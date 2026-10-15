// J5 (HANDOFF 6i; items 4, 6, 6d): Esc resumes the game (a click re-locks without reopening the menu);
// no action needs an F-key; the dodge starts within ~100 ms of C; voice is hidden ("coming soon").

import { expect, test } from "./fixtures.ts";
import type { Player } from "./player.ts";

/** shared/net/schema.ts ANIM, for the notes. */
const ANIM_NAMES = ["idle", "walk", "run", "sprint", "jump", "fall", "swim", "dodge", "attack", "heavy", "block", "aim", "cast", "hit", "dead", "emote"];

const pauseMenu = (p: Player) => p.page.locator('[data-e2e="pause-menu"]');

/** A keycap label from How to play ("P", "`", "Shift") as a Playwright key. */
function keyName(k: string): string {
  if (/^[A-Z]$/i.test(k)) return `Key${k.toUpperCase()}`;
  if (/^\d$/.test(k)) return `Digit${k}`;
  return ({ "`": "Backquote", Esc: "Escape", Space: "Space", Tab: "Tab", Shift: "Shift", Ctrl: "Control", Alt: "Alt" } as Record<string, string>)[k] ?? k;
}

async function arrive(player: Player, body = "arcadia") {
  await player.joinAsDevAdmin({ starter: "Hexwick", body });
  await player.waitInWorld(90_000, body);
  await player.lock();
}

test.describe("J5 controls", () => {
  test("J5.1 · item 6d · Esc opens the menu, Esc again goes back to the game, a click looks around again", { tag: ["@J5", "@J5.1", "@item-6d"] }, async ({ player, page }) => {
    await arrive(player);
    await player.escape(); // the browser releases the pointer
    await expect(pauseMenu(player), "Esc opens the pause menu").toBeVisible();
    await player.shot("pause-menu");
    await page.keyboard.press("Escape");
    await expect(pauseMenu(player), "Esc in the menu closes it").toBeHidden();
    // Back in the game: either the pointer came straight back (allowed where the browser lets the page
    // re-lock without a click) or the "Click to look around" hint shows and one click looks around.
    const hint = page.locator('[data-e2e="click-to-look"]');
    const relocked = await player.until((s) => s.input.pointerLocked, "re-locked", 1500).then(() => true, () => false);
    await player.note("after Esc in the menu", relocked ? "pointer re-locked at once" : "hint, waiting for a click");
    if (!relocked) {
      await expect(hint, '"Click to look around" hint').toBeVisible();
      await player.shot("click-to-look");
      await page.mouse.click(640, 360);
      await player.until((s) => s.input.pointerLocked, "one click re-locks the pointer", 5000);
    }
    await expect(pauseMenu(player), "the click doesn't reopen the menu").toBeHidden();
    await expect(hint).toBeHidden();
    // And again: Esc → menu → Esc → game, a second round trip (the old menu "didn't go anywhere").
    await player.escape();
    await expect(pauseMenu(player)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(pauseMenu(player)).toBeHidden();
  });

  test("J5.2 · item 6d · no action needs an F-key (How to play lists none; photo mode works from its listed key)", { tag: ["@J5", "@J5.2", "@item-6d"] }, async ({ player, page }) => {
    await arrive(player);
    await player.escape();
    const menu = pauseMenu(player);
    await expect(menu).toBeVisible();
    const caps = (await menu.locator(".fl-key").allInnerTexts()).map((s) => s.trim());
    await player.note("keycaps", caps);
    expect(caps.length, "How to play lists keys").toBeGreaterThan(5);
    expect(caps.filter((k) => /^F\d{1,2}$/.test(k)), "no F1–F12 keys anywhere in the menu").toEqual([]);
    // Photo mode from the key How to play gives it.
    const row = menu.locator("dl dd", { hasText: /^Photo mode$/ }).first();
    const keys = (await row.locator("xpath=preceding-sibling::dt[1]").locator(".fl-key").allInnerTexts()).map((s) => s.trim());
    expect(keys.length, "How to play gives photo mode a key").toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    await page.mouse.click(640, 360);
    await player.until((s) => s.input.pointerLocked, "back in the game");
    await page.keyboard.press(keys.map(keyName).join("+"));
    await player.until((s) => s.ui.photo === true, `photo mode opens with ${keys.join("+")}`, 5000);
    await player.shot("photo-mode");
    await page.keyboard.press(keys.map(keyName).join("+"));
    await player.until((s) => s.ui.photo === false, "the same key leaves photo mode", 5000);
  });

  test("J5.3 · item 4 · the dodge roll starts within 100 ms of pressing C, standing and running, every time", { tag: ["@J5", "@J5.3", "@item-4"] }, async ({ player }) => {
    await arrive(player);
    await player.walkOutOfRing(); // uneven ground, like the owner's play, not the flat pad
    const tries: { running: boolean; controllerMs: number | null; avatarMs: number | null; corrected: boolean; animAtKey: unknown }[] = [];
    for (let i = 0; i < 6; i++) {
      const running = i % 2 === 1;
      await player.page.waitForTimeout(1500); // past the 1.2 s dodge cooldown
      const before = await player.snap();
      if (before.player?.swimming) await player.note("skipped", `try ${i + 1}: in water`);
      if (running) {
        await player.turn(180); // back and forth over the same ground, not off into a lake
        await player.page.keyboard.down("ShiftLeft");
        await player.page.keyboard.down("KeyW");
        await player.page.waitForTimeout(700);
      }
      const since = await player.now();
      await player.page.keyboard.down("KeyC");
      await player.page.waitForTimeout(60);
      await player.page.keyboard.up("KeyC");
      await player.page.waitForTimeout(900);
      if (running) {
        await player.page.keyboard.up("KeyW");
        await player.page.keyboard.up("ShiftLeft");
      }
      const ev = await player.events(since);
      const key = ev.find((e) => e.kind === "key" && e.code === "KeyC");
      const anim = ev.find((e) => e.kind === "anim" && e.to === 7 && !!key && e.t >= key.t);
      const clip = ev.find((e) => e.kind === "clip" && /dodge|roll/i.test(String(e.name)) && !!key && e.t >= key.t);
      // A server correction right after the roll would snap it back (D3: the server validates movement).
      const corrected = ev.some((e) => e.kind === "in" && e.type === "correct" && !!key && e.t - key.t < 800);
      // The player's state when C went down (a press while airborne over a bump is dropped, not buffered).
      const all = key ? await player.events(since - 3000) : [];
      const animAtKey = [...all].reverse().find((e) => e.kind === "anim" && !!key && e.t <= key.t)?.to ?? null;
      tries.push({ running, controllerMs: key && anim ? Math.round(anim.t - key.t) : null, avatarMs: key && clip ? Math.round(clip.t - key.t) : null, corrected, animAtKey: ANIM_NAMES[animAtKey as number] ?? animAtKey });
    }
    await player.note("dodge tries", tries);
    for (const [i, t] of tries.entries()) {
      const ms = t.avatarMs ?? t.controllerMs;
      expect.soft(ms, `try ${i + 1} (${t.running ? "running" : "standing"}, ${String(t.animAtKey)} when C went down): the roll started`).not.toBeNull();
      if (ms !== null) expect.soft(ms, `try ${i + 1} (${t.running ? "running" : "standing"}): key → roll on screen (ms)`).toBeLessThan(100);
      expect.soft(t.corrected, `try ${i + 1}: the server didn't snap the roll back`).toBe(false);
    }
  });

  test("J5.4 · item 6 · voice and radio are hidden: no pill, V does nothing, Esc menu says coming soon", { tag: ["@J5", "@J5.4", "@item-6"] }, async ({ player, page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __micRequests: number };
      w.__micRequests = 0;
      const md = navigator.mediaDevices;
      if (md?.getUserMedia) {
        const orig = md.getUserMedia.bind(md);
        md.getUserMedia = (c) => {
          w.__micRequests++;
          return orig(c);
        };
      }
    });
    await arrive(player, "portus");
    await expect(page.locator(".fl-hud").getByText(/voice/i), "no voice pill on the HUD").toHaveCount(0);
    await player.tap("KeyV");
    await page.waitForTimeout(800);
    const s = await player.snap();
    expect(s.input.pointerLocked, "V doesn't open a voice panel (the pointer stays locked)").toBe(true);
    expect(await page.evaluate(() => (window as unknown as { __micRequests: number }).__micRequests), "no microphone request").toBe(0);
    await player.escape();
    await expect(pauseMenu(player)).toBeVisible();
    await expect(page.locator('[data-e2e="voice-coming-soon"]'), '"Voice chat: coming soon" in the menu').toBeVisible();
    await expect(pauseMenu(player).getByText(/Voice & radio/), "no Voice & radio row").toHaveCount(0);
    await player.shot("menu-voice-coming-soon");
  });
});
