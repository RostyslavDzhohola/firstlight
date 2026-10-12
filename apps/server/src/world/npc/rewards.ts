// Kill rewards (content §1.2, §1.4, §3.6, §4.1): XP to everyone who dealt ≥ 20% of max HP or the
// killing blow (with the repeat-kill decay per spawn point), coins auto-credited to the top damage
// dealer, item drops rolled for the top damage dealer and left as a glowing pile at the corpse,
// camp chests when a camp's elite dies, and personal boss loot.

import { killXp } from "@firstlight/shared/content/progression";
import {
  DROP_WEAPONS, NPC_RULES, PLANET_COSMETIC, PLANET_TONIC, npcCoins, weaponTierFor,
  type BossDef, type CampChest, type PlanetId,
} from "@firstlight/shared/content/npcs";
import type { InvItem } from "@firstlight/shared/net/protocol";
import { actorPos, type PlayerActor } from "../actors.ts";
import type { V3 } from "../geometry.ts";
import type { NpcSystem } from "./NpcSystem.ts";
import type { Npc } from "./npc.ts";
import { emitNpcEvent } from "./tuning.ts";
import { actorOf, recipientOf, stillEligible } from "./payouts.ts";

type Rng = () => number;

/**
 * XP multiplier for killing at the same spawn point again within 5 minutes (−10% per kill, floor 30%).
 * `key` names the spawn source: a spawn point or a summoner.
 */
export function repeatDecay(sys: NpcSystem, userId: string, key: string, now: number): number {
  const k = `${userId}|${key}`;
  const window = NPC_RULES.repeatWindowSeconds * 1000;
  const list = (sys.repeatKills.get(k) ?? []).filter((t) => now - t < window);
  const decay = Math.max(NPC_RULES.repeatFloor, 1 - NPC_RULES.repeatStep * list.length);
  list.push(now);
  sys.repeatKills.set(k, list);
  return decay;
}

/** How long an idle planet-cosmetic pity counter is kept (ms); the counter is per life anyway. */
export const PITY_IDLE_MS = 6 * 60 * 60_000;

/** Drop reward bookkeeping nobody can use any more (expired decay windows, idle pity, old tags). */
export function pruneRewardMaps(sys: NpcSystem, now: number) {
  const window = NPC_RULES.repeatWindowSeconds * 1000;
  for (const [k, list] of sys.repeatKills) if (!list.length || now - list[list.length - 1]! >= window) sys.repeatKills.delete(k);
  for (const [k, p] of sys.cosmeticPity) if (now - p.at > PITY_IDLE_MS) sys.cosmeticPity.delete(k);
  for (const [k, until] of sys.tagged) if (until <= now) sys.tagged.delete(k);
}

export function randomWeapon(level: number, rng: Rng, tier?: 1 | 2 | 3): InvItem {
  const id = DROP_WEAPONS[Math.floor(rng() * DROP_WEAPONS.length)]!;
  return { id, tier: tier ?? weaponTierFor(level, rng()), qty: 1 };
}

/** Roll a def's drop table (plus the planet cosmetic with pity) for the top damage dealer. */
export function rollDrops(sys: NpcSystem, n: Npc, top: PlayerActor, rng: Rng = Math.random): InvItem[] {
  const out: InvItem[] = [];
  const planet = sys.planet ?? "arcadia";
  for (const e of n.def.drops) {
    switch (e.kind) {
      case "item":
        if (rng() < e.chance) out.push({ id: e.id, tier: e.tier ?? 1, qty: e.qty ?? 1 });
        break;
      case "weapon":
        if (rng() < e.chance) out.push(randomWeapon(n.level, rng, e.tier));
        break;
      case "tonic":
        if (rng() < e.chance) out.push({ id: PLANET_TONIC[planet].id, tier: 1, qty: 1 });
        break;
      case "grenade":
        if (rng() < e.chance) out.push({ id: "grenade", tier: weaponTierFor(n.level, rng()), qty: 1 });
        break;
    }
  }
  if (n.def.temper !== "critter" && n.def.temper !== "passive" && n.def.family !== "egg" && !n.summoner && !n.spawned) {
    const c = PLANET_COSMETIC[planet];
    const key = `${top.identity.userId}|${planet}`;
    const pity = sys.cosmeticPity.get(key);
    let kills = pity && pity.life === top.char.lifeStartedAt ? pity.kills + 1 : 1;
    if (rng() < c.chance || kills >= 3 / c.chance) {
      out.push({ id: c.id, tier: 1, qty: 1 });
      kills = 0;
    }
    sys.cosmeticPity.set(key, { life: top.char.lifeStartedAt, kills, at: sys.world.now() });
  }
  return out;
}

/**
 * Pay a kill. The payout is decided once, here (each XP share with this kill's repeat decay, the top
 * dealer's coins, the rolled drops and camp chest), so the decay and pity counters move once and a
 * retry pays exactly this. XP, coins, drops, chest and saves land together; pile events, level-ups,
 * the kill news and hunt credit go out after the commit (D26, F12 final B1). A failed save pays
 * nobody anything and is retried on later ticks (payouts.ts, F12 confirm Sonnet SF1); by then a
 * recipient who left, died or was reborn forfeits their XP and coins, while the ground piles (drops,
 * chest) are still placed.
 */
export function rewardKill(sys: NpcSystem, n: Npc, killerId: string | null, now: number) {
  // Egg penalties and staged-scene spawns pay nothing (no XP, coins, drops or hunt credit): they are
  // a penalty and a film set, not a farm (F12 review S1).
  if (n.spawned) return;
  const def = n.def;
  const world = sys.world;
  const maxHp = n.state.maxHp;
  const killer = killerId ? world.playerById(killerId) ?? null : null;
  const xpTo: PlayerActor[] = [];
  let top: PlayerActor | null = null;
  let topAmt = -1;
  // Credit is HP actually removed per account (overkill can't outrank earlier damage).
  for (const e of n.damage.values()) {
    const p = actorOf(world, e.userId, e.sid);
    if (!p || p.dead) continue;
    if (e.amount > topAmt) {
      topAmt = e.amount;
      top = p;
    }
    if (e.amount >= NPC_RULES.xpShare * maxHp || (killer && killer.identity.userId === e.userId)) xpTo.push(p);
  }
  if (killer && !killer.dead && !xpTo.includes(killer)) xpTo.push(killer);
  const key = n.point ? `p${n.point.id}` : n.summoner ? `s${n.summoner}` : `x${n.id}`;
  const shares = xpTo.map((p) => ({ who: recipientOf(p), xp: killXp(def.tier, n.level, p.char.level, repeatDecay(sys, p.identity.userId, key, now)) }));
  const coins = top ? npcCoins(def, n.level) : 0;
  const drops = top ? rollDrops(sys, n, top) : [];
  const topWho = top ? recipientOf(top) : null;
  const chestOwner = n.point?.chest && n.point.chestKey === n.member ? (top ?? killer) : null;
  const chest = chestOwner ? rollChest(sys, n.point!.chest!, n.level) : null;
  const at: V3 = [n.pos[0], n.pos[1], n.pos[2]];
  const chestAt = n.point?.pos;
  const commit = () => {
    const gains = new Map<string, { p: PlayerActor; xp: number; coins: number }>();
    const paid = shares.map((s) => ({ s, p: stillEligible(world, s.who) }));
    const coinsTo = topWho ? stillEligible(world, topWho) : null;
    const touched = [...new Set([...paid.flatMap((x) => (x.p ? [x.p] : [])), ...(coinsTo ? [coinsTo] : [])])];
    const events: (() => void)[] = [];
    world.withTx(touched, () => {
      for (const { s, p } of paid) {
        if (!p) continue;
        if (s.xp > 0) events.push(world.addXp(p, s.xp));
        gains.set(p.id, { p, xp: s.xp, coins: 0 });
      }
      if (coinsTo) {
        if (coins > 0) {
          coinsTo.char.coins += coins;
          coinsTo.youDirty = true;
        }
        const g = gains.get(coinsTo.id) ?? { p: coinsTo, xp: 0, coins: 0 };
        g.coins = coins;
        gains.set(coinsTo.id, g);
      }
      if (top && drops.length) world.createPile(top, drops.map((it) => ({ ...it })), 0, at, events);
      if (chestOwner && chest && chestAt) placeChest(sys, chest, chestOwner, chestAt, events);
      for (const g of gains.values()) world.save(g.p);
    });
    return () => {
      for (const e of events) e();
      for (const g of gains.values()) world.send(g.p, "npcKill", { id: n.id, kind: n.defIndex, xp: g.xp, coins: g.coins });
      emitNpcEvent({
        kind: "kill",
        body: world.body.id,
        def: def.id,
        npcLevel: n.level,
        players: [...gains.keys()],
        userIds: [...gains.values()].map((g) => g.p.identity.userId),
        area: n.point?.area ?? null,
      });
    };
  };
  sys.payouts.pay(`kill:${n.id}`, `kill reward for ${def.id} (${n.id})`, commit, now);
}

/** A camp chest's contents (content §1.4), rolled once per opening. */
export interface ChestRoll {
  items: InvItem[];
  coins: number;
}

export function rollChest(sys: NpcSystem, chest: CampChest, level: number, rng: Rng = Math.random): ChestRoll {
  const planet: PlanetId = sys.planet ?? "arcadia";
  const items: InvItem[] = [];
  for (let i = 0; i < chest.weapons; i++) items.push(randomWeapon(level, rng));
  if (chest.tonics > 0) items.push({ id: PLANET_TONIC[planet].id, tier: 1, qty: chest.tonics });
  if (chest.cosmetic && rng() < chest.cosmetic.chance) items.push({ id: chest.cosmetic.id, tier: 1, qty: 1 });
  return { items, coins: chest.coins };
}

/** Camp chest (content §1.4): opens when the camp elite dies; a pile at the camp centre. */
export function placeChest(sys: NpcSystem, chest: ChestRoll, owner: PlayerActor, at: V3, deferred?: (() => void)[]) {
  sys.world.createPile(owner, chest.items.map((it) => ({ ...it })), chest.coins, at, deferred);
  const announce = () => sys.sendNear(at, 80, "npcChest", { x: at[0], y: at[1], z: at[2], coins: chest.coins, items: chest.items.length });
  if (deferred) deferred.push(announce);
  else announce();
}

/** Personal boss loot for one eligible player (coins and XP are fixed by the def), rolled once. */
export function rollBossLoot(def: BossDef, rng: Rng = Math.random): InvItem[] {
  const items: InvItem[] = [];
  for (const a of def.loot.always) {
    if (a.id === "weapon") items.push(randomWeapon(def.level, rng, a.tier === "random3" ? 3 : 2));
    else items.push({ id: a.id, tier: (typeof a.tier === "number" ? a.tier : 1) as 1 | 2 | 3, qty: a.qty });
  }
  for (const r of def.loot.rolls) {
    if (rng() >= r.chance) continue;
    const id = r.oneOf[Math.floor(rng() * r.oneOf.length)]!;
    if (id === "weapon") items.push(randomWeapon(def.level, rng, r.weaponTier ?? 2));
    else items.push({ id, tier: 1, qty: 1 });
  }
  return items;
}

/**
 * Pay rolled boss loot: coins, XP, items into the inventory, overflow at the player's feet, in one
 * transaction (throws if it fails: nothing was paid). Returns the pile events and level-up to run
 * after the commit (D26, F12 final B1).
 */
export function payBossLoot(sys: NpcSystem, def: BossDef, p: PlayerActor, items: readonly InvItem[]): () => void {
  const events: (() => void)[] = [];
  sys.world.withTx([p], () => {
    p.char.coins += def.loot.coins;
    p.youDirty = true;
    events.push(sys.world.addXp(p, def.loot.xp));
    const leftovers: InvItem[] = [];
    for (const it of items) if (!sys.world.giveItem(p, { ...it })) leftovers.push({ ...it });
    if (leftovers.length) sys.world.createPile(p, leftovers, 0, actorPos(p), events);
    sys.world.save(p);
  });
  return () => {
    for (const e of events) e();
  };
}
