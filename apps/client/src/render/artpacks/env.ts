// The browser side of the HD art packs (ArtPacks.ts): the manifest and files from the asset base,
// SHA-256 checks, decoding off the main thread (strips in a worker, images through createImageBitmap),
// textures made like the shipped ones (same class, format and sampler: no new programs), uploads in
// slices, and the slots of the shipped textures loaded in this session.

import * as THREE from "three/webgpu";
import { config, flags } from "../../config.ts";
import { avatarTextureSlot } from "../avatars/assets.ts";
import { loadedStrip, stripTexture } from "../townAssets.ts";
import { townStripSlot } from "../townMaterial.ts";
import { loadedVegetation, vegetationAtlasSlot } from "../vegetationAssets.ts";
import { ArtPacks, type ArtPacksEnv, type TextureSlot } from "./ArtPacks.ts";
import { parsePackFlag, type PackEntry, type PackManifest } from "./catalog.ts";
import type { StripJob, StripResult } from "./strip.worker.ts";

/** The packs' folder under the asset base (built by tools/blender/artpacks). */
export const PACK_FOLDER = "packs/hd";

/**
 * Array-texture layers uploaded per frame: one 1024² RGBA layer is 4 MB. Two per frame measured up to
 * 33 ms per step on WebGL2 on the M1 (texSubImage3D and the array's mip rebuild), over the ~25 ms a
 * frame may take (D-artpacks-4).
 */
export const LAYERS_PER_STEP = 1;

/** A pack file that takes longer than this is dropped (the shipped textures stay). */
export const PACK_FILE_TIMEOUT_MS = 120_000;

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

let worker: Worker | null = null;
let jobs = 0;
const waiting = new Map<number, { resolve: (d: ArrayBuffer) => void; reject: (e: Error) => void }>();
function decodeStrip(blob: Blob, size: number, layers: number, cols: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!worker) {
    worker = new Worker(new URL("./strip.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<StripResult>) => {
      const w = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      if (!w) return;
      if ("error" in e.data) w.reject(new Error(e.data.error));
      else w.resolve(e.data.data);
    };
  }
  const id = ++jobs;
  return new Promise<Uint8Array>((resolve, reject) => {
    waiting.set(id, { resolve: (d) => resolve(new Uint8Array(d)), reject });
    signal.addEventListener("abort", () => {
      waiting.delete(id); // the worker finishes and its answer is dropped
      reject(signal.reason ?? new Error("aborted"));
    }, { once: true });
    worker!.postMessage({ id, blob, size, layers, cols } satisfies StripJob);
  });
}

/** Copy what the program and the binding depend on from the shipped texture (sampler, colour space, UV transform). */
export function likeShipped(t: THREE.Texture, like: THREE.Texture): THREE.Texture {
  t.colorSpace = like.colorSpace;
  t.flipY = like.flipY;
  t.premultiplyAlpha = like.premultiplyAlpha;
  t.wrapS = like.wrapS;
  t.wrapT = like.wrapT;
  (t as THREE.DataArrayTexture).wrapR = (like as THREE.DataArrayTexture).wrapR;
  t.magFilter = like.magFilter;
  t.minFilter = like.minFilter;
  t.anisotropy = like.anisotropy;
  t.generateMipmaps = like.generateMipmaps;
  t.mapping = like.mapping;
  t.channel = like.channel;
  t.format = like.format;
  t.type = like.type;
  t.offset.copy(like.offset);
  t.repeat.copy(like.repeat);
  t.center.copy(like.center);
  t.rotation = like.rotation;
  t.matrixAutoUpdate = like.matrixAutoUpdate;
  t.matrix.copy(like.matrix);
  t.name = `${like.name || "texture"}:hd`;
  return t;
}

/** The slot of a shipped texture by its manifest key, if it is loaded in this session. */
function shippedSlot(base: string): { slot: TextureSlot; sha256: string | null } | null {
  if (base.startsWith("characters/")) {
    const slot = avatarTextureSlot(base.slice("characters/".length).replace(/\.webp$/, ""));
    return slot ? { slot, sha256: null } : null;
  }
  if (base === "vegetation/vegetation.glb#vegetation_atlas") {
    const v = loadedVegetation();
    return v ? { slot: vegetationAtlasSlot(v.atlas), sha256: null } : null;
  }
  const strip = loadedStrip(base);
  return strip ? { slot: townStripSlot(strip.texture), sha256: strip.sha256 } : null;
}

export function artPacksEnv(renderer: THREE.WebGPURenderer): ArtPacksEnv {
  const folder = `${config.assetBase}/${PACK_FOLDER}`;
  return {
    async manifest() {
      const r = await fetch(`${folder}/manifest.json`, { priority: "low" } as RequestInit);
      if (!r.ok) throw new Error(`pack manifest ${r.status}`);
      const m = (await r.json()) as PackManifest;
      return m?.version === 1 && m.files ? m : null;
    },
    async download(entry: PackEntry, signal: AbortSignal) {
      const s = AbortSignal.any([signal, AbortSignal.timeout(PACK_FILE_TIMEOUT_MS)]);
      const r = await fetch(`${folder}/${entry.file}`, { signal: s, priority: "low" } as RequestInit);
      if (!r.ok) throw new Error(`${entry.file} ${r.status}`);
      const buf = await r.arrayBuffer();
      const sha = hex(await crypto.subtle.digest("SHA-256", buf));
      if (sha !== entry.sha256) throw new Error(`${entry.file}: SHA-256 ${sha} is not the manifest's`);
      return new Uint8Array(buf);
    },
    slot: shippedSlot,
    async make(entry: PackEntry, bytes: Uint8Array, like: THREE.Texture, signal: AbortSignal) {
      const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/webp" });
      if (entry.layers && entry.layerSize) {
        const data = await decodeStrip(blob, entry.layerSize, entry.layers, entry.cols ?? 1, signal);
        return likeShipped(stripTexture(data, entry.layerSize, entry.layers, like.colorSpace === THREE.SRGBColorSpace), like);
      }
      // As GLTFLoader's ImageBitmapLoader and TextureLoader make the shipped ones: straight alpha, no colour conversion, no flip.
      const bmp = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
      if (signal.aborted) {
        bmp.close();
        throw signal.reason ?? new Error("aborted");
      }
      if (bmp.width !== entry.width || bmp.height !== entry.height) {
        bmp.close();
        throw new Error(`${entry.file}: ${bmp.width}×${bmp.height}, the manifest says ${entry.width}×${entry.height}`);
      }
      const t = likeShipped(new THREE.Texture(bmp as unknown as HTMLImageElement), like);
      t.needsUpdate = true;
      return t;
    },
    uploadSteps(t: THREE.Texture) {
      const steps: (() => void)[] = [];
      const arr = t as THREE.DataArrayTexture;
      if (arr.isDataArrayTexture) {
        const n = arr.image.depth;
        for (let l = 0; l < n; l += LAYERS_PER_STEP) {
          const last = l + LAYERS_PER_STEP >= n;
          steps.push(() => {
            for (let k = l; k < Math.min(n, l + LAYERS_PER_STEP); k++) arr.addLayerUpdate(k);
            arr.needsUpdate = true;
            renderer.initTexture(arr);
            if (last) (arr.image as { data: unknown }).data = null; // on the GPU now; the bytes are 64 MB of JS heap
          });
        }
      } else {
        steps.push(() => {
          renderer.initTexture(t);
          const img = t.image as ImageBitmap;
          const { width, height } = img;
          img.close?.(); // 16–64 MB outside the JS heap; three never reads it again
          t.image = { width, height };
        });
      }
      return steps;
    },
    later(fn, ms) {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
    now: () => performance.now(),
  };
}

/** The session's packs, per the URL (`?packs`, `?packs=off`, `?nopacks`) and the tier table. */
export function createArtPacks(renderer: THREE.WebGPURenderer): ArtPacks {
  const delay = Number(flags.get("packsdelay")); // tests: hold the swap back for a "before" screenshot
  if (Number.isFinite(delay) && delay >= 0 && flags.get("packsdelay") !== null) ArtPacks.START_DELAY_MS = delay;
  return new ArtPacks(artPacksEnv(renderer), parsePackFlag(flags.get("packs"), flags.has("nopacks")));
}
