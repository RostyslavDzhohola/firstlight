// Game audio: one AudioContext, master/music/SFX/voice/speech buses, positional SFX, and a generative
// ambient soundtrack per body (music.ts). `speech` carries the characters' recorded lines (speech.ts); `voice`
// is voice chat. SFX are ElevenLabs samples from the asset Worker where the set has
// them (samples.ts, never in the repo) and ZzFX presets (MIT, synthesised) for everything else.

import * as THREE from "three/webgpu";
import { ZZFX } from "zzfx";
import { WEAPONS } from "@firstlight/shared/content/weapons";
import type { BodyId } from "@firstlight/shared";
import { PRESETS, type PresetName } from "./presets.ts";
import { resolveSound, SampleBank } from "./samples.ts";
import { attackSound, impactSound, swingSound, type SoundName } from "./sounds.ts";
import { MusicGen } from "./music.ts";

export interface Volumes {
  master: number;
  music: number;
  sfx: number;
  voice: number;
  /** Characters' spoken lines (Settings → Audio → Voices). */
  speech: number;
}

const DEFAULT_VOLUMES: Volumes = { master: 0.8, music: 0.35, sfx: 0.8, voice: 1, speech: 0.9 };

export class GameAudio {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly music: GainNode;
  readonly sfx: GainNode;
  readonly voice: GainNode;
  readonly speech: GainNode;
  /** Music ducks under speech: this gain sits between the music bus and the master. */
  private readonly musicDuck: GainNode;
  private duckUntil = 0;
  private readonly buffers = new Map<PresetName, AudioBuffer>();
  private samples: SampleBank<AudioBuffer> | null = null;
  private musicGen: MusicGen | null = null;
  volumes: Volumes;

  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.music = this.ctx.createGain();
    this.sfx = this.ctx.createGain();
    this.voice = this.ctx.createGain();
    this.speech = this.ctx.createGain();
    this.musicDuck = this.ctx.createGain();
    this.music.connect(this.musicDuck).connect(this.master);
    this.speech.connect(this.master);
    this.sfx.connect(this.master);
    this.voice.connect(this.master);
    this.master.connect(this.ctx.destination);
    const saved = localStorage.getItem("fl.volumes");
    this.volumes = { ...DEFAULT_VOLUMES, ...(saved ? (JSON.parse(saved) as Partial<Volumes>) : {}) };
    this.applyVolumes();
  }

  applyVolumes() {
    this.master.gain.value = this.volumes.master;
    this.music.gain.value = this.volumes.music;
    this.sfx.gain.value = this.volumes.sfx;
    this.voice.gain.value = this.volumes.voice;
    this.speech.gain.value = this.volumes.speech;
    localStorage.setItem("fl.volumes", JSON.stringify(this.volumes));
  }

  /** Must be called inside a user gesture at least once. */
  resume() {
    if (this.ctx.state !== "running") void this.ctx.resume();
  }

  /**
   * Fetch and decode the sample set once (a failing manifest or file leaves those sounds on ZzFX).
   * decodeAudioData works while the context waits for a user gesture, so this can start at once.
   */
  loadSamples(base: string): Promise<number> {
    const bank = new SampleBank<AudioBuffer>({
      json: async (url) => {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      },
      buffer: async (url) => {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return this.ctx.decodeAudioData(await r.arrayBuffer());
      },
      peak: (b) => {
        let p = 0;
        for (let c = 0; c < b.numberOfChannels; c++) for (const v of b.getChannelData(c)) p = Math.max(p, Math.abs(v));
        return p;
      },
    });
    this.samples = bank;
    return bank.load(base);
  }

  private zzfx(name: PresetName): AudioBuffer {
    let b = this.buffers.get(name);
    if (b) return b;
    const samples = (ZZFX.buildSamples as (...p: (number | undefined)[]) => number[])(...PRESETS[name]);
    b = this.ctx.createBuffer(1, samples.length, ZZFX.sampleRate);
    b.getChannelData(0).set(samples);
    this.buffers.set(name, b);
    return b;
  }

  /** Play a sound, positional if `at` is given: a random sample take if loaded, else its ZzFX preset. */
  play(name: SoundName, at?: THREE.Vector3 | null, gain = 1, rate = 1) {
    if (this.ctx.state !== "running") return;
    const r = resolveSound(name, this.samples);
    const src = this.ctx.createBufferSource();
    if (r.kind === "sample") {
      src.buffer = r.buffer;
      src.playbackRate.value = rate * r.rate;
    } else {
      src.buffer = this.zzfx(r.preset);
      src.playbackRate.value = rate * r.rate * (0.94 + Math.random() * 0.12);
    }
    const g = this.ctx.createGain();
    g.gain.value = gain * r.gain;
    src.connect(g).connect(this.spatial(at ?? null, this.sfx));
    src.start();
  }

  /**
   * The node a source connects to, to be heard from `at` (a panner on the way to `bus`), or `bus`
   * itself when there is no position. Speech uses a shorter reach than effects.
   */
  spatial(at: THREE.Vector3 | null, bus: AudioNode, o: { refDistance?: number; maxDistance?: number; rolloff?: number } = {}): AudioNode {
    if (!at) return bus;
    const p = this.ctx.createPanner();
    p.panningModel = "equalpower";
    p.distanceModel = "inverse";
    p.refDistance = o.refDistance ?? 4;
    p.maxDistance = o.maxDistance ?? 160;
    p.rolloffFactor = o.rolloff ?? 1.2;
    p.positionX.value = at.x;
    p.positionY.value = at.y;
    p.positionZ.value = at.z;
    p.connect(bus);
    return p;
  }

  /** Lower the music by about 6 dB for `seconds` (a character is speaking), then bring it back. */
  duckMusic(seconds: number) {
    const t = this.ctx.currentTime;
    this.duckUntil = Math.max(this.duckUntil, t + seconds);
    const g = this.musicDuck.gain;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(0.5, t, 0.08);
    g.setTargetAtTime(1, this.duckUntil + 0.2, 0.5);
  }

  /** A weapon's fire, cast or throw sound (melee weapons: their swing), by weapon index. */
  weaponSound(weaponIndex: number): SoundName {
    return attackSound(WEAPONS[weaponIndex]);
  }

  /** A melee weapon's swing, by weapon index. */
  swingSound(weaponIndex: number): SoundName {
    return swingSound(WEAPONS[weaponIndex]?.id ?? "fists");
  }

  /** A non-exploding projectile landing, by weapon index. */
  impactSound(weaponIndex: number): SoundName {
    return impactSound(WEAPONS[weaponIndex]);
  }

  /** Listener follows the camera. */
  updateListener(camera: THREE.Camera) {
    const l = this.ctx.listener;
    const pos = camera.getWorldPosition(new THREE.Vector3());
    const fwd = camera.getWorldDirection(new THREE.Vector3());
    const up = camera.up;
    if (l.positionX) {
      const t = this.ctx.currentTime;
      l.positionX.setTargetAtTime(pos.x, t, 0.02);
      l.positionY.setTargetAtTime(pos.y, t, 0.02);
      l.positionZ.setTargetAtTime(pos.z, t, 0.02);
      l.forwardX.setTargetAtTime(fwd.x, t, 0.02);
      l.forwardY.setTargetAtTime(fwd.y, t, 0.02);
      l.forwardZ.setTargetAtTime(fwd.z, t, 0.02);
      l.upX.setTargetAtTime(up.x, t, 0.02);
      l.upY.setTargetAtTime(up.y, t, 0.02);
      l.upZ.setTargetAtTime(up.z, t, 0.02);
    }
  }

  setMusic(body: BodyId | null) {
    this.musicGen?.stop();
    this.musicGen = body ? new MusicGen(this.ctx, this.music, body) : null;
    this.musicGen?.setNight(this.night);
    this.musicGen?.start();
  }

  /** You hit something or something hit you: the music's combat layer comes in (and leaves a few seconds after the last call). */
  fight() {
    if (this.ctx.state === "running") this.musicGen?.setCombat(true);
  }

  private night = 0;

  /** The sky's night factor (0 day … 1 night): the music turns to its night variant. Cheap to call every frame. */
  setNight(n: number) {
    if (Math.abs(n - this.night) < 0.02) return;
    this.night = n;
    this.musicGen?.setNight(n);
  }

  private ambience: WeatherAmbience | null = null;

  /** Weather bed: rain hiss (0..1) and wind/dust (0..1). Cheap to call every frame. */
  setWeather(rain: number, wind: number) {
    if (this.ctx.state !== "running") return;
    if (!this.ambience) {
      if (rain < 0.01 && wind < 0.01) return;
      this.ambience = new WeatherAmbience(this.ctx, this.sfx);
    }
    this.ambience.set(rain, wind);
  }

  /** A thunder rumble arriving after `delaySec` from a strike `distance` metres away. */
  thunder(delaySec: number, distance: number) {
    if (this.ctx.state !== "running") return;
    (this.ambience ??= new WeatherAmbience(this.ctx, this.sfx)).thunder(delaySec, distance);
  }
}

// ---------------------------------------------------------------- weather ambience (all synthesised)

/** Looping noise beds for rain and wind plus thunder rumbles; no samples. */
class WeatherAmbience {
  private readonly rainGain: GainNode;
  private readonly windGain: GainNode;
  private readonly brown: AudioBuffer;
  private rain = -1;
  private wind = -1;

  constructor(private readonly ctx: AudioContext, private readonly dest: AudioNode) {
    const sr = ctx.sampleRate;
    const len = sr * 3;
    // White-ish noise for rain, brown noise for wind and thunder.
    const white = ctx.createBuffer(1, len, sr);
    const w = white.getChannelData(0);
    for (let i = 0; i < len; i++) w[i] = Math.random() * 2 - 1;
    this.brown = ctx.createBuffer(1, len, sr);
    const b = this.brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      b[i] = last * 3.5;
    }
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    const rainSrc = ctx.createBufferSource();
    rainSrc.buffer = white;
    rainSrc.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 900;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 7000;
    rainSrc.connect(hp).connect(lp).connect(this.rainGain).connect(dest);
    rainSrc.start();
    const windSrc = ctx.createBufferSource();
    windSrc.buffer = this.brown;
    windSrc.loop = true;
    const wlp = ctx.createBiquadFilter();
    wlp.type = "lowpass";
    wlp.frequency.value = 520;
    wlp.Q.value = 0.9;
    // Slow gusts.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.11;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 220;
    lfo.connect(lfoGain).connect(wlp.frequency);
    lfo.start();
    windSrc.connect(wlp).connect(this.windGain).connect(dest);
    windSrc.start();
  }

  set(rain: number, wind: number) {
    const t = this.ctx.currentTime;
    if (Math.abs(rain - this.rain) > 0.01) {
      this.rain = rain;
      this.rainGain.gain.setTargetAtTime(rain * 0.22, t, 0.6);
    }
    if (Math.abs(wind - this.wind) > 0.01) {
      this.wind = wind;
      this.windGain.gain.setTargetAtTime(wind * 0.35, t, 0.8);
    }
  }

  thunder(delaySec: number, distance: number) {
    const t = this.ctx.currentTime + Math.max(0, delaySec);
    const src = this.ctx.createBufferSource();
    src.buffer = this.brown;
    src.playbackRate.value = 0.55 + Math.random() * 0.2;
    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(1100, t);
    lp.frequency.exponentialRampToValueAtTime(110, t + 2.6);
    const g = this.ctx.createGain();
    const peak = Math.max(0.25, Math.min(1, 300 / Math.max(1, distance))) * 1.1;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.06);
    g.gain.exponentialRampToValueAtTime(peak * 0.45, t + 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.6);
    src.connect(lp).connect(g).connect(this.dest);
    src.start(t, Math.random() * 0.5);
    src.stop(t + 3.8);
  }
}
