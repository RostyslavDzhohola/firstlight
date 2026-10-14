// The paving decal on the rising rim (browser round 1: terrain showed through the east road).
import { describe, expect, it } from "vitest";
import { createTerrain, PORTUS_TOWN_FLAT } from "@firstlight/shared";
import { TOWN_LAYOUT, TOWN_PREFABS, TOWN_STREETS } from "@firstlight/shared/content/portusTown";
import { townCoords, townPlacements } from "@firstlight/shared/planet/town";
import { testTownAssets } from "../render/townAssets.testutil.ts";
import { conformDecal, DECAL_LIFT } from "./townDecal.ts";

const terrain = createTerrain("portus");
const R = terrain.body.radius;

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

describe("the paving decal laid onto the ground", () => {
  it("keeps both outer roads' surface above the rendered terrain everywhere, not just at its vertices", async () => {
    const { meshes } = await testTownAssets();
    const i = TOWN_LAYOUT.findIndex((it) => TOWN_PREFABS[it[0]]!.name === "paving");
    const p = townPlacements(terrain)[i]!;
    const src = meshes.get("paving")!.opaque!;
    const laid = conformDecal(src, p, terrain);
    // Only pieces off the floor are added: a few thousand triangles, not a remeshed plaza.
    expect(laid.index.length / 3).toBeGreaterThan(src.index.length / 3);
    expect(laid.index.length / 3 - src.index.length / 3).toBeLessThan(6000);
    const world = (v: number) => {
      const x = laid.position[v * 3]!, y = laid.position[v * 3 + 1]!, z = laid.position[v * 3 + 2]!;
      return [p.px + p.rx * x + p.ux * y + p.fx * z, p.py + p.ry * x + p.uy * y + p.fy * z, p.pz + p.rz * x + p.uz * y + p.fz * z];
    };
    const roads = TOWN_STREETS.filter((st) => st.name === "east" || st.name === "west");
    const seen = new Map<string, number>(roads.map((st) => [st.name, 0]));
    let lowest = Infinity;
    for (let t = 0; t < laid.index.length; t += 3) {
      const [a, b, c] = [world(laid.index[t]!), world(laid.index[t + 1]!), world(laid.index[t + 2]!)];
      // Up-facing pieces only (road and curb tops; curb sides go into the ground by design).
      const e1 = a.map((v, k) => b[k]! - v), e2 = a.map((v, k) => c[k]! - v);
      const fn = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      const m = [(a[0]! + b[0]! + c[0]!) / 3, (a[1]! + b[1]! + c[1]!) / 3, (a[2]! + b[2]! + c[2]!) / 3];
      const ml = Math.hypot(m[0]!, m[1]!, m[2]!);
      if (Math.abs(fn[0]! * m[0]! + fn[1]! * m[1]! + fn[2]! * m[2]!) / (ml * Math.hypot(fn[0]!, fn[1]!, fn[2]!)) < 0.5) continue;
      const chord = Math.hypot(m[0]! / ml, m[1]! / ml - 1, m[2]! / ml) * R;
      if (chord < PORTUS_TOWN_FLAT) continue;
      const [e, n] = townCoords(m[0]!, m[1]!, m[2]!, R);
      const road = roads.find((st) => streetDistance(e, n, st.pts) < st.width / 2 + 0.5);
      if (!road) continue;
      seen.set(road.name, seen.get(road.name)! + 1);
      // Dense samples of the piece against the rendered terrain under each one.
      for (let u = 0; u <= 4; u++) {
        for (let v = 0; v <= 4 - u; v++) {
          const wb = u / 4, wc = v / 4, wa = 1 - wb - wc;
          const q = [0, 1, 2].map((k) => a[k]! * wa + b[k]! * wb + c[k]! * wc);
          const l = Math.hypot(q[0]!, q[1]!, q[2]!);
          lowest = Math.min(lowest, l - R - terrain.groundHeight(q[0]! / l, q[1]! / l, q[2]! / l));
        }
      }
    }
    // Nowhere does the terrain reach the paving, and both roads are covered beyond the flat floor.
    expect(lowest).toBeGreaterThan(0.01);
    for (const [name, count] of seen) expect(count, name).toBeGreaterThan(300);
    expect(lowest).toBeLessThan(DECAL_LIFT + 0.06); // and it doesn't float either
  });
});
