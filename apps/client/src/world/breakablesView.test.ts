// BreakablesView with a fake Worker and a fake game (F12 Opus S13 + destruction nits): a failed
// fracture worker still shows intact props, early shatters are capped, a `rebuilt` that beats its
// state patch doesn't flicker, and every client seeds the same shatter the same way.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { bodyBreakables, createTerrain, type Breakable } from "@firstlight/shared";
import type { Game } from "../game/Game.ts";
import type { MoveColliders } from "../game/PlayerController.ts";

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  posted: unknown[] = [];
  terminated = false;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(m: unknown) {
    this.posted.push(m);
  }
  terminate() {
    this.terminated = true;
  }
  /** The chunk 404s (old build after a client deploy). */
  fail() {
    this.onerror?.({ message: "404", preventDefault() {} } as unknown as ErrorEvent);
  }
}

class FakeRoom {
  readonly handlers = new Map<string, (m: unknown) => void>();
  readonly state = { broken: new Map<string, number>() };
  onMessage(type: string, cb: (m: unknown) => void) {
    this.handlers.set(type, cb);
    return () => this.handlers.delete(type);
  }
  emit(type: string, m: unknown) {
    this.handlers.get(type)?.(m);
  }
}

const terrain = createTerrain("arcadia");
const list = bodyBreakables(terrain);

function fakeGame(room: FakeRoom | null) {
  let colliders: MoveColliders | null = null;
  const camera = new THREE.PerspectiveCamera();
  const b = list[0]!;
  camera.position.set(b.cx + b.ux * 3, b.cy + b.uy * 3, b.cz + b.uz * 3); // right over the first prop
  const game = {
    bodyId: "arcadia",
    ctx: { scene: new THREE.Scene(), camera, settings: { tier: "medium", on: { destruct: true, shadows: true }, shadows: { mode: "map" } }, onChange: () => () => {} },
    net: { room },
    planet: { terrain, loadRadius: 520, body: terrain.body },
    player: { setColliders: (c: MoveColliders | null) => (colliders = c), getColliders: () => colliders },
    burst: vi.fn(),
    audio: { play: vi.fn() },
  };
  return game as typeof game & Game;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let mod: typeof import("./Breakables.ts");
let debrisMod: typeof import("../render/debris.ts");
beforeAll(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
});
afterAll(() => {
  delete (globalThis as { Worker?: unknown }).Worker;
});
beforeEach(async () => {
  vi.resetModules(); // a fresh worker/cache per test
  FakeWorker.all = [];
  mod = await import("./Breakables.ts");
  debrisMod = await import("../render/debris.ts");
});

/** A view whose worker failed: ready with main-thread intact props after one update. */
async function readyView(room: FakeRoom | null) {
  const game = fakeGame(room);
  const view = new mod.BreakablesView(game);
  FakeWorker.all[0]?.fail();
  await flush();
  view.update(0.016, performance.now());
  return { game, view };
}

describe("fracture worker failure (Opus S13)", () => {
  it("settles the request, builds intact props on the main thread, and makes them solid", async () => {
    const game = fakeGame(null);
    const view = new mod.BreakablesView(game);
    expect(FakeWorker.all).toHaveLength(1);
    FakeWorker.all[0]!.fail();
    expect(FakeWorker.all[0]!.terminated).toBe(true);
    await flush();
    view.update(0.016, performance.now());
    const st = view.stats();
    expect(st.props).toBe(list.length);
    expect(st.instances).toBeGreaterThan(0); // drawn: what blocks shots is visible
    expect(game.player.getColliders()).toBe(view);
    expect(view.raycast(game.ctx.camera.position, new THREE.Vector3(-list[0]!.ux, -list[0]!.uy, -list[0]!.uz), 10)).toBeLessThan(10);
    // The next body (or debris for another tier) doesn't retry a broken worker: no hang, no storm.
    const next = new mod.BreakablesView(fakeGame(null));
    await flush();
    next.update(0.016, performance.now());
    expect(FakeWorker.all).toHaveLength(1);
    expect(next.stats().props).toBe(list.length);
    view.dispose();
    next.dispose();
  });

  it("remembers at most a bounded number of shatters while loading", async () => {
    const room = new FakeRoom();
    const view = new mod.BreakablesView(fakeGame(room));
    for (let k = 0; k < 10_000; k++) room.emit("broke", { id: `junk.${k}`, archetype: 0, variant: 0, ix: 0, iy: 1, iz: 0 });
    room.emit("broke", { id: list[3]!.id, archetype: 0, variant: 0, ix: 0, iy: 1, iz: 0 });
    expect(view.stats().early).toBeLessThanOrEqual(2048);
    view.dispose();
  });
});

describe("rebuild sync", () => {
  it("a `rebuilt` that beats its state patch shows the prop once: no flicker, one burst", async () => {
    const room = new FakeRoom();
    const { game, view } = await readyView(room);
    const b: Breakable = list[0]!;
    let now = performance.now();
    room.state.broken.set(b.id, Date.now() + 180_000);
    view.update(0.016, (now += 300));
    expect(view.stats().broken).toBe(1);
    room.emit("rebuilt", { id: b.id }); // the state patch dropping it hasn't arrived yet
    expect(view.stats().broken).toBe(0);
    expect(game.burst).toHaveBeenCalledTimes(1);
    view.update(0.016, (now += 300)); // a poll against the stale state
    expect(view.stats().broken).toBe(0);
    room.state.broken.delete(b.id); // the patch lands
    view.update(0.016, (now += 300));
    expect(view.stats().broken).toBe(0);
    expect(game.burst).toHaveBeenCalledTimes(1);
    // It can break again later (a new rebuild time is not stale).
    room.state.broken.set(b.id, Date.now() + 360_000);
    view.update(0.016, (now += 300));
    expect(view.stats().broken).toBe(1);
    view.dispose();
  });
});

describe("shatter seeds (destruction nit)", () => {
  it("two clients seed the same break the same way, whatever else they broke before", async () => {
    const spawn = vi.spyOn(debrisMod.Debris.prototype, "spawn");
    const a = await readyView(new FakeRoom());
    const b = await readyView(new FakeRoom());
    a.view.breakNearest(); // a local debug shatter on one client only
    a.view.rebuildAll();
    spawn.mockClear();
    const prop = list[5]!;
    const msg = { id: prop.id, archetype: prop.archetype, variant: 2, ix: 0.6, iy: 0.0, iz: 0.8, f: 1.3 };
    (a.game.net.room as unknown as FakeRoom).emit("broke", msg);
    (b.game.net.room as unknown as FakeRoom).emit("broke", msg);
    expect(spawn).toHaveBeenCalledTimes(2);
    const seedA = spawn.mock.calls[0]![7], seedB = spawn.mock.calls[1]![7];
    expect(seedA).toBe(seedB);
    expect(seedA).toBe(mod.shatterSeed(prop.index, 2, 0.6, 0, 0.8, 1.3));
    expect(mod.shatterSeed(prop.index, 1, 0.6, 0, 0.8, 1.3)).not.toBe(seedA);
    a.view.dispose();
    b.view.dispose();
  });
});
