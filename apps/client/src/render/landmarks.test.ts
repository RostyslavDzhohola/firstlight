// Horizon landmarks (D-gfx-worlds-1): pure visuals that nobody can reach, cheap enough for every tier.
import { describe, expect, it } from "vitest";
import type * as THREE from "three/webgpu";
import { BODIES } from "@firstlight/shared";
import { buildLandmarks, Landmarks, spreadDirs } from "./landmarks.ts";
import { watchDisposals } from "./disposeWatch.testutil.ts";

describe("horizon landmarks", () => {
  it("the hub has none; each planet has its own set", () => {
    expect(buildLandmarks("portus")).toBeNull();
    const tris = (["arcadia", "hollowmere", "meridian"] as const).map((b) => buildLandmarks(b)!.triangles);
    for (const t of tris) expect(t).toBeGreaterThan(300);
    expect(new Set(tris).size).toBe(3);
  });

  it("every vertex hangs well above anything a player can stand on, and the soup stays small", () => {
    for (const body of ["arcadia", "hollowmere", "meridian"] as const) {
      const b = buildLandmarks(body)!;
      const def = BODIES[body];
      const peak = Math.max(0, ...(def.peaks ?? []).map((p) => p.height));
      let lowest = Infinity;
      for (let i = 0; i < b.pos.length; i += 3) {
        const r = Math.hypot(b.pos[i]!, b.pos[i + 1]!, b.pos[i + 2]!);
        expect(Number.isFinite(r)).toBe(true);
        lowest = Math.min(lowest, r - def.radius);
      }
      // A jump is a couple of metres: 20 m over the highest named peak is out of reach.
      expect(lowest, body).toBeGreaterThan(peak + 20);
      expect(b.triangles, body).toBeLessThan(12_000);
      expect(b.col.length).toBe(b.pos.length);
      expect(b.glow.length).toBe(b.pos.length);
      expect(b.nor.every(Number.isFinite)).toBe(true);
    }
  });

  it("is the same on every client", () => {
    expect(buildLandmarks("arcadia")!.pos).toEqual(buildLandmarks("arcadia")!.pos);
  });

  it("spreads directions evenly: no two closer than a third of the mean spacing", () => {
    const dirs = spreadDirs(13, 0x51a7);
    let min = Infinity;
    for (let i = 0; i < dirs.length; i++) {
      expect(Math.hypot(...dirs[i]!)).toBeCloseTo(1, 6);
      for (let j = 0; j < i; j++) min = Math.min(min, Math.acos(Math.min(1, dirs[i]![0] * dirs[j]![0] + dirs[i]![1] * dirs[j]![1] + dirs[i]![2] * dirs[j]![2])));
    }
    expect(min).toBeGreaterThan(Math.sqrt((4 * Math.PI) / 13) / 3);
  });
});

describe("landmark lifetime (planet graphics review, finding 4)", () => {
  it("leaving a body frees its geometry and, with no landmarks left, the material; the next arrival builds new ones", () => {
    const first = new Landmarks("arcadia", 500);
    const mesh = first.mesh!;
    const geo = mesh.geometry;
    const mat = mesh.material as THREE.Material;
    const w = watchDisposals(first.group);
    expect(w.all.has(geo) && w.all.has(mat)).toBe(true);
    first.dispose();
    expect(w.disposed.has(geo), "the departing body's geometry").toBe(true);
    expect(w.disposed.has(mat), "the material, with its last owner").toBe(true);
    expect(w.disposed.has(mesh), "the mesh's own render state").toBe(true);
    expect(first.mesh).toBeNull();
    expect(first.group.children.length).toBe(0);
    first.dispose(); // twice is safe (a failed arrival disposes what it built)

    const again = new Landmarks("arcadia", 500);
    const w2 = watchDisposals(again.group);
    expect(again.mesh!.geometry).not.toBe(geo);
    expect(again.mesh!.material).not.toBe(mat);
    expect(again.mesh!.geometry.getAttribute("position").count).toBe(geo.getAttribute("position").count);
    expect(w2.disposed.size).toBe(0);
    again.dispose();
    expect(w2.disposed.size).toBe(3); // its mesh's render state, its geometry and the material
  });

  it("the material outlives a body while another body's landmarks draw with it (a travel builds the next planet before the last one goes, or after)", () => {
    const arcadia = new Landmarks("arcadia", 500);
    const hollowmere = new Landmarks("hollowmere", 750);
    const mat = arcadia.mesh!.material;
    expect(hollowmere.mesh!.material).toBe(mat);
    expect(hollowmere.mesh!.geometry).not.toBe(arcadia.mesh!.geometry);
    const w = watchDisposals(arcadia.group);
    watchDisposals(hollowmere.group, w);
    const arcadiaGeo = arcadia.mesh!.geometry, hollowGeo = hollowmere.mesh!.geometry;
    arcadia.dispose();
    expect(w.disposed.has(arcadiaGeo)).toBe(true);
    expect(w.disposed.has(hollowGeo)).toBe(false);
    expect(w.disposed.has(mat as never)).toBe(false);
    hollowmere.dispose();
    expect(w.disposed.has(hollowGeo)).toBe(true);
    expect(w.disposed.has(mat as never)).toBe(true);
  });

  it("two planets of one body share its geometry until the last of them goes", () => {
    const a = new Landmarks("meridian", 1000);
    const b = new Landmarks("meridian", 1000);
    const geo = a.mesh!.geometry;
    expect(b.mesh!.geometry).toBe(geo);
    const w = watchDisposals(a.group);
    const mesh = a.mesh!;
    a.dispose();
    expect([...w.disposed]).toEqual([mesh]); // its own render state only: the other planet still draws the rest
    expect(b.mesh!.geometry).toBe(geo);
    b.dispose();
    expect(w.disposed.has(geo)).toBe(true);
  });

  it("the hub has nothing to free", () => {
    const hub = new Landmarks("portus", 150);
    expect(hub.mesh).toBeNull();
    const w = watchDisposals(hub.group);
    hub.dispose();
    expect(w.all.size).toBe(0);
    // And it holds no share of the material: a planet's landmarks after the hub still free it.
    const planet = new Landmarks("arcadia", 500);
    const mat = planet.mesh!.material;
    watchDisposals(planet.group, w);
    planet.dispose();
    expect(w.disposed.has(mat as never)).toBe(true);
  });
});
