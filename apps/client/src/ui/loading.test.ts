import { describe, expect, it } from "vitest";
import { loadingPhase, WARMUP_FROM, warmupProgress, type LoadingPhase } from "./loading.ts";

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

describe("warm-up progress (Preparing shaders compiled/total)", () => {
  it("labels compiled/total, moves monotonically from the warm-up step's start and reaches 100%", () => {
    const p = warmupProgress();
    expect(p.start()).toEqual({ text: "Preparing shaders…", frac: WARMUP_FROM });
    let prev = WARMUP_FROM;
    const seen: string[] = [];
    // 240 compile items, then 6 shadow builds, then 5 real frames: 251 units.
    for (let done = 1; done <= 251; done++) {
      const s = p.update(done, 251);
      expect(s.text).toBe(`Preparing shaders ${done}/251`);
      expect(s.frac).toBeGreaterThanOrEqual(prev);
      prev = s.frac;
      seen.push(`${Math.round(s.frac * 100)}%`);
    }
    expect(prev).toBe(1);
    expect(new Set(seen).size).toBeGreaterThan(10); // the percentage keeps moving, not one fixed number
  });

  it("never goes backwards when the total grows, and never shows more compiled than total", () => {
    const p = warmupProgress();
    const a = p.update(90, 100);
    const b = p.update(91, 140); // more work turned up (e.g. shadow builds over the prediction)
    expect(b.frac).toBeGreaterThanOrEqual(a.frac);
    expect(b.text).toBe("Preparing shaders 91/140");
    const c = p.update(150, 140);
    expect(c.text).toBe("Preparing shaders 140/140");
    expect(c.frac).toBe(1);
    expect(p.update(0, 0).frac).toBe(1); // nothing left to do: still full, never back to the start
  });

  it("is the warm-up boot step", () => {
    expect(loadingPhase("Preparing shaders…")).toMatchObject({ step: 3, compact: false });
    expect(loadingPhase("Preparing shaders 120/242", { step: 2, body: "portus", compact: false })).toEqual({ step: 3, body: "portus", compact: false });
  });
});
