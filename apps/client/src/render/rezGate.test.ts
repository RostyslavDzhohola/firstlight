// The rez effect's gates (review A1): a few slots, the nearest arrivals first, nothing beyond sight.
// And the Rez switch (review A2): turning it off settles what is running at once.
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

describe("the Rez switch (AvatarView.settleRez)", () => {
  const live = (a: InstanceType<typeof mod.AvatarView>, frames = 40) => {
    const p = a.root.position;
    for (let i = 0; i < frames; i++) a.set(p.x, p.y, p.z, 1, 0, 0, ANIM.IDLE, 1 / 30);
  };
  /** The far-LOD capsule stands in for the body here (?nochars): hidden while the avatar is gone. */
  const bodyShown = (a: InstanceType<typeof mod.AvatarView>) => {
    let shown = false;
    a.root.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh && o.name !== "rez_fx") shown = true; });
    return shown;
  };

  it("off: arrivals are whole, the dying lie whole, lights are hidden, slots are free and departures are freed", () => {
    const arriving = avatar(4);
    mod.AvatarView.rezArrivals([arriving], camera);
    const dying = avatar(6);
    live(dying);
    dying.setFlags(PF.DEAD);
    dying.stepRez(REZ_SECONDS.death * 0.7);
    const gone = avatar(8);
    live(gone);
    gone.setFlags(PF.DEAD);
    gone.stepRez(REZ_SECONDS.death + 0.1);
    expect(bodyShown(gone)).toBe(false);
    const leaver = avatar(10);
    expect(leaver.rez("out")).toBe(true);
    const leaving = new Set([leaver]);
    expect(rezActive.count).toBe(3);
    expect(lights()).toBe(3);

    rezSwitch.on = false;
    mod.AvatarView.settleRez(false, leaving);

    expect(rezActive.count).toBe(0);
    expect(lights()).toBe(0);
    for (const a of [arriving, dying, gone]) {
      expect(a.rezzing).toBe(false);
      expect(bodyShown(a)).toBe(true);
    }
    expect(leaving.size).toBe(0);
    expect(mod.AvatarView.all.has(leaver)).toBe(false);
    expect(leaver.root.parent).toBeNull();
    // Nothing steps or draws afterwards.
    live(arriving, 3);
    expect(arriving.rezzing).toBe(false);
    expect(lights()).toBe(0);
  });

  it("off: later deaths, arrivals and departures start nothing", () => {
    rezSwitch.on = false;
    const a = avatar(5);
    live(a);
    a.setFlags(PF.DEAD);
    expect(a.rezzing).toBe(false);
    expect(bodyShown(a)).toBe(true);
    expect(a.rez("out")).toBe(false);
    // Someone met dead with Rez off lies there too.
    const met = avatar(7);
    met.setFlags(PF.DEAD);
    expect(bodyShown(met)).toBe(true);
    expect(lights()).toBe(0);
  });

  it("on again: the dead are gone until they rise, the living are untouched", () => {
    rezSwitch.on = false;
    const dead = avatar(5);
    live(dead);
    dead.setFlags(PF.DEAD);
    const alive = avatar(9);
    live(alive);
    rezSwitch.on = true;
    mod.AvatarView.settleRez(true);
    expect(bodyShown(dead)).toBe(false);
    expect(bodyShown(alive)).toBe(true);
    expect(lights()).toBe(0);
    dead.setFlags(0); // they rise
    expect(dead.rezzing).toBe(true);
    dead.stepRez(REZ_SECONDS.in + 0.1);
    expect(bodyShown(dead)).toBe(true);
  });
});
