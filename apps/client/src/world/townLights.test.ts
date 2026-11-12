import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { createTerrain } from "@firstlight/shared";
import { TOWN_LAYOUT, TOWN_PREFABS } from "@firstlight/shared/content/portusTown";
import { HALO_PULL, HALO_PULL_MAX, LANTERN_M, MOTES_PER_BRAZIER, MOTES_PER_LAMP, portusTownLights, townLightGeometry, townLightMaterial } from "./townLights.ts";

describe("Portus' evening lights", () => {
  const lights = portusTownLights();
  const count = (name: string) => {
    const i = TOWN_PREFABS.findIndex((p) => p.name === name);
    return TOWN_LAYOUT.filter((l) => l[0] === i).length;
  };

  it("a halo at every lantern and brazier, a glow round each portal and at the scoreboard, motes round the lamps and fires", () => {
    const lamps = count("lamp_post"), braziers = count("brazier");
    expect(lamps).toBeGreaterThan(4);
    const halos = lights.filter((l) => l.drift === 0);
    const motes = lights.filter((l) => l.drift > 0);
    expect(halos).toHaveLength(lamps + braziers + 3 + 1);
    expect(motes).toHaveLength(lamps * MOTES_PER_LAMP + braziers * MOTES_PER_BRAZIER);
    // Lantern halos sit at the lantern and have a core that blooms (over the 1.25 threshold).
    const lantern = halos.filter((l) => l.at[2] === LANTERN_M);
    expect(lantern).toHaveLength(lamps);
    for (const l of lantern) expect(l.core).toBeGreaterThan(1.4);
    // The portals' glow is wide, weak and has no core of its own; three colours.
    const portal = halos.filter((l) => l.size > 6);
    expect(portal).toHaveLength(3);
    expect(new Set(portal.map((l) => l.color)).size).toBe(3);
    for (const l of portal) {
      expect(l.core).toBe(0);
      expect(l.skirt).toBeLessThanOrEqual(0.35);
    }
    // A lantern's halo is pulled clear of the lantern's own model (about 0.25 m from its centre).
    expect(Math.min(lantern[0]!.size * HALO_PULL, HALO_PULL_MAX)).toBeGreaterThan(0.3);
    // Motes are small.
    for (const m of motes) expect(m.size).toBeLessThan(0.1);
    expect(portusTownLights()).toEqual(lights); // the same every session
  });

  it("is one quad per light in one geometry, each centred on its light above the ground", () => {
    const terrain = createTerrain("portus");
    const g = townLightGeometry(lights, terrain);
    const p = g.getAttribute("position"), uv = g.getAttribute("uv"), par = g.getAttribute("aLight");
    expect(p.count).toBe(lights.length * 4);
    expect(g.getIndex()!.count).toBe(lights.length * 6);
    const R = terrain.body.radius;
    lights.forEach((l, i) => {
      const v = new THREE.Vector3(p.getX(i * 4), p.getY(i * 4), p.getZ(i * 4));
      const len = v.length();
      expect(len - R - terrain.groundHeight(v.x / len, v.y / len, v.z / len)).toBeCloseTo(l.at[2], 3);
      // The four corners share the centre and carry (±1, ±1).
      for (let k = 1; k < 4; k++) expect(p.getX(i * 4 + k)).toBe(p.getX(i * 4));
      expect([0, 1, 2, 3].map((k) => `${uv.getX(i * 4 + k)},${uv.getY(i * 4 + k)}`)).toEqual(["-1,-1", "1,-1", "1,1", "-1,1"]);
      expect(par.getX(i * 4)).toBeCloseTo(l.size, 5);
    });
  });

  it("is one additive, single-pass material that writes no depth", () => {
    const m = townLightMaterial({ up: new THREE.Vector3(0, 1, 0), east: new THREE.Vector3(1, 0, 0), north: new THREE.Vector3(0, 0, -1) });
    expect(m.blending).toBe(THREE.AdditiveBlending);
    expect(m.depthWrite).toBe(false);
    expect(m.forceSinglePass).toBe(true);
    expect(m.fog).toBe(false);
  });
});
