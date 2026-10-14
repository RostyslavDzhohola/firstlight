// The Portus town view (D38): built from the shipped asset and the shared layout, its draw and
// triangle budget at the spawn views per tier, LOD switching, horizon culling and the fallback.
import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { createTerrain } from "@firstlight/shared";
import { TOWN_LAYOUT, TOWN_PREFABS, TOWN_STREETS } from "@firstlight/shared/content/portusTown";
import { townCoords, townDir, townSolids } from "@firstlight/shared/planet/town";
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

  it("lays the road paving onto the rising rim beyond the flat floor (no buried decal)", async () => {
    const town = await townFor("medium");
    const road = TOWN_STREETS.find((st) => st.name === "east")!.pts;
    const nearRoad = (e: number, n: number) => road.some(([a, b], k) => {
      const q = road[k + 1];
      if (!q) return false;
      const de = q[0] - a, dn = q[1] - b, t = Math.max(0, Math.min(1, ((e - a) * de + (n - b) * dn) / (de * de + dn * dn)));
      return Math.hypot(e - a - de * t, n - b - dn * t) < 3.5; // the strip's edge vertices sit 3 m out
    });
    let checked = 0;
    for (const m of town.cells[0]!.variants[0]) {
      const a = m.mesh.geometry.getAttribute("position").array as Float32Array;
      for (let i = 0; i < a.length; i += 3) {
        const [e, n] = townCoords(a[i]!, a[i + 1]!, a[i + 2]!, R);
        if (Math.hypot(e, n) < 76 || !nearRoad(e, n)) continue;
        const l = Math.hypot(a[i]!, a[i + 1]!, a[i + 2]!);
        const above = l - R - terrain.groundHeight(a[i]! / l, a[i + 1]! / l, a[i + 2]! / l);
        expect(above).toBeGreaterThan(-0.02);
        expect(above).toBeLessThan(0.25);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
    town.dispose();
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

  it("draws the colliders as plain stone, at the colliders' size, when the asset is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const town = new PortusTown(terrain, settingsFor("medium"), Promise.resolve(null));
      await town.ready;
      expect(town.cells).toHaveLength(0);
      const meshes = town.group.children as THREE.InstancedMesh[];
      const solids = townSolids(terrain);
      expect(meshes.reduce((s, m) => s + m.count, 0)).toBe(solids.length);
      expect(town.stats().draws).toBe(2);
      // Every instance's drawn extent is its solid: half widths hx, hz across, 0..h up (review S2).
      const lists = [solids.filter((x) => x.shape === 0), solids.filter((x) => x.shape === 1)];
      const m = new THREE.Matrix4(), v = new THREE.Vector3();
      meshes.forEach((mesh, k) => {
        const pos = mesh.geometry.getAttribute("position");
        lists[k]!.forEach((sol, i) => {
          mesh.getMatrixAt(i, m);
          let ex = 0, ez = 0, rad = 0, y0 = Infinity, y1 = -Infinity;
          for (let j = 0; j < pos.count; j++) {
            v.fromBufferAttribute(pos, j).applyMatrix4(m).sub(new THREE.Vector3(sol.px, sol.py, sol.pz));
            const lx = v.x * sol.rx + v.y * sol.ry + v.z * sol.rz, lz = v.x * sol.fx + v.y * sol.fy + v.z * sol.fz;
            const ly = v.x * sol.ux + v.y * sol.uy + v.z * sol.uz;
            ex = Math.max(ex, Math.abs(lx));
            ez = Math.max(ez, Math.abs(lz));
            rad = Math.max(rad, Math.hypot(lx, lz));
            y0 = Math.min(y0, ly);
            y1 = Math.max(y1, ly);
          }
          if (k === 0) {
            expect(ex, `box ${i}`).toBeCloseTo(sol.hx, 4);
            expect(ez, `box ${i}`).toBeCloseTo(sol.hz, 4);
          } else expect(rad, `cylinder ${i}`).toBeCloseTo(sol.hx, 4); // its rim is the collider's radius
          expect(y0).toBeCloseTo(0, 4);
          expect(y1).toBeCloseTo(sol.h, 4);
        });
      });
      town.dispose();
    } finally {
      warn.mockRestore();
    }
  });

  it("shows the fallback by its deadline when the asset never arrives, and ignores a late one (review S1)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const never = new PortusTown(terrain, settingsFor("medium"), new Promise(() => {}), 30);
      await never.ready; // settles at the deadline
      expect(never.cells).toHaveLength(0);
      expect(never.group.children).toHaveLength(2);
      never.dispose();
      const assets = await testTownAssets();
      const late = new PortusTown(terrain, settingsFor("medium"), new Promise((r) => setTimeout(() => r(assets), 120)), 30);
      await late.ready;
      expect(late.group.children).toHaveLength(2);
      await new Promise((r) => setTimeout(r, 200)); // the asset lands after the deadline
      expect(late.cells).toHaveLength(0);
      expect(late.group.children).toHaveLength(2); // still the fallback: no meshes after the warm-up
      expect(warn).toHaveBeenCalled();
      late.dispose();
    } finally {
      warn.mockRestore();
    }
  });
});
