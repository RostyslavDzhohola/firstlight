// A body's structure sites on the client (D38, D42): the Portus castle town, or a planet's pad-0
// outpost with a landing platform and a waystone at each other pad. Placements come from the shared
// sites (planet/sites.ts), so what is drawn stands exactly where the shared colliders block; the
// geometry comes from the shipped GLB (render/townAssets.ts).
//
// Draw-call budget: a site is static, so at load every placed prefab is baked into merged meshes
// per ground cell (CELL m squares in the site frame), two variants per cell (LOD0: full houses and
// trees; LOD1: roof shells and tree cards; walls, props and paving in both) and two materials
// (opaque, cutout). Each frame one variant per cell is shown (the camera's distance to the cell,
// the tier's LOD distance; Low always shows LOD1 and drops normal maps), cells below the horizon
// are hidden, and three frustum-culls the rest. All meshes share two materials, so the warm-up
// (which shows every hidden mesh) compiles the site's pipelines once. On a planet the outpost's
// paths are ground decals built here from the shared path data (the same strips the grass mask
// clears), and the other pads' platforms and waystones are one instanced mesh per material (one
// fixed offset between the two at every pad: sites.ts waystonePlacement), drawn at the pads in range.
//
// Fallback: if the asset can't load, or hasn't arrived by TOWN_LOAD_DEADLINE_MS, the collider solids
// are drawn as plain stone boxes and cylinders (two instanced draws) before the quality probe and
// the warm-up, so nothing blocks the player invisibly and nothing compiles in play (on a planet the
// old pad discs stay: Portals.setPadModels). A later completion is kept, not ignored (D-load-6): the
// next loading screen on this body swaps it in before its warm-up (swapInLate), and the next
// arrival uses the cached asset.

import * as THREE from "three/webgpu";
import { padDirs, type Terrain } from "@firstlight/shared";
import { OUTPOSTS, type OutpostBody } from "@firstlight/shared/content/padOutposts";
import { TOWN_LAYOUT } from "@firstlight/shared/content/portusTown";
import {
  padPlatformPlacement, sitePlacements, sitePrefabs, siteSolids, structureCollider, TOWN_BODY,
  type StructureCollider,
} from "@firstlight/shared/planet/sites";
import type { TownPlacement } from "@firstlight/shared/planet/townFrame";
import { flags } from "../config.ts";
import type { MoveColliders } from "../game/PlayerController.ts";
import { SHADOW_ONLY_LAYER } from "../render/atmosphere.ts";
import type { ResolvedSettings } from "../render/quality.ts";
import { preloadSite, type SiteId, type TownAssets, type TownPart, type TownSlot } from "../render/townAssets.ts";
import { TOWN_EMISSIVE, townFallbackMaterial, townMaterial, type TownMaterialKind } from "../render/townMaterial.ts";
import { conformDecal } from "./townDecal.ts";
import { outpostPaths } from "./outpostPaths.ts";
import { cameraBoxRay, stallCameraBoxes } from "./stallCamera.ts";

/**
 * Ground cell size (m) and the half extent of the cell grid around the site's centre. Measured at
 * the Portus spawn views (portusTown.test.ts): 32 m cells cost 19–23 draws + 19 shadow draws on
 * Medium, 64 m cells 8–12 + 10, 96 m cells 6 + 8, one cell 2 + 2, while frustum culling saved under
 * 15 % of the triangles (from the plaza nearly the whole town is in view). So the whole town is one
 * cell: one opaque and one cutout draw (+ the same two in the shadow map), LOD per tier. An outpost
 * (within 64 m of pad 0) is one cell too.
 */
export const TOWN_CELL = 192;
const GRID_HALF = 96;
const GRID_N = Math.round((2 * GRID_HALF) / TOWN_CELL);

/**
 * Prefabs wider than this (m) are ground decals spanning the town (Portus' paving): laid onto the
 * ground where it rises off the flat floor (townDecal.ts), and their triangles split between cells.
 */
const DECAL_RADIUS = 30;

/**
 * How long an arrival waits for the site asset (ms) before it shows the fallback instead (D-load-6;
 * was 18 s). A hung download is aborted before it (townAssets.ts TOWN_FETCH_TIMEOUT_MS: no byte for
 * 45 s); a slow one that is still receiving goes on, and swapInLate puts it in at the next loading screen.
 */
export const TOWN_LOAD_DEADLINE_MS = 50_000;

/**
 * Shadows (Medium+ shadow map). The drawn opaque site casts nothing; a shadow-only copy of it casts
 * instead, on SHADOW_ONLY_LAYER (render/atmosphere.ts: only the sun's shadow camera renders it).
 * It holds positions only, with a plain material, so the shadow pass doesn't sample the site's
 * texture arrays; it leaves out what can't change a shadow map texel (the paving and paths lying on
 * the ground, the window glass inset in the walls) and uses the roof shells for buildings (the same
 * silhouette; the tile relief is below a texel). The cutout meshes (leaves, vines) cast themselves:
 * they need their alpha. Measured against cutting the shadow copy into 16–48 m cells that the shadow
 * camera culls: from the plaza the shadow box needs most of the town anyway (48 m cells: +8 draws for
 * −9 % triangles), so one mesh, 2 shadow draws as before. The other pads' waystones cast with their
 * own instanced mesh (one more shadow draw, only where pads are in range).
 */
export const TOWN_SHADOW_LAYER = SHADOW_ONLY_LAYER;

let shadowMaterial: THREE.MeshBasicNodeMaterial | null = null;
/** Depth-only caster material for the shadow copy (no colour node: plain depth in the shadow pass). */
function townShadowMaterial(): THREE.MeshBasicNodeMaterial {
  if (!shadowMaterial) {
    shadowMaterial = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    shadowMaterial.name = "town:shadow";
  }
  return shadowMaterial;
}

/** Camera distance (m, to a cell's bounding sphere) beyond which a cell shows LOD1; 0 = always LOD1. */
export const TOWN_LOD_DISTANCE: Record<ResolvedSettings["tier"], number> = { low: 0, medium: 60, high: 90, ultra: 140 };
const LOD_HYSTERESIS = 4;

/** The other pads' platforms and waystones are drawn within this distance (m) of the camera (the old pad discs' range). */
export const PAD_MODEL_RANGE = 450;

/** Slot names whose triangles the shadow copy leaves out (inset window panes). */
const GLASS_SLOTS = new Set(["MI_WindowGlass", "M_Glass"]);

interface CellMesh {
  mesh: THREE.Mesh;
  kind: TownMaterialKind;
  triangles: number;
  /** The outpost's shop stall: its own mesh in the faded town material (D-view-5). */
  fade?: boolean;
}

interface Cell {
  index: number;
  /** Meshes per variant (0 = LOD0, 1 = LOD1). */
  variants: [CellMesh[], CellMesh[]];
  shown: 0 | 1;
  centre: THREE.Vector3;
  radius: number;
  /** Unit direction, angular radius (rad) and top radius for horizon culling. */
  dir: THREE.Vector3;
  angle: number;
  topR: number;
  aboveHorizon: boolean;
}

interface Bucket {
  parts: { part: TownPart; p: TownPlacement; tris: Uint32Array | null }[];
  verts: number;
  indices: number;
}

/** The other pads' platform + waystone (outposts): one instanced mesh per material kind. */
interface PadModels {
  meshes: { mesh: THREE.InstancedMesh; kind: TownMaterialKind; triangles: number }[];
  /** Instance frames of pads 1..n and their positions (range test). */
  frames: THREE.Matrix4[];
  at: THREE.Vector3[];
  /** Which pad each instance slot holds, and how many slots are drawn. */
  order: Int32Array;
  shown: number;
}

const _v = new THREE.Vector3();

/** Identity frame: geometry already in the target space. */
const IDENTITY: TownPlacement = { item: 0, prefab: -1, scale: 1, px: 0, py: 0, pz: 0, rx: 1, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0, fx: 0, fy: 0, fz: 1 };

/** Cell index of a site point (or -1 outside the grid). */
function cellOf(east: number, north: number): number {
  const i = Math.floor((east + GRID_HALF) / TOWN_CELL), j = Math.floor((north + GRID_HALF) / TOWN_CELL);
  if (i < 0 || j < 0 || i >= GRID_N || j >= GRID_N) return -1;
  return j * GRID_N + i;
}

/** Placement `w` in the frame of placement `p` (x = right, y = up, z = front of p). */
function relative(p: TownPlacement, w: TownPlacement): TownPlacement {
  const d = [w.px - p.px, w.py - p.py, w.pz - p.pz] as const;
  const into = (x: number, y: number, z: number): [number, number, number] => [
    p.rx * x + p.ry * y + p.rz * z,
    p.ux * x + p.uy * y + p.uz * z,
    p.fx * x + p.fy * y + p.fz * z,
  ];
  const [px, py, pz] = into(d[0], d[1], d[2]);
  const [rx, ry, rz] = into(w.rx, w.ry, w.rz);
  const [ux, uy, uz] = into(w.ux, w.uy, w.uz);
  const [fx, fy, fz] = into(w.fx, w.fy, w.fz);
  return { item: w.item, prefab: w.prefab, scale: w.scale, px, py, pz, rx, ry, rz, ux, uy, uz, fx, fy, fz };
}

export class SiteTown {
  readonly group = new THREE.Group();
  /** Which site: Portus' town or the planet's outpost. */
  readonly site: SiteId;
  /** The shared structure solids (the local player's MoveColliders use them). */
  readonly collider: StructureCollider;
  /** The structures as the local player's MoveColliders (PlayerController.setStructures). */
  readonly moveColliders: MoveColliders;
  /** Resolves once the site meshes (or the fallback) are in the scene. */
  readonly ready: Promise<void>;
  readonly cells: Cell[] = [];
  /** The shadow-only opaque copy (TOWN_SHADOW_LAYER), or null (fallback, or not built yet). */
  shadowMesh: CellMesh | null = null;
  /** The other pads' platforms and waystones (outposts with assets), or null. */
  pads: PadModels | null = null;
  private fallback: THREE.InstancedMesh[] = [];
  private settings: ResolvedSettings;
  private assets: TownAssets | null = null;
  /** The site's download is over (landed, failed or timed out), however long after the arrival's deadline. */
  readonly settled: Promise<void>;
  /** The asset that came after the deadline, waiting for the next loading screen (swapInLate). */
  private late: TownAssets | null = null;
  private lodDistance = 60;
  private disposed = false;
  /** Warm-up: show both variants of every cell (so both compile and upload). */
  private forceAll = false;

  /** @param source the site asset (tests pass a decoded one; the game downloads it once per session). */
  constructor(
    private readonly terrain: Terrain,
    settings: ResolvedSettings,
    source: Promise<TownAssets | null> = preloadSite(terrain.body.id as SiteId),
    deadlineMs = TOWN_LOAD_DEADLINE_MS,
  ) {
    this.site = terrain.body.id as SiteId;
    this.group.name = this.site === TOWN_BODY ? "portusTown" : `outpost:${this.site}`;
    const collider = (this.collider = structureCollider(terrain));
    const stalls = stallCameraBoxes(terrain);
    this.moveColliders = {
      resolve: (pos, out) => collider.resolve(pos, out),
      raycast: (o, d, maxT) => collider.raycast(o.x, o.y, o.z, d.x, d.y, d.z, maxT),
      // The camera also stops at the shop stall's awning and what else hangs off it (#22, D-view-5).
      cameraRay: (o, d, maxT) => Math.min(collider.raycast(o.x, o.y, o.z, d.x, d.y, d.z, maxT), cameraBoxRay(stalls, o.x, o.y, o.z, d.x, d.y, d.z, maxT)),
    };
    this.settings = settings;
    this.group.visible = !flags.has("notown");
    this.settled = source.then(() => undefined, () => undefined);
    this.ready = this.build(source, deadlineMs);
  }

  /** The site's own models are drawn (not the plain-collider fallback): the planets' old pad discs and portal base can go. */
  get drawsModels(): boolean {
    return this.assets !== null;
  }

  private async build(source: Promise<TownAssets | null>, deadlineMs: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), deadlineMs)));
    const assets = await Promise.race([source, deadline]);
    clearTimeout(timer);
    if (this.disposed) return;
    if (assets === "late") {
      // Show the fallback now (before the probe and warm-up). What arrives later waits for the next
      // loading screen on this body (swapInLate): never a new mesh, or a shader build, in play.
      console.warn(`[town] ${this.site} structure assets not ready after ${deadlineMs} ms; drawing plain colliders until the next loading screen`);
      void source.then(
        (a) => {
          if (a && !this.disposed) this.late = a;
        },
        () => undefined,
      );
      return this.buildFallback();
    }
    if (!assets) return this.buildFallback();
    this.buildSite(assets);
  }

  /** The real site from its asset (the fallback on a failure). False when it fell back. */
  private buildSite(assets: TownAssets): boolean {
    let ok = true;
    try {
      this.assets = assets;
      this.buildCells(assets);
      if (this.site !== TOWN_BODY) this.buildPads(assets);
    } catch (e) {
      console.error("[town] building the site meshes failed; drawing plain colliders", e);
      this.disposeMeshes();
      this.group.clear();
      this.assets = null;
      this.buildFallback();
      ok = false;
    }
    this.applySettings(this.settings);
    return ok;
  }

  /**
   * A loading screen on this body (a graphics re-warm, a re-probe): if the real site came after the
   * arrival's deadline, it replaces the stone fallback now, so the warm-up that follows compiles it
   * (D-load-6). True when it did (on a planet the caller then drops the old pad discs).
   */
  swapInLate(): boolean {
    const assets = this.late;
    this.late = null;
    if (!assets || this.disposed || this.assets) return false;
    for (const m of this.fallback) {
      this.group.remove(m);
      m.geometry.dispose();
      m.dispose();
    }
    this.fallback.length = 0;
    const ok = this.buildSite(assets);
    if (ok) console.info(`[town] ${this.site} structure assets arrived after the arrival's deadline; drawn from this loading screen on`);
    return ok;
  }

  // ------------------------------------------------------------------ building

  private buildCells(assets: TownAssets) {
    const placements = sitePlacements(this.terrain);
    const prefabs = sitePrefabs(this.terrain.body.id);
    const portus = this.site === TOWN_BODY;
    const buckets = new Map<string, Bucket>();
    const bucket = (cell: number, variant: 0 | 1, kind: TownMaterialKind, fade: boolean) => {
      const k = `${cell}:${variant}:${kind}:${fade ? 1 : 0}`;
      let b = buckets.get(k);
      if (!b) buckets.set(k, (b = { parts: [], verts: 0, indices: 0 }));
      return b;
    };
    const add = (cell: number, variant: 0 | 1, kind: TownMaterialKind, part: TownPart, p: TownPlacement, tris: Uint32Array | null, fade = false) => {
      const b = bucket(cell, variant, kind, fade);
      b.parts.push({ part, p, tris });
      b.verts += part.position.length / 3;
      b.indices += tris ? tris.length * 3 : part.index.length;
    };
    // The layout (Portus' town, or pad 0's outpost): placement i is layout item i, at site point
    // (east, north); the waystones of the other pads (item < 0) are drawn with the pad models.
    const coords = (i: number): [number, number] => {
      const it = portus ? TOWN_LAYOUT[i]! : OUTPOSTS[this.site as OutpostBody].layout[i]!;
      return [it[1], it[2]];
    };
    // An outpost's shop stall stands where the camera may pass close by, so it is baked on its own,
    // in the faded material: between the camera and the player it dissolves, the buildings never do.
    const stallItem = portus ? -1 : OUTPOSTS[this.site as OutpostBody].shop.item;
    placements.forEach((p, i) => {
      if (p.item < 0) return;
      const pre = prefabs[p.prefab]!;
      const fade = i === stallItem;
      const l0 = assets.meshes.get(pre.name)!;
      const l1 = pre.tris[1] > 0 ? assets.meshes.get(`${pre.name}__L1`)! : l0;
      const decal = portus && pre.radius > DECAL_RADIUS;
      const [e0, n0] = coords(i);
      for (const kind of ["opaque", "cutout"] as const) {
        // A decal (the paving) is laid onto the ground once and used for both LODs.
        const laid = decal && l0[kind] ? conformDecal(l0[kind]!, p, this.terrain) : null;
        const parts: [TownPart | null, TownPart | null] = laid ? [laid, laid] : [l0[kind], l1[kind]];
        for (const variant of [0, 1] as const) {
          const part = parts[variant];
          if (!part) continue;
          if (decal) {
            // A decal spanning many cells (the paving): split its triangles by their centroid. At the
            // pole with yaw 0, prefab x = east and z = -north.
            const byCell = new Map<number, number[]>();
            for (let t = 0; t < part.index.length; t += 3) {
              let e = 0, n = 0;
              for (let k = 0; k < 3; k++) {
                const v = part.index[t + k]!;
                e += part.position[v * 3]!;
                n -= part.position[v * 3 + 2]!;
              }
              const c = cellOf(e0 + e / 3, n0 + n / 3);
              if (c < 0) continue;
              let l = byCell.get(c);
              if (!l) byCell.set(c, (l = []));
              l.push(t / 3);
            }
            for (const [c, l] of byCell) add(c, variant, kind, part, p, Uint32Array.from(l));
          } else {
            const c = cellOf(e0, n0);
            if (c >= 0) add(c, variant, kind, part, p, null, fade);
          }
        }
      }
    });
    // The outpost's paths: ground decals (world space) in both LODs of pad 0's cell.
    if (!portus) {
      const paths = outpostPaths(this.site as OutpostBody, this.terrain, assets.manifest.slots);
      if (paths) for (const variant of [0, 1] as const) add(cellOf(0, 0), variant, "opaque", paths, IDENTITY, null);
    }
    const slots = assets.manifest.slots;
    const floor = assets.manifest.look?.albedoFloor ?? 0;
    const byCell = new Map<number, Cell>();
    for (const [key, b] of buckets) {
      const [cs, vs, kind, fs] = key.split(":") as [string, string, TownMaterialKind, string];
      const ci = Number(cs), variant = Number(vs) as 0 | 1, fade = fs === "1";
      const geo = this.merge(b, slots);
      const mat = townMaterial(kind, true, assets.color, assets.normal, floor, fade);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `town:${ci}:L${variant}:${kind}${fade ? ":stall" : ""}`;
      mesh.matrixAutoUpdate = false;
      (mesh as unknown as { static: boolean }).static = true;
      mesh.receiveShadow = true;
      let cell = byCell.get(ci);
      if (!cell) {
        cell = { index: ci, variants: [[], []], shown: 0, centre: new THREE.Vector3(), radius: 0, dir: new THREE.Vector3(), angle: 0, topR: 0, aboveHorizon: true };
        byCell.set(ci, cell);
      }
      cell.variants[variant].push({ mesh, kind, triangles: b.indices / 3, fade });
      this.group.add(mesh);
    }
    for (const cell of byCell.values()) {
      const box = new THREE.Box3();
      for (const v of cell.variants) for (const m of v) box.union(m.mesh.geometry.boundingBox!);
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      cell.centre.copy(sphere.center);
      cell.radius = sphere.radius;
      cell.dir.copy(sphere.center).normalize();
      // Horizon test inputs from the vertices themselves: the widest angle from the cell's
      // direction and the highest point (the keep's flag), tighter than the bounding sphere.
      let cosMin = 1, topR = 0;
      for (const v of cell.variants) {
        for (const m of v) {
          const a = m.mesh.geometry.getAttribute("position").array as Float32Array;
          for (let i = 0; i < a.length; i += 3) {
            const l = Math.hypot(a[i]!, a[i + 1]!, a[i + 2]!);
            topR = Math.max(topR, l);
            cosMin = Math.min(cosMin, (a[i]! * cell.dir.x + a[i + 1]! * cell.dir.y + a[i + 2]! * cell.dir.z) / l);
          }
        }
      }
      cell.angle = Math.acos(Math.max(-1, cosMin));
      cell.topR = topR;
      this.cells.push(cell);
    }
    this.cells.sort((a, b) => a.index - b.index);
    this.buildShadowMesh(assets, placements);
  }

  /** The shadow-only opaque copy: positions only, roof shells, no paving, paths or window glass. */
  private buildShadowMesh(assets: TownAssets, placements: readonly TownPlacement[]) {
    const prefabs = sitePrefabs(this.terrain.body.id);
    const glass = new Set(assets.manifest.slots.flatMap((x, i) => (GLASS_SLOTS.has(x.name) ? [i] : [])));
    const parts: { part: TownPart; p: TownPlacement }[] = [];
    let verts = 0;
    for (const p of placements) {
      if (p.item < 0) continue; // the other pads' waystones cast with their own mesh
      const pre = prefabs[p.prefab]!;
      if (pre.radius > DECAL_RADIUS) continue; // the paving lies on the ground
      const mesh = assets.meshes.get(pre.cls === "building" && pre.tris[1] > 0 ? `${pre.name}__L1` : pre.name)!;
      if (!mesh.opaque) continue;
      parts.push({ part: mesh.opaque, p });
      verts += mesh.opaque.position.length / 3;
    }
    const pos = new Float32Array(verts * 3);
    const idx: number[] = [];
    let vo = 0;
    for (const { part, p } of parts) {
      const n = part.position.length / 3, s = p.scale;
      for (let i = 0; i < n; i++) {
        const x = part.position[i * 3]! * s, y = part.position[i * 3 + 1]! * s, z = part.position[i * 3 + 2]! * s;
        pos[(vo + i) * 3] = p.px + p.rx * x + p.ux * y + p.fx * z;
        pos[(vo + i) * 3 + 1] = p.py + p.ry * x + p.uy * y + p.fy * z;
        pos[(vo + i) * 3 + 2] = p.pz + p.rz * x + p.uz * y + p.fz * z;
      }
      for (let t = 0; t < part.index.length; t += 3) {
        const a = part.index[t]!, b = part.index[t + 1]!, c = part.index[t + 2]!;
        if (glass.has(part.color[a * 4 + 3]!)) continue; // inset panes: inside the wall's shadow anyway
        idx.push(a + vo, b + vo, c + vo);
      }
      vo += n;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(Uint32Array.from(idx), 1));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, townShadowMaterial());
    mesh.name = "town:shadow";
    mesh.layers.set(TOWN_SHADOW_LAYER);
    mesh.matrixAutoUpdate = false;
    (mesh as unknown as { static: boolean }).static = true;
    mesh.receiveShadow = false;
    this.shadowMesh = { mesh, kind: "opaque", triangles: idx.length / 3 };
    this.group.add(mesh);
  }

  /**
   * The other pads' platform + waystone (pads 1..n): one geometry per material kind in a pad's frame
   * (the waystone at its fixed offset from the platform), instanced at every pad.
   */
  private buildPads(assets: TownAssets) {
    const site = OUTPOSTS[this.site as OutpostBody];
    const n = padDirs(this.terrain.body).length;
    if (n < 2) return;
    const prefabs = site.prefabs;
    const placements = sitePlacements(this.terrain);
    const stone = placements.find((p) => p.item === -2)!;
    const offset = relative(padPlatformPlacement(this.terrain, 1), stone);
    const platform = assets.meshes.get(prefabs[site.pad]!.name)!;
    const waystone = assets.meshes.get(prefabs[site.waystone]!.name)!;
    const frames: THREE.Matrix4[] = [], at: THREE.Vector3[] = [];
    const r = new THREE.Vector3(), u = new THREE.Vector3(), f = new THREE.Vector3();
    for (let k = 1; k < n; k++) {
      const p = padPlatformPlacement(this.terrain, k);
      frames.push(new THREE.Matrix4().makeBasis(r.set(p.rx, p.ry, p.rz), u.set(p.ux, p.uy, p.uz), f.set(p.fx, p.fy, p.fz)).setPosition(p.px, p.py, p.pz));
      at.push(new THREE.Vector3(p.px, p.py, p.pz));
    }
    const floor = assets.manifest.look?.albedoFloor ?? 0;
    const meshes: PadModels["meshes"] = [];
    for (const kind of ["opaque", "cutout"] as const) {
      const b: Bucket = { parts: [], verts: 0, indices: 0 };
      for (const [part, p] of [[platform[kind], IDENTITY], [waystone[kind], offset]] as const) {
        if (!part) continue;
        b.parts.push({ part, p, tris: null });
        b.verts += part.position.length / 3;
        b.indices += part.index.length;
      }
      if (b.parts.length === 0) continue;
      const mesh = new THREE.InstancedMesh(this.merge(b, assets.manifest.slots), townMaterial(kind, true, assets.color, assets.normal, floor), frames.length);
      mesh.name = `town:pads:${kind}`;
      frames.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.count = frames.length;
      // The instances span the planet: culled per pad by range here, never by three's one sphere.
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      meshes.push({ mesh, kind, triangles: b.indices / 3 });
      this.group.add(mesh);
    }
    this.pads = { meshes, frames, at, order: Int32Array.from(frames, (_, i) => i), shown: frames.length };
  }

  /** Bake a bucket's placed parts into one geometry (positions in the placements' space; slot data per vertex). */
  private merge(b: Bucket, slots: readonly TownSlot[]): THREE.BufferGeometry {
    const pos = new Float32Array(b.verts * 3), nrm = new Float32Array(b.verts * 3), uv = new Float32Array(b.verts * 2);
    const col = new Uint8Array(b.verts * 4), mat = new Uint8Array(b.verts * 4);
    const idx = new Uint32Array(b.indices);
    const slotData = slots.map((s) => ({
      tint: s.tint,
      normal: Math.round(Math.max(0, Math.min(1, s.normal)) * 255),
      layer: s.layer,
      rough: Math.round(s.rough * 255),
      metal: Math.round(s.metal * 255),
      mode: (s.glow ?? 0) > 0 ? TOWN_EMISSIVE.glow : s.emissive[3] > 0 ? TOWN_EMISSIVE.flame : s.night[3] > 0 ? TOWN_EMISSIVE.window : TOWN_EMISSIVE.none,
    }));
    let vo = 0, io = 0;
    for (const { part, p, tris } of b.parts) {
      const n = part.position.length / 3;
      const s = p.scale;
      for (let i = 0; i < n; i++) {
        const x = part.position[i * 3]! * s, y = part.position[i * 3 + 1]! * s, z = part.position[i * 3 + 2]! * s;
        const wx = p.px + p.rx * x + p.ux * y + p.fx * z;
        const wy = p.py + p.ry * x + p.uy * y + p.fy * z;
        const wz = p.pz + p.rz * x + p.uz * y + p.fz * z;
        const o = (vo + i) * 3;
        pos[o] = wx;
        pos[o + 1] = wy;
        pos[o + 2] = wz;
        const nx = part.normal[i * 3]!, ny = part.normal[i * 3 + 1]!, nz = part.normal[i * 3 + 2]!;
        nrm[o] = p.rx * nx + p.ux * ny + p.fx * nz;
        nrm[o + 1] = p.ry * nx + p.uy * ny + p.fy * nz;
        nrm[o + 2] = p.rz * nx + p.uz * ny + p.fz * nz;
        uv[(vo + i) * 2] = part.uv[i * 2]!;
        uv[(vo + i) * 2 + 1] = part.uv[i * 2 + 1]!;
        const sd = slotData[part.color[i * 4 + 3]!]!;
        const c = (vo + i) * 4;
        col[c] = Math.min(255, Math.round(part.color[i * 4]! * sd.tint[0]));
        col[c + 1] = Math.min(255, Math.round(part.color[i * 4 + 1]! * sd.tint[1]));
        col[c + 2] = Math.min(255, Math.round(part.color[i * 4 + 2]! * sd.tint[2]));
        col[c + 3] = sd.normal;
        mat[c] = sd.layer;
        mat[c + 1] = sd.rough;
        mat[c + 2] = sd.metal;
        mat[c + 3] = sd.mode;
      }
      if (tris) {
        for (const t of tris) {
          idx[io++] = part.index[t * 3]! + vo;
          idx[io++] = part.index[t * 3 + 1]! + vo;
          idx[io++] = part.index[t * 3 + 2]! + vo;
        }
      } else {
        for (let k = 0; k < part.index.length; k++) idx[io++] = part.index[k]! + vo;
      }
      vo += n;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setAttribute("color", new THREE.BufferAttribute(col, 4, true));
    g.setAttribute("townMat", new THREE.BufferAttribute(mat, 4, true));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }

  /** No asset: the solids as stone boxes and cylinders (the same shapes that block the player). */
  private buildFallback() {
    // Portus: the layout's solids (the Hall board's stand, item -1, is drawn by QuestWorld with its
    // board). A planet: the outpost's and the other pads' waystones (items < 0).
    const solids = siteSolids(this.terrain).filter((x) => this.site !== TOWN_BODY || x.item >= 0);
    const boxes = solids.filter((s) => s.shape === 0), cyls = solids.filter((s) => s.shape === 1);
    const boxGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    // Unit-wide sources (a box 1 m across, a cylinder 1 m across): the instance basis scales them by
    // the solid's full width (2·hx, 2·hz) and height.
    const cylGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 14).translate(0, 0.5, 0);
    const m = new THREE.Matrix4(), r = new THREE.Vector3(), u = new THREE.Vector3(), f = new THREE.Vector3();
    for (const [list, geo] of [[boxes, boxGeo], [cyls, cylGeo]] as const) {
      const mesh = new THREE.InstancedMesh(geo, townFallbackMaterial(), Math.max(1, list.length));
      mesh.name = "town:fallback";
      list.forEach((s, i) => {
        m.makeBasis(r.set(s.rx, s.ry, s.rz).multiplyScalar(s.hx * 2), u.set(s.ux, s.uy, s.uz).multiplyScalar(s.h), f.set(s.fx, s.fy, s.fz).multiplyScalar(s.hz * 2));
        m.setPosition(s.px, s.py, s.pz);
        mesh.setMatrixAt(i, m);
      });
      mesh.count = list.length;
      mesh.computeBoundingSphere();
      mesh.receiveShadow = true;
      this.fallback.push(mesh);
      this.group.add(mesh);
    }
    this.applySettings(this.settings);
  }

  // ------------------------------------------------------------------ per frame and settings

  applySettings(s: ResolvedSettings) {
    this.settings = s;
    this.lodDistance = TOWN_LOD_DISTANCE[s.tier];
    const cast = s.on.shadows && s.shadows.mode === "map";
    // The cascaded SunLight (High/Ultra opt-in) renders its own cameras' layers: there the drawn
    // town casts, as it did before the shadow copy.
    const copy = cast && !s.on.cascades && !!this.shadowMesh;
    const normals = s.tier !== "low";
    const floor = this.assets?.manifest.look?.albedoFloor ?? 0;
    for (const c of this.cells) {
      for (const v of c.variants) {
        for (const m of v) {
          m.mesh.castShadow = cast && (m.kind === "cutout" || !copy);
          if (this.assets) m.mesh.material = townMaterial(m.kind, normals, this.assets.color, this.assets.normal, floor, m.fade);
        }
      }
    }
    for (const m of this.pads?.meshes ?? []) {
      m.mesh.castShadow = cast;
      if (this.assets) m.mesh.material = townMaterial(m.kind, normals, this.assets.color, this.assets.normal, floor);
    }
    if (this.shadowMesh) {
      this.shadowMesh.mesh.castShadow = copy;
      this.shadowMesh.mesh.visible = copy;
    }
    for (const m of this.fallback) m.castShadow = cast;
  }

  /** Warm-up hook: both LOD variants of every cell drawn (Game.warmupHook). */
  setForceAll(on: boolean) {
    this.forceAll = on;
  }

  /** LOD per cell, horizon culling (from the camera) and the pads in range. */
  update(camera: THREE.Camera) {
    const cam = camera.position;
    const R = this.terrain.body.radius;
    const rMin = R - 25;
    const rc = Math.max(cam.length(), rMin + 0.01);
    const thetaC = Math.acos(Math.min(1, rMin / rc));
    _v.copy(cam).divideScalar(rc);
    for (const c of this.cells) {
      const ang = Math.acos(Math.max(-1, Math.min(1, c.dir.dot(_v))));
      c.aboveHorizon = ang - c.angle <= thetaC + Math.acos(Math.min(1, rMin / c.topR));
      const d = Math.max(0, cam.distanceTo(c.centre) - c.radius);
      const lim = this.lodDistance;
      if (lim <= 0) c.shown = 1;
      else if (c.shown === 0 && d > lim + LOD_HYSTERESIS) c.shown = 1;
      else if (c.shown === 1 && d < lim - LOD_HYSTERESIS) c.shown = 0;
      for (const v of [0, 1] as const) {
        const on = c.aboveHorizon && (this.forceAll || v === c.shown);
        for (const m of c.variants[v]) m.mesh.visible = on;
      }
    }
    const pads = this.pads;
    if (pads) {
      // The pads in range, packed at the front of the instance list (all of them while warming up).
      let k = 0, changed = false;
      for (let i = 0; i < pads.frames.length; i++) {
        if (!this.forceAll && pads.at[i]!.distanceTo(cam) > PAD_MODEL_RANGE) continue;
        if (pads.order[k] !== i) {
          pads.order[k] = i;
          for (const m of pads.meshes) m.mesh.setMatrixAt(k, pads.frames[i]!);
          changed = true;
        }
        k++;
      }
      if (changed) for (const m of pads.meshes) m.mesh.instanceMatrix.needsUpdate = true;
      pads.shown = k;
      for (const m of pads.meshes) {
        m.mesh.count = k;
        m.mesh.visible = k > 0;
      }
    }
  }

  /**
   * Draws and triangles the site adds for this camera (frustum and the current LOD state), and in
   * the shadow map for `shadowCamera` (the casters on its layers whose bounds meet its frustum).
   */
  stats(camera?: THREE.Camera, shadowCamera?: THREE.Camera): { draws: number; triangles: number; shadowDraws: number; shadowTriangles: number; meshes: number } {
    let draws = 0, triangles = 0, shadowDraws = 0, shadowTriangles = 0, meshes = 0;
    const frustum = new THREE.Frustum(), shadowFrustum = new THREE.Frustum();
    const setFrom = (f: THREE.Frustum, c: THREE.Camera) => {
      c.updateMatrixWorld();
      f.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse));
    };
    if (camera) setFrom(frustum, camera);
    if (shadowCamera) setFrom(shadowFrustum, shadowCamera);
    const sees = (c: THREE.Camera | undefined, f: THREE.Frustum, m: THREE.Mesh) => !c || (m.layers.test(c.layers) && f.intersectsSphere(m.geometry.boundingSphere!));
    for (const m of [...this.cells.flatMap((c) => [...c.variants[0], ...c.variants[1]]), ...(this.shadowMesh ? [this.shadowMesh] : [])]) {
      meshes++;
      if (!m.mesh.visible) continue;
      if (m.mesh.layers.isEnabled(0) && sees(camera, frustum, m.mesh)) {
        draws++;
        triangles += m.triangles;
      }
      if (shadowCamera && m.mesh.castShadow && sees(shadowCamera, shadowFrustum, m.mesh)) {
        shadowDraws++;
        shadowTriangles += m.triangles;
      }
    }
    // The pads' instanced meshes are never frustum-culled: every shown instance is drawn.
    for (const m of this.pads?.meshes ?? []) {
      meshes++;
      if (!m.mesh.visible || m.mesh.count === 0) continue;
      draws++;
      triangles += m.triangles * m.mesh.count;
      if (shadowCamera && m.mesh.castShadow) {
        shadowDraws++;
        shadowTriangles += m.triangles * m.mesh.count;
      }
    }
    for (const m of this.fallback) if (m.count > 0) {
      draws++;
      meshes++;
    }
    return { draws, triangles, shadowDraws, shadowTriangles, meshes };
  }

  private disposeMeshes() {
    for (const c of this.cells) for (const v of c.variants) for (const m of v) m.mesh.geometry.dispose();
    this.shadowMesh?.mesh.geometry.dispose();
    for (const m of this.pads?.meshes ?? []) {
      m.mesh.geometry.dispose();
      m.mesh.dispose();
    }
    this.cells.length = 0;
    this.shadowMesh = null;
    this.pads = null;
  }

  dispose() {
    this.disposed = true;
    this.disposeMeshes();
    for (const m of this.fallback) {
      m.geometry.dispose();
      m.dispose();
    }
    this.fallback.length = 0;
    this.group.removeFromParent();
  }
}
