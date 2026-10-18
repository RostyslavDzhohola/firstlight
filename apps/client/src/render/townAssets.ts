// The shipped structure sites (D38, D42): the Portus castle town (tools/blender/portus) and each
// planet's pad outpost (tools/blender/pads). Each is one meshopt GLB with a node per prefab and LOD
// (two primitives: "town_opaque", "town_cutout"; COLOR_0 = linear tint + material slot), two WebP
// layer strips (512 px layers stacked vertically: base colour with the cutout mask in alpha, and the
// tangent-space normal) and a manifest (files, slots, data version, look). Arcadia's and Hollowmere's
// outposts use the Portus kit, so their manifests point at the Portus strips ("../portus/…"): a strip
// is downloaded and decoded once per session whichever site asks first, and the sites share it (and
// so their materials). Loaded on arrival, before the warm-up; cached for the session.
//
// The strips become two DataArrayTextures (one layer per kit texture), so the whole town draws with
// two shared materials and tiles every kit texture with plain repeat wrapping. They are decoded
// through a canvas, which zeroes the colour where the mask is 0: the material samples the colour
// layer as premultiplied (rgb / a), so filtering and mipmaps never pull dark fringes into leaves.

import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { PORTUS_TOWN_VERSION, TOWN_PREFABS, type TownPrefab } from "@firstlight/shared/content/portusTown";
import { OUTPOSTS, type OutpostBody } from "@firstlight/shared/content/padOutposts";
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
  /** Glows in its own tint above the bloom threshold, day and night (the outposts' lamps; Hollowmere's windows). */
  glow?: number;
}

/** A site's look adjustments (outposts): a lighter albedo floor for the dusk body's town materials. */
export interface TownLook {
  albedoFloor: number;
}

export interface TownManifest {
  version: string;
  /** Strip file names are relative to the site's folder ("../portus/…" for a shared strip). */
  files: Record<"glb" | "color" | "normal", { name: string; bytes: number; sha256: string }>;
  layerSize: number;
  layers: string[];
  slots: TownSlot[];
  items: number;
  trianglesLod0: number;
  look?: TownLook;
}

/** A structure site with shipped assets: Portus' town or a planet's pad outpost. */
export type SiteId = "portus" | OutpostBody;

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
  site?: SiteId;
  manifest: TownManifest;
  /** Node name ("house_a", "house_a__L1") → geometry. */
  meshes: Map<string, TownMesh>;
  color: THREE.Texture;
  normal: THREE.Texture;
}

const pending = new Map<SiteId, Promise<TownAssets | null>>();
/** Decoded strips by resolved URL: Portus and the Portus-kit outposts share theirs. A failed decode is dropped. */
const strips = new Map<string, Promise<THREE.DataArrayTexture>>();

/** The site folder under the asset base. */
export function siteFolder(site: SiteId): string {
  return site === "portus" ? "portus/" : `outposts/${site}/`;
}

/** The layout version a site's manifest must carry. */
export function siteVersion(site: SiteId): string {
  return site === "portus" ? PORTUS_TOWN_VERSION : OUTPOSTS[site].version;
}

/** The prefab table a site's GLB must hold. */
export function sitePrefabTable(site: SiteId): readonly TownPrefab[] {
  return site === "portus" ? TOWN_PREFABS : OUTPOSTS[site].prefabs;
}

/** `name` relative to folder URL `base` ("a/b/" + "../c/x" → "a/c/x"); absolute names pass through. */
export function resolveAsset(base: string, name: string): string {
  if (/^[a-z]+:|^\//i.test(name)) return name;
  const m = /^([a-z]+:\/\/[^/]*)?(.*)$/i.exec(base)!;
  const origin = m[1] ?? "";
  const parts = (m[2]! + name).split("/");
  const out: string[] = [];
  parts.forEach((p, i) => {
    if (p === "..") {
      if (out.length > 1 || (out.length === 1 && out[0] !== "")) out.pop();
    } else if (p !== "." && (p !== "" || i === 0 || i === parts.length - 1)) out.push(p);
  });
  return origin + out.join("/");
}

/**
 * A download (manifest, GLB, both strips) that gets no byte for this many milliseconds is aborted,
 * so a hung request can't stay in the session cache: the next arrival tries again. One that keeps
 * receiving goes on however slow the network (D-load-6; it was 15 s for the whole download): what
 * lands after the arrival's deadline (SiteTown TOWN_LOAD_DEADLINE_MS) goes in at the next loading
 * screen, and the next arrival uses it from the cache. A byte of any town download counts for all
 * of them (they share the Portus strips).
 */
export const TOWN_FETCH_TIMEOUT_MS = 45_000;

/** The idle timers of the town downloads in flight: each restarts on any download's progress. */
const inFlight = new Set<() => void>();
function progressed() {
  for (const restart of inFlight) restart();
}

/** Start (or reuse) a site's download. Resolves null if anything fails or times out (the site then draws its colliders as plain stone). */
export function preloadSite(site: SiteId): Promise<TownAssets | null> {
  let p = pending.get(site);
  if (!p) {
    p = loadSite(site).catch((e: unknown) => {
      console.warn(`[town] ${site} structure assets failed to load; drawing plain colliders`, e);
      pending.delete(site); // try again on the next arrival
      return null;
    });
    pending.set(site, p);
  }
  return p;
}

/** The Portus town's download (preloadSite("portus")). */
export function preloadTown(): Promise<TownAssets | null> {
  return preloadSite("portus");
}

type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

/** Download, decode and validate the Portus town (loadSite("portus")). */
export function loadTown(fetchImpl: Fetch = (u, i) => fetch(u, i), timeoutMs = TOWN_FETCH_TIMEOUT_MS): Promise<TownAssets> {
  return loadSite("portus", fetchImpl, timeoutMs);
}

/**
 * Download, decode and validate a site; rejects on any failure, or when no byte came for `timeoutMs`
 * (every request is aborted).
 */
export async function loadSite(site: SiteId, fetchImpl: Fetch = (u, i) => fetch(u, i), timeoutMs = TOWN_FETCH_TIMEOUT_MS): Promise<TownAssets> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const restart = () => {
    clearTimeout(timer);
    timer = setTimeout(() => abort.abort(new Error(`town assets: no answer in ${timeoutMs} ms`)), timeoutMs);
  };
  restart();
  inFlight.add(restart);
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
    progressed();
    if (!r.ok) throw new Error(`${url} ${r.status}`);
    return r;
  };
  /** The whole body, read part by part: every part is progress (the idle timer restarts). */
  const body = async (r: Response): Promise<Uint8Array<ArrayBuffer>> => {
    if (!r.body) return new Uint8Array(await bounded(r.arrayBuffer()));
    const reader = r.body.getReader();
    const parts: Uint8Array[] = [];
    let n = 0;
    try {
      for (;;) {
        const { done, value } = await bounded(reader.read());
        if (done) break;
        parts.push(value);
        n += value.byteLength;
        progressed();
      }
    } catch (e) {
      void reader.cancel(e).catch(() => undefined);
      throw e;
    }
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.byteLength;
    }
    return out;
  };
  try {
    const base = `${config.assetBase}/${siteFolder(site)}`;
    const manifest = JSON.parse(new TextDecoder().decode(await body(await get(`${base}manifest.json`)))) as TownManifest;
    const want = siteVersion(site);
    if (manifest.version !== want) {
      // A stale cache or a half-finished deploy: the geometry may not match the layout.
      throw new Error(`asset version ${manifest.version} does not match the layout ${want}`);
    }
    // A strip shared with another site is fetched and decoded once (its first download's signal).
    const strip = (name: string, srgb: boolean) => {
      const url = resolveAsset(base, name);
      const key = `${url}|${srgb ? 1 : 0}`;
      let p = strips.get(key);
      if (!p) {
        p = get(url).then(body).then((b) => bounded(decodeStrip(new Blob([b]), manifest.layerSize, srgb)));
        strips.set(key, p);
        p.catch(() => strips.delete(key));
      }
      return bounded(p);
    };
    const [gltfBytes, color, normal] = await Promise.all([
      get(resolveAsset(base, manifest.files.glb.name)).then(body).then((b) => b.buffer),
      strip(manifest.files.color.name, true),
      strip(manifest.files.normal.name, false),
    ]);
    const meshes = await bounded(parseTownGlb(gltfBytes));
    validateTown(meshes, manifest, sitePrefabTable(site));
    return { site, manifest, meshes, color, normal };
  } finally {
    clearTimeout(timer);
    inFlight.delete(restart);
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
export function validateTown(meshes: Map<string, TownMesh>, manifest: Pick<TownManifest, "slots">, prefabs: readonly TownPrefab[] = TOWN_PREFABS): void {
  for (const p of prefabs) {
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
