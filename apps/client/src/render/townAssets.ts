// The Portus castle town's shipped asset (D38, tools/blender/portus): one meshopt GLB with a node per
// prefab and LOD (two primitives: "town_opaque", "town_cutout"; COLOR_0 = linear tint + material
// slot), two WebP layer strips (512 px layers stacked vertically: base colour with the cutout mask
// in alpha, and the tangent-space normal) and a manifest (files, slots, data version). Loaded only
// on Portus, before its warm-up; cached for the session.
//
// The strips become two DataArrayTextures (one layer per kit texture), so the whole town draws with
// two shared materials and tiles every kit texture with plain repeat wrapping. They are decoded
// through a canvas, which zeroes the colour where the mask is 0: the material samples the colour
// layer as premultiplied (rgb / a), so filtering and mipmaps never pull dark fringes into leaves.

import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { PORTUS_TOWN_VERSION, TOWN_PREFABS } from "@firstlight/shared/content/portusTown";
import { config } from "../config.ts";

/** A material slot of the packed town (pack.py SLOTS): which layer, tint and surface it uses. */
export interface TownSlot {
  name: string;
  layer: number;
  tint: [number, number, number];
  rough: number;
  metal: number;
  /** Normal-map strength 0..1. */
  normal: number;
  /** Emissive colour + strength (flames, lanterns). */
  emissive: [number, number, number, number];
  /** Night glow colour + strength (window glass). */
  night: [number, number, number, number];
  cutout: boolean;
}

export interface TownManifest {
  version: string;
  files: Record<"glb" | "color" | "normal", { name: string; bytes: number; sha256: string }>;
  layerSize: number;
  layers: string[];
  slots: TownSlot[];
  items: number;
  trianglesLod0: number;
}

/** One prefab LOD's geometry per material kind: plain arrays in the prefab frame (x right, y up, z front). */
export interface TownPart {
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  /** RGBA bytes: linear tint, slot index. */
  color: Uint8Array;
  index: Uint32Array;
}

export interface TownMesh {
  opaque: TownPart | null;
  cutout: TownPart | null;
}

export interface TownAssets {
  manifest: TownManifest;
  /** Node name ("house_a", "house_a__L1") → geometry. */
  meshes: Map<string, TownMesh>;
  color: THREE.Texture;
  normal: THREE.Texture;
}

let pending: Promise<TownAssets | null> | null = null;

/**
 * The whole download (manifest, GLB, both strips) is aborted after this many milliseconds, so a hung
 * request can't stay in the session cache: the next arrival tries again. PortusTown's own deadline
 * (a little longer) shows the plain fallback before the probe and the warm-up either way.
 */
export const TOWN_FETCH_TIMEOUT_MS = 15_000;

/** Start (or reuse) the download. Resolves null if anything fails or times out (the town then draws its colliders as plain stone). */
export function preloadTown(): Promise<TownAssets | null> {
  return (pending ??= loadTown().catch((e: unknown) => {
    console.warn("[town] Portus town assets failed to load; drawing plain colliders", e);
    pending = null; // try again on the next arrival
    return null;
  }));
}

type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

/** Download, decode and validate the town; rejects on any failure, or when `timeoutMs` runs out (every request is aborted). */
export async function loadTown(fetchImpl: Fetch = (u, i) => fetch(u, i), timeoutMs = TOWN_FETCH_TIMEOUT_MS): Promise<TownAssets> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error(`town assets: no answer in ${timeoutMs} ms`)), timeoutMs);
  const { signal } = abort;
  // Every await below also settles when the signal fires (a body stream that stalls, a decode).
  const bounded = <T>(p: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      p.then(resolve, reject);
    });
  const get = async (url: string) => {
    const r = await bounded(fetchImpl(url, { signal }));
    if (!r.ok) throw new Error(`${url} ${r.status}`);
    return r;
  };
  try {
    const base = `${config.assetBase}/portus/`;
    const manifest = (await bounded((await get(`${base}manifest.json`)).json())) as TownManifest;
    if (manifest.version !== PORTUS_TOWN_VERSION) {
      // A stale cache or a half-finished deploy: the geometry may not match the layout.
      throw new Error(`asset version ${manifest.version} does not match the layout ${PORTUS_TOWN_VERSION}`);
    }
    const [gltfBytes, color, normal] = await Promise.all([
      get(base + manifest.files.glb.name).then((r) => bounded(r.arrayBuffer())),
      get(base + manifest.files.color.name).then((r) => bounded(r.blob())).then((b) => bounded(decodeStrip(b, manifest.layerSize, true))),
      get(base + manifest.files.normal.name).then((r) => bounded(r.blob())).then((b) => bounded(decodeStrip(b, manifest.layerSize, false))),
    ]);
    const meshes = await bounded(parseTownGlb(gltfBytes));
    validateTown(meshes, manifest);
    return { manifest, meshes, color, normal };
  } finally {
    clearTimeout(timer);
  }
}

/** A WebP layer strip → a repeat-wrapped, mipmapped DataArrayTexture (one layer per kit texture). */
async function decodeStrip(blob: Blob, size: number, srgb: boolean): Promise<THREE.DataArrayTexture> {
  const url = "layer strip";
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const w = bmp.width, h = bmp.height;
  if (w !== size || h % size !== 0) throw new Error(`${url}: ${w}×${h} is not a strip of ${size} px layers`);
  const canvas: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!ctx) throw new Error("no 2D canvas");
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const data = new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer);
  return stripTexture(data, size, h / size, srgb);
}

/** Wrap RGBA layer bytes (layer 0 first, rows top-down) as the town's array texture. */
export function stripTexture(data: Uint8Array, size: number, layers: number, srgb: boolean): THREE.DataArrayTexture {
  const tex = new THREE.DataArrayTexture(data, size, size, layers);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.flipY = false; // glTF UVs: v = 0 at the top row
  tex.name = srgb ? "town_color" : "town_normal";
  tex.needsUpdate = true;
  return tex;
}

/** Decode the town GLB (meshopt) into plain per-node arrays; quantized attributes are expanded to floats. */
export async function parseTownGlb(bytes: ArrayBuffer): Promise<Map<string, TownMesh>> {
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes, "");
  const meshes = new Map<string, TownMesh>();
  gltf.scene.updateMatrixWorld(true);
  const nrm = new THREE.Matrix3();
  const v = new THREE.Vector3();
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    // A one-primitive node is the mesh itself; a two-primitive node is a group of two meshes. Either
    // way GLTFLoader keeps the glTF node name in userData.name (object names get uniqueness suffixes).
    const name = ((m.userData.name as string | undefined) ?? (m.parent?.userData.name as string | undefined) ?? m.name);
    const mat = m.material as THREE.Material;
    const kind = mat.name === "town_cutout" ? "cutout" : "opaque";
    const g = m.geometry;
    const pos = g.getAttribute("position"), n = g.getAttribute("normal"), uv = g.getAttribute("uv"), col = g.getAttribute("color");
    if (!pos || !n || !uv || !col || !g.index) throw new Error(`town node ${name}: missing attributes`);
    nrm.getNormalMatrix(m.matrixWorld);
    const count = pos.count;
    const part: TownPart = {
      position: new Float32Array(count * 3),
      normal: new Float32Array(count * 3),
      uv: new Float32Array(count * 2),
      color: new Uint8Array(count * 4),
      index: Uint32Array.from(g.index.array as ArrayLike<number>),
    };
    for (let i = 0; i < count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      part.position[i * 3] = v.x;
      part.position[i * 3 + 1] = v.y;
      part.position[i * 3 + 2] = v.z;
      v.fromBufferAttribute(n, i).applyMatrix3(nrm).normalize();
      part.normal[i * 3] = v.x;
      part.normal[i * 3 + 1] = v.y;
      part.normal[i * 3 + 2] = v.z;
      part.uv[i * 2] = uv.getX(i);
      part.uv[i * 2 + 1] = uv.getY(i);
      for (let c = 0; c < 4; c++) part.color[i * 4 + c] = Math.round(Math.min(1, Math.max(0, col.getComponent(i, c))) * 255);
    }
    let entry = meshes.get(name);
    if (!entry) meshes.set(name, (entry = { opaque: null, cutout: null }));
    entry[kind] = part;
    g.dispose();
    mat.dispose();
  });
  return meshes;
}

/** Every prefab of the layout (and its LOD1 where it has one) must be in the GLB with sane data. */
export function validateTown(meshes: Map<string, TownMesh>, manifest: Pick<TownManifest, "slots">): void {
  for (const p of TOWN_PREFABS) {
    for (const name of p.tris[1] > 0 ? [p.name, `${p.name}__L1`] : [p.name]) {
      const m = meshes.get(name);
      if (!m || (!m.opaque && !m.cutout)) throw new Error(`town GLB has no node ${name}`);
      let tris = 0;
      for (const part of [m.opaque, m.cutout]) {
        if (!part) continue;
        const n = part.position.length / 3;
        if (part.index.length % 3 !== 0) throw new Error(`town ${name}: bad index count`);
        for (let i = 0; i < part.index.length; i++) if (part.index[i]! >= n) throw new Error(`town ${name}: index out of range`);
        for (let i = 0; i < n; i++) if (part.color[i * 4 + 3]! >= manifest.slots.length) throw new Error(`town ${name}: unknown material slot`);
        for (const a of [part.position, part.normal, part.uv]) for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) throw new Error(`town ${name}: non-finite vertex data`);
        tris += part.index.length / 3;
      }
      const want = name.endsWith("__L1") ? p.tris[1] : p.tris[0];
      if (tris !== want) throw new Error(`town ${name}: ${tris} triangles, the layout expects ${want}`);
    }
  }
}
