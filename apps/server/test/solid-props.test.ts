// Natural solids on the real path (D-solid-1): walking into a tree trunk is refused, sliding round it
// like the client does is never corrected (also through a forest), and the server puts a player down
// clear of trunks (a save from before solids, a teleport).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Room } from "@colyseus/sdk";
import { BODIES, chunkOf, createTerrain, natureSolids, padDirs, propSolid, solidChunkProps, type BodyId, type Face, type PropInstance } from "@firstlight/shared";
import { emptyContact, PLAYER_BODY } from "@firstlight/shared/planet/collide";
import { newCharacter } from "@firstlight/shared/content/character";
import type { Game } from "../src/app.ts";
import { characterRepo } from "../src/world/characters.ts";
import { joinAs, safeLeave, startServer, waitFor } from "./helpers.ts";

type V3 = [number, number, number];
let game: Game;
const rooms: Room[] = [];
beforeEach(async () => {
  game = await startServer();
});
afterEach(async () => {
  for (const r of rooms.splice(0)) await safeLeave(r);
  await game.close();
});

const BODY: BodyId = "arcadia";
const DEF = BODIES[BODY];
const R = DEF.radius;
const T = createTerrain(BODY);
const SOLIDS = natureSolids(T);
const me = (r: Room) => (r.state as any).players.get(r.sessionId);
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const norm = (v: readonly number[]): V3 => {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [v[0]! / l, v[1]! / l, v[2]! / l];
};
const groundR = (d: readonly number[]) => R + T.groundHeight(d[0]!, d[1]!, d[2]!);
const onGround = (v: readonly number[]): V3 => {
  const d = norm(v);
  const g = groundR(d);
  return [d[0] * g, d[1] * g, d[2] * g];
};
function tangentToward(from: readonly number[], to: readonly number[]): V3 {
  const u = norm(from);
  const d = [to[0]! - from[0]!, to[1]! - from[1]!, to[2]! - from[2]!];
  const k = d[0]! * u[0] + d[1]! * u[1] + d[2]! * u[2];
  return norm([d[0]! - k * u[0], d[1]! - k * u[1], d[2]! - k * u[2]]);
}
const add = (p: readonly number[], t: readonly number[], m: number): V3 => [p[0]! + t[0]! * m, p[1]! + t[1]! * m, p[2]! + t[2]! * m];

/** Solid props within ~250 m of Dawnpad (the chunks round it). */
function solidsNearPad(): PropInstance[] {
  const pad = padDirs(DEF)[0]!;
  const seen = new Set<string>();
  const out: PropInstance[] = [];
  for (let a = 0; a < 16; a++) {
    for (const m of [0, 120, 240]) {
      const ref = Math.abs(pad[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      const t = tangentToward(pad, add(pad, ref, 1));
      const s = norm([pad[1] * t[2] - pad[2] * t[1], pad[2] * t[0] - pad[0] * t[2], pad[0] * t[1] - pad[1] * t[0]]);
      const ang = (a / 16) * Math.PI * 2;
      const d = norm(add(pad, [t[0] * Math.cos(ang) + s[0] * Math.sin(ang), t[1] * Math.cos(ang) + s[1] * Math.sin(ang), t[2] * Math.cos(ang) + s[2] * Math.sin(ang)], m / R));
      const c = chunkOf(d[0], d[1], d[2], DEF.chunksPerFace);
      const k = `${c.face}:${c.cx}:${c.cy}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(...solidChunkProps(T, c.face as Face, c.cx, c.cy));
    }
  }
  return out;
}

/** A lone oak (nothing solid within 6 m) with dry, flat-ish ground 6 m either side along some line. */
function loneTree(): { p: V3; radius: number; t: V3 } {
  const all = solidsNearPad();
  for (const p of all) {
    if (p.kind !== "oak") continue;
    const s = propSolid(p.kind, p.scale)!;
    if (all.some((q) => q !== p && Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) < 7)) continue;
    const c: V3 = [p.x, p.y, p.z];
    const ref = Math.abs(c[2]) < 0.9 * R ? [0, 0, R] : [R, 0, 0];
    const t = tangentToward(c, ref);
    const a = onGround(add(c, t, -6)), b = onGround(add(c, t, 6));
    if (T.groundHeight(...norm(a)) < DEF.waterLevel + 0.5 || T.groundHeight(...norm(b)) < DEF.waterLevel + 0.5) continue;
    if (Math.abs(groundR(norm(a)) - groundR(norm(b))) > 1.5) continue;
    return { p: c, radius: s.radius, t };
  }
  throw new Error("no lone oak near Dawnpad");
}

async function joinAt(name: string, at: V3): Promise<{ r: Room; corrections: { n: number }; seq: { n: number } }> {
  const r = await joinAs(game, name, BODY, {}, "admin");
  rooms.push(r);
  await waitFor(() => !!me(r));
  r.send("admin", { cmd: "teleport", args: { x: at[0], y: at[1], z: at[2] } });
  r.send("admin", { cmd: "unprotect" });
  await waitFor(() => Math.hypot(me(r).x - at[0], me(r).y - at[1], me(r).z - at[2]) < 1);
  const corrections = { n: 0 };
  r.onMessage("correct", () => corrections.n++);
  await sleep(100);
  corrections.n = 0;
  return { r, corrections, seq: { n: 100 } };
}

/**
 * Walk like the client for `seconds`: 60 Hz frames of `speed` m/s along `t` (re-aimed at `goal` each
 * frame if given), pushed out of the natural solids the way PlayerController does (slide), snapped to
 * the ground; an input every third frame. `slide: false` walks straight through instead.
 */
async function walkLikeClient(r: Room, seq: { n: number }, from: V3, t: V3, speed: number, seconds: number, slide: boolean, goal?: V3): Promise<V3> {
  let pos: V3 = [from[0], from[1], from[2]];
  let dir = t;
  const c = emptyContact();
  const q = { x: 0, y: 0, z: 0 };
  for (let f = 0; f < seconds * 60; f++) {
    if (goal) dir = tangentToward(pos, goal);
    pos = onGround(add(pos, dir, speed / 60));
    if (slide) {
      q.x = pos[0]; q.y = pos[1]; q.z = pos[2];
      SOLIDS.resolve(q, c);
      pos = onGround([q.x, q.y, q.z]);
    }
    if (f % 3 === 2) {
      r.send("input", { seq: ++seq.n, x: pos[0], y: pos[1], z: pos[2], fx: dir[0], fy: dir[1], fz: dir[2], anim: 2, t: Date.now() });
      await sleep(50);
    }
  }
  await sleep(200);
  return pos;
}

describe("tree trunks are solid on the server (D-solid-1)", () => {
  it("walking straight into a trunk is refused; the player never ends up in it", async () => {
    const { p, radius, t } = loneTree();
    const start = onGround(add(p, t, -4));
    const k = await joinAt("lumberjack", start);
    await walkLikeClient(k.r, k.seq, start, t, 6, 1.6, false);
    expect(k.corrections.n).toBeGreaterThan(0);
    const s = me(k.r);
    // Stopped short of the trunk, on the near side.
    expect(Math.hypot(s.x - p[0], s.y - p[1], s.z - p[2])).toBeGreaterThan(radius);
    const along = (s.x - p[0]) * t[0] + (s.y - p[1]) * t[1] + (s.z - p[2]) * t[2];
    expect(along).toBeLessThan(0);
  });

  it("sliding round the trunk like the client does is never corrected and gets past it", async () => {
    const { p, t } = loneTree();
    // A line 0.25 m off the trunk's centre: the push has a sideways part and the walk slides round
    // (dead centre-on, the push is straight back and a player stops, as anywhere: they steer).
    const side = norm([p[1] * t[2] - p[2] * t[1], p[2] * t[0] - p[0] * t[2], p[0] * t[1] - p[1] * t[0]]);
    const start = onGround(add(add(p, t, -4), side, 0.25));
    const goal = onGround(add(add(p, t, 4), side, 0.25));
    const k = await joinAt("slider", start);
    const end = await walkLikeClient(k.r, k.seq, start, t, 6, 1.8, true, goal);
    expect(k.corrections.n).toBe(0);
    expect(Math.hypot(end[0] - goal[0], end[1] - goal[1], end[2] - goal[2])).toBeLessThan(1.5);
    expect(Math.hypot(me(k.r).x - end[0], me(k.r).y - end[1], me(k.r).z - end[2])).toBeLessThan(0.5);
  });

  it("a run through the forest with the client's sliding is never corrected", async () => {
    // The densest 60 m line among the solids near Dawnpad, on dry ground.
    const all = solidsNearPad().filter((x) => x.kind === "oak" || x.kind === "pine");
    let best: { a: V3; b: V3; n: number } | null = null;
    for (const s of all.slice(0, 400)) {
      const c: V3 = [s.x, s.y, s.z];
      const ref = Math.abs(c[2]) < 0.9 * R ? [0, 0, R] : [R, 0, 0];
      const t = tangentToward(c, ref);
      const a = onGround(add(c, t, -30)), b = onGround(add(c, t, 30));
      let dry = true;
      for (let m = -30; m <= 30 && dry; m += 3) dry = T.groundHeight(...norm(add(c, t, m))) > DEF.waterLevel + 0.6;
      if (!dry) continue;
      const n = all.filter((o) => {
        const d = [o.x - c[0], o.y - c[1], o.z - c[2]];
        const along = d[0]! * t[0] + d[1]! * t[1] + d[2]! * t[2];
        const off = Math.hypot(d[0]! - t[0] * along, d[1]! - t[1] * along, d[2]! - t[2] * along);
        return Math.abs(along) < 30 && off < 2;
      }).length;
      if (!best || n > best.n) best = { a, b, n };
    }
    expect(best!.n).toBeGreaterThan(3); // a real forest line
    const k = await joinAt("rambler", best!.a);
    if (!SOLIDS.isClear({ x: best!.a[0], y: best!.a[1], z: best!.a[2] })) throw new Error("start inside a solid");
    await walkLikeClient(k.r, k.seq, best!.a, tangentToward(best!.a, best!.b), 6, 9, true, best!.b);
    expect(k.corrections.n).toBe(0);
  }, 30_000);

  it("a save from inside a trunk, and a teleport into one, come back standing clear of it", async () => {
    const { p, radius } = loneTree();
    const c = newCharacter(0, 0);
    c.body = BODY;
    c.pos = [p[0], p[1], p[2]];
    characterRepo.current.save("stuck", c);
    const r = await joinAs(game, "stuck", BODY, {}, "admin", false);
    rooms.push(r);
    await waitFor(() => !!me(r));
    const s = me(r);
    expect(Math.hypot(s.x - p[0], s.y - p[1], s.z - p[2])).toBeGreaterThanOrEqual(radius + PLAYER_BODY.radius);
    expect(SOLIDS.isClear({ x: s.x, y: s.y, z: s.z })).toBe(true);
    r.send("admin", { cmd: "teleport", args: { x: p[0], y: p[1], z: p[2] } });
    await sleep(300);
    const s2 = me(r);
    expect(SOLIDS.isClear({ x: s2.x, y: s2.y, z: s2.z })).toBe(true);
    expect(Math.hypot(s2.x - p[0], s2.y - p[1], s2.z - p[2])).toBeLessThan(3);
  });
});
