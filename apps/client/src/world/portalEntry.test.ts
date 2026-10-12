import { describe, expect, it } from "vitest";
import { BODIES, createTerrain, padDirs, portalNear, portalSpots, type PortalSpot } from "@firstlight/shared";
import { dummyPos } from "@firstlight/shared/content/onboarding";
import { inPortal, portalAt } from "./portalEntry.ts";

const body = BODIES.portus;
const terrain = createTerrain(body);
const spots = portalSpots(body, terrain);
const R = body.radius;

type V3 = [number, number, number];

/** Feet on the ground below a point (planet space). */
function ground(p: V3): V3 {
  const l = Math.hypot(...p);
  const n: V3 = [p[0] / l, p[1] / l, p[2] / l];
  const r = R + terrain.groundHeight(n[0], n[1], n[2]);
  return [n[0] * r, n[1] * r, n[2] * r];
}

/** Ground point `along` metres through the ring (along its facing) and `side` metres across it. */
function at(s: PortalSpot, along: number, side: number): V3 {
  const right: V3 = [s.facing[1] * s.dir[2] - s.facing[2] * s.dir[1], s.facing[2] * s.dir[0] - s.facing[0] * s.dir[2], s.facing[0] * s.dir[1] - s.facing[1] * s.dir[0]];
  const b = (R + s.h);
  return ground([s.dir[0] * b + s.facing[0] * along + right[0] * side, s.dir[1] * b + s.facing[1] * along + right[1] * side, s.dir[2] * b + s.facing[2] * along + right[2] * side]);
}

describe("portal entry", () => {
  it("walking on the ground through each Portus ring enters it", () => {
    expect(spots.map((s) => s.to)).toEqual(["arcadia", "hollowmere", "meridian"]);
    for (const s of spots) {
      expect(inPortal(s, ...at(s, 0, 0))).toBe(true);
      expect(inPortal(s, ...at(s, 0.5, 1))).toBe(true);
      expect(inPortal(s, ...at(s, -0.5, -1))).toBe(true);
      expect(portalAt(spots, ...at(s, 0, 0))?.to).toBe(s.to);
      // A walk straight through crosses the slab.
      let inside = 0;
      for (let t = -6; t <= 6; t += 0.1) if (inPortal(s, ...at(s, t, 0))) inside++;
      expect(inside).toBeGreaterThan(10);
    }
  });

  it("jumping through the ring still counts", () => {
    const s = spots[0]!;
    const g = at(s, 0, 0);
    const l = Math.hypot(...g);
    const up = (m: number): V3 => [g[0] * (1 + m / l), g[1] * (1 + m / l), g[2] * (1 + m / l)];
    expect(inPortal(s, ...up(1.2))).toBe(true);
    expect(inPortal(s, ...up(5))).toBe(false); // over the top of the ring
  });

  it("passing beside or in front of a ring doesn't, though the server's travel reach does", () => {
    for (const s of spots) {
      for (const p of [at(s, 0, 2.5), at(s, 0, -2.5), at(s, 1.5, 0), at(s, -1.5, 0)]) {
        expect(inPortal(s, ...p)).toBe(false);
        expect(portalNear(spots, ...p)?.to).toBe(s.to); // within PORTAL_REACH of the centre
      }
    }
  });

  it("every point that enters a ring is within the server's travel reach", () => {
    for (const s of spots) {
      for (let a = -1; a <= 1; a += 0.1) {
        for (let side = -3; side <= 3; side += 0.1) {
          const p = at(s, a, side);
          if (inPortal(s, ...p)) expect(portalNear(spots, ...p)?.to).toBe(s.to);
        }
      }
    }
  });

  it("the walk from the arrival point to the training dummies never enters a portal", () => {
    const d0 = padDirs(body)[0]!;
    const spawn = ground([d0[0] * R, d0[1] * R, d0[2] * R]);
    for (let i = 0; i < 3; i++) {
      const to = dummyPos(i, (x, y, z) => terrain.groundHeight(x, y, z));
      for (let t = 0; t <= 1; t += 0.01) {
        const p = ground([spawn[0] + (to[0] - spawn[0]) * t, spawn[1] + (to[1] - spawn[1]) * t, spawn[2] + (to[2] - spawn[2]) * t]);
        expect(portalAt(spots, ...p)).toBeNull();
      }
    }
  });

  it("ignores the planet centre and non-finite positions", () => {
    expect(portalAt(spots, 0, 0, 0)).toBeNull();
    expect(portalAt(spots, Number.NaN, 0, 0)).toBeNull();
  });
});
