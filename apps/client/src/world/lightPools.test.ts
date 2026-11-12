import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { createTerrain } from "@firstlight/shared";
import { TOWN_LAYOUT, TOWN_PREFABS } from "@firstlight/shared/content/portusTown";
import { lightPoolGeometry, lightPoolMaterial, POOL_LIFT, portusLightPools } from "./lightPools.ts";

describe("Portus' light pools", () => {
  const pools = portusLightPools();

  it("puts a warm pool under every lamp post, one before each portal and one under the scoreboard", () => {
    const lamp = TOWN_PREFABS.findIndex((p) => p.name === "lamp_post");
    const lamps = TOWN_LAYOUT.filter((i) => i[0] === lamp).length;
    expect(lamps).toBeGreaterThan(4);
    expect(pools).toHaveLength(lamps + 3 + 1);
    expect(pools.filter((p) => p.day === 0)).toHaveLength(lamps); // lamps are out by day
    // The portals' pools lie nearer the plaza's centre than their arches (17 m out).
    const portal = pools.filter((p) => p.day > 0 && p.radius > 5);
    expect(portal).toHaveLength(3);
    for (const p of portal) expect(Math.hypot(...p.at)).toBeCloseTo(17 - 3.4, 0);
  });

  it("drapes them on the ground in one geometry: every vertex a little above the terrain", () => {
    const terrain = createTerrain("portus");
    const g = lightPoolGeometry(pools, terrain);
    const p = g.getAttribute("position");
    const R = terrain.body.radius;
    for (let i = 0; i < p.count; i += 7) {
      const v = new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i));
      const l = v.length();
      expect(l - R - terrain.groundHeight(v.x / l, v.y / l, v.z / l)).toBeCloseTo(POOL_LIFT, 3);
    }
    expect(g.getAttribute("aPool").count).toBe(p.count);
    expect(g.getIndex()!.count % 3).toBe(0);
    // Centre vertices carry radius 0, rims 1.
    const uv = g.getAttribute("uv");
    let min = 1, max = 0;
    for (let i = 0; i < uv.count; i++) {
      min = Math.min(min, uv.getX(i));
      max = Math.max(max, uv.getX(i));
    }
    expect([min, max]).toEqual([0, 1]);
  });

  it("is one additive material that writes no depth", () => {
    const m = lightPoolMaterial();
    expect(m.blending).toBe(THREE.AdditiveBlending);
    expect(m.depthWrite).toBe(false);
    expect(m.polygonOffset).toBe(true);
  });
});
