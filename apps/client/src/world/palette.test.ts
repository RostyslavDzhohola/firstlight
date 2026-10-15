import { describe, expect, it } from "vitest";
import { BODIES, createTerrain, padDirs } from "@firstlight/shared";
import { OUTPOSTS } from "@firstlight/shared/content/padOutposts";
import { PAD_APRON_RADIUS } from "@firstlight/shared/planet/outpostGround";
import { outpostAnchor, siteDir } from "@firstlight/shared/planet/sites";
import { padGrassMask } from "./palette.ts";
import { siteGrassMask } from "./siteGrass.ts";

describe("grass around landing pads (live smoke test: blades grew through Dawnpad)", () => {
  const arcadia = BODIES.arcadia;
  const pads = padDirs(arcadia);
  const R = arcadia.radius;
  /** A direction `m` metres (arc) from pad 0 along a tangent. */
  const near = (m: number): [number, number, number] => {
    const [x, y, z] = pads[0]!;
    const t = Math.abs(y) < 0.9 ? [z, 0, -x] : [0, -z, y];
    const tl = Math.hypot(t[0]!, t[1]!, t[2]!);
    const a = m / R;
    const d = [x * Math.cos(a) + (t[0]! / tl) * Math.sin(a), y * Math.cos(a) + (t[1]! / tl) * Math.sin(a), z * Math.cos(a) + (t[2]! / tl) * Math.sin(a)];
    return [d[0]!, d[1]!, d[2]!];
  };

  it("is bare on the stone disc and the paved apron round it (D42), fades in past the apron and is full a few metres out", () => {
    expect(padGrassMask(pads, ...near(0), R)).toBe(0);
    expect(padGrassMask(pads, ...near(8.6), R)).toBe(0);
    expect(padGrassMask(pads, ...near(PAD_APRON_RADIUS), R)).toBe(0);
    const rim = padGrassMask(pads, ...near(11.6), R);
    expect(rim).toBeGreaterThan(0);
    expect(rim).toBeLessThan(1);
    expect(padGrassMask(pads, ...near(14), R)).toBe(1);
  });
});

describe("grass round a pad outpost (D42)", () => {
  it("doesn't grow on the outpost's paths or under its buildings, and grows away from them", () => {
    for (const body of ["arcadia", "hollowmere", "meridian"] as const) {
      const def = BODIES[body];
      const mask = siteGrassMask(def)!;
      const a = outpostAnchor(createTerrain(body));
      const at = (e: number, n: number) => mask(...siteDir(a, e, n, def.radius));
      for (const pa of OUTPOSTS[body].paths) for (const [e, n] of pa.pts) expect(at(e, n), `${body} path`).toBe(0);
      const big = OUTPOSTS[body].layout.find((it) => OUTPOSTS[body].prefabs[it[0]]!.cls === "building")!;
      expect(at(big[1], big[2]), `${body} building`).toBe(0);
      // Far from the outpost (and on the far side of the planet) the mask stays out of the way.
      expect(at(0, 90)).toBe(1);
      const p0 = padDirs(def)[0]!;
      expect(mask(-p0[0], -p0[1], -p0[2])).toBe(1);
    }
    expect(siteGrassMask(BODIES.portus)).not.toBeNull();
  });
});
