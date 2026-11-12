// The live re-probe (performance panel) on real grass over a fake renderer that keeps shader builds
// the way three does: one per material, attribute layout and shadow flag, freed with the last
// geometry that used it. Planet graphics review, finding 1: a session that started on Low and
// re-probed to Medium or High warmed and measured bare ground, and first compiled the meadow grass
// after play resumed.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { buildChunk, CHUNK_QUADS, createTerrain } from "@firstlight/shared";
import { emptyStored, resolveSettings, type Tier } from "./quality.ts";
import { GrassSystem, type GrassChunk } from "./grass.ts";
import { reprobe, type ProbeWorld } from "./probe.ts";
import { installShaderMonitor, shaderMonitorFrame, shaderStats } from "./warmup.ts";
import type { RenderCtx } from "./renderer.ts";

const terrain = createTerrain("arcadia");
const body = terrain.body;

function chunk(face: 0 | 1 | 2 | 3 | 4 | 5, cx: number, cy: number): GrassChunk {
  const g = buildChunk(terrain, face, cx, cy);
  const side = CHUNK_QUADS + 1;
  const c = g.center;
  const mid = body.radius + (g.minHeight + g.maxHeight) / 2;
  return {
    key: `${face}:${cx}:${cy}`, face, cx, cy, positions: g.positions, grass: new Float32Array(side * side).fill(1),
    center: new THREE.Vector3(c[0] * mid, c[1] * mid, c[2] * mid), radius: g.boundRadius,
  };
}

/** What a frame draws: visible meshes (their ancestors too) with at least one instance. */
function drawn(scene: THREE.Scene): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  const walk = (o: THREE.Object3D) => {
    if (!o.visible) return;
    const m = o as THREE.Mesh;
    if (m.isMesh && ((m.geometry as THREE.InstancedBufferGeometry).instanceCount ?? 1) > 0) out.push(m);
    for (const c of o.children) walk(c);
  };
  walk(scene);
  return out;
}

/**
 * A session on a hand-moved clock: one chunk of Arcadia under the camera (or none: `bare`), the
 * grass at `start`, and a GPU that takes `gpuMs` a frame (3: the probe goes on to High; 9: Medium).
 */
function session(start: Tier, gpuMs: number, bare = false) {
  let clock = 1000;
  /** Inside the play-rate world update every clock read costs a millisecond, so its 2 ms budget bites. */
  let tick = 0;
  vi.spyOn(performance, "now").mockImplementation(() => (clock += tick));
  vi.stubGlobal("window", {});
  vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => setTimeout(() => cb((clock += 16)), 0));
  const debug: { onNodeBuilderCreated?: (builder: unknown, ro: unknown) => void } = {};
  // three's build cache: a key's build lives while a geometry that was drawn with it does.
  const builds = new Map<string, Set<THREE.BufferGeometry>>();
  const use = (m: THREE.Mesh) => {
    const g = m.geometry;
    const mat = m.material as THREE.Material;
    const key = [mat.name, ...Object.keys(g.attributes).sort().map((n) => `${n}:${g.attributes[n]!.itemSize}`), g.index ? "index" : "", m.receiveShadow].join(",");
    let users = builds.get(key);
    if (!users) {
      builds.set(key, (users = new Set()));
      debug.onNodeBuilderCreated?.({}, { object: m, material: mat });
    }
    if (users.has(g)) return;
    users.add(g);
    const set = users;
    g.addEventListener("dispose", () => {
      set.delete(g);
      if (set.size === 0 && builds.get(key) === set) builds.delete(key);
    });
  };
  const scene = new THREE.Scene();
  const grass = new GrassSystem(body.radius, body.chunksPerFace * CHUNK_QUADS);
  scene.add(grass.group);
  const ch = chunk(0, 3, 3);
  const chunks: GrassChunk[] = bare ? [] : [ch];
  const cam = ch.center.clone().setLength(ch.center.length() + 2);
  let tier: Tier = start;
  const apply = () => grass.applySettings(resolveSettings(tier, false, true, emptyStored(), new Set()));
  apply();
  const frames: { tier: Tier; blades: number; backlog: number }[] = [];
  let pending: number[] = [];
  const ctx = {
    scene,
    camera: new THREE.PerspectiveCamera(),
    webgpu: true,
    get tier() {
      return tier;
    },
    gpuName: "Apple M1",
    renderer: {
      debug,
      info: { frame: 0, reset() {} },
      compileAsync: async () => {
        for (const m of drawn(scene)) use(m);
      },
    },
    setTier: (t: Tier) => {
      tier = t;
      apply();
    },
    setProbedTier: (t: Tier) => {
      tier = t;
      apply();
    },
    render() {
      for (const m of drawn(scene)) use(m);
      frames.push({ tier, blades: grass.blades, backlog: grass.backlog() });
      pending.push(gpuMs);
    },
    gpu: {
      available: true,
      frame() {},
      drain: () => {
        const out = pending;
        pending = [];
        return out;
      },
      drainBusy: () => [],
    },
  } as unknown as RenderCtx;
  installShaderMonitor(ctx);
  const world: ProbeWorld = {
    // Play's streaming: 2 ms of new cells a frame.
    update: () => {
      tick = 1;
      grass.update(cam, chunks, clock, 2);
      tick = 0;
    },
    // Game.buildWorld: stream until nothing is left to fill.
    settle: async () => {
      do grass.update(cam, chunks, clock, 1000);
      while (grass.backlog() > 0);
    },
  };
  /** Frames of play after the loading screen: stream, draw, count. */
  const play = (n: number) => {
    for (let i = 0; i < n; i++) {
      world.update();
      ctx.render();
      shaderMonitorFrame();
    }
  };
  return { ctx, world, grass, frames, chunks, ch, play, tier: () => tier };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("live re-probe from Low (review finding 1)", () => {
  for (const [gpuMs, lands] of [[9, "medium"], [3, "ultra"]] as const) {
    it(`to ${lands}: every warm-up and measurement frame draws the tier's rebuilt grass, and play after it compiles nothing`, async () => {
      const s = session("low", gpuMs);
      await s.world.settle!(); // play on Low before the re-probe
      s.play(3);
      s.frames.length = 0;
      await reprobe(s.ctx, { world: s.world });
      expect(s.tier()).toBe(lands);
      expect(s.frames.length).toBeGreaterThan(100); // the warm-ups and the 2 s measurement
      expect(s.frames.filter((f) => f.blades === 0 || f.backlog > 0), "frames drawn without the tier's grass").toEqual([]);
      expect(new Set(s.frames.map((f) => f.tier)).has("medium")).toBe(true);
      expect(shaderStats().watching).toBe(120); // the window after the final warm-up
      s.play(60);
      expect(shaderStats().recent).toEqual([]);
      expect(shaderStats().afterWarmup).toBe(0);
      s.grass.dispose();
    });
  }

  it("on ground with no grass near: the warm-up still compiles the tier's grass, so the first cell later is no new build", async () => {
    const s = session("low", 9, true);
    s.play(3);
    await reprobe(s.ctx, { world: s.world });
    expect(s.tier()).toBe("medium");
    s.play(5);
    expect(s.grass.blades).toBe(0);
    s.chunks.push(s.ch); // the player walks on to a meadow
    s.grass.chunksChanged();
    s.play(30);
    expect(s.grass.blades).toBeGreaterThan(0);
    expect(shaderStats().recent).toEqual([]);
    expect(shaderStats().afterWarmup).toBe(0);
    s.grass.dispose();
  });

  it("runs what follows the tier (textures, packs) after the probed tier is set and before its warm-up", async () => {
    const s = session("low", 9);
    const order: string[] = [];
    await reprobe(s.ctx, {
      world: { update: s.world.update, settle: async () => void order.push("settle") },
      afterTier: () => void order.push(`afterTier:${s.tier()}`),
      onWarmup: () => order.at(-1) !== "warmup" && order.push("warmup"),
    });
    expect(order.slice(-3)).toEqual(["afterTier:medium", "settle", "warmup"]);
    s.grass.dispose();
  });
});
