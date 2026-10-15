// The planets' pad-0 outposts on the client (D42): built from the shipped assets and the shared
// sites, their path decals on the ground, the other pads' platforms and waystones as one instanced
// mesh per material where the shared colliders put them, the glow and albedo-floor slots, the draw
// and triangle budget at the pad-0 arrival per tier, and the plain-collider fallback.
import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { createTerrain, padDirs } from "@firstlight/shared";
import { OUTPOSTS, type OutpostBody } from "@firstlight/shared/content/padOutposts";
import { outpostAnchor, padPlatformPlacement, siteDir, sitePlacements, siteSolids } from "@firstlight/shared/planet/sites";
import { emptyStored, resolveSettings, TIER_TABLE, type Tier } from "../render/quality.ts";
import { testSiteAssets } from "../render/townAssets.testutil.ts";
import { TOWN_EMISSIVE } from "../render/townMaterial.ts";
import { PAD_MODEL_RANGE, SiteTown } from "./SiteTown.ts";
import { outpostPaths, PATH_ACROSS, PATH_STEP } from "./outpostPaths.ts";

const BODIES_ = ["arcadia", "hollowmere", "meridian"] as const;
const terrains = new Map(BODIES_.map((b) => [b, createTerrain(b)] as const));
const settingsFor = (t: Tier) => resolveSettings(t, false, true, emptyStored(), new Set());

async function outpostFor(body: OutpostBody, t: Tier) {
  const town = new SiteTown(terrains.get(body)!, settingsFor(t), testSiteAssets(body));
  await town.ready;
  return town;
}

/** Eye camera at pad-0 site point `from`, `h` m up, looking at site point `to` (1.7 m up). */
function eye(body: OutpostBody, from: [number, number], to: [number, number], h = 1.7): THREE.PerspectiveCamera {
  const t = terrains.get(body)!;
  const R = t.body.radius, a = outpostAnchor(t);
  const ground = (d: number[]) => R + t.groundHeight(d[0]!, d[1]!, d[2]!);
  const f = siteDir(a, from[0], from[1], R), g = siteDir(a, to[0], to[1], R);
  const cam = new THREE.PerspectiveCamera(75, 16 / 9, 0.3, 6000);
  cam.position.set(f[0], f[1], f[2]).multiplyScalar(ground(f) + h);
  cam.up.set(f[0], f[1], f[2]);
  cam.lookAt(new THREE.Vector3(g[0], g[1], g[2]).multiplyScalar(ground(g) + 1.7));
  cam.updateMatrixWorld();
  return cam;
}

/** The arrival views: from the pad looking out over the outpost (the arrival camera faces site north). */
const views: Record<string, [[number, number], [number, number], number]> = {
  "arrival → north": [[0, -4], [0, 40], 3],
  "pad → east": [[0, 0], [40, 0], 1.7],
  "pad → west": [[0, 0], [-40, 0], 1.7],
  "pad → south": [[0, 0], [0, -40], 1.7],
};

describe.each(BODIES_)("%s pad outpost view (D42)", (body) => {
  const terrain = terrains.get(body)!;
  const site = OUTPOSTS[body];

  it("bakes the outpost into one cell with two shared materials per tier, glow slots marked", async () => {
    for (const t of ["low", "medium"] as const) {
      const town = await outpostFor(body, t);
      expect(town.drawsModels).toBe(true);
      expect(town.cells).toHaveLength(1);
      const materials = new Set<THREE.Material>();
      for (const v of town.cells[0]!.variants) for (const m of v) materials.add(m.mesh.material as THREE.Material);
      for (const m of town.pads!.meshes) materials.add(m.mesh.material as THREE.Material);
      expect(materials.size).toBeLessThanOrEqual(2);
      const names = [...materials].map((m) => m.name);
      expect(names.every((n) => n.startsWith("town:"))).toBe(true);
      expect(names.every((n) => n.includes(":floor") === (body === "hollowmere"))).toBe(true);
      if (t === "low") expect(names.every((n) => n.includes(":flat"))).toBe(true);
      // Glow slots carry the glow mode; nothing else does.
      const assets = await testSiteAssets(body);
      const glow = new Set(assets.manifest.slots.flatMap((s, i) => ((s.glow ?? 0) > 0 ? [i] : [])));
      expect(glow.size).toBeGreaterThan(0);
      let glowing = 0;
      for (const v of town.cells[0]!.variants) for (const m of v) {
        const a = m.mesh.geometry.getAttribute("townMat").array as Uint8Array;
        for (let i = 3; i < a.length; i += 4) if (a[i] === TOWN_EMISSIVE.glow) glowing++;
      }
      // Hollowmere's lit windows and teal lanterns, Meridian's teal and amber lamps (Arcadia's are flames).
      if (body !== "arcadia") expect(glowing).toBeGreaterThan(0);
      town.dispose();
    }
  });

  it("lays every path on the ground as a decal a few centimetres up, the ground never poking through", async () => {
    const R = terrain.body.radius;
    const assets = await testSiteAssets(body);
    const part = outpostPaths(body, terrain, assets.manifest.slots)!;
    const slots = new Set(site.paths.map((p) => assets.manifest.slots.findIndex((sl) => sl.name === p.mat)));
    for (let i = 3; i < part.color.length; i += 4) expect(slots.has(part.color[i]!)).toBe(true);
    // PATH_ACROSS vertices across every PATH_STEP m of every path.
    const length = site.paths.reduce((s, p) => s + p.pts.slice(1).reduce((t, q, i) => t + Math.hypot(q[0] - p.pts[i]![0], q[1] - p.pts[i]![1]), 0), 0);
    expect(part.position.length / 3).toBeGreaterThan((length / PATH_STEP) * PATH_ACROSS);
    // Every triangle's corners, edge midpoints and centre stay above the rendered ground.
    const above = (x: number, y: number, z: number) => {
      const l = Math.hypot(x, y, z);
      return l - R - terrain.groundHeight(x / l, y / l, z / l);
    };
    let low = Infinity, high = -Infinity;
    const P = part.position, I = part.index;
    for (let t = 0; t < I.length; t += 3) {
      const v = [0, 1, 2].map((k) => [P[I[t + k]! * 3]!, P[I[t + k]! * 3 + 1]!, P[I[t + k]! * 3 + 2]!]);
      const pts = [...v, ...[[0, 1], [1, 2], [2, 0]].map(([a, b]) => v[a]!.map((c, j) => (c + v[b]![j]!) / 2)), v[0]!.map((c, j) => (c + v[1]![j]! + v[2]![j]!) / 3)];
      for (const q of pts) {
        const h = above(q[0]!, q[1]!, q[2]!);
        low = Math.min(low, h);
        high = Math.max(high, h);
      }
    }
    expect(low).toBeGreaterThan(0.003);
    expect(high).toBeLessThan(0.25); // never floating visibly over a hollow
    // ...and the decals are in the drawn cell, both LODs.
    const town = await outpostFor(body, "medium");
    for (const v of town.cells[0]!.variants) {
      const opaque = v.find((m) => m.kind === "opaque")!;
      expect(opaque.triangles).toBeGreaterThan(I.length / 3);
    }
    town.dispose();
  });

  it("draws the other pads' platform and waystone as one instanced mesh, the waystone where its collider is", async () => {
    const town = await outpostFor(body, "medium");
    const pads = town.pads!;
    const n = padDirs(terrain.body).length;
    expect(pads.frames).toHaveLength(n - 1);
    expect(pads.meshes.length).toBeGreaterThanOrEqual(1);
    expect(pads.meshes.length).toBeLessThanOrEqual(2);
    // At pad 0 the next pad is out of range: no instances; at pad 1 its own is drawn.
    town.update(eye(body, [0, -4], [0, 40], 3));
    expect(pads.meshes.every((m) => m.mesh.count === 0 || !m.mesh.visible)).toBe(true);
    const p1 = padPlatformPlacement(terrain, 1);
    const cam = new THREE.PerspectiveCamera(75, 16 / 9, 0.3, 6000);
    cam.position.set(p1.px + p1.ux * 2, p1.py + p1.uy * 2, p1.pz + p1.uz * 2);
    cam.updateMatrixWorld();
    town.update(cam);
    const shown = pads.meshes[0]!.mesh.count;
    expect(shown).toBeGreaterThanOrEqual(1);
    expect(shown).toBeLessThan(n - 1 + 1);
    const within = pads.at.filter((a) => a.distanceTo(cam.position) <= PAD_MODEL_RANGE).length;
    expect(shown).toBe(within);
    // The instance frame of pad k times the waystone's offset is the shared waystone placement.
    const stones = sitePlacements(terrain).filter((p) => p.item < 0);
    const m = new THREE.Matrix4();
    stones.forEach((w) => {
      const k = -1 - w.item;
      const f = pads.frames[k - 1]!;
      const p = padPlatformPlacement(terrain, k);
      m.copy(f);
      const origin = new THREE.Vector3().setFromMatrixPosition(m);
      expect(origin.distanceTo(new THREE.Vector3(p.px, p.py, p.pz))).toBeLessThan(1e-6);
      // The stone's base relative to the pad, in the pad frame, is the same at every pad.
      const rel = new THREE.Vector3(w.px - p.px, w.py - p.py, w.pz - p.pz);
      const local = rel.applyMatrix4(new THREE.Matrix4().extractRotation(m).invert());
      const p1w = stones[0]!, p1p = padPlatformPlacement(terrain, -1 - p1w.item);
      const first = new THREE.Vector3(p1w.px - p1p.px, p1w.py - p1p.py, p1w.pz - p1p.pz).applyMatrix4(new THREE.Matrix4().extractRotation(pads.frames[-1 - p1w.item - 1]!).invert());
      expect(local.distanceTo(first)).toBeLessThan(1e-3);
    });
    // Warm-up shows every instance.
    town.setForceAll(true);
    town.update(cam);
    expect(pads.meshes[0]!.mesh.count).toBe(n - 1);
    town.dispose();
  });

  it("stays within the draw and triangle budget at the pad-0 arrival views on every tier", async () => {
    const report: Record<string, string> = {};
    for (const t of ["low", "medium", "high", "ultra"] as const) {
      const town = await outpostFor(body, t);
      const s = settingsFor(t);
      for (const [name, [from, to, h]] of Object.entries(views)) {
        const cam = eye(body, from, to, h);
        town.update(cam);
        const st = town.stats(cam);
        report[`${t} ${name}`] = `${st.draws} draws ${(st.triangles / 1000).toFixed(1)}k tris`;
        // Opaque + cutout (Meridian has no cutout), the other pads out of range.
        expect(st.draws, `${t} ${name}`).toBeLessThanOrEqual(2);
        expect(st.draws).toBeLessThanOrEqual(Math.round(TIER_TABLE[t].drawBudget * 0.02));
        expect(st.triangles, `${t} ${name}`).toBeLessThanOrEqual(t === "low" ? 25_000 : 40_000);
        // Shadow casters on Medium+: the depth-only copy (+ cutout); none on Low.
        const casters = town.cells[0]!.variants.flat().filter((m) => m.mesh.castShadow).length + (town.shadowMesh?.mesh.castShadow ? 1 : 0);
        expect(casters > 0).toBe(s.on.shadows && s.shadows.mode === "map");
      }
      town.dispose();
    }
    if (process.env.OUTPOST_BUDGET_OUT) writeFileSync(`${process.env.OUTPOST_BUDGET_OUT}.${body}.json`, JSON.stringify(report, null, 1));
  });

  it("draws the outpost's and the waystones' colliders as plain stone when the asset is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const town = new SiteTown(terrain, settingsFor("medium"), Promise.resolve(null));
      await town.ready;
      expect(town.drawsModels).toBe(false);
      expect(town.cells).toHaveLength(0);
      expect(town.pads).toBeNull();
      const meshes = town.group.children as THREE.InstancedMesh[];
      expect(meshes.reduce((s, m) => s + m.count, 0)).toBe(siteSolids(terrain).length);
      expect(siteSolids(terrain).some((x) => x.item < 0)).toBe(true); // the waystones are in it
      town.dispose();
    } finally {
      warn.mockRestore();
    }
  });
});
