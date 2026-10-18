// The grass streaming's backlog (D-load-6): the arrival waits for the cells round the camera to fill
// before the loader goes, so the grass has to say what is still to build and notice new chunks.
import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { buildChunk, CHUNK_QUADS, createTerrain } from "@firstlight/shared";
import { emptyStored, resolveSettings } from "./quality.ts";
import { GrassSystem, type GrassChunk } from "./grass.ts";

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
    grass.update(cam, [ch], 1001, 1000); // all the time it needs
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
    grass.update(cam, [a], 1000, 1000);
    expect(grass.backlog()).toBe(0);
    grass.chunksChanged();
    expect(grass.backlog(), "an unscanned change is work still to do").toBeGreaterThan(0);
    grass.update(cam, [a, b], 1010, 0); // 10 ms later, the camera still: scanned all the same
    expect(grass.backlog()).toBeGreaterThan(1);
    grass.update(cam, [a, b], 1020, 1000);
    expect(grass.backlog()).toBe(0);
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
