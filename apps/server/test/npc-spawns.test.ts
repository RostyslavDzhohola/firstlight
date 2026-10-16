import { describe, expect, it } from "vitest";
import { OUTPOSTS } from "@firstlight/shared/content/padOutposts";
import { BODIES, createTerrain, nearSafeZone, padDirs, tangentFrame, TOWN_GATES, type Dir } from "@firstlight/shared";
import { bossArena, walk } from "@firstlight/shared/content/arenas";
import { ARRIVAL_GROUPS, NPC_DEFS, NPC_RULES, PORTUS_WILDS } from "@firstlight/shared/content/npcs";
import { buildSpawnPoints } from "../src/world/npc/spawns.ts";

const distance = (a: Dir, b: Dir, radius: number) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * radius;

it.each(["portus", "arcadia", "hollowmere", "meridian"] as const)("%s keeps every hostile spawn and its roaming range at least 45 m from every landing pad", (body) => {
  const terrain = createTerrain(body);
  const points = buildSpawnPoints(terrain, bossArena(terrain));
  let hostiles = 0;
  for (const point of points) for (const member of point.members) {
    if (NPC_DEFS[member.def]!.temper !== "hostile") continue;
    hostiles++;
    const dir = walk(point.dir, point.t1, member.a, point.t2, member.b, terrain.body.radius);
    for (const pad of padDirs(terrain.body)) {
      expect(distance(point.dir, pad, terrain.body.radius), `group ${point.id}`).toBeGreaterThanOrEqual(45);
      expect(distance(dir, pad, terrain.body.radius) - point.roam, `member of group ${point.id}`).toBeGreaterThanOrEqual(45);
    }
  }
  expect(hostiles).toBeGreaterThan(body === "portus" ? 10 : 50);
});

it("makes Dawnpad's nearest hostile pack a small Hopbit encounter of two or three", () => {
  const terrain = createTerrain("arcadia");
  const dawnpad = padDirs(BODIES.arcadia)[0]!;
  const packs = buildSpawnPoints(terrain, bossArena(terrain))
    .filter((p) => p.kind === "pack" && p.members.some((m) => NPC_DEFS[m.def]!.temper === "hostile"))
    .sort((a, b) => distance(a.dir, dawnpad, terrain.body.radius) - distance(b.dir, dawnpad, terrain.body.radius));
  const first = packs[0]!;
  expect(first.members.length).toBeGreaterThanOrEqual(2);
  expect(first.members.length).toBeLessThanOrEqual(3);
  expect(first.members.filter((m) => NPC_DEFS[m.def]!.temper === "hostile").every((m) => NPC_DEFS[m.def]!.id === "hopbit")).toBe(true);
});

describe("Portus outside the town walls (D-zones-1)", () => {
  const terrain = createTerrain("portus");
  const R = BODIES.portus.radius;
  const points = buildSpawnPoints(terrain, null);

  it("places every listed group; no member can wander to within the NPC margin of the town", () => {
    expect(points).toHaveLength(PORTUS_WILDS.length);
    for (const p of points) {
      const hostile = p.members.some((m) => NPC_DEFS[m.def]!.temper === "hostile");
      for (const m of p.members) {
        const d = walk(p.dir, p.t1, m.a, p.t2, m.b, R);
        const margin = NPC_RULES.safeMargin + NPC_DEFS[m.def]!.radius + (hostile ? p.roam : 0);
        expect(nearSafeZone(BODIES.portus, d[0] * R, d[1] * R, d[2] * R, margin), `group ${p.id}`).toBe(false);
      }
    }
  });

  it("is a new player's first fight: levels 1–2, no elites, beasts or bosses", () => {
    for (const p of points) for (const m of p.members) {
      expect(m.level).toBeLessThanOrEqual(2);
      expect(["regular", "critter"]).toContain(NPC_DEFS[m.def]!.tier);
    }
  });

  it("each gate looks out on a herd within 25 m and a hostile pack within 50 m, out of its 25 m sight from the gate", () => {
    expect(TOWN_GATES).toHaveLength(2);
    for (const g of TOWN_GATES) {
      const near = (hostile: boolean) => Math.min(...points.filter((p) => p.members.some((m) => NPC_DEFS[m.def]!.temper === "hostile") === hostile).map((p) => distance(p.dir, g, R)));
      expect(near(false)).toBeLessThan(25);
      expect(near(true)).toBeLessThan(50);
      // Members wander 10 m and stand 4 m from home: still beyond a Hopbit's 25 m sight from the gate.
      expect(near(true) - 14).toBeGreaterThan(25);
    }
  });
});

describe("creeps near each planet's arrival pad (D-zones-2)", () => {
  it.each(["arcadia", "hollowmere", "meridian"] as const)("%s: a herd within 50 m (20 m past the outpost wall) and a weakest-level hostile pack within 72 m (32 m past it), ahead of the arrival camera", (body) => {
    const terrain = createTerrain(body);
    const def = BODIES[body];
    const R = def.radius;
    const pad = padDirs(def)[0]!;
    const { fwd, right } = tangentFrame([pad[0], pad[1], pad[2]]);
    const bearing = (d: Dir) => {
      const v = [d[0] - pad[0], d[1] - pad[1], d[2] - pad[2]];
      return (Math.atan2(v[0]! * right[0] + v[1]! * right[1] + v[2]! * right[2], v[0]! * fwd[0] + v[1]! * fwd[1] + v[2]! * fwd[2]) * 180) / Math.PI;
    };
    const points = buildSpawnPoints(terrain, bossArena(terrain));
    const hostile = (p: (typeof points)[number]) => p.members.some((m) => NPC_DEFS[m.def]!.temper === "hostile");
    const ahead = (p: (typeof points)[number]) => Math.abs(bearing(p.dir)) <= 70;
    // Outside the walled outpost (D-b2-1): the herd just past the wall, the pack a little further.
    const wall = OUTPOSTS[body].wall.radius;
    const herd = points.filter((p) => !hostile(p) && ahead(p) && distance(p.dir, pad, R) < Math.max(50, wall + 20));
    const pack = points.filter((p) => hostile(p) && ahead(p) && distance(p.dir, pad, R) < Math.max(72, wall + 32));
    expect(herd.length, "herd").toBeGreaterThan(0);
    expect(pack.length, "pack").toBeGreaterThan(0);
    expect(Math.min(...pack.flatMap((p) => p.members.map((m) => m.level)))).toBe(def.levels[0]);
    for (const g of ARRIVAL_GROUPS[body]) expect(g.members.every((m) => m.level <= def.levels[0])).toBe(true);
  });
});

describe("the walled arrival outposts (D-b2-1)", () => {
  it.each(["arcadia", "hollowmere", "meridian"] as const)("%s: every group starts outside the outpost's walls with the NPC margin to spare", (body) => {
    const terrain = createTerrain(body);
    const def = BODIES[body];
    const R = def.radius;
    const pad = padDirs(def)[0]!;
    let near = 0;
    for (const p of buildSpawnPoints(terrain, bossArena(terrain))) {
      for (const m of p.members) {
        const q = walk(p.dir, p.t1, m.a, p.t2, m.b, R);
        const r = R + terrain.groundHeight(q[0], q[1], q[2]);
        expect(nearSafeZone(def, q[0] * r, q[1] * r, q[2] * r, NPC_RULES.safeMargin + NPC_DEFS[m.def]!.radius), `${body} group ${p.id}`).toBe(false);
        if (distance(q, pad, R) < OUTPOSTS[body].wall.radius + 40) near++;
      }
    }
    // ...and there are still creeps within a short walk of the gates.
    expect(near, body).toBeGreaterThan(0);
  });
});
