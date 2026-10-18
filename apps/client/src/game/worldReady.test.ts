import { describe, expect, it } from "vitest";
import { WORLD_READY_CAP_MS, worldReady, type WorldBuild } from "./worldReady.ts";

const build = (loaded: number, chunks: number, grass = 0): WorldBuild => ({ chunks, loaded, grass });

describe("the world is ready to show (D-load-6)", () => {
  it("waits for every chunk the streaming wants, not just the nearest ones", () => {
    expect(worldReady(build(0, 96), 0).done).toBe(false);
    expect(worldReady(build(95, 96), 1000).done).toBe(false);
    expect(worldReady(build(96, 96), 1000).done).toBe(true);
  });

  it("then waits for the grass round the player to fill", () => {
    const r = worldReady(build(96, 96, 12), 1000);
    expect(r.done).toBe(false);
    expect(r.text).toMatch(/^Building the world/); // the loader's "Building the world" step
    expect(r.text).toMatch(/grass/i);
    expect(worldReady(build(96, 96, 0), 1100).done).toBe(true);
  });

  it("gives up after 30 s with the world as it is (never a stuck loader)", () => {
    expect(WORLD_READY_CAP_MS).toBe(30_000);
    expect(worldReady(build(10, 96, 50), WORLD_READY_CAP_MS - 1)).toMatchObject({ done: false, timedOut: false });
    expect(worldReady(build(10, 96, 50), WORLD_READY_CAP_MS)).toMatchObject({ done: true, timedOut: true });
    expect(worldReady(build(10, 96), 5000, 4000)).toMatchObject({ done: true, timedOut: true }); // a caller's own cap
  });

  it("reports its progress: chunks in out of wanted, grass last, 1 when done", () => {
    const a = worldReady(build(0, 96), 0);
    const b = worldReady(build(48, 96), 500);
    const c = worldReady(build(96, 96, 20), 900);
    const d = worldReady(build(96, 96, 0), 1000);
    expect(a.frac).toBe(0);
    expect(b.frac).toBeGreaterThan(a.frac);
    expect(c.frac).toBeGreaterThan(b.frac);
    expect(c.frac).toBeLessThan(1);
    expect(d.frac).toBe(1);
    expect(b.text).toBe("Building the world 48/96");
  });

  it("counts a world with nothing to stream (no chunks wanted) as built", () => {
    expect(worldReady(build(0, 0), 0)).toMatchObject({ done: true, frac: 1, timedOut: false });
  });
});
