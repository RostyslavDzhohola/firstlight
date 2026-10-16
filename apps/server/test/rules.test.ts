// Seam 1: the server rules added after the combat/auth review (D26), driven by SDK bot clients.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Room } from "@colyseus/sdk";
import { BODIES, createTerrain, portalSpots } from "@firstlight/shared";
import type { Game } from "../src/app.ts";
import { joinAs, playRequest, safeLeave, startServer, waitFor } from "./helpers.ts";

let game: Game;
const rooms: Room[] = [];

beforeEach(async () => {
  game = await startServer();
});
afterEach(async () => {
  for (const r of rooms.splice(0)) await safeLeave(r);
  await game.close();
});

const st = (r: Room) => r.state as any;
const me = (r: Room) => st(r).players.get(r.sessionId);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Walk along the ground to `target` at `speed` m/s, sending 20 Hz inputs like the real client. */
async function walkTo(r: Room, target: [number, number, number], speed = 6) {
  const terrain = createTerrain(BODIES.portus);
  const R = BODIES.portus.radius;
  let corrected = false;
  r.onMessage("correct", () => (corrected = true));
  const p0 = me(r);
  let pos = [p0.x, p0.y, p0.z];
  let seq = 1000;
  for (let i = 0; i < 400; i++) {
    const d = [target[0] - pos[0]!, target[1] - pos[1]!, target[2] - pos[2]!];
    const dist = Math.hypot(d[0]!, d[1]!, d[2]!);
    if (dist < 0.4) break;
    const step = Math.min(dist, speed * 0.05);
    const n = [pos[0]! + (d[0]! / dist) * step, pos[1]! + (d[1]! / dist) * step, pos[2]! + (d[2]! / dist) * step];
    const l = Math.hypot(n[0]!, n[1]!, n[2]!);
    const u = [n[0]! / l, n[1]! / l, n[2]! / l];
    const h = R + terrain.groundHeight(u[0]!, u[1]!, u[2]!);
    pos = [u[0]! * h, u[1]! * h, u[2]! * h];
    r.send("input", { seq: ++seq, x: pos[0], y: pos[1], z: pos[2], fx: d[0]! / dist, fy: d[1]! / dist, fz: d[2]! / dist, anim: 1, t: Date.now() });
    await sleep(50);
  }
  expect(corrected).toBe(false);
  await waitFor(() => Math.hypot(me(r).x - pos[0]!, me(r).y - pos[1]!, me(r).z - pos[2]!) < 0.5);
}

describe("travel tickets (D26)", () => {
  it("a character can only enter another body after the server authorises a portal", async () => {
    const token = "dev:traveller:traveller";
    const a = await joinAs(game, "traveller", "portus");
    rooms.push(a);
    await waitFor(() => !!me(a));

    // Asking /api/play for another body without a ticket sends us back to Portus.
    expect(await playRequest(game, token, { body: "arcadia" })).toEqual({ ok: false, error: "travel", body: "portus" });

    // Asking far from any portal is refused.
    const denied = new Promise<{ action: string }>((ok) => a.onMessage("denied", ok));
    a.send("travel", { to: "arcadia" });
    expect((await denied).action).toBe("travel");

    // Walk into the Arcadia portal; now the server issues the ticket.
    const spot = portalSpots(BODIES.portus, createTerrain(BODIES.portus)).find((s) => s.to === "arcadia")!;
    const R = BODIES.portus.radius + spot.h;
    await walkTo(a, [spot.dir[0] * R, spot.dir[1] * R, spot.dir[2] * R]);
    const okMsg = new Promise<{ to: string }>((ok) => a.onMessage("travelOk", ok));
    a.send("travel", { to: "arcadia" });
    expect((await okMsg).to).toBe("arcadia");
    const r = await playRequest(game, token, { body: "arcadia" });
    expect(r.ok).toBe(true);
  });
});

describe("one actor per user (D26)", () => {
  it("a second session takes over: the first is closed with 4100 and only one body remains", async () => {
    const first = await joinAs(game, "twin", "portus");
    rooms.push(first);
    await waitFor(() => !!me(first));
    let code = 0;
    first.onLeave((c) => (code = c));
    const second = await joinAs(game, "twin", "portus");
    rooms.push(second);
    await waitFor(() => code !== 0);
    expect(code).toBe(4100);
    await waitFor(() => !!me(second));
    await sleep(150);
    expect(st(second).players.size).toBe(1);
  });
});

describe("server-timed bow draw (D26)", () => {
  async function bowShot(drawMs: number | null): Promise<number> {
    const a = await joinAs(game, `archer${drawMs}`, "arcadia", { starter: 3 }, "admin");
    rooms.push(a);
    await waitFor(() => !!me(a));
    a.send("admin", { cmd: "unprotect" });
    // Leave the pad's safe ring (weapons are holstered inside it).
    const p = me(a);
    const l = Math.hypot(p.x, p.y, p.z);
    const up = [p.x / l, p.y / l, p.z / l];
    const side = Math.abs(up[2]!) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const k = side[0]! * up[0]! + side[1]! * up[1]! + side[2]! * up[2]!;
    const t = [side[0]! - k * up[0]!, side[1]! - k * up[1]!, side[2]! - k * up[2]!];
    const tl = Math.hypot(t[0]!, t[1]!, t[2]!);
    a.send("admin", { cmd: "teleport", args: { x: p.x + (t[0]! / tl) * 30, y: p.y + (t[1]! / tl) * 30, z: p.z + (t[2]! / tl) * 30 } });
    a.send("admin", { cmd: "give", args: { id: "longbow" } });
    await waitFor(() => !(me(a).flags & 2)); // not SAFE
    await sleep(200);
    // Bow in hand before the draw, like the client (a draw belongs to the item it started with).
    a.send("equip", { slot: 1 });
    if (drawMs !== null) {
      a.send("charge", { on: true });
      await sleep(drawMs);
    }
    const shot = new Promise<{ vx: number; vy: number; vz: number }>((ok) => a.onMessage("projectile", ok));
    const q = me(a);
    const ql = Math.hypot(q.x, q.y, q.z);
    // Aim slightly upwards, along the tangent; the client claims a full draw every time.
    a.send("fire", { slot: 1, ox: q.x + (q.x / ql) * 1.6, oy: q.y + (q.y / ql) * 1.6, oz: q.z + (q.z / ql) * 1.6, dx: t[0]! / tl, dy: t[1]! / tl, dz: t[2]! / tl, t: Date.now(), charge: 1 });
    const m = await shot;
    return Math.hypot(m.vx, m.vy, m.vz);
  }

  it("a shot without a server-timed draw flies as a tap; a full draw flies at full speed", async () => {
    const tap = await bowShot(null);
    const full = await bowShot(1100);
    expect(tap).toBeCloseTo(25, 0);
    expect(full).toBeCloseTo(55, 0);
  });
});
