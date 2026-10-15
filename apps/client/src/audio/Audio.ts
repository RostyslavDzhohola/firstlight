// Game audio: one AudioContext, master/music/SFX/voice buses, positional SFX, and a generative
// ambient soundtrack per body. SFX are ElevenLabs samples from the asset Worker where the set has
// them (samples.ts, never in the repo) and ZzFX presets (MIT, synthesised) for everything else.

import * as THREE from "three/webgpu";
import { ZZFX } from "zzfx";
import { WEAPONS } from "@firstlight/shared/content/weapons";
import type { BodyId } from "@firstlight/shared";
import { PRESETS, type PresetName } from "./presets.ts";
import { resolveSound, SampleBank } from "./samples.ts";
import { attackSound, impactSound, swingSound, type SoundName } from "./sounds.ts";

export interface Volumes {
  master: number;
  music: number;
  sfx: number;
  voice: number;
}

const DEFAULT_VOLUMES: Volumes = { master: 0.8, music: 0.35, sfx: 0.8, voice: 1 };

export class GameAudio {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly music: GainNode;
  readonly sfx: GainNode;
  readonly voice: GainNode;
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
    this.music.connect(this.master);
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
    if (at) {
      const p = this.ctx.createPanner();
      p.panningModel = "equalpower";
      p.distanceModel = "inverse";
      p.refDistance = 4;
      p.maxDistance = 160;
      p.rolloffFactor = 1.2;
      p.positionX.value = at.x;
      p.positionY.value = at.y;
      p.positionZ.value = at.z;
      src.connect(g).connect(p).connect(this.sfx);
    } else {
      src.connect(g).connect(this.sfx);
    }
    src.start();
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
    this.musicGen?.start();
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

// ---------------------------------------------------------------- generative ambient soundtrack

interface Mood {
  bpm: number;
  root: number; // MIDI note
  scale: number[]; // semitone offsets
  chords: number[][]; // degrees (indexes into scale) per chord
  padCutoff: number;
  arpWave: OscillatorType;
  arpDensity: number; // 0..1 chance per 8th note
  kick: boolean;
}

const MOODS: Record<BodyId, Mood> = {
  portus: { bpm: 84, root: 57, scale: [0, 2, 4, 7, 9, 12, 14, 16], chords: [[0, 2, 4], [3, 5, 7], [1, 3, 5], [0, 3, 4]], padCutoff: 1400, arpWave: "triangle", arpDensity: 0.55, kick: false },
  arcadia: { bpm: 96, root: 62, scale: [0, 2, 4, 7, 9, 12, 14, 16, 19], chords: [[0, 2, 4], [4, 6, 8], [3, 5, 7], [1, 3, 5]], padCutoff: 1800, arpWave: "square", arpDensity: 0.7, kick: false },
  hollowmere: { bpm: 64, root: 50, scale: [0, 2, 3, 7, 8, 12, 14, 15], chords: [[0, 2, 3], [4, 5, 7], [2, 4, 5], [0, 3, 4]], padCutoff: 700, arpWave: "sine", arpDensity: 0.3, kick: false },
  meridian: { bpm: 108, root: 52, scale: [0, 3, 5, 7, 10, 12, 15, 17], chords: [[0, 2, 3], [1, 3, 4], [2, 4, 5], [0, 3, 5]], padCutoff: 1100, arpWave: "sawtooth", arpDensity: 0.6, kick: true },
};

const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

class MusicGen {
  private timer = 0;
  private nextTime = 0;
  private step = 0;
  private readonly mood: Mood;
  private readonly out: GainNode;

  constructor(private readonly ctx: AudioContext, dest: AudioNode, body: BodyId) {
    this.mood = MOODS[body];
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(dest);
  }

  start() {
    this.nextTime = this.ctx.currentTime + 0.1;
    this.out.gain.setTargetAtTime(0.9, this.ctx.currentTime, 2);
    this.timer = window.setInterval(() => this.schedule(), 50);
  }

  stop() {
    clearInterval(this.timer);
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(0, t, 0.6);
    setTimeout(() => this.out.disconnect(), 3000);
  }

  private schedule() {
    const eighth = 60 / this.mood.bpm / 2;
    while (this.nextTime < this.ctx.currentTime + 0.25) {
      this.playStep(this.step, this.nextTime, eighth);
      this.step++;
      this.nextTime += eighth;
    }
  }

  private note(deg: number, octave = 0): number {
    const s = this.mood.scale;
    const n = s[((deg % s.length) + s.length) % s.length]! + 12 * (Math.floor(deg / s.length) + octave);
    return this.mood.root + n;
  }

  private playStep(step: number, t: number, eighth: number) {
    const m = this.mood;
    const bar = Math.floor(step / 8);
    const chord = m.chords[Math.floor(bar / 2) % m.chords.length]!;
    if (step % 16 === 0) for (const d of chord) this.pad(midiHz(this.note(d, -1)), t, eighth * 16);
    if (step % 8 === 0) this.bass(midiHz(this.note(chord[0]!, -2)), t, eighth * 6);
    if (m.kick && step % 4 === 0) this.kick(t);
    if (Math.random() < m.arpDensity) {
      const d = chord[step % chord.length]! + (step % 6 === 5 ? 2 : 0);
      this.pluck(midiHz(this.note(d, step % 16 < 8 ? 1 : 0)), t, eighth * 0.9);
    }
  }

  private pad(freq: number, t: number, dur: number) {
    const c = this.ctx;
    const g = c.createGain();
    const f = c.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = this.mood.padCutoff;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.045, t + dur * 0.3);
    g.gain.linearRampToValueAtTime(0, t + dur);
    for (const det of [-7, 7]) {
      const o = c.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = freq;
      o.detune.value = det;
      o.connect(f);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
    f.connect(g).connect(this.out);
  }

  private bass(freq: number, t: number, dur: number) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = "sine";
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private pluck(freq: number, t: number, dur: number) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    const f = c.createBiquadFilter();
    o.type = this.mood.arpWave;
    o.frequency.value = freq;
    f.type = "lowpass";
    f.frequency.setValueAtTime(3000, t);
    f.frequency.exponentialRampToValueAtTime(400, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.03, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f).connect(g).connect(this.out);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private kick(t: number) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.15);
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + 0.3);
  }
}
