import { describe, expect, it } from "vitest";
import { BODIES, createTerrain, type Breakable, type Terrain } from "@firstlight/shared";
import { structureCollider, townCoords, townDir } from "@firstlight/shared/planet/town";
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

/** Run the controller at `fps` (60 by default), calling `each` after every frame. */
function run(pc: PlayerController, input: Input, seconds: number, fps = 60, each?: () => void) {
  for (let t = 0; t < seconds - 1e-9; t += 1 / fps) {
    pc.update(1 / fps, input, false);
    each?.();
  }
}

function spawn(): PlayerController {
  const pc = new PlayerController(terrain, -100);
  pc.teleport(0, R, 0); // camera forward = +z
  run(pc, fakeInput(), 0.2); // settle on the ground
  return pc;
}

describe("PlayerController in the Portus town (D38)", () => {
  it("is stopped by a house's wall (the shared structures) and slides along it", () => {
    const portus = createTerrain("portus");
    const town = structureCollider(portus)!;
    const pc = new PlayerController(portus, BODIES.portus.waterLevel);
    pc.setStructures({ resolve: (p, out) => town.resolve(p, out) });
    // On the east street, south of the house at (26.2, 6.1) whose front faces the street.
    const d = townDir(26.2, 1, BODIES.portus.radius);
    pc.teleport(d[0] * BODIES.portus.radius, d[1] * BODIES.portus.radius, d[2] * BODIES.portus.radius);
    run(pc, fakeInput(), 0.2);
    run(pc, fakeInput(["KeyW"]), 2.5); // north, into the house
    const [, north] = townCoords(pc.pos.x, pc.pos.y, pc.pos.z, BODIES.portus.radius);
    expect(north).toBeGreaterThan(2.5);
    expect(north).toBeLessThan(3.8);
    expect(town.footing(pc.pos.x, pc.pos.y, pc.pos.z, PLAYER_BODY.step).inside).toBe(false);
    expect(pc.onGround).toBe(true);
  });
});

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

  describe("at low frame rates (no tunnelling)", () => {
    const fence = () => crate(0, 0, 0, 1.0, 0.09, 1.1); // the shared 2 × 0.18 × 1.1 m fence collider

    for (const fps of [20, 30]) {
      it(`a dodge at ${fps} fps doesn't cross a fence it starts against`, () => {
        const pc = spawn();
        pc.setColliders(collidersFor([fence()]));
        pc.teleport(0, R, -0.09 - PLAYER_BODY.radius - 0.001);
        run(pc, fakeInput(), 0.1, fps);
        const input = fakeInput(["KeyW"]);
        input.pressed.add("KeyC");
        let maxZ = -Infinity;
        run(pc, input, 0.5, fps, () => {
          input.pressed.clear();
          maxZ = Math.max(maxZ, pc.pos.z);
        });
        expect(maxZ).toBeLessThan(-0.09 - PLAYER_BODY.radius + 0.01);
      });
    }

    it("a 20 m/s fall onto a crate top at 20 fps lands on it instead of being shoved off", () => {
      const pc = spawn();
      pc.setColliders(collidersFor([crate(0, 0, 0)]));
      pc.teleport(0.1, R + 1.1, 0.05);
      pc.vel.set(0, -20, 0);
      pc.onGround = false;
      run(pc, fakeInput(), 0.05, 20);
      expect(pc.pos.length()).toBeCloseTo(R + 1, 3);
      expect(pc.onGround).toBe(true);
      expect(pc.pos.x).toBeCloseTo(0.1, 3); // not shoved (that would be ≥ 0.1 m); sub-mm from the radial snap
      expect(pc.pos.z).toBeCloseTo(0.05, 3);
    });

    it("a galloping horse (16 m/s) at 20 fps stops at a fence", () => {
      const pc = spawn();
      pc.setColliders(collidersFor([fence()]));
      pc.teleport(0, R, -14);
      pc.mounted = true;
      let maxZ = -Infinity;
      run(pc, fakeInput(["KeyW", "ShiftLeft"]), 3, 20, () => (maxZ = Math.max(maxZ, pc.pos.z)));
      expect(maxZ).toBeLessThan(-0.09 - PLAYER_BODY.radius + 0.01);
      expect(pc.pos.z).toBeCloseTo(-0.09 - PLAYER_BODY.radius, 2);
    });
  });

  describe("server corrections (F12 confirm Sonnet N-6)", () => {
    it("a small correction keeps the camera heading and the facing; motion stops", () => {
      const pc = spawn();
      const heading = Math.SQRT1_2;
      pc.camForward.set(heading, 0, heading); // turned 45° right of +z
      pc.facing.set(1, 0, 0);
      pc.vel.set(3, 0, 0);
      pc.correct(0.8, R, 0.3);
      expect(pc.pos.x).toBeCloseTo(0.8, 6);
      expect(pc.camForward.x).toBeCloseTo(heading, 2);
      expect(pc.camForward.z).toBeCloseTo(heading, 2);
      expect(pc.facing.x).toBeCloseTo(1, 2);
      expect(Math.abs(pc.camForward.dot(pc.up()))).toBeLessThan(1e-9); // still tangent
      expect(pc.vel.length()).toBe(0);
    });

    it("a far one (admin or quest teleport) resets the camera like a teleport", () => {
      const pc = spawn();
      pc.camForward.set(1, 0, 0);
      pc.correct(0, 0, R); // a quarter of the way round the planet
      const ref = new PlayerController(terrain, -100);
      ref.teleport(0, 0, R);
      expect(pc.camForward.distanceTo(ref.camForward)).toBeLessThan(1e-9);
      expect(pc.facing.distanceTo(ref.facing)).toBeLessThan(1e-9);
    });
  });
});
