// Web Worker (SPEC §6.9): places the body's breakable props with the shared deterministic
// placement, builds each archetype's intact mesh and pre-fractures it with three-piñata into a
// few fixed-seed variants (live fracture costs 10–650 ms: tech-facts §3), then transfers every
// array back without copying. The main thread caches the result for the session.

import type { BodyId } from "@firstlight/shared";
import { assetBuffers, buildBreakableAssets, type BreakableAssets } from "./breakableShapes.ts";

export interface FractureRequest {
  id: number;
  body: BodyId;
  quality: 0 | 1;
  /** false: intact meshes only (?nodestruct). */
  fracture: boolean;
}

export interface FractureResponse {
  id: number;
  assets: BreakableAssets | null;
  error?: string;
}

self.onmessage = (e: MessageEvent<FractureRequest>) => {
  const r = e.data;
  try {
    const assets = buildBreakableAssets(r.body, { quality: r.quality, fracture: r.fracture });
    const res: FractureResponse = { id: r.id, assets };
    (self as unknown as Worker).postMessage(res, assetBuffers(assets));
  } catch (err) {
    const res: FractureResponse = { id: r.id, assets: null, error: String((err as Error)?.stack ?? err) };
    (self as unknown as Worker).postMessage(res);
  }
};
