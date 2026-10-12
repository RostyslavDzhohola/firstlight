import { describe, expect, it } from "vitest";
import type { Breakable, Terrain } from "@firstlight/shared";
import { BreakableCollider, PLAYER_BODY } from "@firstlight/shared/planet/collide";
import type { Input } from "./input.ts";
import { PlayerController, type MoveColliders } from "./PlayerController.ts";

const R = 500;
/** A flat, dry sphere. */
const terrain = { body: { radius: R }, groundHeight: () => 0 } as unknown as Terrain;

function fakeInput(keys: string[] = []) {
  const down = new Set(keys);
  return {
    locked: true, mouseDX: 0, mouseDY: 0, wheel: 0, sensitivity: 0.002, invertY: false,
    pressed: new Set<string>(),
    down: (k: string) => down.has(k),
    hold(k: string, on: boolean) {
      if (on) down.add(k);
      else down.delete(k);
    },
  } as unknown as Input & { hold(k: string, on: boolean): void; pressed: Set<string> };
}

/** A box prop standing on the sphere near the north pole (up +y, right +x, forward +z). */
function crate(x: number, z: number, index: number, hx = 0.5, hz = 0.5, h = 1): Breakable {
  const b = {
    id: `0.${index}`, index, site: 0, archetype: 0, kind: "crate", shape: 0, hx, hz, h,
    px: x, py: R, pz: z, rx: 1, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0, fx: 0, fy: 0, fz: 1,
    scale: 1, hp: 40, size: "light", rebuildMs: 1000,
  } as Breakable;
  b.cx = x;
  b.cy = R + h / 2;
  b.cz = z;
  b.foot = Math.hypot(hx, hz);
  b.bound = Math.hypot(b.foot, h / 2);
  return b;
}

function collidersFor(list: Breakable[], solid: (i: number) => boolean = () => true): MoveColliders {
  const c = new BreakableCollider(list);
  return { resolve: (p, out) => c.resolve(p, solid, out) };
}

/** Run the controller at 60 Hz. */
function run(pc: PlayerController, input: Input, seconds: number) {
  for (let t = 0; t < seconds; t += 1 / 60) pc.update(1 / 60, input, false);
}

function spawn(): PlayerController {
  const pc = new PlayerController(terrain, -100);
  pc.teleport(0, R, 0); // camera forward = +z
  run(pc, fakeInput(), 0.2); // settle on the ground
  return pc;
}

describe("PlayerController", () => {
  it("runs forward at run speed along the surface", () => {
    const pc = spawn();
    run(pc, fakeInput(["KeyW"]), 1);
    expect(pc.onGround).toBe(true);
    expect(pc.pos.length()).toBeCloseTo(R, 3);
    expect(pc.pos.z).toBeGreaterThan(4.5); // accelerates to 6 m/s within ~0.3 s
    expect(pc.pos.z).toBeLessThan(6.1);
    expect(Math.abs(pc.pos.x)).toBeLessThan(1e-6);
  });

  it("is stopped by an intact crate and stands clear of it", () => {
    const pc = spawn();
    pc.setColliders(collidersFor([crate(0, 3, 0)]));
    run(pc, fakeInput(["KeyW"]), 2);
    // Crate face at z = 2.5; the body stays a radius in front of it.
    expect(pc.pos.z).toBeCloseTo(2.5 - PLAYER_BODY.radius, 2);
    expect(pc.onGround).toBe(true);
  });

  it("slides along a wall it walks into at an angle", () => {
    const pc = spawn();
    pc.setColliders(collidersFor([crate(0, 3, 0, 30, 0.3, 2.6)])); // a long wall across the path
    const input = fakeInput(["KeyW", "KeyD"]); // forward-right: +z and -x (right = forward × up)
    run(pc, input, 2);
    expect(pc.pos.z).toBeCloseTo(2.7 - PLAYER_BODY.radius, 2);
    expect(Math.abs(pc.pos.x)).toBeGreaterThan(3); // kept moving along the wall
  });

  it("walks through a broken prop", () => {
    const pc = spawn();
    pc.setColliders(collidersFor([crate(0, 3, 0)], () => false));
    run(pc, fakeInput(["KeyW"]), 1.2);
    expect(pc.pos.z).toBeGreaterThan(4);
  });

  it("can jump onto a crate and stand on it, then walk off and land", () => {
    const pc = spawn();
    pc.setColliders(collidersFor([crate(0, 1.5, 0, 1, 1, 1)]));
    const input = fakeInput(["KeyW"]);
    run(pc, input, 0.15); // a few steps toward it
    input.pressed.add("Space");
    pc.update(1 / 60, input, false);
    input.pressed.clear();
    run(pc, input, 0.45);
    input.hold("KeyW", false);
    run(pc, input, 0.6);
    expect(pc.onGround).toBe(true);
    expect(pc.pos.length()).toBeCloseTo(R + 1, 2);
    input.hold("KeyW", true);
    run(pc, input, 1.5);
    expect(pc.onGround).toBe(true);
    expect(pc.pos.length()).toBeCloseTo(R, 3);
    expect(pc.pos.z).toBeGreaterThan(3);
  });

  it("gets out of a crate that rebuilt around it", () => {
    const pc = spawn();
    pc.setColliders(collidersFor([crate(0, 0.1, 0)]));
    run(pc, fakeInput(), 0.1);
    expect(Math.abs(pc.pos.z - 0.1)).toBeGreaterThan(0.5 + PLAYER_BODY.radius - 0.01);
  });
});
