// Blink and stall measurement shared by J1 and the smoke test (items 1 and 6i): frame times from the
// hook's rAF ring, canvas luma flashes and HUD hidden/shown flips from its probe.

import { expect } from "@playwright/test";
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
