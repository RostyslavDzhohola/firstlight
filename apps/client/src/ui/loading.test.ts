import { describe, expect, it } from "vitest";
import { loadingPhase, type LoadingPhase } from "./loading.ts";

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
