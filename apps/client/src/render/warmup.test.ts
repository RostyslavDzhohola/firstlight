import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { forceProperty } from "./warmup.ts";

describe("warm-up forced properties", () => {
  it("restores the original value when nothing wrote during warm-up", () => {
    const o = new THREE.Object3D();
    o.visible = false;
    const restore = forceProperty(o, "visible", true);
    expect(o.visible).toBe(true);
    restore();
    expect(o.visible).toBe(false);
  });

  it("keeps a value written by another system during warm-up", () => {
    const o = new THREE.Object3D();
    o.visible = false;
    const restore = forceProperty(o, "visible", true);
    o.visible = true; // e.g. a grass cell got filled
    o.visible = false;
    o.visible = true;
    expect(o.visible).toBe(true);
    restore();
    expect(o.visible).toBe(true);
    // Back to a plain data property.
    o.visible = false;
    expect(o.visible).toBe(false);
    expect(Object.getOwnPropertyDescriptor(o, "visible")?.get).toBeUndefined();
  });

  it("works for instance counts", () => {
    const g = new THREE.InstancedBufferGeometry();
    g.instanceCount = 0;
    const restore = forceProperty(g, "instanceCount", 1);
    expect(g.instanceCount).toBe(1);
    g.instanceCount = 3000;
    expect(g.instanceCount).toBe(1); // still forced while warming
    restore();
    expect(g.instanceCount).toBe(3000);
  });
});
