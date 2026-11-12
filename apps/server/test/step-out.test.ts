// The client's step-out (#34) against the server's real movement validator (no room): feet pinned
// between the Hall of Firsts' column and its low plinth (each pushes them into the other, so every
// walking step is undone) step out to a clear spot, and the server takes that step like any other.
// The training pen's corner by the archery target is a dead end, not a pocket: no step-out there.

import { describe, expect, it } from "vitest";
import { BODIES, createTerrain, natureSolids } from "@firstlight/shared";
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
  setNature(c: unknown): void;
}

/** The client's PlayerController with the town and the natural solids wired as Game wires them (loaded at runtime: the server typecheck stays server-only). */
async function controller(withStepOut = true): Promise<Controller> {
  const base = new URL("../../client/src/game/", import.meta.url).href;
  const { PlayerController } = (await import(/* @vite-ignore */ `${base}PlayerController.ts`)) as { PlayerController: new (t: unknown, water: number) => Controller };
  const { bothSolids, stepOut } = (await import(/* @vite-ignore */ `${base}stepOut.ts`)) as { bothSolids: (a: unknown, b: unknown) => unknown; stepOut: (s: unknown, g: unknown, p: Vec) => boolean };
  const terrain = createTerrain("portus");
  const pc = new PlayerController(terrain, BODIES.portus.waterLevel);
  const walls = structureCollider(terrain);
  const groundR = (x: number, y: number, z: number) => terrain.body.radius + terrain.groundHeight(x, y, z);
  // As Game.enterBody wires them: the step-out sees the structures and the natural solids together.
  pc.setStructures({ resolve: (p: Vec, out: never) => walls.resolve(p, out), raycast: () => Infinity });
  const nature = natureSolids(terrain);
  const both = bothSolids(walls, nature);
  pc.setNature({ resolve: (p: Vec, out: never) => nature.resolve(p, out), raycast: () => Infinity, stepOut: withStepOut ? (p: Vec) => stepOut(both, groundR, p) : undefined });
  return pc;
}

/** The server's MoveWorld as BodyRoom builds it: structures and natural solids together (Portus has no breakables). */
function moveWorld(): MoveWorld {
  const terrain = createTerrain("portus");
  const walls = structureCollider(terrain);
  const nature = natureSolids(terrain);
  const f = { top: 0, inside: false };
  return {
    radius: BODIES.portus.radius,
    waterLevel: BODIES.portus.waterLevel,
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

describe("the training pen's corner by the archery target (Portus, town 12.62 E −9.32 N)", () => {
  /** Where this run's play-through wedged against the pen's fences and the target's south-east corner. */
  async function penSpot(): Promise<readonly [number, number, number]> {
    const { townDir } = await import("@firstlight/shared/planet/town");
    const tr = createTerrain("portus");
    const R = BODIES.portus.radius;
    const d = townDir(12.62, -9.32, R);
    const g = R + tr.groundHeight(d[0], d[1], d[2]);
    return [d[0] * g, d[1] * g, d[2] * g];
  }

  it("is a dead end, not a pocket: from wherever a walk into it stops, some walk gets 5 m out (20 fps)", async () => {
    const P = await penSpot();
    const pc = await controller(false);
    const still = keys([]), walk = keys(["KeyW"]);
    const fps = 20;
    const walkFrom = (x: number, y: number, z: number, h: number) => {
      pc.teleport(x, y, z);
      for (let i = 0; i < 2; i++) pc.update(1 / fps, still, false);
      const s0 = pc.pos.clone();
      pc.camForward.set(...heading(s0, h, 16));
      for (let k = 0; k < 1.5 * fps; k++) pc.update(1 / fps, walk, false);
      return { end: pc.pos.clone(), moved: pc.pos.distanceTo(s0) };
    };
    let stuckHeadings = 0;
    for (let h = 0; h < 16; h++) {
      const { end, moved } = walkFrom(...P, h);
      if (moved < 0.25) stuckHeadings++;
      let best = 0;
      for (let h2 = 0; h2 < 16 && best < 5; h2++) best = Math.max(best, walkFrom(end.x, end.y, end.z, h2).moved);
      expect(best, `heading ${h}/16 stopped ${moved.toFixed(2)} m in`).toBeGreaterThan(5);
    }
    expect(stuckHeadings).toBeGreaterThan(0); // the corner is real: walking into it stops
  }, 90_000);

  it("pressing into the corner for 2 s at 60 fps, the step-out leaves the player where walking put them", async () => {
    const P = await penSpot();
    const pc = await controller(true);
    pc.teleport(...P);
    const still = keys([]), walk = keys(["KeyW"]);
    for (let i = 0; i < 3; i++) pc.update(1 / 60, still, false);
    pc.camForward.set(...heading(pc.pos.clone(), 0, 16));
    let jump = 0;
    let last = pc.pos.clone();
    for (let k = 0; k < 120; k++) {
      pc.update(1 / 60, walk, false);
      jump = Math.max(jump, pc.pos.distanceTo(last));
      last = pc.pos.clone();
    }
    expect(jump).toBeLessThan(0.2);
  }, 60_000);
});
