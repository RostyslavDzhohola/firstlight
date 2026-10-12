// Boss voice lines (ElevenLabs, served from the asset host, never in the repo) with per-boss
// processing and subtitles. Subtitles always show, so the lines work with sound off (accessibility).

import type { GameAudio } from "./Audio.ts";
import { config } from "../config.ts";
import { showSubtitle } from "../ui/subtitle.ts";

export type BossId = "tidewrath" | "hollowking" | "receiver";
export type BossTrigger = "engage" | "phase2" | "defeat";

/**
 * A clip's URL: `<asset base>/voice/<boss>-<trigger>.mp3`, the same base as every other asset
 * (config.assetBase = VITE_ASSET_BASE, which already ends in /v/<buildId>, SPEC §10.1). The clips
 * are deployed with each asset build; they are never in the repo, so without them (local dev) the
 * fetch fails and the subtitle alone plays.
 */
export function bossLineUrl(boss: BossId, trigger: BossTrigger, base: string = config.assetBase): string {
  return `${base.replace(/\/+$/, "")}/voice/${boss}-${trigger}.mp3`;
}

export const BOSS_LINES: Record<BossId, Record<BossTrigger, string>> = {
  tidewrath: { engage: "The lake was quiet. You woke it.", phase2: "Every tide comes back. So do I.", defeat: "The water... remembers you." },
  hollowking: { engage: "Kneel. The Court is in session.", phase2: "Every crown here was once a head.", defeat: "Ring the bell... for me." },
  receiver: { engage: "This planet is now under new management.", phase2: "Resistance has been noted on your file.", defeat: "Shutting down... pending review." },
};

const BOSS_NAMES: Record<BossId, string> = { tidewrath: "Tidewrath", hollowking: "The Hollow King", receiver: "The Receiver" };

const cache = new Map<string, Promise<AudioBuffer | null>>();

function load(audio: GameAudio, url: string): Promise<AudioBuffer | null> {
  let p = cache.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((b) => audio.ctx.decodeAudioData(b))
      .catch(() => null);
    cache.set(url, p);
  }
  return p;
}

/** Play a boss line with its voice treatment; shows a subtitle even if audio fails. */
export async function playBossLine(audio: GameAudio, boss: BossId, trigger: BossTrigger) {
  const text = BOSS_LINES[boss][trigger];
  showSubtitle(BOSS_NAMES[boss], text, 4500);
  const buf = await load(audio, bossLineUrl(boss, trigger));
  if (!buf || audio.ctx.state !== "running") return;
  const c = audio.ctx;
  const src = c.createBufferSource();
  src.buffer = buf;
  let node: AudioNode = src;
  if (boss === "tidewrath") {
    src.playbackRate.value = 0.78; // deeper, slower: something huge under the water
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 2200;
    node = node.connect(lp);
  } else if (boss === "hollowking") {
    src.playbackRate.value = 0.9;
    const delay = c.createDelay(0.5);
    delay.delayTime.value = 0.18;
    const fb = c.createGain();
    fb.gain.value = 0.28;
    delay.connect(fb).connect(delay); // a crypt echo
    const mix = c.createGain();
    node.connect(mix);
    node.connect(delay).connect(mix);
    node = mix;
  } else {
    const bp = c.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1700;
    bp.Q.value = 0.8; // PA-system voice
    node = node.connect(bp);
  }
  const g = c.createGain();
  g.gain.value = 1.6;
  node.connect(g).connect(audio.sfx);
  src.start();
}
