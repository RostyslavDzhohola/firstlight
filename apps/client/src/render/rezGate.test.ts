// The rez effect's gates (review A1): a few slots, the nearest arrivals first, nothing beyond sight.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { ANIM, PF } from "@firstlight/shared/net/schema";
import { REZ_MAX_ACTIVE, REZ_RANGE_M, REZ_SECONDS, rezActive, rezAdmits, rezSwitch } from "./rez.ts";

// config.ts reads the URL at import time; ?nochars keeps AvatarView on capsules (no asset fetches).
vi.stubGlobal("location", { search: "?nochars", hostname: "localhost" });

let mod: typeof import("./Avatars.ts");
beforeAll(async () => {
  mod = await import("./Avatars.ts");
});

const R = 1000;
/** A point on a planet of radius R, `east` metres along the tangent from the north pole. */
const at = (east: number) => new THREE.Vector3(east, R, 0).normalize().multiplyScalar(R);
const camera = new THREE.PerspectiveCamera();
camera.position.copy(at(0));

const made: InstanceType<typeof mod.AvatarView>[] = [];
function avatar(east: number) {
  const a = new mod.AvatarView(made.length % 6, 0);
  const p = at(east);
  a.set(p.x, p.y, p.z, 1, 0, 0, ANIM.IDLE, 0);
  made.push(a);
  return a;
}
const lights = () => made.filter((a) => a.root.children.some((c) => c.name === "rez_fx" && c.visible)).length;

afterEach(() => {
  for (const a of made.splice(0)) a.dispose();
  rezSwitch.on = true;
  expect(rezActive.count).toBe(0); // every slot comes back
});

describe("rezAdmits", () => {
  it("lets the player's own effect through whatever is running", () => {
    expect(rezAdmits(REZ_MAX_ACTIVE + 20, 500, true)).toBe(true);
  });
  it("gives anyone else a slot only while one is free and they are within range", () => {
    expect(rezAdmits(0, 10)).toBe(true);
    expect(rezAdmits(REZ_MAX_ACTIVE - 1, REZ_RANGE_M)).toBe(true);
    expect(rezAdmits(REZ_MAX_ACTIVE, 10)).toBe(false);
    expect(rezAdmits(0, REZ_RANGE_M + 1)).toBe(false);
  });
});

describe("arrivals (AvatarView.rezArrivals)", () => {
  it("forty at once: only the nearest few materialise, the rest are simply there", () => {
    // Far ones first in the list, as a snapshot might order them.
    const crowd = Array.from({ length: 40 }, (_, i) => avatar(80 - i * 2));
    mod.AvatarView.rezArrivals([...crowd], camera);
    const running = crowd.filter((a) => a.rezzing);
    expect(running).toHaveLength(REZ_MAX_ACTIVE);
    expect(rezActive.count).toBe(REZ_MAX_ACTIVE);
    expect(lights()).toBe(REZ_MAX_ACTIVE);
    const nearest = [...crowd].sort((p, q) => p.root.position.distanceTo(camera.position) - q.root.position.distanceTo(camera.position)).slice(0, REZ_MAX_ACTIVE);
    expect(new Set(running)).toEqual(new Set(nearest));
  });

  it("an arrival out of sight takes no slot", () => {
    const far = avatar(REZ_RANGE_M + 40);
    const near = avatar(12);
    mod.AvatarView.rezArrivals([far, near], camera);
    expect(far.rezzing).toBe(false);
    expect(near.rezzing).toBe(true);
    expect(rezActive.count).toBe(1);
  });

  it("a finished effect frees its slot for the next arrival", () => {
    const first = Array.from({ length: REZ_MAX_ACTIVE }, (_, i) => avatar(5 + i));
    mod.AvatarView.rezArrivals([...first], camera);
    const late = avatar(3);
    mod.AvatarView.rezArrivals([late], camera);
    expect(late.rezzing).toBe(false);
    for (const a of first) a.stepRez(REZ_SECONDS.in + 0.1);
    expect(rezActive.count).toBe(0);
    expect(lights()).toBe(0);
    const next = avatar(4);
    mod.AvatarView.rezArrivals([next], camera);
    expect(next.rezzing).toBe(true);
  });

  it("the player's own avatar always gets its effect", () => {
    const first = Array.from({ length: REZ_MAX_ACTIVE }, (_, i) => avatar(5 + i));
    mod.AvatarView.rezArrivals([...first], camera);
    const self = avatar(0);
    self.root.userData.ownAvatar = true;
    expect(self.rez("in")).toBe(true);
    expect(self.rezzing).toBe(true);
  });

  it("with no slot a departure is refused (the caller frees it) and a death still dissolves the body, without a light", () => {
    const first = Array.from({ length: REZ_MAX_ACTIVE }, (_, i) => avatar(5 + i));
    mod.AvatarView.rezArrivals([...first], camera);
    const leaver = avatar(2);
    expect(leaver.rez("out")).toBe(false);
    expect(leaver.rezzing).toBe(false);
    const victim = avatar(3);
    for (let i = 0; i < 40; i++) victim.set(victim.root.position.x, victim.root.position.y, victim.root.position.z, 1, 0, 0, ANIM.IDLE, 1 / 30);
    victim.setFlags(PF.DEAD);
    expect(victim.rezzing).toBe(true);
    expect(rezActive.count).toBe(REZ_MAX_ACTIVE);
    expect(lights()).toBe(REZ_MAX_ACTIVE);
  });
});
