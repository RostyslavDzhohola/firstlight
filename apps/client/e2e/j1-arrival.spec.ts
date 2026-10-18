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
    // Where the warm-up's time goes, per phase, with the shader count (D-load-1, #25).
    const warm = await player.warmup("arrival");
    await player.note("warmup", warm);
    await player.note("warmups", (await player.warmups()).map((w) => ({ label: w.label, backend: w.backend, tier: w.tier, ms: w.ms, builds: w.builds, shaders: w.shaders, phases: w.phases })));
    expect.soft(warm, "the arrival's warm-up is reported").not.toBeNull();
    expect.soft(warm?.backend, "the report names the renderer under test").toBe(player.gfx === "webgpu" ? "webgpu" : "webgl2");

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
    await player.note("warmup", await player.warmup("arrival:arcadia"));
    await player.shot("arcadia");
    // The warm-up used to compile everything again in its first real frame (WebGL: 0.7-3.3 s frozen).
    expect.soft(frames.max, `no frozen frame from the portal to Arcadia (worst: ${JSON.stringify(frames.worst)})`).toBeLessThan(500);
    expect.soft(shaders.afterWarmup, `no shader builds after the warm-up (${JSON.stringify(shaders.recent)})`).toBe(0);
  });
  test("J1.4 · a WebGPU that never answers costs this device one 8 s wait, not one per visit", { tag: ["@J1", "@J1.4"] }, async ({ player, page }) => {
    test.skip(player.gfx !== "webgl", "the hang is simulated, so one renderer project covers it");
    // The owner's M1: Chrome's WebGPU adapter never answers. Same for every visit in this browser profile.
    await page.addInitScript(() => {
      const hang = { requestAdapter: () => new Promise(() => {}), getPreferredCanvasFormat: () => "bgra8unorm", wgslLanguageFeatures: new Set() };
      Object.defineProperty(Navigator.prototype, "gpu", { configurable: true, get: () => hang });
    });
    /** One visit without ?webgl: ms from navigation to the renderer being up, and its start log. */
    const visit = async (extra = "") => {
      const lines: string[] = [];
      const onLine = (m: { text(): string }) => void (m.text().startsWith("[gfx]") && lines.push(m.text()));
      page.on("console", onLine);
      const t0 = Date.now();
      const up = page.waitForEvent("console", { predicate: (m) => m.text().startsWith("[gfx] backend"), timeout: 60_000 });
      await page.goto(`/?e2e&offline&autoplay${extra}`);
      await up;
      const ms = Date.now() - t0;
      page.off("console", onLine);
      const record = await page.evaluate(() => localStorage.getItem("fl.gfx.webgpu-failed"));
      return { ms, lines, record: record ? (JSON.parse(record) as Record<string, unknown>) : null };
    };
    const first = await visit();
    const second = await visit();
    const forced = await visit("&webgpu");
    await player.note("webgpu-memory", { firstMs: first.ms, secondMs: second.ms, forcedMs: forced.ms, record: second.record, lines: [first.lines, second.lines, forced.lines] });
    expect.soft(first.lines.join("\n"), "the first visit waits out the deadline").toMatch(/WebGPU did not start within 8 s/);
    expect.soft(first.ms, "the first visit pays the 8 s deadline").toBeGreaterThanOrEqual(8000);
    expect.soft(second.record, "the device keeps a small record: reason, time, browser, GPU").toMatchObject({ reason: "timeout", browser: expect.stringMatching(/^Chrome\/\d+$/) });
    expect.soft(Object.keys(second.record ?? {}).sort(), "and nothing else").toEqual(["at", "browser", "gpu", "reason", "v"]);
    expect.soft(second.lines.join("\n"), "the second visit skips WebGPU").toMatch(/WebGPU skipped/);
    expect.soft(second.ms, "the second visit doesn't wait for WebGPU").toBeLessThan(first.ms - 6000);
    expect.soft(forced.lines.join("\n"), "?webgpu tries again").toMatch(/\?webgpu: trying WebGPU[\s\S]*WebGPU did not start within 8 s/);
  });
});
