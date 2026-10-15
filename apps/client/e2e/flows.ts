// Multi-step flows several journeys share: saving with an email code, signing in, logging out, and the
// tutorial's training dummies. Written against the selector contract (/tmp/fl-go/e2e-contract.md) and
// HANDOFF items 5c and 6a, not today's DOM.

import { expect, type Locator } from "@playwright/test";
import type { Player } from "./player.ts";
import { mailCode } from "./stack.ts";

export function newEmail(tag: string): string {
  return `e2e-${tag}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@example.test`;
}

/** Email → "Send code" → the 6-digit code from the server's dev mail log → confirm, inside `card`. */
export async function emailCodeFlow(player: Player, card: Locator, email: string) {
  await expect(card).toBeVisible();
  await card.locator('input[type="email"], input[autocomplete="email"]').first().fill(email);
  await card.getByRole("button", { name: /send/i }).first().click();
  const code = await mailCode(email);
  const codeInput = card.locator('input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name*="code" i]').first();
  await expect(codeInput, "the code field appears after sending").toBeVisible();
  await codeInput.fill(code);
  // Six digits submit by themselves (ui/account.ts); press the button only if the field is still there.
  const submitted = await codeInput.waitFor({ state: "hidden", timeout: 4000 }).then(() => true, () => false);
  if (!submitted) {
    const confirm = card.getByRole("button", { name: /^(save|verify|confirm|sign in)$/i }).first();
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
  }
  return code;
}

/**
 * Esc → "Save progress" → the save card (mouse free) → saved. Saving unlocks at level 2 (the
 * tutorial's dummies pay it), so a level-1 guest trains first. Ends back in the game.
 */
export async function saveWithEmail(player: Player, email: string) {
  if (((await player.snap()).you?.level ?? 1) < 2) expect(await hitTrainingDummies(player), "level 2 from the training dummies").toBeGreaterThanOrEqual(2);
  await player.lock();
  await player.escape();
  const menu = player.page.locator('[data-e2e="pause-menu"]');
  await expect(menu, "Esc opens the pause menu").toBeVisible();
  const save = player.page.locator('[data-e2e="menu-save"]');
  await expect(save, 'the Esc menu offers "Save progress" to a guest').toBeVisible();
  await save.click();
  const card = player.page.locator('[data-e2e="save-card"]');
  await expect(player.page.locator('[data-e2e="save-unavailable"]'), "saving is available on the local stack").toHaveCount(0);
  await emailCodeFlow(player, card, email);
  await expect.poll(async () => (await player.page.evaluate(() => (window as any).__fl.auth()))?.kind, { message: "the account is saved", timeout: 20_000 }).toBe("saved");
  await player.shot("saved");
}

/** Pause menu → Log out (instant in a safe zone). */
export async function logOut(player: Player) {
  await player.escape();
  const menu = player.page.locator('[data-e2e="pause-menu"]');
  await expect(menu, "Esc opens the pause menu").toBeVisible();
  await menu.getByRole("menuitem", { name: /log out/i }).or(menu.getByRole("button", { name: /log out/i })).first().click();
}

/**
 * The tutorial's three training dummies, three hits each, aimed through the camera like a player
 * (SPEC §6.12: the last pays level 2). Returns the level reached.
 */
export async function hitTrainingDummies(player: Player, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  let s = await player.snap();
  const level0 = s.you?.level ?? 1;
  while (Date.now() < until) {
    s = await player.snap();
    if ((s.you?.level ?? 1) > level0 || s.onboarding?.paid) break;
    // The nearest dummy still standing (the server counts 3 hits each; fallen ones stop counting).
    const pick = (s.dummies ?? []).map((d, i) => ({ d, i })).filter((x) => !x.d.down && (x.d.hits ?? 0) < 3).sort((a, b) => a.d.dist - b.d.dist)[0];
    if (!pick) {
      await player.page.waitForTimeout(500);
      continue;
    }
    // Walk within reach (melee starters need to stand next to it).
    const reach = s.weapon?.delivery === "melee" ? 1.8 : 12;
    if (pick.d.dist > reach) {
      await player.walkTo((x) => x.dummies?.[pick.i] ?? null, (x) => (x.dummies?.[pick.i]?.dist ?? 99) <= reach, { timeoutMs: 15_000, sprint: false });
      continue;
    }
    await player.aim((x) => x.dummies?.[pick.i] ?? null);
    await player.attack();
    await player.page.waitForTimeout(500);
  }
  return (await player.snap()).you?.level ?? 1;
}
