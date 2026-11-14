// Wild sites (content/wildSites.ts, planet/wildSites.ts) on the real in-process server: the site's
// camp stands round it, the first visit this life pays its discovery XP once, and the guardian's
// death drops the chest's loot on the chest.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { siteDiscoveryXp, WILD_SITE_BY_ID } from "@firstlight/shared/content/wildSites";
import { prefabPoint, wildSitePlacements, type WildSitePlacement } from "@firstlight/shared/planet/wildSites";
import { structureCollider } from "@firstlight/shared/planet/sites";
import { PLAYER_BODY } from "@firstlight/shared/planet/collide";
import { RULES } from "../src/world/BodyRoom.ts";
import { newCharacter } from "@firstlight/shared/content/character";
import { characterRepo } from "../src/world/characters.ts";
import { joinAs } from "./helpers.ts";
import { npcSystemOf, NPC_TUNING, resetTuning } from "../src/world/npc/index.ts";
import { pileStore } from "../src/world/piles.ts";
import { rollChest } from "../src/world/npc/rewards.ts";
import { safeLeave, startServer, waitFor } from "./helpers.ts";
import { bot, ground, harness, me, serverRoom, sleep, terrain, tpAndWait } from "./quest-helpers.ts";

beforeEach(async () => {
  harness.game = await startServer();
});
afterEach(async () => {
  resetTuning();
  for (const r of harness.rooms.splice(0)) await safeLeave(r);
  await harness.game!.close();
});

/** Ground under prefab point (x, z) of a placed site. */
function siteGround(body: "arcadia" | "meridian", p: WildSitePlacement, x: number, z: number): [number, number, number] {
  const q = prefabPoint(p.frame, x, z, 0);
  const l = Math.hypot(q[0], q[1], q[2]);
  return ground(body, [q[0] / l, q[1] / l, q[2] / l]);
}
const dist = (a: { x: number; y: number; z: number }, b: readonly number[]) => Math.hypot(a.x - b[0]!, a.y - b[1]!, a.z - b[2]!);

const watch = () => wildSitePlacements(terrain("arcadia")).find((p) => p.site.id === "bellwether_watch")!;

describe("wild sites", () => {
  it("pays the discovery XP once per life and lists the site in you.sites", async () => {
    const b = await bot("site_finder", "arcadia");
    const xp0 = b.you.xp;
    const ws = watch();
    await tpAndWait(b, ground("arcadia", ws.guardDirs[0]!));
    await waitFor(() => (b.you.sites ?? []).includes("bellwether_watch"));
    const want = siteDiscoveryXp(WILD_SITE_BY_ID.get("bellwether_watch")!);
    await waitFor(() => b.you.xp >= xp0 + want);
    expect(b.toasts.filter((t) => t.startsWith("Site discovered: Bellwether Watch"))).toHaveLength(1);
    // Away and back: no second payment.
    await tpAndWait(b, ground("arcadia", wildSitePlacements(terrain("arcadia"))[1]!.guardDirs[0]!));
    await waitFor(() => (b.you.sites ?? []).length === 2);
    const xp1 = b.you.xp;
    await tpAndWait(b, ground("arcadia", ws.guardDirs[1]!));
    await sleep(600);
    expect(b.toasts.filter((t) => t.startsWith("Site discovered: Bellwether Watch"))).toHaveLength(1);
    expect(b.you.xp).toBe(xp1);
  });

  it("stands its camp round the site and drops the chest on the chest when the guardian falls", async () => {
    NPC_TUNING.ambient = true;
    const b = await bot("site_raider", "arcadia");
    const room = serverRoom(b);
    const sys = npcSystemOf(room)!;
    const site = WILD_SITE_BY_ID.get("bellwether_watch")!;
    const ws = watch();
    // Creatures spawn round players: stand 60 m off, out of their sight (a fight would make them evade).
    const off = prefabPoint(ws.frame, 0, 60, 0);
    const l = Math.hypot(off[0], off[1], off[2]);
    await tpAndWait(b, ground("arcadia", [off[0] / l, off[1] / l, off[2] / l]));
    const campOf = () => [...sys.npcs.values()].filter((n) => n.point?.area === "bellwether_watch");
    const size = 1 + site.pack.reduce((s, m) => s + m.count, 0);
    await waitFor(() => campOf().length === size, 20_000);
    const guardian = campOf().find((n) => n.member === 0)!;
    expect(guardian.def.id).toBe(site.guardian.kind);
    const before = pileStore.current.list("arcadia").length;
    await sleep(2500); // creatures rise out of the ground before they can be hurt
    b.send("admin", { cmd: "unprotect" }); // a protected attacker can't hurt
    b.send("npc", { cmd: "hurt", id: guardian.id, amount: 100_000, as: b.id });
    await waitFor(() => guardian.dead || guardian.state.hp <= 0, 6000);
    await waitFor(() => pileStore.current.list("arcadia").length > before, 10_000);
    const pile = pileStore.current.list("arcadia").at(-1)!;
    expect(pile.coins).toBe(site.chest.coins);
    const chest = ground("arcadia", ws.chestDir);
    expect(Math.hypot(pile.x - chest[0], pile.y - chest[1], pile.z - chest[2])).toBeLessThan(1.5);
    void me;
  }, 40_000);

  // Review 2026-11-13 world sites, finding 2: piles are saved by position, and the sites added solids
  // where piles may already lie. One under the Long Haul wreck's hull (prefab x 9.75) is 3.8 m inside
  // it, the nearest clear ground beyond pickup reach.
  it("moves a pile left under the wreck's hull before the deploy to clear ground within reach, and saves the move", async () => {
    const hull = wildSitePlacements(terrain("meridian")).find((p) => p.site.id === "long_haul_wreck")!;
    const at = siteGround("meridian", hull, 9.75, 0);
    const walls = structureCollider(terrain("meridian"));
    expect(walls.footing(at[0], at[1], at[2], PLAYER_BODY.step).inside).toBe(true);
    const old = pileStore.current.add({
      body: "meridian", x: at[0], y: at[1], z: at[2], owner: "Old Timer", ownerUserId: "u-old",
      createdAt: Date.now() - 86_400_000, items: [{ id: "carbine", tier: 1, qty: 1 }], coins: 7, kind: "death",
    }).pile;
    const b = await bot("pile_finder", "meridian");
    const saved = pileStore.current.get(old.id)!;
    expect(dist(saved, at)).toBeGreaterThan(1);
    expect(walls.isClear(saved)).toBe(true); // a player can stand on it
    expect(saved).toMatchObject({ coins: 7, kind: "death", createdAt: old.createdAt, owner: "Old Timer" });
    expect(dist(serverRoom(b).state.piles.get(old.id)!, [saved.x, saved.y, saved.z])).toBeLessThan(1e-6);
    // Walk up and take it.
    await tpAndWait(b, [saved.x, saved.y, saved.z]);
    expect(dist(me(b), [saved.x, saved.y, saved.z])).toBeLessThan(RULES.PICKUP_RANGE);
    const coins = b.you.coins;
    b.send("pickup", { pileId: old.id });
    await waitFor(() => b.you.coins === coins + 7);
    expect(pileStore.current.get(old.id)).toBeUndefined();
  }, 30_000);

  it("drops the pile of a player who falls on a lookout where a player can reach it, not inside the tower", async () => {
    const b = await bot("lookout_faller", "arcadia");
    const ws = watch();
    const room = serverRoom(b);
    const a = [...(room as any).actors.values()].find((x: any) => x.id === b.id);
    const pile = room.createPile(a, [{ id: "carbine", tier: 1, qty: 1 }], 3, ws.lookout, undefined, { kind: "death" })!;
    const walls = structureCollider(terrain("arcadia"));
    expect(walls.isClear(pile)).toBe(true);
    expect(pileStore.current.get(pile.id)).toMatchObject({ x: pile.x, y: pile.y, z: pile.z });
    // Next to the tower's foot, not across the site.
    expect(dist(pile, ground("arcadia", ws.dir))).toBeLessThan(ws.prefab.foot);
  });

  it("a character saved where the wreck's hull now stands joins on clear ground beside it", async () => {
    const hull = wildSitePlacements(terrain("meridian")).find((p) => p.site.id === "long_haul_wreck")!;
    const at = siteGround("meridian", hull, 9.75, 0);
    const c = newCharacter(0, 0);
    c.body = "meridian";
    c.pos = at;
    characterRepo.current.save("saved_in_hull", c);
    const room = await joinAs(harness.game!, "saved_in_hull", "meridian");
    harness.rooms.push(room);
    const p = () => (room.state as any).players?.get(room.sessionId);
    await waitFor(() => !!p());
    const walls = structureCollider(terrain("meridian"));
    expect(walls.isClear({ x: p().x, y: p().y, z: p().z })).toBe(true);
    expect(dist(p(), at)).toBeLessThan(9);
  });
});

describe("wild-site rare finds (lane weapons, 2026-11-13)", () => {
  it("the Lantern Shrine and the Long Haul wreck can hold their sculpted weapon, at the site's tier", () => {
    const sys = { planet: "hollowmere" } as unknown as Parameters<typeof rollChest>[0];
    const shrine = WILD_SITE_BY_ID.get("lantern_shrine")!.chest;
    const wreck = WILD_SITE_BY_ID.get("long_haul_wreck")!.chest;
    expect(shrine.rare?.id).toBe("lantern");
    expect(wreck.rare?.id).toBe("crossbow");
    // rng 0: every roll succeeds (the rare find is in); rng 0.99: none does (it isn't)
    const lucky = rollChest(sys, shrine, 9, () => 0);
    expect(lucky.items).toContainEqual({ id: "lantern", tier: 1, qty: 1 }); // L9 with a low tier roll: T1
    expect(rollChest(sys, shrine, 9, () => 0.99).items.some((i) => i.id === "lantern")).toBe(false);
    const late = rollChest({ planet: "meridian" } as unknown as Parameters<typeof rollChest>[0], wreck, 19, () => 0.5);
    expect(late.items.find((i) => i.id === "crossbow")).toBeUndefined(); // 0.5 misses a 1/6 chance
    expect(rollChest({ planet: "meridian" } as unknown as Parameters<typeof rollChest>[0], wreck, 19, () => 0).items).toContainEqual({ id: "crossbow", tier: 2, qty: 1 });
  });
});
