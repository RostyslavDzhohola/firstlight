// The Portus town view (D38): built from the shipped asset and the shared layout, its draw and
// triangle budget at the spawn views per tier, LOD switching, horizon culling and the fallback.
import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { createTerrain } from "@firstlight/shared";
import { TOWN_LAYOUT, TOWN_PREFABS } from "@firstlight/shared/content/portusTown";
import { townDir, townSolids } from "@firstlight/shared/planet/town";
import { emptyStored, resolveSettings, TIER_TABLE, type Tier } from "../render/quality.ts";
import { testTownAssets } from "../render/townAssets.testutil.ts";
import { PortusTown, TOWN_LOD_DISTANCE } from "./PortusTown.ts";

const terrain = createTerrain("portus");
const R = terrain.body.radius;
const settingsFor = (t: Tier) => resolveSettings(t, false, true, emptyStored(), new Set());

/** Eye camera at town point `from`, 1.7 m up, looking at town point `to` (1.7 m up). */
function eye(from: [number, number], to: [number, number]): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(75, 16 / 9, 0.3, 6000);
  const a = townDir(from[0], from[1], R), b = townDir(to[0], to[1], R);
  cam.position.set(a[0], a[1], a[2]).multiplyScalar(R + 1.7);
  cam.up.set(a[0], a[1], a[2]);
  cam.lookAt(new THREE.Vector3(b[0], b[1], b[2]).multiplyScalar(R + 1.7));
  cam.updateMatrixWorld();
  return cam;
}

const views: Record<string, [[number, number], [number, number]]> = {
  "spawn → north (keep)": [[0, 0], [0, 40]],
  "plaza_eye (0,-6) → north": [[0, -6], [0, 40]],
  "spawn → east gate": [[0, 0], [46, 0]],
  "spawn → south": [[0, 0], [0, -40]],
};

async function townFor(t: Tier) {
  const town = new PortusTown(terrain, settingsFor(t), testTownAssets());
  await town.ready;
  return town;
}

describe("Portus town view", () => {
  it("bakes every placed prefab into merged cell meshes with two shared materials per tier", async () => {
    for (const t of ["low", "medium"] as const) {
      const town = await townFor(t);
      const materials = new Set<THREE.Material>();
      let lod0 = 0;
      for (const c of town.cells) {
        for (const m of c.variants[0]) {
          materials.add(m.mesh.material as THREE.Material);
          lod0 += m.triangles;
          expect(m.mesh.geometry.getAttribute("townMat").itemSize).toBe(4);
          expect(m.mesh.geometry.getAttribute("color").normalized).toBe(true);
        }
        for (const m of c.variants[1]) materials.add(m.mesh.material as THREE.Material);
      }
      expect(materials.size).toBeLessThanOrEqual(2);
      expect([...materials].every((m) => m.name.startsWith("town:"))).toBe(true);
      if (t === "low") expect([...materials].every((m) => m.name.endsWith(":flat"))).toBe(true);
      // LOD0 cells hold the whole layout at full detail (the paving is split across cells).
      expect(lod0).toBe(TOWN_LAYOUT.reduce((s, it) => s + TOWN_PREFABS[it[0]]!.tris[0], 0));
      town.dispose();
    }
  });

  it("stays within the draw and triangle budget at the spawn views on every tier", async () => {
    const report: Record<string, unknown> = {};
    for (const t of ["low", "medium", "high", "ultra"] as const) {
      const town = await townFor(t);
      const s = settingsFor(t);
      for (const [name, [from, to]] of Object.entries(views)) {
        const cam = eye(from, to);
        town.update(cam);
        const focus = cam.position.clone().setLength(R);
        const st = town.stats(cam, focus, s.shadows.mode === "map" ? s.shadows.extent * Math.SQRT2 : 0);
        report[`${t} ${name}`] = `${st.draws} draws + ${st.shadowDraws} shadow, ${(st.triangles / 1000).toFixed(1)}k tris`;
        // A small, fixed share of the tier's draw budget, whatever the view.
        // Two draws (opaque + cutout) and the same two in the shadow map, whatever the view: a
        // sliver of every tier's budget (SPEC §7.3: Low 150, Medium 250).
        expect(st.draws + st.shadowDraws, `${t} ${name}`).toBeLessThanOrEqual(Math.min(4, Math.round(TIER_TABLE[t].drawBudget * 0.02)));
        expect(st.triangles, `${t} ${name}`).toBeLessThanOrEqual(t === "low" ? 150_000 : 200_000);
        if (t === "low") expect(st.shadowDraws).toBe(0);
      }
      town.dispose();
    }
    if (process.env.TOWN_BUDGET_OUT) writeFileSync(process.env.TOWN_BUDGET_OUT, JSON.stringify(report, null, 1));
  });

  it("shows LOD1 beyond the tier's distance (always on Low) and hides the town below the horizon", async () => {
    const town = await townFor("medium");
    const lod = () => town.cells.map((c) => c.shown);
    town.update(eye([0, 0], [0, 40]));
    expect(lod().every((v) => v === 0)).toBe(true);
    town.update(eye([70, -7], [0, 0])); // outside the east gate, looking back
    expect(lod().every((v) => v === 0)).toBe(true);
    const away = eye([0, -200], [0, 0]); // 200 m round the planet: LOD1, the keep still over the horizon
    town.update(away);
    expect(Math.max(0, away.position.distanceTo(town.cells[0]!.centre) - town.cells[0]!.radius)).toBeGreaterThan(TOWN_LOD_DISTANCE.medium);
    expect(lod().every((v) => v === 1)).toBe(true);
    expect(town.stats(away).draws).toBeGreaterThan(0);
    // On the far side of the planet nothing of the town is drawn.
    const far = eye([0, -440], [0, -470]);
    town.update(far);
    expect(town.stats(far).draws).toBe(0);
    town.dispose();
    const low = await townFor("low");
    low.update(eye([0, 0], [0, 40]));
    expect(low.cells.every((c) => c.shown === 1)).toBe(true);
    low.dispose();
  });

  it("draws the colliders as plain stone when the asset is missing (nothing blocks invisibly)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const town = new PortusTown(terrain, settingsFor("medium"), Promise.resolve(null));
      await town.ready;
      expect(town.cells).toHaveLength(0);
      const meshes = town.group.children as THREE.InstancedMesh[];
      expect(meshes.reduce((s, m) => s + m.count, 0)).toBe(townSolids(terrain).length);
      expect(town.stats().draws).toBe(2);
      town.dispose();
    } finally {
      warn.mockRestore();
    }
  });
});
