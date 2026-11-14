// First / third person (D-view-fp-1): the view rules, the eye's easing, the wheel, and the controller's
// camera in first person (eye height, no roll, aim along the crosshair, a wall in front).
import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import type { Terrain } from "@firstlight/shared";
import type { Input } from "./input.ts";
import { PlayerController, type MoveColliders } from "./PlayerController.ts";
import { EyeFollow, otherView, smoothBlend, stepBlend, VIEW, viewFor, wheelView } from "./view.ts";

const R = 500;
const terrain = { body: { radius: R }, groundHeight: () => 0 } as unknown as Terrain;

function input(over: Partial<Input> = {}): Input {
  return { locked: true, captured: true, mouseDX: 0, mouseDY: 0, wheel: 0, sensitivity: 0.002, invertY: false, pressed: new Set<string>(), down: () => false, ...over } as unknown as Input;
}

function spawn(): PlayerController {
  const pc = new PlayerController(terrain, -100);
  pc.teleport(0, R, 0); // up +y, camera forward +z
  for (let i = 0; i < 12; i++) pc.update(1 / 60, input(), false);
  return pc;
}

function camera() {
  return new THREE.PerspectiveCamera(80, 16 / 9, 0.3, 6000);
}

/** Place the camera for `s` seconds at 60 fps. */
function settle(pc: PlayerController, cam: THREE.PerspectiveCamera, s = 0.5) {
  for (let t = 0; t < s; t += 1 / 60) pc.placeCamera(cam, 1 / 60);
  cam.updateMatrixWorld();
}

describe("view rules (game/view.ts)", () => {
  it("first person stays through everything but death, which pulls out to third", () => {
    expect(viewFor("first", { dead: false })).toBe("first");
    expect(viewFor("first", { dead: true })).toBe("third");
    expect(viewFor("third", { dead: false })).toBe("third");
    expect(viewFor("third", { dead: true })).toBe("third");
    expect(otherView("first")).toBe("third");
    expect(otherView("third")).toBe("first");
  });

  it("the wheel zooms third person; one more notch in at the closest is first person, a notch out comes back", () => {
    expect(wheelView("third", 4.6, -1)).toEqual({ view: "third", distance: 4.1 });
    expect(wheelView("third", 4.6, 1)).toEqual({ view: "third", distance: 5.1 });
    expect(wheelView("third", 8.8, 2)).toEqual({ view: "third", distance: VIEW.maxDistance });
    expect(wheelView("third", 2.8, -1)).toEqual({ view: "third", distance: VIEW.minDistance });
    expect(wheelView("third", VIEW.minDistance, -1)).toEqual({ view: "first", distance: VIEW.minDistance });
    expect(wheelView("first", VIEW.minDistance, -1)).toEqual({ view: "first", distance: VIEW.minDistance });
    expect(wheelView("first", VIEW.minDistance, 1)).toEqual({ view: "third", distance: VIEW.minDistance });
    expect(wheelView("third", 4.6, 0)).toEqual({ view: "third", distance: 4.6 });
  });

  it("the blend between the views takes VIEW.blendTime at any frame rate and eases at both ends", () => {
    for (const fps of [30, 60, 144]) {
      let b = 0;
      let t = 0;
      while (b < 1) {
        b = stepBlend(b, 1, 1 / fps);
        t += 1 / fps;
      }
      expect(t).toBeGreaterThanOrEqual(VIEW.blendTime - 1e-9);
      expect(t).toBeLessThan(VIEW.blendTime + 1 / fps + 1e-9);
    }
    expect(stepBlend(1, 0, 10)).toBe(0);
    expect(smoothBlend(0)).toBe(0);
    expect(smoothBlend(1)).toBe(1);
    expect(smoothBlend(0.5)).toBeCloseTo(0.5, 9);
    expect(smoothBlend(0.05)).toBeLessThan(0.05);
  });

  it("the eye follows the head's height quickly, lets its sway through only a little, and never sits on the ground", () => {
    const e = new EyeFollow();
    e.follow(1.7, 0.1, 0, 1 / 60); // fresh: on the target at once
    expect(e.up).toBeCloseTo(1.7, 9);
    // A roll drops the head to 0.4 m: the eye dips but stops at minEyeHeight.
    for (let i = 0; i < 60; i++) e.follow(0.4, 0.1, 0, 1 / 60);
    expect(e.up).toBeCloseTo(VIEW.minEyeHeight, 3);
    // Up again within a fifth of a second (most of the way).
    for (let i = 0; i < 12; i++) e.follow(1.7, 0.1, 0, 1 / 60);
    expect(e.up).toBeGreaterThan(1.6);
    // A walk's sway of ±0.12 m at 2 Hz: the eye moves sideways under 2 cm.
    let maxSide = 0;
    for (let i = 0; i < 240; i++) {
      e.follow(1.7, 0.1, 0.12 * Math.sin((i / 60) * 2 * Math.PI * 2), 1 / 60);
      maxSide = Math.max(maxSide, Math.abs(e.side));
    }
    expect(maxSide).toBeLessThan(0.02);
    // The same at 30 fps and 144 fps (it eases by time, not by frames).
    for (const fps of [30, 144]) {
      const f = new EyeFollow();
      f.follow(1.7, 0, 0, 1 / fps);
      for (let i = 0; i < fps / 5; i++) f.follow(1.0, 0, 0, 1 / fps);
      expect(f.up).toBeGreaterThan(1.0);
      expect(f.up).toBeLessThan(1.1);
    }
  });
});

describe("the controller's first-person camera", () => {
  it("sits at the eye, a little in front of the face, looking where the crosshair is; never rolled", () => {
    const pc = spawn();
    const cam = camera();
    pc.view = "first";
    pc.setHead(new THREE.Vector3(0, R + 1.72, 0.14)); // the face socket, 1.72 m up and 0.14 m forward
    settle(pc, cam);
    expect(pc.viewBlend).toBe(1);
    expect(cam.position.y - R).toBeCloseTo(1.72, 2);
    expect(cam.position.z).toBeCloseTo(0.14 + VIEW.eyeForward, 2);
    expect(Math.abs(cam.position.x)).toBeLessThan(1e-6);
    // Looking along the camera's heading and pitch.
    const dir = cam.getWorldDirection(new THREE.Vector3());
    expect(dir.z).toBeGreaterThan(0.9);
    expect(dir.y).toBeCloseTo(Math.sin(pc.camPitch), 2);
    // No roll: the camera's right vector stays level (no component along up).
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    expect(Math.abs(right.y)).toBeLessThan(1e-6);
  });

  it("the head swaying sideways and dipping in a roll moves the eye smoothly, without roll", () => {
    const pc = spawn();
    const cam = camera();
    pc.view = "first";
    pc.setHead(new THREE.Vector3(0, R + 1.72, 0.14));
    settle(pc, cam);
    let lowest = Infinity;
    for (let i = 0; i < 30; i++) {
      // A roll: the head goes down to 0.5 m and 0.2 m to the side over half a second.
      const k = Math.sin((i / 30) * Math.PI);
      pc.setHead(new THREE.Vector3(0.2 * k, R + 1.72 - 1.22 * k, 0.14));
      pc.placeCamera(cam, 1 / 60);
      cam.updateMatrixWorld();
      lowest = Math.min(lowest, cam.position.y - R);
      expect(Math.abs(cam.position.x)).toBeLessThanOrEqual(VIEW.maxSide + 1e-9);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
      expect(Math.abs(right.y)).toBeLessThan(1e-6);
    }
    expect(lowest).toBeGreaterThanOrEqual(VIEW.minEyeHeight - 1e-6);
    expect(lowest).toBeLessThan(1.4);
  });

  it("without a model to follow, the eye stands at VIEW.eyeHeight (higher in the saddle)", () => {
    const pc = spawn();
    const cam = camera();
    pc.view = "first";
    pc.setHead(null);
    settle(pc, cam);
    expect(cam.position.y - R).toBeCloseTo(VIEW.eyeHeight, 2);
    pc.rideBlend = 1;
    settle(pc, cam, 1);
    expect(cam.position.y - R).toBeCloseTo(VIEW.eyeHeight + 1, 2);
  });

  it("goes between the views over VIEW.blendTime; death pulls out to third and respawn comes back in", () => {
    const pc = spawn();
    const cam = camera();
    pc.setHead(new THREE.Vector3(0, R + 1.72, 0.14));
    settle(pc, cam);
    const third = cam.position.clone();
    expect(third.z).toBeLessThan(-2); // behind the player
    pc.view = "first";
    pc.placeCamera(cam, VIEW.blendTime / 2);
    expect(pc.viewBlend).toBeCloseTo(0.5, 6);
    expect(cam.position.z).toBeGreaterThan(third.z); // on the way in
    expect(cam.position.z).toBeLessThan(0);
    settle(pc, cam);
    expect(pc.viewBlend).toBe(1);
    pc.dead = true;
    expect(pc.viewNow).toBe("third");
    settle(pc, cam, 1);
    expect(pc.viewBlend).toBe(0);
    expect(cam.position.z).toBeLessThan(-2);
    pc.dead = false;
    settle(pc, cam);
    expect(pc.viewBlend).toBe(1);
  });

  it("in first person the gameplay facing is the camera heading on the very next frame; only the drawn body eases", () => {
    const pc = spawn();
    const cam = camera();
    pc.view = "first";
    settle(pc, cam);
    // Look 90° to the right (mouse), standing still, and swing on this frame (review finding 1: the
    // facing the server's melee arc uses was eased, 66.8° off the crosshair right after the turn).
    pc.update(1 / 60, input({ mouseDX: -(Math.PI / 2) / 0.002 }), false);
    expect(pc.facing.dot(pc.camForward)).toBeGreaterThan(0.9999);
    // The drawn body turns after it, smoothly, and catches up.
    expect(pc.bodyFacing.dot(pc.camForward)).toBeLessThan(0.9);
    for (let i = 0; i < 30; i++) {
      pc.update(1 / 60, input(), false);
      pc.placeCamera(cam, 1 / 60);
    }
    expect(pc.bodyFacing.dot(pc.camForward)).toBeGreaterThan(0.999);
    // Third person: facing stays where it was when not moving or aiming, and the body is drawn there.
    const tp = spawn();
    tp.update(1 / 60, input({ mouseDX: -(Math.PI / 2) / 0.002 }), false);
    for (let i = 0; i < 30; i++) tp.update(1 / 60, input(), false);
    expect(tp.facing.dot(tp.camForward)).toBeLessThan(0.1);
    expect(tp.bodyFacing.dot(tp.facing)).toBeGreaterThan(0.9999);
  });

  it("scrolling all the way in enters first person and tells the game; scrolling out leaves it", () => {
    const pc = spawn();
    const seen: string[] = [];
    pc.onViewChange = (v) => seen.push(v);
    for (let i = 0; i < 6; i++) pc.update(1 / 60, input({ wheel: -1 }), false);
    expect(pc.camDistance).toBe(VIEW.minDistance);
    expect(pc.view).toBe("first");
    pc.update(1 / 60, input({ wheel: 1 }), false);
    expect(pc.view).toBe("third");
    expect(seen).toEqual(["first", "third"]);
  });

  it("pressed face-first against a wall, the eye backs off so the near plane never reaches into it", () => {
    const pc = spawn();
    const cam = camera();
    // A wall across the way 0.45 m ahead of the feet (the body's 0.38 m radius plus a hair).
    const wallZ = 0.45;
    const wall: MoveColliders = {
      resolve: () => false,
      raycast: (o, d, maxT) => {
        if (Math.abs(d.z) < 1e-9) return Infinity;
        const t = (wallZ - o.z) / d.z;
        return t >= 0 && t <= maxT ? t : Infinity;
      },
    };
    pc.setStructures(wall);
    pc.view = "first";
    pc.camPitch = 0;
    pc.setHead(new THREE.Vector3(0, R + 1.72, 0.14));
    settle(pc, cam);
    // The near plane (looking straight at the wall) stays on this side of it.
    expect(cam.position.z + cam.near).toBeLessThan(wallZ);
    // ...and with the wall gone the eye goes back in front of the face.
    pc.setStructures(null);
    settle(pc, cam);
    expect(cam.position.z).toBeCloseTo(0.14 + VIEW.eyeForward, 2);
  });
});
