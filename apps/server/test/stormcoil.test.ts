// Stormcoil chain lightning (F12 review, Codex S1): the bolt is traced from the caster's head on the
// server, not from the client's camera origin (which may be up to 7 m away), and every jump needs a
// clear line between the two targets: terrain, intact cover and Prism Bubble shells stop it.

import { describe, expect, it } from "vitest";
import { BODIES, padDirs } from "@firstlight/shared";
import { fire, type BreakableHost } from "../src/world/combat.ts";
import type { PlayerActor } from "../src/world/actors.ts";
import type { V3 } from "../src/world/geometry.ts";
import { segmentShellT } from "../src/world/support.ts";
import { fakeWorld, type FakeWorld } from "./npcWorld.ts";

/** Ground point `along` metres from Arcadia's main pad on a fixed tangent, `side` metres across it. */
function pt(w: FakeWorld, along: number, side = 0): V3 {
  const R = BODIES.arcadia.radius;
  const d = padDirs(BODIES.arcadia)[0]!;
  const ref = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const k = ref[0]! * d[0] + ref[1]! * d[1] + ref[2]! * d[2];
  let t = [ref[0]! - k * d[0], ref[1]! - k * d[1], ref[2]! - k * d[2]];
  const tl = Math.hypot(t[0]!, t[1]!, t[2]!);
  t = t.map((v) => v / tl);
  const s = [d[1] * t[2]! - d[2] * t[1]!, d[2] * t[0]! - d[0] * t[2]!, d[0] * t[1]! - d[1] * t[0]!];
  const v = [0, 1, 2].map((i) => d[i]! + (t[i]! * along + s[i]! * side) / R);
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return w.world.snapToGround([(v[0]! / l) * R, (v[1]! / l) * R, (v[2]! / l) * R]);
}

const lift = (p: V3, h: number): V3 => {
  const l = Math.hypot(p[0], p[1], p[2]);
  return [p[0] + (p[0] / l) * h, p[1] + (p[1] / l) * h, p[2] + (p[2] / l) * h];
};
const mid = (a: V3, b: V3): V3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

/** Spherical "cover" props for the test (stand-ins for crates and walls). */
function cover(spheres: { c: V3; r: number }[]): BreakableHost {
  return {
    raycast(o, d, maxT) {
      let best: { index: number; t: number } | null = null;
      spheres.forEach((s, index) => {
        const t = segmentShellT(o, d, maxT, s.c, s.r);
        if (t !== null && (!best || t < best.t)) best = { index, t };
      });
      return best;
    },
    damage() {},
    splash() {},
    arc() {},
  };
}

function caster(w: FakeWorld, at: V3): PlayerActor {
  const p = w.addPlayer("caster", at, 1);
  p.char.hotbar[0] = { id: "stormcoil", tier: 1, qty: 1 };
  p.char.selected = 0;
  return p;
}

/** A cast whose camera ray starts at `o` and points at `aim`. */
function cast(w: FakeWorld, p: PlayerActor, o: V3, aim: V3) {
  p.lastAttackAt = 0;
  p.overheatUntil = 0;
  const d = [aim[0] - o[0], aim[1] - o[1], aim[2] - o[2]];
  const l = Math.hypot(d[0]!, d[1]!, d[2]!);
  return fire(w.world.host, p, { ox: o[0], oy: o[1], oz: o[2], dx: d[0]! / l, dy: d[1]! / l, dz: d[2]! / l });
}

describe("Stormcoil", () => {
  it("is traced from the caster's head: a camera origin around the cover doesn't shoot through it", () => {
    const w = fakeWorld("arcadia");
    const p = caster(w, pt(w, 80));
    const target = w.addPlayer("target", pt(w, 90), 1);
    const head = lift(pt(w, 80), 1.6);
    const chest = lift(pt(w, 90), 1.0);
    // Control: in the open, the bolt lands.
    expect(cast(w, p, head, chest)).toEqual({ ok: true });
    expect(target.state.hp).toBeLessThan(100);
    const hp = target.state.hp;
    // Cover between the head and the target; the client claims a camera 6 m to the side, past it.
    w.world.host.props = cover([{ c: mid(head, chest), r: 0.7 }]);
    const forged = lift(pt(w, 80, 6), 1.6);
    expect(cast(w, p, forged, chest)).toEqual({ ok: true });
    expect(target.state.hp).toBe(hp);
  });

  it("each jump needs a clear line between the two targets", () => {
    const w = fakeWorld("arcadia");
    const p = caster(w, pt(w, 80));
    const first = w.addPlayer("first", pt(w, 90), 1);
    const hidden = w.addPlayer("hidden", pt(w, 90, 4), 1);
    const head = lift(pt(w, 80), 1.6);
    // A wall between the first target and the second (not between the caster and either).
    w.world.host.props = cover([{ c: mid(lift(pt(w, 90), 1.0), lift(pt(w, 90, 4), 1.0)), r: 0.8 }]);
    cast(w, p, head, lift(pt(w, 90), 1.0));
    expect(first.state.hp).toBeLessThan(100);
    expect(hidden.state.hp).toBe(100);
    // Without the wall the bolt jumps (×0.7).
    w.world.host.props = undefined;
    cast(w, p, head, lift(pt(w, 90), 1.0));
    expect(hidden.state.hp).toBeLessThan(100);
  });

  it("the shot broadcast starts at the head", () => {
    const w = fakeWorld("arcadia");
    const p = caster(w, pt(w, 80));
    w.addPlayer("target", pt(w, 90), 1);
    const head = lift(pt(w, 80), 1.6);
    cast(w, p, lift(pt(w, 76), 3), lift(pt(w, 90), 1.0));
    const shot = w.sent.find((m) => m.type === "shot")!.msg as { ox: number; oy: number; oz: number };
    expect(Math.hypot(shot.ox - head[0], shot.oy - head[1], shot.oz - head[2])).toBeLessThan(0.01);
  });
});
