// Test-only: the shop stall checks for the e2e hook (#22, `__fl.stalls`; debug/e2eHook.ts). Reads the
// game through narrow structural types, like the hook, and changes nothing in it except for the few
// frames a coverage measurement hides parts of the stall in (then puts everything back).
//
//   info()          the body's shop: the keeper, its frame (x right, y up, z toward the customers) and
//                   the stall's centre, for placing the player round it
//   camera()        the camera now: inside a stall volume (its counter or awning: the shared solid or a
//                   camera-only one), and the label's depth in front of it with its fade
//   settle()        async: resolves once the camera has stopped moving (it eases out from a wall at
//                   0.25 m a frame), with the frames it took
//   standable(p)    can a player stand at world point p (no structure solid there)? For approaches a
//                   wall may close off
//   coverage()      async: the share of the screen the label, the awning, the rest of the stall, the
//                   keeper and the player's own avatar each cover in the frames drawn now, by drawing them with and without
//                   each (pixel differences). Juno's stall is QuestWorld's; an outpost's is the site
//                   mesh baked on its own (SiteTown ":stall"), its awning the triangles above 1.95 m.
//   watch.start()   every drawn frame from now: is the camera inside a stall volume, how close is the label;
//   watch.stop()    → { frames, inside, minLabelDepth, minVisibleLabelDepth (drawn at > 2 % opacity) }

interface V {
  x: number;
  y: number;
  z: number;
}
interface IndexLike {
  count: number;
  array: ArrayLike<number>;
}
interface Obj3 {
  name: string;
  visible: boolean;
  geometry?: { index: IndexLike | null; attributes: { position: { array: ArrayLike<number> } }; setIndex(i: unknown): void };
  isMesh?: boolean;
  isSprite?: boolean;
  children: Obj3[];
  layers: { mask: number; set(n: number): void };
  matrixWorld: { elements: ArrayLike<number> };
  traverse(cb: (o: Obj3) => void): void;
}
interface PropLike {
  def: { id: string; look?: string };
  root: Obj3;
  pos: V;
  facing?: V;
  npc?: { root: Obj3 };
}
interface StallGame {
  bodyId?: string;
  ctx?: {
    render?: () => void;
    camera?: { position: V; matrixWorldInverse: { elements: ArrayLike<number> } };
    renderer?: { domElement?: HTMLCanvasElement };
  };
  planet?: { terrain?: unknown; town?: { group: Obj3 } | null };
  systems?: unknown[];
  /** The local player's avatar. */
  self?: { root: Obj3 } | null;
}

/** An outpost stall's awning: its triangles wholly above this height (m, prefab frame; the valance hangs to 1.98). */
const AWNING_FROM = 1.95;

/** Layer only the sun's shadow camera draws (render/atmosphere.ts SHADOW_ONLY_LAYER): hidden, shadow kept. */
const SHADOW_ONLY_LAYER = 5;

const sub = (a: V, b: V) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const len = (a: V) => Math.hypot(a.x, a.y, a.z);

export function stallTools(game: () => StallGame | null) {
  const world = (g: StallGame) =>
    ((g.systems ?? []).map((s) => (s as { world?: { props?: unknown } }).world).find((w) => Array.isArray(w?.props)) as { props: PropLike[] } | undefined) ?? null;
  const keeperOf = (g: StallGame) => world(g)?.props.find((p) => p.def.look === "keeper") ?? null;
  const labelOf = (k: PropLike): Obj3 | null => k.root.children.find((c) => c.isSprite) ?? null;

  let mods: {
    stall: typeof import("../world/stallCamera.ts");
    sites: typeof import("@firstlight/shared/planet/sites");
    outposts: typeof import("@firstlight/shared/content/padOutposts");
    label: typeof import("../render/labelFade.ts");
  } | null = null;
  const load = async () =>
    (mods ??= {
      stall: await import("../world/stallCamera.ts"),
      sites: await import("@firstlight/shared/planet/sites"),
      outposts: await import("@firstlight/shared/content/padOutposts"),
      label: await import("../render/labelFade.ts"),
    });
  type Terrain = Parameters<typeof import("../world/stallCamera.ts").stallCameraBoxes>[0];

  /** The keeper's frame axes in planet space (QuestWorld's root: columns of its world matrix). */
  const frameOf = (k: PropLike) => {
    const e = k.root.matrixWorld.elements;
    const col = (i: number) => {
      const v = { x: e[i * 4]!, y: e[i * 4 + 1]!, z: e[i * 4 + 2]! };
      const l = len(v) || 1;
      return { x: v.x / l, y: v.y / l, z: v.z / l };
    };
    return { origin: { x: e[12]!, y: e[13]!, z: e[14]! }, right: col(0), up: col(1), front: col(2) };
  };

  const info = () => {
    const g = game();
    const k = g && keeperOf(g);
    if (!g || !k) return null;
    const f = frameOf(k);
    // The stall's middle: Juno's counter and awning stand ~0.6 m in front of her; an outpost keeper is
    // 0.35 m behind the middle of the outpost's stall (padOutposts shop.at).
    const ahead = g.bodyId === "portus" ? 0.6 : 0.35;
    const centre = { x: f.origin.x + f.front.x * ahead, y: f.origin.y + f.front.y * ahead, z: f.origin.z + f.front.z * ahead };
    return { body: g.bodyId ?? null, id: k.def.id, keeper: [k.pos.x, k.pos.y, k.pos.z], centre: [centre.x, centre.y, centre.z], right: [f.right.x, f.right.y, f.right.z], up: [f.up.x, f.up.y, f.up.z], front: [f.front.x, f.front.y, f.front.z] };
  };

  /** Camera state now; needs the stall modules (loaded by any async call first). */
  const cameraNow = () => {
    const g = game();
    const cam = g?.ctx?.camera;
    const k = g && keeperOf(g);
    const terrain = g?.planet?.terrain as Parameters<typeof import("../world/stallCamera.ts").stallCameraBoxes>[0] | undefined;
    if (!g || !cam || !k || !terrain || !mods) return null;
    const p = cam.position;
    const boxes = mods.stall.stallCameraBoxes(terrain).map(mods.stall.unpadded);
    const inAwning = mods.stall.inCameraBox(boxes, p.x, p.y, p.z);
    const solid = mods.sites.structureCollider(terrain as never).footing(p.x, p.y, p.z, 0, { radius: 0.01, height: 0.01, step: 0 }).inside;
    const label = labelOf(k);
    let labelDepth: number | null = null;
    let labelOpacity: number | null = null;
    if (label) {
      const e = label.matrixWorld.elements;
      const w = { x: e[12]!, y: e[13]!, z: e[14]! };
      const m = cam.matrixWorldInverse.elements;
      labelDepth = -(m[2]! * w.x + m[6]! * w.y + m[10]! * w.z + m[14]!);
      // What it is drawn with: the near-camera fade where its material has it (#22), else whole.
      const mat = (label as unknown as { material: Parameters<typeof mods.label.hasLabelFade>[0] }).material;
      labelOpacity = !label.visible || labelDepth <= 0 ? 0 : mods.label.hasLabelFade(mat) ? mods.label.labelFade(labelDepth) : 1;
    }
    return { inside: inAwning || solid, inAwning, inSolid: solid, labelDepth, labelOpacity, keeperDistance: len(sub(p, k.pos)) };
  };

  // ---- coverage: frames drawn with and without the stall's parts

  const capture = (w: number, h: number): Promise<Uint8ClampedArray> =>
    new Promise((resolve, reject) => {
      const g = game();
      const ctx = g?.ctx;
      const canvas = ctx?.renderer?.domElement;
      if (!ctx?.render || !canvas) return reject(new Error("no game canvas"));
      const own = Object.prototype.hasOwnProperty.call(ctx, "render");
      const original = ctx.render;
      ctx.render = function (this: unknown, ...args: unknown[]) {
        const r = (original as (...a: unknown[]) => unknown).apply(ctx, args);
        if (own) ctx.render = original;
        else delete (ctx as { render?: unknown }).render;
        // Same task as the render: the drawing buffer still holds this frame.
        createImageBitmap(canvas, { resizeWidth: w, resizeHeight: h, resizeQuality: "medium" })
          .then((bmp) => {
            const c = document.createElement("canvas");
            c.width = w;
            c.height = h;
            const c2 = c.getContext("2d", { willReadFrequently: true })!;
            c2.drawImage(bmp, 0, 0);
            bmp.close();
            resolve(c2.getImageData(0, 0, w, h).data);
          })
          .catch(reject);
        return r;
      } as typeof original;
    });

  /** Share of pixels whose colour differs by more than `threshold` (0–255, any channel). */
  const differ = (a: Uint8ClampedArray, b: Uint8ClampedArray, threshold: number) => {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (Math.max(Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!), Math.abs(a[i + 2]! - b[i + 2]!)) > threshold) n++;
    }
    return n / (a.length / 4);
  };

  /** The outpost stall's meshes (both LOD variants), or none (Portus: Juno's stall is QuestWorld's). */
  const outpostStall = (g: StallGame): Obj3[] => {
    const out: Obj3[] = [];
    g.planet?.town?.group.traverse((o) => { if (o.isMesh && o.name.endsWith(":stall")) out.push(o); });
    return out;
  };

  /** Per stall mesh: its index without the awning's triangles (cached; the geometry never changes). */
  const withoutAwning = new WeakMap<Obj3, Uint32Array>();
  const noAwningIndex = (g: StallGame, m: Obj3): Uint32Array | null => {
    let idx = withoutAwning.get(m);
    if (idx) return idx;
    const m0 = mods!;
    const site = m0.outposts.OUTPOSTS[g.bodyId as keyof typeof m0.outposts.OUTPOSTS];
    const p = site && m0.sites.sitePlacements(g.planet!.terrain as never)[site.shop.item];
    const index = m.geometry?.index;
    if (!p || !index) return null;
    const pos = m.geometry!.attributes.position.array;
    const lift = (v: number) => ((pos[v * 3]! - p.px) * p.ux + (pos[v * 3 + 1]! - p.py) * p.uy + (pos[v * 3 + 2]! - p.pz) * p.uz) / p.scale;
    const keep: number[] = [];
    for (let t = 0; t < index.count; t += 3) {
      const a = index.array[t]!, b = index.array[t + 1]!, c = index.array[t + 2]!;
      if (lift(a) >= AWNING_FROM && lift(b) >= AWNING_FROM && lift(c) >= AWNING_FROM) continue;
      keep.push(a, b, c);
    }
    idx = Uint32Array.from(keep);
    withoutAwning.set(m, idx);
    return idx;
  };

  const coverage = async (opts: { width?: number; height?: number; threshold?: number } = {}) => {
    await load();
    const g = game();
    const k = g && keeperOf(g);
    if (!g || !k) return null;
    const w = opts.width ?? 192, h = opts.height ?? 108, th = opts.threshold ?? 24;
    const label = labelOf(k);
    // Juno's stall: QuestWorld's meshes under her root (the awning its own); an outpost's: the site's stall mesh.
    const quest: Obj3[] = [];
    k.root.traverse((o) => { if (o.isMesh) quest.push(o); });
    const outpost = outpostStall(g);
    const awningMeshes = quest.filter((m) => m.name === "stall:awning");
    const rest = [...quest.filter((m) => m.name !== "stall:awning"), ...outpost];
    const keeperMeshes: Obj3[] = [];
    k.npc?.root.traverse((o) => { if (o.isMesh) keeperMeshes.push(o); });
    const selfMeshes: Obj3[] = [];
    g.self?.root.traverse((o) => { if (o.isMesh) selfMeshes.push(o); });
    const masks = new Map<Obj3, number>();
    const indices = new Map<Obj3, unknown>();
    const hide = (ms: Obj3[]) => { for (const m of ms) if (!masks.has(m)) masks.set(m, m.layers.mask), m.layers.set(SHADOW_ONLY_LAYER); };
    const labelWasVisible = label?.visible ?? false;
    const state = cameraNow();
    try {
      const all = await capture(w, h);
      if (label) label.visible = false;
      const noLabel = await capture(w, h);
      hide(awningMeshes);
      for (const m of outpost) {
        const idx = noAwningIndex(g, m);
        if (!idx || !m.geometry) continue;
        indices.set(m, m.geometry.index);
        m.geometry.setIndex(Array.from(idx));
      }
      const noAwning = await capture(w, h);
      hide(rest);
      const noStall = await capture(w, h);
      hide(keeperMeshes);
      const noKeeper = await capture(w, h);
      hide(selfMeshes);
      const none = await capture(w, h);
      const again = await capture(w, h);
      return {
        label: differ(all, noLabel, th),
        awning: differ(noLabel, noAwning, th),
        /** The rest of the stall: counter, posts, goods, sign, the outpost stall's walls. */
        stall: differ(noAwning, noStall, th),
        keeper: differ(noStall, noKeeper, th),
        /** The player's own avatar, with what it holds and wears. */
        self: differ(noKeeper, none, th),
        total: differ(all, none, th),
        noise: differ(none, again, th),
        parts: { awning: awningMeshes.length + outpost.length, stall: rest.length },
        camera: state,
      };
    } finally {
      if (label) label.visible = labelWasVisible;
      for (const [m, mask] of masks) m.layers.mask = mask;
      for (const [m, index] of indices) m.geometry?.setIndex(index);
    }
  };

  /** Resolves when the camera has moved under 1 mm for 3 drawn frames in a row (at most `max` frames). */
  const settle = (max = 120) =>
    new Promise<{ frames: number; settled: boolean }>((resolve) => {
      const cam = game()?.ctx?.camera;
      if (!cam) return resolve({ frames: 0, settled: false });
      let last = { x: cam.position.x, y: cam.position.y, z: cam.position.z };
      let still = 0, frames = 0;
      const tick = () => {
        frames++;
        const p = cam.position;
        still = len(sub(p, last)) < 0.001 ? still + 1 : 0;
        last = { x: p.x, y: p.y, z: p.z };
        if (still >= 3 || frames >= max) resolve({ frames, settled: still >= 3 });
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

  /** Can a player stand at world point (x, y, z) (feet, any height: snapped to the ground there)? */
  const standable = async (x: number, y: number, z: number) => {
    await load();
    const terrain = game()?.planet?.terrain as { body: { radius: number }; groundHeight(x: number, y: number, z: number): number } | undefined;
    if (!terrain) return null;
    const l = Math.hypot(x, y, z);
    const r = terrain.body.radius + terrain.groundHeight(x / l, y / l, z / l);
    return mods!.sites.structureCollider(terrain as never).isClear({ x: (x / l) * r, y: (y / l) * r, z: (z / l) * r });
  };

  // ---- watch: every frame

  let watching: { stop(): void; frames: number; inside: number; minLabelDepth: number; minVisibleLabelDepth: number; worst: unknown[] } | null = null;
  const watch = {
    start: async () => {
      await load();
      if (watching) return true;
      const st = { frames: 0, inside: 0, minLabelDepth: Infinity, minVisibleLabelDepth: Infinity, worst: [] as unknown[], stop: () => {} };
      let on = true;
      const tick = () => {
        if (!on) return;
        const c = cameraNow();
        if (c) {
          st.frames++;
          if (c.inside) {
            st.inside++;
            if (st.worst.length < 10) st.worst.push(c);
          }
          if (c.labelDepth !== null && c.labelDepth > 0) {
            st.minLabelDepth = Math.min(st.minLabelDepth, c.labelDepth);
            if ((c.labelOpacity ?? 0) > 0.02) st.minVisibleLabelDepth = Math.min(st.minVisibleLabelDepth, c.labelDepth);
          }
        }
        requestAnimationFrame(tick);
      };
      st.stop = () => void (on = false);
      watching = st;
      requestAnimationFrame(tick);
      return true;
    },
    stop: () => {
      const s = watching;
      if (!s) return null;
      s.stop();
      watching = null;
      const fin = (v: number) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
      return { frames: s.frames, inside: s.inside, minLabelDepth: fin(s.minLabelDepth), minVisibleLabelDepth: fin(s.minVisibleLabelDepth), worst: s.worst };
    },
  };

  return { info, camera: async () => (await load(), cameraNow()), settle, standable, coverage, watch };
}
