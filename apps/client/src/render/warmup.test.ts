import { describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import {
  fnv1a, forceProperty, installShaderMonitor, keptSamples, lastWarmup, MovingProgress, predictShadowBuilds, shadowBuildCost, shaderStats,
  warmShadowCasters, warmup, type WarmupProgress,
} from "./warmup.ts";
import { FIRST_DRAWS_START, PIPELINE_OVERHEAD } from "./parallelCompile.ts";
import { flags } from "../config.ts";
import type { RenderCtx } from "./renderer.ts";
import { watchDisposals } from "./disposeWatch.testutil.ts";

describe("warm-up forced properties", () => {
  it("restores the original value when nothing wrote during warm-up", () => {
    const o = new THREE.Object3D();
    o.visible = false;
    const restore = forceProperty(o, "visible", true);
    expect(o.visible).toBe(true);
    restore();
    expect(o.visible).toBe(false);
  });

  it("keeps a value written by another system during warm-up", () => {
    const o = new THREE.Object3D();
    o.visible = false;
    const restore = forceProperty(o, "visible", true);
    o.visible = true; // e.g. a grass cell got filled
    o.visible = false;
    o.visible = true;
    expect(o.visible).toBe(true);
    restore();
    expect(o.visible).toBe(true);
    // Back to a plain data property.
    o.visible = false;
    expect(o.visible).toBe(false);
    expect(Object.getOwnPropertyDescriptor(o, "visible")?.get).toBeUndefined();
  });

  it("works for instance counts", () => {
    const g = new THREE.InstancedBufferGeometry();
    g.instanceCount = 0;
    const restore = forceProperty(g, "instanceCount", 1);
    expect(g.instanceCount).toBe(1);
    g.instanceCount = 3000;
    expect(g.instanceCount).toBe(1); // still forced while warming
    restore();
    expect(g.instanceCount).toBe(3000);
  });
});

describe("session warm-up samples (T9)", () => {
  const mesh = () => new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicNodeMaterial());

  it("are built once and come back hidden, with nothing disposed", () => {
    let builds = 0;
    const build = () => {
      builds++;
      return [mesh(), mesh()];
    };
    const g = keptSamples("test-a", build)!;
    expect(g.visible).toBe(false); // drawn only while warmup() shows hidden objects
    expect(g.userData.noWarmup).toBeUndefined();
    expect(g.children).toHaveLength(2);
    const w = watchDisposals(g);
    expect(keptSamples("test-a", build)).toBe(g);
    expect(builds).toBe(1);
    expect(w.disposed.size).toBe(0);
  });

  it("retry a build that couldn't run yet; without a build they only look up", () => {
    expect(keptSamples("test-b")).toBeNull();
    expect(keptSamples("test-b", () => null)).toBeNull();
    const g = keptSamples("test-b", () => [mesh()])!;
    expect(g.children).toHaveLength(1);
    expect(keptSamples("test-b", () => [mesh(), mesh()])).toBe(g);
    expect(keptSamples("test-b")).toBe(g);
  });
});

describe("post-warm-up shader window", () => {
  it("doesn't count a later warm-up's own builds as builds after warm-up (first-visit probe, then the full warm-up)", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 0));
    const debug: { onNodeBuilderCreated?: (builder: unknown, ro: unknown) => void } = {};
    const watchingDuringCompile: number[] = [];
    const ctx = {
      scene: new THREE.Scene(),
      camera: new THREE.PerspectiveCamera(),
      renderer: {
        debug,
        info: { frame: 0, reset() {} },
        compileAsync: async () => {
          watchingDuringCompile.push(shaderStats().watching);
          debug.onNodeBuilderCreated?.({}, { object: new THREE.Mesh(), material: new THREE.MeshBasicNodeMaterial() });
        },
      },
      render() {},
      gpu: { frame() {}, drain: () => [] },
    } as unknown as RenderCtx;
    installShaderMonitor(ctx);
    try {
      await warmup(ctx, { frames: 1 }); // the probe's warm-up opens a watch window
      expect(shaderStats().watching).toBe(120);
      await warmup(ctx, { frames: 1 }); // the full warm-up right after compiles what the probe didn't draw
      expect(watchingDuringCompile).toEqual([0, 0]);
      expect(shaderStats().afterWarmup).toBe(0);
      expect(shaderStats().watching).toBe(120);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("warmShadowCasters", () => {
  const mat = new THREE.MeshStandardNodeMaterial();
  const geo = new THREE.BoxGeometry();
  function sceneWith(parts: THREE.Mesh[], others = 2) {
    const scene = new THREE.Scene();
    for (const m of parts) {
      m.castShadow = true;
      scene.add(m);
    }
    for (let i = 0; i < others; i++) scene.add(new THREE.Mesh(geo, mat));
    return scene;
  }
  const casting = (ms: THREE.Mesh[]) => ms.filter((m) => m.castShadow).length;

  it("adds casters a batch of predicted new builds per frame; casters sharing a build ride along", async () => {
    // 10 instanced meshes (a build each), then 20 plain meshes that share one material and layout.
    const inst = Array.from({ length: 10 }, () => new THREE.InstancedMesh(geo, mat, 4));
    const plain = Array.from({ length: 20 }, () => new THREE.Mesh(geo, mat));
    const all = [...inst, ...plain];
    const scene = sceneWith(all);
    const seen: number[] = [];
    const frames = await warmShadowCasters(scene, () => seen.push(casting(all)), async () => {});
    // 4 + 4 + (2 instanced + the first plain: a new build; then the other 19 plain cost nothing)
    expect(seen).toEqual([4, 8, 30]);
    expect(frames).toBe(3);
    expect(casting(all)).toBe(30);
    // a bigger batch when the programs link off the main thread
    const again = sceneWith(all.map((m) => { m.castShadow = false; return m; }));
    const wide: number[] = [];
    expect(await warmShadowCasters(again, () => wide.push(casting(all)), async () => {}, undefined, 8)).toBe(2);
    expect(wide).toEqual([8, 30]);
  });

  it("predicts builds: instanced and skinned always, plain meshes once per material and layout", () => {
    const seen = new Set<string>();
    expect(shadowBuildCost(new THREE.InstancedMesh(geo, mat, 2), seen)).toBe(1);
    expect(shadowBuildCost(new THREE.Mesh(geo, mat), seen)).toBe(1);
    expect(shadowBuildCost(new THREE.Mesh(geo, mat), seen)).toBe(0);
    expect(shadowBuildCost(new THREE.Mesh(new THREE.PlaneGeometry(), mat), seen)).toBe(0); // same attributes
    const other = new THREE.BufferGeometry();
    other.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3));
    expect(shadowBuildCost(new THREE.Mesh(other, mat), seen)).toBe(1); // no normals/uvs: another layout
    expect(shadowBuildCost(new THREE.Mesh(geo, new THREE.MeshStandardNodeMaterial()), seen)).toBe(1);
  });

  it("puts every caster back, keeps non-casters off, even when a frame throws", async () => {
    const parts = Array.from({ length: 10 }, () => new THREE.InstancedMesh(geo, mat, 2));
    const scene = sceneWith(parts, 3);
    await expect(warmShadowCasters(scene, () => {
      throw new Error("frame failed");
    }, async () => {})).rejects.toThrow("frame failed");
    expect(casting(parts)).toBe(10);
    const others = scene.children.filter((o) => !(parts as THREE.Object3D[]).includes(o));
    expect(others.every((o) => !o.castShadow)).toBe(true);
  });
});

/** three's Pipelines: a program compiles in parallel (a promise in the list) only when given a list. */
class FakePipelines {
  calls: { ro: string; parallel: boolean }[] = [];
  unfinished = 0;
  compiled = new Set<string>();
  private readonly started = new Set<string>();
  private readonly pipelines = new Map<string, object>();
  getForRender(ro: unknown, promises: Promise<unknown>[] | null = null) {
    const k = String(ro);
    this.calls.push({ ro: k, parallel: !!promises });
    if (this.started.has(k)) return ro;
    this.started.add(k);
    if (promises) {
      this.unfinished++;
      promises.push(new Promise<void>((r) => setTimeout(() => {
        this.unfinished--;
        this.compiled.add(k);
        r();
      }, 2)));
    } else {
      this.compiled.add(k);
    }
    return ro;
  }
}

/** …with three's draw check: a render object draws once its pipeline is compiled. */
class FakeDrawPipelines extends FakePipelines {
  private readonly byKey = new Map<string, object>();
  /** One vertex stage for every pipeline (three shares a stage per distinct source); null: each its own. */
  constructor(private readonly sharedVertex: { code: string } | null = null) {
    super();
  }
  get(ro: unknown) {
    const k = String(ro);
    // 12k characters of GLSL each: two fit the first batch's budget
    if (!this.byKey.has(k)) this.byKey.set(k, { k, vertexProgram: this.sharedVertex ?? { code: "v".repeat(4000) }, fragmentProgram: { code: "f".repeat(8000) } });
    return { pipeline: this.byKey.get(k) };
  }
  isReady(ro: unknown) {
    return this.compiled.has(String(ro));
  }
}

/** WebGL2 fences that the GPU signals on their second poll. */
function fakeFenceGl() {
  return {
    SYNC_GPU_COMMANDS_COMPLETE: 1, SYNC_STATUS: 2, SIGNALED: 3,
    fenceSync: () => ({ polls: 0 }),
    getSyncParameter: (s: { polls: number }) => (++s.polls >= 2 ? 3 : 0),
    deleteSync() {},
    flush() {},
  };
}

describe("warm-up report (per-phase times and shader counts) and progress", () => {
  /** A fake renderer on a hand-moved clock: compile items cost 10 ms and one build each, frames 5 ms. */
  let draws: string[][] = [];
  function fakeCtx(opts: {
    items: number; webgpu: boolean; shadows: boolean; frameBuilds?: number; pipelines?: FakePipelines; objects?: number;
    /** WebGL2 fences (fakeFenceGl); none by default. */
    gl?: ReturnType<typeof fakeFenceGl>;
    /** Each animation frame moves the clock this much (ms) before its callback. */
    frameMs?: number;
  }) {
    draws = [];
    let clock = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.stubGlobal("window", {});
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(() => {
      clock += opts.frameMs ?? 0;
      cb();
    }, 0));
    const debug: { onNodeBuilderCreated?: (builder: unknown, ro: unknown) => void } = {};
    const build = () => debug.onNodeBuilderCreated?.({}, { object: new THREE.Mesh(), material: new THREE.MeshBasicNodeMaterial() });
    const scene = new THREE.Scene();
    const geo = new THREE.BoxGeometry();
    const mat = new THREE.MeshStandardNodeMaterial();
    for (let i = 0; i < 6; i++) {
      const m = new THREE.InstancedMesh(geo, mat, 2); // a shadow build each
      m.castShadow = true;
      scene.add(m);
    }
    let frameBuilds = opts.frameBuilds ?? 0;
    const ctx = {
      scene,
      camera: new THREE.PerspectiveCamera(),
      webgpu: opts.webgpu,
      tier: "medium",
      settings: { on: { shadows: opts.shadows }, shadows: { mode: "map" } },
      renderer: {
        debug,
        info: { frame: 0, reset() {} },
        _pipelines: opts.pipelines,
        ...(opts.gl ? { backend: { gl: opts.gl } } : {}),
        compileAsync: async (_s: unknown, _c: unknown, _t: unknown, onProgress?: (e: { loaded: number; total: number }) => void) => {
          for (let i = 1; i <= opts.items; i++) {
            await Promise.resolve();
            clock += 10;
            build();
            // three: a per-object list, awaited before the next object
            const list: Promise<unknown>[] = [];
            opts.pipelines?.getForRender(`object ${i}`, list);
            await Promise.all(list);
            onProgress?.({ loaded: i, total: opts.items });
          }
        },
      },
      render() {
        if (opts.objects) {
          const p = opts.pipelines as FakeDrawPipelines;
          const drew: string[] = [];
          for (let i = 0; i < opts.objects; i++) {
            p.getForRender(`mesh ${i}`);
            if (p.isReady(`mesh ${i}`)) drew.push(`mesh ${i}`);
          }
          draws.push(drew);
        } else opts.pipelines?.getForRender("frame");
        clock += 5;
        if (frameBuilds > 0) {
          frameBuilds--;
          build();
        }
      },
      gpu: { frame() {}, drain: () => [] },
    } as unknown as RenderCtx;
    installShaderMonitor(ctx);
    return ctx;
  }

  it("compiles new programs side by side during the warm-up; the settle frame renders the way play does", async () => {
    const pipelines = new FakePipelines();
    const own = pipelines.getForRender;
    try {
      const ctx = fakeCtx({ items: 3, webgpu: false, shadows: true, pipelines });
      await warmup(ctx, { frames: 2 });
      const calls = pipelines.calls;
      expect(calls.filter((c) => c.ro.startsWith("object")).every((c) => c.parallel)).toBe(true);
      expect(calls.filter((c) => c.ro === "frame").slice(0, -1).every((c) => c.parallel)).toBe(true); // shadow + real frames
      expect(calls.at(-1)).toEqual({ ro: "frame", parallel: false }); // the settle frame: three's own path
      expect(pipelines.unfinished).toBe(0); // everything compiled before the loader goes
      expect(pipelines.getForRender).toBe(own); // three's method is back
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("WebGL2: spreads first draws over frames, and keeps drawing until every program has compiled and drawn once", async () => {
    const pipelines = new FakeDrawPipelines();
    const own = pipelines.isReady;
    try {
      const ctx = fakeCtx({ items: 0, webgpu: false, shadows: false, pipelines, objects: 12 });
      const r = await warmup(ctx, { frames: 1 });
      const settleFrame = draws.at(-1)!;
      const before = draws.slice(0, -1);
      const firstDraws = before.map((d, i) => d.filter((m) => !before.slice(0, i).some((p) => p.includes(m))).length);
      // at most one budget's worth (fewer if only some programs had compiled yet), not all twelve
      expect(firstDraws.find((n) => n > 0)).toBeLessThanOrEqual(FIRST_DRAWS_START / 12_000);
      expect(new Set(before.flat()).size).toBe(12); // every object drew once before the loader goes
      expect(settleFrame).toHaveLength(12);
      expect(r.phases.frames.drain).toBeGreaterThan(0);
      expect(pipelines.isReady).toBe(own);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("WebGPU: no first-draw budget (its pipelines are whole when compiled); waits for them without drawing", async () => {
    const pipelines = new FakeDrawPipelines();
    try {
      const ctx = fakeCtx({ items: 0, webgpu: true, shadows: false, pipelines, objects: 12 });
      const r = await warmup(ctx, { frames: 1 });
      expect(r.phases.frames.drain).toBe(0);
      expect(r.phases.frames.frames).toBe(2);
      expect(pipelines.unfinished).toBe(0);
      expect(draws.at(-1)).toHaveLength(12);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("times the scene-pass compile, compute compile, shadow frames and real frames, with the shaders built in each", async () => {
    try {
      const ctx = fakeCtx({ items: 5, webgpu: false, shadows: true, frameBuilds: 1 });
      const before = shaderStats().total;
      await warmup(ctx, { frames: 2, label: "arrival" });
      const r = lastWarmup()!;
      expect(r.label).toBe("arrival");
      expect(r.backend).toBe("webgl2");
      expect(r.tier).toBe("medium");
      expect(r.phases.compile).toEqual({ ms: 50, builds: 5, items: 5, wait: 0 }); // no three internals: nothing deferred
      expect(r.phases.compute).toEqual({ ms: 0, builds: 0, nodes: 0 }); // no compute nodes yet
      // 6 predicted shadow builds in batches of 4 (nothing deferred here): two frames, the first's build lands here
      expect(r.phases.shadows).toEqual({ ms: 10, builds: 1, frames: 2, predicted: 6, wait: 0 });
      expect(r.phases.frames).toEqual({ ms: 15, builds: 0, frames: 3, wait: 0, drain: 0 }); // 2 + the settle frame
      expect(r.ms).toBe(75);
      expect(r.end - r.start).toBe(75);
      expect(r.builds).toBe(6);
      expect(r.shaders).toBe(before + 6);
      expect(shaderStats().warmups.at(-1)).toBe(r); // what the e2e hook reads
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("reports progress: the bar moves forward with every bit of work and ends at 100%", async () => {
    try {
      const ctx = fakeCtx({ items: 5, webgpu: true, shadows: true });
      const events: WarmupProgress[] = [];
      await warmup(ctx, { frames: 2, onProgress: (p) => events.push({ ...p }) });
      expect(events.length).toBeGreaterThanOrEqual(10); // 5 objects, 2 shadow batches, 2 frames, the end
      for (let i = 1; i < events.length; i++) {
        expect(events[i]!.frac).toBeGreaterThan(events[i - 1]!.frac); // every event is work done: it moves
        expect(events[i]!.ready).toBeLessThanOrEqual(events[i]!.programs);
      }
      expect(events.at(-1)).toEqual({ ready: 5, programs: 5, frac: 1 }); // nothing deferred: builds are programs
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("labels GPU programs that have compiled, not objects prepared", async () => {
    const pipelines = new FakePipelines();
    try {
      const ctx = fakeCtx({ items: 4, webgpu: false, shadows: false, pipelines });
      const events: WarmupProgress[] = [];
      await warmup(ctx, { frames: 1, onProgress: (p) => events.push({ ...p }) });
      const duringCompile = events.filter((e) => e.programs > 0 && e.frac < 0.5);
      expect(duringCompile.some((e) => e.ready < e.programs)).toBe(true); // prepared, still compiling on the GPU
      expect(events.at(-1)).toEqual({ ready: 5, programs: 5, frac: 1 }); // 4 objects + the frames' pipeline
      for (let i = 1; i < events.length; i++) expect(events[i]!.frac).toBeGreaterThanOrEqual(events[i - 1]!.frac);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("still ends at 100% without shadows or compile items", async () => {
    try {
      const ctx = fakeCtx({ items: 0, webgpu: false, shadows: false });
      const events: WarmupProgress[] = [];
      await warmup(ctx, { frames: 1, onProgress: (p) => events.push({ ...p }) });
      expect(events.at(-1)!.frac).toBe(1);
      expect(lastWarmup()!.phases.shadows).toEqual({ ms: 0, builds: 0, frames: 0, predicted: 0, wait: 0 });
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("?warmdiag logs every fenced first-draw batch in send order: when, GPU ms, charged units, characters, links pending, stage hashes", async () => {
    vi.spyOn(flags, "has").mockImplementation((n) => n === "warmdiag");
    const shared = { code: "v".repeat(4000) };
    const pipelines = new FakeDrawPipelines(shared);
    try {
      const ctx = fakeCtx({ items: 0, webgpu: false, shadows: false, pipelines, objects: 12, gl: fakeFenceGl() });
      const r = await warmup(ctx, { frames: 1 });
      const b = r.batches!;
      expect(b.length).toBe(r.firstDraws.batches); // every batch, not the slowest 20
      expect(b.length).toBeGreaterThan(1);
      const ts = b.map((x) => x.t);
      expect(ts).toEqual([...ts].sort((x, y) => x - y)); // in the order they were sent
      expect(b.reduce((n, x) => n + x.items.length, 0)).toBe(r.firstDraws.granted);
      for (const x of b) {
        expect(x.n).toBe(x.items.length);
        expect(x.chars).toBe(x.items.reduce((n, i) => n + i.vs + i.fs, 0));
        expect(x.newChars).toBe(x.items.reduce((n, i) => n + i.newChars, 0));
        expect(x.used).toBe(x.items.reduce((n, i) => n + i.cost, 0));
        expect(x.ms).toBeGreaterThanOrEqual(0);
        expect(x.pending).toBeGreaterThanOrEqual(0);
        expect(x.skinnedShadow).toBe(0);
      }
      const items = b.flatMap((x) => x.items);
      expect(items[0]!.vh).toBe(fnv1a(shared.code));
      expect(items[0]!.fh).toBe(fnv1a("f".repeat(8000)));
      // the shared vertex stage is new only for the first pipeline drawn
      expect(items.map((i) => i.newChars)).toEqual([12_000, ...Array(11).fill(8000)]);
      expect(r.census).toEqual({ pipelines: 12, skinnedShadow: 0, skinnedMain: 0, vertexStages: 1, fragmentStages: 1, skinnedVertexStages: 0 });
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("prices a first draw by its stages new to the GPU plus an overhead; ?oldpacer by its whole program", async () => {
    for (const old of [false, true]) {
      vi.spyOn(flags, "has").mockImplementation((n) => n === "warmdiag" || (old && n === "oldpacer"));
      const pipelines = new FakeDrawPipelines({ code: "v".repeat(4000) }); // one vertex stage for all
      try {
        const ctx = fakeCtx({ items: 0, webgpu: false, shadows: false, pipelines, objects: 4, gl: fakeFenceGl() });
        const r = await warmup(ctx, { frames: 1 });
        const costs = r.batches!.flatMap((b) => b.items.map((i) => i.cost));
        expect(costs).toEqual(old ? [12_000, 12_000, 12_000, 12_000] : [PIPELINE_OVERHEAD + 12_000, ...Array(3).fill(PIPELINE_OVERHEAD + 8000)]);
      } finally {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
      }
    }
  });

  it("?warmsolo (diagnostics): one first draw per fenced batch", async () => {
    vi.spyOn(flags, "has").mockImplementation((n) => n === "warmdiag" || n === "warmsolo");
    const pipelines = new FakeDrawPipelines();
    try {
      const ctx = fakeCtx({ items: 0, webgpu: false, shadows: false, pipelines, objects: 6, gl: fakeFenceGl() });
      const r = await warmup(ctx, { frames: 1 });
      expect(r.batches!.map((x) => x.items.length)).toEqual([1, 1, 1, 1, 1, 1]);
      expect(r.firstDraws.granted).toBe(6);
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("records slow frames in every phase, the compile included, with when, the batch in flight and links pending", async () => {
    for (const diag of [false, true]) {
      vi.spyOn(flags, "has").mockImplementation((n) => diag && n === "warmdiag");
      const pipelines = new FakeDrawPipelines();
      try {
        // every animation frame takes 120 ms: all of them are slow
        const ctx = fakeCtx({ items: 4, webgpu: false, shadows: false, pipelines, objects: 12, gl: fakeFenceGl(), frameMs: 120 });
        const r = await warmup(ctx, { frames: 1 });
        const phases = new Set(r.slow.map((s) => s.phase));
        expect(phases.has("compile")).toBe(true); // waiting for the links
        expect(phases.has("drain")).toBe(true);
        for (const s of r.slow) {
          expect(s.ms).toBeGreaterThan(100);
          expect(s.t).toBeGreaterThan(r.start);
          expect(s.t).toBeLessThanOrEqual(r.end);
          expect(s.pending).toBeGreaterThanOrEqual(0);
          expect(typeof s.inFlight).toBe("boolean");
        }
        expect(r.slow.some((s) => s.phase === "compile" && s.pending > 0)).toBe(true);
        expect(r.slow.some((s) => s.phase === "drain" && s.inFlight && s.batch !== null)).toBe(true);
        if (diag) {
          expect(r.slow.length).toBeGreaterThan(12); // all of them, in time order
          const ts = r.slow.map((s) => s.t);
          expect(ts).toEqual([...ts].sort((x, y) => x - y));
        } else {
          expect(r.slow.length).toBeLessThanOrEqual(12); // the longest dozen
        }
      } finally {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
      }
    }
  });

  it("predicts the shadow phase's builds the way the batching counts them", () => {
    const scene = new THREE.Scene();
    const geo = new THREE.BoxGeometry();
    const mat = new THREE.MeshStandardNodeMaterial();
    for (let i = 0; i < 3; i++) {
      const m = new THREE.InstancedMesh(geo, mat, 2);
      m.castShadow = true;
      scene.add(m);
    }
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      scene.add(m);
    }
    scene.add(new THREE.Mesh(geo, new THREE.MeshStandardNodeMaterial())); // not a caster
    expect(predictShadowBuilds(scene)).toBe(4);
  });
});

describe("fnv1a (the diagnostics' 32-bit hash of a shader stage's source)", () => {
  it("matches the reference FNV-1a values", () => {
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(0xe40c292c);
    expect(fnv1a("foobar")).toBe(0xbf9cf968);
  });
});

describe("MovingProgress (the bar toward a total that is still being discovered)", () => {
  it("is exactly done/total when the total is known from the start", () => {
    const p = new MovingProgress();
    expect(p.update(25, 100)).toBeCloseTo(0.25);
    expect(p.update(50, 100)).toBeCloseTo(0.5);
    expect(p.update(100, 100)).toBeCloseTo(1);
  });

  it("keeps moving on every bit of work while the total grows, never backwards, never past 100%", () => {
    const p = new MovingProgress();
    let prev = 0;
    for (let done = 1; done <= 200; done++) {
      const f = p.update(done, 50 + done * 2); // more work keeps turning up
      expect(f).toBeGreaterThan(prev);
      expect(f).toBeLessThan(1);
      prev = f;
    }
    expect(p.update(200, 150)).toBe(prev); // a smaller total later changes nothing by itself
    expect(p.update(200, 200)).toBe(prev); // no new work: the bar holds
    expect(p.update(260, 260)).toBeCloseTo(1); // all done
  });
});
