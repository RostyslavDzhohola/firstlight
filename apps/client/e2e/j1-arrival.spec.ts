// J1 (HANDOFF 6i): a new guest goes home → Play → tutorial → arrival in < 30 s, with no blinking
// (items 1 and 6a). Blinking = frame stalls (rAF deltas) or a picture that jumps and comes back (canvas
// luma), or HUD parts flipping hidden/shown, while the player walks and looks around.

import { expect, test } from "./fixtures.ts";
import type { Player } from "./player.ts";

/** Look around and walk for ~10 s the way the owner did in the recording. */
export async function playAWhile(player: Player) {
  await player.hold(["KeyW"], 2500);
  for (let i = 0; i < 12; i++) await player.turn(30); // a full turn in 30° steps
  await player.hold(["ShiftLeft", "KeyW"], 2000);
  await player.lookUp(0.3);
  for (let i = 0; i < 6; i++) await player.turn(-20);
  await player.lookUp(-0.3);
  await player.hold(["KeyS"], 1200);
}

export interface BlinkReport {
  frames: { frames: number; p50: number; p95: number; p99: number; max: number; over100: number; over250: number; worst: { t: number; ms: number }[] };
  probe: { samples: number; flashes: { t: number; jump: number; samples: number }[]; flaps: { key: string; t: number; gapMs: number }[]; lumaMin: number | null; lumaMax: number | null; errors: number };
}

/** Run `during` with the blink probe on; returns frame stats and probe results for that window. */
export async function measureBlinks(player: Player, during: () => Promise<void>): Promise<BlinkReport> {
  const t0 = await player.now();
  const started = await player.page.evaluate(() => (window as any).__fl.probe.start({ every: 2 }));
  expect(started.ok, `blink probe started (${started.reason ?? ""})`).toBe(true);
  await during();
  const probe = await player.page.evaluate(() => (window as any).__fl.probe.stop());
  const frames = await player.page.evaluate((t) => (window as any).__fl.frames.stats(t), t0);
  const report: BlinkReport = { frames, probe };
  await player.info.attach("blink-report.json", { body: JSON.stringify({ ...report, probe: { ...probe, series: undefined } }, null, 2), contentType: "application/json" });
  await player.info.attach("luma-series.json", { body: JSON.stringify(probe.series), contentType: "application/json" });
  return report;
}

/** The pass line for "no blinking" (owner's recording: a one-frame ±72 luma flash; 117–717 ms stalls). */
export function expectNoBlinking(r: BlinkReport) {
  expect.soft(r.probe.samples, "luma samples taken").toBeGreaterThan(50);
  expect.soft(r.probe.flashes, "no picture flash or blackout (luma jump ≥ 40 that comes back)").toEqual([]);
  expect.soft(r.probe.flaps, "no HUD element flipping hidden/shown within 250 ms").toEqual([]);
  expect.soft(r.frames.over250, `no frame stall over 250 ms (worst: ${JSON.stringify(r.frames.worst)})`).toBe(0);
  expect.soft(r.frames.over100, "at most 2 frames over 100 ms").toBeLessThanOrEqual(2);
}

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
    await player.note("blinks", { frames: r.frames, flashes: r.probe.flashes, flaps: r.probe.flaps, luma: [r.probe.lumaMin, r.probe.lumaMax] });
    expectNoBlinking(r);
    await player.shot("after-walk");
  });
});
