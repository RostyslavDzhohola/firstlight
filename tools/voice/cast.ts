// Who speaks with which Kokoro voice (tools/voice/generate.ts). Kokoro-82M v1.0 voices (Apache-2.0,
// hexgrad/Kokoro-82M VOICES.md): `a*` American English, `b*` British; `f` female, `m` male. A list
// is a blend (weighted mean of the style vectors) for a voice no single preset has. `fx` is an
// ffmpeg filter baked into the file (the bosses' treatments, formerly done at play time).

import type { SpeakerId } from "../../packages/shared/src/content/dialogue.ts";

export interface CastVoice {
  voice: string | [string, number][];
  speed: number;
  /** Optional ffmpeg -af chain at 24 kHz, applied before trimming and levelling. */
  fx?: string;
  /** One line on why this voice, for docs/ASSETS.md and the owner. */
  note: string;
}

export const CAST: Record<SpeakerId, CastVoice> = {
  // Named characters.
  lark: { voice: [["af_sky", 0.6], ["af_heart", 0.4]], speed: 1.06, note: "young, quick, a little bossy" },
  mabry: { voice: [["bm_george", 0.7], ["am_onyx", 0.3]], speed: 0.86, note: "old, slow, gravel" },
  rook: { voice: [["am_onyx", 0.5], ["am_michael", 0.5]], speed: 1.05, note: "low and quick, a man passing notes" },
  odile: { voice: "bf_isabella", speed: 0.96, note: "precise, a little lonely" },
  sela: { voice: "bf_emma", speed: 0.92, note: "calm, exact" },
  juno: { voice: "af_bella", speed: 1.08, note: "brisk shopkeeper" },
  pell: { voice: "am_puck", speed: 1.04, note: "chatty trader" },
  nell: { voice: "af_nicole", speed: 0.9, note: "close, near a whisper" },
  ostrow: { voice: "bm_lewis", speed: 0.95, note: "flat clerk" },
  tidewrath: { voice: "am_onyx", speed: 0.9, fx: "asetrate=19200,aresample=24000,lowpass=f=2200,apad=pad_dur=0.3", note: "pitched down, under water" },
  hollowking: { voice: "bm_fable", speed: 0.88, fx: "asetrate=21600,aresample=24000,apad=pad_dur=0.8,aecho=0.8:0.6:180|360:0.32|0.18", note: "slowed, crypt echo" },
  receiver: { voice: "am_eric", speed: 0.95, fx: "highpass=f=380,lowpass=f=3000,acompressor=threshold=0.1:ratio=6,apad=pad_dur=0.2", note: "PA system" },
  // Residents (residentLines.ts VOICES).
  brindle: { voice: "am_fenrir", speed: 0.95, note: "gruff hunter" },
  tamsin: { voice: "af_heart", speed: 0.95, note: "dreamy cartographer" },
  marlo: { voice: "am_liam", speed: 1.08, note: "upbeat salesman" },
  juniper: { voice: "af_kore", speed: 1.15, note: "fast, short bursts" },
  garnet: { voice: "am_echo", speed: 1.0, note: "even, methodical" },
  hesper: { voice: "af_aoede", speed: 0.9, note: "slow stargazer" },
  sable: { voice: "bf_alice", speed: 1.02, note: "appraiser" },
  corbin: { voice: [["am_puck", 0.5], ["am_liam", 0.5]], speed: 1.12, note: "nervous, hurried" },
  wendell: { voice: "bm_daniel", speed: 0.88, note: "old hunter" },
  odessa: { voice: "bf_lily", speed: 0.95, note: "gentle forager" },
  ptolemy: { voice: [["bm_fable", 0.6], ["bm_lewis", 0.4]], speed: 1.0, note: "grand would-be merchant prince" },
  isla: { voice: "af_sarah", speed: 1.08, note: "conspiratorial" },
};

/** The language a voice reads in: British voices get British pronunciation. */
export function langOf(v: CastVoice["voice"]): "en-us" | "en-gb" {
  const first = typeof v === "string" ? v : v[0]![0];
  return first.startsWith("b") ? "en-gb" : "en-us";
}
