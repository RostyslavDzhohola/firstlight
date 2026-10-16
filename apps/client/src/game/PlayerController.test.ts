import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { BODIES, createTerrain, natureSolids, padDirs, portalSpots, type Breakable, type Terrain } from "@firstlight/shared";
import { OUTPOSTS } from "@firstlight/shared/content/padOutposts";
import { outpostAnchor, siteDir } from "@firstlight/shared/planet/sites";
import { structureCollider, townCoords, townDir } from "@firstlight/shared/planet/town";
import { BreakableCollider, PLAYER_BODY } from "@firstlight/shared/planet/collide";
import type { Input } from "./input.ts";
import { ANIM } from "@firstlight/shared/net/schema";
import { MOVE, PlayerController, type MoveColliders } from "./PlayerController.ts";

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

  describe("dodge-roll (C; content §0: 4.5 m over 0.3 s, cooldown 1.2 s, 100 ms input buffer)", () => {
    /** One frame with C pressed (the key went down since the last frame), then the rest at `fps`. */
    function pressC(pc: PlayerController, input: ReturnType<typeof fakeInput>, fps = 60) {
      input.pressed.add("KeyC");
      pc.update(1 / fps, input, false);
      input.pressed.clear();
    }
    const hSpeed = (pc: PlayerController) => pc.vel.clone().addScaledVector(pc.up(), -pc.vel.dot(pc.up())).length();

    it("rolls on the frame the key is read: roll state and roll speed at once, no wind-up", () => {
      const pc = spawn();
      const input = fakeInput();
      pressC(pc, input);
      expect(pc.anim).toBe(ANIM.DODGE);
      expect(hSpeed(pc)).toBeCloseTo(MOVE.dodgeDistance / MOVE.dodgeTime, 1);
      run(pc, input, MOVE.dodgeTime);
      expect(pc.pos.z).toBeGreaterThan(MOVE.dodgeDistance - 0.3);
    });

    it("a press in the last 100 ms of the cooldown rolls the moment it ends (input buffer)", () => {
      const pc = spawn();
      const input = fakeInput();
      pressC(pc, input);
      run(pc, input, MOVE.dodgeCooldown - 0.08);
      expect(pc.anim).not.toBe(ANIM.DODGE);
      pressC(pc, input);
      let rolledAt = -1;
      let t = 0;
      run(pc, input, 0.15, 60, () => {
        t += 1 / 60;
        if (rolledAt < 0 && pc.anim === ANIM.DODGE) rolledAt = t;
      });
      expect(rolledAt).toBeGreaterThan(0);
      expect(rolledAt).toBeLessThan(0.1);
    });

    it("the cooldown is a wall-clock deadline: at 10 fps (frames clamped to 50 ms) C 1.25 s after a roll rolls", () => {
      // A slow machine: 100 ms frames, simulated as 50 ms steps (Game's clamp). In game time only
      // 0.62 s have passed, which used to drop the press until 2.4 s of real time had gone by.
      const pc = spawn();
      const input = fakeInput();
      let now = 10_000;
      input.pressed.add("KeyC");
      pc.update(0.05, input, false, now);
      input.pressed.clear();
      for (let i = 0; i < 12; i++) pc.update(0.05, input, false, (now += 100)); // 1.2 s of real time
      input.pressed.add("KeyC");
      pc.update(0.05, input, false, (now += 100));
      expect(pc.anim).toBe(ANIM.DODGE);
    });

    it("a stall longer than the cooldown counts in full: C on the first frame back rolls (Codex review)", () => {
      // The roll, then the tab or the machine stalls 1.5 s (one frame, its step clamped to 50 ms):
      // the server is ready again, and so is the client, however long the stall.
      for (const [stallTo, rolls] of [[1100, false], [1250, true], [1500, true], [5000, true]] as const) {
        const pc = spawn();
        const input = fakeInput();
        const t0 = 10_000;
        let now = t0;
        input.pressed.add("KeyC");
        pc.update(1 / 60, input, false, now);
        input.pressed.clear();
        for (let i = 0; i < 25; i++) pc.update(1 / 60, input, false, (now += 1000 / 60)); // the roll ends
        expect(pc.anim).not.toBe(ANIM.DODGE);
        pc.update(0.05, input, false, (now = t0 + stallTo)); // one stalled frame, clamped to 50 ms
        input.pressed.add("KeyC");
        pc.update(1 / 60, input, false, (now += 1000 / 60));
        expect(pc.anim === ANIM.DODGE, `C after a stall to ${stallTo} ms`).toBe(rolls);
      }
    });

    it("a press earlier in the cooldown is dropped, not stored for a late roll", () => {
      const pc = spawn();
      const input = fakeInput();
      pressC(pc, input);
      run(pc, input, 0.6);
      pressC(pc, input);
      let rolled = false;
      run(pc, input, 1.2, 60, () => (rolled ||= pc.anim === ANIM.DODGE));
      expect(rolled).toBe(false);
    });

    it("a press just before landing from a jump rolls on touchdown", () => {
      const pc = spawn();
      const input = fakeInput();
      input.pressed.add("Space");
      pc.update(1 / 60, input, false);
      input.pressed.clear();
      // A 6.6 m/s jump lands after ~0.73 s: press 60 ms before that.
      run(pc, input, 0.67);
      expect(pc.onGround).toBe(false);
      pressC(pc, input);
      let rolled = false;
      run(pc, input, 0.15, 60, () => (rolled ||= pc.anim === ANIM.DODGE));
      expect(rolled).toBe(true);
    });

    it("no roll straight out of a jump (only stepping off an edge gets a moment of grace)", () => {
      const pc = spawn();
      const input = fakeInput();
      input.pressed.add("Space");
      pc.update(1 / 60, input, false);
      input.pressed.clear();
      pressC(pc, input);
      let rolled = false;
      run(pc, input, 0.3, 60, () => (rolled ||= pc.anim === ANIM.DODGE));
      expect(rolled).toBe(false);
    });

    it("stepping off a ledge, a press within a moment still rolls (low frame rates lose the ground for a frame)", () => {
      const pc = spawn();
      pc.setColliders(collidersFor([crate(0, 0, 0, 1, 1, 1)]));
      pc.teleport(0, R + 1, 0.5);
      const input = fakeInput();
      run(pc, input, 0.1, 20);
      expect(pc.onGround).toBe(true);
      input.hold("KeyW", true);
      while (pc.onGround) pc.update(1 / 20, input, false); // walk off the front edge
      pressC(pc, input, 20);
      expect(pc.anim).toBe(ANIM.DODGE);
    });

    it("the body faces the roll from its first frame: back and side rolls look like rolls", () => {
      for (const [key, want] of [["KeyS", [0, 0, -1]], ["KeyA", [1, 0, 0]]] as const) {
        const pc = spawn();
        const input = fakeInput([key]);
        pressC(pc, input);
        expect(pc.facing.x).toBeCloseTo(want[0], 3);
        expect(pc.facing.z).toBeCloseTo(want[2], 3);
        run(pc, input, MOVE.dodgeTime / 2, 60, () => {});
        // Aiming doesn't turn it back mid-roll either.
        pc.update(1 / 60, input, true);
        expect(pc.facing.x).toBeCloseTo(want[0], 3);
        expect(pc.facing.z).toBeCloseTo(want[2], 3);
      }
    });

    it("no grace before the first touchdown: a body placed in the air (arrival) can't roll until it lands", () => {
      const pc = new PlayerController(terrain, -100);
      pc.teleport(0, R + 3, 0);
      const input = fakeInput();
      pressC(pc, input);
      expect(pc.anim).not.toBe(ANIM.DODGE);
    });

    it("a roll's extra speed bleeds off at the ground rate in the air too (off an edge)", () => {
      const pc = spawn();
      const input = fakeInput(["KeyW"]);
      pressC(pc, input);
      run(pc, input, MOVE.dodgeTime);
      pc.vel.addScaledVector(pc.up(), 8); // thrown up as the roll ends: the rest happens in the air
      pc.onGround = false;
      run(pc, input, 0.25);
      expect(pc.onGround).toBe(false);
      expect(hSpeed(pc)).toBeLessThan(MOVE.run + 0.5); // air control alone would still be ~10 m/s
    });

    it("no roll from the saddle, in the water or while frozen", () => {
      for (const set of [(p: PlayerController) => (p.mounted = true), (p: PlayerController) => (p.frozen = true)]) {
        const pc = spawn();
        set(pc);
        pressC(pc, fakeInput());
        expect(pc.anim).not.toBe(ANIM.DODGE);
      }
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

describe("third-person camera and structures (D42)", () => {
  it("comes in short of a house wall behind the player and eases back out once clear", () => {
    const portus = createTerrain("portus");
    const town = structureCollider(portus)!;
    const R = BODIES.portus.radius;
    const pc = new PlayerController(portus, BODIES.portus.waterLevel);
    pc.setStructures({ resolve: (p, out) => town.resolve(p, out), raycast: (o, d, maxT) => town.raycast(o.x, o.y, o.z, d.x, d.y, d.z, maxT) });
    // On the east street just south of the house at (26.2, 6.1), looking south: the house is behind.
    const d = townDir(26.2, 2.2, R);
    pc.teleport(d[0] * R, d[1] * R, d[2] * R);
    run(pc, fakeInput(), 0.2);
    const toward = (e: number, n: number) => {
      const q = townDir(e, n, R);
      const up = pc.pos.clone().normalize();
      const v = new THREE.Vector3(q[0] * R - pc.pos.x, q[1] * R - pc.pos.y, q[2] * R - pc.pos.z);
      return v.addScaledVector(up, -v.dot(up)).normalize();
    };
    (pc as unknown as { camForward: THREE.Vector3 }).camForward.copy(toward(26.2, -20));
    const cam = new THREE.PerspectiveCamera();
    const head = pc.pos.clone().addScaledVector(pc.pos.clone().normalize(), 1.65);
    const clear = () => {
      const v = cam.position.clone().sub(head);
      const l = v.length();
      return town.raycast(head.x, head.y, head.z, v.x / l, v.y / l, v.z / l, l + 0.1) === Infinity;
    };
    pc.placeCamera(cam);
    expect(clear()).toBe(true);
    expect(cam.position.distanceTo(head)).toBeLessThan(4.6);
    // Turned round (the house now in front), the camera eases back out to its full distance.
    (pc as unknown as { camForward: THREE.Vector3 }).camForward.copy(toward(26.2, 30));
    pc.placeCamera(cam);
    const first = cam.position.distanceTo(head);
    for (let i = 0; i < 40; i++) pc.placeCamera(cam);
    expect(cam.position.distanceTo(head)).toBeGreaterThan(first);
    expect(cam.position.distanceTo(head)).toBeGreaterThan(4.5);
  });

  it("pressed against a wall and turned away from it, the lens stays out of the wall (round 2 browser check)", () => {
    const portus = createTerrain("portus");
    const town = structureCollider(portus)!;
    const R = BODIES.portus.radius;
    const pc = new PlayerController(portus, BODIES.portus.waterLevel);
    pc.setStructures({ resolve: (p, out) => town.resolve(p, out), raycast: (o, d, maxT) => town.raycast(o.x, o.y, o.z, d.x, d.y, d.z, maxT) });
    const d = townDir(26.2, 2.2, R);
    pc.teleport(d[0] * R, d[1] * R, d[2] * R);
    run(pc, fakeInput(), 0.2);
    const toward = (e: number, n: number) => {
      const q = townDir(e, n, R);
      const up = pc.pos.clone().normalize();
      const v = new THREE.Vector3(q[0] * R - pc.pos.x, q[1] * R - pc.pos.y, q[2] * R - pc.pos.z);
      return v.addScaledVector(up, -v.dot(up)).normalize();
    };
    // Walk north into the house's wall and keep pushing, then turn round: the wall is right behind.
    const cf = (pc as unknown as { camForward: THREE.Vector3 }).camForward;
    cf.copy(toward(26.2, 30));
    run(pc, fakeInput(["KeyW"]), 3);
    cf.copy(toward(26.2, -30));
    const cam = new THREE.PerspectiveCamera();
    for (let i = 0; i < 10; i++) pc.placeCamera(cam);
    const head = pc.pos.clone().addScaledVector(pc.pos.clone().normalize(), 1.65);
    const v = cam.position.clone().sub(head);
    const l = v.length();
    const wall = town.raycast(head.x, head.y, head.z, v.x / l, v.y / l, v.z / l, 5);
    expect(wall, "the wall is close behind the head").toBeLessThan(1.2);
    // The lens sits short of the wall along its line from the head, with room to spare.
    expect(wall - l).toBeGreaterThan(0.15);
    expect(town.footing(cam.position.x, cam.position.y, cam.position.z, 0, { radius: 0.01, height: 0.01, step: 0 }).inside).toBe(false);
  });
});

describe("walking into the Portus portals (round 2: gate A's courts)", () => {
  it("walks straight from the plaza into each portal with W alone: nothing at its foot stops the feet", () => {
    const portus = createTerrain("portus");
    const town = structureCollider(portus)!;
    const R = BODIES.portus.radius;
    for (const spot of portalSpots(BODIES.portus, portus)) {
      const pc = new PlayerController(portus, BODIES.portus.waterLevel);
      pc.setStructures({ resolve: (p, out) => town.resolve(p, out), raycast: (o, d, maxT) => town.raycast(o.x, o.y, o.z, d.x, d.y, d.z, maxT) });
      // 9 m out in front of the portal (the way players come from the plaza), facing it.
      const up = new THREE.Vector3(...spot.dir);
      const f = new THREE.Vector3(...spot.facing);
      const start = up.clone().multiplyScalar(R).addScaledVector(f, 9).normalize().multiplyScalar(R);
      pc.teleport(start.x, start.y, start.z);
      run(pc, fakeInput(), 0.2);
      const cf = (pc as unknown as { camForward: THREE.Vector3 }).camForward;
      const aim = () => {
        const u = pc.pos.clone().normalize();
        const v = up.clone().multiplyScalar(R).sub(pc.pos);
        cf.copy(v.addScaledVector(u, -v.dot(u)).normalize());
      };
      aim();
      let best = Infinity;
      run(pc, fakeInput(["KeyW"]), 4, 60, () => {
        aim();
        best = Math.min(best, pc.pos.clone().normalize().distanceTo(up) * R);
      });
      expect(best, `into the ${spot.to} portal`).toBeLessThan(1);
    }
  });
});

describe("the walled outposts' rings and the controller (D-b2-1 with D-solid-1)", () => {
  /** Into the ring from 5 m outside at `bearing` (site frame of pad 0), W held for 4 s, as the game wires it. */
  function intoRing(body: "arcadia" | "hollowmere" | "meridian", bearing: number) {
    const t = createTerrain(body);
    const R = BODIES[body].radius;
    const town = structureCollider(t)!;
    const nature = natureSolids(t);
    const wall = OUTPOSTS[body].wall;
    const a = outpostAnchor(t);
    const pc = new PlayerController(t, BODIES[body].waterLevel);
    pc.setStructures({ resolve: (q, out) => town.resolve(q, out), raycast: (o, d, maxT) => town.raycast(o.x, o.y, o.z, d.x, d.y, d.z, maxT) });
    pc.setNature({ resolve: (q, out) => nature.resolve(q, out), raycast: (o, d, maxT) => nature.raycast(o.x, o.y, o.z, d.x, d.y, d.z, maxT) });
    const b = (bearing * Math.PI) / 180;
    const site = (m: number) => siteDir(a, Math.sin(b) * m, Math.cos(b) * m, R);
    const d0 = site(wall.radius + 5);
    const g0 = t.groundHeight(d0[0], d0[1], d0[2]);
    pc.teleport(d0[0] * (R + g0), d0[1] * (R + g0), d0[2] * (R + g0));
    run(pc, fakeInput(), 0.5);
    const cf = (pc as unknown as { camForward: THREE.Vector3 }).camForward;
    const target = new THREE.Vector3(...site(wall.radius - 6)).multiplyScalar(R);
    const aim = () => {
      const u = pc.pos.clone().normalize();
      const v = target.clone().sub(pc.pos);
      cf.copy(v.addScaledVector(u, -v.dot(u)).normalize());
    };
    let inside = 0, crossed = false, swam = false;
    const pad0 = new THREE.Vector3(...padDirs(BODIES[body])[0]!);
    run(pc, fakeInput(["KeyW"]), 4, 60, () => {
      aim();
      if (pc.swimming) swam = true;
      if (town.footing(pc.pos.x, pc.pos.y, pc.pos.z, PLAYER_BODY.step).inside) inside++;
      if (pc.pos.clone().normalize().distanceTo(pad0) * R < wall.radius - 0.4) crossed = true;
    });
    return { inside, crossed, swam };
  }

  it.each([
    ["arcadia", 100, false], // a land wall on the slope east of the pad
    ["arcadia", 280, true], // the sea wall across the lake, swimming
    ["hollowmere", 300, false],
    ["hollowmere", 285, false], // the sea wall over the west pond's shallows, wading
    ["meridian", 30, false],
    ["meridian", 95, true], // the sea wall across the brine lake, swimming
  ] as const)("%s at %d°: walking or swimming in, the feet never end a frame inside the wall nor cross it", (body, bearing, deep) => {
    const r = intoRing(body, bearing);
    expect(r.crossed, "crossed the ring").toBe(false);
    expect(r.inside, "frames ending inside a wall").toBe(0);
    if (deep) expect(r.swam, "swam up to the sea wall").toBe(true);
  });
});
