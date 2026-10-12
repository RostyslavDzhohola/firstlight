import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { BODIES, createTerrain, padDirs } from "@firstlight/shared";
import { clampPhotoCamera, PHOTO_MAX_DISTANCE, PHOTO_MIN_CLEARANCE } from "./PhotoMode.ts";

const terrain = createTerrain("arcadia");
const R = BODIES.arcadia.radius;
const d = padDirs(BODIES.arcadia)[0]!;
const dir = new THREE.Vector3(d[0], d[1], d[2]);
const ground = R + terrain.groundHeight(d[0], d[1], d[2]);
const anchor = dir.clone().multiplyScalar(ground);

describe("photo camera clamp", () => {
  it("lifts a camera that dips under the ground", () => {
    const p = clampPhotoCamera(dir.clone().multiplyScalar(ground - 5), anchor, terrain);
    expect(p.length()).toBeCloseTo(ground + PHOTO_MIN_CLEARANCE, 3);
  });

  it("keeps the camera within reach of the body", () => {
    const far = anchor.clone().addScaledVector(dir, 1000);
    const p = clampPhotoCamera(far, anchor, terrain);
    expect(p.distanceTo(anchor)).toBeLessThanOrEqual(PHOTO_MAX_DISTANCE + 1e-6);
  });

  it("leaves a legal position alone", () => {
    const ok = anchor.clone().addScaledVector(dir, 20);
    const p = clampPhotoCamera(ok.clone(), anchor, terrain);
    expect(p.distanceTo(ok)).toBeLessThan(1e-9);
  });
});
