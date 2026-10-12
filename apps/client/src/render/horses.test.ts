import { beforeAll, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { HORSE, HORSE_COATS } from "@firstlight/shared/content/horse";
import { watchDisposals } from "./disposeWatch.testutil.ts";

// config.ts reads the URL at import time; ?nochars keeps views on the box horse (no asset fetches).
vi.stubGlobal("location", { search: "?nochars", hostname: "localhost" });

let horses: typeof import("./Horses.ts");
let ride: typeof import("./avatars/ride.ts");
beforeAll(async () => {
  horses = await import("./Horses.ts");
  ride = await import("./avatars/ride.ts");
});

describe("horse gait", () => {
  it("walks slowly, gallops fast, jumps when airborne, and caps the stride rate", () => {
    expect(horses.gaitFor(0, false).clip).toBe("idle");
    expect(horses.gaitFor(2, false).clip).toBe("walk");
    expect(horses.gaitFor(HORSE.speed, false).clip).toBe("run");
    expect(horses.gaitFor(HORSE.speed, true).clip).toBe("jump");
    const canter = horses.gaitFor(HORSE.speed, false).timeScale;
    const gallop = horses.gaitFor(HORSE.sprint, false).timeScale;
    expect(gallop).toBeGreaterThan(canter);
    expect(gallop).toBeLessThanOrEqual(2.1);
  });
});

describe("HorseView (box fallback)", () => {
  it("stands on local up and offers a seat at the saddle height; dispose leaves the registry", () => {
    const R = 1000;
    const h = new horses.HorseView(3);
    expect(horses.HorseView.all.has(h)).toBe(true);
    h.set(0, R, 0, 0, 0, 1, HORSE.speed, false, 1 / 60);
    const seat = h.seat(new THREE.Vector3());
    expect(seat.y - R).toBeCloseTo(HORSE.seatHeight, 5);
    h.dispose();
    expect(horses.HorseView.all.has(h)).toBe(false);
  });
});

describe("ride pose", () => {
  /** pelvis → thigh → calf → foot on both sides, legs hanging straight down (like a standing idle). */
  function skeleton(): THREE.Object3D {
    const root = new THREE.Group();
    const bone = (name: string, x: number, y: number, z: number, parent: THREE.Object3D) => {
      const b = new THREE.Bone();
      b.name = name;
      b.position.set(x, y, z);
      parent.add(b);
      return b;
    };
    const pelvis = bone("pelvis", 0, 0.92, 0, root);
    for (const [s, side] of [["l", 1], ["r", -1]] as const) {
      const thigh = bone(`thigh_${s}`, 0.09 * side, 0, 0, pelvis);
      const calf = bone(`calf_${s}`, 0, -0.4, 0, thigh);
      bone(`foot_${s}`, 0, -0.43, 0, calf);
    }
    return root;
  }

  it("aims both thighs forward and out round the saddle, shins down, over idle's other tracks", () => {
    const idle = new THREE.AnimationClip("idle", 2, [new THREE.VectorKeyframeTrack("pelvis.position", [0, 2], [0, 0.92, 0, 0, 0.93, 0])]);
    const clip = ride.makeRideClip(idle, skeleton());
    expect(clip.name).toBe("ride");
    expect(clip.duration).toBe(2);
    expect(clip.tracks.map((t) => t.name).sort()).toEqual(["calf_l.quaternion", "calf_r.quaternion", "pelvis.position", "thigh_l.quaternion", "thigh_r.quaternion"]);

    const model = skeleton();
    const mixer = new THREE.AnimationMixer(model);
    mixer.clipAction(clip).play();
    mixer.update(0);
    model.updateMatrixWorld(true);
    const at = (n: string) => new THREE.Vector3().setFromMatrixPosition(model.getObjectByName(n)!.matrixWorld);
    for (const [s, side] of [["l", 1], ["r", -1]] as const) {
      const thigh = at(`calf_${s}`).sub(at(`thigh_${s}`)).normalize();
      const want = new THREE.Vector3(...ride.RIDE_AIMS.find((a) => a.bone === `thigh_${s}`)!.dir(side)).normalize();
      expect(thigh.angleTo(want)).toBeLessThan(1e-3);
      const shin = at(`foot_${s}`).sub(at(`calf_${s}`)).normalize();
      expect(shin.y).toBeLessThan(-0.9); // down into the stirrup
      expect(Math.sign(at(`calf_${s}`).x)).toBe(side); // knees on their own side of the horse
    }
  });
});

describe("horse warm-up hook (T9)", () => {
  it("keeps one horse per coat for the session, out of the LOD and blob passes, never disposed", () => {
    const R = 1000;
    const scene = new THREE.Scene();
    const before = horses.HorseView.all.size;
    const hook = horses.horseWarmupHook(scene, () => new THREE.Vector3(0, R, 0));
    hook.forceAll(true);
    const kept = scene.getObjectByName("horseWarmup")!;
    expect(kept).toBeTruthy();
    expect(kept.visible).toBe(false);
    expect(kept.children).toHaveLength(HORSE_COATS.length);
    expect(horses.HorseView.all.size).toBe(before);
    const w = watchDisposals(kept);
    hook.forceAll(false);
    expect(kept.parent).toBeNull();
    expect(w.disposed.size).toBe(0);
    horses.horseWarmupHook(scene, () => new THREE.Vector3(0, R, 0)).forceAll(true);
    expect(scene.getObjectByName("horseWarmup")).toBe(kept);
    expect(kept.children).toHaveLength(HORSE_COATS.length);
    expect(w.disposed.size).toBe(0);
  });
});
