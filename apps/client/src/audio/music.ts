// The generated soundtrack (synthesised in the browser, no samples, no model): one piece per body.
// Each body has a mood (tempo, key, chords, timbre) and an authored theme, a four-bar melody that
// comes back every other phrase so a world is recognisable by ear. Around it: a pad, a bass line, a
// seeded arpeggio (the same notes every time you visit), a room reverb, and two layers that follow
// the game: a combat layer (drums and a driving bass) that comes in when a fight starts and leaves
// a few seconds after it ends, and a night variant (darker pad, lower and softer theme, fewer
// notes, slow high bells).
//
// Scheduling is by time, not by timer: `scheduleUntil(t)` writes every note up to `t`, so the same
// code plays live (a 50 ms timer keeps 250 ms ahead) and renders offline (tools/voice/render-music.ts
// renders a minute of each body into an OfflineAudioContext).

import type { BodyId } from "@firstlight/shared";

/** One theme note: start (sixteenth steps into the four-bar phrase), scale degree, length in steps. */
export type ThemeNote = readonly [step: number, degree: number, len: number];

export interface Mood {
  bpm: number;
  root: number; // MIDI note
  scale: readonly number[]; // semitone offsets
  chords: readonly (readonly number[])[]; // degrees (indexes into scale), one per two bars
  padCutoff: number;
  leadWave: OscillatorType;
  arpWave: OscillatorType;
  arpDensity: number; // 0..1 chance per eighth note (seeded)
  /** Drums in calm play too (Meridian's machine pulse). */
  kick: boolean;
  /** Reverb send 0..1. */
  space: number;
  theme: readonly ThemeNote[];
}

export const MOODS: Record<BodyId, Mood> = {
  // The hub: warm, unhurried, a tune you can hum on the way to a portal.
  portus: {
    bpm: 84, root: 57, scale: [0, 2, 4, 7, 9, 12, 14, 16], chords: [[0, 2, 4], [3, 5, 7], [1, 3, 5], [0, 3, 4]], padCutoff: 1400,
    leadWave: "triangle", arpWave: "triangle", arpDensity: 0.45, kick: false, space: 0.3,
    theme: [[0, 4, 4], [4, 5, 2], [6, 6, 2], [8, 4, 6], [16, 3, 4], [20, 4, 2], [22, 3, 2], [24, 2, 8], [32, 4, 4], [36, 5, 2], [38, 6, 2], [40, 7, 6], [48, 6, 4], [52, 4, 4], [56, 3, 8]],
  },
  // Meadows: bright and bouncy, short notes.
  arcadia: {
    bpm: 96, root: 62, scale: [0, 2, 4, 7, 9, 12, 14, 16, 19], chords: [[0, 2, 4], [4, 6, 8], [3, 5, 7], [1, 3, 5]], padCutoff: 1800,
    leadWave: "square", arpWave: "triangle", arpDensity: 0.55, kick: false, space: 0.22,
    theme: [[0, 4, 2], [2, 4, 2], [4, 5, 2], [6, 4, 2], [8, 2, 4], [12, 3, 4], [16, 4, 2], [18, 5, 2], [20, 6, 4], [24, 5, 8], [32, 6, 2], [34, 5, 2], [36, 4, 2], [38, 5, 2], [40, 3, 4], [44, 2, 4], [48, 1, 4], [52, 2, 4], [56, 0, 8]],
  },
  // Fog and bells: slow, minor, long notes.
  hollowmere: {
    bpm: 64, root: 50, scale: [0, 2, 3, 7, 8, 12, 14, 15], chords: [[0, 2, 3], [4, 5, 7], [2, 4, 5], [0, 3, 4]], padCutoff: 700,
    leadWave: "sine", arpWave: "sine", arpDensity: 0.28, kick: false, space: 0.5,
    theme: [[0, 4, 8], [8, 3, 4], [12, 2, 4], [16, 1, 12], [28, 0, 4], [32, 2, 8], [40, 3, 4], [44, 4, 4], [48, 1, 16]],
  },
  // The company planet: a machine pulse, a clipped riff.
  meridian: {
    bpm: 108, root: 52, scale: [0, 3, 5, 7, 10, 12, 15, 17], chords: [[0, 2, 3], [1, 3, 4], [2, 4, 5], [0, 3, 5]], padCutoff: 1100,
    leadWave: "sawtooth", arpWave: "sawtooth", arpDensity: 0.5, kick: true, space: 0.18,
    theme: [[0, 0, 2], [2, 0, 2], [4, 3, 2], [6, 0, 2], [8, 4, 2], [10, 3, 2], [12, 2, 4], [16, 0, 2], [18, 0, 2], [20, 3, 2], [22, 0, 2], [24, 5, 4], [28, 4, 4], [32, 0, 2], [34, 0, 2], [36, 3, 2], [38, 0, 2], [40, 4, 2], [42, 5, 2], [44, 6, 4], [48, 5, 4], [52, 4, 4], [56, 3, 8]],
  },
  // The moon: slow, wide and weightless (lydian), a few long notes.
  lumen: {
    bpm: 58, root: 55, scale: [0, 2, 4, 6, 7, 11, 12, 14, 16], chords: [[0, 2, 4], [1, 3, 5], [4, 6, 8], [0, 3, 5]], padCutoff: 900,
    leadWave: "sine", arpWave: "sine", arpDensity: 0.22, kick: false, space: 0.6,
    theme: [[0, 4, 12], [16, 6, 8], [24, 5, 8], [32, 8, 16], [48, 7, 8], [56, 4, 8]],
  },
};

export const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

/** A small seeded random generator (mulberry32): the same arpeggio every visit. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The scale degree as a MIDI note (degrees past the scale wrap up an octave). */
export function degreeNote(mood: Mood, deg: number, octave = 0): number {
  const s = mood.scale;
  const n = s[((deg % s.length) + s.length) % s.length]! + 12 * (Math.floor(deg / s.length) + octave);
  return mood.root + n;
}

/** Theme notes starting on this step of a 64-step phrase. */
export function themeAt(mood: Mood, phraseStep: number): ThemeNote[] {
  return mood.theme.filter((n) => n[0] === phraseStep);
}

/** Combat spans and night changes over time (live: one open span; offline: a script). */
interface Span {
  from: number;
  to: number;
}

const COMBAT_TAIL_S = 5;

export class MusicGen {
  private timer = 0;
  private nextTime = 0;
  private step = 0;
  readonly mood: Mood;
  private readonly out: GainNode;
  private readonly dry: GainNode;
  private readonly wet: GainNode;
  private readonly combatBus: GainNode;
  private readonly noise: AudioBuffer;
  private readonly rnd: () => number;
  private night = 0;
  private readonly combat: Span[] = [];

  constructor(private readonly ctx: BaseAudioContext, dest: AudioNode, body: BodyId) {
    this.mood = MOODS[body];
    this.rnd = seeded([...body].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 0x811c9dc5));
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(dest);
    this.dry = ctx.createGain();
    this.dry.connect(this.out);
    // A room: a convolver on a decaying noise impulse (made once here, no file).
    const verb = ctx.createConvolver();
    verb.buffer = impulse(ctx, 2.6, 2.2);
    this.wet = ctx.createGain();
    this.wet.gain.value = this.mood.space;
    this.wet.connect(verb).connect(this.out);
    this.combatBus = ctx.createGain();
    this.combatBus.gain.value = 0;
    this.combatBus.connect(this.dry);
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    const r = seeded(7);
    for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1;
  }

  /** Live play: fade in and keep 250 ms of notes written ahead. */
  start() {
    this.nextTime = this.ctx.currentTime + 0.1;
    this.out.gain.setTargetAtTime(0.9, this.ctx.currentTime, 2);
    this.timer = window.setInterval(() => this.scheduleUntil(this.ctx.currentTime + 0.25), 50);
  }

  /** Offline render: start at `t`, full level at once. */
  startAt(t: number) {
    this.nextTime = t;
    this.out.gain.setValueAtTime(0.9, t);
  }

  stop() {
    clearInterval(this.timer);
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(0, t, 0.6);
    setTimeout(() => this.out.disconnect(), 3000);
  }

  /** A fight started (`on`) or is still going: the combat layer comes in, and stays COMBAT_TAIL_S after the last call. */
  setCombat(on: boolean, at = this.ctx.currentTime) {
    const last = this.combat[this.combat.length - 1];
    if (on) {
      if (last && at <= last.to + 0.5) last.to = Math.max(last.to, at + COMBAT_TAIL_S);
      else {
        this.combat.push({ from: at, to: at + COMBAT_TAIL_S });
        this.combatBus.gain.cancelScheduledValues(at);
        this.combatBus.gain.setTargetAtTime(1, at, 0.4);
      }
    } else if (last && last.to > at) last.to = at;
    if (this.combat.length > 8) this.combat.splice(0, this.combat.length - 8);
  }

  private inCombat(t: number): boolean {
    return this.combat.some((s) => t >= s.from && t < s.to);
  }

  /** How dark it is, 0 day … 1 night (the sky's night factor). Applies to notes from now on. */
  setNight(n: number) {
    this.night = Math.min(1, Math.max(0, n));
  }

  scheduleUntil(t: number) {
    const sixteenth = 60 / this.mood.bpm / 4;
    while (this.nextTime < t) {
      this.playStep(this.step, this.nextTime, sixteenth);
      this.step++;
      this.nextTime += sixteenth;
    }
  }

  private playStep(step: number, t: number, s16: number) {
    const m = this.mood;
    const night = this.night;
    const bar = Math.floor(step / 16);
    const phrase = Math.floor(step / 64);
    const chord = m.chords[Math.floor(bar / 2) % m.chords.length]!;
    const fight = this.inCombat(t);
    // The combat layer fades out once a fight is over (it was faded in by setCombat).
    if (!fight && step % 16 === 0) this.combatBus.gain.setTargetAtTime(0, t, 1.2);

    if (step % 32 === 0) for (const d of chord) this.pad(midiHz(degreeNote(m, d, -1)), t, s16 * 32, night);
    if (step % 16 === 0) this.bass(midiHz(degreeNote(m, chord[0]!, -2)), t, s16 * 10);
    if (step % 16 === 8) this.bass(midiHz(degreeNote(m, chord[Math.min(2, chord.length - 1)]!, -2)), t, s16 * 6, 0.6);
    if (m.kick && step % 4 === 0 && !fight) this.kick(t, 0.09);

    // The theme on even phrases; the arpeggio carries the odd ones (and sits under the theme quietly).
    const themePhrase = phrase % 2 === 0;
    if (themePhrase) for (const [, deg, len] of themeAt(m, step % 64)) this.lead(midiHz(degreeNote(m, deg, night > 0.5 ? 0 : 1)), t, s16 * len, night);
    if (step % 2 === 0) {
      const density = m.arpDensity * (themePhrase ? 0.5 : 1) * (1 - 0.6 * night);
      if (this.rnd() < density) {
        const i = (step / 2) % 4;
        const d = chord[i % chord.length]! + (i === 3 ? 2 : 0);
        this.pluck(midiHz(degreeNote(m, d, 1)), t, s16 * 1.8, night);
      }
    }
    // Night: a slow high bell now and then.
    if (night > 0.3 && step % 8 === 0 && this.rnd() < 0.18 * night) this.bell(midiHz(degreeNote(m, chord[Math.floor(this.rnd() * chord.length)]!, 2)), t);

    if (fight) {
      if (step % 4 === 0) this.kick(t, 0.16);
      if (step % 8 === 4) this.snare(t);
      if (step % 2 === 1) this.hat(t, step % 4 === 3 ? 0.05 : 0.03);
      if (step % 2 === 0) this.bass(midiHz(degreeNote(m, chord[0]!, -2)), t, s16 * 1.5, 0.7, this.combatBus);
      if (step % 64 === 60) this.tom(t);
    }
  }

  private send(node: AudioNode, wet = 1) {
    node.connect(this.dry);
    if (wet > 0) {
      const g = this.ctx.createGain();
      g.gain.value = wet;
      node.connect(g).connect(this.wet);
    }
  }

  private pad(freq: number, t: number, dur: number, night: number) {
    const c = this.ctx;
    const g = c.createGain();
    const f = c.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = this.mood.padCutoff * (1 - 0.45 * night);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.04, t + dur * 0.25);
    g.gain.linearRampToValueAtTime(0.03, t + dur * 0.75);
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
    f.connect(g);
    this.send(g, 0.8);
  }

  private bass(freq: number, t: number, dur: number, level = 1, bus: AudioNode | null = null) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = "sine";
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.1 * level, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    if (bus) g.connect(bus);
    else this.send(g, 0.1);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private lead(freq: number, t: number, dur: number, night: number) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    const f = c.createBiquadFilter();
    const vib = c.createOscillator();
    const vibAmt = c.createGain();
    o.type = this.mood.leadWave;
    o.frequency.value = freq;
    vib.frequency.value = 5.2;
    vibAmt.gain.setValueAtTime(0, t);
    vibAmt.gain.linearRampToValueAtTime(freq * 0.006, t + Math.min(0.6, dur)); // vibrato swells in on long notes
    vib.connect(vibAmt).connect(o.frequency);
    f.type = "lowpass";
    f.frequency.value = (this.mood.leadWave === "sine" ? 4000 : 2400) * (1 - 0.4 * night);
    const peak = (this.mood.leadWave === "sine" || this.mood.leadWave === "triangle" ? 0.06 : 0.028) * (1 - 0.35 * night);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.02);
    g.gain.setTargetAtTime(peak * 0.6, t + 0.05, dur * 0.3);
    g.gain.setTargetAtTime(0.0001, t + dur * 0.9, 0.08);
    o.connect(f).connect(g);
    this.send(g, 0.9);
    o.start(t);
    vib.start(t);
    o.stop(t + dur + 0.5);
    vib.stop(t + dur + 0.5);
  }

  private pluck(freq: number, t: number, dur: number, night: number) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    const f = c.createBiquadFilter();
    o.type = this.mood.arpWave;
    o.frequency.value = freq;
    f.type = "lowpass";
    f.frequency.setValueAtTime(3000 * (1 - 0.4 * night), t);
    f.frequency.exponentialRampToValueAtTime(400, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.024, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f).connect(g);
    this.send(g, 0.7);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private bell(freq: number, t: number) {
    const c = this.ctx;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.018, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.5);
    for (const [ratio, lvl] of [[1, 1], [2.76, 0.4], [5.4, 0.15]] as const) {
      const o = c.createOscillator();
      const og = c.createGain();
      o.type = "sine";
      o.frequency.value = freq * ratio;
      og.gain.value = lvl;
      o.connect(og).connect(g);
      o.start(t);
      o.stop(t + 3.6);
    }
    this.send(g, 1.6);
  }

  private kick(t: number, level: number) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.14);
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    o.connect(g).connect(level > 0.1 ? this.combatBus : this.dry);
    o.start(t);
    o.stop(t + 0.3);
  }

  private noiseHit(t: number, dur: number, level: number, type: BiquadFilterType, hz: number, q = 0.8) {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.value = hz;
    f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.combatBus);
    src.start(t, this.rnd() * 0.5);
    src.stop(t + dur + 0.02);
  }

  private snare(t: number) {
    this.noiseHit(t, 0.18, 0.09, "bandpass", 1800, 0.7);
  }

  private hat(t: number, level: number) {
    this.noiseHit(t, 0.05, level, "highpass", 7000);
  }

  private tom(t: number) {
    const c = this.ctx;
    for (const [i, hz] of [[0, 110], [1, 92], [2, 80]] as const) {
      const at = t + i * (60 / this.mood.bpm / 4);
      const o = c.createOscillator();
      const g = c.createGain();
      o.frequency.setValueAtTime(hz * 1.6, at);
      o.frequency.exponentialRampToValueAtTime(hz, at + 0.08);
      g.gain.setValueAtTime(0.12, at);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
      o.connect(g).connect(this.combatBus);
      o.start(at);
      o.stop(at + 0.4);
    }
  }
}

/** A stereo reverb impulse: noise under an exponential decay (`seconds` long, steeper with `decay`). */
function impulse(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const len = Math.round(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(2, len, ctx.sampleRate);
  const r = seeded(11);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (r() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return b;
}
