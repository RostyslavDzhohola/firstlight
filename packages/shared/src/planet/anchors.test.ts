import { describe, expect, it } from "vitest";
import { BODIES, type BodyDef } from "./bodies.ts";
import { anchorDir, padDirs } from "./pads.ts";

// Lakes and peaks are anchored on pads. A pair or triple that includes opposite pads collapses onto
// a pad (or has no direction at all), which put a fast-travel pad on top of the Tolling Tower.
const planets = Object.values(BODIES).filter((b) => b.padLayout !== "none") as BodyDef[];

describe("terrain feature anchors", () => {
  for (const b of planets) {
    const pads = padDirs(b);
    for (const f of [...(b.lakes ?? []), ...(b.peaks ?? [])]) {
      it(`${b.id}: ${f.name} has a real direction away from every pad`, () => {
        const d = anchorDir(b, f.at);
        expect(d.every(Number.isFinite)).toBe(true);
        if ("mid" in f.at || "tri" in f.at) {
          const idx = "mid" in f.at ? f.at.mid : f.at.tri;
          const s = [0, 0, 0];
          for (const i of idx) for (let k = 0; k < 3; k++) s[k]! += pads[i]![k]!;
          expect(Math.hypot(s[0]!, s[1]!, s[2]!) / idx.length).toBeGreaterThan(0.5);
        }
        // No pad inside the feature's core (pads sit on flat ground, not on a summit or lake bed).
        const nearest = Math.min(...pads.map((p) => Math.acos(Math.min(1, p[0] * d[0] + p[1] * d[1] + p[2] * d[2])) * b.radius));
        expect(nearest, `${f.name}: nearest pad`).toBeGreaterThan(f.radius * 0.9);
      });
    }
  }
});
