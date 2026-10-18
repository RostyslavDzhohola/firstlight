// J7 (HANDOFF 6i; item 6a): logging out brings you back to the main page, a home screen with the
// leaderboard, who's online, the worlds and (signed in) my progress, plus Play and Sign in. No
// "LOGGED OUT" card over the blurred game, no voice pill. The home page draws no live blur (D-ui-1)
// and leaves the page while the loader is up (D-home-8).

import { expect, test } from "./fixtures.ts";
import { blurredBackdrops, hudParts, logOut, newEmail, saveWithEmail } from "./flows.ts";

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

  test("J7.3 · D-ui-1 · the home page draws no live backdrop blur; ?blur=1 brings the old look back", { tag: ["@J7", "@J7.3", "@D-ui-1"] }, async ({ player, page }) => {
    await player.open();
    const board = page.locator('[data-e2e="home-leaderboard"]');
    await expect(board).toBeVisible();
    expect(await blurredBackdrops(page), "no blurring backdrop filter on the home page").toEqual([]);
    await player.shot("home-flat");
    await player.open({ blur: 1 });
    await expect(board).toBeVisible();
    expect(await board.evaluate((e) => getComputedStyle(e).backdropFilter), "a home card with ?blur=1").toMatch(/blur\(22px\)/);
    expect((await blurredBackdrops(page)).length, "the cards and the share row blur again").toBeGreaterThanOrEqual(3);
    await player.shot("home-blur1");
  });

  test("J7.4 · D-home-8 · under the loader the home page leaves the page and polls nothing; a failed load brings it back working, with fresh data", { tag: ["@J7", "@J7.4", "@D-home-8"] }, async ({ player, page }) => {
    // A dev guest with a character: Play goes straight to the loader (no starter pick or name card).
    await page.addInitScript(() => {
      if (!localStorage.getItem("firstlight.devGuest")) localStorage.setItem("firstlight.devGuest", `e2e${Math.random().toString(16).slice(2, 12)}:E2E_home`);
      localStorage.setItem("fl.starter", "1");
      localStorage.setItem("fl.palette", "0");
    });
    let homeCalls = 0;
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/api/home") homeCalls++;
    });
    // The world never answers: the arrival gives up after 20 s (a full home poll period) with an error.
    await page.route("**/api/play", () => {});
    await player.open({ devguest: true, tier: "medium" });
    const home = page.locator('[data-e2e="home"]');
    await expect(page.locator('[data-e2e="home-leaderboard"]')).toBeVisible();
    await expect.poll(() => homeCalls, { message: "the home page polls" }).toBeGreaterThan(0);
    await page.locator('[data-e2e="home-play"]').click();
    await expect(page.locator("#loading"), "the loader").toBeVisible();
    await expect(home, "the home page leaves under the loader").toBeHidden();
    expect(await home.evaluate((e) => (e as HTMLElement).inert), "and is inert").toBe(true);
    const seen = homeCalls;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); // what polls at once on a visible page
    const back = page.getByRole("button", { name: "Back to the home page" });
    await expect(back, "the failed arrival's error").toBeVisible({ timeout: 120_000 });
    expect(homeCalls, "no home polling while the loader was up").toBe(seen);
    await player.shot("load-error");
    await page.unroute("**/api/play");
    await back.click();
    await expect(home, "back on the home page").toBeVisible();
    await expect(page.locator("#loading")).toBeHidden();
    expect(await home.evaluate((e) => (e as HTMLElement).inert), "interactive again").toBe(false);
    await expect.poll(() => homeCalls, { message: "fresh data on the way back" }).toBeGreaterThan(seen);
    expect(await hudParts(player), "no half-started HUD over the home page").toEqual([]);
    await player.shot("home-after-load-error");
    await page.locator('[data-e2e="home-play"]').click();
    await player.waitInWorld(90_000);
    expect(await hudParts(player), "the HUD in the world").toEqual(expect.arrayContaining(["playerCard", "hotbar"]));
  });
});
