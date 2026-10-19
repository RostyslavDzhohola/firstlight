// The client's step-out (#34) against the server's real movement validator (no room): feet pinned
// between the Hall of Firsts' column and its low plinth (each pushes them into the other, so every
// walking step is undone) step out to a clear spot, and the server takes that step like any other.

import { describe, expect, it } from "vitest";
import { BODIES, createTerrain } from "@firstlight/shared";
import { structureCollider } from "@firstlight/shared/planet/sites";
import { motionFields, validateMove, type MoveWorld } from "../src/world/movement.ts";
import type { PlayerActor } from "../src/world/actors.ts";

const T0 = 1_000_000;
/** Where the Portus sweep (apps/client/src/world/portusCamera.test.ts) found the feet pinned. */
const POCKET = [23.5, 147.7, -10.9] as const;

interface Vec {
  x: number;
  y: number;
  z: number;
  length(): number;
  distanceTo(v: Vec): number;
  clone(): Vec;
  set(x: number, y: number, z: number): Vec;
}
interface Controller {
  pos: Vec;
  camForward: Vec;
  anim: number;
  update(dt: number, input: unknown, aiming: boolean): void;
  teleport(x: number, y: number, z: number): void;
  correct(x: number, y: number, z: number): void;
  setStructures(c: unknown): void;
}

/** The client's PlayerController with the town wired as SiteTown wires it (loaded at runtime: the server typecheck stays server-only). */
async function controller(withStepOut = true): Promise<Controller> {
  const base = new URL("../../client/src/game/", import.meta.url).href;
  const { PlayerController } = (await import(/* @vite-ignore */ `${base}PlayerController.ts`)) as { PlayerController: new (t: unknown, water: number) => Controller };
  const { stepOut } = (await import(/* @vite-ignore */ `${base}stepOut.ts`)) as { stepOut: (s: unknown, g: unknown, p: Vec) => boolean };
  const terrain = createTerrain("portus");
  const pc = new PlayerController(terrain, BODIES.portus.waterLevel);
  const walls = structureCollider(terrain);
  const groundR = (x: number, y: number, z: number) => terrain.body.radius + terrain.groundHeight(x, y, z);
  pc.setStructures({ resolve: (p: Vec, out: never) => walls.resolve(p, out), raycast: () => Infinity, stepOut: withStepOut ? (p: Vec) => stepOut(walls, groundR, p) : undefined });
  return pc;
}

function moveWorld(): MoveWorld {
  const terrain = createTerrain("portus");
  const walls = structureCollider(terrain);
  return {
    radius: BODIES.portus.radius,
    waterLevel: BODIES.portus.waterLevel,
    groundAt: (x, y, z) => terrain.groundHeightAt(x, y, z),
    footing: (x, y, z, step) => walls.footing(x, y, z, step),
    crosses: (ax, ay, az, bx, by, bz) => walls.crosses(ax, ay, az, bx, by, bz),
  };
}

/** Unit tangent at `p`, heading `k` of `n` round from the x axis. */
function heading(p: Vec, k: number, n: number): [number, number, number] {
  const l = p.length();
  const u = [p.x / l, p.y / l, p.z / l] as const;
  const e = [1 - u[0] * u[0], -u[0] * u[1], -u[0] * u[2]];
  const el = Math.hypot(e[0]!, e[1]!, e[2]!);
  const a = [e[0]! / el, e[1]! / el, e[2]! / el];
  const b = [u[1] * a[2]! - u[2] * a[1]!, u[2] * a[0]! - u[0] * a[2]!, u[0] * a[1]! - u[1] * a[0]!];
  const t = (k / n) * Math.PI * 2;
  return [a[0]! * Math.cos(t) + b[0]! * Math.sin(t), a[1]! * Math.cos(t) + b[1]! * Math.sin(t), a[2]! * Math.cos(t) + b[2]! * Math.sin(t)];
}

function keys(down: string[]) {
  const held = new Set(down);
  return { locked: true, mouseDX: 0, mouseDY: 0, wheel: 0, sensitivity: 0.002, invertY: false, pressed: new Set<string>(), down: (k: string) => held.has(k) };
}

describe("stepping out of a pocket between structures (#34)", () => {
  it("without it, walking there for 2 s in any of 8 directions gets nowhere (the pocket is real)", async () => {
    const pc = await controller(false);
    pc.teleport(...POCKET);
    const still = keys([]), walk = keys(["KeyW"]);
    for (let i = 0; i < 3; i++) pc.update(1 / 60, still, false);
    const start = pc.pos.clone();
    let best = 0;
    for (let h = 0; h < 8; h++) {
      pc.teleport(start.x, start.y, start.z);
      pc.camForward.set(...heading(start, h, 8));
      for (let k = 0; k < 120; k++) pc.update(1 / 60, walk, false);
      best = Math.max(best, pc.pos.distanceTo(start));
    }
    expect(best).toBeLessThan(0.2);
  });

  for (const fps of [20, 60]) {
    it(`${fps} fps: walking there, the player is out within 2 s, and the server refuses no packet`, async () => {
      const pc = await controller();
      const world = moveWorld();
      pc.teleport(...POCKET);
      const still = keys([]);
      const dt = 1 / fps;
      for (let i = 0; i < 3; i++) pc.update(dt, still, false);
      const start = pc.pos.clone();
      const a = { lastX: pc.pos.x, lastY: pc.pos.y, lastZ: pc.pos.z, ...motionFields(pc.pos.length(), T0) } as unknown as PlayerActor;
      pc.camForward.set(...heading(start, 0, 8));
      const walk = keys(["KeyW"]);
      const refused: string[] = [];
      let lastSend = -Infinity, outAt = Infinity;
      for (let t = 0; t < 2.5; t += dt) {
        pc.update(dt, walk, false);
        const now = T0 + Math.round((t + dt) * 1000);
        if (outAt === Infinity && pc.pos.distanceTo(start) > 1) outAt = t + dt;
        if (now - lastSend < 50) continue;
        lastSend = now;
        const r = validateMove(a, { x: pc.pos.x, y: pc.pos.y, z: pc.pos.z, anim: pc.anim }, world, { speed: 1, dodge: 1 }, now);
        if (!r.ok) {
          refused.push(`${r.reason} at ${now - T0} ms`);
          pc.correct(a.lastX, a.lastY, a.lastZ);
          continue;
        }
        a.lastX = pc.pos.x;
        a.lastY = pc.pos.y;
        a.lastZ = pc.pos.z;
      }
      expect(refused).toEqual([]);
      expect(outAt).toBeLessThan(2);
    });
  }
});
