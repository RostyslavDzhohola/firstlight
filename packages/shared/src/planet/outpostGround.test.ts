import { describe, expect, it } from "vitest";
import { OUTPOSTS, type OutpostBody } from "../content/padOutposts.ts";
import { chunkOf } from "./cubesphere.ts";
import { padDirs } from "./pads.ts";
import { BODIES } from "./bodies.ts";
import { chunkProps } from "./props.ts";
import { outpostAnchor } from "./sites.ts";
import { createTerrain } from "./terrain.ts";
import { siteCoords, siteDir } from "./townFrame.ts";
import { outpostGrass, outpostGroundDistance, outpostPropClear, PAD_APRON_RADIUS } from "./outpostGround.ts";

const PLANETS: OutpostBody[] = ["arcadia", "hollowmere", "meridian"];

describe("pad-0 outpost ground masks (D42, render-only)", () => {
  it("grows no grass on the apron, the paths or under buildings, and grass a little way off them", () => {
    for (const b of PLANETS) {
      expect(outpostGrass(b, 0, 0)).toBe(0);
      expect(outpostGrass(b, PAD_APRON_RADIUS - 0.4, 0)).toBe(0);
      for (const pa of OUTPOSTS[b].paths) for (const p of pa.pts) expect(outpostGrass(b, p[0], p[1]), b).toBe(0);
      for (const it of OUTPOSTS[b].layout) if (OUTPOSTS[b].prefabs[it[0]]!.cls === "building") expect(outpostGrass(b, it[1], it[2]), b).toBe(0);
      // Out in the open it grows.
      let found = 0;
      for (let e = -40; e <= 40; e += 5) for (let n = -40; n <= 40; n += 5) if (outpostGrass(b, e, n) === 1) found++;
      expect(found, b).toBeGreaterThan(100);
      expect(outpostGroundDistance("portus", 0, 0)).toBeGreaterThan(10);
    }
  });

  it("keeps natural props 3 m off the outpost's apron, paths and structures (PROPS_VERSION 5)", () => {
    for (const b of PLANETS) {
      const t = createTerrain(b);
      const a = outpostAnchor(t);
      const R = BODIES[b].radius;
      const keys = new Set<string>();
      for (let e = -60; e <= 60; e += 16) for (let n = -60; n <= 60; n += 16) {
        const d = siteDir(a, e, n, R);
        const k = chunkOf(d[0], d[1], d[2], BODIES[b].chunksPerFace);
        keys.add(`${k.face}:${k.cx}:${k.cy}`);
      }
      let checked = 0;
      for (const key of keys) {
        const [face, cx, cy] = key.split(":").map(Number) as [0 | 1 | 2 | 3 | 4 | 5, number, number];
        for (const p of chunkProps(t, face, cx, cy)) {
          const c = siteCoords(a, p.x, p.y, p.z, R);
          if (Math.abs(c[0]) > 60 || Math.abs(c[1]) > 60) continue;
          checked++;
          expect(outpostGroundDistance(b, c[0], c[1]), `${b} ${p.kind} at ${c[0].toFixed(1)}, ${c[1].toFixed(1)}`).toBeGreaterThanOrEqual(3);
          expect(outpostPropClear(b, c[0], c[1])).toBe(true);
        }
      }
      expect(checked, b).toBeGreaterThan(20);
      expect(padDirs(BODIES[b]).length).toBeGreaterThan(10);
    }
  });
});
