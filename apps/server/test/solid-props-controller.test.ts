// The client's real PlayerController against the server's real movement validator (no room), round
// natural solids (D-solid-1). Codex review: the controller resolved the solids at the substep's
// position, which uphill is under the ground (the step runs along the old tangent plane), and only
// then snapped up onto the terrain: below a boulder's base the push saw too little, the snap put the
// feet inside it, and the server refused every packet (Meridian, sprinting uphill at a boulder:
// 113 refusals in 6 s at 20 fps). Several frame rates, packets paced like Net.sendInput (20 Hz).

import { describe, expect, it } from "vitest";
import { BODIES, chunkOf, createTerrain, natureSolids, padDirs, propSolid, solidChunkProps, type BodyId, type Face } from "@firstlight/shared";
import { motionFields, validateMove } from "../src/world/movement.ts";
import type { PlayerActor } from "../src/world/actors.ts";
import { controller, keys, moveWorld, T0, toward, type V3 } from "./controller-helpers.ts";

/**
 * Hold W + Shift at `goal` from `start` for `seconds` at `fps`, re-aiming every frame; every 20 Hz
 * packet goes through validateMove, a refusal corrects the client like Net does. Returns the refusals.
 */
async function sprintAt(body: BodyId, start: V3, goal: V3, fps: number, seconds: number): Promise<string[]> {
  const pc = await controller(body);
  const world = moveWorld(body);
  pc.teleport(...start);
  const still = keys([]);
  const dt = 1 / fps;
  for (let i = 0; i < 6; i++) pc.update(dt, still, false);
  const a = { lastX: pc.pos.x, lastY: pc.pos.y, lastZ: pc.pos.z, ...motionFields(pc.pos.length(), T0) } as unknown as PlayerActor;
  const input = keys(["KeyW", "ShiftLeft"]);
  const refused: string[] = [];
  let lastSend = -Infinity;
  for (let t = 0; t < seconds; t += dt) {
    pc.camForward.set(...toward(pc.pos, goal));
    pc.update(dt, input, false);
    const now = T0 + Math.round((t + dt) * 1000);
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
  return refused;
}

/**
 * The `n` solids of a body (within ~300 m of pad 0) on the steepest ground round them, each with a
 * start 6 m off on its downhill side and one 6 m off across the slope, on dry ground clear of other
 * solids.
 */
function steepSolids(body: BodyId, n: number): { at: V3; starts: V3[]; drop: number }[] {
  const t = createTerrain(body);
  const R = BODIES[body].radius;
  const nature = natureSolids(t);
  const pad = padDirs(BODIES[body])[0]!;
  const seen = new Set<string>();
  const found: { at: V3; starts: V3[]; drop: number }[] = [];
  const onGround = (d: readonly number[]): V3 => {
    const l = Math.hypot(d[0]!, d[1]!, d[2]!);
    const g = R + t.groundHeight(d[0]! / l, d[1]! / l, d[2]! / l);
    return [(d[0]! / l) * g, (d[1]! / l) * g, (d[2]! / l) * g];
  };
  for (let i = 0; i < 400; i++) {
    const a = i * 2.39996, m = Math.sqrt(i / 400) * 300;
    const ref = Math.abs(pad[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const k = ref[0]! * pad[0] + ref[1]! * pad[1] + ref[2]! * pad[2];
    const e = [ref[0]! - k * pad[0], ref[1]! - k * pad[1], ref[2]! - k * pad[2]];
    const el = Math.hypot(e[0]!, e[1]!, e[2]!);
    const f = [pad[1] * e[2]! - pad[2] * e[1]!, pad[2] * e[0]! - pad[0] * e[2]!, pad[0] * e[1]! - pad[1] * e[0]!].map((v) => v / el);
    const d = [0, 1, 2].map((j) => pad[j]! + (((e[j]! / el) * Math.cos(a) + f[j]! * Math.sin(a)) * m) / R);
    const c = chunkOf(d[0]!, d[1]!, d[2]!, BODIES[body].chunksPerFace);
    const key = `${c.face}:${c.cx}:${c.cy}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const p of solidChunkProps(t, c.face as Face, c.cx, c.cy)) {
      const s = propSolid(p.kind, p.scale)!;
      if (s.radius < 0.5) continue;
      const at: V3 = [p.x, p.y, p.z];
      const l = Math.hypot(...at);
      const u = at.map((v) => v / l);
      const r2 = Math.abs(u[2]!) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      const k2 = r2[0]! * u[0]! + r2[1]! * u[1]! + r2[2]! * u[2]!;
      const t1 = [r2[0]! - k2 * u[0]!, r2[1]! - k2 * u[1]!, r2[2]! - k2 * u[2]!];
      const t1l = Math.hypot(t1[0]!, t1[1]!, t1[2]!);
      const t2 = [u[1]! * t1[2]! - u[2]! * t1[1]!, u[2]! * t1[0]! - u[0]! * t1[2]!, u[0]! * t1[1]! - u[1]! * t1[0]!].map((v) => v / t1l);
      const dir = (ang: number, m2: number) => [0, 1, 2].map((j) => at[j]! + ((t1[j]! / t1l) * Math.cos(ang) + t2[j]! * Math.sin(ang)) * m2);
      // The downhill bearing (lowest ground 3 m out).
      let best = 0, low = Infinity;
      for (let b = 0; b < 16; b++) {
        const g = Math.hypot(...onGround(dir((b / 16) * Math.PI * 2, 3)));
        if (g < low) (low = g), (best = (b / 16) * Math.PI * 2);
      }
      const drop = l - low;
      const starts = [best, best + Math.PI / 2].map((ang) => onGround(dir(ang, s.radius + 6)));
      const dry = starts.every((q) => Math.hypot(...q) - R > BODIES[body].waterLevel + 0.3 && nature.isClear({ x: q[0], y: q[1], z: q[2] }));
      if (dry) found.push({ at, starts, drop });
    }
  }
  return found.sort((x, y) => y.drop - x.drop).slice(0, n);
}

describe("the real controller round natural solids, against the server (D-solid-1)", () => {
  for (const body of ["arcadia", "hollowmere", "meridian"] as const) {
    it(`${body}: sprinting at the solids on the steepest ground, uphill and across, at 20 and 60 fps, is never refused`, async () => {
      const list = steepSolids(body, 4);
      expect(list.length).toBe(4);
      expect(list[0]!.drop).toBeGreaterThan(0.8); // real slopes
      for (const s of list) {
        for (const start of s.starts) {
          for (const fps of [20, 60]) expect(await sprintAt(body, start, s.at, fps, 3), `${body} ${fps} fps from ${start.map((v) => v.toFixed(1))}`).toEqual([]);
        }
      }
    }, 60_000);
  }

  // Codex's case: a Meridian boulder on a slope, sprinted at from downhill.
  const BOULDER: V3 = [-375.108756, 834.052651, 446.698029];
  const START: V3 = [-374.01883, 832.236143, 441.237548];
  for (const fps of [20, 30, 60, 144]) {
    it(`${fps} fps: sprinting uphill into a Meridian boulder is never refused`, async () => {
      expect(await sprintAt("meridian", START, BOULDER, fps, 6)).toEqual([]);
    });
  }
});
