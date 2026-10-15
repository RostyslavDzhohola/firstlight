// A planet outpost's paths as ground decals (D42): the shared path strips (content/padOutposts.ts:
// centre lines, widths and a material slot; the same strips the grass and natural-prop masks clear,
// planet/outpostGround.ts), laid on the rendered ground. Each path is one continuous ribbon with
// mitred joints (no overlapping quads to fight), a vertex every PATH_STEP m along it and three across,
// lifted PATH_LIFT m off the ground, each path a few millimetres higher than the one before so their
// crossings don't flicker. UVs follow the design build (tools/blender/pads/design.py build_paths):
// the RockTrim trim sheet's fieldstone band at 4 m per U, tiling kit textures at 2 m per UV.

import type { Terrain } from "@firstlight/shared";
import { OUTPOSTS, type OutpostBody } from "@firstlight/shared/content/padOutposts";
import { outpostAnchor, siteDir } from "@firstlight/shared/planet/sites";
import type { TownPart, TownSlot } from "../render/townAssets.ts";

/** Longest ribbon segment (m): well under a terrain quad, so the ribbon follows the ground. */
export const PATH_STEP = 0.8;
/** Lift (m) off the rendered ground. */
export const PATH_LIFT = 0.04;
/** The RockTrim trim sheet's fieldstone band (v range: tools/blender/portus/build.py BAND.field). */
const FIELD_BAND: readonly [number, number] = [0.7, 0.98];
/** Slots drawn with the trim sheet's band (the others tile). */
const TRIM_SLOTS = new Set(["MI_RockTrim"]);

/** The outpost's path decals in world space (one part), or null if it has none or no slot fits. */
export function outpostPaths(body: OutpostBody, terrain: Terrain, slots: readonly TownSlot[]): TownPart | null {
  const site = OUTPOSTS[body];
  const R = terrain.body.radius;
  const anchor = outpostAnchor(terrain);
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [], col: number[] = [], idx: number[] = [];
  const dir: [number, number, number] = [0, 0, 0];
  site.paths.forEach((pa, k) => {
    const slot = slots.findIndex((s) => s.name === pa.mat);
    if (slot < 0) {
      console.warn(`[town] ${body} path material ${pa.mat} has no slot; path skipped`);
      return;
    }
    // Dense centre line.
    const pts: [number, number][] = [];
    for (let i = 0; i + 1 < pa.pts.length; i++) {
      const [ae, an] = pa.pts[i]!, [be, bn] = pa.pts[i + 1]!;
      const n = Math.max(1, Math.ceil(Math.hypot(be - ae, bn - an) / PATH_STEP));
      for (let s = 0; s < n; s++) pts.push([ae + ((be - ae) * s) / n, an + ((bn - an) * s) / n]);
    }
    pts.push([pa.pts.at(-1)![0], pa.pts.at(-1)![1]]);
    const w = pa.width / 2;
    const trim = TRIM_SLOTS.has(pa.mat);
    const lift = PATH_LIFT + 0.004 * k;
    const v0 = pos.length / 3;
    let run = 0;
    pts.forEach(([e, n], i) => {
      // Mitred side direction: the mean of the neighbouring segments' left normals, stretched so
      // the ribbon keeps its width round the bend.
      const seg = (a: number, b: number) => {
        const [ae, an] = pts[a]!, [be, bn] = pts[b]!;
        const l = Math.hypot(be - ae, bn - an) || 1;
        return [-(bn - an) / l, (be - ae) / l] as const;
      };
      const l0 = i > 0 ? seg(i - 1, i) : seg(i, i + 1);
      const l1 = i + 1 < pts.length ? seg(i, i + 1) : l0;
      let se = l0[0] + l1[0], sn = l0[1] + l1[1];
      const sl = Math.hypot(se, sn) || 1;
      se /= sl;
      sn /= sl;
      const stretch = 1 / Math.max(0.5, se * l1[0] + sn * l1[1]);
      if (i > 0) run += Math.hypot(e - pts[i - 1]![0], n - pts[i - 1]![1]);
      for (const a of [-1, 0, 1]) {
        siteDir(anchor, e + se * w * a * stretch, n + sn * w * a * stretch, R, dir);
        const r = R + terrain.groundHeight(dir[0], dir[1], dir[2]) + lift;
        pos.push(dir[0] * r, dir[1] * r, dir[2] * r);
        nrm.push(dir[0], dir[1], dir[2]);
        if (trim) uv.push(run / 4, FIELD_BAND[0] + ((a + 1) / 2) * (FIELD_BAND[1] - FIELD_BAND[0]));
        else uv.push(run / 2, ((a + 1) * w) / 2);
        col.push(255, 255, 255, slot);
      }
    });
    for (let i = 0; i + 1 < pts.length; i++) {
      for (let c = 0; c < 2; c++) {
        const a = v0 + i * 3 + c, b = a + 1, d = a + 3, e = d + 1;
        // Counter-clockwise seen from above: a (near, right) → d (far, right) → e (far, left) → b (near, left).
        idx.push(a, d, e, a, e, b);
      }
    }
  });
  if (idx.length === 0) return null;
  return {
    position: Float32Array.from(pos),
    normal: Float32Array.from(nrm),
    uv: Float32Array.from(uv),
    color: Uint8Array.from(col),
    index: Uint32Array.from(idx),
  };
}
