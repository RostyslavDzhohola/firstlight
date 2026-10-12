import { expect, it } from "vitest";
import { BODIES, createTerrain, padDirs, type Dir } from "@firstlight/shared";
import { bossArena, walk } from "@firstlight/shared/content/arenas";
import { NPC_DEFS } from "@firstlight/shared/content/npcs";
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
  if (body === "portus") expect(points).toEqual([]);
  else expect(hostiles).toBeGreaterThan(50);
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
