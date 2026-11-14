// Spoken lines (2026-11-13, voice lane): characters say authored lines (shared content/dialogue.ts
// SPOKEN_LINES), recorded with a free local text-to-speech model by tools/voice and shipped in the
// client (public/voice/<id>.mp3, listed with their text keys in voiceLines.json). A file plays only
// when it was made from the line's current words, so the voice always matches the subtitle; without
// one (or with the sound off) the subtitle alone shows. Subtitles are on by default (Settings → Audio).

import type * as THREE from "three/webgpu";
import { SPOKEN_BY_ID, textKey } from "@firstlight/shared/content/dialogue";
import type { GameAudio } from "./Audio.ts";
import manifest from "./voiceLines.json";
import { showSubtitle } from "../ui/subtitle.ts";
import { uiSettings } from "../ui/uiSettings.ts";

const LINES = (manifest as { lines: Record<string, { k: string; ms: number }> }).lines;

/** A line has a recording that matches its current text. */
export function hasVoice(id: string, lines: Record<string, { k: string; ms: number }> = LINES): boolean {
  const l = SPOKEN_BY_ID.get(id);
  const e = lines[id];
  return !!l && !!e && e.k === textKey(l.text);
}

/** Where a line's file is served (Vite's public dir, under the app's base path). */
export function voiceUrl(id: string, base: string = import.meta.env?.BASE_URL ?? "/"): string {
  return `${base.replace(/\/*$/, "/")}voice/${encodeURIComponent(id)}.mp3`;
}

/** How long the subtitle stays: the recording plus a beat, or a reading time for the text. */
export function subtitleMs(id: string, text: string, lines: Record<string, { k: string; ms: number }> = LINES): number {
  const rec = hasVoice(id, lines) ? lines[id]!.ms + 900 : 0;
  return Math.min(9000, Math.max(rec, 2500 + text.length * 45));
}

const cache = new Map<string, Promise<AudioBuffer | null>>();

function load(audio: GameAudio, id: string): Promise<AudioBuffer | null> {
  let p = cache.get(id);
  if (!p) {
    p = fetch(voiceUrl(id))
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((b) => audio.ctx.decodeAudioData(b))
      .catch(() => {
        cache.delete(id); // try again next time (a dropped connection shouldn't mute a character for good)
        return null;
      });
    cache.set(id, p);
  }
  return p;
}

/** Fetch and decode lines ahead of time (a guide's greetings when you walk up), so they start at once. */
export function preload(audio: GameAudio, ids: readonly string[]) {
  for (const id of ids) if (hasVoice(id)) void load(audio, id);
}

/** What's playing per speaker: a new line from the same speaker cuts the old one. */
const playing = new Map<string, AudioBufferSourceNode>();

export interface SayOptions {
  /** Subtitle speaker name; no subtitle when null (the caller shows its own, e.g. a resident's bubble). */
  name: string | null;
  /** Where the speaker stands (positional); omitted: heard everywhere (bosses). */
  at?: THREE.Vector3 | null;
  /** Who speaks, so the same voice never talks over itself (defaults to the name). */
  key?: string;
}

/** Say a spoken line: its subtitle (if subtitles are on) and its recording. Returns the subtitle's ms. */
export function say(audio: GameAudio | null | undefined, id: string, o: SayOptions): number {
  const line = SPOKEN_BY_ID.get(id);
  if (!line) return 0;
  const ms = subtitleMs(id, line.text);
  if (o.name !== null && uiSettings.get().subtitles) showSubtitle(o.name, line.text, ms);
  if (!audio || !hasVoice(id)) return ms;
  const key = o.key ?? o.name ?? line.speaker;
  void load(audio, id).then((buf) => {
    if (!buf || audio.ctx.state !== "running") return;
    playing.get(key)?.stop();
    const src = audio.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(audio.spatial(o.at ?? null, audio.speech, { refDistance: 3, maxDistance: 45, rolloff: 1.4 }));
    src.onended = () => {
      if (playing.get(key) === src) playing.delete(key);
    };
    playing.set(key, src);
    audio.duckMusic(buf.duration);
    src.start();
  });
  return ms;
}
