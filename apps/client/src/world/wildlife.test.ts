// Ambient wildlife (#7): what lives where, and how it reacts to the player.
import { describe, expect, it } from "vitest";
import { anchorDir, BODIES, createTerrain, type BodyId } from "@firstlight/shared";
import { REGION_KINDS, regionCells } from "@firstlight/shared/planet/regions";
import type { PartBatcher } from "./npcs/parts.ts";
import { BIRD_FLEE_RUN, GRAZER_KEEP, MAX_ANIMALS, WILD_MODE, WILDLIFE, Wildlife } from "./wildlife.ts";

/** Counts pushes; no GPU. */
function fakeBatch() {
  const b = { pushes: 0, push: () => void b.pushes++ };
  return b as unknown as PartBatcher & { pushes: number };
}

function surface(body: BodyId, d: readonly number[], up = 0): [number, number, number] {
  const t = createTerrain(body);
  const l = Math.hypot(d[0]!, d[1]!, d[2]!);
  const u = [d[0]! / l, d[1]! / l, d[2]! / l];
  const r = BODIES[body].radius + Math.max(BODIES[body].waterLevel, t.groundHeight(u[0]!, u[1]!, u[2]!)) + up;
  return [u[0]! * r, u[1]! * r, u[2]! * r];
}

/** Walk the player about a planet's region cells, scanning, until `want` says enough. */
function roam(life: Wildlife, body: BodyId, want: () => boolean, night = 0) {
  life.night = night;
  const cells = regionCells(body);
  for (let i = 0; i < cells.length && !want(); i++) {
    const p = surface(body, cells[i]!.dir, 1);
    life.setPlayer(p[0], p[1], p[2], 0);
    life.scan();
  }
}

describe("ambient wildlife (#7)", () => {
  it("three or more harmless kinds per planet, none on the moon or in Portus", () => {
    for (const b of ["arcadia", "hollowmere", "meridian"] as const) {
      expect(WILDLIFE[b].length, b).toBeGreaterThanOrEqual(3);
      const kinds = new Set(WILDLIFE[b].map((s) => s.behaviour));
      expect(kinds.size, b).toBeGreaterThanOrEqual(3);
      // Region ids they name exist on that planet.
      const ids = REGION_KINDS[b].map((k) => k.id);
      for (const s of WILDLIFE[b]) for (const r of s.regions ?? []) expect(ids, `${b} ${s.id}`).toContain(r);
    }
    expect(WILDLIFE.lumen).toEqual([]);
    expect(WILDLIFE.portus).toEqual([]);
  });

  it("appears round the player on every planet, birds and grazers by day, insects only at night, fish on lakes", () => {
    for (const b of ["arcadia", "hollowmere", "meridian"] as const) {
      const day = new Wildlife(b, createTerrain(b));
      roam(day, b, () => day.census().bird > 0 && day.census().grazer > 0);
      expect(day.census().bird, b).toBeGreaterThan(0);
      expect(day.census().grazer, b).toBeGreaterThan(0);
      expect(day.census().glow, b).toBe(0);
      const night = new Wildlife(b, createTerrain(b));
      roam(night, b, () => night.census().glow > 0, 1);
      expect(night.census().glow, b).toBeGreaterThan(0);
      // At dawn the insects go.
      night.night = 0;
      night.scan();
      expect(night.census().glow, b).toBe(0);
      // Fish rise on the planet's first lake.
      const lake = new Wildlife(b, createTerrain(b));
      const p = surface(b, anchorDir(BODIES[b], BODIES[b].lakes[0]!.at));
      lake.setPlayer(p[0], p[1], p[2], 0);
      lake.scan();
      expect(lake.census().fish, b).toBeGreaterThan(0);
    }
  });

  it("is dense enough to meet: several groups round a player standing in the open by day", () => {
    for (const b of ["arcadia", "hollowmere", "meridian"] as const) {
      const cells = regionCells(b);
      let total = 0, n = 0;
      for (let i = 0; i < cells.length && n < 16; i += 5) {
        const life = new Wildlife(b, createTerrain(b));
        const p = surface(b, cells[i]!.dir, 1);
        if (Math.hypot(...p) < BODIES[b].radius + BODIES[b].waterLevel + 1.5) continue;
        life.setPlayer(p[0], p[1], p[2], 0);
        life.scan();
        const c = life.census();
        total += c.bird + c.grazer + c.fish;
        n++;
      }
      expect(total / n, b).toBeGreaterThanOrEqual(2.5);
    }
  });

  it("stays within its caps and draws a few parts per animal", () => {
    const life = new Wildlife("arcadia", createTerrain("arcadia"));
    roam(life, "arcadia", () => false, 1);
    const batch = fakeBatch();
    life.draw(batch, 1 / 60, 1000);
    expect(life.stats.animals).toBeLessThanOrEqual(MAX_ANIMALS);
    expect(batch.pushes).toBe(life.stats.parts);
    expect(batch.pushes).toBeLessThanOrEqual(MAX_ANIMALS * 7);
  });

  it("birds lift off when you run at them and land again further on", () => {
    const life = new Wildlife("arcadia", createTerrain("arcadia"));
    roam(life, "arcadia", () => life.census().bird > 0);
    const birds = life.animalsOf("bird");
    const b0 = birds[0]!;
    const batch = fakeBatch();
    // Run at the flock: start 30 m off along the surface, close in at 7 m/s.
    const target: [number, number, number] = [b0.x, b0.y, b0.z];
    const l = Math.hypot(...target);
    const side = [target[1] / l, -target[0] / l, 0];
    let t = 0;
    for (let i = 0; i < 60 * 6; i++) {
      const d = Math.max(0, 30 - i * (7 / 60));
      const p: [number, number, number] = [target[0] + side[0]! * d, target[1] + side[1]! * d, target[2] + side[2]! * d];
      life.setPlayer(p[0], p[1], p[2], 1 / 60);
      t += 1000 / 60;
      life.draw(batch, 1 / 60, t);
      if (d < BIRD_FLEE_RUN - 2) break;
    }
    expect(birds.some((b) => b.mode === WILD_MODE.FLY)).toBe(true);
    // Stand still and let them fly off and settle.
    for (let i = 0; i < 60 * 14; i++) {
      t += 1000 / 60;
      life.draw(batch, 1 / 60, t);
    }
    const flown = birds.filter((b) => Math.hypot(b.x - target[0], b.y - target[1], b.z - target[2]) > 15);
    expect(flown.length).toBeGreaterThan(0);
    expect(birds.every((b) => b.mode !== WILD_MODE.FLY || b.alt >= 0)).toBe(true);
  });

  it("grazers keep their distance", () => {
    const life = new Wildlife("arcadia", createTerrain("arcadia"));
    roam(life, "arcadia", () => life.census().grazer > 0);
    const g = life.animalsOf("grazer")[0]!;
    // Stand 4 m from one: it moves off past the keep distance within a few seconds.
    const l = Math.hypot(g.x, g.y, g.z);
    const p: [number, number, number] = [g.x + (g.y / l) * 4, g.y - (g.x / l) * 4, g.z];
    life.setPlayer(p[0], p[1], p[2], 0);
    const batch = fakeBatch();
    for (let i = 0; i < 60 * 5; i++) life.draw(batch, 1 / 60, i * 16.7);
    expect(Math.hypot(g.x - p[0], g.y - p[1], g.z - p[2])).toBeGreaterThan(GRAZER_KEEP - 1);
  });
});
