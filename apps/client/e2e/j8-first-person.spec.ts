// J8 (D-view-1, review finding 4 of the first-person lane): V puts the camera in first person and the
// blend between the views finishes; a fight is won in first person with a melee weapon (the swing
// goes where the crosshair is: the server confirms the hit and pays the kill's XP); V brings the
// camera back out.

import { expect, test } from "./fixtures.ts";
import type { Player, Snap } from "./player.ts";
import { NPC_DEFS } from "@firstlight/shared/content/npcs";

const HOSTILE = new Set(NPC_DEFS.filter((d) => d.temper === "hostile").map((d) => d.id));

/** V, and the camera's way to `view`: the choice, what the camera does, and the blend at its end. */
async function toggleTo(player: Player, view: "first" | "third"): Promise<{ ms: number; s: Snap }> {
  const t0 = Date.now();
  await player.tap("KeyV");
  const s = await player.until(
    (x) => x.player?.view === view && x.player.viewNow === view && x.player.viewBlend === (view === "first" ? 1 : 0),
    `V: the camera all the way in ${view} person`,
    5000,
  );
  return { ms: Date.now() - t0, s };
}

test.describe("J8 first person", () => {
  test("J8.1 · D-view-1 · Arcadia: V into first person, a melee fight won there (server-confirmed hits, XP), V back out", { tag: ["@J8", "@J8.1"] }, async ({ player }) => {
    await player.joinAsDevAdmin({ starter: "Brother Ash", body: "arcadia" });
    await player.waitInWorld(90_000, "arcadia");
    await player.lock();
    const start = await player.snap();
    expect(start.player?.viewNow, "a new player starts in third person").toBe("third");
    expect(start.weapon?.delivery, "Brother Ash holds the Sunbrand (melee)").toBe("melee");

    const into = await toggleTo(player, "first");
    await player.note("into first person", { ms: into.ms });
    await player.shot("first-person");

    // Out of the ring, a level-1 Hopbit spawned at our feet; we step back from it, facing it.
    await player.walkOutOfRing();
    await player.readyToFight();
    await player.admin("level", { level: 3 }); // a levelled character: the fight is about the swing, not survival
    const xp0 = (await player.snap()).you?.xp ?? 0;
    await player.npc("spawn", { kind: "hopbit", level: 1, roam: 0 });
    await player.hold(["KeyS"], 700);

    const t0 = await player.now();
    const until = Date.now() + 90_000;
    let swings = 0;
    let offView = 0;
    let respawned = false;
    let lastFoeAt = Date.now();
    const reach = (start.weapon?.range ?? 2.4) - 0.4;
    while (Date.now() < until) {
      const s = await player.snap();
      if ((s.you?.xp ?? 0) > xp0 || s.player?.dead) break;
      if (s.player?.viewNow !== "first") offView++;
      // Healed early: on a loaded machine a snapshot can take seconds, and a Hopbit doesn't wait.
      if ((s.player?.hp ?? 1) < 0.75 * (s.player?.maxHp ?? s.player?.hp ?? 1)) await player.admin("heal");
      if (s.zone?.server === "safe") {
        await player.walkOutOfRing();
        continue;
      }
      const foe = s.npcs?.filter((n) => n.hostile && !n.dead && n.dist < 40 && HOSTILE.has(n.kind)).sort((a, b) => a.dist - b.dist)[0];
      if (!foe) {
        if (!respawned && Date.now() - lastFoeAt > 8000) {
          respawned = true;
          await player.npc("spawn", { kind: "hopbit", level: 1, roam: 0 });
          await player.hold(["KeyS"], 700);
        }
        await player.page.waitForTimeout(250);
        continue;
      }
      lastFoeAt = Date.now();
      // Turn onto it and swing at once: in first person the swing follows the camera on the same frame.
      await player.aimOnce(foe);
      if (foe.surface > reach) {
        await player.hold(["KeyW"], Math.min(500, Math.max(120, (foe.surface - reach) * 180)));
        continue;
      }
      await player.attack();
      swings++;
      await player.page.waitForTimeout(250);
    }
    const end = await player.snap();
    const ev = await player.events(t0);
    const hits = ev.filter((e) => e.kind === "in" && e.type === "hit" && e.mine === true && !e.targetPlayer).length;
    const sent = ev.filter((e) => e.kind === "out" && e.type === "melee").length;
    await player.note("fight", { swings, sent, hits, offView, xp: [xp0, end.you?.xp], dead: end.player?.dead, view: end.player?.viewNow });
    await player.shot("after-fight");
    expect(end.player?.dead, "we didn't die").toBeFalsy();
    expect(offView, "the camera stayed in first person through the fight").toBe(0);
    expect(hits, "the server confirmed our swings' hits").toBeGreaterThan(0);
    expect((end.you?.xp ?? 0) > xp0, "the kill paid XP").toBe(true);
    expect(end.player?.viewNow).toBe("first");

    const out = await toggleTo(player, "third");
    await player.note("back to third person", { ms: out.ms });
    await player.shot("third-person");
  });
});
