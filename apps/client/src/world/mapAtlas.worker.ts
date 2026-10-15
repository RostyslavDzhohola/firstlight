// Web Worker: bakes the current body's map atlas (ui/mapRaster.ts) once per body, the face under
// the player first, and draws map views from it on request (the map's globe, the minimap's tile),
// so the main thread only draws finished images. Requests are served between faces while baking.

import { BODIES, createTerrain, FACES, type BodyId, type Face } from "@firstlight/shared";
import { atlasResolution, bakeFace, renderView, townRaster, type Atlas, type TownRaster } from "../ui/mapRaster.ts";
import { mapView } from "../ui/mapView.ts";
import type { V3 } from "../social/compassMath.ts";

export type MapWorkerIn =
  | { type: "bake"; body: BodyId; near: V3 }
  | { type: "render"; id: number; body: BodyId; c: V3; rot: number; ppr: number; w: number; h: number; limb: boolean };

export type MapWorkerOut =
  | { type: "face"; body: BodyId; baked: number }
  | { type: "rendered"; id: number; body: BodyId; baked: number; w: number; h: number; bitmap: ImageBitmap | null; pixels: ArrayBuffer | null };

const scope = self as unknown as { postMessage(m: MapWorkerOut, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent<MapWorkerIn>) => void) | null };

let gen = 0;
let atlas: Atlas | null = null;
let town: TownRaster | null = null;
let baked = 0;
const queue: Extract<MapWorkerIn, { type: "render" }>[] = [];
let draining = false;

async function bake(body: BodyId, near: V3, g: number) {
  const terrain = createTerrain(body);
  const n = atlasResolution(terrain.body.radius);
  atlas = { body, n, faces: [null, null, null, null, null, null] };
  baked = 0;
  town = null;
  // Nearest face first: the minimap has its ground within a fraction of the bake.
  const order = ([0, 1, 2, 3, 4, 5] as Face[]).sort((a, b) => {
    const na = FACES[a]!.n, nb = FACES[b]!.n;
    return nb[0] * near[0] + nb[1] * near[1] + nb[2] * near[2] - (na[0] * near[0] + na[1] * near[1] + na[2] * near[2]);
  });
  if (body === "portus") town = townRaster();
  for (const face of order) {
    await new Promise((r) => setTimeout(r, 0)); // let render requests and a new body in
    if (g !== gen) return;
    atlas.faces[face] = bakeFace(terrain, face, n);
    baked++;
    scope.postMessage({ type: "face", body, baked });
    void drain();
  }
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const r = queue.shift()!;
      if (!atlas || atlas.body !== r.body) {
        // Not this body's atlas (yet): answer anyway, so the client never waits on it.
        scope.postMessage({ type: "rendered", id: r.id, body: r.body, baked: 0, w: r.w, h: r.h, bitmap: null, pixels: null });
        continue;
      }
      const out = new Uint32Array(r.w * r.h);
      renderView(atlas, mapView(r.c, r.rot, r.ppr, r.w, r.h), out, { radius: BODIES[r.body].radius, town: r.body === "portus" ? town : null, limb: r.limb });
      const pixels = new Uint8ClampedArray(out.buffer);
      let bitmap: ImageBitmap | null = null;
      if (typeof createImageBitmap === "function" && typeof ImageData === "function") {
        try {
          bitmap = await createImageBitmap(new ImageData(pixels, r.w, r.h));
        } catch {
          bitmap = null;
        }
      }
      const msg: MapWorkerOut = { type: "rendered", id: r.id, body: r.body, baked, w: r.w, h: r.h, bitmap, pixels: bitmap ? null : out.buffer };
      scope.postMessage(msg, bitmap ? [bitmap] : [out.buffer]);
    }
  } finally {
    draining = false;
  }
}

scope.onmessage = (e) => {
  const m = e.data;
  if (m.type === "bake") {
    if (atlas?.body === m.body) return;
    gen++;
    void bake(m.body, m.near, gen);
  } else {
    queue.push(m); // the client keeps one request in flight per view, so this stays short
    void drain();
  }
};
