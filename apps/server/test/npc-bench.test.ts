// AI tick cost for 40 players' surroundings (budget: well under 10 ms per 50 ms tick).
// Runs the real NpcSystem on real terrain with a manual clock; players circle their spots at run
// speed so packs notice, chase and attack. Prints avg / p95 / max per scenario.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BODIES, type BodyId } from "@firstlight/shared";
import { resolveAreaDir, stableTangent, walk } from "@firstlight/shared/content/arenas";
import { NPC_AREAS } from "@firstlight/shared/content/npcs";
import type { PlayerActor } from "../src/world/actors.ts";
import type { V3 } from "../src/world/geometry.ts";
import { NPC_TUNING, resetTuning } from "../src/world/npc/index.ts";
import { fakeWorld } from "./npcWorld.ts";

beforeAll(() => {
  resetTuning();
  NPC_TUNING.ambient = true;
  NPC_TUNING.bosses = true;
});
afterAll(() => resetTuning());

function cross(a: readonly number[], b: readonly number[]): V3 {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
}

function ground(body: BodyId, terrain: ReturnType<typeof fakeWorld>["world"]["terrain"], d: readonly number[]): V3 {
  const R = BODIES[body].radius;
  const r = R + Math.max(terrain.groundHeight(d[0]!, d[1]!, d[2]!), BODIES[body].waterLevel - 1);
  return [d[0]! * r, d[1]! * r, d[2]! * r];
}

function run(body: BodyId, starts: V3[], label: string) {
  const w = fakeWorld(body, { immortal: true });
  const R = BODIES[body].radius;
  const players: { a: PlayerActor; dir: V3; t1: V3; t2: V3; phase: number }[] = starts.map((d, i) => {
    const t1 = stableTangent(d);
    return { a: w.addPlayer(`p${i}`, ground(body, w.world.terrain, d), body === "arcadia" ? 6 : body === "hollowmere" ? 12 : 18), dir: d, t1, t2: cross(d, t1), phase: i };
  });
  const times: number[] = [];
  let maxNpcs = 0;
  for (let tick = 0; tick < 520; tick++) {
    for (const p of players) {
      const ang = p.phase + (w.clock.t / 1000) * 0.5;
      w.movePlayer(p.a, ground(body, w.world.terrain, walk(p.dir, p.t1, Math.cos(ang) * 12, p.t2, Math.sin(ang) * 12, R)));
    }
    const ms = w.step(50);
    if (tick >= 120) times.push(ms);
    maxNpcs = Math.max(maxNpcs, w.sys.npcs.size);
  }
  times.sort((a, b) => a - b);
  const avg = times.reduce((s, x) => s + x, 0) / times.length;
  const p95 = times[Math.floor(times.length * 0.95)]!;
  const max = times[times.length - 1]!;
  const engaged = [...w.sys.npcs.values()].filter((n) => n.target).length;
  console.log(`[npc bench] ${label}: ${maxNpcs} NPCs live (${engaged} in combat at the end), ${w.sys.groups.filter((g) => g.active).length} spawn points awake — tick avg ${avg.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${max.toFixed(2)} ms`);
  return { avg, p95, max, maxNpcs };
}

/** Evenly spread directions (Fibonacci sphere), skipping water. */
function spread(body: BodyId, count: number): V3[] {
  const w = fakeWorld(body);
  const out: V3[] = [];
  for (let i = 0; out.length < count && i < count * 4; i++) {
    const y = 1 - ((i + 0.5) / (count * 4)) * 2;
    const r = Math.sqrt(1 - y * y);
    const phi = i * Math.PI * (3 - Math.sqrt(5));
    const d: V3 = [Math.cos(phi) * r, y, Math.sin(phi) * r];
    if (i % 4 !== 0) continue;
    if (w.world.terrain.groundHeight(d[0], d[1], d[2]) < BODIES[body].waterLevel + 0.5) continue;
    out.push(d);
  }
  return out;
}

function clustered(body: BodyId, areaId: string, count: number, radius: number): V3[] {
  const area = NPC_AREAS.find((a) => a.id === areaId)!;
  const c = resolveAreaDir(BODIES[body], area.at);
  const t1 = stableTangent(c);
  const t2 = cross(c, t1);
  return Array.from({ length: count }, (_, i) => {
    const ang = (i / count) * Math.PI * 2 * 3;
    const r = radius * Math.sqrt((i + 0.5) / count);
    return walk(c, t1, Math.cos(ang) * r, t2, Math.sin(ang) * r, BODIES[body].radius);
  });
}

describe("NPC AI tick cost (40 players)", () => {
  it("stays well under 10 ms per tick", () => {
    const results = [
      run("meridian", spread("meridian", 40), "Meridian, 40 players spread over the planet"),
      run("hollowmere", spread("hollowmere", 40), "Hollowmere, 40 players spread over the planet"),
      run("arcadia", clustered("arcadia", "clover_fields", 40, 120), "Arcadia, 40 players in Clover Fields"),
    ];
    for (const r of results) {
      expect(r.maxNpcs).toBeGreaterThan(20);
      expect(r.avg).toBeLessThan(10);
    }
  }, 120_000);
});
