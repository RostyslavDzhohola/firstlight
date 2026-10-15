// J3 (HANDOFF 6i; items 3 and 6c "no creeps outside", "let's see the creeps"): on each combat planet a
// new arrival sees a hostile creep within ~20 s, looking around and then following the mission
// pointer (or, without one, walking out of the arrival area); and a hostile can be killed for XP.

import { NPC_DEFS } from "@firstlight/shared/content/npcs";
import { expect, test } from "./fixtures.ts";
import { COMBAT_PLANETS, wrap180, type Npc, type Player, type ServerNpc, type Snap, type Target } from "./player.ts";

const HOSTILE = new Set(NPC_DEFS.filter((d) => d.temper === "hostile").map((d) => d.id));
const CREATURE = new Set(NPC_DEFS.filter((d) => d.family !== "egg").map((d) => d.id));
/**
 * "In view": drawn by the client, inside the picture and at least 12 px tall at 720p (an icon's size:
 * a 0.9 m Hopbit up to ~40 m, a 1.8 m Bonewalker up to ~80 m). The camera's vertical field is 75°.
 */
const MIN_PX = 12;
const apparentPx = (n: Npc) => ((n.height ?? 1) / Math.max(1, n.dist) / ((75 * Math.PI) / 180)) * 720;
const visibleHostile = (s: Snap): Npc | null => s.npcs?.find((n) => n.hostile && !n.dead && n.drawn && n.onScreen && apparentPx(n) >= MIN_PX) ?? null;
const visibleCreature = (s: Snap): Npc | null => s.npcs?.find((n) => !n.dead && n.drawn && n.onScreen && apparentPx(n) >= MIN_PX && CREATURE.has(n.kind)) ?? null;

/**
 * Take the first mission from the planet's guide by the pad (walk up, E, Accept), as a new player
 * does. Returns false when there's no guide near.
 */
async function takeFirstMission(player: Player): Promise<boolean> {
  const s = await player.snap();
  if (!s.guide || s.guide.surface > 20) return false;
  await player.walkTo((x) => x.guide ?? null, (x) => (x.guide?.surface ?? 99) < 2.2, { timeoutMs: 15_000, sprint: false });
  await player.face((x) => x.guide?.bearing ?? null, 10);
  await player.tap("KeyE");
  const accept = player.page.locator(".fl-overlay .fl-panel").getByRole("button", { name: /^Accept$/ }).first();
  if (!(await accept.isVisible({ timeout: 5000 }).catch(() => false))) {
    await player.note("guide", "no Accept button (panel didn't open?)");
    return false;
  }
  await player.shot("guide");
  await accept.click();
  await player.page.waitForTimeout(600);
  await player.page.keyboard.press("Escape");
  await player.lock();
  return true;
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

/**
 * Look around from the arrival pad; then take the guide's first mission and follow its pointer (the
 * zones lane's world callout, `[data-e2e="mission-pointer"]`), for up to `budgetMs`; without a pointer,
 * walk toward the nearest creature the client has. Steps round the portal home.
 */
async function lookForCreeps(player: Player, budgetMs: number) {
  const t0 = Date.now();
  const found = async (how: string, extra: Record<string, unknown> = {}) => {
    const s = await player.snap();
    const h = visibleHostile(s);
    return h ? { hostile: h, how, afterMs: Date.now() - t0, ...extra } : null;
  };
  for (let i = 0; i < 12; i++) {
    const f = await found("looking around the arrival pad");
    if (f) return f;
    await player.turn(30);
  }
  const g0 = Date.now();
  const took = (await player.snap()).mission?.shown ? false : await takeFirstMission(player);
  const guideMs = Date.now() - g0;
  const pointer = player.page.locator('[data-e2e="mission-pointer"]');
  const f0 = Date.now();
  let pointerSeen = false;
  let step = 0;
  while (Date.now() - f0 < budgetMs) {
    const s = await player.snap();
    if (s.mission?.shown || (await pointer.isVisible().catch(() => false))) pointerSeen = true;
    const how = pointerSeen ? "following the mission pointer" : "walking toward the creatures in sight (no mission pointer)";
    const f = await found(how, { tookMission: took, guideMs, followMs: Date.now() - f0 });
    if (f) return f;
    const to = s.mission?.bearing !== undefined && s.mission.at ? (s.mission as unknown as { bearing: number; surface: number }) : s.npcs?.find((n) => !n.dead && CREATURE.has(n.kind)) ?? null;
    // Toward it, round the outpost's buildings and clear of the portal (Player.steer).
    const go = await player.steer(to ? to.bearing : 0, 4, s);
    if (Math.abs(go.bearing) > 8) await player.turn(go.bearing);
    await player.hold(["ShiftLeft", "KeyW"], Math.max(300, Math.min(900, (go.clear / 9) * 1000)));
    if (++step % 2 === 0) {
      for (const d of [-40, 80, -40]) {
        await player.turn(d);
        const f2 = await found(how, { tookMission: took, guideMs, followMs: Date.now() - f0 });
        if (f2) return f2;
      }
    }
  }
  return { hostile: null, how: pointerSeen ? "followed the mission pointer" : "no mission pointer; walked toward creatures", afterMs: Date.now() - t0, tookMission: took, guideMs, followMs: Date.now() - f0 };
}

test.describe("J3 creeps", () => {
  COMBAT_PLANETS.forEach((planet, i) => {
    test(`J3.${i + 1} · items 3, 6c · ${planet}: a hostile creep is in view within 20 s of arriving and following the mission pointer`, { tag: ["@J3", `@J3.${i + 1}`, "@item-3", "@item-6c"] }, async ({ player }) => {
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
      await player.note("search", { ...r, hostile: r.hostile ? `${r.hostile.kind} L${r.hostile.level} at ${r.hostile.dist} m` : null });
      await player.shot(r.hostile ? "creep-in-view" : "no-creep");
      expect(r.hostile, `a hostile creep on screen (≥ ${MIN_PX} px tall) within 20 s of looking around and following the pointer (${r.how}; nearest hostile from the pad: ${JSON.stringify(fromPad.hostile)})`).not.toBeNull();
    });
  });

  test("J3.4 · item 3 · Arcadia: a new player (Hexwick) kills a hostile and gets XP", { tag: ["@J3", "@J3.4", "@item-3"] }, async ({ player }) => {
    await player.joinAsDevAdmin({ starter: "Hexwick", body: "arcadia" });
    await player.waitInWorld(90_000, "arcadia");
    await player.lock();
    const start = await player.snap();
    const xp0 = start.you?.xp ?? 0;
    const level0 = start.you?.level ?? 1;

    // A weak hostile near the arrival, with the fewest friends around it (a level-1 player takes one
    // at a time). Without one (no creeps near the arrival yet, item 6c) the admin NPC command spawns a
    // single Hopbit outside the ring, so the kill → XP path is still tested every run.
    const list = (await player.npcList()).filter((n) => HOSTILE.has(n.def) && n.hp > 0 && !n.boss);
    const friends = (n: ServerNpc) => list.filter((m) => m !== n && Math.hypot(m.x - n.x, m.y - n.y, m.z - n.z) < 14).length;
    const ranked = (await Promise.all(list.map(async (n) => ({ n, pack: friends(n), t: await player.targetOf([n.x, n.y, n.z]) })))).filter(
      (x): x is { n: ServerNpc; pack: number; t: Target } => !!x.t,
    );
    ranked.sort((a, b) => a.n.level - b.n.level || a.pack - b.pack || a.t.surface - b.t.surface);
    const near = ranked.find((x) => x.t.surface <= 60 && x.pack <= 2 && x.n.level <= 2);
    /** The fallback: out of the ring, somewhere of our own, one Hopbit spawned in the open in front of us. */
    const spawnOne = async (why: string) => {
      await player.walkOutOfRing();
      // Journeys run in parallel in the same planet copy: go somewhere of our own first, so another
      // test's player isn't in the line of fire (the bolts hit players outside safe zones too).
      let want = Math.random() * 120 - 60;
      for (let i = 0; i < 4; i++) {
        const go = await player.steer(want, 6);
        if (Math.abs(go.bearing) > 8) await player.turn(go.bearing);
        want = 0;
        await player.hold(["ShiftLeft", "KeyW"], 700);
        const w = await player.snap();
        if (w.player?.swimming || w.zone?.server === "safe") want = 150;
      }
      // Spawn it in the open: a clear line ahead (no outpost wall between us and it), then step back.
      const open = await player.steer(0, 10);
      if (Math.abs(open.bearing) > 8) await player.turn(open.bearing);
      await player.npc("spawn", { kind: "hopbit", level: 1, roam: 0 });
      await player.hold(["KeyS"], 900); // back off from it, facing it
      await player.note("placement", `admin npc spawn: one Hopbit outside the ring (${why})`);
    };
    if (near) await player.note("target", { def: near.n.def, level: near.n.level, pack: near.pack + 1, fromUsM: near.t.surface });
    else await spawnOne(`nearest natural hostile ${ranked[0] ? `${ranked[0].n.def} ${ranked[0].t.surface} m` : "none"}`);

    // Fight: the nearest live hostile within 60 m, aimed at through the camera like a player, healed by
    // the admin command when low (the test is about the kill paying XP, not about surviving a pack).
    const until = Date.now() + 90_000;
    let shots = 0;
    let spawned = !near;
    let lastFoeAt = Date.now();
    while (Date.now() < until) {
      const s = await player.snap();
      if ((s.you?.xp ?? 0) > xp0 || (s.you?.level ?? 1) > level0 || s.player?.dead) break;
      if ((s.player?.hp ?? 100) < 80) await player.admin("heal");
      // No casting while swimming (the server says "swimming"): back out of the lake first.
      if (s.player?.swimming) {
        await player.turn(180);
        await player.hold(["KeyW"], 1000);
        continue;
      }
      // Weapons are holstered in safe zones: fight from outside the ring.
      if (s.zone?.server === "safe") {
        await player.walkOutOfRing();
        continue;
      }
      const foe = s.npcs?.find((n) => n.hostile && !n.dead && n.dist < 60);
      if (!foe) {
        // The natural pack went (another journey in this copy took it, or it wandered off): spawn one.
        if (!spawned && Date.now() - lastFoeAt > 8000) {
          spawned = true;
          await spawnOne("the natural hostile near the arrival was gone");
        }
        await player.page.waitForTimeout(300);
        continue;
      }
      lastFoeAt = Date.now();
      // Walls stop bolts (D43): only shoot along a clear line; otherwise go round toward it.
      const line = (await player.clearance([foe.bearing], foe.surface))?.[0]?.clear ?? foe.surface;
      const blocked = line < foe.surface - 1.5;
      // Hostiles come to us (Hopbits leap in): only walk when it's far or behind a building, one step at a time.
      if (foe.dist > 30 || blocked) {
        const go = await player.steer(foe.bearing, Math.min(4, foe.surface), s);
        if (Math.abs(go.bearing) > 8) await player.turn(go.bearing);
        await player.hold(["KeyW"], 500);
        continue;
      }
      // Point blank the bolt (it leaves from the hand) flies past a Hopbit at our feet: back off first.
      if (foe.dist < 5) {
        await player.turn(foe.bearing);
        await player.hold(["KeyS"], 500);
        continue;
      }
      // Never through another player (journeys share the copy; a bolt would hit them, PvP): side-step.
      const inLine = s.players?.find((p) => !p.dead && p.surface < foe.surface && Math.abs(p.surface * Math.sin((wrap180(p.bearing - foe.bearing) * Math.PI) / 180)) < 2 && Math.abs(wrap180(p.bearing - foe.bearing)) < 90);
      if (inLine) {
        await player.hold([wrap180(inLine.bearing - foe.bearing) > 0 ? "KeyA" : "KeyD"], 600);
        continue;
      }
      await player.aim((x) => x.npcs?.find((n) => n.id === foe.id && !n.dead) ?? null, 3);
      await player.attack();
      shots++;
      await player.page.waitForTimeout(200);
    }
    const end = await player.snap();
    const ev = await player.events();
    const hits = ev.filter((e) => e.kind === "in" && e.type === "hit" && e.mine === true && !e.targetPlayer).length;
    const pvp = ev.filter((e) => e.kind === "in" && e.type === "hit" && e.mine === true && e.targetPlayer).length;
    await player.note("fight", { shots, hits, playerHits: pvp, xp: [xp0, end.you?.xp], level: [level0, end.you?.level], dead: end.player?.dead });
    await player.shot("after-fight");
    expect(end.player?.dead, "we didn't die").toBeFalsy();
    expect((end.you?.xp ?? 0) > xp0 || (end.you?.level ?? 1) > level0, "killing a hostile paid XP").toBe(true);
  });
});
