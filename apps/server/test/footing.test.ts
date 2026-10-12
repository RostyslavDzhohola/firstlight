// Seam 1: the server's movement footing agrees with the client's player-vs-prop collision on
// compound props (F12 re-review S6): statue bases and robe ledges, Meridian's plinth and bust,
// pillar caps, coral and Nave cover, including footprint edges. Both sides use the shared
// planet/collide.ts; this checks the server's wiring (intact props, step, inside test) against it.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matchMaker } from "@colyseus/core";
import type { Room } from "@colyseus/sdk";
import type { Breakable, BodyId } from "@firstlight/shared";
import { emptyContact, PLAYER_BODY } from "@firstlight/shared/planet/collide";
import type { Game } from "../src/app.ts";
import type { BodyRoom } from "../src/world/BodyRoom.ts";
import { DestructionSystem } from "../src/world/destruction.ts";
import { MOVE } from "../src/world/movement.ts";
import { joinAs, safeLeave, startServer, waitFor } from "./helpers.ts";

let game: Game;
const rooms: Room[] = [];
beforeEach(async () => {
  game = await startServer();
});
afterEach(async () => {
  for (const r of rooms.splice(0)) await safeLeave(r);
  await game.close();
});

async function destruction(body: BodyId): Promise<DestructionSystem> {
  const r = await joinAs(game, `foot_${body}`, body, {}, "admin");
  rooms.push(r);
  await waitFor(() => !!(r.state as any).players?.get(r.sessionId));
  const room = matchMaker.getLocalRoomById(r.roomId) as unknown as BodyRoom;
  return room.systems.find((s) => s instanceof DestructionSystem) as DestructionSystem;
}

interface Solid {
  shape: 0 | 1;
  hx: number;
  hz: number;
  y0: number;
  y1: number;
}
const solids = (b: Breakable): Solid[] => [{ shape: b.shape, hx: b.hx, hz: b.hz, y0: 0, y1: b.h }, ...(b.parts ?? [])];

/** Planet-space point at local (lx, ly, lz) of a prop. */
function at(b: Breakable, lx: number, ly: number, lz: number) {
  return { x: b.px + b.rx * lx + b.ux * ly + b.fx * lz, y: b.py + b.ry * lx + b.uy * ly + b.fy * lz, z: b.pz + b.rz * lx + b.uz * ly + b.fz * lz };
}

/** Sample points on and around every solid's top: centre, inner edge, edge slack, just outside; on, in the step band, below it. */
function samples(b: Breakable) {
  const out: { x: number; y: number; z: number; where: string }[] = [];
  for (const [si, s] of solids(b).entries()) {
    for (const off of [0, 0.9, 1, 1.15, 1.3]) {
      for (const dir of [[1, 0], [0, 1], [Math.SQRT1_2, Math.SQRT1_2]] as const) {
        const reach = s.shape === 0 ? (dir[0] && dir[1] ? Math.min(s.hx, s.hz) : dir[0] ? s.hx : s.hz) : s.hx;
        const lx = dir[0] * reach * off, lz = dir[1] * reach * off;
        for (const dy of [0.02, -0.2, -0.6]) out.push({ ...at(b, lx, s.y1 + dy, lz), where: `${b.kind}#${b.index} solid ${si} off ${off} dy ${dy}` });
      }
    }
  }
  return out;
}

describe("server footing agrees with the client collider on compound props (F12 re-review S6)", () => {
  for (const body of ["hollowmere", "meridian", "arcadia"] as const) {
    it(`${body}: statues, pillars and cover`, async () => {
      const sys = await destruction(body);
      const compound = sys.list.filter((b) => (b.parts?.length ?? 0) > 0);
      expect(compound.length).toBeGreaterThan(0);
      const solid = (i: number) => !sys.isBroken(i);
      let compared = 0, supported = 0, inside = 0;
      for (const b of compound.slice(0, 12)) {
        for (const p of samples(b)) {
          // The client: resolve the feet against the props (sideways pushes, floor under them).
          const c = emptyContact();
          const q = { x: p.x, y: p.y, z: p.z };
          sys.collider.resolve(q, solid, c, PLAYER_BODY);
          const pushed = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
          // The server: the same feet.
          const f = { ...sys.footing(p.x, p.y, p.z, MOVE.groundedAbove) };
          if (!c.pushed) {
            // Standing (or not) on a top: the same top.
            expect(f.top, p.where).toBeCloseTo(c.floor, 6);
            expect(f.inside, p.where).toBe(false);
            compared++;
            if (c.floor > 0) supported++;
          } else if (pushed >= PLAYER_BODY.radius + 0.1 + 1e-6 && !f.inside) {
            // A deep push from one solid is "inside" for the server too (several shallow pushes may add up).
            const single = solids(b).some((s) => {
              const l = [p.x - b.px, p.y - b.py, p.z - b.pz];
              const lx = l[0]! * b.rx + l[1]! * b.ry + l[2]! * b.rz, ly = l[0]! * b.ux + l[1]! * b.uy + l[2]! * b.uz, lz = l[0]! * b.fx + l[1]! * b.fy + l[2]! * b.fz;
              if (ly >= s.y1 - PLAYER_BODY.step || ly + PLAYER_BODY.height <= s.y0) return false;
              const depth = s.shape === 0 ? Math.min(s.hx - Math.abs(lx), s.hz - Math.abs(lz)) : s.hx - Math.hypot(lx, lz);
              return depth >= 0.1 + 1e-6;
            });
            expect(single, p.where).toBe(false);
          }
          if (f.inside) {
            expect(pushed, p.where).toBeGreaterThanOrEqual(PLAYER_BODY.radius + 0.1 - 1e-6);
            inside++;
          }
        }
      }
      expect(compared).toBeGreaterThan(50);
      expect(supported).toBeGreaterThan(10);
      expect(inside).toBeGreaterThan(5);
    });
  }

  it("a broken compound prop holds nobody and contains nobody", async () => {
    const sys = await destruction("hollowmere");
    const b = sys.list.find((x) => x.kind === "pillar")!;
    const onCap = at(b, 0, b.h + 0.02, 0);
    const inShaft = at(b, 0, 1.0, 0);
    expect(sys.footing(onCap.x, onCap.y, onCap.z, MOVE.groundedAbove).top).toBeGreaterThan(0);
    expect(sys.footing(inShaft.x, inShaft.y, inShaft.z, MOVE.groundedAbove).inside).toBe(true);
    expect(sys.contains(b.index, [inShaft.x, inShaft.y, inShaft.z])).toBe(true);
    sys.damage(b.index, 1e6, "heavy", "comet", [0, 0, 1]);
    expect(sys.footing(onCap.x, onCap.y, onCap.z, MOVE.groundedAbove).top).toBe(0);
    expect(sys.footing(inShaft.x, inShaft.y, inShaft.z, MOVE.groundedAbove).inside).toBe(false);
    expect(sys.contains(b.index, [inShaft.x, inShaft.y, inShaft.z])).toBe(false);
  });

  it("the statue's square base counts for shots too: a point in the base corner is inside", async () => {
    const sys = await destruction("hollowmere");
    const b = sys.list.find((x) => x.kind === "statue")!;
    const base = b.parts![0]!; // the square base (outside the figure's cylinders at the corner)
    const corner = at(b, base.hx * 0.95, (base.y0 + base.y1) / 2, base.hz * 0.95);
    expect(sys.contains(b.index, [corner.x, corner.y, corner.z])).toBe(true);
  });
});
