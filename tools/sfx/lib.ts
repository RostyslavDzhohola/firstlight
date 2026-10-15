// Helpers for the SFX tools: the API key, ffmpeg decode/encode, loudness and a few cheap analyses.
// Runs with Node 24's type stripping (erasable TypeScript only).

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const RATE = 48000;

const present = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * The real path of an output folder, refused if it is inside any git checkout (ElevenLabs outputs
 * never go in git: AGENTS.md, D18). Symlinks are resolved first, including in parents of a path
 * that doesn't exist yet; a dangling symlink is refused. Changes nothing on disk.
 */
export function safeOutDir(dir: string, cwd: string = process.cwd()): string {
  let base = resolve(cwd, dir);
  const rest: string[] = [];
  while (!present(base)) {
    const up = dirname(base);
    if (up === base) break;
    rest.unshift(basename(base));
    base = up;
  }
  const real = join(realpathSync(base), ...rest); // throws on a dangling symlink
  for (let d = real; ; d = dirname(d)) {
    if (present(join(d, ".git"))) throw new Error(`refusing SFX output inside the git checkout ${d}: ElevenLabs outputs never go in git`);
    if (dirname(d) === d) break;
  }
  return real;
}

/** Where everything generated goes (checked at load, before any script touches the disk or the API). */
export const OUT = safeOutDir(process.env.FL_SFX_OUT ?? "/tmp/fl-go/sfx");

/** The ElevenLabs key from the environment or `~/.config/firstlight/.env`. Never print it. */
export function apiKey(): string {
  const env = process.env.ELEVENLABS_API_KEY;
  if (env) return env;
  const file = join(homedir(), ".config/firstlight/.env");
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?ELEVENLABS_API_KEY\s*=\s*(.*)\s*$/.exec(line);
      if (m) return m[1]!.replace(/^["']|["']$/g, "");
    }
  }
  throw new Error("ELEVENLABS_API_KEY is not set (env or ~/.config/firstlight/.env)");
}

/** Any audio file to mono float samples at 48 kHz (stereo is averaged). */
export function decode(file: string): Float32Array {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", String(RATE), "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4).slice();
}

/** Mono float samples at 48 kHz to a mono MP3 (CBR, so every browser decodes it the same). */
export function encodeMp3(x: Float32Array, file: string, kbps = 96) {
  const input = Buffer.from(x.buffer, x.byteOffset, x.byteLength);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "f32le", "-ar", String(RATE), "-ac", "1", "-i", "-", "-c:a", "libmp3lame", "-b:a", `${kbps}k`, "-write_xing", "1", file], { input });
}

/** 16-bit PCM WAV bytes. */
export function wav(x: Float32Array | number[], rate: number): Buffer {
  const n = x.length;
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i]!)) * 32767), 44 + i * 2);
  return b;
}

const db = (v: number) => 20 * Math.log10(Math.max(v, 1e-9));

/** −1 dBFS: the most a sample may reach the output with master and effects at 100 %, the settings' maximum (the client's SFX_CEILING). */
export const CEILING = 10 ** (-1 / 20);

/**
 * A sound's playback gain: what lifts its files from `fileLoud` to `target` (dB), capped so the
 * loudest decoded take (linear `peaks`) times the gain stays under CEILING; rounded down.
 */
export function playbackGain(target: number, fileLoud: number, peaks: number[]): number {
  const want = 10 ** ((target - fileLoud) / 20);
  const peak = Math.max(0, ...peaks);
  return Math.floor((peak > 0 ? Math.min(want, CEILING / peak) : want) * 1000) / 1000;
}

export function peakDb(x: Float32Array): number {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]!));
  return db(p);
}

function biquad(x: Float64Array, b: number[], a: number[]): Float64Array {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b[0]! * x[i]! + b[1]! * x1 + b[2]! * x2 - a[1]! * y1 - a[2]! * y2;
    x2 = x1;
    x1 = x[i]!;
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

/**
 * Loudness of a short sound: the loudest 400 ms window (ITU-R BS.1770 K-weighting, "momentary"
 * loudness), in LUFS. Clips shorter than 400 ms count as padded with silence, so a short tick
 * measures quieter than a long note of the same peak, as it sounds.
 */
export function loudness(x: Float32Array): number {
  const pad = new Float64Array(x.length + RATE * 0.4);
  pad.set(x, 0);
  // BS.1770 stage 1 (head shelf) and stage 2 (RLB high-pass) at 48 kHz.
  const k = biquad(biquad(pad, [1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585]), [1, -2, 1], [1, -1.99004745483398, 0.99007225036621]);
  const win = RATE * 0.4;
  const hop = RATE * 0.01;
  let sum = 0;
  for (let i = 0; i < win; i++) sum += k[i]! * k[i]!;
  let best = sum;
  for (let s = hop; s + win <= k.length; s += hop) {
    for (let i = s - hop; i < s; i++) sum -= k[i]! * k[i]!;
    for (let i = s + win - hop; i < s + win; i++) sum += k[i]! * k[i]!;
    best = Math.max(best, sum);
  }
  return -0.691 + 10 * Math.log10(Math.max(best / win, 1e-12));
}

/** 5 ms RMS envelope in dB. */
export function envelope(x: Float32Array, ms = 5): number[] {
  const n = Math.round((RATE * ms) / 1000);
  const out: number[] = [];
  for (let s = 0; s < x.length; s += n) {
    let e = 0;
    const end = Math.min(x.length, s + n);
    for (let i = s; i < end; i++) e += x[i]! * x[i]!;
    out.push(10 * Math.log10(Math.max(e / Math.max(1, end - s), 1e-12)));
  }
  return out;
}

/** Separate hits: envelope peaks within 14 dB of the loudest that follow a dip of 10 dB or more. */
export function onsets(x: Float32Array): number {
  const env = envelope(x);
  const top = Math.max(...env);
  let count = 0;
  let floor = Infinity;
  let armed = true;
  for (const e of env) {
    floor = Math.min(floor, e);
    if (armed && e > top - 14 && e - floor > 10) {
      count++;
      armed = false;
      floor = e;
    } else if (!armed && e < top - 24) {
      armed = true;
      floor = e;
    }
  }
  return Math.max(1, count);
}

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const ar = re[i + k + len / 2]!, ai = im[i + k + len / 2]!;
        const tr = ar * wr - ai * wi, ti = ar * wi + ai * wr;
        re[i + k + len / 2] = re[i + k]! - tr;
        im[i + k + len / 2] = im[i + k]! - ti;
        re[i + k] = re[i + k]! + tr;
        im[i + k] = im[i + k]! + ti;
      }
    }
  }
}

/**
 * Spectrum summary: the centroid (Hz) and the strongest narrow tone, i.e. how far the loudest bin
 * between 300 Hz and 12 kHz rises above its neighbourhood's median (dB). A "ping" is a tone ≥ 18 dB.
 */
export function spectrum(x: Float32Array): { centroid: number; toneHz: number; toneDb: number } {
  const N = 4096;
  const mag = new Float64Array(N / 2);
  const hop = N / 4;
  let frames = 0;
  for (let s = 0; s === 0 || s + N <= x.length; s += hop) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = (x[s + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
    fft(re, im);
    for (let i = 0; i < N / 2; i++) mag[i] = mag[i]! + Math.hypot(re[i]!, im[i]!);
    frames++;
  }
  const hz = RATE / N;
  let num = 0, den = 0;
  for (let i = 1; i < N / 2; i++) {
    num += i * hz * mag[i]!;
    den += mag[i]!;
  }
  let toneDb = 0, toneHz = 0;
  for (let i = Math.round(300 / hz); i < Math.round(12000 / hz); i++) {
    const near: number[] = [];
    for (let j = Math.max(1, i - 40); j < Math.min(N / 2, i + 40); j++) if (Math.abs(j - i) > 3) near.push(mag[j]!);
    near.sort((a, b) => a - b);
    const rise = db(mag[i]! / Math.max(near[near.length >> 1]!, 1e-12));
    if (rise > toneDb) {
      toneDb = rise;
      toneHz = i * hz;
    }
  }
  return { centroid: frames ? num / Math.max(den, 1e-12) : 0, toneHz, toneDb };
}

/**
 * Trim for low latency: cut everything before the first sample within 40 dB of the peak (keeping
 * 2 ms), end where the 5 ms envelope last rises within 50 dB of its loudest (capped at `maxMs`),
 * fade in over 2 ms and out over `fadeMs`.
 */
export function trim(x: Float32Array, maxMs: number, fadeMs: number): Float32Array {
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]!));
  const thr = peak * 10 ** (-40 / 20);
  let start = 0;
  while (start < x.length && Math.abs(x[start]!) < thr) start++;
  start = Math.max(0, start - Math.round(RATE * 0.002));
  const env = envelope(x.subarray(start));
  const top = Math.max(...env);
  let last = env.length - 1;
  while (last > 0 && env[last]! < top - 50) last--;
  const len = Math.min(x.length - start, Math.round((RATE * 5 * (last + 1)) / 1000), Math.round((RATE * maxMs) / 1000));
  const y = x.slice(start, start + len);
  const fin = Math.min(len, Math.round(RATE * 0.002));
  for (let i = 0; i < fin; i++) y[i] = y[i]! * (i / fin);
  const fout = Math.min(len, Math.round((RATE * fadeMs) / 1000));
  for (let i = 0; i < fout; i++) y[len - 1 - i] = y[len - 1 - i]! * (0.5 - 0.5 * Math.cos((Math.PI * i) / fout));
  return y;
}
