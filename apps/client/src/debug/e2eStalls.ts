// Test-only: the shop stall checks for the e2e hook (#22, `__fl.stalls`; debug/e2eHook.ts). Reads the
// game through narrow structural types, like the hook, and changes nothing in it except for the two
// frames a coverage measurement hides the stall in (then puts everything back).
//
//   info()          the body's shop: the keeper, its frame (x right, y up, z toward the customers) and
//                   the stall's centre, for placing the player round it
//   camera()        the camera now: inside a stall volume (its counter or awning: the shared solid or a
//                   camera-only one), and the label's depth in front of it with its fade
//   coverage()      async: the share of the screen the stall, its keeper and its label cover in the
//                   frames drawn now, by drawing them with and without each (pixel differences), and
//                   the stall's volume across the view by rays (`geo`: an outpost's stall is part of the
//                   town mesh, so it can't be hidden for the pixel measure)
//   watch.start()   every drawn frame from now: is the camera inside a stall volume, how close is the label;
//   watch.stop()    → { frames, inside, minLabelDepth, minVisibleLabelDepth (drawn at > 2 % opacity) }

interface V {
  x: number;
  y: number;
  z: number;
}
interface Obj3 {
  name: string;
  visible: boolean;
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
    camera?: { position: V; matrixWorld: { elements: ArrayLike<number> }; matrixWorldInverse: { elements: ArrayLike<number> }; projectionMatrixInverse: { elements: ArrayLike<number> } };
    renderer?: { domElement?: HTMLCanvasElement };
  };
  planet?: { terrain?: unknown };
  systems?: unknown[];
}

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

  /**
   * The stall's whole drawn volume as boxes (no padding): its camera-only pieces and its shared
   * solids (Juno's counter; an outpost stall's whole-stall box).
   */
  const stallVolumes = (body: string, terrain: Terrain) => {
    const m = mods!;
    const pieces = m.stall.stallCameraBoxes(terrain).map((b) => ({ ...b, h: [b.h[0] - b.pad, b.h[1] - b.pad, b.h[2] - b.pad] as const, pad: 0 }));
    const site = m.outposts.OUTPOSTS[body as keyof typeof m.outposts.OUTPOSTS];
    const frame = body === "portus" ? m.sites.plazaFacingPlacement("juno_vale", terrain as never) : site ? m.sites.sitePlacements(terrain as never)[site.shop.item] : null;
    const solids = body === "portus" ? m.sites.JUNO_COUNTER_SOLIDS : frame && site ? site.prefabs[frame.prefab]!.solids : [];
    const boxes = frame ? m.stall.placeStallBoxes(frame, solids.map(([, cx, cz, hx, hz, y0, y1]) => ({ x: cx, y: (y0 + y1) / 2, z: cz, w: 2 * hx, h: y1 - y0, d: 2 * hz })), 0) : [];
    return [...pieces, ...boxes];
  };

  /** Share of the view (a 48 × 27 grid of rays from the lens) that meets the stall's volume, ignoring what hides it. */
  const geometricShare = (g: StallGame) => {
    const cam = g.ctx?.camera;
    const terrain = g.planet?.terrain as Terrain | undefined;
    if (!cam || !terrain || !mods) return null;
    const vols = stallVolumes(g.bodyId ?? "", terrain);
    const o = cam.position;
    if (mods.stall.inCameraBox(vols, o.x, o.y, o.z)) return 1;
    const pi = cam.projectionMatrixInverse.elements, mw = cam.matrixWorld.elements;
    let hit = 0, n = 0;
    for (let j = 0; j < 27; j++) {
      for (let i = 0; i < 48; i++) {
        const u = ((i + 0.5) / 48) * 2 - 1, v = 1 - ((j + 0.5) / 27) * 2;
        // NDC (u, v, 0.5) → view space → world direction.
        const x = pi[0]! * u + pi[4]! * v + pi[8]! * 0.5 + pi[12]!;
        const y = pi[1]! * u + pi[5]! * v + pi[9]! * 0.5 + pi[13]!;
        const z = pi[2]! * u + pi[6]! * v + pi[10]! * 0.5 + pi[14]!;
        const dx = mw[0]! * x + mw[4]! * y + mw[8]! * z, dy = mw[1]! * x + mw[5]! * y + mw[9]! * z, dz = mw[2]! * x + mw[6]! * y + mw[10]! * z;
        const l = Math.hypot(dx, dy, dz);
        n++;
        if (mods.stall.cameraBoxRay(vols, o.x, o.y, o.z, dx / l, dy / l, dz / l, 60) < Infinity) hit++;
      }
    }
    return hit / n;
  };

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
    const boxes = mods.stall.stallCameraBoxes(terrain).map((b) => ({ ...b, h: [b.h[0] - b.pad, b.h[1] - b.pad, b.h[2] - b.pad] as const, pad: 0 }));
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

  const coverage = async (opts: { width?: number; height?: number; threshold?: number } = {}) => {
    await load();
    const g = game();
    const k = g && keeperOf(g);
    if (!g || !k) return null;
    const w = opts.width ?? 192, h = opts.height ?? 108, th = opts.threshold ?? 24;
    const label = labelOf(k);
    const stallMeshes: Obj3[] = [];
    k.root.traverse((o) => { if (o.isMesh) stallMeshes.push(o); });
    const keeperMeshes: Obj3[] = [];
    k.npc?.root.traverse((o) => { if (o.isMesh) keeperMeshes.push(o); });
    const masks = new Map<Obj3, number>();
    const labelWasVisible = label?.visible ?? false;
    const state = cameraNow();
    const geo = geometricShare(g);
    try {
      const all = await capture(w, h);
      if (label) label.visible = false;
      const noLabel = await capture(w, h);
      for (const m of stallMeshes) masks.set(m, m.layers.mask), m.layers.set(SHADOW_ONLY_LAYER);
      const noStall = await capture(w, h);
      for (const m of keeperMeshes) masks.set(m, m.layers.mask), m.layers.set(SHADOW_ONLY_LAYER);
      const none = await capture(w, h);
      const again = await capture(w, h);
      return {
        label: differ(all, noLabel, th),
        stall: differ(noLabel, noStall, th),
        keeper: differ(noStall, none, th),
        total: differ(all, none, th),
        noise: differ(none, again, th),
        /** The stall's volume across the view (rays; covers the outposts' stalls, drawn in the town mesh). */
        geo,
        camera: state,
      };
    } finally {
      if (label) label.visible = labelWasVisible;
      for (const [m, mask] of masks) m.layers.mask = mask;
    }
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

  return { info, camera: async () => (await load(), cameraNow()), coverage, watch };
}
