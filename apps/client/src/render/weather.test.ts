import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { WeatherFx } from "./weather.ts";

describe("weather box", () => {
  it("a new drop budget frees the old buffers instead of leaking them", () => {
    const fx = new WeatherFx(new THREE.Scene());
    fx.setCapacity(4000);
    const first = fx.drops.geometry;
    let disposed = 0;
    first.addEventListener("dispose", () => disposed++);
    fx.setCapacity(4000); // same budget: nothing rebuilt
    expect(fx.drops.geometry).toBe(first);
    expect(disposed).toBe(0);

    fx.setCapacity(1500);
    expect(disposed).toBe(1);
    expect(fx.drops.geometry).not.toBe(first);
    expect(fx.drops.geometry.getAttribute("seed").count).toBe(1500);

    // The new geometry draws: a full-intensity frame uses the whole budget.
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(0, 502, 0);
    fx.update(1 / 60, cam, 1, 0, 9, 0, 0, 0.5, 0.012, 0.3, new THREE.Color(1, 1, 1));
    expect((fx.drops.geometry as THREE.InstancedBufferGeometry).instanceCount).toBe(1500);
    expect(fx.drops.visible).toBe(true);
    fx.dispose();
  });
});
