// Smoke (@smoke): the short, read-only subset that also runs against production after each deploy
// (`pnpm e2e:prod`): a guest joins, sees the world, nothing blinks, no console errors. It never
// attacks, saves, names a character or changes settings: `?autoplay` joins with a generated guest name.

import { expect, test } from "./fixtures.ts";
import { expectNoBlinking, measureBlinks, playAWhile } from "./blink.ts";
import { TARGET } from "./stack.ts";

/** Console noise that isn't a defect: fullscreen needs a user gesture under ?autoplay. */
const BENIGN = [/requestFullscreen/i, /user gesture/i];

test.describe("smoke", () => {
  test("smoke · item 6i · a guest joins, sees the world, no blinking, no console errors", { tag: ["@smoke"] }, async ({ player, page, consoleErrors }) => {
    await page.goto(player.url({ autoplay: true }));
    const hook = await page.waitForFunction(() => !!(window as any).__fl, null, { timeout: 15_000 }).then(() => true, () => false);
    await player.note("target", { target: TARGET, hook });
    if (!hook) {
      // Production before this suite's hook is deployed: DOM-only checks.
      await expect(page.locator("#loading")).toBeHidden({ timeout: 90_000 });
      await expect(page.locator("#game canvas")).toBeVisible();
      await player.shot("world-no-hook");
    } else {
      const s = await player.waitInWorld(90_000);
      expect(s.player?.hp, "alive in the world").toBeGreaterThan(0);
      await player.shot("world");
      await player.lock();
      const r = await measureBlinks(player, () => playAWhile(player));
      await player.note("blinks", { frames: r.frames, flashes: r.probe.flashes, viewChanges: r.probe.viewChanges, flaps: r.probe.flaps });
      expectNoBlinking(r);
    }
    const errors = consoleErrors.filter((e) => !BENIGN.some((re) => re.test(e)));
    expect(errors, "no console errors").toEqual([]);
  });
});
