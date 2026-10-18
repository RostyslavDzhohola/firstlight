// J1 (HANDOFF 6i): a new guest goes home → Play → tutorial → arrival in < 30 s, with no blinking
// (items 1 and 6a). Blinking = frame stalls (rAF deltas) or a picture that jumps and comes back (canvas
// luma), or HUD parts flipping hidden/shown, while the player walks and looks around.

import { expectNoBlinking, measureBlinks, playAWhile } from "./blink.ts";
import { expect, test } from "./fixtures.ts";

test.describe("J1 arrival", () => {
  test("J1.1 · item 6a · a new guest lands on the home page with a Play button", { tag: ["@J1", "@J1.1", "@item-6a"] }, async ({ player, page }) => {
    await player.open();
    await expect(page.locator('[data-e2e="home"]'), "home page root").toBeVisible();
    await expect(page.locator('[data-e2e="home-play"]'), "Play / Continue on the home page").toBeVisible();
    await player.shot("home");
  });

  test("J1.2 · items 1, 6i · Play → starter → tutorial → in the world in < 30 s, no blinking", { tag: ["@J1", "@J1.2", "@item-1"] }, async ({ player, page }) => {
    const t = await player.playAsNewGuest({ starter: "Hexwick" });
    const s = await player.waitInWorld(90_000, "portus");
    const inWorldAt = Date.now();
    const loadingMs = t.pickShownAt - t.clickedAt + (inWorldAt - t.playAsAt);
    await player.note("timing", { playToPickMs: t.pickShownAt - t.clickedAt, playAsToWorldMs: inWorldAt - t.playAsAt, loadingMs, gfx: s.gfx });
    expect.soft(s.gfx?.webgpu, "renderer under test").toBe(player.gfx === "webgpu");
    expect.soft(loadingMs, "Play → in the world (minus the time spent choosing) under 30 s").toBeLessThan(30_000);

    // The tutorial greets a new player in Portus.
    const tut = await player.until((x) => !!x.onboarding?.active, "the first-minute tutorial is running", 10_000);
    expect.soft(tut.onboarding?.step, "the tutorial starts at its first step").toBe("move");
    await expect.soft(page.locator(".fl-onb"), "tutorial panel visible").toBeVisible();
    await player.shot("arrival");

    await player.lock();
    const r = await measureBlinks(player, () => playAWhile(player));
    await player.note("blinks", { frames: r.frames, flashes: r.probe.flashes, viewChanges: r.probe.viewChanges, flaps: r.probe.flaps, luma: [r.probe.lumaMin, r.probe.lumaMax] });
    expectNoBlinking(r);
    await player.shot("after-walk");
  });

  test("J1.3 · item 1 · through a portal: the loading screen never freezes, nothing compiles after it", { tag: ["@J1", "@J1.3", "@item-1"] }, async ({ player, page }) => {
    await player.joinAsDevAdmin({ starter: "Hexwick", body: "portus" });
    await player.waitInWorld(180_000, "portus");
    await player.lock();
    const t0 = await player.now();
    await player.walkThroughPortal("arcadia");
    const arrived = await player.now();
    const frames = await page.evaluate((t) => (window as any).__fl.frames.stats(t), t0);
    // Every build in the warm-up's watch window (the 120 rendered frames after the hand-over) counts.
    const shaders = await player.shaderWatchClosed();
    await player.note("travel", { ms: arrived - t0, frames, afterWarmup: shaders.afterWarmup, recent: shaders.recent });
    await player.shot("arcadia");
    // The warm-up used to compile everything again in its first real frame (WebGL: 0.7-3.3 s frozen).
    expect.soft(frames.max, `no frozen frame from the portal to Arcadia (worst: ${JSON.stringify(frames.worst)})`).toBeLessThan(500);
    expect.soft(shaders.afterWarmup, `no shader builds after the warm-up (${JSON.stringify(shaders.recent)})`).toBe(0);
  });

  test("J1.4 · item 1 · resolution steps and a window resize never show a blank world (D-view-3)", { tag: ["@J1", "@J1.4", "@item-1"] }, async ({ player, page }) => {
    // ?noladder: only the forced steps below change the resolution (they are taken all the same).
    await player.joinAsDevAdmin({ starter: "Hexwick", body: "portus", extra: { noladder: true } });
    await player.waitInWorld(180_000, "portus");
    const frames = (n: number) =>
      page.evaluate((n) => new Promise<void>((done) => {
        let left = n;
        const tick = () => (--left <= 0 ? done() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }), n);
    const started = await page.evaluate(() => (window as any).__fl.probe.start({ every: 2 }));
    expect(started.ok, `blink probe started (${started.reason ?? ""})`).toBe(true);
    const steps: { dir: number; ladder: number; canvas: unknown }[] = [];
    // Three steps down to the floor and three back up: each one resizes the drawing buffer from the
    // frame's afterFrame, the way the ladder does on a slow machine.
    for (const dir of [1, 1, 1, -1, -1, -1] as const) {
      const before = (await player.snap()).gfx?.ladder ?? 0;
      expect(await page.evaluate((d) => (window as any).__fl.act.ladderStep(d), dir), "the hook can force a ladder step").toBe(true);
      const s = await player.until((x) => x.gfx?.ladder === before + dir, `ladder rung ${before + dir}`, 10_000);
      steps.push({ dir, ladder: s.gfx!.ladder!, canvas: s.gfx!.canvas });
      await frames(20);
    }
    // A window resize (a fullscreen change resizes the same way).
    for (const size of [{ width: 1100, height: 640 }, { width: 1280, height: 720 }]) {
      const before = JSON.stringify((await player.snap()).gfx?.canvas);
      await page.setViewportSize(size);
      await player.until((x) => JSON.stringify(x.gfx?.canvas) !== before, `drawing buffer resized for ${size.width}×${size.height}`, 10_000);
      await frames(20);
    }
    const probe = await page.evaluate(() => (window as any).__fl.probe.stop());
    await player.note("frame-sizing", { steps, resizes: probe.resizes, blanks: probe.blanks, samples: probe.samples, skipped: probe.skipped, errors: probe.errors });
    expect(probe.samples, "luma samples taken").toBeGreaterThan(50);
    expect(probe.resizes, "every ladder step and window resize was a drawing-buffer change the probe read").toBeGreaterThanOrEqual(8);
    expect(probe.blanks, "no presented frame shows a blank world").toEqual([]);
  });
});
