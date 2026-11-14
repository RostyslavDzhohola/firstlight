// Pure helpers for the voice tool (generate.ts): which lines need recording, levelling, the manifest.

import { RATE } from "../sfx/lib.ts";

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
