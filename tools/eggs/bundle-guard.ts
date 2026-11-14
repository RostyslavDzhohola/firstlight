// #41 guard (review 2026-11-13 ship #4): the Easter eggs' answers never reach the client as text. Scans
// the client's sources and a fresh production build for the keypad code (as a number of its own, not
// part of a longer one) and for the server's rule constant names. Images are not scanned: the clue
// textures (tools/eggs/mirror-clue.ts) carry the digits as pixels on purpose.
//   node tools/eggs/bundle-guard.ts        build the client into a temp dir, scan it and the sources
// apps/server/test/egg-rules.test.ts runs the same checks.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EGG_RULES } from "../../apps/server/src/world/quests/eggRules.ts";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const CLIENT = path.join(ROOT, "apps/client");

const TEXT = /\.(?:[cm]?[jt]sx?|html?|css|json|md|svg|txt|webmanifest|map|xml)$/i;
const RULE_NAMES = /\bE\d+_(?:ORDER|CODE|LANTERNS|LAMPS|WINDOW_MS|LAMP_RADIUS)\b/;

/** Text files under `dir` (dot-directories, node_modules and build output skipped). */
export function textFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist") return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? textFiles(p) : TEXT.test(e.name) ? [p] : [];
  });
}

/** Files that hold the keypad code as a number of its own, or name a rule constant. */
export function leaks(files: string[], code: string = EGG_RULES.E7_CODE): string[] {
  const own = new RegExp(`(?<![0-9.])${code}(?![0-9])`);
  return files.filter((f) => {
    const t = readFileSync(f, "utf8");
    return own.test(t) || RULE_NAMES.test(t);
  });
}

/** Every client source file that could reach a player or a reader of the repo's client. */
export function clientSources(): string[] {
  return readdirSync(CLIENT, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist") return [];
    const p = path.join(CLIENT, e.name);
    return e.isDirectory() ? textFiles(p) : TEXT.test(e.name) ? [p] : [];
  });
}

/** Build the production client into a new temp dir (the caller removes it). */
export function buildClient(): string {
  const out = mkdtempSync(path.join(os.tmpdir(), "fl-egg-guard-"));
  execFileSync(path.join(CLIENT, "node_modules/.bin/vite"), ["build", "--outDir", out, "--emptyOutDir", "--logLevel", "error"], { cwd: CLIENT, stdio: "pipe", timeout: 300_000 });
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const src = leaks(clientSources());
  const out = buildClient();
  try {
    const built = leaks(textFiles(out));
    for (const f of src) console.error(`answer in client source: ${path.relative(ROOT, f)}`);
    for (const f of built) console.error(`answer in the production bundle: ${path.relative(out, f)}`);
    if (src.length || built.length) process.exit(1);
    console.log(`egg guard: ${clientSources().length} client sources and ${textFiles(out).length} built files clean`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
