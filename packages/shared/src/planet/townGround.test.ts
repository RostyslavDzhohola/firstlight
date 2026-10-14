import { describe, expect, it } from "vitest";
import { TOWN_FIXED, TOWN_LAYOUT, TOWN_PREFABS, TOWN_STREETS } from "../content/portusTown.ts";
import { BODIES } from "./bodies.ts";
import { chunkOf, type Face } from "./cubesphere.ts";
import { chunkProps, PORTUS_PLAZA_CLEAR } from "./props.ts";
import { createTerrain } from "./terrain.ts";
import { townCoords, townDir } from "./townFrame.ts";
import { townGrass, townGroundDistance, townPropClear } from "./townGround.ts";

const R = BODIES.portus.radius;

/** Distance (m) from a town point to a street's centre line. */
function streetDistance(e: number, n: number, pts: readonly (readonly [number, number])[]): number {
  let best = Infinity;
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ae, an] = pts[k]!, [be, bn] = pts[k + 1]!;
    const de = be - ae, dn = bn - an;
    const t = Math.max(0, Math.min(1, ((e - ae) * de + (n - an) * dn) / (de * de + dn * dn)));
    best = Math.min(best, Math.hypot(e - ae - de * t, n - an - dn * t));
  }
  return best;
}

describe("Portus town ground masks (D38, render-only)", () => {
  it("grows no grass on the plaza, the portal courts, the streets or under buildings", () => {
    expect(townGrass(0, 0)).toBe(0);
    expect(townGrass(20, 10)).toBe(0);
    for (const p of Object.values(TOWN_FIXED.portals)) expect(townGrass(p[0], p[1])).toBe(0);
    for (const s of TOWN_STREETS) for (const p of s.pts) expect(townGrass(p[0], p[1]), s.name).toBe(0);
    for (const it of TOWN_LAYOUT) {
      if (TOWN_PREFABS[it[0]]!.cls === "building") expect(townGrass(it[1], it[2])).toBe(0);
    }
  });

  it("keeps grass in the gaps, the gardens and the meadow outside the walls", () => {
    // Somewhere in every quarter inside the walls there is grass (gardens, gaps between houses).
    for (const [e0, n0] of [[25, 25], [-25, 25], [-25, -25], [25, -25]] as const) {
      let found = false;
      for (let e = e0 - 8; e <= e0 + 8 && !found; e += 1) for (let n = n0 - 8; n <= n0 + 8 && !found; n += 1) found = townGrass(e, n) === 1;
      expect(found, `${e0}, ${n0}`).toBe(true);
    }
    expect(townGrass(-30, -52)).toBe(1);
    expect(townGrass(100, 100)).toBe(1);
    expect(townGroundDistance(500, 0)).toBeGreaterThan(20);
  });

  it("keeps natural props out of the town, off its roads and away from its structures and trees", () => {
    const terrain = createTerrain("portus");
    const seen = new Set<string>();
    let props = 0;
    for (let a = 0; a < 360; a += 4) {
      for (let r = 40; r <= 100; r += 6) {
        const d = townDir(r * Math.cos((a * Math.PI) / 180), r * Math.sin((a * Math.PI) / 180), R);
        const k = chunkOf(d[0], d[1], d[2], BODIES.portus.chunksPerFace);
        const key = `${k.face}:${k.cx}:${k.cy}`;
        if (seen.has(key)) continue;
        seen.add(key);
        for (const p of chunkProps(terrain, k.face as Face, k.cx, k.cy)) {
          const l = Math.hypot(p.x, p.y, p.z);
          const chord = Math.hypot(p.x / l, p.y / l - 1, p.z / l) * R;
          expect(chord).toBeGreaterThanOrEqual(PORTUS_PLAZA_CLEAR);
          const [e, n] = townCoords(p.x, p.y, p.z, R);
          expect(townPropClear(e, n)).toBe(true);
          for (const s of TOWN_STREETS) expect(streetDistance(e, n, s.pts)).toBeGreaterThan(s.width / 2 + 2.5);
          props++;
        }
      }
    }
    expect(props).toBeGreaterThan(20); // the blossom meadow beyond the walls is still there
  });
});
