import { describe, expect, it } from "vitest";
import { loadingPhase, stepProgress, WARMUP_FROM, warmupProgress, type LoadingPhase } from "./loading.ts";

describe("loadingPhase", () => {
  it("maps Game.ts status lines to the four boot steps in order", () => {
    let p: LoadingPhase | undefined;
    const seen: number[] = [];
    for (const line of ["Loading the game…", "Starting the renderer…", "Travelling to Arcadia…", "Connecting…", "Building the world…", "Loading characters…", "Tuning graphics for this computer…", "Warming up shaders…"]) {
      p = loadingPhase(line, p);
      seen.push(p.step);
      expect(p.compact).toBe(false);
    }
    expect(seen).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    expect(p!.body).toBe("arcadia");
  });

  it("uses the compact card for mid-game re-warms and reconnects", () => {
    const g = loadingPhase("Applying graphics settings…");
    expect(g).toMatchObject({ step: 3, compact: true });
    const r = loadingPhase("Reconnecting… (try 3)", { step: 3, body: "portus", compact: false });
    expect(r).toEqual({ step: 1, body: "portus", compact: true });
  });

  it("keeps the previous state for unknown lines and unknown bodies", () => {
    const prev: LoadingPhase = { step: 2, body: "meridian", compact: false };
    expect(loadingPhase("Something else", prev)).toBe(prev);
    expect(loadingPhase("Travelling to Nowhere…", prev).body).toBe("meridian");
  });
});

describe("warm-up progress (Preparing shaders ready/total)", () => {
  it("labels GPU programs ready of those known, and moves the bar monotonically from the step's start to 100%", () => {
    const p = warmupProgress();
    expect(p.start()).toEqual({ text: "Preparing shaders…", frac: WARMUP_FROM });
    let prev = WARMUP_FROM;
    const seen = new Set<number>();
    // programs turn up as the compile goes (the total grows), and finish later
    for (let i = 1; i <= 100; i++) {
      const programs = Math.min(242, 40 + i * 3);
      const ready = Math.max(0, Math.floor(i * 2.42) - 20);
      const s = p.update({ ready, programs, frac: i / 100 });
      expect(s.text).toBe(ready > 0 || programs > 0 ? `Preparing shaders ${Math.min(ready, programs)}/${programs}` : "Preparing shaders…");
      expect(s.frac).toBeGreaterThanOrEqual(prev);
      prev = s.frac;
      seen.add(Math.round(s.frac * 100));
    }
    expect(prev).toBe(1);
    expect(seen.size).toBeGreaterThan(10); // the percentage keeps moving
  });

  it("never goes backwards, never shows more ready than known, and says nothing before the first program", () => {
    const p = warmupProgress();
    expect(p.update({ ready: 0, programs: 0, frac: 0.1 }).text).toBe("Preparing shaders…");
    const a = p.update({ ready: 90, programs: 100, frac: 0.6 });
    const b = p.update({ ready: 91, programs: 140, frac: 0.55 }); // a caller's blip: held
    expect(b.frac).toBe(a.frac);
    expect(p.update({ ready: 150, programs: 140, frac: 1 })).toEqual({ text: "Preparing shaders 140/140", frac: 1 });
  });

  it("fills only its own range (after the probe; a mid-game re-warm from 50%)", () => {
    const after = warmupProgress(0.9);
    expect(after.start().frac).toBe(0.9);
    expect(after.update({ ready: 1, programs: 2, frac: 0.5 }).frac).toBeCloseTo(0.95);
    const mid = warmupProgress(0.5);
    expect(mid.update({ ready: 2, programs: 2, frac: 1 }).frac).toBe(1);
  });

  it("is the warm-up boot step", () => {
    expect(loadingPhase("Preparing shaders…")).toMatchObject({ step: 3, compact: false });
    expect(loadingPhase("Preparing shaders 120/242", { step: 2, body: "portus", compact: false })).toEqual({ step: 3, body: "portus", compact: false });
    // a mid-game re-warm stays on the compact card
    expect(loadingPhase("Preparing shaders 3/9", { step: 3, body: "portus", compact: true }).compact).toBe(true);
  });
});

describe("stepProgress (a boot step's share of the bar, e.g. the first-visit probe)", () => {
  it("maps 0–1 into its range, monotonic", () => {
    const p = stepProgress(0.82, 0.9);
    expect(p.at(0)).toBeCloseTo(0.82);
    expect(p.at(0.5)).toBeCloseTo(0.86);
    expect(p.at(0.25)).toBeCloseTo(0.86); // never back
    expect(p.at(2)).toBeCloseTo(0.9);
  });
});
