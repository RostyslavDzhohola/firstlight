import { describe, expect, it } from "vitest";
import { degreeNote, MOODS, MusicGen, seeded, themeAt } from "./music.ts";

/** A fake audio context that counts the sources started (oscillators and noise) per kind. */
function fakeCtx() {
  const started = { osc: 0, noise: 0, oscFreqs: [] as number[] };
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} });
  const node = () => ({ gain: param(), frequency: param(), detune: param(), Q: param(), connect: (n: unknown) => n, type: "", buffer: null });
  const ctx = {
    currentTime: 0,
    sampleRate: 8000,
    createGain: node,
    createBiquadFilter: node,
    createConvolver: node,
    createBuffer: (ch: number, len: number) => ({ getChannelData: () => new Float32Array(len), numberOfChannels: ch }),
    createOscillator: () => {
      const o = { ...node(), start: () => started.osc++, stop() {} };
      const f = o.frequency;
      o.start = () => {
        started.oscFreqs.push(f.value);
        return started.osc++;
      };
      return o;
    },
    createBufferSource: () => ({ ...node(), start: () => started.noise++, stop() {} }),
  };
  return { ctx: ctx as unknown as BaseAudioContext, started };
}

describe("music", () => {
  it("every body has a four-bar theme on its scale", () => {
    for (const [body, m] of Object.entries(MOODS)) {
      expect(m.theme.length, body).toBeGreaterThan(3);
      for (const [step, deg, len] of m.theme) {
        expect(step + len, body).toBeLessThanOrEqual(64);
        expect(deg, body).toBeGreaterThanOrEqual(0);
        expect(deg, body).toBeLessThan(m.scale.length + 2);
      }
      expect(themeAt(m, m.theme[0]![0]).length, body).toBeGreaterThan(0);
    }
    expect(degreeNote(MOODS.portus, 0)).toBe(57);
    expect(degreeNote(MOODS.portus, MOODS.portus.scale.length)).toBe(57 + 12);
  });

  it("the seeded arpeggio is the same every visit", () => {
    const a = seeded(42);
    const b = seeded(42);
    for (let i = 0; i < 10; i++) expect(a()).toBe(b());
  });

  it("a fight brings in the drums; they leave once it's over", () => {
    const calm = fakeCtx();
    const g = new MusicGen(calm.ctx, {} as AudioNode, "arcadia");
    g.startAt(0);
    g.scheduleUntil(20);
    const fight = fakeCtx();
    const f = new MusicGen(fight.ctx, {} as AudioNode, "arcadia");
    f.startAt(0);
    f.setCombat(true, 0);
    f.scheduleUntil(5.5);
    expect(fight.started.noise).toBeGreaterThan(10); // hats and snares
    const during = fight.started.noise;
    f.scheduleUntil(20); // the combat tail ran out at 5 s
    expect(fight.started.noise).toBe(during);
    expect(calm.started.noise).toBe(0);
  });
});
