// NPC rules that are awkward to observe through sockets: AI hit caps, true damage, repeat-kill
// decay, cosmetic pity, deterministic spawn points.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BODIES, createTerrain, padDirs } from "@firstlight/shared";
import { bossArena } from "@firstlight/shared/content/arenas";
import { NF, NPC_INDEX, PLANET_COSMETIC } from "@firstlight/shared/content/npcs";
import { env } from "../src/env.ts";
import { dealDamage } from "../src/world/combat.ts";
import { NPC_TUNING, resetTuning } from "../src/world/npc/index.ts";
import { EGG_NPC } from "../src/world/npc/NpcSystem.ts";
import { copyStateStore, MemoryCopyStateStore } from "../src/world/copyState.ts";
import { onNpcEvent, type NpcEvent } from "../src/world/npc/tuning.ts";
import { cosmeticPity, PITY_IDLE_MS, pruneRewardMaps, repeatDecay, rollDrops } from "../src/world/npc/rewards.ts";
import { buildSpawnPoints } from "../src/world/npc/spawns.ts";
import { PAYOUT_RETRY, PayoutQueue } from "../src/world/npc/payouts.ts";
import { fakeWorld } from "./npcWorld.ts";

beforeEach(() => {
  cosmeticPity.clear();
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
  it.each(["arcadia:0", "arcadia:1"])("539 misses survive recreation or travel to %s and roll 540 pays the same account and life", (copyKey) => {
    const w = fakeWorld("arcadia", { copyKey: "arcadia:0" });
    const p = w.addPlayer("persistent_pity", arcadiaPoint(80), 3);
    const n = w.sys.createNpc(NPC_INDEX.get("hopbit")!, 3, arcadiaPoint(84), w.clock.t, { instant: true });
    for (let k = 0; k < 539; k++) {
      expect(rollDrops(w.sys, n, p, () => 0.999).some((i) => i.id === "petalwake_mask")).toBe(false);
    }
    w.sys.dispose();
    const back = fakeWorld("arcadia", { copyKey, start: w.clock.t + 1000 });
    const same = back.addPlayer("persistent_pity", arcadiaPoint(80), 3);
    same.char.lifeStartedAt = p.char.lifeStartedAt;
    const next = back.sys.createNpc(NPC_INDEX.get("hopbit")!, 3, arcadiaPoint(84), back.clock.t, { instant: true });
    const other = back.addPlayer("unrelated_pity", arcadiaPoint(80), 3);
    other.char.lifeStartedAt = p.char.lifeStartedAt;
    expect(rollDrops(back.sys, next, other, () => 0.999).some((i) => i.id === "petalwake_mask")).toBe(false);
    same.char.lifeStartedAt++;
    expect(rollDrops(back.sys, next, same, () => 0.999).some((i) => i.id === "petalwake_mask")).toBe(false);
    same.char.lifeStartedAt = p.char.lifeStartedAt;
    expect(rollDrops(back.sys, next, same, () => 0.999)).toContainEqual({ id: "petalwake_mask", tier: 1, qty: 1 });
    back.sys.dispose();
  });

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

  it.each([
    ["arcadia", "hopbit", "petalwake_mask", 540],
    ["hollowmere", "bonewalker", "fenweave_cape", 480],
  ] as const)("%s new drop has independent pity, resets on rebirth and excludes penalty spawns", (body, kind, id, limit) => {
    const w = fakeWorld(body);
    const p = w.addPlayer("p", arcadiaPoint(80), 3);
    const n = w.sys.createNpc(NPC_INDEX.get(kind)!, 3, arcadiaPoint(84), w.clock.t, { instant: true });
    for (let k = 1; k < limit; k++) expect(rollDrops(w.sys, n, p, () => 0.999).some((i) => i.id === id)).toBe(false);
    expect(rollDrops(w.sys, n, p, () => 0.999)).toContainEqual({ id, tier: 1, qty: 1 });
    expect(rollDrops(w.sys, n, p, () => 0.999).some((i) => i.id === id)).toBe(false);
    for (let k = 1; k < limit - 1; k++) rollDrops(w.sys, n, p, () => 0.999);
    p.char.lifeStartedAt++;
    expect(rollDrops(w.sys, n, p, () => 0.999).some((i) => i.id === id)).toBe(false);
    const penalty = w.sys.createNpc(NPC_INDEX.get(kind)!, 3, arcadiaPoint(84), w.clock.t, { instant: true, spawned: { reason: "egg", key: "E2", userId: "u-p" }, ttlMs: 1000 });
    expect(rollDrops(w.sys, penalty, p, () => 0).some((i) => i.id === id)).toBe(false);
    expect(rollDrops(w.sys, n, p, () => 0)).toContainEqual({ id, tier: 1, qty: 1 });
    w.sys.dispose();
  });

  it("disabled extra rolls leave the original planet drops available", () => {
    const enabled = env.cosmeticsExtras;
    env.cosmeticsExtras = false;
    try {
      const w = fakeWorld("arcadia");
      const p = w.addPlayer("p", arcadiaPoint(80), 3);
      const n = w.sys.createNpc(NPC_INDEX.get("hopbit")!, 3, arcadiaPoint(84), w.clock.t, { instant: true });
      const drops = rollDrops(w.sys, n, p, () => 0);
      expect(drops).toContainEqual({ id: "winged_cap", tier: 1, qty: 1 });
      expect(drops.some((i) => i.id === "petalwake_mask")).toBe(false);
      w.sys.dispose();
    } finally { env.cosmeticsExtras = enabled; }
  });

  it("reward bookkeeping is pruned: expired decay windows, idle pity counters, old Collector tags", () => {
    const w = fakeWorld("arcadia");
    const t = w.clock.t;
    repeatDecay(w.sys, "u1", "p7", t);
    repeatDecay(w.sys, "u2", "p7", t + 200_000);
    cosmeticPity.set("u1|arcadia", { kills: 4, at: t });
    cosmeticPity.set("u2|arcadia", { kills: 4, at: t + PITY_IDLE_MS });
    w.sys.tagged.set("s1", t + 1000);
    w.sys.tagged.set("s2", t + 400_000);
    pruneRewardMaps(w.sys, t + 301_000);
    expect([...w.sys.repeatKills.keys()]).toEqual(["u2|p7"]);
    expect([...cosmeticPity.keys()]).toEqual(["u1|arcadia", "u2|arcadia"]);
    expect([...w.sys.tagged.keys()]).toEqual(["s2"]);
    pruneRewardMaps(w.sys, t + PITY_IDLE_MS + 1);
    expect([...w.sys.repeatKills.keys()]).toEqual([]);
    expect([...cosmeticPity.keys()]).toEqual(["u2|arcadia"]);
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

describe("payout retries (F12 confirm Sonnet SF1)", () => {
  /** A fake world whose saves throw while `fail.on`, with persist's rollback of the touched characters. */
  function flakyWorld() {
    const w = fakeWorld("arcadia");
    const fail = { on: false, tries: 0 };
    w.world.save = () => {
      fail.tries++;
      if (fail.on) throw new Error("disk I/O error (test)");
    };
    w.world.withTx = (players, fn) => {
      const before = players.map((p) => ({ p, char: structuredClone(p.char) }));
      try {
        return fn();
      } catch (err) {
        for (const { p, char } of before) Object.assign(p.char, char);
        throw err;
      }
    };
    return { w, fail };
  }

  it("a failed kill payout is retried after 1 s, 3 s and 6 s; a recipient who left by then forfeits only their own share", () => {
    const { w, fail } = flakyWorld();
    const a = w.addPlayer("a", arcadiaPoint(80), 1);
    const b = w.addPlayer("b", arcadiaPoint(82), 1);
    const n = w.sys.createNpc(NPC_INDEX.get("bramblehorn")!, 3, arcadiaPoint(90), w.clock.t, { instant: true });
    const events: NpcEvent[] = [];
    const off = onNpcEvent((e) => e.kind === "kill" && events.push(e));
    try {
      fail.on = true;
      dealDamage(w.world.host, a, n, n.state.maxHp * 0.3, false);
      dealDamage(w.world.host, b, n, n.state.maxHp, false); // the top dealer: the coins are b's
      expect(n.dead).toBe(true);
      expect(w.sys.payouts.size()).toBe(1);
      expect([a.char.xp, b.char.xp, b.char.coins]).toEqual([0, 0, 0]);
      expect(fail.tries).toBe(1); // both shares in one transaction: its first save threw
      w.step(900);
      expect(fail.tries).toBe(1);
      w.step(200); // first retry at +1 s: fails again
      expect(fail.tries).toBe(2);
      expect(w.sys.payouts.size()).toBe(1);
      // b (the top dealer) leaves; storage recovers before the second retry, 3 s later.
      w.players.delete("b");
      fail.on = false;
      for (let i = 0; i < 70; i++) w.step(50);
      expect(w.sys.payouts.size()).toBe(0);
      expect(a.char.xp).toBeGreaterThan(0);
      expect(a.char.coins).toBe(0);
      expect([b.char.xp, b.char.coins]).toEqual([0, 0]);
      const kills = w.sent.filter((m) => m.type === "npcKill");
      expect(kills.map((m) => m.to)).toEqual(["a"]);
      expect(events.map((e) => (e as { userIds: string[] }).userIds)).toEqual([["u-a"]]);
      // Settled: nothing runs again.
      const xp = a.char.xp;
      for (let i = 0; i < 300; i++) w.step(50);
      expect(a.char.xp).toBe(xp);
      expect(w.sent.filter((m) => m.type === "npcKill")).toHaveLength(1);
    } finally {
      off();
    }
  });

  it("a payout still waiting when its room closes gets one last try, so its ground loot isn't lost (T9 review)", () => {
    const w = fakeWorld("arcadia");
    let failing = true;
    let commits = 0;
    let published = 0;
    w.sys.payouts.pay("kill:x", "test", () => {
      if (failing) throw new Error("save failed");
      commits++;
      return () => {
        published++;
      };
    }, w.clock.t);
    expect(w.sys.payouts.size()).toBe(1);
    failing = false; // storage is back, but the room closes before the 1 s retry
    w.sys.dispose();
    expect([commits, published, w.sys.payouts.size()]).toEqual([1, 1, 0]);
  });

  it("the last try at close gives up if the save still fails, without throwing", () => {
    const q = new PayoutQueue();
    let tries = 0;
    q.pay("k", "test", () => {
      tries++;
      throw new Error("save failed");
    }, 0);
    expect(() => q.flush(10)).not.toThrow();
    expect([tries, q.size()]).toEqual([2, 0]);
  });

  it("the queue is keyed: a paid or waiting key never runs again, and a publish error isn't a retry", () => {
    const q = new PayoutQueue();
    let commits = 0;
    let publishes = 0;
    const ok = () => {
      commits++;
      return () => {
        publishes++;
      };
    };
    q.pay("k", "test", ok, 0);
    q.pay("k", "test", ok, 1);
    expect([commits, publishes, q.size()]).toEqual([1, 1, 0]);

    let failing = true;
    let tries = 0;
    const flaky = () => {
      tries++;
      if (failing) throw new Error("save failed");
      return () => {};
    };
    q.pay("f", "test", flaky, 0);
    q.pay("f", "test", flaky, 10); // already waiting: not queued twice
    expect([tries, q.size()]).toEqual([1, 1]);
    q.tick(999);
    expect(tries).toBe(1);
    failing = false;
    q.tick(1000);
    expect([tries, q.size()]).toEqual([2, 0]);
    q.tick(30_000);
    q.pay("f", "test", flaky, 30_001); // settled: not paid again
    expect(tries).toBe(2);

    let late = 0;
    q.pay("p", "test", () => {
      late++;
      return () => {
        throw new Error("publish failed");
      };
    }, 0);
    q.tick(20_000);
    expect([late, q.size()]).toEqual([1, 0]);

    let doomed = 0;
    q.pay("d", "test", () => {
      doomed++;
      throw new Error("save failed");
    }, 0);
    for (let t = 0; t <= 20_000; t += 500) q.tick(t);
    expect([doomed, q.size()]).toEqual([1 + PAYOUT_RETRY.delaysMs.length, 0]);
  });
});

describe("egg NPCs", () => {
  it("the Golden Hopbit runs to its burrow for whoever stays within 15 m of it for 60 s; walking off resets it; a hit pops it", () => {
    const w = fakeWorld("arcadia");
    const events: NpcEvent[] = [];
    const off = onNpcEvent((e) => events.push(e));
    try {
      const golden = w.sys.createNpc(NPC_INDEX.get("golden_hopbit")!, 1, arcadiaPoint(84), w.clock.t, { instant: true, roam: 0 });
      const p = w.addPlayer("p", arcadiaPoint(94), 3); // 10 m: close enough to follow, too far to make it flee
      const run = (ms: number) => {
        for (let t = 0; t < ms; t += 500) w.step(500);
      };
      run(30_000);
      expect(events.filter((e) => e.kind === "egg")).toHaveLength(0);
      w.movePlayer(p, arcadiaPoint(140)); // walks off: the follow resets
      run(2_000);
      w.movePlayer(p, arcadiaPoint(94));
      run(58_000);
      expect(events.filter((e) => e.kind === "egg")).toHaveLength(0);
      run(4_000);
      expect(events.filter((e) => e.kind === "egg")).toEqual([{ kind: "egg", body: "arcadia", egg: "E3", sessionId: "p", userId: "u-p" }]);
      expect(golden.dead).toBe(true);
      // Another one, popped by a hit: 25 coins, no egg.
      const second = w.sys.createNpc(NPC_INDEX.get("golden_hopbit")!, 1, arcadiaPoint(84), w.clock.t, { instant: true, roam: 0 });
      const coins = p.char.coins;
      dealDamage(w.world.host, p, second, 5, false);
      expect(second.dead).toBe(true);
      expect(p.char.coins).toBe(coins + 25);
      expect(events.filter((e) => e.kind === "egg")).toHaveLength(1);
    } finally {
      off();
    }
  });

  it("a Golden Hopbit that was popped stays away on its own timer, not the pack's", () => {
    const w = fakeWorld("arcadia");
    NPC_TUNING.respawnScale = 0.01;
    w.sys.ambientOn = true;
    const g = w.sys.groups.find((x) => x.point.members.some((m) => m.golden))!;
    expect(g).toBeTruthy();
    w.addPlayer("p", g.point.pos, 3);
    const golden = () => g.members.find((m) => m?.def.id === "golden_hopbit") ?? null;
    const clearPack = () => {
      for (const m of [...g.members]) if (m && !m.dead) w.sys.retire(m);
    };
    for (let i = 0; i < 4 && !g.active; i++) w.step(600);
    expect(golden()).not.toBeNull();
    w.sys.retire(golden()!); // popped (or ran into its burrow)
    clearPack();
    expect(g.cleared).toBe(true);
    for (let i = 0; i < 40 && !g.active; i++) w.step(600); // the pack respawns quickly…
    expect(g.active).toBe(true);
    expect(g.members.some((m) => m && m.def.id === "hopbit")).toBe(true);
    expect(golden()).toBeNull(); // …without the Golden Hopbit
    // Its own timer runs out while this pack is still alive: it comes back on its own.
    const pack = g.members.filter((m) => m && !m.dead).map((m) => m!.id);
    expect(pack.length).toBeGreaterThan(0);
    w.clock.t += EGG_NPC.goldenBackMs;
    for (let i = 0; i < 4 && !golden(); i++) w.step(600);
    expect(golden()).not.toBeNull();
    expect(g.members.filter((m) => m && !m.dead && m.def.id !== "golden_hopbit").map((m) => m!.id)).toEqual(pack);
  });
});

describe("egg NPC timers in the copy state", () => {
  it("a popped Golden Hopbit's return time survives a new room on the same copy", () => {
    copyStateStore.current = new MemoryCopyStateStore();
    try {
      NPC_TUNING.respawnScale = 0.01;
      const w = fakeWorld("arcadia", { copyKey: "arcadia:0" });
      w.sys.ambientOn = true;
      const g = w.sys.groups.find((x) => x.point.members.some((m) => m.golden))!;
      w.addPlayer("p", g.point.pos, 3);
      for (let i = 0; i < 4 && !g.active; i++) w.step(600);
      const golden = g.members.find((m) => m?.def.id === "golden_hopbit")!;
      w.sys.retire(golden);
      const back = w.sys.goldenBack.get(g.point.id)!;
      expect(back).toBeGreaterThan(w.clock.t);
      w.sys.dispose(); // the copy empties
      // A new room on the same copy, two minutes later.
      const w2 = fakeWorld("arcadia", { copyKey: "arcadia:0", start: w.clock.t + 120_000 });
      w2.sys.ambientOn = true;
      expect(w2.sys.goldenBack.get(g.point.id)).toBe(back);
      const g2 = w2.sys.groups[g.point.id]!;
      w2.addPlayer("p", g2.point.pos, 3);
      for (let i = 0; i < 4 && !g2.active; i++) w2.step(600);
      const gi = g2.point.members.findIndex((m) => m.golden);
      expect(g2.members[gi]).toBeNull(); // still away
      w2.clock.t = back;
      for (let i = 0; i < 4 && !g2.members[gi]; i++) w2.step(600);
      expect(g2.members[gi]?.def.id).toBe("golden_hopbit"); // back on its own timer
    } finally {
      copyStateStore.current = new MemoryCopyStateStore();
    }
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
