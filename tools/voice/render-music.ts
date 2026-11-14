// Render the generated soundtrack to audio files, to listen to (or, without ears, to measure): each
// body by day, at night and with the combat layer, from apps/client/src/audio/music.ts, played into
// an OfflineAudioContext in a headless browser. `--before <commit>` renders that commit's generator
// (the MusicGen class then inside Audio.ts) for a comparison.
//
//   with-browser.sh node tools/voice/render-music.ts --out /tmp/fl-music [--seconds 40] [--before 45a88188]
//
// Writes <out>/<label>-<body>.wav (44.1 kHz stereo). Needs the client's Playwright browser.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { wav } from "../sfx/lib.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const req = createRequire(join(ROOT, "apps/client/package.json"));
const esbuild = createRequire(req.resolve("vite"))("esbuild") as typeof import("esbuild");
const { chromium } = req("@playwright/test") as typeof import("@playwright/test");

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i < 0 ? d : process.argv[i + 1];
};
const OUT = arg("out", "/tmp/fl-music")!;
const SECONDS = Number(arg("seconds", "40"));
const BEFORE = arg("before");
const BODIES = (arg("bodies", "portus,arcadia,hollowmere,meridian,lumen") ?? "").split(",");
const RATE = 44100;
mkdirSync(OUT, { recursive: true });

async function bundle(entry: string): Promise<string> {
  const r = await esbuild.build({ entryPoints: [entry], bundle: true, format: "iife", globalName: "FLMusic", write: false, platform: "browser", logLevel: "error" });
  return `${r.outputFiles[0]!.text}\n;globalThis.FLMusic = FLMusic;`;
}

// The current generator, and optionally an older one (its MusicGen class cut out of that commit's Audio.ts).
const now = await bundle(join(ROOT, "apps/client/src/audio/music.ts"));
let before: string | null = null;
if (BEFORE) {
  const src = execFileSync("git", ["show", `${BEFORE}:apps/client/src/audio/Audio.ts`], { cwd: ROOT, encoding: "utf8" });
  const cut = src.slice(src.indexOf("interface Mood {"));
  const file = join(OUT, "before-music.ts");
  writeFileSync(file, `type BodyId = string;\n${cut.replace("class MusicGen", "export class MusicGen")}`);
  before = await bundle(file);
}

const browser = await chromium.launch({ args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"] });
try {
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  type Job = { code: string; body: string; seconds: number; night: number; combat: [number, number] | null; old: boolean };
  const render = (j: Job) =>
    page.evaluate(async ({ code, body, seconds, night, combat, old, rate }) => {
      (0, eval)(code);
      const M = (globalThis as unknown as { FLMusic: { MusicGen: new (...a: unknown[]) => any } }).FLMusic;
      const ctx = new OfflineAudioContext(2, rate * seconds, rate);
      const g = new M.MusicGen(ctx, ctx.destination, body);
      if (old) {
        // The old generator schedules from ctx.currentTime on a timer: give it a clock that has already run.
        let clock = 0;
        Object.defineProperty(ctx, "currentTime", { get: () => clock });
        g.nextTime = 0.1;
        g.out.gain.value = 0.9;
        clock = seconds - 0.25;
        g.schedule();
      } else {
        g.setNight(night);
        g.startAt(0);
        if (combat) for (let t = combat[0]; t < combat[1]; t += 1) g.setCombat(true, t);
        g.scheduleUntil(seconds);
      }
      const buf = await ctx.startRendering();
      const l = buf.getChannelData(0);
      const r = buf.getChannelData(1);
      const out = new Float32Array(l.length * 2);
      for (let i = 0; i < l.length; i++) {
        out[2 * i] = l[i]!;
        out[2 * i + 1] = r[i]!;
      }
      // Base64 across the page boundary (a plain array of 3.5 M numbers is slow).
      const bytes = new Uint8Array(out.buffer);
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    }, { ...j, rate: RATE });

  const jobs: [string, Job][] = [];
  for (const body of BODIES) {
    jobs.push([`day-${body}`, { code: now, body, seconds: SECONDS, night: 0, combat: null, old: false }]);
    jobs.push([`night-${body}`, { code: now, body, seconds: SECONDS, night: 1, combat: null, old: false }]);
    jobs.push([`fight-${body}`, { code: now, body, seconds: SECONDS, night: 0, combat: [SECONDS * 0.3, SECONDS * 0.7], old: false }]);
    if (before) jobs.push([`before-${body}`, { code: before, body, seconds: SECONDS, night: 0, combat: null, old: true }]);
  }
  for (const [label, j] of jobs) {
    const b = Buffer.from(await render(j), "base64");
    const st = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
    writeFileSync(join(OUT, `${label}.wav`), wavStereo(st));
    console.log(`${label}: ${(st.length / 2 / RATE).toFixed(1)} s`);
  }
} finally {
  await browser.close();
}

/** Interleaved stereo float samples to a 16-bit WAV (sfx/lib's wav() is mono). */
function wavStereo(x: Float32Array): Buffer {
  const mono = wav(new Float32Array(0), RATE); // header template
  const n = x.length;
  const b = Buffer.alloc(44 + n * 2);
  mono.copy(b, 0, 0, 44);
  b.writeUInt32LE(36 + n * 2, 4);
  b.writeUInt16LE(2, 22); // channels
  b.writeUInt32LE(RATE * 4, 28); // byte rate
  b.writeUInt16LE(4, 32); // block align
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i]!)) * 32767), 44 + i * 2);
  return b;
}
