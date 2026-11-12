// The grass streaming's backlog (D-load-6): the arrival waits for the cells round the camera to fill
// before the loader goes, so the grass has to say what is still to build and notice new chunks.
import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { buildChunk, CHUNK_QUADS, createTerrain } from "@firstlight/shared";
import { emptyStored, resolveSettings } from "./quality.ts";
import { GrassSystem, type GrassChunk } from "./grass.ts";
import { watchDisposals } from "./disposeWatch.testutil.ts";

const terrain = createTerrain("arcadia");
const body = terrain.body;

/** A streamed chunk as Planet hands it to the grass: real positions, full grass weight. */
function chunk(face: 0 | 1 | 2 | 3 | 4 | 5, cx: number, cy: number): GrassChunk {
  const g = buildChunk(terrain, face, cx, cy);
  const side = CHUNK_QUADS + 1;
  const c = g.center;
  const mid = body.radius + (g.minHeight + g.maxHeight) / 2;
  return {
    key: `${face}:${cx}:${cy}`, face, cx, cy, positions: g.positions, grass: new Float32Array(side * side).fill(1),
    center: new THREE.Vector3(c[0] * mid, c[1] * mid, c[2] * mid), radius: g.boundRadius,
  };
}

describe("grass backlog", () => {
  it("counts the cells round the camera still to fill, down to 0 when every one is built", () => {
    const grass = new GrassSystem(body.radius, body.chunksPerFace * CHUNK_QUADS);
    grass.applySettings(resolveSettings("medium", false, true, emptyStored(), new Set()));
    const ch = chunk(0, 3, 3);
    const cam = ch.center.clone().setLength(ch.center.length() + 2);
    expect(grass.backlog()).toBe(0); // nothing streamed yet
    grass.update(cam, [ch], 1000, 0); // a scan, no time to build
    const wanted = grass.backlog();
    expect(wanted).toBeGreaterThan(0);
    grass.update(cam, [ch], 1001, Infinity); // all the time it needs (no budget: a loaded machine takes over a second)
    expect(grass.backlog()).toBe(0);
    expect(grass.blades).toBeGreaterThan(0);
    grass.dispose();
  });

  it("a chunk that arrives or leaves is scanned at the next update, not up to 250 ms later", () => {
    const grass = new GrassSystem(body.radius, body.chunksPerFace * CHUNK_QUADS);
    grass.applySettings(resolveSettings("medium", false, true, emptyStored(), new Set()));
    const a = chunk(0, 3, 3);
    const b = chunk(0, 4, 3);
    const cam = a.center.clone().lerp(b.center, 0.5);
    cam.setLength(cam.length() + 2);
    grass.update(cam, [a], 1000, Infinity);
    expect(grass.backlog()).toBe(0);
    grass.chunksChanged();
    expect(grass.backlog(), "an unscanned change is work still to do").toBeGreaterThan(0);
    grass.update(cam, [a, b], 1010, 0); // 10 ms later, the camera still: scanned all the same
    expect(grass.backlog()).toBeGreaterThan(1);
    grass.update(cam, [a, b], 1020, Infinity);
    expect(grass.backlog()).toBe(0);
    grass.dispose();
  });

  it("draws every clump of a near cell and only the head of a far cell's list (meadow thinning)", () => {
    const grass = new GrassSystem(body.radius, body.chunksPerFace * CHUNK_QUADS);
    grass.applySettings(resolveSettings("medium", false, true, emptyStored(), new Set()));
    const ch = chunk(0, 3, 3);
    const cam = ch.center.clone().setLength(ch.center.length() + 2);
    grass.update(cam, [ch], 1000, Infinity);
    type C = { count: number; geo: THREE.InstancedBufferGeometry; center: THREE.Vector3; meta: THREE.InstancedBufferAttribute };
    const all = () => [...(grass as any).cells.values()] as C[];
    // Stand in the middle of a cell that grew grass and look again.
    const home = all().find((c) => c.count > 50)!;
    cam.copy(home.center).setLength(home.center.length() + 1.5);
    grass.update(cam, [ch], 2000, Infinity);
    const cells = all();
    const near = cells.filter((c) => c.center.distanceTo(cam) < 6 && c.count > 0);
    const far = cells.filter((c) => c.center.distanceTo(cam) > 36 && c.count > 50);
    expect(near.length).toBeGreaterThan(0);
    expect(far.length).toBeGreaterThan(0);
    for (const c of near) expect(c.geo.instanceCount).toBe(c.count);
    for (const c of far) expect(c.geo.instanceCount).toBeLessThan(c.count * 0.8);
    // Ranks run 0..1 in draw order, so the tail a far cell stops drawing is the part the shader has shrunk away.
    const m = near[0]!.meta.array as Float32Array;
    for (let i = 1; i < near[0]!.count; i++) expect(m[i * 4 + 3]!).toBeGreaterThan(m[(i - 1) * 4 + 3]!);
    expect(m[(near[0]!.count - 1) * 4 + 3]!).toBeLessThanOrEqual(1);
    grass.dispose();
  });

  it("has no backlog with the grass off", () => {
    const grass = new GrassSystem(body.radius, body.chunksPerFace * CHUNK_QUADS);
    grass.applySettings(resolveSettings("medium", false, true, emptyStored(), new Set(["grass"])));
    const ch = chunk(0, 3, 3);
    grass.chunksChanged();
    grass.update(ch.center.clone().setLength(ch.center.length() + 2), [ch], 1000, 0);
    expect(grass.backlog()).toBe(0);
    grass.dispose();
  });
});

describe("grass warm-up sample (review finding 1)", () => {
  const settings = (t: "low" | "medium" | "high", shadows = true) =>
    resolveSettings(t, false, true, emptyStored(), new Set(shadows ? [] : (["shadows"] as const)));
  const layout = (g: THREE.BufferGeometry) => Object.keys(g.attributes).sort().map((n) => `${n}:${g.attributes[n]!.itemSize}`).join(",") + (g.index ? ",index" : "");

  it("is a hidden, empty cell of the tier's grass: the cells' material, attribute layout and shadow flag", () => {
    const grass = new GrassSystem(body.radius, body.chunksPerFace * CHUNK_QUADS);
    expect(grass.warmupSample).toBeNull();
    const ch = chunk(0, 3, 3);
    const cam = ch.center.clone().setLength(ch.center.length() + 2);
    for (const t of ["low", "medium", "high"] as const) {
      grass.applySettings(settings(t));
      const sample = grass.warmupSample!;
      expect(sample.parent, t).toBe(grass.group);
      expect(sample.visible).toBe(false); // warmup() shows it; play never draws it
      expect((sample.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(0);
      expect((sample.material as THREE.Material).name).toBe(t === "low" ? "grass" : "grass-meadow");
      grass.update(cam, [ch], 1000, Infinity);
      const cells = grass.group.children.filter((c) => c !== sample) as THREE.Mesh[];
      expect(cells.length).toBeGreaterThan(0);
      // Near (full clump) and far (lite clump) cells alike: one layout, so one sample stands for both.
      const layouts = new Set(cells.map((c) => layout(c.geometry)));
      for (const c of (grass as unknown as { cells: Map<string, { geo: THREE.BufferGeometry; geoLite: THREE.BufferGeometry | null }> }).cells.values()) {
        layouts.add(layout(c.geo));
        if (c.geoLite) layouts.add(layout(c.geoLite));
      }
      expect([...layouts], t).toEqual([layout(sample.geometry)]);
      for (const c of cells) {
        expect(c.material).toBe(sample.material);
        expect(c.receiveShadow).toBe(sample.receiveShadow);
      }
      expect(grass.blades, "the sample is not grass").toBe(cells.reduce((n, c) => n + (c.geometry as THREE.InstancedBufferGeometry).instanceCount, 0));
    }
    // The shadow flag is part of three's build key: the sample follows the cells'.
    grass.applySettings(settings("high", false));
    expect(grass.warmupSample!.receiveShadow).toBe(false);
    grass.applySettings(settings("high"));
    expect(grass.warmupSample!.receiveShadow).toBe(true);
    grass.dispose();
  });

  it("is replaced with the tier's grass and freed with the system", () => {
    const grass = new GrassSystem(body.radius, body.chunksPerFace * CHUNK_QUADS);
    grass.applySettings(settings("low"));
    const low = grass.warmupSample!;
    const w = watchDisposals(grass.group);
    grass.applySettings(settings("medium"));
    const medium = grass.warmupSample!;
    expect(medium).not.toBe(low);
    expect(low.parent).toBeNull();
    expect(w.disposed.has(low.geometry)).toBe(true);
    watchDisposals(grass.group, w);
    grass.dispose();
    expect(w.disposed.has(medium.geometry)).toBe(true);
    expect(grass.warmupSample).toBeNull();
    // The materials are shared by every body's grass for the session: never disposed here.
    expect(w.disposed.has(low.material as THREE.Material)).toBe(false);
    expect(w.disposed.has(medium.material as THREE.Material)).toBe(false);
  });
});
