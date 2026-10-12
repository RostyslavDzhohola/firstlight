import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { BlobShadows } from "./blobShadows.ts";
import type { ResolvedSettings } from "./quality.ts";

const settings = (mode: "blob" | "map", on = true) => ({ on: { shadows: on, chars: true }, shadows: { mode } }) as unknown as ResolvedSettings;

describe("BlobShadows", () => {
  it("writes blobs straight into the instance buffer, one frame at a time", () => {
    const blobs = new BlobShadows(new THREE.Scene());
    blobs.applySettings(settings("blob"));
    const geo = blobs.mesh.geometry as THREE.InstancedBufferGeometry;
    const attr = geo.getAttribute("iBlob") as THREE.InstancedBufferAttribute;
    blobs.begin();
    blobs.add(1, 2, 3, 0.5);
    blobs.add(4, 5, 6, 0.25);
    blobs.end();
    expect(geo.instanceCount).toBe(2);
    expect(Array.from((attr.array as Float32Array).subarray(0, 8))).toEqual([1, 2, 3, 0.5, 4, 5, 6, 0.25]);
    const v = attr.version;
    blobs.begin();
    blobs.add(7, 8, 9, 1);
    blobs.end();
    expect(geo.instanceCount).toBe(1);
    expect(attr.version).toBeGreaterThan(v);
  });

  it("caps at its capacity and ignores blobs while shadow maps are on", () => {
    const blobs = new BlobShadows(new THREE.Scene());
    blobs.applySettings(settings("blob"));
    const geo = blobs.mesh.geometry as THREE.InstancedBufferGeometry;
    blobs.begin();
    for (let i = 0; i < 500; i++) blobs.add(i, 0, 0, 1);
    blobs.end();
    expect(geo.instanceCount).toBe(128);
    blobs.applySettings(settings("map"));
    blobs.begin();
    blobs.add(1, 1, 1, 1);
    blobs.end();
    expect(blobs.mesh.visible).toBe(false);
    expect(geo.instanceCount).toBe(128); // untouched while hidden
  });

  it("keeps the array form for callers that have a list", () => {
    const blobs = new BlobShadows(new THREE.Scene());
    blobs.applySettings(settings("blob"));
    blobs.update([{ x: 1, y: 1, z: 1, r: 1 }]);
    expect((blobs.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(1);
  });
});
