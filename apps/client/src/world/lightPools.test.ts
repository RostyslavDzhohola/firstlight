import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { createTerrain } from "@firstlight/shared";
import { TOWN_LAYOUT, TOWN_PREFABS } from "@firstlight/shared/content/portusTown";
import { HOLO_AT } from "./HoloBoard.ts";
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
    const portal = pools.filter((p) => p.day > 0 && p.radius > 6.5);
    expect(portal).toHaveLength(3);
    for (const p of portal) expect(Math.hypot(...p.at)).toBeCloseTo(17 - 3.4, 0);
    expect(new Set(portal.map((p) => p.color)).size).toBe(3); // three destinations, three colours
    // The scoreboard's pool lies in front of the board, on the pad's side of the emitter.
    const board = pools.filter((p) => p.day > 0 && p.radius <= 6.5);
    expect(board).toHaveLength(1);
    expect(Math.hypot(...board[0]!.at)).toBeLessThan(Math.hypot(...HOLO_AT));
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
    expect(g.getAttribute("aPool").itemSize).toBe(3); // day, glow, tint
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

  it("tints the paving first (ground × (1 + colour)), then adds a faint glow; neither writes depth", () => {
    const tint = lightPoolMaterial("tint"), glow = lightPoolMaterial("glow");
    // src × dst + dst × 1: what is under the pool is multiplied, never replaced by flat light.
    expect(tint.blending).toBe(THREE.CustomBlending);
    expect([tint.blendSrc, tint.blendDst]).toEqual([THREE.DstColorFactor, THREE.OneFactor]);
    expect([tint.blendSrcAlpha, tint.blendDstAlpha]).toEqual([THREE.ZeroFactor, THREE.OneFactor]);
    expect(glow.blending).toBe(THREE.AdditiveBlending);
    for (const m of [tint, glow]) {
      expect(m.depthWrite).toBe(false);
      expect(m.polygonOffset).toBe(true);
      expect(m.fog).toBe(false);
    }
    expect(lightPoolMaterial("tint")).toBe(tint); // one material per layer for the app's lifetime
  });

  it("the tint does most of the work: every pool's glow is weak enough to leave the stones visible", () => {
    for (const p of pools) {
      expect(p.tint).toBeGreaterThan(8);
      expect(p.strength).toBeLessThan(0.5);
      expect(p.day).toBeLessThan(0.1);
    }
  });
});
