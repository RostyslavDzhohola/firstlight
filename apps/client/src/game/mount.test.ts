import { describe, expect, it } from "vitest";
import { HORSE } from "@firstlight/shared/content/horse";
import { MountState, horseKeys, horsesEnabled, mountedSpeed, rideBlockedByWater, rideCamera } from "./mount.ts";

describe("MountState (local riding state)", () => {
  it("follows the server's flag and never gets on before it", () => {
    const m = new MountState();
    m.sync(false);
    expect(m.riding).toBe(false);
    m.sync(true);
    expect(m.riding).toBe(true);
    m.sync(false);
    expect(m.riding).toBe(false);
  });

  it("can slide off early (deep water) and stays off until the server agrees, then can mount again", () => {
    const m = new MountState();
    m.sync(true);
    m.slideOff();
    expect(m.riding).toBe(false);
    expect(m.awaitingServer).toBe(true);
    m.sync(true); // server still thinks we ride: stay off
    expect(m.riding).toBe(false);
    m.sync(false); // server caught up
    expect(m.awaitingServer).toBe(false);
    m.sync(true); // a later mount works
    expect(m.riding).toBe(true);
  });

  it("asks the server to dismount after a slide-off, and asks again (no faster than its cooldown) until it agrees", () => {
    const m = new MountState();
    m.sync(true);
    expect(m.dismountDue(0)).toBe(false); // riding: nothing to ask
    m.slideOff();
    expect(m.dismountDue(1000)).toBe(true);
    expect(m.dismountDue(1000 + HORSE.toggleCooldownMs - 1)).toBe(false);
    m.sync(true); // the server ignored it (e.g. it had just mounted us)
    expect(m.dismountDue(1000 + HORSE.toggleCooldownMs)).toBe(true);
    m.sync(false); // agreed
    expect(m.dismountDue(1e6)).toBe(false);
  });

  it("keeps weapons lowered while riding and for the server's dismount grace afterwards", () => {
    const m = new MountState();
    expect(m.weaponsLocked).toBe(false); // never rode
    m.sync(true);
    m.step(1 / 60);
    expect(m.weaponsLocked).toBe(true);
    m.sync(false);
    m.step(HORSE.dismountGraceMs / 2000);
    expect(m.weaponsLocked).toBe(true);
    m.step(HORSE.dismountGraceMs / 1000);
    expect(m.weaponsLocked).toBe(false);
  });

  it("eases the camera blend in and out", () => {
    const m = new MountState();
    m.sync(true);
    for (let i = 0; i < 3; i++) m.step(1 / 60);
    expect(m.blend).toBeGreaterThan(0);
    expect(m.blend).toBeLessThan(0.5);
    for (let i = 0; i < 240; i++) m.step(1 / 60);
    expect(m.blend).toBe(1);
    m.sync(false);
    for (let i = 0; i < 240; i++) m.step(1 / 60);
    expect(m.blend).toBe(0);
    expect(rideCamera(1).lift).toBeGreaterThan(0);
    expect(rideCamera(1).back).toBeGreaterThan(0);
    expect(rideCamera(0)).toEqual({ lift: 0, back: 0 });
  });
});

describe("riding rules on the client", () => {
  it("moves at the server's horse speeds, NPC slows included", () => {
    expect(mountedSpeed(false)).toBe(HORSE.speed);
    expect(mountedSpeed(true)).toBe(HORSE.sprint);
    expect(mountedSpeed(true, 0.5)).toBe(HORSE.sprint * 0.5);
    expect(mountedSpeed(true, 0, true)).toBe(HORSE.speed);
  });

  it("slides off only in water too deep to wade", () => {
    expect(rideBlockedByWater(-0.4, 0)).toBe(false);
    expect(rideBlockedByWater(-2, 0)).toBe(true);
  });

  it("maps E to get on / off and only prompts when it matters", () => {
    expect(horseKeys({ riding: true, haveHorse: true, near: true, moving: true })).toEqual({ e: "dismount", prompt: null });
    expect(horseKeys({ riding: true, haveHorse: true, near: true, moving: false }).prompt).toContain("Get off");
    expect(horseKeys({ riding: false, haveHorse: true, near: true, moving: false })).toEqual({ e: "ride", prompt: "E — Ride your horse" });
    expect(horseKeys({ riding: false, haveHorse: true, near: false, moving: false })).toEqual({ e: null, prompt: null });
    expect(horseKeys({ riding: false, haveHorse: false, near: false, moving: false }).e).toBeNull();
  });
});

describe("the horses flag", () => {
  it("is on only when the server says so and the ?nohorses kill switch is off", () => {
    expect(horsesEnabled({ horses: true }, false)).toBe(true);
    expect(horsesEnabled({ horses: true }, true)).toBe(false);
    expect(horsesEnabled({}, false)).toBe(false);
    expect(horsesEnabled(null, false)).toBe(false);
  });
});
