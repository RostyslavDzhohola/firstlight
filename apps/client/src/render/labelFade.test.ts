import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { LABEL_FADE_FAR, LABEL_FADE_NEAR, labelFade, labelFadeFor } from "./labelFade.ts";

describe("label near-camera fade (#22)", () => {
  it("is gone within 1.5 m of the camera, whole beyond 2.5 m, and rises smoothly between", () => {
    expect(LABEL_FADE_NEAR).toBe(1.5);
    expect(LABEL_FADE_FAR).toBe(2.5);
    for (const d of [-1, 0, 0.3, 1, 1.5]) expect(labelFade(d), `${d} m`).toBe(0);
    for (const d of [2.5, 3, 6, 40]) expect(labelFade(d), `${d} m`).toBe(1);
    let last = 0;
    for (let i = 1; i < 20; i++) {
      const f = labelFade(1.5 + i * 0.05);
      expect(f).toBeGreaterThan(last);
      expect(f).toBeLessThan(1);
      last = f;
    }
  });

  it("counts a label's depth in front of the camera: off to one side at 1 m is as close as straight ahead", () => {
    const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.3, 6000);
    camera.position.set(10, 501.9, -3);
    camera.lookAt(10, 501.9, 10); // looking along +z
    camera.updateMatrixWorld();
    const label = new THREE.Sprite();
    const at = (x: number, y: number, z: number) => {
      label.position.set(x, y, z);
      label.updateMatrixWorld();
      return labelFadeFor(camera, label);
    };
    expect(at(10, 502.3, -1.8)).toBe(0); // 1.2 m ahead, a little up: the sign over a counter the camera brushes
    expect(at(13, 501.9, -2)).toBe(0); // 1 m ahead, 3 m to the side: still 4.2 m wide across the view
    expect(at(10, 501.9, -6)).toBe(0); // behind the camera
    expect(at(10, 503.4, 0)).toBe(1); // 3 m ahead
    expect(at(10, 501.9, -1)).toBeGreaterThan(0); // 2 m: on its way in
    expect(at(10, 501.9, -1)).toBeLessThan(1);
  });
});
