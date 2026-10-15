// ElevenLabs sound-effect samples: never in the repo (D18, D-sfx-1). They live on the asset Worker as
// a versioned set (`/v/sfx-1`, config.sfxBase) with a `manifest.json` that lists each sound's files
// (2–3 takes for frequent sounds) and its playback gain. The bank fetches the manifest, decodes each
// file once, and hands out a random take; any sound it doesn't hold plays its ZzFX preset instead.

import { fallbackOf, isSampleName, type SampleName, type SoundName } from "./sounds.ts";
import type { PresetName } from "./presets.ts";

export interface SampleManifest {
  set: string;
  sounds: Partial<Record<SampleName, { files: string[]; gain: number }>>;
}

const FILE = /^[A-Za-z0-9][A-Za-z0-9_-]*\.(mp3|ogg|m4a|wav)$/;

/**
 * Validate a manifest. Unknown sound names are skipped (a newer set may carry sounds this client
 * doesn't play yet); bad entries are dropped, never thrown on, so they fall back to ZzFX.
 */
export function parseManifest(raw: unknown): SampleManifest {
  const out: SampleManifest = { set: "", sounds: {} };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as { set?: unknown; sounds?: unknown };
  if (typeof r.set === "string") out.set = r.set;
  if (!r.sounds || typeof r.sounds !== "object") return out;
  for (const [name, entry] of Object.entries(r.sounds as Record<string, unknown>)) {
    if (!isSampleName(name) || !entry || typeof entry !== "object") continue;
    const e = entry as { files?: unknown; gain?: unknown };
    const files = Array.isArray(e.files) ? e.files.filter((f): f is string => typeof f === "string" && FILE.test(f)) : [];
    const gain = typeof e.gain === "number" && Number.isFinite(e.gain) && e.gain > 0 && e.gain <= 8 ? e.gain : 1;
    if (files.length) out.sounds[name] = { files, gain };
  }
  return out;
}

/** A file's URL in the set: `<base>/<file>`, joined with exactly one slash. */
export function sampleUrl(base: string, file: string): string {
  return `${base.replace(/\/+$/, "")}/${file}`;
}

/** A take index in [0, n), never `last` again when there are two or more takes. */
export function pickTake(n: number, last: number, rnd: () => number = Math.random): number {
  if (n <= 1) return 0;
  if (last < 0 || last >= n) return Math.min(n - 1, Math.floor(rnd() * n));
  const i = Math.min(n - 2, Math.floor(rnd() * (n - 1)));
  return i >= last ? i + 1 : i;
}

/** Per-play variation for samples: pitch ±6 %, level −1.5 dB…0, so repeats don't sound copied. */
export function jitter(rnd: () => number = Math.random): { rate: number; gain: number } {
  return { rate: 0.94 + rnd() * 0.12, gain: 0.84 + rnd() * 0.16 };
}

export interface SampleIo<B> {
  json(url: string): Promise<unknown>;
  /** Fetch and decode one file. */
  buffer(url: string): Promise<B>;
}

interface Loaded<B> {
  takes: B[];
  gain: number;
  last: number;
}

/** Decoded samples by sound name. `B` is AudioBuffer in the game (anything in tests). */
export class SampleBank<B> {
  private readonly loaded = new Map<SampleName, Loaded<B>>();

  constructor(private readonly io: SampleIo<B>) {}

  /**
   * Load a set. Resolves to the number of sounds now held; a missing manifest or failing file is
   * logged once and leaves those sounds on ZzFX.
   */
  async load(base: string): Promise<number> {
    let manifest: SampleManifest;
    try {
      manifest = parseManifest(await this.io.json(sampleUrl(base, "manifest.json")));
    } catch (e) {
      console.info(`[sfx] no sample set at ${base} (${String(e)}); using ZzFX`);
      return 0;
    }
    const failed: string[] = [];
    await Promise.all(
      Object.entries(manifest.sounds).map(async ([name, entry]) => {
        const results = await Promise.allSettled(entry.files.map((f) => this.io.buffer(sampleUrl(base, f))));
        const takes: B[] = [];
        results.forEach((r, i) => (r.status === "fulfilled" ? takes.push(r.value) : failed.push(entry.files[i]!)));
        if (takes.length) this.loaded.set(name as SampleName, { takes, gain: entry.gain, last: -1 });
      }),
    );
    if (failed.length) console.warn(`[sfx] ${failed.length} sample file(s) failed, ZzFX stands in: ${failed.join(", ")}`);
    console.info(`[sfx] ${this.loaded.size} sampled sounds from ${manifest.set || base}`);
    return this.loaded.size;
  }

  has(name: string): boolean {
    return isSampleName(name) && this.loaded.has(name);
  }

  /** A take of a sound (not the previous one) and the set's gain for it, or null if not held. */
  pick(name: string, rnd: () => number = Math.random): { buffer: B; gain: number } | null {
    const s = isSampleName(name) ? this.loaded.get(name) : undefined;
    if (!s) return null;
    s.last = pickTake(s.takes.length, s.last, rnd);
    return { buffer: s.takes[s.last]!, gain: s.gain };
  }
}

export type Resolved<B> = { kind: "sample"; buffer: B; gain: number; rate: number } | { kind: "zzfx"; preset: PresetName; gain: number; rate: number };

/**
 * What plays for a sound: a random take with jitter when the bank holds it, else its ZzFX preset
 * (ZzFX keeps its own ±6 % pitch randomisation in GameAudio.play).
 */
export function resolveSound<B>(name: SoundName, bank: SampleBank<B> | null, rnd: () => number = Math.random): Resolved<B> {
  const s = bank?.pick(name, rnd);
  if (s) {
    const j = jitter(rnd);
    return { kind: "sample", buffer: s.buffer, gain: s.gain * j.gain, rate: j.rate };
  }
  const f = fallbackOf(name);
  return { kind: "zzfx", preset: f.preset, gain: f.gain, rate: f.rate };
}
