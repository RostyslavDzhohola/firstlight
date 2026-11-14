// The static group's bundle analysis (docs/metrics.md "Static and build"): every file of a client
// build by kind, each JS/CSS chunk raw, gzip and brotli, and the bytes a first visit must fetch before
// the home page runs (index.html's scripts and their static imports) and before the world can start
// (plus the Game chunk's static closure). Reads a dist directory; no network, no browser.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

export interface ChunkSize {
  /** The file name without its content hash (`Game-Pl1YxGOC.js` → `Game.js`); duplicates get `.2`, `.3` by size. */
  name: string;
  file: string;
  raw: number;
  gzip: number;
  br: number;
}

export interface BundleReport {
  files: number;
  totalBytes: number;
  /** Bytes per kind: js, css, image, model, font, audio, data, other. */
  kinds: Record<string, { files: number; bytes: number }>;
  chunks: ChunkSize[];
  /** index.html, its module scripts and their static imports, its stylesheets. */
  home: { requests: number; raw: number; gzip: number; br: number };
  /** home plus the Game chunk and its static imports (the code the world needs before its first frame). */
  world: { requests: number; raw: number; gzip: number; br: number };
}

const KIND: Record<string, string> = {
  js: "js", mjs: "js", css: "css",
  webp: "image", png: "image", jpg: "image", jpeg: "image", svg: "image", avif: "image", ktx2: "image",
  glb: "model", gltf: "model", bin: "model",
  woff: "font", woff2: "font", ttf: "font", otf: "font",
  mp3: "audio", ogg: "audio", wav: "audio", m4a: "audio", opus: "audio",
  json: "data", webmanifest: "data", xml: "data", txt: "data", md: "data", html: "data",
};

export function kindOf(file: string): string {
  return KIND[path.extname(file).slice(1).toLowerCase()] ?? "other";
}

/** `Game-Pl1YxGOC.js` → `Game.js`; `three.tsl-BjefPv-S.js` → `three.tsl.js` (rolldown's 8-char hash). */
export function unhashed(file: string): string {
  const base = path.basename(file);
  const m = /^(.+)-[A-Za-z0-9_-]{8}(\.[a-z0-9]+)$/.exec(base);
  return m ? `${m[1]}${m[2]}` : base;
}

export function compressed(buf: Buffer): { gzip: number; br: number } {
  return {
    gzip: gzipSync(buf, { level: 9 }).length,
    br: brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }).length,
  };
}

/** Relative static imports in a built ES module (`import"./x.js"`, `from"./x.js"`); dynamic `import(…)` is left out. */
export function staticImports(code: string): string[] {
  const out = new Set<string>();
  const re = /\bfrom\s*["'](\.\.?\/[^"']+\.js)["']|\bimport\s*["'](\.\.?\/[^"']+\.js)["']/g;
  for (let m = re.exec(code); m; m = re.exec(code)) out.add((m[1] ?? m[2])!);
  return [...out];
}

/** index.html's own module scripts and stylesheets (root-relative paths). */
export function htmlEntries(html: string): { scripts: string[]; styles: string[] } {
  const scripts = [...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)].map((m) => m[1]!).filter((s) => s.startsWith("/"));
  const pre = [...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g)].map((m) => m[1]!);
  const styles = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]!).filter((s) => s.startsWith("/"));
  return { scripts: [...scripts, ...pre], styles };
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

export function analyseDist(dist: string): BundleReport {
  const files = walk(dist);
  const kinds: Record<string, { files: number; bytes: number }> = {};
  let totalBytes = 0;
  const sizes = new Map<string, { raw: number; gzip: number; br: number }>();
  const chunks: ChunkSize[] = [];
  for (const f of files) {
    const rel = "/" + path.relative(dist, f).split(path.sep).join("/");
    const raw = statSync(f).size;
    totalBytes += raw;
    const k = kindOf(f);
    kinds[k] ??= { files: 0, bytes: 0 };
    kinds[k].files++;
    kinds[k].bytes += raw;
    if (k === "js" || k === "css" || rel === "/index.html") {
      const c = compressed(readFileSync(f));
      sizes.set(rel, { raw, ...c });
      if (k !== "data") chunks.push({ name: unhashed(f), file: rel, raw, ...c });
    }
  }
  // Stable names for chunks that share one (two `devpage` chunks): smallest first gets the plain name.
  chunks.sort((a, b) => a.name.localeCompare(b.name) || a.raw - b.raw);
  const seen = new Map<string, number>();
  for (const c of chunks) {
    const n = (seen.get(c.name) ?? 0) + 1;
    seen.set(c.name, n);
    if (n > 1) c.name = c.name.replace(/(\.[a-z0-9]+)$/, `.${n}$1`);
  }
  chunks.sort((a, b) => b.raw - a.raw);

  const closure = (starts: string[], into = new Set<string>()) => {
    const stack = [...starts];
    while (stack.length) {
      const p = stack.pop()!;
      if (into.has(p)) continue;
      into.add(p);
      if (!p.endsWith(".js")) continue;
      let code = "";
      try {
        code = readFileSync(path.join(dist, p), "utf8");
      } catch {
        continue;
      }
      for (const i of staticImports(code)) stack.push(path.posix.normalize(path.posix.join(path.posix.dirname(p), i)));
    }
    return into;
  };
  const sum = (set: Set<string>) => {
    let raw = 0, gzip = 0, br = 0;
    for (const p of set) {
      const s = sizes.get(p);
      if (!s) continue;
      raw += s.raw;
      gzip += s.gzip;
      br += s.br;
    }
    return { requests: set.size, raw, gzip, br };
  };
  let html = "";
  try {
    html = readFileSync(path.join(dist, "index.html"), "utf8");
  } catch {}
  const entries = htmlEntries(html);
  const homeSet = closure(entries.scripts, new Set(html ? ["/index.html"] : []));
  for (const s of entries.styles) homeSet.add(s);
  const game = chunks.find((c) => c.name === "Game.js");
  const worldSet = closure(game ? [game.file] : [], new Set(homeSet));
  // A chunk's own CSS (Vite emits Game-*.css next to Game-*.js and loads it with the chunk).
  for (const c of chunks) if (c.name === "Game.css") worldSet.add(c.file);
  return { files: files.length, totalBytes, kinds, chunks, home: sum(homeSet), world: sum(worldSet) };
}
