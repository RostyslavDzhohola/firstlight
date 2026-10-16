import { describe, expect, it } from "vitest";
import { DoneCardTimer } from "./doneCardTimer.ts";

/** A hand-driven clock and visibility: `advance` moves time forward and ticks once per `step` ms, as frames would. */
function rig(opts: { durationMs?: number; maxStepMs?: number } = {}) {
  const state = { t: 1000, visible: false };
  const timer = new DoneCardTimer({ durationMs: opts.durationMs ?? 8000, maxStepMs: opts.maxStepMs, now: () => state.t, visible: () => state.visible });
  /** Returns whether the card's time ran out at any tick. */
  const advance = (ms: number, step = 100): boolean => {
    let expired = false;
    for (let left = ms; left > 0; left -= step) {
      state.t += Math.min(step, left);
      if (timer.tick()) expired = true;
    }
    return expired;
  };
  return { state, timer, advance };
}

describe("DoneCardTimer", () => {
  it("does not run before start(), and tick() reports nothing", () => {
    const { state, timer, advance } = rig();
    state.visible = true;
    expect(timer.running).toBe(false);
    expect(advance(20_000)).toBe(false);
    expect(timer.remainingMs).toBe(0);
  });

  it("runs out after the full duration of visible time", () => {
    const { state, timer, advance } = rig();
    state.visible = true;
    timer.start();
    expect(timer.running).toBe(true);
    expect(advance(7900)).toBe(false);
    expect(timer.remainingMs).toBe(100);
    expect(advance(100)).toBe(true);
    expect(timer.tick()).toBe(true); // stays expired until stop() or start()
  });

  it("does not count behind a loading screen: the portal travel", () => {
    const { state, timer, advance } = rig();
    state.visible = true;
    timer.start(); // the card appears as the player steps into the portal
    advance(200);
    state.visible = false; // Game.travel: the loading screen is up (input.suspended)
    expect(advance(30_000)).toBe(false); // a slow load, far longer than the 8 s
    expect(timer.remainingMs).toBe(7800);
    state.visible = true; // arrival hand-over: the world is on screen
    expect(advance(7700)).toBe(false);
    expect(advance(100)).toBe(true);
  });

  it("gives the whole card even when it first appears behind a loading screen", () => {
    const { state, timer, advance } = rig();
    timer.start();
    expect(advance(60_000)).toBe(false);
    expect(timer.remainingMs).toBe(8000);
    state.visible = true;
    expect(advance(7900)).toBe(false);
    expect(advance(100)).toBe(true);
  });

  it("pauses while the pause menu is open and goes on with the time that was left", () => {
    const { state, timer, advance } = rig();
    state.visible = true;
    timer.start();
    advance(5000);
    state.visible = false; // Esc: the pause menu
    advance(120_000);
    expect(timer.remainingMs).toBe(3000);
    state.visible = true;
    expect(advance(2900)).toBe(false);
    expect(advance(100)).toBe(true);
  });

  it("does not count the stretch between two ticks that straddles a pause", () => {
    const { state, timer } = rig();
    state.visible = true;
    timer.start();
    state.t += 100;
    timer.tick(); // 7900 left
    state.visible = false;
    state.t += 400; // hidden at the tick that ends this stretch
    timer.tick();
    state.visible = true;
    state.t += 100; // one visible step after resuming
    timer.tick();
    expect(timer.remainingMs).toBe(7800);
  });

  it("caps one tick, so a long hitch right after arriving cannot eat the card", () => {
    const { state, timer } = rig({ maxStepMs: 500 });
    state.visible = true;
    timer.start();
    state.t += 6000; // e.g. the main thread was busy with shaders
    expect(timer.tick()).toBe(false);
    expect(timer.remainingMs).toBe(7500);
  });

  it("start() again restarts from the full duration, stop() ends it", () => {
    const { state, timer, advance } = rig();
    state.visible = true;
    timer.start();
    advance(6000);
    timer.start();
    expect(timer.remainingMs).toBe(8000);
    advance(3000);
    timer.stop();
    expect(timer.running).toBe(false);
    expect(timer.remainingMs).toBe(0);
    expect(advance(20_000)).toBe(false);
  });
});
