// Helpers for the voice tool (generate.ts, setup.ts): where it lives, which lines need recording, levelling, the manifest.

import { homedir } from "node:os";
import { join } from "node:path";
import { RATE } from "../sfx/lib.ts";

/** Where the voice tool's model environment lives, outside the repo (setup.ts makes it). */
export function voiceHome(env: Record<string, string | undefined> = process.env): string {
  return env.FL_VOICE_HOME || join(homedir(), ".cache/firstlight-voice");
}

/** The Kokoro-82M v1.0 ONNX files (kokoro-onnx release model-files-v1.0) and their sha256 (docs/ASSETS.md). */
export const MODEL_FILES = [
  { name: "kokoro-v1.0.onnx", url: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx", sha256: "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5" },
  { name: "voices-v1.0.bin", url: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin", sha256: "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d" },
] as const;

/** What the game reads (apps/client/src/audio/voiceLines.json): per line, the text key and length. */
export interface VoiceManifest {
  model: string;
  kbps: number;
  lines: Record<string, { k: string; ms: number }>;
}

/** Spoken lines whose file is missing or was made from other words. */
export function stale(lines: readonly { id: string; text: string }[], manifest: VoiceManifest, key: (t: string) => string, has: (id: string) => boolean): string[] {
  return lines.filter((l) => manifest.lines[l.id]?.k !== key(l.text) || !has(l.id)).map((l) => l.id);
}

/** Integrated loudness (EBU R128) every line is levelled to, in LUFS, and the limiter's ceiling in dBFS. */
export const TARGET_LUFS = -17;
export const PEAK_DBFS = -1.5;

/**
 * Cut the silence around speech (kept: 30 ms before the first sound, 120 ms after the last above
 * −45 dB of the peak), with short fades so the cut never clicks. Samples at RATE.
 */
export function trimSpeech(x: Float32Array): Float32Array {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  if (peak === 0) return x;
  const thr = peak * 10 ** (-45 / 20);
  let a = 0;
  while (a < x.length && Math.abs(x[a]!) < thr) a++;
  let b = x.length - 1;
  while (b > a && Math.abs(x[b]!) < thr) b--;
  const start = Math.max(0, a - Math.round(RATE * 0.03));
  const end = Math.min(x.length, b + Math.round(RATE * 0.12));
  const y = x.slice(start, end);
  const fin = Math.min(y.length, Math.round(RATE * 0.005));
  for (let i = 0; i < fin; i++) y[i] = y[i]! * (i / fin);
  const fout = Math.min(y.length, Math.round(RATE * 0.06));
  for (let i = 0; i < fout; i++) y[y.length - 1 - i] = y[y.length - 1 - i]! * (i / fout);
  return y;
}

/**
 * What a finished recording must measure (tools/voice/check.ts): integrated loudness within 1 LU of the
 * set's median (lines sound equally loud next to each other; the limiter leaves the set about 0.9 LU
 * under TARGET_LUFS, measured −17.9 on 2026-11-14) and within 2 LU of TARGET_LUFS, sample peak at or under −1 dBFS (the limiter's −1.5 plus MP3 overshoot) with no flat
 * tops, 0.8–8.1 s long (the subtitle's 9 s cap less its 0.9 s tail), no pause inside over 1.2 s, a
 * pace within 35 % of the speaker's median (a cut-off or runaway take reads far off it), and the
 * manifest's length within 150 ms of the file's.
 */
export const VOICE_BANDS = { lu: 1, target: 2, peakMax: -1, sec: [0.8, 8.1], silentLufs: -40, maxGap: 1.2, pace: 0.35, manifestMs: 150 } as const;

export interface Measured {
  id: string;
  sec: number;
  lufs: number;
  peak: number;
  /** astats flat factor: > 0 means runs of samples stuck at the peak (clipping). */
  flat: number;
  /** Longest pause inside the line, seconds. */
  gap: number;
}

/** Each recording's problems against VOICE_BANDS (an empty `why` is a pass). */
export function judge(xs: readonly (Measured & { text: string; speaker: string; manifestMs: number })[]): { id: string; why: string[]; pace: number }[] {
  const B = VOICE_BANDS;
  const pace = (x: { text: string; sec: number }) => x.text.length / x.sec;
  const median = new Map<string, number>();
  for (const s of new Set(xs.map((x) => x.speaker))) {
    const p = xs.filter((x) => x.speaker === s).map(pace).sort((a, b) => a - b);
    median.set(s, p[p.length >> 1]!);
  }
  const heard = xs.filter((x) => x.lufs > B.silentLufs).map((x) => x.lufs).sort((a, b) => a - b);
  const mid = heard[heard.length >> 1] ?? TARGET_LUFS;
  return xs.map((x) => {
    const why: string[] = [];
    const rel = pace(x) / median.get(x.speaker)!;
    if (!(x.lufs > B.silentLufs)) why.push(`silent (${x.lufs} LUFS)`);
    else if (Math.abs(x.lufs - mid) > B.lu || Math.abs(x.lufs - TARGET_LUFS) > B.target) why.push(`loudness ${x.lufs} LUFS (set median ${mid} ± ${B.lu}, target ${TARGET_LUFS} ± ${B.target})`);
    if (x.peak > B.peakMax || x.flat > 0) why.push(`clipped (peak ${x.peak} dBFS, flat ${x.flat})`);
    if (x.sec < B.sec[0] || x.sec > B.sec[1]) why.push(`length ${x.sec.toFixed(2)} s (${B.sec[0]}–${B.sec[1]})`);
    if (x.gap > B.maxGap) why.push(`a ${x.gap.toFixed(2)} s pause inside`);
    if (Math.abs(rel - 1) > B.pace) why.push(`pace ${pace(x).toFixed(1)} chars/s, ${Math.round(rel * 100)} % of ${x.speaker}'s median`);
    if (Math.abs(x.manifestMs - x.sec * 1000) > B.manifestMs) why.push(`manifest says ${x.manifestMs} ms, file is ${Math.round(x.sec * 1000)} ms`);
    return { id: x.id, why, pace: Number(pace(x).toFixed(2)) };
  });
}
