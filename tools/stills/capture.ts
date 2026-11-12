// Stills of what awaits (D-showcase-2): captures the loading screen's in-game pictures from this
// build. Headless and muted Google Chrome on WebGPU (Metal on macOS) at Ultra, offline (`?offline`,
// no server), photo mode for the camera (the HUD hidden), a fixed time of day and clear weather,
// characters placed by hand. Shots are in shots.ts.
//
//   node tools/stills/capture.ts                      build the client, serve it on :5201, every shot
//   node tools/stills/capture.ts --only portus-gate   some shots (comma-separated ids)
//   node tools/stills/capture.ts --url http://127.0.0.1:5173   a client already running (vite dev works)
//   node tools/stills/capture.ts --scout arcadia:clover_fields[:e,n]   8 headings round a spot, to frame shots
//   --out DIR (default $TMPDIR/firstlight-stills)   --webgl (WebGL2 instead of WebGPU)   --install
//
// Writes DIR/raw/<id>.png (1920×1080, what the game drew) and DIR/<id>.webp (1920×1080 via cwebp, the
// quality stepped down from 82 until the file is at most 120 KB); --install copies the shipped ones
// (`ship` in shots.ts) to apps/client/src/ui/stills/; --encode-only re-encodes DIR/raw without the browser. Needs Node 24, Google Chrome and cwebp (`brew install webp`). One GPU job
// at a time on a shared machine: take your lock around it.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { offsetDir, placeDir } from "../../packages/shared/src/content/places.ts";
import { BODIES, type BodyId } from "../../packages/shared/src/planet/bodies.ts";
import { padDirs, type Dir } from "../../packages/shared/src/planet/pads.ts";
import { createTerrain } from "../../packages/shared/src/planet/terrain.ts";
import { SHOTS, type Shot } from "./shots.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const CLIENT = path.join(ROOT, "apps/client");
const STILLS_DIR = path.join(CLIENT, "src/ui/stills");
// Playwright is the client's pinned dev dependency (1.64.0); no package of our own.
const { chromium } = createRequire(path.join(CLIENT, "package.json"))("@playwright/test") as typeof import("@playwright/test");

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (!a.startsWith("--")) continue;
  const v = process.argv[i + 1];
  if (v && !v.startsWith("--")) (args.set(a.slice(2), v), i++);
  else args.set(a.slice(2), "1");
}
const OUT = path.resolve(args.get("out") ?? path.join(os.tmpdir(), "firstlight-stills"));
const PORT = Number(args.get("port") ?? 5201);
const WEBGL = args.has("webgl");
const SIZE = { width: 1920, height: 1080 };
const FINAL = { width: 1920, height: 1080 };
const BUDGET = 120 * 1024;

type V3 = [number, number, number];

// ------------------------------------------------------------------------------- world positions

const terrains = new Map<BodyId, ReturnType<typeof createTerrain>>();
const terrainOf = (b: BodyId) => terrains.get(b) ?? terrains.set(b, createTerrain(b)).get(b)!;

/** The direction east/north offsets start from: a place, a pad index, or pad 0. */
function anchor(body: BodyId, from: Shot["from"]): Dir {
  if (typeof from === "string") return placeDir(from);
  return padDirs(BODIES[body])[from ?? 0]!;
}

/** A point `h` metres above the ground (or the water) at east/north metres from the anchor. */
function point(body: BodyId, a: Dir, e: number, n: number, h: number): V3 {
  const R = BODIES[body].radius;
  const d = offsetDir(a, e, n, R);
  const t = terrainOf(body);
  const ground = Math.max(t.groundHeight(d[0], d[1], d[2]), BODIES[body].waterLevel ?? -Infinity);
  const r = R + ground + h;
  return [d[0] * r, d[1] * r, d[2] * r];
}

/** The tangent direction from `p` toward `q` (a character's facing). */
function facing(p: V3, q: V3): V3 {
  const l = Math.hypot(...p);
  const up = p.map((v) => v / l) as V3;
  const d = q.map((v, i) => v - p[i]!) as V3;
  const k = d[0] * up[0] + d[1] * up[1] + d[2] * up[2];
  const t = d.map((v, i) => v - k * up[i]!) as V3;
  const tl = Math.hypot(...t) || 1;
  return t.map((v) => v / tl) as V3;
}

/** Everything the page needs for one shot, in planet space. */
function resolve(s: Shot) {
  const a = anchor(s.body, s.from);
  const cam = point(s.body, a, ...s.cam);
  const look = point(s.body, a, ...s.look);
  const cast = (s.cast ?? []).map((c) => {
    const p = point(s.body, a, c.at[0], c.at[1], 0);
    return { starter: c.starter, palette: c.palette, look: c.look ?? 0, anim: c.anim ?? 0, t: c.t ?? 0, p, f: facing(p, point(s.body, a, c.face[0], c.face[1], 0)) };
  });
  // No one in the shot: the player's own body waits 6 m behind the camera, out of frame (photo
  // mode keeps the camera within 180 m of it).
  const [e, n] = s.cam;
  const d = Math.hypot(s.look[0] - e, s.look[1] - n) || 1;
  const hide = point(s.body, a, e - ((s.look[0] - e) / d) * 6, n - ((s.look[1] - n) / d) * 6, 0);
  return { id: s.id, cam, look, fov: s.fov, time: s.time, exposure: s.exposure ?? 1, filter: s.filter ?? 0, dof: s.dof ?? null, cast, hide };
}

// ---------------------------------------------------------------------------------- the browser

/** Runs in the page: place the cast and the photo-mode camera for one shot. */
function stage(shot: ReturnType<typeof resolve>) {
  type Vec = { set(x: number, y: number, z: number): Vec; copy(v: Vec): Vec; clone(): Vec; sub(v: Vec): Vec; normalize(): Vec; dot(v: Vec): number; addScaledVector(v: Vec, s: number): Vec };
  type Av = { root: { removeFromParent(): void }; set(...a: number[]): void; setLook(p: number, s: number, l: number): void; dispose(): void };
  const w = window as unknown as {
    __game: any;
    __cast?: { a: Av; c: (typeof shot.cast)[number] }[];
    __castLoop?: number;
  };
  const g = w.__game;
  const V = g.ctx.camera.position.constructor as new (x?: number, y?: number, z?: number) => Vec;
  for (const x of w.__cast ?? []) {
    x.a.root.removeFromParent();
    x.a.dispose();
  }
  const [lead, ...extra] = shot.cast;
  // The player's own avatar is the first of the cast (or waits out of frame).
  const at = lead ? lead.p : shot.hide;
  g.player.teleport(at[0], at[1], at[2]);
  if (lead) {
    g.player.facing.set(lead.f[0], lead.f[1], lead.f[2]);
    g.self.setLook(lead.palette, lead.starter, lead.look);
    g.player.anim = lead.anim;
  }
  const AvatarView = g.self.constructor as new (palette: number, starter: number, look: number) => Av;
  w.__cast = extra.map((c) => {
    const a = new AvatarView(c.palette, c.starter, c.look);
    g.ctx.scene.add(a.root);
    a.set(c.p[0], c.p[1], c.p[2], c.f[0], c.f[1], c.f[2], c.anim, c.t);
    return { a, c };
  });
  if (!w.__castLoop) {
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      for (const { a, c } of w.__cast ?? []) a.set(c.p[0], c.p[1], c.p[2], c.f[0], c.f[1], c.f[2], c.anim, dt);
      w.__castLoop = requestAnimationFrame(tick);
    };
    w.__castLoop = requestAnimationFrame(tick);
  }
  // Only the world: no HUD, hint or prompt over it.
  if (!document.getElementById("fl-capture")) {
    const css = document.createElement("style");
    css.id = "fl-capture";
    css.textContent = "body > :not(#game) { display: none !important; }";
    document.head.append(css);
  }
  const ph = g.photo;
  ph.panelHidden = true;
  if (!ph.active) ph.enter(g.ctx.camera);
  ph.pos.set(shot.cam[0], shot.cam[1], shot.cam[2]);
  const up = ph.pos.clone().normalize();
  const look = new V(shot.look[0], shot.look[1], shot.look[2]).sub(ph.pos).normalize();
  ph.pitch = Math.asin(Math.max(-1, Math.min(1, look.dot(up))));
  ph.forward.copy(look).addScaledVector(up, -look.dot(up)).normalize();
  ph.fov = shot.fov;
  ph.time = shot.time;
  ph.weatherIndex = 1; // clear
  ph.exposure = shot.exposure;
  ph.filter = shot.filter;
  if (shot.dof) {
    ph.focus = shot.dof.focus;
    ph.aperture = shot.dof.aperture;
    ph.bokeh = shot.dof.bokeh;
  } else {
    ph.focus = 400; // everything sharp
    ph.aperture = 60;
  }
  ph.applyLook();
  return { webgpu: !!g.ctx.webgpu, tier: g.ctx.tier as string };
}

async function serve(): Promise<{ url: string; stop: () => void }> {
  const given = args.get("url");
  if (given) return { url: given, stop: () => {} };
  const dist = path.join(OUT, "dist");
  console.log(`building the client into ${dist}…`);
  execFileSync("npx", ["vite", "build", "--outDir", dist, "--emptyOutDir", "--logLevel", "warn"], { cwd: CLIENT, stdio: "inherit" });
  const child: ChildProcess = spawn("npx", ["vite", "preview", "--outDir", dist, "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: CLIENT, stdio: "ignore", detached: true });
  const url = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 100; i++) {
    if (await fetch(url).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  return { url, stop: () => process.kill(-child.pid!, "SIGTERM") };
}

/** 1600×900 WebP within the budget: cwebp's quality stepped down from 82. */
function encode(png: string, webp: string): { q: number; bytes: number } {
  let last = { q: 0, bytes: Infinity };
  for (const q of [82, 78, 74, 70, 66, 62, 58]) {
    execFileSync("cwebp", ["-quiet", "-q", String(q), "-m", "6", "-sharp_yuv", "-af", "-resize", String(FINAL.width), String(FINAL.height), png, "-o", webp]);
    last = { q, bytes: statSync(webp).size };
    if (last.bytes <= BUDGET) break;
  }
  return last;
}

async function main() {
  const only = args.get("only")?.split(",");
  const scout = args.get("scout");
  const shots: Shot[] = scout ? scoutShots(scout) : SHOTS.filter((s) => !only || only.includes(s.id));
  if (!shots.length) throw new Error("no shots");
  mkdirSync(path.join(OUT, "raw"), { recursive: true });
  const log: unknown[] = [];
  if (args.has("encode-only")) {
    for (const s of shots) finish(s, path.join(OUT, "raw", `${s.id}.png`), log, {});
    writeFileSync(path.join(OUT, "capture.json"), JSON.stringify(log, null, 1));
    return;
  }
  const { url, stop } = await serve();
  const browser = await chromium.launch({
    headless: true,
    channel: "chrome",
    args: ["--mute-audio", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", ...(process.platform === "darwin" ? ["--use-angle=metal"] : [])],
  });
  try {
    for (const body of [...new Set(shots.map((s) => s.body))]) {
      const page = await browser.newPage({ viewport: SIZE, deviceScaleFactor: 1 });
      page.on("console", (m) => m.text().startsWith("[gfx]") && console.log(`  ${m.text()}`));
      const first = shots.find((s) => s.body === body)!;
      await page.addInitScript(() => localStorage.setItem("fl.starter", "0"));
      const q = new URLSearchParams({ offline: "", autoplay: "", body, tier: "ultra", scale: "1", noladder: "", time: String(first.time), weather: "clear", ...(WEBGL ? { webgl: "" } : { webgpu: "" }) });
      const t0 = Date.now();
      await page.goto(`${url}/?${q.toString().replace(/=(&|$)/g, "$1")}`);
      await page.waitForFunction(() => (window as any).__game?.running && document.getElementById("loading")?.hidden, null, { timeout: 300_000, polling: 500 });
      console.log(`${body}: in the world after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      for (const s of shots.filter((x) => x.body === body)) {
        const r = resolve(s);
        const gfx = await page.evaluate(stage, r);
        await page.waitForTimeout(s.wait ?? 9000); // streaming, grass, shaders, TRAA settle
        const png = path.join(OUT, "raw", `${s.id}.png`);
        await page.screenshot({ path: png, scale: "css" });
        if (scout) {
          console.log(`  ${s.id}`);
          continue;
        }
        finish(s, png, log, gfx);
      }
      await page.close();
    }
  } finally {
    await browser.close();
    stop();
    writeFileSync(path.join(OUT, "capture.json"), JSON.stringify(log, null, 1));
  }
}

/** Encode one capture (and with --install, copy it into the client). */
function finish(s: Shot, png: string, log: unknown[], gfx: { webgpu?: boolean; tier?: string }) {
  const webp = path.join(OUT, `${s.id}.webp`);
  const enc = encode(png, webp);
  log.push({ id: s.id, body: s.body, caption: s.caption, ...gfx, quality: enc.q, kb: Math.round(enc.bytes / 1024) });
  console.log(`  ${s.id}: ${gfx.webgpu === undefined ? "" : gfx.webgpu ? "WebGPU " : "WebGL2 "}${gfx.tier ?? ""} q${enc.q}, ${Math.round(enc.bytes / 1024)} KB`);
  if (args.has("install") && s.ship) {
    mkdirSync(STILLS_DIR, { recursive: true });
    copyFileSync(webp, path.join(STILLS_DIR, `${s.id}.webp`));
  }
}

/** --scout body:place[:e,n]: a camera at eye height turning through 8 headings, and one from 40 m up. */
function scoutShots(spec: string): Shot[] {
  const [body, from, en] = spec.split(":") as [BodyId, string, string | undefined];
  const [e, n] = en ? en.split(",").map(Number) as [number, number] : [0, 0];
  const time = Number(args.get("time") ?? 0.42);
  const out: Shot[] = [];
  for (let i = 0; i < 8; i++) {
    const b = (i * Math.PI) / 4;
    out.push({ id: `scout-${body}-${from}-${i * 45}`, body, from: /^\d+$/.test(from) ? Number(from) : from, caption: "", time, cam: [e, n, 1.7], look: [e + Math.sin(b) * 50, n + Math.cos(b) * 50, 4], fov: 70, wait: 5000 });
  }
  out.push({ id: `scout-${body}-${from}-up`, body, from: /^\d+$/.test(from) ? Number(from) : from, caption: "", time, cam: [e - 30, n - 30, 40], look: [e, n, 0], fov: 70, wait: 7000 });
  return out;
}

await main();
