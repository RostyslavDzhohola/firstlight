// Spoken lines (2026-11-13, voice lane): characters say authored lines (shared content/dialogue.ts
// SPOKEN_LINES), recorded with a free local text-to-speech model by tools/voice and shipped in the
// client (public/voice/<id>.mp3, listed with their text keys in voiceLines.json). A file plays only
// when it was made from the line's current words, so the voice always matches the subtitle; without
// one (or with the sound off) the subtitle alone shows. Subtitles are on by default (Settings → Audio).
//
// Review 2026-11-13 (findings 1, 2, 4): the latest request per speaker wins (a load that finishes after
// a newer request is dropped unplayed and never touches the subtitle); the subtitle is held from the
// moment the recording starts for all of it; a speaker is busy until its playback really ends;
// leaving the body forgets everything; decoded recordings live in a byte-bounded cache.

import type * as THREE from "three/webgpu";
import { SPOKEN_BY_ID, textKey } from "@firstlight/shared/content/dialogue";
import type { GameAudio } from "./Audio.ts";
import manifest from "./voiceLines.json";
import { hideSubtitle, holdSubtitle, showSubtitle } from "../ui/subtitle.ts";
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

/**
 * The decoded-recording budget (D-voice-fix-2): 32 MiB of PCM, about 175 s of speech at 48 kHz mono
 * float, some 40 lines at the median length, enough for every character near you on one body.
 */
export const SPEECH_CACHE_BYTES = 32 * 1024 * 1024;

/** The parts of a decoded recording the player needs (an AudioBuffer). */
export interface VoiceBuffer {
  readonly duration: number;
  readonly length: number;
  readonly numberOfChannels: number;
}

/** What one decoded recording costs in memory: 32-bit float samples per channel. */
export const voiceBytes = (b: VoiceBuffer) => b.length * b.numberOfChannels * 4;

/**
 * Decoded recordings by line id, bounded by bytes: the least recently used goes first, never one that
 * is playing (pinned). While several pinned ones are over the bound it is passed, and restored as they end.
 */
export class VoiceCache<B extends VoiceBuffer> {
  private readonly map = new Map<string, B>(); // insertion order = use order, oldest first
  private readonly pins = new Map<string, number>();
  bytes = 0;

  constructor(readonly maxBytes: number) {}

  get(id: string): B | undefined {
    const b = this.map.get(id);
    if (b) {
      this.map.delete(id);
      this.map.set(id, b);
    }
    return b;
  }

  put(id: string, b: B) {
    const old = this.map.get(id);
    if (old) this.bytes -= voiceBytes(old);
    this.map.delete(id);
    this.map.set(id, b);
    this.bytes += voiceBytes(b);
    this.trim();
  }

  pin(id: string) {
    this.pins.set(id, (this.pins.get(id) ?? 0) + 1);
  }

  unpin(id: string) {
    const n = (this.pins.get(id) ?? 0) - 1;
    if (n > 0) this.pins.set(id, n);
    else this.pins.delete(id);
    this.trim();
  }

  ids(): string[] {
    return [...this.map.keys()].sort();
  }

  private trim() {
    for (const [id, b] of this.map) {
      if (this.bytes <= this.maxBytes) return;
      if (this.pins.has(id)) continue;
      this.map.delete(id);
      this.bytes -= voiceBytes(b);
    }
  }
}

/** The parts of GameAudio the player uses (fakes in tests). */
export interface SpeechOutput {
  readonly ctx: Pick<BaseAudioContext, "state" | "createBufferSource" | "decodeAudioData">;
  readonly speech: AudioNode;
  spatial(at: THREE.Vector3 | null, bus: AudioNode, o?: { refDistance?: number; maxDistance?: number; rolloff?: number }): AudioNode;
  duckMusic(seconds: number): void;
}

export interface SpeechHooks {
  /** A line's compressed file. */
  fetchBytes(id: string): Promise<ArrayBuffer>;
  subtitle: { show(name: string, text: string, ms: number): number; hold(token: number, ms: number): void; hide(token: number): void };
  subtitlesOn(): boolean;
  /** Milliseconds, any origin. */
  now(): number;
  maxBytes?: number;
}

const DEFAULT_HOOKS: SpeechHooks = {
  fetchBytes: (id) => fetch(voiceUrl(id)).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status))))),
  subtitle: { show: showSubtitle, hold: holdSubtitle, hide: hideSubtitle },
  subtitlesOn: () => uiSettings.get().subtitles,
  now: () => performance.now(),
};

/** The subtitle stays this long after the recording ends. */
const AFTER_MS = 900;

/** One say() of one speaker: loading, playing, or (text only) shown until `until`. */
interface Request {
  id: string;
  sub: number | null;
  /** Busy until then while loading (the subtitle's time) or when there is no recording to play. */
  until: number;
  loading: boolean;
  src: AudioBufferSourceNode | null;
  /** Holds its recording in the cache from the request until it ends or is dropped. */
  pinned: boolean;
}

export interface SayOptions {
  /** Subtitle speaker name; no subtitle when null (the caller shows its own, e.g. a resident's bubble). */
  name: string | null;
  /** Where the speaker stands (positional); omitted: heard everywhere (bosses). */
  at?: THREE.Vector3 | null;
  /** Who speaks, so the same voice never talks over itself (defaults to the name). */
  key?: string;
}

/** Plays spoken lines for one GameAudio (or text only, with none). */
export class SpeechPlayer {
  private readonly hooks: SpeechHooks;
  private readonly cache: VoiceCache<AudioBuffer>;
  private readonly loading = new Map<string, Promise<AudioBuffer | null>>();
  /** The latest request per speaker: only it may play or touch the subtitle. */
  private readonly current = new Map<string, Request>();

  constructor(private readonly out: SpeechOutput | null, hooks: Partial<SpeechHooks> = {}) {
    this.hooks = { ...DEFAULT_HOOKS, ...hooks };
    this.cache = new VoiceCache(this.hooks.maxBytes ?? SPEECH_CACHE_BYTES);
  }

  private load(id: string): Promise<AudioBuffer | null> {
    const hit = this.cache.get(id);
    if (hit) return Promise.resolve(hit);
    let p = this.loading.get(id);
    if (!p) {
      const out = this.out!;
      // A failed load is forgotten, so a dropped connection never mutes a character for good.
      p = this.hooks
        .fetchBytes(id)
        .then((b) => out.ctx.decodeAudioData(b))
        .then(
          (buf) => (this.cache.put(id, buf), buf),
          () => null,
        )
        .finally(() => this.loading.delete(id));
      this.loading.set(id, p);
    }
    return p;
  }

  /** Fetch and decode lines ahead of time (a guide's greetings when you walk up), so they start at once. */
  preload(ids: readonly string[]) {
    if (this.out) for (const id of ids) if (hasVoice(id)) void this.load(id);
  }

  /** Say a spoken line: its subtitle (if subtitles are on) and its recording. Returns the subtitle's first ms. */
  say(id: string, o: SayOptions): number {
    const line = SPOKEN_BY_ID.get(id);
    if (!line) return 0;
    const ms = subtitleMs(id, line.text);
    const key = o.key ?? o.name ?? line.speaker;
    this.stop(key, false);
    const req: Request = { id, sub: null, until: this.hooks.now() + ms, loading: false, src: null, pinned: false };
    if (o.name !== null && this.hooks.subtitlesOn()) req.sub = this.hooks.subtitle.show(o.name, line.text, ms);
    this.current.set(key, req);
    if (!this.out || !hasVoice(id)) return ms;
    const out = this.out;
    req.loading = true;
    req.pinned = true;
    this.cache.pin(id);
    void this.load(id).then((buf) => {
      if (this.current.get(key) !== req) return this.release(req); // a newer line, or stopped: never plays
      req.loading = false;
      if (!buf || out.ctx.state !== "running") return this.release(req); // the subtitle keeps its reading time
      const src = out.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(out.spatial(o.at ?? null, out.speech, { refDistance: 3, maxDistance: 45, rolloff: 1.4 }));
      src.onended = () => {
        src.onended = null;
        this.release(req);
        if (this.current.get(key) === req) this.current.delete(key);
      };
      req.src = src;
      out.duckMusic(buf.duration);
      src.start();
      if (req.sub !== null) this.hooks.subtitle.hold(req.sub, Math.round(buf.duration * 1000) + AFTER_MS);
    });
    return ms;
  }

  private release(r: Request) {
    if (!r.pinned) return;
    r.pinned = false;
    this.cache.unpin(r.id);
  }

  /** Still saying something: loading (for as long as its subtitle shows), playing, or showing text only. */
  busy(key: string): boolean {
    const r = this.current.get(key);
    if (!r) return false;
    return !!r.src || this.hooks.now() < r.until;
  }

  /** Silence one speaker and forget their pending line (and take their subtitle down when `hide`). */
  stop(key: string, hide = true) {
    const r = this.current.get(key);
    if (!r) return;
    this.current.delete(key);
    if (r.src) {
      try {
        r.src.stop(); // its ended event releases the recording
      } catch {
        this.release(r); // never started or already stopped
      }
    } else if (!r.loading) this.release(r);
    if (hide && r.sub !== null) this.hooks.subtitle.hide(r.sub);
  }

  /** Leaving the body: everyone stops, nothing pending plays later, their subtitles go. */
  stopAll() {
    for (const key of [...this.current.keys()]) this.stop(key);
  }

  /** Decoded bytes held (tests, /stats). */
  cachedBytes(): number {
    return this.cache.bytes;
  }

  /** Line ids held decoded, sorted (tests). */
  cached(): string[] {
    return this.cache.ids();
  }
}

const players = new WeakMap<SpeechOutput, SpeechPlayer>();
let textOnly: SpeechPlayer | null = null;

/** The speech player of a GameAudio (one per audio context), or the text-only one without. */
export function speechOf(audio: SpeechOutput | null | undefined): SpeechPlayer {
  if (!audio) return (textOnly ??= new SpeechPlayer(null));
  let p = players.get(audio);
  if (!p) players.set(audio, (p = new SpeechPlayer(audio)));
  return p;
}

/** Fetch and decode lines ahead of time. */
export function preload(audio: GameAudio, ids: readonly string[]) {
  speechOf(audio).preload(ids);
}

/** Say a spoken line (see SpeechPlayer.say). */
export function say(audio: GameAudio | null | undefined, id: string, o: SayOptions): number {
  return speechOf(audio).say(id, o);
}

/** Leaving the body: stop and forget every spoken line. */
export function stopSpeech(audio: GameAudio | null | undefined) {
  speechOf(audio).stopAll();
}
