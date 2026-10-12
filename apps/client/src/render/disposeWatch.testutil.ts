// Test helper (imported only by *.test.ts): records `dispose` events on every object, geometry,
// material and texture reachable from a subtree, to check views free what they own.

import type * as THREE from "three/webgpu";
import { drawables, texturesOf } from "./dispose.ts";

export interface DisposalWatch {
  /** Everything watched. */
  all: Set<object>;
  /** What fired `dispose`. */
  disposed: Set<object>;
}

export function watchDisposals(root: THREE.Object3D, into: DisposalWatch = { all: new Set(), disposed: new Set() }): DisposalWatch {
  const watch = (x: object) => {
    if (into.all.has(x)) return;
    into.all.add(x);
    (x as THREE.EventDispatcher<{ dispose: object }>).addEventListener("dispose", () => into.disposed.add(x));
  };
  for (const o of drawables(root)) {
    watch(o);
    if (o.geometry && !o.isSprite) watch(o.geometry);
    const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of ms) {
      watch(m);
      const texs = new Set<THREE.Texture>();
      texturesOf(m, texs);
      for (const t of texs) watch(t);
    }
  }
  return into;
}

/** A canvas good enough for CanvasTexture labels in node tests (no drawing happens). */
export function stubCanvasDocument(): () => void {
  const g = globalThis as { document?: unknown };
  const had = "document" in g;
  const prev = g.document;
  const ctx = new Proxy({}, { get: (_t, k) => (k === "measureText" ? () => ({ width: 10 }) : k === "createLinearGradient" ? () => ({ addColorStop() {} }) : k === "getImageData" || k === "createImageData" ? (w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4) }) : () => {}), set: () => true });
  g.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx, style: {} }) };
  return () => {
    if (had) g.document = prev;
    else delete g.document;
  };
}
