// The new objective sites (2026-11-12: race rings, beacons, shards and kite panels) sit on open,
// dry ground, clear of safe zones, boss arenas and Easter-egg parts, and the Three Gleams' Portus
// pair stands on clear plaza floor (world geometry is frozen; these only use placement helpers).

import { describe, expect, it } from "vitest";
import { BODIES, PLANET_IDS } from "../planet/bodies.ts";
import { createTerrain } from "../planet/terrain.ts";
import { nearSafeZone } from "../planet/zones.ts";
import { structureCollider } from "../planet/sites.ts";
import { bossArena } from "./arenas.ts";
import { MISSIONS } from "./missions.ts";
import { objectPos, surfaceDistance, WORLD_OBJECT_BY_ID, WORLD_OBJECTS } from "./world.ts";

const SITES = MISSIONS.flatMap((m) => [...(m.race?.rings ?? []), ...(m.collect?.pieces ?? []), ...(m.defend ? [m.defend.beacon] : [])].map((id) => ({ m, o: WORLD_OBJECT_BY_ID.get(id)! })));

describe("trial sites", () => {
  it("are dry, outside safe zones, clear of structures, boss arenas and egg parts", () => {
    expect(SITES.length).toBe(8 + 8 + 5 + 2);
    for (const body of PLANET_IDS) {
      const t = createTerrain(body);
      const g = (x: number, y: number, z: number) => t.groundHeight(x, y, z);
      const arena = bossArena(t);
      const eggs = WORLD_OBJECTS.filter((o) => o.body === body && o.egg).map((o) => objectPos(o, g));
      const sc = structureCollider(t);
      for (const { m, o } of SITES.filter((s) => s.o.body === body)) {
        const p = objectPos(o, g);
        const d = Math.hypot(p[0], p[1], p[2]);
        const ground = t.groundHeight(p[0] / d, p[1] / d, p[2] / d);
        expect(ground, `${o.id} dry`).toBeGreaterThan(BODIES[body].waterLevel);
        // Defend rings (14 m) and everything else stay well out of safe ground.
        expect(nearSafeZone(BODIES[body], p[0], p[1], p[2], m.defend ? m.defend.radius + 5 : 5), `${o.id} safe zone`).toBe(false);
        expect(sc.near(p[0], p[1], p[2], 6), `${o.id} structure`).toBe(false);
        if (arena) expect(surfaceDistance(arena.centre, p), `${o.id} arena`).toBeGreaterThan(arena.radius + 100);
        for (const e of eggs) expect(surfaceDistance(e, p), `${o.id} egg part`).toBeGreaterThan(30);
      }
    }
  });

  it("puts Sela Marchbank and the Gleam Vault on clear plaza floor in Portus", () => {
    const t = createTerrain("portus");
    const sc = structureCollider(t);
    for (const id of ["curator_sela", "gleam_vault"]) {
      const o = WORLD_OBJECT_BY_ID.get(id)!;
      const p = objectPos(o, (x, y, z) => t.groundHeight(x, y, z));
      const l = Math.hypot(p[0], p[1], p[2]);
      const q = { x: (p[0] * (l + 0.3)) / l, y: (p[1] * (l + 0.3)) / l, z: (p[2] * (l + 0.3)) / l };
      expect(sc.isClear(q), id).toBe(true);
    }
  });
});
