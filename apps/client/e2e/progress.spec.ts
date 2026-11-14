// Evidence clips for #81 (the build tree), filmed stop-motion (a step, then a frame) so a loaded
// machine slows the clip instead of breaking it. Frames are numbered JPEGs in $PROGRESS_OUT/<clip>/;
// ffmpeg turns them into a clip afterwards. Skipped unless PROGRESS_OUT is set:
//   PROGRESS_OUT=/tmp/progress pnpm exec playwright test -c e2e/playwright.config.ts --project webgl --grep @progress
//
// "levels": Brother Ash from level 1 to 3 (the banner and toast name the key), a fight against a
// level-3 Linewyrm with nothing spent, then U opens the build panel, Hardy (Body) and Keen
// Edge (Blade) are taken, and the same fight again: a longer health bar and harder hits.
// "respec": level 6 at the arcadia pad (a safe zone), three nodes taken, then Respec for coins.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures.ts";
import type { Player } from "./player.ts";

const OUT = process.env.PROGRESS_OUT ?? "";

function film(page: Player["page"], dir: string) {
  mkdirSync(dir, { recursive: true });
  let n = 0;
  return async (times = 1) => {
    for (let i = 0; i < times; i++) {
      await page.screenshot({ path: path.join(dir, `${String(n++).padStart(4, "0")}.jpg`), type: "jpeg", quality: 82 }).catch(() => {});
    }
    return n;
  };
}

/** Swing at the nearest hostile `swings` times, a frame after each; the admin heals between. */
async function fight(player: Player, shot: (n?: number) => Promise<number>, swings: number) {
  for (let i = 0; i < swings; i++) {
    const s = await player.snap();
    const foe = s.npcs?.filter((n) => n.hostile && !n.dead).sort((a, b) => a.dist - b.dist)[0];
    if (!foe || s.player?.dead) break;
    await player.admin("heal"); // stop-motion is slow: the creature gets many turns between frames
    if (foe.dist > 2.6) {
      await player.face(() => foe.bearing, 8);
      await player.hold(["KeyW"], Math.min(600, (foe.dist - 2) * 160));
    }
    await player.aim((x) => x.npcs?.find((n) => n.id === foe.id) ?? null, 2);
    await player.attack();
    await player.page.waitForTimeout(260);
    await shot();
    await player.page.waitForTimeout(220);
    await shot();
  }
}

test("progress · level 1 to 3, two branches, the same fight before and after", { tag: ["@progress"] }, async ({ player, page }) => {
  test.skip(!OUT, "set PROGRESS_OUT to film the build tree (#81)");
  test.setTimeout(25 * 60_000);
  const shot = film(page, path.join(OUT, "levels"));
  await player.joinAsDevAdmin({ starter: "Brother Ash", body: "arcadia", extra: { tier: "medium", time: "0.42" } });
  await player.waitInWorld(240_000, "arcadia");
  await player.lock();
  await player.walkOutOfRing(60_000);
  await player.admin("unprotect");
  await page.waitForTimeout(1200);
  await shot(4);
  // Level 2, then 3: the banner says "+1 build point (U or the menu)"; a toast names the key.
  for (const level of [2, 3]) {
    await player.admin("level", { level });
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(350);
      await shot();
    }
  }
  // The fight with nothing spent.
  await player.npc("spawn", { kind: "linewyrm", level: 3, roam: 0 });
  await page.waitForTimeout(900);
  await fight(player, shot, 6);
  await player.npc("clear", {}).catch(() => {});
  // U opens the panel (the pointer is freed by the panel, not needed before).
  await player.tap("KeyU");
  await page.waitForSelector('[data-e2e="tree-panel"]', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shot(8);
  for (const node of ["body_hardy", "blade_edge"]) {
    await page.click(`[data-e2e="tree-node-${node}"]`);
    await page.waitForFunction((id) => document.querySelector(`[data-e2e="tree-node-${id}"]`)?.classList.contains("is-taken"), node, { timeout: 10_000 });
    await page.waitForTimeout(300);
    await shot(7);
  }
  await expect(page.locator('[data-e2e="tree-points"]')).toHaveText("0 points to spend");
  await player.escape();
  await player.lock();
  await page.waitForTimeout(600);
  await shot(4);
  // The same fight again: Hardy's longer health bar, Keen Edge's harder hits.
  await player.npc("spawn", { kind: "linewyrm", level: 3, roam: 0 });
  await page.waitForTimeout(900);
  await fight(player, shot, 6);
  await shot(4);
  console.log(`[progress] levels: ${await shot(0)} frames`);
});

test("progress · respec in a safe zone, for coins", { tag: ["@progress"] }, async ({ player, page }) => {
  test.skip(!OUT, "set PROGRESS_OUT to film the build tree (#81)");
  test.setTimeout(15 * 60_000);
  const shot = film(page, path.join(OUT, "respec"));
  await player.joinAsDevAdmin({ starter: "Kappa", body: "arcadia", extra: { tier: "medium", time: "0.42" } });
  await player.waitInWorld(240_000, "arcadia");
  await player.admin("level", { level: 6 });
  await player.admin("coins", { amount: 120 });
  await page.waitForTimeout(1500);
  await player.tap("KeyU");
  await page.waitForSelector('[data-e2e="tree-panel"]', { timeout: 10_000 });
  await shot(6);
  for (const node of ["travel_stride", "travel_far_step", "magic_attuned", "body_hardy"]) {
    await page.click(`[data-e2e="tree-node-${node}"]`);
    await page.waitForFunction((id) => document.querySelector(`[data-e2e="tree-node-${id}"]`)?.classList.contains("is-taken"), node, { timeout: 10_000 });
    await page.waitForTimeout(250);
    await shot(4);
  }
  await shot(4);
  // Respec: the first press asks, the second does it (in the pad's ring, a safe zone).
  await page.click('[data-e2e="tree-respec"]');
  await page.waitForTimeout(300);
  await shot(8);
  await page.click('[data-e2e="tree-respec"]');
  await expect(page.locator('[data-e2e="tree-points"]')).toHaveText("5 points to spend", { timeout: 10_000 });
  await expect(page.locator('[data-e2e="tree-coins"]')).toHaveText(`${120 - 5 * 10} ◎`);
  await page.waitForTimeout(400);
  await shot(10);
  console.log(`[progress] respec: ${await shot(0)} frames`);
});

/** The build panel's state as the page shows it. */
async function panel(page: Player["page"]) {
  return page.evaluate(() => ({
    points: document.querySelector('[data-e2e="tree-points"]')?.textContent ?? null,
    taken: [...document.querySelectorAll('[data-e2e^="tree-node-"].is-taken')].map((e) => (e as HTMLElement).dataset.e2e!.slice(10)),
  }));
}

// "pass" (review fixes, 2026-11-14): one new player end to end. The pick screen with nothing stored
// (the Traveller first and picked, #80); in the world as it; level 3; a fight with nothing spent; Hardy
// (Body) and Keen Edge (Blade); the same fight; back to the pad ring and a respec for coins; Hardy and
// Keen Edge again; out of the ring, a death; Rise again: level 1, no points, no nodes.
test("progress · a new Traveller: level 3, two branches, a fight before and after, respec, death", { tag: ["@progress", "@progress-pass"] }, async ({ player, page }) => {
  test.skip(!OUT, "set PROGRESS_OUT to film the build tree (#81)");
  test.setTimeout(30 * 60_000);
  const shot = film(page, path.join(OUT, "pass"));
  const id = `e2e${Math.random().toString(16).slice(2, 12)}`;
  // A dev admin guest with nothing else stored: a new player as far as the pick screen knows.
  await page.addInitScript(([id, name]) => {
    if (!localStorage.getItem("firstlight.devGuest")) localStorage.setItem("firstlight.devGuest", `${id}:${name}:admin`);
  }, [id, `E2E_${id.slice(3, 9)}`] as const);
  await player.open({ devguest: true, tier: "medium" });
  await player.playButton().click();
  const pick = page.locator(".fl-charpick");
  await expect(pick).toBeVisible({ timeout: 45_000 });
  await expect(pick.locator(".fl-starter").first()).toContainText("Traveller");
  await expect(pick.locator(".fl-starter.is-on")).toContainText("Traveller");
  await page.waitForTimeout(1500);
  await shot(16);
  // Into Arcadia with nothing stored: the client's fallback is the Traveller too.
  await player.open({ devguest: true, autoplay: true, tier: "medium", body: "arcadia", time: "0.42" });
  const first = await player.waitInWorld(240_000, "arcadia");
  expect(first.player?.starter, "the Traveller (#80): nothing was stored").toBe(5);
  await player.lock();
  await player.walkOutOfRing(60_000);
  await player.admin("unprotect");
  await page.waitForTimeout(1200);
  await shot(4);
  for (const level of [2, 3]) {
    await player.admin("level", { level });
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(350);
      await shot();
    }
  }
  await player.npc("spawn", { kind: "linewyrm", level: 3, roam: 0 });
  await page.waitForTimeout(900);
  await fight(player, shot, 5);
  await player.npc("clear", {}).catch(() => {});
  const spendTwo = async () => {
    await player.tap("KeyU");
    await page.waitForSelector('[data-e2e="tree-panel"]', { timeout: 10_000 });
    await page.waitForTimeout(400);
    await shot(6);
    for (const node of ["body_hardy", "blade_edge"]) {
      await page.click(`[data-e2e="tree-node-${node}"]`);
      await page.waitForFunction((id) => document.querySelector(`[data-e2e="tree-node-${id}"]`)?.classList.contains("is-taken"), node, { timeout: 10_000 });
      await page.waitForTimeout(300);
      await shot(5);
    }
    await expect(page.locator('[data-e2e="tree-points"]')).toHaveText("0 points to spend");
  };
  await spendTwo();
  await player.escape();
  await player.lock();
  await page.waitForTimeout(600);
  await shot(3);
  await player.npc("spawn", { kind: "linewyrm", level: 3, roam: 0 });
  await page.waitForTimeout(900);
  await fight(player, shot, 5);
  await player.npc("clear", {}).catch(() => {});
  // Back into the pad's ring (a safe zone) for the respec.
  await player.walkTo((s) => s.pad ?? null, (s) => s.zone?.server === "safe", { timeoutMs: 60_000 });
  await player.admin("coins", { amount: 40 });
  await page.waitForTimeout(800);
  await player.tap("KeyU");
  await page.waitForSelector('[data-e2e="tree-panel"]', { timeout: 10_000 });
  await shot(5);
  await page.click('[data-e2e="tree-respec"]');
  await page.waitForTimeout(300);
  await shot(6);
  await page.click('[data-e2e="tree-respec"]');
  await expect(page.locator('[data-e2e="tree-points"]')).toHaveText("2 points to spend", { timeout: 10_000 });
  await page.waitForTimeout(400);
  await shot(8);
  await player.escape();
  await spendTwo();
  await player.escape();
  await player.lock();
  // Out of the ring, and a death: the points go with the level.
  await player.walkOutOfRing(60_000);
  await player.admin("unprotect");
  await shot(3);
  await player.admin("damage", { amount: 5000 });
  await player.until((s) => !!s.player?.dead, "dead", 20_000);
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(400);
    await shot();
  }
  for (let i = 0; i < 6; i++) {
    const s = await player.snap();
    if (!s.player?.dead && s.stage === "playing" && !s.loading) break;
    const b = page.getByRole("button", { name: /^rise (again|in)/i }).filter({ visible: true }).first();
    if (await b.count()) {
      await b.click();
      await page.waitForTimeout(700);
      await shot(3);
    }
    await page.waitForTimeout(1200);
  }
  const reborn = await player.waitInWorld(240_000);
  expect(reborn.player?.level).toBe(1);
  await page.waitForTimeout(1500);
  await shot(4);
  await player.tap("KeyU");
  await page.waitForSelector('[data-e2e="tree-panel"]', { timeout: 10_000 });
  await page.waitForTimeout(500);
  const after = await panel(page);
  expect(after.taken).toEqual([]);
  expect(after.points).toBe("0 points to spend");
  await shot(12);
  console.log(`[progress] pass: ${await shot(0)} frames; after death ${JSON.stringify(after)}`);
});
