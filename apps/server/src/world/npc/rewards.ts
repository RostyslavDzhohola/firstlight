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

type Rng = () => number;

/**
 * XP multiplier for killing at the same spawn point again within 5 minutes (−10% per kill, floor 30%).
 * `key` names the spawn source: a spawn point, a summoner, or an egg (penalty spawns share one key per
 * egg, so farming wrong answers decays like farming one pack).
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

/** The live actor of an account in this room (connected players only), preferring its last session. */
function actorOf(sys: NpcSystem, userId: string, sid: string): PlayerActor | null {
  const bySid = sys.world.playerById(sid);
  if (bySid && bySid.identity.userId === userId) return bySid;
  for (const p of sys.world.connected()) if (p.identity.userId === userId) return p;
  return null;
}

export function rewardKill(sys: NpcSystem, n: Npc, killerId: string | null, now: number) {
  const def = n.def;
  const world = sys.world;
  const maxHp = n.state.maxHp;
  const killer = killerId ? world.playerById(killerId) ?? null : null;
  const xpTo: PlayerActor[] = [];
  let top: PlayerActor | null = null;
  let topAmt = -1;
  // Credit is HP actually removed per account (overkill can't outrank earlier damage).
  for (const e of n.damage.values()) {
    const p = actorOf(sys, e.userId, e.sid);
    if (!p || p.dead) continue;
    if (e.amount > topAmt) {
      topAmt = e.amount;
      top = p;
    }
    if (e.amount >= NPC_RULES.xpShare * maxHp || (killer && killer.identity.userId === e.userId)) xpTo.push(p);
  }
  if (killer && !killer.dead && !xpTo.includes(killer)) xpTo.push(killer);
  const key = n.point ? `p${n.point.id}` : n.summoner ? `s${n.summoner}` : n.spawned ? (n.spawned.reason === "egg" ? `e${n.spawned.key}` : "stage") : `x${n.id}`;
  const gains = new Map<string, { p: PlayerActor; xp: number; coins: number }>();
  // XP, coins, drops, chest and saves land together; pile events go out after the commit (D26).
  const events: (() => void)[] = [];
  world.withTx(() => {
    for (const p of xpTo) {
      const xp = killXp(def.tier, n.level, p.char.level, repeatDecay(sys, p.identity.userId, key, now));
      if (xp > 0) world.grantXp(p, xp);
      gains.set(p.id, { p, xp, coins: 0 });
    }
    if (top) {
      const coins = npcCoins(def, n.level);
      if (coins > 0) {
        top.char.coins += coins;
        top.youDirty = true;
      }
      const g = gains.get(top.id) ?? { p: top, xp: 0, coins: 0 };
      g.coins = coins;
      gains.set(top.id, g);
      const items = rollDrops(sys, n, top);
      if (items.length) world.createPile(top, items, 0, n.pos, events);
    }
    if (n.point?.chest && n.point.chestKey === n.member) {
      const owner = top ?? killer;
      if (owner) openChest(sys, n.point.chest, owner, n.level, n.point.pos, Math.random, events);
    }
    for (const g of gains.values()) world.save(g.p);
  });
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
}

/** Camp chest (content §1.4): opens when the camp elite dies; a pile at the camp centre. */
export function openChest(sys: NpcSystem, chest: CampChest, owner: PlayerActor, level: number, at: V3, rng: Rng = Math.random, deferred?: (() => void)[]) {
  const planet: PlanetId = sys.planet ?? "arcadia";
  const items: InvItem[] = [];
  for (let i = 0; i < chest.weapons; i++) items.push(randomWeapon(level, rng));
  if (chest.tonics > 0) items.push({ id: PLANET_TONIC[planet].id, tier: 1, qty: chest.tonics });
  if (chest.cosmetic && rng() < chest.cosmetic.chance) items.push({ id: chest.cosmetic.id, tier: 1, qty: 1 });
  sys.world.createPile(owner, items, chest.coins, at, deferred);
  const announce = () => sys.sendNear(at, 80, "npcChest", { x: at[0], y: at[1], z: at[2], coins: chest.coins, items: items.length });
  if (deferred) deferred.push(announce);
  else announce();
}

/** Personal boss loot for one eligible player: coins, XP, items into the inventory, overflow at their feet. */
export function bossLoot(sys: NpcSystem, def: BossDef, p: PlayerActor, rng: Rng = Math.random): { xp: number; coins: number; items: InvItem[] } {
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
  // Coins, XP, items and the overflow pile commit together; pile events go out after (D26).
  const events: (() => void)[] = [];
  sys.world.withTx(() => {
    p.char.coins += def.loot.coins;
    p.youDirty = true;
    sys.world.grantXp(p, def.loot.xp);
    const leftovers: InvItem[] = [];
    for (const it of items) if (!sys.world.giveItem(p, it)) leftovers.push(it);
    if (leftovers.length) sys.world.createPile(p, leftovers, 0, actorPos(p), events);
    sys.world.save(p);
  });
  for (const e of events) e();
  return { xp: def.loot.xp, coins: def.loot.coins, items };
}
