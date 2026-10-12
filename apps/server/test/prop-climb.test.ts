// Prop tops (F12 confirmation Opus should-fix 1): a step that lands on a prop top from below must fit
// a jump. One packet onto a 2.6 m camp wall or a 4.2 m pillar was accepted because the top counts as
// ground. Walking along a top, stepping onto a slightly higher one and jumping onto a crate stay legal.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BODIES, createTerrain, isSafe, type Breakable, type BodyId } from "@firstlight/shared";
import type { PlayerActor } from "../src/world/actors.ts";
import { DestructionSystem } from "../src/world/destruction.ts";
import type { V3 } from "../src/world/geometry.ts";
import { groundMotion, MOVE, motionFields, moveLimits, validateMove, type MoveWorld } from "../src/world/movement.ts";
import { startServer, safeLeave } from "./helpers.ts";
import * as Q from "./quest-helpers.ts";

// ------------------------------------------------------------------------------------ unit: the rule

/** A flat test world (radius 1000, ground 0, no water) with box props centred on the +z pole's tangent plane. */
const RW = 1000;
interface Box {
  cx: number;
  hx: number;
  hz: number;
  h: number;
}
function boxWorld(...boxes: Box[]): MoveWorld {
  const out = { top: 0, inside: false };
  return {
    radius: RW,
    waterLevel: -100,
    groundAt: () => 0,
    footing(x, y, z, step) {
      const l = Math.hypot(x, y, z);
      const px = (x / l) * RW, py = (y / l) * RW, feet = l - RW;
      out.top = 0;
      out.inside = false;
      for (const b of boxes) {
        const off = Math.max(Math.abs(px - b.cx) - b.hx, Math.abs(py) - b.hz);
        // Standable within half the body radius past the edge (the client's landing rule), feet within `step` below the top.
        if (off <= 0.19 && feet >= b.h - step) out.top = Math.max(out.top, RW + b.h);
        if (off < -0.1 && feet < b.h - step && feet > -1.8) out.inside = true;
      }
      return out;
    },
    crosses: () => false, // a radial step at the edge never crosses the footprint (the review's probe)
  };
}
/** Planet point at tangent-plane (x, y) and height h above the flat ground. */
function at(x: number, y: number, h: number) {
  const l = Math.hypot(x, y, RW);
  return { x: (x / l) * (RW + h), y: (y / l) * (RW + h), z: (RW / l) * (RW + h) };
}

/** A body standing at (x, y, h) since `idleMs` ago, stepping every 50 ms (accepted steps move it). */
function walker(w: MoveWorld, x: number, y: number, h: number, idleMs = 0) {
  let now = 1_000_000;
  const p = at(x, y, h);
  const a = { ...motionFields(Math.hypot(p.x, p.y, p.z), now - idleMs), lastX: p.x, lastY: p.y, lastZ: p.z, state: { ...p }, mounted: false, mountGraceUntil: 0 } as unknown as PlayerActor;
  a.lastBudgetAt = now;
  return {
    a,
    step(x2: number, y2: number, h2: number, anim = 1, dtMs = 50) {
      now += dtMs;
      const q = at(x2, y2, h2);
      const r = validateMove(a, { ...q, anim }, w, moveLimits(a, now), now);
      if (r.ok) {
        a.lastX = a.state.x = q.x;
        a.lastY = a.state.y = q.y;
        a.lastZ = a.state.z = q.z;
      }
      return r;
    },
  };
}

describe("prop tops can't be climbed in one packet (F12 confirmation Opus SF1)", () => {
  // A 2.6 m camp wall (2 × 0.3 m half extents) and a 4.2 m pillar.
  for (const h of [2.6, 4.2]) {
    it(`a step from the ground onto a ${h} m top's edge is refused (height)`, () => {
      const w = boxWorld({ cx: 10, hx: 0.3, hz: 2, h });
      const m = walker(w, 10 - 0.3 - 0.63, 0, 0);
      m.step(10 - 0.3 - 0.45, 0, 0); // standing at the wall
      expect(m.step(10 - 0.3 - 0.1, 0, h + 0.01)).toEqual({ ok: false, reason: "height" });
    });
  }

  it("…and so is getting there in two packets: up the side inside the envelope, then onto the top", () => {
    const w = boxWorld({ cx: 10, hx: 0.3, hz: 2, h: 2.6 });
    const m = walker(w, 10 - 0.3 - 0.45, 0, 0);
    expect(m.step(10 - 0.3 - 0.1, 0, 1.6).ok).toBe(true); // a jump's height, beside the wall
    expect(m.step(10 - 0.3 - 0.1, 0, 2.61)).toEqual({ ok: false, reason: "height" });
  });

  it("a real jump onto a 1 m crate lands (6.6 m/s up, 3 m/s across, client physics at 20 Hz)", () => {
    const w = boxWorld({ cx: 10, hx: 0.5, hz: 0.5, h: 1.0 });
    const run = 1.6;
    const m = walker(w, 10 - run, 0, 0);
    let x = 10 - run, h = 0, v = 6.6, landed = false;
    for (let i = 0; i < 30 && !landed; i++) {
      v -= MOVE.gravity * 0.05;
      x = Math.min(10, x + 3 * 0.05);
      h += v * 0.05;
      if (v < 0 && Math.abs(x - 10) <= 0.5 + 0.19 && h <= 1.0) {
        h = 1.0;
        landed = true;
      } else if (h < 0) h = 0;
      expect(m.step(x, 0, h, landed ? 0 : 4).ok, `packet ${i}`).toBe(true);
    }
    expect(landed).toBe(true);
    expect(m.step(x, 0, 1.0, 0)).toMatchObject({ ok: true, grounded: true });
  });

  it("walking along a wall top after standing still on it for 5 s is accepted", () => {
    const w = boxWorld({ cx: 10, hx: 2, hz: 0.3, h: 2.6 });
    const m = walker(w, 8.2, 0, 2.6, 5000);
    for (let x = 8.4; x <= 11.8; x += 0.2) expect(m.step(x, 0, 2.6).ok, `x ${x}`).toBe(true);
  });

  it("stepping from one crate top onto a slightly higher one after standing still is accepted", () => {
    const w = boxWorld({ cx: 10, hx: 0.5, hz: 0.5, h: 1.0 }, { cx: 11.05, hx: 0.5, hz: 0.5, h: 1.3 });
    const m = walker(w, 9.8, 0, 1.0, 5000);
    for (let x = 10.0; x <= 11.2; x += 0.2) {
      const onSecond = Math.abs(x - 11.05) <= 0.5 + 0.19;
      expect(m.step(x, 0, onSecond ? 1.3 : 1.0).ok, `x ${x}`).toBe(true);
    }
  });
});

// ------------------------------------------------------------------------------------ integration: real props

describe("on real camp walls and pillars (the review's probe)", () => {
  beforeAll(async () => {
    Q.harness.game = await startServer();
  });
  afterAll(async () => {
    for (const r of Q.harness.rooms.splice(0)) await safeLeave(r);
    await Q.harness.game!.close();
  });
  const norm = (v: readonly number[]): V3 => {
    const l = Math.hypot(v[0]!, v[1]!, v[2]!);
    return [v[0]! / l, v[1]! / l, v[2]! / l];
  };
  /** Planet point at prop-local (lx, ly, lz). */
  const local = (b: Breakable, lx: number, ly: number, lz: number): V3 => [b.px + b.rx * lx + b.ux * ly + b.fx * lz, b.py + b.ry * lx + b.uy * ly + b.fy * lz, b.pz + b.rz * lx + b.uz * ly + b.fz * lz];
  /** Prop-local forward coordinate of a planet point. */
  const localZ = (b: Breakable, p: { x: number; y: number; z: number }) => (p.x - b.px) * b.fx + (p.y - b.py) * b.fy + (p.z - b.pz) * b.fz;

  async function setup(body: BodyId, kind: "campwall" | "pillar", name: string) {
    const def = BODIES[body];
    const terrain = createTerrain(def);
    const gp = (v: readonly number[]): V3 => {
      const d = norm(v);
      const r = def.radius + terrain.groundHeight(d[0], d[1], d[2]) + 0.02;
      return [d[0] * r, d[1] * r, d[2] * r];
    };
    const b = await Q.bot(name, body, "admin");
    const sys = Q.serverRoom(b).systems.find((x) => x instanceof DestructionSystem) as DestructionSystem;
    const dry = (p: V3) => !isSafe(def, ...p) && terrain.groundHeight(...norm(p)) > def.waterLevel + 0.5;
    const off = (w: Breakable) => w.hz + 0.38 + 0.25;
    const wall = sys.list.find((w) => w.kind === kind && !sys.isBroken(w.index) && dry(gp(local(w, 0, 0, -off(w)))) && dry(gp(local(w, 0, 0, off(w)))) && !sys.footing(...gp(local(w, 0, 0, -off(w))), MOVE.groundedAbove).inside);
    if (!wall) throw new Error(`no free ${kind} on ${body}`);
    const aboveGround = (p: { x: number; y: number; z: number }) => Math.hypot(p.x, p.y, p.z) - Math.hypot(...gp([p.x, p.y, p.z]));
    return { b, sys, wall, gp, off, aboveGround };
  }

  for (const [body, kind] of [["arcadia", "campwall"], ["hollowmere", "pillar"]] as const) {
    it(`${body}: one packet onto a ${kind}'s top is corrected, and walking over it ends on the near side`, async () => {
      const { b, wall, gp, off, aboveGround } = await setup(body, kind, `climber_${body}`);
      await Q.tpAndWait(b, gp(local(wall, 0, 0, -off(wall))));
      await Q.sleep(400);
      let corrections = 0;
      b.room.onMessage("correct", () => corrections++);
      let seq = (Q.me(b).seq ?? 0) + 100;
      const send = (p: readonly number[]) => b.send("input", { seq: ++seq, x: p[0], y: p[1], z: p[2], fx: wall.fx, fy: wall.fy, fz: wall.fz, anim: 1, t: Date.now() });
      // Straight up onto the top's near edge: the centre 0.1 m outside the footprint, the feet on the top.
      send(local(wall, 0, wall.h + 0.01, -(wall.hz + 0.1)));
      await Q.sleep(200);
      expect(corrections).toBeGreaterThan(0);
      expect(aboveGround(Q.me(b))).toBeLessThan(1.5);
      // Across the top and down the far side.
      for (let i = 1; i <= 4; i++) {
        send(local(wall, 0, wall.h + 0.01, -(wall.hz + 0.1) + (i / 4) * (2 * wall.hz + 0.2)));
        await Q.sleep(60);
      }
      send(gp(local(wall, 0, 0, off(wall))));
      await Q.sleep(400);
      expect(localZ(wall, Q.me(b))).toBeLessThan(0);
    });
  }

  it("arcadia: a player standing on a camp wall's top walks along it after idling (no corrections)", async () => {
    const { b, wall, aboveGround } = await setup("arcadia", "campwall", "wallwalker");
    const a = Q.serverRoom(b).actors.get(b.id)!;
    // Put on the top (as a rejoin or a legal climb would), then idle there for a second.
    const start = local(wall, -1.6, wall.h + 0.01, 0);
    const len = Math.hypot(...start);
    a.state.x = a.lastX = start[0];
    a.state.y = a.lastY = start[1];
    a.state.z = a.lastZ = start[2];
    groundMotion(a, len, Date.now());
    a.airborne = false;
    a.peakRadius = len;
    await Q.sleep(1000);
    expect(aboveGround(a.state)).toBeGreaterThan(2);
    let corrections = 0;
    b.room.onMessage("correct", () => corrections++);
    let seq = (Q.me(b).seq ?? 0) + 100;
    for (let x = -1.4; x <= 1.6; x += 0.2) {
      const p = local(wall, x, wall.h + 0.01, 0);
      b.send("input", { seq: ++seq, x: p[0], y: p[1], z: p[2], fx: wall.rx, fy: wall.ry, fz: wall.rz, anim: 1, t: Date.now() });
      await Q.sleep(50);
    }
    await Q.sleep(150);
    expect(corrections).toBe(0);
    expect(aboveGround(a.state)).toBeGreaterThan(2);
  });
});
