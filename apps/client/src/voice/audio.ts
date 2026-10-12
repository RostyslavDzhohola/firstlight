// Voice audio graph (r2-13 §5–§6). One AudioContext (never force its sample rate). Per peer:
//
//   primer <audio muted> (Chrome: remote WebRTC audio is silent in Web Audio without one)
//   source ─┬─ HRTF panner (linear, ref 2, max 35) ─ proximity gain ─┐
//           ├─ radio chain: highpass 400 → lowpass 2.8k → soft clip ─ radio gain ─┼─ peer gain (mute) ─ master
//           └─ analyser (speaking ring)                                 squelch ─┘
//
// The listener stays at the origin; each frame the caller writes every speaker's position in the
// listener's (camera) frame with `.value` (no AudioParam automation: much cheaper).

import { VOICE } from "@firstlight/shared/net/voice";

interface PeerAudio {
  primer: HTMLAudioElement;
  src: MediaStreamAudioSourceNode;
  panner: PannerNode;
  prox: GainNode;
  radioIn: BiquadFilterNode;
  radioOut: GainNode;
  gain: GainNode;
  analyser: AnalyserNode;
  buf: Float32Array<ArrayBuffer>;
  radioOn: boolean;
  level: number;
}

const RADIO_GAIN = 0.9;
const SQUELCH_DB = -12;

function softClipCurve(): Float32Array<ArrayBuffer> {
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = Math.tanh(3 * ((i / (n - 1)) * 2 - 1)) / Math.tanh(3);
  return c;
}

function rms(buf: Float32Array<ArrayBuffer>): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i]! * buf[i]!;
  return Math.sqrt(s / buf.length);
}

export class VoiceAudio {
  readonly ctx: AudioContext;
  /** Panic mute and overall voice volume. */
  readonly master: GainNode;
  private readonly peers = new Map<string, PeerAudio>();
  private readonly curve = softClipCurve();
  private readonly noise: AudioBuffer;
  private readonly squelchIn: BiquadFilterNode;
  private mic: { stream: MediaStream; src: MediaStreamAudioSourceNode; analyser: AnalyserNode; buf: Float32Array<ArrayBuffer> } | null = null;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.master = new GainNode(ctx, { gain: 1 });
    this.master.connect(ctx.destination);
    // Squelch: a short burst of noise through the same band-pass as the radio.
    const len = Math.floor(ctx.sampleRate * 0.11);
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    this.squelchIn = new BiquadFilterNode(ctx, { type: "highpass", frequency: 400, Q: 0.7 });
    this.squelchIn.connect(new BiquadFilterNode(ctx, { type: "lowpass", frequency: 2800, Q: 0.7 })).connect(this.master);
  }

  has(peer: string): boolean {
    return this.peers.has(peer);
  }

  /** Route a peer's remote stream (replaces an earlier one). */
  attach(peer: string, stream: MediaStream): void {
    this.detach(peer);
    const ctx = this.ctx;
    const primer = new Audio();
    primer.muted = true;
    primer.srcObject = stream;
    void primer.play().catch(() => {});
    const src = ctx.createMediaStreamSource(stream);
    const panner = new PannerNode(ctx, {
      panningModel: "HRTF",
      distanceModel: "linear",
      refDistance: VOICE.REF,
      maxDistance: VOICE.HEAR,
      rolloffFactor: 1,
      positionX: 0,
      positionY: 0,
      positionZ: -VOICE.HEAR * 2, // silent until the first position update
    });
    const prox = new GainNode(ctx, { gain: 1 });
    const radioIn = new BiquadFilterNode(ctx, { type: "highpass", frequency: 400, Q: 0.7 });
    const lp = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 2800, Q: 0.7 });
    const shaper = new WaveShaperNode(ctx, { curve: this.curve, oversample: "2x" });
    const radioOut = new GainNode(ctx, { gain: 0 });
    const gain = new GainNode(ctx, { gain: 1 });
    const analyser = new AnalyserNode(ctx, { fftSize: 512, smoothingTimeConstant: 0 });
    src.connect(panner).connect(prox).connect(gain);
    src.connect(radioIn).connect(lp).connect(shaper).connect(radioOut).connect(gain);
    src.connect(analyser);
    gain.connect(this.master);
    this.peers.set(peer, { primer, src, panner, prox, radioIn, radioOut, gain, analyser, buf: new Float32Array(analyser.fftSize), radioOn: false, level: 0 });
  }

  detach(peer: string): void {
    const p = this.peers.get(peer);
    if (!p) return;
    this.peers.delete(peer);
    for (const n of [p.src, p.panner, p.prox, p.radioIn, p.radioOut, p.gain, p.analyser]) n.disconnect();
    p.primer.pause();
    p.primer.srcObject = null;
  }

  /** Speaker position relative to the listener, in the listener's frame (−Z forward, +Y up). */
  setPosition(peer: string, x: number, y: number, z: number): void {
    const p = this.peers.get(peer);
    if (!p) return;
    p.panner.positionX.value = x;
    p.panner.positionY.value = y;
    p.panner.positionZ.value = z;
  }

  /** Local mute / strangers: 0 or 1, smoothed to avoid clicks. */
  setPeerGain(peer: string, g: number): void {
    const p = this.peers.get(peer);
    if (p && Math.abs(p.gain.gain.value - g) > 1e-3) p.gain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.02);
  }

  /** Route a same-channel transmitter through the radio chain; squelch on both edges. */
  setRadio(peer: string, on: boolean, audible: boolean): void {
    const p = this.peers.get(peer);
    if (!p || p.radioOn === on) return;
    p.radioOn = on;
    p.radioOut.gain.setTargetAtTime(on ? RADIO_GAIN : 0, this.ctx.currentTime, 0.015);
    if (audible) this.squelch();
  }

  squelch(): void {
    const ctx = this.ctx;
    const src = new AudioBufferSourceNode(ctx, { buffer: this.noise });
    const env = new GainNode(ctx, { gain: 10 ** (SQUELCH_DB / 20) });
    env.gain.setTargetAtTime(0.0001, ctx.currentTime + 0.02, 0.03);
    src.connect(env).connect(this.squelchIn);
    src.onended = () => env.disconnect();
    src.start();
  }

  setMaster(g: number): void {
    this.master.gain.setTargetAtTime(g, this.ctx.currentTime, 0.02);
  }

  /** Update and return smoothed speaking levels (0..1) for every attached peer. */
  levels(out: Map<string, number>): void {
    out.clear();
    for (const [id, p] of this.peers) {
      p.analyser.getFloatTimeDomainData(p.buf);
      const v = Math.min(1, rms(p.buf) * 8);
      p.level = v > p.level ? v : p.level * 0.8 + v * 0.2;
      out.set(id, p.level);
    }
  }

  setMic(stream: MediaStream | null): void {
    if (this.mic) {
      this.mic.src.disconnect();
      this.mic = null;
    }
    if (!stream) return;
    const src = this.ctx.createMediaStreamSource(stream);
    const analyser = new AnalyserNode(this.ctx, { fftSize: 512, smoothingTimeConstant: 0 });
    src.connect(analyser); // metering only, never to the speakers
    this.mic = { stream, src, analyser, buf: new Float32Array(analyser.fftSize) };
  }

  micLevel(): number {
    if (!this.mic) return 0;
    this.mic.analyser.getFloatTimeDomainData(this.mic.buf);
    return Math.min(1, rms(this.mic.buf) * 8);
  }

  dispose(): void {
    for (const id of [...this.peers.keys()]) this.detach(id);
    this.setMic(null);
    this.master.disconnect();
  }
}
