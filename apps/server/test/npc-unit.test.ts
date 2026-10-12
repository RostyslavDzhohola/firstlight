// NPC rules that are awkward to observe through sockets: AI hit caps, true damage, repeat-kill
// decay, cosmetic pity, deterministic spawn points.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BODIES, createTerrain, padDirs } from "@firstlight/shared";
import { bossArena } from "@firstlight/shared/content/arenas";
import { NF, NPC_INDEX, PLANET_COSMETIC } from "@firstlight/shared/content/npcs";
import { dealDamage } from "../src/world/combat.ts";
import { NPC_TUNING, resetTuning } from "../src/world/npc/index.ts";
import { PITY_IDLE_MS, pruneRewardMaps, repeatDecay, rollDrops } from "../src/world/npc/rewards.ts";
import { buildSpawnPoints } from "../src/world/npc/spawns.ts";
import { fakeWorld } from "./npcWorld.ts";

beforeEach(() => {
  resetTuning();
  NPC_TUNING.ambient = false;
  NPC_TUNING.bosses = false;
});
afterEach(() => resetTuning());

function arcadiaPoint(metres: number): [number, number, number] {
  const R = BODIES.arcadia.radius;
  const d = padDirs(BODIES.arcadia)[0]!;
  const t = [0, 0, 1];
  const v = [d[0] + (t[0]! * metres) / R, d[1] + (t[1]! * metres) / R, d[2] + (t[2]! * metres) / R];
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [(v[0]! / l) * R, (v[1]! / l) * R, (v[2]! / l) * R];
}

describe("AI hit caps (content §0, code clamp)", () => {
  it("a single regular/beast hit deals at most 35% of the target's max HP", () => {
    const w = fakeWorld("arcadia");
    const p = w.addPlayer("p", arcadiaPoint(80), 1);
    const beast = w.sys.createNpc(NPC_INDEX.get("bramblehorn")!, 8, arcadiaPoint(84), w.clock.t, { instant: true });
    expect(w.sys.hitPlayer(beast, p, 90)).toBe(35);
  });

  it("any AI sequence deals at most 80% within 1.5 s", () => {
    const w = fakeWorld("arcadia");
    const p = w.addPlayer("p", arcadiaPoint(80), 1);
    const a = w.sys.createNpc(NPC_INDEX.get("bramblehorn")!, 8, arcadiaPoint(84), w.clock.t, { instant: true });
    const b = w.sys.createNpc(NPC_INDEX.get("bramblehorn")!, 8, arcadiaPoint(86), w.clock.t, { instant: true });
    expect(w.sys.hitPlayer(a, p, 50)).toBe(35);
    w.clock.t += 300;
    expect(w.sys.hitPlayer(b, p, 50)).toBe(35);
    w.clock.t += 300;
    expect(w.sys.hitPlayer(a, p, 50)).toBe(10);
    expect(p.state.hp).toBe(20);
    w.clock.t += 1600;
    p.state.hp = 100;
    expect(w.sys.hitPlayer(a, p, 50)).toBe(35);
  });

  it("bosses cap at 60%, but split-circle true damage ignores the caps", () => {
    const w = fakeWorld("arcadia");
    const p = w.addPlayer("p", arcadiaPoint(80), 1);
    const boss = w.sys.createNpc(NPC_INDEX.get("tidewrath")!, 8, arcadiaPoint(90), w.clock.t, { instant: true, boss: true });
    expect(w.sys.hitPlayer(boss, p, 95)).toBe(60);
    w.clock.t += 2000;
    p.state.hp = 100;
    w.sys.hitPlayer(boss, p, 276, { trueDamage: true });
    expect(p.state.hp).toBe(0);
    expect(p.dead).toBe(true);
  });
});

describe("rewards", () => {
  it("repeat kills at one spawn point within 5 min lose 10% each, floor 30%", () => {
    const w = fakeWorld("arcadia");
    const t = w.clock.t;
    const seq = Array.from({ length: 9 }, (_, i) => repeatDecay(w.sys, "u1", "p7", t + i * 1000));
    expect(seq.map((x) => Math.round(x * 100))).toEqual([100, 90, 80, 70, 60, 50, 40, 30, 30]);
    expect(repeatDecay(w.sys, "u1", "p8", t)).toBe(1);
    expect(repeatDecay(w.sys, "u1", "p7", t + 9000 + 301_000)).toBe(1);
  });

  it("egg penalty NPCs dissolve at their TTL without rewards, and never feed the cosmetic pity", () => {
    const w = fakeWorld("arcadia");
    const p = w.addPlayer("p", arcadiaPoint(80), 3);
    const n = w.sys.createNpc(NPC_INDEX.get("hopbit")!, 3, arcadiaPoint(84), w.clock.t, { instant: true, spawned: { reason: "egg", key: "E2", userId: "u-p" }, ttlMs: 1000 });
    expect(w.sys.spawnedCount("egg")).toBe(1);
    expect(w.sys.spawnedCount("egg", "u-p")).toBe(1);
    expect(w.sys.spawnedCount("egg", "someone-else")).toBe(0);
    expect(rollDrops(w.sys, n, p, () => 0)).not.toContainEqual(expect.objectContaining({ id: PLANET_COSMETIC.arcadia.id }));
    w.step(900);
    expect(n.dead).toBe(false);
    w.step(200);
    expect(n.dead).toBe(true);
    expect(w.sys.spawnedCount("egg")).toBe(0);
    w.step(1300);
    expect(w.sys.npcs.has(n.id)).toBe(false);
    expect(p.char.xp).toBe(0);
    expect(w.sent.some((m) => m.type === "npcKill")).toBe(false);
  });

  it("reward bookkeeping is pruned: expired decay windows, idle pity counters, old Collector tags", () => {
    const w = fakeWorld("arcadia");
    const t = w.clock.t;
    repeatDecay(w.sys, "u1", "p7", t);
    repeatDecay(w.sys, "u2", "p7", t + 200_000);
    w.sys.cosmeticPity.set("u1|arcadia", { life: 1, kills: 4, at: t });
    w.sys.cosmeticPity.set("u2|arcadia", { life: 1, kills: 4, at: t + PITY_IDLE_MS });
    w.sys.tagged.set("s1", t + 1000);
    w.sys.tagged.set("s2", t + 400_000);
    pruneRewardMaps(w.sys, t + 301_000);
    expect([...w.sys.repeatKills.keys()]).toEqual(["u2|p7"]);
    expect([...w.sys.cosmeticPity.keys()]).toEqual(["u1|arcadia", "u2|arcadia"]);
    expect([...w.sys.tagged.keys()]).toEqual(["s2"]);
    pruneRewardMaps(w.sys, t + PITY_IDLE_MS + 1);
    expect([...w.sys.repeatKills.keys()]).toEqual([]);
    expect([...w.sys.cosmeticPity.keys()]).toEqual(["u2|arcadia"]);
    expect([...w.sys.tagged.keys()]).toEqual([]);
  });

  it("the planet cosmetic is guaranteed after 3× its expected kills in one life (pity)", () => {
    const w = fakeWorld("arcadia");
    const p = w.addPlayer("p", arcadiaPoint(80), 3);
    const n = w.sys.createNpc(NPC_INDEX.get("hopbit")!, 3, arcadiaPoint(84), w.clock.t, { instant: true });
    const expected = 1 / PLANET_COSMETIC.arcadia.chance;
    let got = -1;
    for (let k = 1; k <= 3 * expected; k++) {
      const items = rollDrops(w.sys, n, p, () => 0.999);
      if (items.some((i) => i.id === PLANET_COSMETIC.arcadia.id)) {
        got = k;
        break;
      }
    }
    expect(got).toBe(3 * expected);
  });
});

describe("spawn points", () => {
  it("are deterministic and keep out of pad safe rings and the boss lair", () => {
    for (const id of ["arcadia", "hollowmere", "meridian"] as const) {
      const t = createTerrain(id);
      const arena = bossArena(t)!;
      const a = buildSpawnPoints(t, arena);
      const b = buildSpawnPoints(createTerrain(id), bossArena(createTerrain(id)));
      expect(a.map((p) => p.pos)).toEqual(b.map((p) => p.pos));
      const R = BODIES[id].radius;
      for (const p of a) {
        for (const pad of padDirs(BODIES[id])) expect(Math.hypot(pad[0] - p.dir[0], pad[1] - p.dir[1], pad[2] - p.dir[2]) * R).toBeGreaterThanOrEqual(39.9);
        expect(Math.hypot(arena.up[0] - p.dir[0], arena.up[1] - p.dir[1], arena.up[2] - p.dir[2]) * R).toBeGreaterThan(arena.radius);
      }
      expect(a.length).toBeGreaterThan(50);
    }
  });
});

describe("review fixes (units)", () => {
  it("boss weak points are volumes exposed only in their window, with the boss's own multiplier", () => {
    const w = fakeWorld("arcadia");
    const boss = w.sys.boss!;
    boss.forceSpawn(w.clock.t);
    const n = boss.npc!;
    n.state.flags &= ~(NF.SPAWNING | NF.INVULN); // past the 1 s materialise
    const u = n.pos.map((v) => v / Math.hypot(...n.pos)) as [number, number, number];
    const f = n.facing;
    const vent: [number, number, number] = [0, 1, 2].map((i) => n.pos[i]! + u[i]! * 2.1 + f[i]! * 3.3) as [number, number, number];
    const crown: [number, number, number] = [0, 1, 2].map((i) => n.pos[i]! + u[i]! * 6.8) as [number, number, number];
    // A shot from 20 m in front of the boss, aimed at a target point; the capsule entry is ~4 m short of the axis.
    const shot = (target: [number, number, number]) => {
      const o = [0, 1, 2].map((i) => target[i]! + f[i]! * 20) as [number, number, number];
      const d = [0, 1, 2].map((i) => (target[i]! - o[i]!) / 20) as [number, number, number];
      return n.weakPoint!(o, d, 20 - 1.2);
    };
    expect(n.weakMult).toBe(1.5);
    expect(shot(vent)).toBe(false); // closed: no weak point at all
    expect(boss.mitigate(n, 1000, true)).toBe(200); // and armour applies (no generic headshot leak)
    boss.windowUntil = w.clock.t + 5000; // Moored
    expect(shot(vent)).toBe(true);
    expect(shot(crown)).toBe(false); // the top of the shell isn't the vent
    expect(boss.mitigate(n, 1000, true)).toBe(1000);
  });

  it("an overkill hit only credits the HP it actually removed", () => {
    const w = fakeWorld("arcadia");
    const a = w.addPlayer("a", arcadiaPoint(80), 1);
    const b = w.addPlayer("b", arcadiaPoint(82), 1);
    const n = w.sys.createNpc(NPC_INDEX.get("hopbit")!, 1, arcadiaPoint(90), w.clock.t, { instant: true });
    dealDamage(w.world.host, a, n, 15, false);
    dealDamage(w.world.host, b, n, 500, false);
    expect(n.damage.get(a.identity.userId)!.amount).toBe(15);
    expect(n.damage.get(b.identity.userId)!.amount).toBe(7);
  });

  it("raised Bonewalkers crumble when their Cantor dies", () => {
    const w = fakeWorld("hollowmere");
    const R = 750;
    const at: [number, number, number] = [0, R, 0];
    const cantor = w.sys.createNpc(NPC_INDEX.get("cantor")!, 9, at, w.clock.t, { instant: true });
    const child = w.sys.createNpc(NPC_INDEX.get("bonewalker")!, 9, [3, R, 0], w.clock.t, { instant: true, summoner: cantor.id });
    cantor.raised.add(child.id);
    dealDamage(w.world.host, null, cantor, 10_000, false);
    expect(cantor.dead).toBe(true);
    expect(child.dead).toBe(true);
    expect(child.state.flags & NF.DEAD).toBeTruthy();
  });
});
