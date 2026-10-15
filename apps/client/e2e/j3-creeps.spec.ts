// J3 (HANDOFF 6i; items 3 and 6c "no creeps outside", "let's see the creeps"): on each combat planet a
// new arrival sees a hostile creep within ~20 s, looking around and then following the mission
// pointer (or, without one, walking out of the arrival area); and a hostile can be killed for XP.

import { NPC_DEFS } from "@firstlight/shared/content/npcs";
import { expect, test } from "./fixtures.ts";
import { COMBAT_PLANETS, type Npc, type Player, type ServerNpc, type Snap, type Target } from "./player.ts";

const HOSTILE = new Set(NPC_DEFS.filter((d) => d.temper === "hostile").map((d) => d.id));
const CREATURE = new Set(NPC_DEFS.filter((d) => d.family !== "egg").map((d) => d.id));
/**
 * "In view": drawn by the client, inside the picture, and near enough to read as something to fight:
 * 40 m (Hexquill's range; a 0.9 m Hopbit is ~20 px tall there at 720p, a few pixels at 80 m).
 */
const IN_VIEW_M = 40;
const visibleHostile = (s: Snap): Npc | null => s.npcs?.find((n) => n.hostile && !n.dead && n.drawn && n.onScreen && n.dist <= IN_VIEW_M) ?? null;
const visibleCreature = (s: Snap): Npc | null => s.npcs?.find((n) => !n.dead && n.drawn && n.onScreen && n.dist <= IN_VIEW_M && CREATURE.has(n.kind)) ?? null;

/** The mission pointer on the compass (creeps lane, item 6c): its bearing from the strip, or null. */
async function missionPointerBearing(player: Player): Promise<number | null> {
  const ptr = player.page.locator('[data-e2e="compass-mission"]').first();
  if (!(await ptr.isVisible().catch(() => false))) return null;
  const strip = await player.page.locator(".fl-compass").first().boundingBox();
  const box = await ptr.boundingBox();
  if (!strip || !box) return null;
  const fx = (box.x + box.width / 2 - strip.x) / strip.width;
  return (fx - 0.5) * 190; // the strip spans ±95° (social/compass.ts HALF_SPAN)
}

/** Distances from the arrival pad to the nearest live hostile and creature, from the server's list. */
async function measureFromPad(player: Player, list: ServerNpc[]) {
  const near = async (pred: (n: ServerNpc) => boolean) => {
    let best: { def: string; m: number } | null = null;
    for (const n of list.filter((x) => x.hp > 0 && !x.boss && pred(x))) {
      const t = await player.targetOf([n.x, n.y, n.z]);
      if (t && (!best || t.surface < best.m)) best = { def: n.def, m: t.surface };
    }
    return best;
  };
  return { hostile: await near((n) => HOSTILE.has(n.def)), creature: await near((n) => CREATURE.has(n.def)), total: list.length };
}

/** Look around, then follow the mission pointer (or walk out of the arrival area) for `budgetMs`. */
async function lookForCreeps(player: Player, budgetMs: number) {
  const t0 = Date.now();
  const found = async (how: string) => {
    const s = await player.snap();
    const h = visibleHostile(s);
    return h ? { hostile: h, how, afterMs: Date.now() - t0 } : null;
  };
  for (let i = 0; i < 12; i++) {
    const f = await found("looking around the arrival pad");
    if (f) return f;
    await player.turn(30);
  }
  let pointerSeen = false;
  const s0 = await player.snap();
  const home = s0.portals?.[0];
  if (home) await player.turn(home.bearing + 180); // out of the gate: away from the portal home
  while (Date.now() - t0 < budgetMs) {
    const b = await missionPointerBearing(player);
    if (b !== null) {
      pointerSeen = true;
      if (Math.abs(b) > 8) await player.turn(b);
    }
    await player.hold(["ShiftLeft", "KeyW"], 1200);
    let f = await found(pointerSeen ? "following the mission pointer" : "walking out of the arrival area (no mission pointer)");
    if (f) return f;
    for (const d of [-45, 90, -45]) {
      await player.turn(d);
      f = await found(pointerSeen ? "following the mission pointer" : "walking out of the arrival area (no mission pointer)");
      if (f) return f;
    }
  }
  return { hostile: null, how: pointerSeen ? "followed the mission pointer" : "no mission pointer; walked out", afterMs: Date.now() - t0 };
}

test.describe("J3 creeps", () => {
  COMBAT_PLANETS.forEach((planet, i) => {
    test(`J3.${i + 1} · items 3, 6c · ${planet}: a hostile creep is in view within 20 s of arriving`, { tag: ["@J3", `@J3.${i + 1}`, "@item-3", "@item-6c"] }, async ({ player }) => {
      await player.joinAsDevAdmin({ starter: "Hexwick", body: planet });
      await player.waitInWorld(90_000, planet);
      await player.lock();
      const fromPad = await measureFromPad(player, await player.npcList());
      await player.note("from the arrival pad (server list)", fromPad);
      const arrival = await player.snap();
      const creature = visibleCreature(arrival);
      await player.note("at arrival", { replicatedNpcs: arrival.npcCount, creatureOnScreen: creature ? `${creature.kind} ${creature.dist} m` : null });
      await player.shot("arrival");
      const r = await lookForCreeps(player, 20_000);
      await player.note("search", { how: r.how, afterMs: r.afterMs, hostile: r.hostile ? `${r.hostile.kind} L${r.hostile.level} at ${r.hostile.dist} m` : null });
      await player.shot(r.hostile ? "creep-in-view" : "no-creep");
      expect(r.hostile, `a hostile creep within ${IN_VIEW_M} m and on screen within 20 s (${r.how}; nearest hostile from the pad: ${JSON.stringify(fromPad.hostile)})`).not.toBeNull();
    });
  });

  test("J3.4 · item 3 · Arcadia: a new player (Hexwick) kills a hostile and gets XP", { tag: ["@J3", "@J3.4", "@item-3"] }, async ({ player }) => {
    await player.joinAsDevAdmin({ starter: "Hexwick", body: "arcadia" });
    await player.waitInWorld(90_000, "arcadia");
    await player.lock();
    const start = await player.snap();
    const xp0 = start.you?.xp ?? 0;
    const level0 = start.you?.level ?? 1;

    // The nearest weak hostile the server has. Walk to it when it's close; otherwise (no creeps near
    // the arrival, item 6c) the admin teleport puts us 10 m from it so the kill itself is still tested.
    const list = (await player.npcList()).filter((n) => HOSTILE.has(n.def) && n.hp > 0 && !n.boss);
    expect(list.length, "the server has hostiles on Arcadia").toBeGreaterThan(0);
    const ranked = (await Promise.all(list.map(async (n) => ({ n, t: await player.targetOf([n.x, n.y, n.z]) })))).filter((x): x is { n: ServerNpc; t: Target } => !!x.t);
    expect(ranked.length, "hostiles we can locate").toBeGreaterThan(0);
    ranked.sort((a, b) => a.n.level - b.n.level || a.t.surface - b.t.surface);
    const pick = ranked[0]!;
    await player.note("target", { def: pick.n.def, level: pick.n.level, fromUsM: pick.t.surface });
    if (pick.t.surface > 60) {
      const p = [pick.n.x, pick.n.y, pick.n.z];
      const me = start.player!.pos;
      const d = Math.max(1, Math.hypot(me[0]! - p[0]!, me[1]! - p[1]!, me[2]! - p[2]!));
      const k = 10 / d;
      await player.admin("teleport", { x: p[0]! + (me[0]! - p[0]!) * k, y: p[1]! + (me[1]! - p[1]!) * k, z: p[2]! + (me[2]! - p[2]!) * k });
      await player.note("placement", "admin teleport to 10 m from the hostile (nothing within 60 m of the arrival)");
      await player.page.waitForTimeout(1500);
    }

    // Fight: the nearest live hostile within 40 m, aimed at through the camera like a player, healed by
    // the admin command when low (the test is about the kill paying XP, not about surviving a pack).
    await player.until((x) => !!x.npcs?.some((n) => n.hostile && !n.dead && n.dist < 40), "a hostile within 40 m", 30_000);
    const until = Date.now() + 75_000;
    let shots = 0;
    while (Date.now() < until) {
      const s = await player.snap();
      if ((s.you?.xp ?? 0) > xp0 || (s.you?.level ?? 1) > level0 || s.player?.dead) break;
      if ((s.player?.hp ?? 100) < 60) await player.admin("heal");
      const foe = s.npcs?.find((n) => n.hostile && !n.dead && n.dist < 40);
      if (!foe) {
        await player.walkTo((x) => x.npcs?.find((n) => n.hostile && !n.dead) ?? null, (x) => !!x.npcs?.find((n) => n.hostile && !n.dead && n.dist < 30), { timeoutMs: 3000 });
        continue;
      }
      await player.aim((x) => x.npcs?.find((n) => n.id === foe.id && !n.dead) ?? null);
      await player.attack();
      shots++;
      await player.page.waitForTimeout(250);
    }
    const end = await player.snap();
    await player.note("fight", { shots, xp: [xp0, end.you?.xp], level: [level0, end.you?.level], dead: end.player?.dead });
    await player.shot("after-fight");
    expect(end.player?.dead, "we didn't die").toBeFalsy();
    expect((end.you?.xp ?? 0) > xp0 || (end.you?.level ?? 1) > level0, "killing a hostile paid XP").toBe(true);
  });
});
