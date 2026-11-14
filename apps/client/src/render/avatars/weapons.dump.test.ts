// Today's code-built held items as data, for the props tools (tools/blender/props3d: the "today"
// previews, compare renders and clip checks rebuild them in Blender). Run with an output path to
// write the dump (tools/blender/props3d/ref.sh does):
//   FL_DUMP_WEAPONS=/tmp/fl-props/ref/today_weapons.json pnpm vitest run apps/client/src/render/avatars/weapons.dump.test.ts
// Without it, the test only checks that every modelled item dumps.

import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { WEAPONS } from "@firstlight/shared/content/weapons";
import { weaponModel } from "./weapons.ts";

interface DumpedMesh {
  pos: number[];
  idx: number[] | null;
  color: string;
  roughness: number;
  metalness: number;
  emissive: string;
  emissiveIntensity: number;
  basic: boolean;
}

const hex = (c: THREE.Color) => c.getHexString(); // sRGB hex, as the designs write them

/** One entry per opaque mesh (the flame ribbon is an effect, not the model), in socket space. */
export function dumpWeapon(id: string): DumpedMesh[] {
  const obj = weaponModel(id, 0);
  if (!obj) return [];
  obj.updateMatrixWorld(true);
  const out: DumpedMesh[] = [];
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const m = mesh.material as THREE.MeshStandardNodeMaterial & THREE.MeshBasicNodeMaterial;
    if (m.transparent) return;
    const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    const basic = !(m as { isMeshStandardMaterial?: boolean }).isMeshStandardMaterial;
    out.push({
      pos: Array.from(geo.attributes.position!.array as Float32Array, (v) => Math.round(v * 1e5) / 1e5),
      idx: geo.index ? Array.from(geo.index.array) : null,
      color: basic ? "ffe2a8" : hex(m.color),
      roughness: basic ? 1 : m.roughness,
      metalness: basic ? 0 : m.metalness,
      emissive: basic ? "000000" : hex(m.emissive),
      emissiveIntensity: basic ? 0 : m.emissiveIntensity,
      basic,
    });
  });
  return out;
}

describe("today's held items as data (props tools reference)", () => {
  it("dumps every modelled item, and writes the file when asked", () => {
    const all: Record<string, DumpedMesh[]> = {};
    for (const w of WEAPONS) {
      const d = dumpWeapon(w.id);
      if (d.length) all[w.id] = d;
    }
    for (const id of ["emberglass", "axe", "longbow", "sunbrand", "riverstaff"]) expect(all[id]?.length).toBeGreaterThan(0);
    const path = process.env.FL_DUMP_WEAPONS;
    if (path) writeFileSync(path, JSON.stringify(all));
  });
});
