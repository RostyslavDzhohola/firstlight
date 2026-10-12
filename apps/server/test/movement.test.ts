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
import { isSafe, type Breakable } from "@firstlight/shared";
import type { BodyId } from "@firstlight/shared";
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

