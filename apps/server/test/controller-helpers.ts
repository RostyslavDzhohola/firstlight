// The client's real PlayerController (apps/client) and the server's real movement world, for tests
// that walk the one against the other's validator (solid-props-controller, wild-site-climb).

import { BODIES, createTerrain, natureSolids, type BodyId } from "@firstlight/shared";
import { structureCollider } from "@firstlight/shared/planet/sites";
import type { MoveWorld } from "../src/world/movement.ts";

export type V3 = [number, number, number];
export const T0 = 1_000_000;

export interface Vec {
  x: number;
  y: number;
  z: number;
  length(): number;
  set(x: number, y: number, z: number): Vec;
}
export interface Controller {
  pos: Vec;
  camForward: Vec;
  anim: number;
  onGround: boolean;
  update(dt: number, input: unknown, aiming: boolean): void;
  teleport(x: number, y: number, z: number): void;
  correct(x: number, y: number, z: number): void;
  setNature(c: unknown): void;
  setStructures(c: unknown): void;
}

/** The client's PlayerController (apps/client), loaded at runtime so the server typecheck stays server-only. */
export async function controller(body: BodyId): Promise<Controller> {
  const url = new URL("../../client/src/game/PlayerController.ts", import.meta.url).href;
  const { PlayerController } = (await import(/* @vite-ignore */ url)) as { PlayerController: new (t: unknown, water: number) => Controller };
  const terrain = createTerrain(body);
  const pc = new PlayerController(terrain, BODIES[body].waterLevel);
  const nature = natureSolids(terrain);
  // As Game.enterBody wires them.
  pc.setNature({ resolve: (p: Vec, out: never) => nature.resolve(p, out), raycast: () => Infinity });
  const walls = structureCollider(terrain);
  pc.setStructures({ resolve: (p: Vec, out: never) => walls.resolve(p, out), raycast: () => Infinity });
  return pc;
}

/** The server's MoveWorld as BodyRoom builds it (no breakables here). */
export function moveWorld(body: BodyId): MoveWorld {
  const terrain = createTerrain(body);
  const nature = natureSolids(terrain);
  const walls = structureCollider(terrain);
  const f = { top: 0, inside: false };
  return {
    radius: BODIES[body].radius,
    waterLevel: BODIES[body].waterLevel,
    groundAt: (x, y, z) => terrain.groundHeightAt(x, y, z),
    footing: (x, y, z, step) => {
      const a = walls.footing(x, y, z, step), b = nature.footing(x, y, z, step);
      f.top = Math.max(a.top, b.top);
      f.inside = a.inside || b.inside;
      return f;
    },
    crosses: (ax, ay, az, bx, by, bz) => walls.crosses(ax, ay, az, bx, by, bz) || nature.crosses(ax, ay, az, bx, by, bz),
  };
}

export function keys(down: string[]) {
  const held = new Set(down);
  return { locked: true, mouseDX: 0, mouseDY: 0, wheel: 0, sensitivity: 0.002, invertY: false, pressed: new Set<string>(), keys: held, down: (k: string) => held.has(k) };
}

/** Tangent (at `p`) toward `q`. */
export function toward(p: Vec, q: V3): V3 {
  const l = p.length();
  const u = [p.x / l, p.y / l, p.z / l];
  const d = [q[0] - p.x, q[1] - p.y, q[2] - p.z];
  const k = d[0]! * u[0]! + d[1]! * u[1]! + d[2]! * u[2]!;
  const t = [d[0]! - k * u[0]!, d[1]! - k * u[1]!, d[2]! - k * u[2]!];
  const tl = Math.hypot(t[0]!, t[1]!, t[2]!) || 1;
  return [t[0]! / tl, t[1]! / tl, t[2]! / tl];
}
