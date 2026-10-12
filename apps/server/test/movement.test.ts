// Seam 1: server movement validation (review F12 B1 flight, S3 swimming, uncharged tolerance).
// Bots send positions like the real client (PlayerController physics: gravity 18, jump 6.6 m/s).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Room } from "@colyseus/sdk";
import { BODIES, createTerrain, padDirs } from "@firstlight/shared";
import type { Game } from "../src/app.ts";
import { matchMaker } from "@colyseus/core";
import type { BodyRoom } from "../src/world/BodyRoom.ts";
import { dealDamage } from "../src/world/combat.ts";
import { DestructionSystem } from "../src/world/destruction.ts";
import { MOVE, motionFields, moveLimits, validateMove, type MoveWorld } from "../src/world/movement.ts";
import type { PlayerActor } from "../src/world/actors.ts";
import { HORSE } from "@firstlight/shared/content/horse";
import { ANIM } from "@firstlight/shared/net/schema";
import { isSafe, type Breakable } from "@firstlight/shared";
import { emptyContact, PLAYER_BODY } from "@firstlight/shared/planet/collide";
import { SWIM_DEPTH } from "@firstlight/shared/planet/water";
import type { BodyId } from "@firstlight/shared";
import { joinAs, safeLeave, startServer, waitFor } from "./helpers.ts";
import { characterRepo } from "../src/world/characters.ts";
import { newCharacter } from "@firstlight/shared/content/character";

let game: Game;
const rooms: Room[] = [];

beforeEach(async () => {
  game = await startServer();
});
afterEach(async () => {
  for (const r of rooms.splice(0)) await safeLeave(r);
  await game.close();
});

const BODY = BODIES.arcadia;
const R = BODY.radius;
const terrain = createTerrain(BODY);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const st = (r: Room) => r.state as any;
const me = (r: Room) => st(r).players.get(r.sessionId);

type V3 = [number, number, number];
const norm = (v: readonly number[]): V3 => {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [v[0]! / l, v[1]! / l, v[2]! / l];
};
const groundR = (d: readonly number[]) => R + terrain.groundHeight(d[0]!, d[1]!, d[2]!);
const aboveGround = (p: { x: number; y: number; z: number }) => Math.hypot(p.x, p.y, p.z) - groundR(norm([p.x, p.y, p.z]));

/** A tangent at `up` (stable). */
function tangent(up: V3): V3 {
  const ref = Math.abs(up[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const k = ref[0]! * up[0] + ref[1]! * up[1] + ref[2]! * up[2];
  return norm([ref[0]! - k * up[0], ref[1]! - k * up[1], ref[2]! - k * up[2]]);
}

/** Direction `metres` from `from` along `t` (great-circle step). */
function walk(from: V3, t: V3, metres: number): V3 {
  return norm([from[0] + (t[0] * metres) / R, from[1] + (t[1] * metres) / R, from[2] + (t[2] * metres) / R]);
}

/** Join as an admin, step off the pad's safe ring and settle on the ground. Returns the start direction and tangent. */
async function joinOutside(name: string, at?: V3): Promise<{ r: Room; dir: V3; t: V3; seq: { n: number }; corrections: { n: number } }> {
  const r = await joinAs(game, name, "arcadia", {}, "admin");
  rooms.push(r);
  await waitFor(() => !!me(r));
  const pad = padDirs(BODY)[0]!;
  const t0 = tangent(pad as V3);
  const dir = at ?? walk(pad as V3, t0, 40);
  const h = Math.max(groundR(dir), R + BODY.waterLevel - 1.03); // swimmers float
  const p = [dir[0] * h, dir[1] * h, dir[2] * h];
  r.send("admin", { cmd: "teleport", args: { x: p[0], y: p[1], z: p[2] } });
  const corrections = { n: 0 };
  await waitFor(() => Math.hypot(me(r).x - p[0]!, me(r).y - p[1]!, me(r).z - p[2]!) < 1.5);
  r.onMessage("correct", () => corrections.n++);
  await sleep(100);
  corrections.n = 0;
  return { r, dir: norm([me(r).x, me(r).y, me(r).z]), t: tangent(norm([me(r).x, me(r).y, me(r).z])), seq: { n: 10 }, corrections };
}

function send(r: Room, seq: { n: number }, dir: V3, radius: number, anim = 1, face: V3 = [0, 0, 1]) {
  r.send("input", { seq: ++seq.n, x: dir[0] * radius, y: dir[1] * radius, z: dir[2] * radius, fx: face[0], fy: face[1], fz: face[2], anim, t: Date.now() });
}

describe("no flying (F12 B1)", () => {
  it("climbing a few centimetres per packet is refused: the server keeps the player near the ground", async () => {
    const { r, dir, seq, corrections } = await joinOutside("climber");
    const base = groundR(dir);
    for (let i = 1; i <= 100; i++) {
      send(r, seq, dir, base + i * 0.04, 4);
      await sleep(50);
    }
    await sleep(200);
    expect(corrections.n).toBeGreaterThan(0);
    expect(aboveGround(me(r))).toBeLessThan(2);
  });

  it("hovering at jump height doesn't last: the body comes down", async () => {
    const { r, dir, seq, corrections } = await joinOutside("hoverer");
    const base = groundR(dir);
    for (let i = 0; i < 50; i++) {
      send(r, seq, dir, base + 1.0, 4);
      await sleep(50);
    }
    await sleep(200);
    expect(corrections.n).toBeGreaterThan(0);
    expect(aboveGround(me(r))).toBeLessThan(0.5);
  });

  it("going quiet in mid-air doesn't leave the body hanging there", async () => {
    const { r, dir, seq } = await joinOutside("statue");
    const base = groundR(dir);
    send(r, seq, dir, base + 1.1, 4); // the top of a jump, then silence
    await sleep(1500);
    expect(aboveGround(me(r))).toBeLessThan(0.5);
  });

  it("real jumps (also back to back, while running) are never corrected", async () => {
    const { r, dir, t, seq, corrections } = await joinOutside("jumper");
    let d = dir;
    for (let hop = 0; hop < 4; hop++) {
      let h = 0, v = 6.6, time = 0;
      do {
        time += 0.05;
        v -= 18 * 0.05;
        h = Math.max(0, h + v * 0.05);
        d = walk(d, t, 6 * 0.05);
        send(r, seq, d, groundR(d) + h, h > 0 ? 4 : 1);
        await sleep(50);
      } while (h > 0 && time < 2);
    }
    await sleep(150);
    expect(corrections.n).toBe(0);
  });
});

describe("no shortcuts through the planet (F12 final Opus N-B1)", () => {
  it("a step to the centre and back out to a far point is corrected: the body stays where it was", async () => {
    const r = await joinAs(game, "diver", "arcadia", {});
    rooms.push(r);
    await waitFor(() => !!me(r));
    let corrections = 0;
    r.onMessage("correct", () => corrections++);
    await sleep(300);
    const start = [me(r).x, me(r).y, me(r).z];
    const sd = norm(start);
    // A dry target more than 300 m away.
    let target: V3 | null = null;
    for (const cand of [[1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1], [0, -1, 0], [0.6, 0.2, 0.77]]) {
      const d = norm(cand);
      if (terrain.groundHeight(d[0], d[1], d[2]) > BODY.waterLevel + 0.5 && Math.hypot(d[0] - sd[0], d[1] - sd[1], d[2] - sd[2]) * R > 300) {
        target = d;
        break;
      }
    }
    const tr = groundR(target!) + 0.02;
    r.send("input", { seq: 101, x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 1, anim: 1, t: Date.now() });
    await sleep(60);
    r.send("input", { seq: 102, x: target![0] * tr, y: target![1] * tr, z: target![2] * tr, fx: 0, fy: 0, fz: 1, anim: 1, t: Date.now() });
    await sleep(300);
    const end = [me(r).x, me(r).y, me(r).z];
    expect(corrections).toBeGreaterThan(0);
    expect(end.every(Number.isFinite)).toBe(true);
    expect(Math.hypot(end[0]! - start[0]!, end[1]! - start[1]!, end[2]! - start[2]!)).toBeLessThan(5);
  });

  it("a step deep below the surface is refused however short its ground distance", () => {
    const len = R + terrain.groundHeight(0, 1, 0);
    const a = { lastX: 0, lastY: len, lastZ: 0, ...motionFields(len, 0) } as unknown as PlayerActor;
    const w: MoveWorld = { radius: R, waterLevel: BODY.waterLevel, groundAt: (x, y, z) => terrain.groundHeightAt(x, y, z) };
    for (const m of [{ x: 0, y: 0, z: 0 }, { x: 0, y: R * 0.3, z: 0 }, { x: 0, y: len - 6, z: 0 }]) {
      const r = validateMove({ ...a }, { ...m, anim: 1 }, w, { speed: 1, dodge: 1 }, 100);
      expect(r.ok).toBe(false);
    }
  });

  it("a character saved at the centre (or at NaN) rejoins at the pad and can walk", async () => {
    for (const [uid, pos] of [["zeroed", [0, 0, 0]], ["nanned", [NaN, 1, 2]]] as const) {
      characterRepo.current.save(uid, { ...newCharacter(0, 0), body: "arcadia", pos: [...pos] as V3 });
      const r = await joinAs(game, uid, "arcadia", {});
      rooms.push(r);
      await waitFor(() => !!me(r));
      const p = [me(r).x, me(r).y, me(r).z];
      expect(p.every(Number.isFinite)).toBe(true);
      const pad = padDirs(BODY)[0]!;
      expect(Math.hypot(p[0]! / R - pad[0]!, p[1]! / R - pad[1]!, p[2]! / R - pad[2]!) * R).toBeLessThan(15);
      expect(aboveGround({ x: p[0]!, y: p[1]!, z: p[2]! })).toBeLessThan(0.5);
      let corrections = 0;
      r.onMessage("correct", () => corrections++);
      const d = norm(p);
      const step = walk(d, tangent(d), 0.4);
      send(r, { n: 10 }, step, groundR(step), 1);
      await sleep(200);
      expect(corrections).toBe(0);
      await safeLeave(r);
    }
  });
});

describe("movement budget", () => {
  it("the per-packet tolerance is charged: 12 m/s sustained at 50 Hz is corrected, a 9 m/s sprint is not", async () => {
    const fast = await joinOutside("speeder");
    let d = fast.dir;
    let last = Date.now();
    const t0 = last;
    while (Date.now() - t0 < 5000) {
      await sleep(20);
      const now = Date.now();
      d = walk(d, fast.t, 12 * ((now - last) / 1000));
      last = now;
      send(fast.r, fast.seq, d, groundR(d), 3);
      if (fast.corrections.n) break;
    }
    expect(fast.corrections.n).toBeGreaterThan(0);

    const ok = await joinOutside("sprinter");
    d = ok.dir;
    last = Date.now();
    const t1 = last;
    while (Date.now() - t1 < 3000) {
      await sleep(25);
      const now = Date.now();
      d = walk(d, ok.t, 9 * ((now - last) / 1000));
      last = now;
      send(ok.r, ok.seq, d, groundR(d), 3);
    }
    await sleep(100);
    expect(ok.corrections.n).toBe(0);
  });
});

describe("knockback (F12 Opus nit)", () => {
  /**
   * Fly like the client: vertical speed `v` (m/s) at height `h` over the start, gravity 18; shoves
   * of strength 4 add 1.6 m/s up each (PlayerController.knockback) when `shoveAt(t)` says how many.
   */
  async function flight(name: string, v0: number, shoveAt: (t: number) => number) {
    const k = await joinOutside(name);
    k.r.send("admin", { cmd: "unprotect" });
    await waitFor(() => !(me(k.r).flags & 3));
    const room = matchMaker.getLocalRoomById(k.r.roomId) as unknown as BodyRoom;
    const actor = room.actors.get(k.r.sessionId)!;
    const base = groundR(k.dir);
    let h = 0, v = v0, t = 0, peak = 0;
    do {
      const n = shoveAt(t);
      for (let i = 0; i < n; i++) {
        dealDamage(room.host, null, actor, 1, false, [-k.t[0], -k.t[1], -k.t[2]], 4);
        v += 4 * 0.4;
      }
      t += 0.05;
      v -= 18 * 0.05;
      h = Math.max(0, h + v * 0.05);
      peak = Math.max(peak, h);
      send(k.r, k.seq, k.dir, base + h, h > 0 ? 4 : 0);
      await sleep(50);
    } while (h > 0 && t < 4);
    await sleep(200);
    return { corrections: k.corrections.n, peak };
  }

  it("eight shoves at once while standing add up like the client's velocity: no height refusals", async () => {
    const r = await flight("stacked", 0, (t) => (t === 0 ? 8 : 0));
    expect(r.peak).toBeGreaterThan(3);
    expect(r.corrections).toBe(0);
  });

  it("shoves during a jump and during its fall add to the speed the body still has", async () => {
    const up = await flight("jumpshoved", 6.6, (t) => (Math.abs(t - 0.15) < 0.01 ? 4 : 0));
    expect(up.corrections).toBe(0);
    const down = await flight("fallshoved", 6.6, (t) => (Math.abs(t - 0.6) < 0.01 ? 10 : 0));
    expect(down.peak).toBeGreaterThan(2);
    expect(down.corrections).toBe(0);
  });

  it("a shove's extra distance is honoured even with the bank spent (not clamped away on the next input)", async () => {
    const k = await joinOutside("shoved");
    k.r.send("admin", { cmd: "unprotect" });
    await waitFor(() => !(me(k.r).flags & 3));
    const room = matchMaker.getLocalRoomById(k.r.roomId) as unknown as BodyRoom;
    const actor = room.actors.get(k.r.sessionId)!;
    await sleep(400); // full bank
    // Spend the bank (3.4 m at once), then take a strength-4 shove (6 m allowance) and slide 6 m.
    let d = walk(k.dir, k.t, 3.4);
    send(k.r, k.seq, d, groundR(d), 3);
    await sleep(20);
    dealDamage(room.host, null, actor, 1, false, [-k.t[0], -k.t[1], -k.t[2]], 4);
    for (let i = 0; i < 3; i++) {
      await sleep(50);
      d = walk(d, k.t, 2);
      send(k.r, k.seq, d, groundR(d), 2);
    }
    await sleep(150);
    expect(k.corrections.n).toBe(0);
  });
});

/** A deep-water direction on Arcadia (lake), well away from the pads. */
function deepWater(): V3 {
  let s = 12345;
  const rand = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
  for (let i = 0; i < 200_000; i++) {
    const d = norm([rand(), rand(), rand()]);
    // Deep here and 15 m around, so a short swim stays in deep water.
    if (terrain.groundHeight(d[0], d[1], d[2]) > BODY.waterLevel - 4) continue;
    const t = tangent(d);
    if ([-15, 15].every((m) => {
      const e = walk(d, t, m);
      return terrain.groundHeight(e[0], e[1], e[2]) < BODY.waterLevel - 4;
    })) return d;
  }
  throw new Error("no deep water found");
}

describe("wading at lake edges (F12 final Opus SF2)", () => {
  for (const body of ["arcadia", "hollowmere", "meridian"] as const) {
    it(`${body}: running through shallows the client wades (ground 1.0–1.2 m under the surface) is never corrected`, async () => {
      const def = BODIES[body];
      const Rb = def.radius;
      const tr = createTerrain(def);
      const wl = def.waterLevel;
      const band = (d: V3) => {
        const g = tr.groundHeight(d[0], d[1], d[2]);
        return g >= wl - SWIM_DEPTH && g < wl - 1.0;
      };
      // The longest straight run inside the band (deterministic scan).
      const rnd = (x: number) => {
        const v = Math.sin(x * 12.9898) * 43758.5453;
        return v - Math.floor(v);
      };
      let best: { d: V3; t: V3; run: number } | null = null;
      for (let i = 0; i < 6000 && !(best && best.run >= 8); i++) {
        const d = norm([rnd(i) * 2 - 1, rnd(i + 0.3) * 2 - 1, rnd(i + 0.7) * 2 - 1]);
        if (!band(d) || isSafe(def, d[0] * Rb, d[1] * Rb, d[2] * Rb)) continue;
        const e1 = tangent(d);
        const e2 = norm([d[1] * e1[2] - d[2] * e1[1], d[2] * e1[0] - d[0] * e1[2], d[0] * e1[1] - d[1] * e1[0]]);
        for (let j = 0; j < 16; j++) {
          const a = (j / 16) * Math.PI * 2;
          const t = norm([e1[0] * Math.cos(a) + e2[0] * Math.sin(a), e1[1] * Math.cos(a) + e2[1] * Math.sin(a), e1[2] * Math.cos(a) + e2[2] * Math.sin(a)]);
          let run = 0;
          for (let m = 0.3; m < 30; m += 0.3) {
            if (band(norm([d[0] * Rb + t[0] * m, d[1] * Rb + t[1] * m, d[2] * Rb + t[2] * m]))) run = m;
            else break;
          }
          if (!best || run > best.run) best = { d, t, run };
        }
      }
      expect(best!.run).toBeGreaterThan(3);
      const at = (m: number): V3 => {
        const q = norm([best!.d[0] * Rb + best!.t[0] * m, best!.d[1] * Rb + best!.t[1] * m, best!.d[2] * Rb + best!.t[2] * m]);
        const r = Rb + tr.groundHeight(q[0], q[1], q[2]);
        return [q[0] * r, q[1] * r, q[2] * r];
      };
      const r = await joinAs(game, `wader_${body}`, body, {}, "admin");
      rooms.push(r);
      await waitFor(() => !!me(r));
      const p0 = at(0);
      r.send("admin", { cmd: "teleport", args: { x: p0[0], y: p0[1], z: p0[2] } });
      await waitFor(() => Math.hypot(me(r).x - p0[0], me(r).y - p0[1], me(r).z - p0[2]) < 0.5);
      let corrections = 0;
      r.onMessage("correct", () => corrections++);
      await sleep(300);
      corrections = 0;
      const seq = { n: 10 };
      // There and back at a 6 m/s run, on the bottom like the client (it only swims deeper than SWIM_DEPTH).
      for (const [from, to] of [[0, best!.run], [best!.run, 0]] as const) {
        const n = Math.max(2, Math.round(Math.abs(to - from) / (6 * 0.05)));
        for (let i = 1; i <= n; i++) {
          const p = at(from + ((to - from) * i) / n);
          send(r, seq, norm(p), Math.hypot(...p), 1);
          await sleep(50);
        }
      }
      await sleep(150);
      expect(corrections).toBe(0);
    }, 30_000);
  }
});

describe("swimming (F12 S3)", () => {
  it("swims at swim speed; sprint-speed swimming and dodge bursts in the water are corrected", async () => {
    const water = deepWater();
    const swimR = R + BODY.waterLevel - 1.05;
    const s = await joinOutside("swimmer", walk(water, tangent(water), -12));
    let d = s.dir;
    // 3 m/s for 2 s: fine.
    for (let i = 0; i < 40; i++) {
      d = walk(d, s.t, 3 * 0.05);
      send(s.r, s.seq, d, swimR, 6);
      await sleep(50);
    }
    await sleep(100);
    expect(s.corrections.n).toBe(0);
    // 9 m/s (a sprint) in the water: corrected within 2 s.
    for (let i = 0; i < 40 && !s.corrections.n; i++) {
      d = walk(d, s.t, 9 * 0.05);
      send(s.r, s.seq, d, swimR, 6);
      await sleep(50);
    }
    expect(s.corrections.n).toBeGreaterThan(0);
  });

  it("a dodge burst is not granted in the water", async () => {
    const water = deepWater();
    const swimR = R + BODY.waterLevel - 1.05;
    const s = await joinOutside("diver", walk(water, tangent(water), 12));
    send(s.r, s.seq, s.dir, swimR, 6); // in the water now
    await sleep(600); // full (swim) budget
    const d = walk(s.dir, s.t, -4.5);
    send(s.r, s.seq, d, swimR, 7);
    await waitFor(() => s.corrections.n > 0, 2000);
  });
});

describe("standing on props (F12 client review should-fix 4)", () => {
  const roomOf = (r: Room) => matchMaker.getLocalRoomById(r.roomId) as unknown as BodyRoom;
  const destructionOf = (r: Room) => roomOf(r).systems.find((x) => x instanceof DestructionSystem) as DestructionSystem;
  const topR = (b: Breakable) => Math.hypot(b.px + b.ux * b.h, b.py + b.uy * b.h, b.pz + b.uz * b.h);
  const centre = (b: Breakable): V3 => norm([b.px, b.py, b.pz]);
  /** Direction `k` of the way from `a` to `b` (great circle, short distances). */
  const lerpDir = (a: V3, b: V3, k: number): V3 => norm([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]);

  /** An intact crate on open, dry, unsafe ground with a run-up spot `run` m from its centre. */
  function crateWithRunUp(sys: DestructionSystem, run: number): { b: Breakable; start: V3 } {
    for (const b of sys.list) {
      if (b.kind !== "crate" || sys.isBroken(b.index)) continue;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const c = Math.cos(a), s2 = Math.sin(a);
        const start = norm([b.px + (b.rx * c + b.fx * s2) * run, b.py + (b.ry * c + b.fy * s2) * run, b.pz + (b.rz * c + b.fz * s2) * run]);
        const g = terrain.groundHeight(start[0], start[1], start[2]);
        if (g < BODY.waterLevel + 0.5 || isSafe(BODY, start[0] * R, start[1] * R, start[2] * R)) continue;
        // Gentle ground between the run-up and the crate, and no other prop on the way.
        const gc = terrain.groundHeight(...centre(b));
        if (Math.abs(g - gc) > 0.25) continue;
        if (sys.list.some((o) => o !== b && Math.hypot(o.px - b.px, o.py - b.py, o.pz - b.pz) < run + 2)) continue;
        return { b, start };
      }
    }
    throw new Error("no crate with a run-up");
  }

  async function onTheCrate(name: string) {
    const k = await joinOutside(name);
    const sys = destructionOf(k.r);
    const run = 1.6;
    const { b, start } = crateWithRunUp(sys, run);
    k.r.send("admin", { cmd: "teleport", args: { x: start[0] * groundR(start), y: start[1] * groundR(start), z: start[2] * groundR(start) } });
    await waitFor(() => Math.hypot(me(k.r).x - start[0] * groundR(start), me(k.r).y - start[1] * groundR(start), me(k.r).z - start[2] * groundR(start)) < 0.5);
    await sleep(150);
    k.corrections.n = 0;
    // Jump at 6.6 m/s while moving 3 m/s toward the crate centre; land on its top.
    const top = topR(b);
    let h = 0, v = 6.6, t = 0, landed = false;
    while (!landed && t < 1.5) {
      t += 0.05;
      v -= 18 * 0.05;
      const d = lerpDir(start, centre(b), Math.min(1, (3 * t) / run));
      const overTop = 3 * t >= run - b.hx + 0.15;
      const g = groundR(d);
      h += v * 0.05;
      let r = g + h;
      if (overTop && v < 0 && r <= top) {
        r = top;
        landed = true;
      } else if (r <= g) r = g;
      send(k.r, k.seq, d, r, landed ? 0 : 4);
      await sleep(50);
    }
    expect(landed).toBe(true);
    const at = lerpDir(start, centre(b), Math.min(1, (3 * t) / run));
    return { ...k, b, sys, at, top };
  }

  it("a player can jump onto a crate, stand there, and jump from its top", async () => {
    const c = await onTheCrate("percher");
    for (let i = 0; i < 30; i++) {
      send(c.r, c.seq, c.at, c.top, 0);
      await sleep(50);
    }
    let h = 0, v = 6.6;
    do {
      v -= 18 * 0.05;
      h = Math.max(0, h + v * 0.05);
      send(c.r, c.seq, c.at, c.top + h, h > 0 ? 4 : 0);
      await sleep(50);
    } while (h > 0);
    await sleep(200);
    expect(c.corrections.n).toBe(0);
    expect(Math.hypot(me(c.r).x, me(c.r).y, me(c.r).z)).toBeCloseTo(c.top, 1);
  });

  it("a broken crate holds nobody up", async () => {
    const c = await onTheCrate("faller");
    c.sys.damage(c.b.index, 1e6, "heavy", "comet", [0, 0, 1]);
    for (let i = 0; i < 30; i++) {
      send(c.r, c.seq, c.at, c.top, 0);
      await sleep(50);
    }
    await sleep(200);
    expect(c.corrections.n).toBeGreaterThan(0);
    expect(aboveGround(me(c.r))).toBeLessThan(0.5);
  });

  it("an idle player whose crate breaks falls on the server and is told where it landed", async () => {
    const c = await onTheCrate("idlefaller");
    for (let i = 0; i < 4; i++) {
      send(c.r, c.seq, c.at, c.top, 0);
      await sleep(50);
    }
    await sleep(600); // idle on the top
    const actor = roomOf(c.r).actors.get(c.r.sessionId)!;
    expect(aboveGround(me(c.r))).toBeGreaterThan(0.6);
    c.sys.damage(c.b.index, 1e6, "heavy", "comet", [0, 0, 1]); // no more input from here on
    await waitFor(() => aboveGround(me(c.r)) < 0.3, 3000);
    await waitFor(() => !actor.airborne, 1000);
    expect(c.corrections.n).toBeGreaterThan(0);
  });

  it("a long idle fall after losing support lands with fall damage on the server", async () => {
    const k = await joinOutside("dropped");
    k.r.send("admin", { cmd: "unprotect" });
    await waitFor(() => !(me(k.r).flags & 3));
    const actor = roomOf(k.r).actors.get(k.r.sessionId)!;
    const hp0 = actor.state.hp;
    // Standing (not airborne) 14 m up, as if on something that just vanished; no input from the client.
    const up = groundR(k.dir) + 14;
    actor.state.x = actor.lastX = k.dir[0] * up;
    actor.state.y = actor.lastY = k.dir[1] * up;
    actor.state.z = actor.lastZ = k.dir[2] * up;
    actor.lastMoveAt = Date.now() - 1000;
    await waitFor(() => actor.airborne, 1000);
    await waitFor(() => aboveGround(actor.state) < 0.3 && !actor.airborne, 4000);
    await waitFor(() => actor.state.hp < hp0, 1000);
    expect(hp0 - actor.state.hp).toBeGreaterThan(0.2 * actor.state.maxHp); // (14 − 8) m × 8 % ≈ 48 %
  });

  it("a move that ends inside a crate's solid part is refused", async () => {
    const k = await joinOutside("ghost");
    const sys = destructionOf(k.r);
    const { b, start } = crateWithRunUp(sys, 1.6);
    k.r.send("admin", { cmd: "teleport", args: { x: start[0] * groundR(start), y: start[1] * groundR(start), z: start[2] * groundR(start) } });
    await waitFor(() => Math.hypot(me(k.r).x - start[0] * groundR(start), me(k.r).y - start[1] * groundR(start), me(k.r).z - start[2] * groundR(start)) < 0.5);
    await sleep(150);
    k.corrections.n = 0;
    for (let i = 1; i <= 8; i++) {
      const d = lerpDir(start, centre(b), i / 8);
      send(k.r, k.seq, d, groundR(d), 1);
      await sleep(80);
    }
    await sleep(150);
    expect(k.corrections.n).toBeGreaterThan(0);
    const p = me(k.r);
    const q = [p.x - b.px, p.y - b.py, p.z - b.pz];
    const lx = q[0]! * b.rx + q[1]! * b.ry + q[2]! * b.rz, lz = q[0]! * b.fx + q[1]! * b.fy + q[2]! * b.fz;
    expect(Math.abs(lx) <= b.hx - 0.1 && Math.abs(lz) <= b.hz - 0.1).toBe(false);
  });

  it("a body put inside a prop (teleport, rebuild) can walk out of it", async () => {
    const k = await joinOutside("stuck");
    const sys = destructionOf(k.r);
    const { b, start } = crateWithRunUp(sys, 1.6);
    const c = centre(b);
    k.r.send("admin", { cmd: "teleport", args: { x: c[0] * groundR(c), y: c[1] * groundR(c), z: c[2] * groundR(c) } });
    await waitFor(() => Math.hypot(me(k.r).x - c[0] * groundR(c), me(k.r).y - c[1] * groundR(c), me(k.r).z - c[2] * groundR(c)) < 0.5);
    await sleep(150);
    k.corrections.n = 0;
    for (let i = 1; i <= 8; i++) {
      const d = lerpDir(c, start, i / 8);
      send(k.r, k.seq, d, groundR(d), 1);
      await sleep(80);
    }
    await sleep(150);
    expect(k.corrections.n).toBe(0);
  });
});

describe("no walking through props in one packet (F12 final S2)", () => {
  const roomOf = (r: Room) => matchMaker.getLocalRoomById(r.roomId) as unknown as BodyRoom;
  const destructionOf = (r: Room) => roomOf(r).systems.find((x) => x instanceof DestructionSystem) as DestructionSystem;
  /** Ground point at prop-local (lx, lz) of `w`. */
  const local = (w: Breakable, lx: number, lz: number): V3 => {
    const d = norm([w.px + w.rx * lx + w.fx * lz, w.py + w.ry * lx + w.fy * lz, w.pz + w.rz * lx + w.fz * lz]);
    const g = groundR(d) + 0.02;
    return [d[0] * g, d[1] * g, d[2] * g];
  };
  const dry = (p: V3) => terrain.groundHeight(...norm(p)) > BODY.waterLevel + 0.5 && !isSafe(BODY, p[0], p[1], p[2]);
  /** Would the client be pushed at feet `p` (intact props only)? */
  const blocked = (sys: DestructionSystem, p: V3) => {
    const q = { x: p[0], y: p[1], z: p[2] };
    return sys.collider.resolve(q, (i) => !sys.isBroken(i), emptyContact(), PLAYER_BODY);
  };
  /** An intact `kind` whose `path(b)` points are all on dry, level, open ground where nothing pushes the body. */
  function wallOf(sys: DestructionSystem, kind: string, path: (b: Breakable) => V3[]): Breakable {
    const w = sys.list.find((b) => {
      if (b.kind !== kind || sys.isBroken(b.index)) return false;
      const pts = path(b);
      const r0 = Math.hypot(...pts[0]!);
      return pts.every((p) => dry(p) && !blocked(sys, p) && Math.abs(Math.hypot(...p) - r0) < 0.3);
    });
    if (!w) throw new Error(`no free ${kind}`);
    return w;
  }

  for (const kind of ["fence", "campwall"] as const) {
    it(`a hop through a ${kind} with both ends outside it is corrected`, async () => {
      const k = await joinOutside(`ghost_${kind}`);
      const sys = destructionOf(k.r);
      const off = (b: Breakable) => b.hz + 0.38 + 0.15;
      const w = wallOf(sys, kind, (b) => [local(b, 0, -off(b)), local(b, 0, off(b))]);
      const front = local(w, 0, -off(w)), back = local(w, 0, off(w));
      k.r.send("admin", { cmd: "teleport", args: { x: front[0], y: front[1], z: front[2] } });
      await waitFor(() => Math.hypot(me(k.r).x - front[0], me(k.r).y - front[1], me(k.r).z - front[2]) < 0.5);
      await sleep(400);
      k.corrections.n = 0;
      send(k.r, k.seq, norm(back), Math.hypot(...back), 1);
      await sleep(300);
      expect(k.corrections.n).toBeGreaterThan(0);
      const p = me(k.r);
      const lz = (p.x - w.px) * w.fx + (p.y - w.py) * w.fy + (p.z - w.pz) * w.fz;
      expect(lz).toBeLessThan(0); // still on the near side
    });
  }

  it("walking along a fence, close to it, is never corrected", async () => {
    const k = await joinOutside("fencewalker");
    const sys = destructionOf(k.r);
    const side = (b: Breakable) => b.hz + 0.38 + 0.02;
    const xs: number[] = [];
    for (let x = -2.5; x <= 2.5; x += 0.4) xs.push(x);
    const w = wallOf(sys, "fence", (b) => xs.map((x) => local(b, x, -side(b))));
    const along = (x: number) => local(w, x, -side(w));
    const start = along(xs[0]!);
    k.r.send("admin", { cmd: "teleport", args: { x: start[0], y: start[1], z: start[2] } });
    await waitFor(() => Math.hypot(me(k.r).x - start[0], me(k.r).y - start[1], me(k.r).z - start[2]) < 0.5);
    await sleep(400);
    k.corrections.n = 0;
    for (const x of xs) {
      const p = along(x);
      send(k.r, k.seq, norm(p), Math.hypot(...p), 1);
      await sleep(50);
    }
    await sleep(150);
    expect(k.corrections.n).toBe(0);
  });
});

describe("sprinting over real terrain like the client (F12 Codex re-review S1)", () => {
  /**
   * The client's ground movement (PlayerController): each 60 Hz frame moves `speed`/60 m along the
   * tangent plane, then snaps onto the terrain (uphill and down); inputs go out every third frame.
   */
  async function sprint(body: BodyId, name: string): Promise<{ corrections: number; climbed: number }> {
    const def = BODIES[body];
    const tr = createTerrain(def);
    const gR = (d: readonly number[]) => def.radius + tr.groundHeight(d[0]!, d[1]!, d[2]!);
    const r = await joinAs(game, name, body, {}, "admin");
    rooms.push(r);
    await waitFor(() => !!me(r));
    const sys = (matchMaker.getLocalRoomById(r.roomId) as unknown as BodyRoom).systems.find((x) => x instanceof DestructionSystem) as DestructionSystem;
    // A dry, prop-free 80 m line from 20 m off the main pad, picking the bearing with the most climb.
    const pad = padDirs(def)[0]! as V3;
    let best: { start: V3; t: V3; climb: number } | null = null;
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const t0 = tangent(pad);
      const s0 = norm([pad[1] * t0[2] - pad[2] * t0[1], pad[2] * t0[0] - pad[0] * t0[2], pad[0] * t0[1] - pad[1] * t0[0]]);
      const t: V3 = norm([t0[0] * Math.cos(a) + s0[0] * Math.sin(a), t0[1] * Math.cos(a) + s0[1] * Math.sin(a), t0[2] * Math.cos(a) + s0[2] * Math.sin(a)]);
      const start = walk(pad, t, 20);
      let ok = true, climb = 0, prev = gR(start);
      for (let m = 0; m <= 80 && ok; m += 1) {
        const d = walk(start, t, m);
        const g = tr.groundHeight(d[0], d[1], d[2]);
        if (g < def.waterLevel + 0.5) ok = false;
        const p: V3 = [d[0] * gR(d), d[1] * gR(d), d[2] * gR(d)];
        if (sys.list.some((b) => Math.hypot(b.px - p[0], b.py - p[1], b.pz - p[2]) < b.foot + 1.5)) ok = false;
        climb += Math.max(0, gR(d) - prev);
        prev = gR(d);
      }
      if (ok && (!best || climb > best.climb)) best = { start, t, climb };
    }
    if (!best) throw new Error(`no dry, clear line on ${body}`);
    const p0 = best.start;
    r.send("admin", { cmd: "teleport", args: { x: p0[0] * gR(p0), y: p0[1] * gR(p0), z: p0[2] * gR(p0) } });
    await waitFor(() => Math.hypot(me(r).x - p0[0] * gR(p0), me(r).y - p0[1] * gR(p0), me(r).z - p0[2] * gR(p0)) < 0.5);
    await sleep(200);
    let corrections = 0;
    r.onMessage("correct", () => corrections++);
    let pos: V3 = [p0[0] * gR(p0), p0[1] * gR(p0), p0[2] * gR(p0)];
    let dir = best.t;
    let seq = 1000;
    let last = Date.now();
    const t0 = last;
    while (Date.now() - t0 < 8000) {
      await sleep(50);
      const now = Date.now();
      const frames = Math.max(1, Math.round(((now - last) / 1000) * 60));
      last = now;
      for (let f = 0; f < frames; f++) {
        const up = norm(pos);
        const k = dir[0] * up[0] + dir[1] * up[1] + dir[2] * up[2];
        dir = norm([dir[0] - k * up[0], dir[1] - k * up[1], dir[2] - k * up[2]]);
        const moved: V3 = [pos[0] + dir[0] * (9 / 60), pos[1] + dir[1] * (9 / 60), pos[2] + dir[2] * (9 / 60)];
        const nu = norm(moved);
        const g = gR(nu);
        pos = [nu[0] * g, nu[1] * g, nu[2] * g];
      }
      r.send("input", { seq: ++seq, x: pos[0], y: pos[1], z: pos[2], fx: dir[0], fy: dir[1], fz: dir[2], anim: 3, t: now });
    }
    await sleep(200);
    return { corrections, climbed: best.climb };
  }

  for (const body of ["arcadia", "hollowmere", "meridian"] as const) {
    it(`${body}: a 9 m/s sprint up and down hills is never corrected`, async () => {
      const r = await sprint(body, `hill_${body}`);
      expect(r.climbed).toBeGreaterThan(1);
      expect(r.corrections).toBe(0);
    });
  }
});

describe("mounted limits go through the limits argument (F12 re-review nit)", () => {
  // A flat test world: radius 1000, ground at 0, no water, no props.
  const flat: MoveWorld = { radius: 1000, waterLevel: -100, groundAt: () => 0 };
  function rider(now: number, mounted: boolean, graceUntil = 0): PlayerActor {
    const pos = { x: 0, y: 0, z: 1000 };
    return { ...motionFields(1000, now), lastX: 0, lastY: 0, lastZ: 1000, state: pos, mounted, mountGraceUntil: graceUntil } as unknown as PlayerActor;
  }
  /** A step of `metres` along +x on the flat world, from the actor's last position. */
  function step(a: PlayerActor, metres: number, anim = 3) {
    const x = a.lastX + metres;
    const l = Math.hypot(x, 0, 1000);
    return { x: (x / l) * 1000, y: 0, z: (1000 / l) * 1000, anim };
  }

  it("riding banks HORSE.budgetCap (5 m), walking 3.5 m", () => {
    const now = 1_000_000;
    const banked = (mounted: boolean) => {
      const a = rider(now, mounted);
      a.moveBudget = 100; // more than any bank: the refill clamps it to the cap
      a.lastBudgetAt = now;
      return a;
    };
    let a = banked(true);
    expect(validateMove(a, step(a, HORSE.budgetCap + 0.2), flat, moveLimits(a, now), now).ok).toBe(false);
    a = banked(true);
    expect(validateMove(a, step(a, HORSE.budgetCap - 0.1), flat, moveLimits(a, now), now).ok).toBe(true);
    a = banked(false);
    expect(validateMove(a, step(a, MOVE.budgetCap + 0.2), flat, moveLimits(a, now), now).ok).toBe(false);
    a = banked(false);
    expect(validateMove(a, step(a, MOVE.budgetCap - 0.1), flat, moveLimits(a, now), now).ok).toBe(true);
  });

  it("the mounted budget lasts HORSE.dismountGraceMs (600 ms) after getting off, then walking limits apply", () => {
    const now = 1_000_000;
    const off = rider(now, false, now + HORSE.dismountGraceMs);
    expect(HORSE.dismountGraceMs).toBe(600);
    expect(moveLimits(off, now + 599).ride).toBeGreaterThan(0);
    expect(moveLimits(off, now + 601).ride).toBeUndefined();
    expect(moveLimits(rider(now, true), now).ride).toBe(HORSE.sprint);
  });

  it("no dodge burst from the saddle", () => {
    const now = 1_000_000;
    const horse = rider(now - 5000, true);
    horse.moveBudget = 0;
    horse.lastBudgetAt = now - 10; // almost nothing refilled
    expect(validateMove(horse, step(horse, 3, ANIM.DODGE), flat, moveLimits(horse, now), now).ok).toBe(false);
    const foot = rider(now - 5000, false);
    foot.moveBudget = 0;
    foot.lastBudgetAt = now - 10;
    expect(validateMove(foot, step(foot, 3, ANIM.DODGE), flat, moveLimits(foot, now), now).ok).toBe(true);
  });
});

