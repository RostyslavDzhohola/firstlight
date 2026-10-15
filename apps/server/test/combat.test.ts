import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Room } from "@colyseus/sdk";
import { BODIES, padDirs } from "@firstlight/shared";
import { PF } from "@firstlight/shared/net/schema";
import type { Game } from "../src/app.ts";
import { RULES } from "../src/world/BodyRoom.ts";
import { pileStore } from "../src/world/piles.ts";
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

/** A point `metres` from Arcadia's main pad, along a fixed tangent, outside the safe ring. */
function awayFromPad(metres: number, sideways = 0): [number, number, number] {
  const R = BODIES.arcadia.radius;
  const d = padDirs(BODIES.arcadia)[0]!;
  const ref = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const k = ref[0]! * d[0] + ref[1]! * d[1] + ref[2]! * d[2];
  let n = [ref[0]! - k * d[0], ref[1]! - k * d[1], ref[2]! - k * d[2]];
  const nl = Math.hypot(n[0]!, n[1]!, n[2]!);
  n = n.map((v) => v / nl);
  // East-north-east of the pad (75° from north): open ground. Due north is the Dawnpad outpost's
  // barn since D42, and its walls stop shots.
  const w = [d[1] * n[2]! - d[2] * n[1]!, d[2] * n[0]! - d[0] * n[2]!, d[0] * n[1]! - d[1] * n[0]!];
  const a = (75 * Math.PI) / 180;
  const t = n.map((v, i) => v * Math.cos(a) - w[i]! * Math.sin(a));
  const s = [d[1] * t[2]! - d[2] * t[1]!, d[2] * t[0]! - d[0] * t[2]!, d[0] * t[1]! - d[1] * t[0]!];
  const v = [d[0] + (t[0]! * metres + s[0]! * sideways) / R, d[1] + (t[1]! * metres + s[1]! * sideways) / R, d[2] + (t[2]! * metres + s[2]! * sideways) / R];
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [(v[0]! / l) * R, (v[1]! / l) * R, (v[2]! / l) * R];
}

const st = (r: Room) => r.state as any;
const me = (r: Room) => st(r).players.get(r.sessionId);

async function setup(body = "arcadia") {
  // Admin tokens let tests teleport and drop spawn protection.
  const a = await joinAs(game, "shooter", body, { starter: 3 }, "admin");
  const b = await joinAs(game, "target", body, { starter: 1 }, "admin");
  rooms.push(a, b);
  await waitFor(() => st(a).players?.size === 2 && st(b).players?.size === 2);
  return { a, b };
}

/** Out of the safe ring and spawn protection, as the server sees it. */
function readyToFight(r: Room): boolean {
  const s = st(r).players.get(r.sessionId);
  return !!s && !(s.flags & PF.SAFE) && !(s.flags & PF.PROTECTED);
}

function place(r: Room, p: [number, number, number]) {
  r.send("admin", { cmd: "teleport", args: { x: p[0], y: p[1], z: p[2] } });
  r.send("admin", { cmd: "unprotect" });
}

function aimAt(shooter: Room, target: Room) {
  const s = me(shooter), t = st(shooter).players.get(target.sessionId);
  const l = Math.hypot(s.x, s.y, s.z);
  const up = [s.x / l, s.y / l, s.z / l];
  const o = [s.x + up[0]! * 1.6, s.y + up[1]! * 1.6, s.z + up[2]! * 1.6];
  const tl = Math.hypot(t.x, t.y, t.z);
  const tu = [t.x / tl, t.y / tl, t.z / tl];
  const aim = [t.x + tu[0]! * 1.0, t.y + tu[1]! * 1.0, t.z + tu[2]! * 1.0];
  const d = [aim[0]! - o[0]!, aim[1]! - o[1]!, aim[2]! - o[2]!];
  const dl = Math.hypot(d[0]!, d[1]!, d[2]!);
  return { ox: o[0], oy: o[1], oz: o[2], dx: d[0]! / dl, dy: d[1]! / dl, dz: d[2]! / dl };
}

describe("combat (seam 1)", () => {
  it("a carbine shot outside the safe zone damages the target", async () => {
    const { a, b } = await setup();
    place(a, awayFromPad(40));
    place(b, awayFromPad(52));
    await waitFor(() => Math.abs(Math.hypot(me(a).x - me(b).x, me(a).y - me(b).y, me(a).z - me(b).z) - 12) < 1.5 && !(me(b).flags & 2));
    await waitFor(() => readyToFight(a) && readyToFight(b));
    const before = st(a).players.get(b.sessionId).hp;
    a.send("fire", { slot: 0, ...aimAt(a, b), t: Date.now() });
    await waitFor(() => st(a).players.get(b.sessionId).hp < before);
  });

  it("nobody can be hurt in a safe zone (Portus)", async () => {
    const { a, b } = await setup("portus");
    a.send("admin", { cmd: "unprotect" });
    b.send("admin", { cmd: "unprotect" });
    await waitFor(() => !(me(a).flags & PF.PROTECTED) && !(st(a).players.get(b.sessionId).flags & PF.PROTECTED));
    let denied = "";
    a.onMessage("denied", (m: { reason: string }) => (denied = m.reason));
    a.send("fire", { slot: 0, ...aimAt(a, b), t: Date.now() });
    await waitFor(() => denied !== "");
    expect(denied).toBe("safe zone");
    expect(st(a).players.get(b.sessionId).hp).toBe(100);
  });

  it("death drops a pile with everything carried; after rebirth the owner can loot it", async () => {
    const { a, b } = await setup();
    place(a, awayFromPad(40));
    place(b, awayFromPad(46));
    await waitFor(() => readyToFight(b));
    let death: any = null;
    b.onMessage("death", (m) => (death = m));
    let reborn = false;
    b.onMessage("reborn", () => (reborn = true));
    a.send("admin", { cmd: "damage", args: { target: b.sessionId, amount: 500 } });
    await waitFor(() => death !== null);
    expect(death.pileId).toBeTruthy();
    expect(pileStore.current.get(death.pileId)?.kind).toBe("death"); // protected from eviction past the cap
    await waitFor(() => st(a).piles?.has(death.pileId));
    // Rebirth (a new life in Portus), then come back for the pile.
    b.send("respawn", { starter: 0, palette: 2 });
    await waitFor(() => reborn);
    await b.leave();
    const portus = await joinAs(game, "target", "portus", {}, "admin");
    rooms.push(portus);
    await portus.leave();
    const back = await joinAs(game, "target", "arcadia", {}, "admin");
    rooms.push(back);
    const pile = st(a).piles.get(death.pileId);
    let you: any = null;
    back.onMessage("you", (m) => (you = m));
    back.send("admin", { cmd: "teleport", args: { x: pile.x, y: pile.y, z: pile.z } });
    await waitFor(() => Math.hypot(me(back).x - pile.x, me(back).y - pile.y, me(back).z - pile.z) < 1.5);
    back.send("pickup", { pileId: death.pileId });
    // The old life's Sunbrand (Brother Ash's starter) is back, next to the new Hexquill.
    await waitFor(() => !!you && JSON.stringify(you.hotbar).includes("sunbrand"));
    await waitFor(() => !st(a).piles.has(death.pileId));
  });

  it("logging out outside a safe zone takes a countdown; inside it is instant", async () => {
    const saved = RULES.LOGOUT_MS;
    RULES.LOGOUT_MS = 1500;
    try {
      const first = await setup();
      let out = false;
      first.a.onMessage("loggedOut", () => (out = true));
      first.a.send("logout", { start: true }); // still on the pad: instant
      await waitFor(() => out);
      // Logging out disconnects; come back and try again outside the safe zone.
      const a = await joinAs(game, "shooter", "arcadia", {}, "admin");
      rooms.push(a);
      a.onMessage("loggedOut", () => (out = true));
      out = false;
      await waitFor(() => (a.state as any).players?.has(a.sessionId));
      place(a, awayFromPad(40));
      await waitFor(() => readyToFight(a));
      const started = Date.now();
      a.send("logout", { start: true });
      await waitFor(() => out, 4000);
      // The countdown ran (not instant): it took most of LOGOUT_MS.
      expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    } finally {
      RULES.LOGOUT_MS = saved;
    }
  });

  it("closing the game outside a safe zone leaves the body in the world for a while", async () => {
    const saved = RULES.LINGER_MS;
    RULES.LINGER_MS = 1500;
    try {
      const { a, b } = await setup();
      place(b, awayFromPad(40));
      await waitFor(() => readyToFight(b));
      const id = b.sessionId;
      const left = Date.now();
      await b.leave(true);
      rooms.splice(rooms.indexOf(b), 1);
      expect(st(a).players.has(id)).toBe(true);
      await waitFor(() => !st(a).players.has(id), 4000);
      expect(Date.now() - left).toBeGreaterThanOrEqual(1000); // it lingered, not removed at once
    } finally {
      RULES.LINGER_MS = saved;
    }
  });
});
