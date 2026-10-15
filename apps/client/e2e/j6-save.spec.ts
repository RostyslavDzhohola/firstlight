// J6 (HANDOFF 6i; item 5c, the owner's final flow): guests play first; saving is offered at natural,
// non-blocking moments (never a card that needs the mouse while the pointer is locked); saving with an
// email code (the local server's dev mail log stands in for Resend) keeps the character, and signing in
// from a second browser gets the same character. Saved players never see save prompts.

import { expect, test } from "./fixtures.ts";
import { emailCodeFlow, hitTrainingDummies, newEmail, saveWithEmail } from "./flows.ts";
import { Player } from "./player.ts";

test.describe("J6 save progress", () => {
  test("J6.1 · item 5c · after the first level-up a guest gets the non-blocking save toast, never a card while the pointer is locked", { tag: ["@J6", "@J6.1", "@item-5c"] }, async ({ player, page }) => {
    await player.playAsNewGuest({ starter: "Unit 7", extra: { tier: "medium" } });
    await player.waitInWorld(90_000, "portus");
    await player.lock();
    // Watch for a blocking save card while the pointer is locked (today's bug: showSavePrompt at level 2).
    await page.evaluate(() => {
      const w = window as unknown as { __blockedCard: string[] };
      w.__blockedCard = [];
      setInterval(() => {
        const card = document.querySelector<HTMLElement>('.fl-savecard, [data-e2e="save-card"]');
        if (card && !card.hidden && card.getBoundingClientRect().width > 0 && document.pointerLockElement) w.__blockedCard.push(card.innerText.slice(0, 80));
      }, 250);
    });
    const level = await hitTrainingDummies(player);
    await player.note("level after the dummies", level);
    expect(level, "the training dummies pay level 2").toBeGreaterThanOrEqual(2);
    const toast = page.locator('[data-e2e="save-toast"]');
    let shown = await toast.waitFor({ state: "visible", timeout: 12_000 }).then(() => true, () => false);
    if (!shown) {
      // The toast may wait for the end of the tutorial: skip the rest of it, like a player who knows the game.
      await player.escape();
      await page.getByRole("menuitem", { name: /skip tutorial/i }).or(page.getByRole("button", { name: /skip tutorial/i })).first().click().catch(() => {});
      await player.lock();
      shown = await toast.waitFor({ state: "visible", timeout: 12_000 }).then(() => true, () => false);
    }
    await player.shot("after-level-up");
    const blocked = await page.evaluate(() => (window as unknown as { __blockedCard: string[] }).__blockedCard);
    expect.soft(blocked, "no save card that needs the mouse while the pointer is locked").toEqual([]);
    expect(shown, '"Progress not saved · Esc → Save progress" toast after the first level-up').toBe(true);
    await expect(toast).toContainText(/not saved/i);
  });

  test("J6.2 · item 5c · save with an email code, then sign in from a second browser and get the same character", { tag: ["@J6", "@J6.2", "@item-5c"] }, async ({ player, browser, gfx }, info) => {
    await player.playAsNewGuest({ starter: "Kappa", extra: { tier: "medium" } });
    await player.waitInWorld(90_000, "portus");
    await player.lock();
    const before = await player.snap();
    const email = newEmail("save");
    await saveWithEmail(player, email);
    // Saved players never see save prompts.
    await player.lock();
    await player.escape();
    await expect(player.page.locator('[data-e2e="pause-menu"]')).toBeVisible();
    await expect(player.page.locator('[data-e2e="menu-save"]'), "no Save progress for a saved player").toHaveCount(0);

    // Second browser (fresh profile): Sign in → same character, no starter pick.
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    try {
      const b = new Player(await ctx.newPage(), info, gfx);
      await b.open({ tier: "medium" });
      await b.page.locator('[data-e2e="signin"]').first().click();
      const card = b.page.locator('[data-e2e="save-card"], .fl-acct, [role="dialog"]').filter({ has: b.page.locator('input[type="email"]') }).first();
      await emailCodeFlow(b, card, email);
      const play = b.playButton();
      if (await play.isVisible().catch(() => false)) await play.click();
      const s = await b.waitInWorld(90_000);
      await b.shot("second-browser");
      expect(await b.page.locator(".fl-charpick").isVisible(), "no starter pick for a saved character").toBe(false);
      expect(s.player?.name, "same name").toBe(before.player?.name);
      expect(s.player?.starter, "same starter").toBe(before.player?.starter);
    } finally {
      await ctx.close();
    }
  });
});
