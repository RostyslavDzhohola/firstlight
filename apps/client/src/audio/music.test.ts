import { describe, expect, it } from "vitest";
import { degreeNote, MOODS, MUSIC_MAX_SOURCES_PER_TICK, MusicGen, seeded, themeAt } from "./music.ts";

/** A fake audio context that counts the sources started (oscillators and noise) per kind. */
function fakeCtx() {
  const started = { osc: 0, noise: 0, oscFreqs: [] as number[], at: [] as number[] };
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
      o.start = (at = 0) => {
        started.oscFreqs.push(f.value);
        started.at.push(at);
        return started.osc++;
      };
      return o;
    },
    createBufferSource: () => ({ ...node(), start: (at = 0) => (started.at.push(at), started.noise++), stop() {} }),
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

  // Review 2026-11-13 finding 3: a ten-minute timer gap once wrote 4,781 sources in one callback.
  it("live play never schedules the past: after any gap it resumes from now with a bounded number of sources", () => {
    for (const body of Object.keys(MOODS) as (keyof typeof MOODS)[]) {
      for (const gap of [10 * 60, 10 * 3600]) {
        const { ctx, started } = fakeCtx();
        const g = new MusicGen(ctx, {} as AudioNode, body);
        g.startAt(0);
        g.setCombat(true, 0); // the busiest layer is on
        g.setNight(1); // and the bells
        for (let now = 0; now < 2; now += 0.05) g.live(now);
        const before = started.osc + started.noise;
        started.at.length = 0;
        const now = 2 + gap; // a throttled tab, a stalled thread or a suspended context: the timer comes back late
        (ctx as { currentTime: number }).currentTime = now;
        g.setCombat(true, now);
        g.live(now);
        const made = started.osc + started.noise - before;
        expect(made, `${body} after ${gap} s`).toBeLessThanOrEqual(MUSIC_MAX_SOURCES_PER_TICK);
        expect(Math.min(...started.at), `${body} after ${gap} s`).toBeGreaterThanOrEqual(now);
        expect(Math.max(...started.at), `${body} after ${gap} s`).toBeLessThan(now + 0.25 + 0.2); // the window (plus a tom's roll)
      }
    }
  });

  it("the bound holds tick by tick in steady play, and steady play skips nothing", () => {
    const { ctx, started } = fakeCtx();
    const g = new MusicGen(ctx, {} as AudioNode, "meridian");
    g.startAt(0);
    g.setCombat(true, 0);
    let last = 0;
    for (let now = 0; now < 4; now += 0.05) {
      g.live(now);
      expect(started.osc + started.noise - last).toBeLessThanOrEqual(MUSIC_MAX_SOURCES_PER_TICK);
      last = started.osc + started.noise;
    }
    // Same notes as an offline render of the same span (nothing was skipped while the timer kept up).
    const off = fakeCtx();
    const h = new MusicGen(off.ctx, {} as AudioNode, "meridian");
    h.startAt(0);
    h.setCombat(true, 0);
    h.scheduleUntil(g.scheduledUntil());
    expect(off.started.osc + off.started.noise).toBe(started.osc + started.noise);
  });
});
