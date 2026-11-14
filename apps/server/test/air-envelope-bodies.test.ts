// The client's real PlayerController against the server's real movement validator on every body
// (sky review 1, 2026-11-13): on foot and mounted, sprinting or galloping into a jump, and on Lumen a
// dodge-roll off the ground into the air and a Skipstep in the middle of a jump. Every 20 Hz packet
// (Net.sendInput) goes through validateMove; none may be refused.
//
// The bug: the client moved in a straight line through the air, so on a small sphere running fast
// carried the body away from the centre (on Lumen, 240 m, a 16 m/s gallop added 1.07 m/s² of lift,
// a quarter of its pull), while the server's envelope is a radial ballistic path from the launch.
// The ground is flat at the body's radius so only the sphere's curvature is in play.

import { describe, expect, it } from "vitest";
import { BODIES, BODY_IDS, bodyGravity, type BodyId } from "@firstlight/shared";
import { ANIM } from "@firstlight/shared/net/schema";
import { rideSpeed } from "@firstlight/shared/content/horse";
import { motionFields, validateMove, groundMotion, type MoveLimits, type MoveWorld } from "../src/world/movement.ts";
import { skipstepPath } from "../src/world/spells/skipstep.ts";
import type { PlayerActor } from "../src/world/actors.ts";

const T0 = 1_000_000;

interface V {
  x: number;
  y: number;
  z: number;
  length(): number;
  dot(v: V): number;
  clone(): V;
}
interface Controller {
  pos: V;
  vel: V;
  anim: number;
  onGround: boolean;
  mounted: boolean;
  update(dt: number, input: unknown, aiming: boolean): void;
  teleport(x: number, y: number, z: number): void;
  correct(x: number, y: number, z: number): void;
  resumeAfterBlink(vel: V): void;
}

async function controller(body: BodyId): Promise<Controller> {
  const url = new URL("../../client/src/game/PlayerController.ts", import.meta.url).href;
  const { PlayerController } = (await import(/* @vite-ignore */ url)) as { PlayerController: new (t: unknown, water: number) => Controller };
  const def = BODIES[body];
  return new PlayerController({ body: def, groundHeight: () => 0 }, -100);
}

function keys(down: string[]) {
  const held = new Set(down);
  return { locked: true, captured: true, mouseDX: 0, mouseDY: 0, wheel: 0, sensitivity: 0.002, invertY: false, pressed: new Set<string>(), down: (k: string) => held.has(k) };
}

interface Run {
  refused: string[];
  /** Highest the feet rose above the ground (m). */
  peak: number;
  rolled: boolean;
}

/**
 * Speed up for 2 s (galloping or sprinting), then jump; `roll`: press C on the ground the frame
 * before the jump (on foot), `blinkAt`: the server Skipsteps the body this many seconds into the jump.
 */
async function jump(body: BodyId, opts: { mounted?: boolean; roll?: boolean; blinkAt?: number; fps?: number } = {}): Promise<Run> {
  const def = BODIES[body];
  const R = def.radius;
  const pc = await controller(body);
  pc.teleport(0, R, 0);
  pc.mounted = !!opts.mounted;
  const world: MoveWorld = { radius: R, waterLevel: -100, groundAt: () => 0 };
  const limits: MoveLimits = opts.mounted ? { speed: 1, dodge: 0, ride: rideSpeed(true) } : { speed: 1, dodge: 1 };
  const input = keys(["KeyW", "ShiftLeft"]);
  const dt = 1 / (opts.fps ?? 60);
  const a = { lastX: pc.pos.x, lastY: pc.pos.y, lastZ: pc.pos.z, ...motionFields(R, T0, bodyGravity(def)), state: { seq: 0 } } as unknown as PlayerActor;
  let t = 0;
  let lastSend = -Infinity;
  let jumpedAt: number | null = null;
  let blinked = false;
  let rolled = false;
  let peak = 0;
  const refused: string[] = [];
  while (t < 2 + 4) {
    if (jumpedAt === null && t >= 2 && pc.onGround) {
      if (opts.roll) input.pressed.add("KeyC");
      input.pressed.add("Space");
      jumpedAt = t;
    }
    pc.update(dt, input, false);
    input.pressed.clear();
    t += dt;
    if (pc.anim === ANIM.DODGE) rolled = true;
    peak = Math.max(peak, pc.pos.length() - R);
    const now = T0 + Math.round(t * 1000);
    if (opts.blinkAt !== undefined && jumpedAt !== null && !blinked && t - jumpedAt >= opts.blinkAt) {
      // What SpellSystem.skipstep does: the server places the feet on the ground ahead and starts a new
      // envelope there; the client is corrected, then resumes with the velocity it had (SpellClient).
      blinked = true;
      const path = skipstepPath(world, [a.lastX, a.lastY, a.lastZ], [pc.vel.x, pc.vel.y, pc.vel.z])!;
      expect(path.dist).toBeGreaterThan(5);
      const to = path.to;
      a.lastX = to[0];
      a.lastY = to[1];
      a.lastZ = to[2];
      groundMotion(a, Math.hypot(to[0], to[1], to[2]), now);
      const vel = pc.vel.clone();
      pc.correct(to[0], to[1], to[2]);
      pc.resumeAfterBlink(vel);
      lastSend = now;
      continue;
    }
    if (now - lastSend >= 50) {
      lastSend = now;
      const r = validateMove(a, { x: pc.pos.x, y: pc.pos.y, z: pc.pos.z, anim: pc.anim }, world, limits, now);
      if (!r.ok) {
        refused.push(`${r.reason} at ${((now - T0) / 1000 - (jumpedAt ?? 0)).toFixed(2)} s into the jump`);
        continue;
      }
      a.lastX = pc.pos.x;
      a.lastY = pc.pos.y;
      a.lastZ = pc.pos.z;
    }
  }
  return { refused, peak, rolled };
}

describe("jumps stay inside the server's air envelope on every body (sky review 1)", () => {
  for (const body of BODY_IDS) {
    it(`${body}: a sprint-jump on foot`, async () => {
      const r = await jump(body);
      expect(r.refused).toEqual([]);
      expect(r.peak).toBeGreaterThan(1);
    });
    it(`${body}: a galloping jump on a horse`, async () => {
      const r = await jump(body, { mounted: true });
      expect(r.refused).toEqual([]);
      expect(r.peak).toBeGreaterThan(1);
    });
  }

  it("a jump is as high at a gallop as standing still (the sphere's curve adds no lift)", async () => {
    for (const body of ["lumen", "portus"] as const) {
      const apex = (6.6 * 6.6) / (2 * bodyGravity(BODIES[body]));
      const r = await jump(body, { mounted: true });
      expect(r.peak).toBeGreaterThan(apex - 0.1);
      expect(r.peak).toBeLessThan(apex + 0.1);
    }
  });

  it("lumen: a dodge-roll into a jump, at 60 and 20 fps", async () => {
    for (const fps of [60, 20]) {
      const r = await jump("lumen", { roll: true, fps });
      expect(r.rolled).toBe(true);
      expect(r.refused).toEqual([]);
    }
  });

  it("lumen: a Skipstep in the middle of a jump, rising and falling", async () => {
    for (const at of [0.3, 1.0, 2.0]) {
      const r = await jump("lumen", { blinkAt: at });
      expect(r.refused, `blink ${at} s in`).toEqual([]);
    }
  });
});
