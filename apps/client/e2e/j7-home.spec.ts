// J7 (HANDOFF 6i; item 6a): logging out brings you back to the main page, a home screen with the
// leaderboard, who's online, the worlds and (signed in) my progress, plus Play and Sign in. No
// "LOGGED OUT" card over the blurred game, no voice pill.

import { expect, test } from "./fixtures.ts";
import { logOut, newEmail, saveWithEmail } from "./flows.ts";

test.describe("J7 home", () => {
  test("J7.1 · item 6a · a guest logs out → the home page with leaderboard, online players, worlds, Play and Sign in", { tag: ["@J7", "@J7.1", "@item-6a"] }, async ({ player, page }) => {
    await player.playAsNewGuest({ starter: "Brother Ash", extra: { tier: "medium" } });
    await player.waitInWorld(90_000, "portus");
    await player.lock();
    await logOut(player);
    const home = page.locator('[data-e2e="home"]');
    await expect(home, "logging out lands on the home page").toBeVisible({ timeout: 15_000 });
    for (const card of ["home-leaderboard", "home-online", "home-worlds", "home-play"]) await expect.soft(page.locator(`[data-e2e="${card}"]`), card).toBeVisible();
    await expect.soft(page.locator('[data-e2e="signin"]'), "Sign in for returning players").toBeVisible();
    await expect.soft(page.getByText(/press V/i), "no voice pill").toHaveCount(0);
    const s = await player.snap();
    expect.soft(s.ui.loggedOutCard, 'no "Logged out" card over the game').toBe(false);
    await player.shot("home-after-logout");
    // Play from home goes straight back in (one click, no starter pick for an existing character).
    await page.locator('[data-e2e="home-play"]').click();
    await player.waitInWorld(90_000);
  });

  test("J7.2 · item 6a · a saved player logs out → home shows my progress (name, level)", { tag: ["@J7", "@J7.2", "@item-6a"] }, async ({ player, page }) => {
    await player.playAsNewGuest({ starter: "Hexwick", extra: { tier: "medium" } });
    const s = await player.waitInWorld(90_000, "portus");
    await player.lock();
    await saveWithEmail(player, newEmail("home"));
    await player.lock();
    await logOut(player);
    await expect(page.locator('[data-e2e="home"]')).toBeVisible({ timeout: 15_000 });
    const progress = page.locator('[data-e2e="home-progress"]');
    await expect(progress, "my progress card").toBeVisible();
    await expect(progress).toContainText(s.player!.name!);
    await expect(progress).toContainText(/level|lv/i);
    await player.shot("home-progress");
  });
});
