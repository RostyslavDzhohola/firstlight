// The Portus castle town on the client (D38). Placements come from the shared layout
// (planet/town.ts), so what is drawn stands exactly where the shared colliders block; the geometry
// comes from the shipped GLB (render/townAssets.ts).
//
// Draw-call budget: the town is static, so at load every placed prefab is baked into merged meshes
// per ground cell (CELL m squares in the town frame), two variants per cell (LOD0: full houses and
// trees; LOD1: roof shells and tree cards; walls, props and paving in both) and two materials
// (opaque, cutout). Each frame one variant per cell is shown (the camera's distance to the cell,
// the tier's LOD distance; Low always shows LOD1 and drops normal maps), cells below the horizon
// are hidden, and three frustum-culls the rest. All meshes share two materials, so the warm-up
// (which shows every hidden mesh) compiles the town's pipelines once.
//
// Fallback: if the asset can't load, or hasn't arrived by TOWN_LOAD_DEADLINE_MS, the collider solids
// are drawn as plain stone boxes and cylinders (two instanced draws) before the quality probe and
// the warm-up, so nothing blocks the player invisibly and nothing compiles in play. A later
// completion is ignored for this arrival (the next arrival in Portus uses the cached asset).

import * as THREE from "three/webgpu";
import { TOWN_LAYOUT, TOWN_PREFABS } from "@firstlight/shared/content/portusTown";
import { structureCollider, townPlacements, townSolids, type StructureCollider, type TownPlacement } from "@firstlight/shared/planet/town";
import type { Terrain } from "@firstlight/shared";
import { flags } from "../config.ts";
import type { MoveColliders } from "../game/PlayerController.ts";
import { SHADOW_ONLY_LAYER } from "../render/atmosphere.ts";
import type { ResolvedSettings } from "../render/quality.ts";
import { preloadTown, type TownAssets, type TownPart, type TownSlot } from "../render/townAssets.ts";
import { TOWN_EMISSIVE, townFallbackMaterial, townMaterial, type TownMaterialKind } from "../render/townMaterial.ts";
import { conformDecal } from "./townDecal.ts";

/**
 * Ground cell size (m) and the half extent of the cell grid around the pole. Measured at the spawn
 * views (portusTown.test.ts): 32 m cells cost 19–23 draws + 19 shadow draws on Medium, 64 m cells
 * 8–12 + 10, 96 m cells 6 + 8, one cell 2 + 2, while frustum culling saved under 15 % of the
 * triangles (from the plaza nearly the whole town is in view). So the whole town is one cell: one
 * opaque and one cutout draw (+ the same two in the shadow map), LOD per tier.
 */
export const TOWN_CELL = 192;
const GRID_HALF = 96;
const GRID_N = Math.round((2 * GRID_HALF) / TOWN_CELL);

/**
 * Prefabs wider than this (m) are ground decals spanning the town (the paving): laid onto the ground
 * where it rises off the flat floor (townDecal.ts), and their triangles split between cells.
 */
const DECAL_RADIUS = 30;

/**
 * How long an arrival waits for the town asset (ms) before it shows the fallback instead. A little
 * longer than the download's own abort (townAssets.ts TOWN_FETCH_TIMEOUT_MS), so it only matters if
 * decoding stalls or a test hands in a source that never settles.
 */
export const TOWN_LOAD_DEADLINE_MS = 18_000;

/**
 * Shadows (Medium+ shadow map). The drawn opaque town casts nothing; a shadow-only copy of it casts
 * instead, on SHADOW_ONLY_LAYER (render/atmosphere.ts: only the sun's shadow camera renders it).
 * It holds positions only, with a plain material, so the shadow pass doesn't sample the town's
 * texture arrays; it leaves out what can't change a shadow map texel (the paving decal lying on the
 * ground, the window glass inset in the walls) and uses the roof shells for buildings (the same
 * silhouette; the tile relief is below a texel). The cutout meshes (leaves, vines) cast themselves:
 * they need their alpha. Measured against cutting the shadow copy into 16–48 m cells that the shadow
 * camera culls: from the plaza the shadow box needs most of the town anyway (48 m cells: +8 draws for
 * −9 % triangles), so one mesh, 2 shadow draws as before.
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

interface CellMesh {
  mesh: THREE.Mesh;
  kind: TownMaterialKind;
  triangles: number;
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

const _v = new THREE.Vector3();

/** Cell index of a town point (or -1 outside the grid). */
function cellOf(east: number, north: number): number {
  const i = Math.floor((east + GRID_HALF) / TOWN_CELL), j = Math.floor((north + GRID_HALF) / TOWN_CELL);
  if (i < 0 || j < 0 || i >= GRID_N || j >= GRID_N) return -1;
  return j * GRID_N + i;
}

export class PortusTown {
  readonly group = new THREE.Group();
  /** The shared structure solids (the local player's MoveColliders use them). */
  readonly collider: StructureCollider;
  /** The structures as the local player's MoveColliders (PlayerController.setStructures). */
  readonly moveColliders: MoveColliders;
  /** Resolves once the town meshes (or the fallback) are in the scene. */
  readonly ready: Promise<void>;
  readonly cells: Cell[] = [];
  /** The shadow-only opaque copy (TOWN_SHADOW_LAYER), or null (fallback, or not built yet). */
  shadowMesh: CellMesh | null = null;
  private fallback: THREE.InstancedMesh[] = [];
  private settings: ResolvedSettings;
  private assets: TownAssets | null = null;
  private lodDistance = 60;
  private disposed = false;
  /** Warm-up: show both variants of every cell (so both compile and upload). */
  private forceAll = false;

  /** @param source the town asset (tests pass a decoded one; the game downloads it once per session). */
  constructor(
    private readonly terrain: Terrain,
    settings: ResolvedSettings,
    source: Promise<TownAssets | null> = preloadTown(),
    deadlineMs = TOWN_LOAD_DEADLINE_MS,
  ) {
    this.group.name = "portusTown";
    const collider = (this.collider = structureCollider(terrain)!);
    this.moveColliders = {
      resolve: (pos, out) => collider.resolve(pos, out),
      raycast: (o, d, maxT) => collider.raycast(o.x, o.y, o.z, d.x, d.y, d.z, maxT),
    };
    this.settings = settings;
    this.group.visible = !flags.has("notown");
    this.ready = this.build(source, deadlineMs);
  }

  private async build(source: Promise<TownAssets | null>, deadlineMs: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), deadlineMs)));
    const assets = await Promise.race([source, deadline]);
    clearTimeout(timer);
    if (this.disposed) return;
    if (assets === "late") {
      // Show the fallback now (before the probe and warm-up); whatever arrives later is ignored here.
      console.warn(`[town] Portus town assets not ready after ${deadlineMs} ms; drawing plain colliders`);
      return this.buildFallback();
    }
    if (!assets) return this.buildFallback();
    try {
      this.assets = assets;
      this.buildCells(assets);
    } catch (e) {
      console.error("[town] building the town meshes failed; drawing plain colliders", e);
      for (const c of this.cells) for (const v of c.variants) for (const m of v) m.mesh.geometry.dispose();
      this.shadowMesh?.mesh.geometry.dispose();
      this.cells.length = 0;
      this.shadowMesh = null;
      this.group.clear();
      this.assets = null;
      this.buildFallback();
    }
    this.applySettings(this.settings);
  }

  // ------------------------------------------------------------------ building

  private buildCells(assets: TownAssets) {
    const placements = townPlacements(this.terrain);
    const buckets = new Map<string, Bucket>();
    const bucket = (cell: number, variant: 0 | 1, kind: TownMaterialKind) => {
      const k = `${cell}:${variant}:${kind}`;
      let b = buckets.get(k);
      if (!b) buckets.set(k, (b = { parts: [], verts: 0, indices: 0 }));
      return b;
    };
    const add = (cell: number, variant: 0 | 1, kind: TownMaterialKind, part: TownPart, p: TownPlacement, tris: Uint32Array | null) => {
      const b = bucket(cell, variant, kind);
      b.parts.push({ part, p, tris });
      b.verts += part.position.length / 3;
      b.indices += tris ? tris.length * 3 : part.index.length;
    };
    TOWN_LAYOUT.forEach((item, i) => {
      const pre = TOWN_PREFABS[item[0]]!;
      const p = placements[i]!;
      const l0 = assets.meshes.get(pre.name)!;
      const l1 = pre.tris[1] > 0 ? assets.meshes.get(`${pre.name}__L1`)! : l0;
      const decal = pre.radius > DECAL_RADIUS;
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
              const c = cellOf(item[1] + e / 3, item[2] + n / 3);
              if (c < 0) continue;
              let l = byCell.get(c);
              if (!l) byCell.set(c, (l = []));
              l.push(t / 3);
            }
            for (const [c, l] of byCell) add(c, variant, kind, part, p, Uint32Array.from(l));
          } else {
            const c = cellOf(item[1], item[2]);
            if (c >= 0) add(c, variant, kind, part, p, null);
          }
        }
      }
    });
    const slots = assets.manifest.slots;
    const byCell = new Map<number, Cell>();
    for (const [key, b] of buckets) {
      const [cs, vs, kind] = key.split(":") as [string, string, TownMaterialKind];
      const ci = Number(cs), variant = Number(vs) as 0 | 1;
      const geo = this.merge(b, slots);
      const mat = townMaterial(kind, true, assets.color, assets.normal);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `town:${ci}:L${variant}:${kind}`;
      mesh.matrixAutoUpdate = false;
      (mesh as unknown as { static: boolean }).static = true;
      mesh.receiveShadow = true;
      let cell = byCell.get(ci);
      if (!cell) {
        cell = { index: ci, variants: [[], []], shown: 0, centre: new THREE.Vector3(), radius: 0, dir: new THREE.Vector3(), angle: 0, topR: 0, aboveHorizon: true };
        byCell.set(ci, cell);
      }
      cell.variants[variant].push({ mesh, kind, triangles: b.indices / 3 });
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

  /** The shadow-only opaque copy: positions only, roof shells, no paving or window glass. */
  private buildShadowMesh(assets: TownAssets, placements: readonly TownPlacement[]) {
    const glass = assets.manifest.slots.findIndex((x) => x.name === "MI_WindowGlass");
    const parts: { part: TownPart; p: TownPlacement }[] = [];
    let verts = 0;
    TOWN_LAYOUT.forEach((item, i) => {
      const pre = TOWN_PREFABS[item[0]]!;
      if (pre.radius > DECAL_RADIUS) return; // the paving lies on the ground
      const mesh = assets.meshes.get(pre.cls === "building" ? `${pre.name}__L1` : pre.name)!;
      if (!mesh.opaque) return;
      parts.push({ part: mesh.opaque, p: placements[i]! });
      verts += mesh.opaque.position.length / 3;
    });
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
        if (part.color[a * 4 + 3] === glass) continue; // inset panes: inside the wall's shadow anyway
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

  /** Bake a bucket's placed parts into one geometry (world positions; slot data per vertex). */
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
      mode: s.emissive[3] > 0 ? TOWN_EMISSIVE.flame : s.night[3] > 0 ? TOWN_EMISSIVE.window : TOWN_EMISSIVE.none,
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
    const solids = townSolids(this.terrain);
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
    for (const c of this.cells) {
      for (const v of c.variants) {
        for (const m of v) {
          m.mesh.castShadow = cast && (m.kind === "cutout" || !copy);
          if (this.assets) m.mesh.material = townMaterial(m.kind, normals, this.assets.color, this.assets.normal);
        }
      }
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

  /** LOD per cell and horizon culling (from the camera). */
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
  }

  /**
   * Draws and triangles the town adds for this camera (frustum and the current LOD state), and in
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
    for (const m of this.fallback) if (m.count > 0) {
      draws++;
      meshes++;
    }
    return { draws, triangles, shadowDraws, shadowTriangles, meshes };
  }

  dispose() {
    this.disposed = true;
    for (const c of this.cells) for (const v of c.variants) for (const m of v) m.mesh.geometry.dispose();
    this.shadowMesh?.mesh.geometry.dispose();
    for (const m of this.fallback) {
      m.geometry.dispose();
      m.dispose();
    }
    this.cells.length = 0;
    this.shadowMesh = null;
    this.fallback.length = 0;
    this.group.removeFromParent();
  }
}
