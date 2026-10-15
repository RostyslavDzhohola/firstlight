// The client's dodge-roll against the server's real movement validator (no room): rolls the client
// allows must never cost more than the server lets them. Codex review of the roll's ground grace: a
// roll that starts just after stepping off an edge kept its 15 m/s in the air (air control slows it
// at a quarter of the ground rate) and outran the 1.6 m dodge reserve, which assumes the ground's
// slowdown. Several frame rates, packets paced like Net.sendInput (20 Hz), the bank emptied first.

import { describe, expect, it } from "vitest";
import { ANIM } from "@firstlight/shared/net/schema";
import { motionFields, validateMove, type MoveWorld } from "../src/world/movement.ts";
import type { PlayerActor } from "../src/world/actors.ts";

const R = 1000;
const LEDGE = 10; // metres: the high ground (z < 0 near the north pole) drops to 0 at z = 0
const T0 = 1_000_000; // server clock at the start (well past any cooldown)

/** Ground height above the radius under a unit direction. */
const groundHeight = (_x: number, _y: number, z: number) => (z < 0 ? LEDGE : 0);
const terrain = { body: { radius: R }, groundHeight };
const world: MoveWorld = { radius: R, waterLevel: -100, groundAt: (x, y, z) => groundHeight(x, y, z / Math.hypot(x, y, z)) };

interface Controller {
  pos: { x: number; y: number; z: number; length(): number };
  facing: { x: number; y: number; z: number };
  anim: number;
  onGround: boolean;
  update(dt: number, input: unknown, aiming: boolean): void;
  teleport(x: number, y: number, z: number): void;
}

/** The client's PlayerController (apps/client), loaded at runtime so the server typecheck stays server-only. */
async function controller(): Promise<Controller> {
  const url = new URL("../../client/src/game/PlayerController.ts", import.meta.url).href;
  const { PlayerController } = (await import(/* @vite-ignore */ url)) as { PlayerController: new (t: unknown, water: number) => Controller };
  return new PlayerController(terrain, -100);
}

function keys(down: string[]) {
  const held = new Set(down);
  return { locked: true, mouseDX: 0, mouseDY: 0, wheel: 0, sensitivity: 0.002, invertY: false, pressed: new Set<string>(), keys: held, down: (k: string) => held.has(k) };
}

/**
 * Sprint at the edge from 6 m back, press C `delay` seconds after the feet leave it (0 = the first
 * airborne frame; negative = on the ground that many metres before it, so the roll carries over the
 * edge; null = at once, on the high ground), and keep sprinting. Every 20 Hz packet goes
 * through validateMove; the bank is emptied the moment the roll starts. Returns the refusals.
 */
async function run(fps: number, delay: number | null): Promise<{ refused: string[]; rolled: boolean }> {
  const pc = await controller();
  const start = [0, R + LEDGE, -6];
  const l = Math.hypot(start[0]!, start[1]!, start[2]!);
  pc.teleport((start[0]! / l) * (R + LEDGE), (start[1]! / l) * (R + LEDGE), (start[2]! / l) * (R + LEDGE));
  const input = keys(["KeyW", "ShiftLeft"]);
  const dt = 1 / fps;
  // Settle on the high ground, then let the server's actor start from there.
  for (let i = 0; i < 6; i++) pc.update(dt, keys([]), false);
  let t = 0;
  const a = { lastX: pc.pos.x, lastY: pc.pos.y, lastZ: pc.pos.z, ...motionFields(pc.pos.length(), T0) } as unknown as PlayerActor;
  let lastSend = -Infinity;
  let leftAt: number | null = null;
  let pressed = false;
  let rolled = false;
  const refused: string[] = [];
  while (t < 2.2) {
    if (!pressed) {
      const airborne = !pc.onGround;
      if (airborne && leftAt === null) leftAt = t;
      const due = delay === null ? pc.onGround : delay < 0 ? pc.onGround && pc.pos.z > delay : leftAt !== null && t - leftAt >= delay - 1e-9;
      if (due) {
        input.pressed.add("KeyC");
        pressed = true;
      }
    }
    pc.update(dt, input, false);
    input.pressed.clear();
    t += dt;
    if (pc.anim === ANIM.DODGE && !rolled) {
      rolled = true;
      a.moveBudget = 0; // an empty bank (just corrected, or shoved): the roll lives on its reserve
    }
    const now = T0 + Math.round(t * 1000);
    if (now - lastSend >= 50) {
      lastSend = now;
      const r = validateMove(a, { x: pc.pos.x, y: pc.pos.y, z: pc.pos.z, anim: pc.anim }, world, { speed: 1, dodge: 1 }, now);
      if (!r.ok) {
        refused.push(`${r.reason} at ${now - T0} ms`);
        continue; // a refused packet leaves the server where it was (the client would be corrected)
      }
      a.lastX = pc.pos.x;
      a.lastY = pc.pos.y;
      a.lastZ = pc.pos.z;
    }
  }
  return { refused, rolled };
}

describe("dodge-roll against the server's movement allowance", () => {
  for (const fps of [20, 30, 60, 120]) {
    it(`${fps} fps: a sprint roll off a 10 m ledge, from an empty bank, is never refused`, async () => {
      for (const delay of [0, 0.05]) { // within the 0.12 s ground grace at every frame rate
        const { refused, rolled } = await run(fps, delay);
        expect(rolled, `rolled (C ${delay} s after the edge)`).toBe(true);
        expect(refused, `C ${delay} s after the edge`).toEqual([]);
      }
    });

    it(`${fps} fps: a roll that carries over the edge is never refused`, async () => {
      const { refused, rolled } = await run(fps, -1.5);
      expect(rolled).toBe(true);
      expect(refused).toEqual([]);
    });

    it(`${fps} fps: the same roll on the high ground, then off the edge, is never refused`, async () => {
      const { refused, rolled } = await run(fps, null);
      expect(rolled).toBe(true);
      expect(refused).toEqual([]);
    });
  }
});
