// The new objective sites (2026-11-12: race rings, beacons, shards and kite panels) sit on open,
// dry ground, clear of safe zones, boss arenas and Easter-egg parts, and the Three Gleams' Portus
// pair stands on clear plaza floor (world geometry is frozen; these only use placement helpers).

import { describe, expect, it } from "vitest";
import { BODIES, PLANET_IDS } from "../planet/bodies.ts";
import { createTerrain } from "../planet/terrain.ts";
import { nearSafeZone } from "../planet/zones.ts";
import { structureCollider } from "../planet/sites.ts";
import { natureSolids } from "../planet/natureSolids.ts";
import { offsetDir } from "./places.ts";
import { bossArena } from "./arenas.ts";
import { MISSIONS } from "./missions.ts";
import { TRAINING_DUMMIES } from "./onboarding.ts";
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
      const ns = natureSolids(t);
      for (const { m, o } of SITES.filter((s) => s.o.body === body)) {
        const p = objectPos(o, g);
        expect(o.clearing, `${o.id} leaves the frozen props alone`).toBe(false);
        // No tree or rock within 3 m of the spot (they stay put: `clearing: false`).
        ns.warm(p[0], p[1], p[2], 12, Infinity);
        const l = Math.hypot(p[0], p[1], p[2]);
        for (const [e, n] of [[0, 0], [1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5], [3, 0], [-3, 0], [0, 3], [0, -3]] as const) {
          const d = offsetDir([p[0] / l, p[1] / l, p[2] / l], e, n, BODIES[body].radius);
          const r = BODIES[body].radius + t.groundHeight(d[0], d[1], d[2]) + 0.3;
          expect(ns.isClear({ x: d[0] * r, y: d[1] * r, z: d[2] * r }), `${o.id} nature at ${e},${n}`).toBe(true);
        }
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
  }, 30_000); // three terrains and their structure colliders

  it("puts Sela Marchbank and the Gleam Vault on clear plaza floor in Portus", () => {
    const t = createTerrain("portus");
    const sc = structureCollider(t);
    for (const id of ["curator_sela", "gleam_vault"]) {
      const o = WORLD_OBJECT_BY_ID.get(id)!;
      const p = objectPos(o, (x, y, z) => t.groundHeight(x, y, z));
      const l = Math.hypot(p[0], p[1], p[2]);
      const q = { x: (p[0] * (l + 0.3)) / l, y: (p[1] * (l + 0.3)) / l, z: (p[2] * (l + 0.3)) / l };
      expect(sc.isClear(q), id).toBe(true);
      // Out of the tutorial's training yard (its dummies, fences and target stand south-east of the pad).
      for (const d of TRAINING_DUMMIES) expect(Math.hypot((o.east ?? 0) - d.east, (o.north ?? 0) - d.north), `${id} training yard`).toBeGreaterThan(10);
    }
  });
});
