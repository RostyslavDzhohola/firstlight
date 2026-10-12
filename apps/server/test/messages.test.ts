// Seam 1: message hygiene from the F12 reviews: per-type rate caps (travel, respawn, ping,
// questSync, client:info), malformed messages are dropped instead of kicking, firing doesn't resend
// the whole private state per shot, and one lag-compensation window.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Room } from "@colyseus/sdk";
import { BODIES, padDirs } from "@firstlight/shared";
import { NET } from "@firstlight/shared/net/protocol";
import type { Game } from "../src/app.ts";
import { REWIND_MS } from "../src/world/combat.ts";
import { characterRepo } from "../src/world/characters.ts";
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

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const me = (r: Room) => (r.state as any).players?.get(r.sessionId);

async function join(name: string, body = "portus", role = ""): Promise<Room> {
  const r = await joinAs(game, name, body, { starter: 3 }, role);
  rooms.push(r);
  await waitFor(() => !!me(r));
  return r;
}
function count(r: Room, type: string, filter: (m: any) => boolean = () => true): { n: number } {
  const c = { n: 0 };
  r.onMessage(type, (m: any) => filter(m) && c.n++);
  return c;
}

describe("per-type message caps (F12 nit)", () => {
  it("bursts of ping, travel, respawn, questSync and client:info are capped per second", async () => {
    const r = await join("chatty");
    const pongs = count(r, "pong");
    const travelDenied = count(r, "denied", (m) => m.action === "travel");
    const halls = count(r, "hall");
    const parties = count(r, "party:state");
    // Under Colyseus's own 60 messages/s per client.
    for (let i = 0; i < 24; i++) r.send("ping", { t: i });
    for (let i = 0; i < 6; i++) {
      r.send("travel", { to: "arcadia" });
      r.send("respawn", { starter: 0, palette: 0 });
      r.send("questSync", {});
      r.send("client:info", { backend: "webgpu", tier: "high" });
    }
    await sleep(600);
    expect(pongs.n).toBeGreaterThan(0);
    expect(pongs.n).toBeLessThanOrEqual(20);
    expect(travelDenied.n).toBeGreaterThan(0);
    expect(travelDenied.n).toBeLessThanOrEqual(3);
    expect(halls.n).toBeGreaterThan(0);
    expect(halls.n).toBeLessThanOrEqual(3);
    expect(parties.n).toBeGreaterThan(0);
    expect(parties.n).toBeLessThanOrEqual(3);
    // Still connected and served after the burst window.
    await sleep(1100);
    const before = pongs.n;
    r.send("ping", { t: 99 });
    await waitFor(() => pongs.n > before);
  });
});

describe("respawn and skySync caps (F12 re-review nit)", () => {
  it("a dead player's burst of respawns is answered (and saved) once per second; skySync bursts are capped too", async () => {
    const r = await join("revenant", "arcadia", "admin");
    // Die outside the safe ring.
    const R = BODIES.arcadia.radius;
    const d = padDirs(BODIES.arcadia)[0]!;
    const ref = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const k = ref[0]! * d[0] + ref[1]! * d[1] + ref[2]! * d[2];
    const t = [ref[0]! - k * d[0], ref[1]! - k * d[1], ref[2]! - k * d[2]];
    const tl = Math.hypot(t[0]!, t[1]!, t[2]!);
    const v = [d[0] + (t[0]! / tl) * (40 / R), d[1] + (t[1]! / tl) * (40 / R), d[2] + (t[2]! / tl) * (40 / R)];
    const vl = Math.hypot(v[0]!, v[1]!, v[2]!);
    r.send("admin", { cmd: "teleport", args: { x: (v[0]! / vl) * R, y: (v[1]! / vl) * R, z: (v[2]! / vl) * R } });
    r.send("admin", { cmd: "unprotect" });
    await waitFor(() => !(me(r).flags & 3));
    const deaths = count(r, "death");
    r.send("admin", { cmd: "damage", args: { amount: 10_000 } });
    await waitFor(() => deaths.n > 0);
    const repo = characterRepo.current;
    let saves = 0;
    const save = repo.save.bind(repo);
    repo.save = (u, c) => {
      if (u === "revenant") saves++;
      save(u, c);
    };
    try {
      const reborn = count(r, "reborn");
      const skies = count(r, "sky");
      for (let i = 0; i < 6; i++) {
        r.send("respawn", { starter: 0, palette: 0 });
        r.send("skySync", {});
      }
      await sleep(500);
      expect(reborn.n).toBe(1);
      expect(saves).toBe(1);
      expect(skies.n).toBeLessThanOrEqual(2);
    } finally {
      repo.save = save;
    }
  });
});

describe("protocol drift (F12 nit)", () => {
  it("a malformed message is dropped; the player isn't disconnected", async () => {
    const r = await join("drifter");
    let closed = 0;
    r.onLeave((c) => (closed = c));
    r.send("equip", { slot: "two" });
    r.send("input", { seq: 1, x: "nope" });
    r.send("block", {});
    await sleep(400);
    expect(closed).toBe(0);
    const pongs = count(r, "pong");
    r.send("ping", { t: 1 });
    await waitFor(() => pongs.n > 0);
  });

  it("a client that keeps sending garbage is disconnected", async () => {
    const r = await join("garbler");
    let closed = 0;
    r.onLeave((c) => (closed = c));
    for (let i = 0; i < 40; i++) r.send("equip", { slot: "x" });
    await waitFor(() => closed !== 0, 3000);
  });

  it("combat rewinds by the shared NET.REWIND_MS", () => {
    expect(REWIND_MS).toBe(NET.REWIND_MS);
  });
});

describe("firing and the private state (F12 nit)", () => {
  it("a burst of shots doesn't resend 'you' per shot, and the magazine still ends up right", async () => {
    const r = await join("burster", "arcadia", "admin");
    const R = BODIES.arcadia.radius;
    const d = padDirs(BODIES.arcadia)[0]!;
    const ref = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const k = ref[0]! * d[0] + ref[1]! * d[1] + ref[2]! * d[2];
    const t = [ref[0]! - k * d[0], ref[1]! - k * d[1], ref[2]! - k * d[2]];
    const tl = Math.hypot(t[0]!, t[1]!, t[2]!);
    const v = [d[0] + (t[0]! / tl) * (40 / R), d[1] + (t[1]! / tl) * (40 / R), d[2] + (t[2]! / tl) * (40 / R)];
    const vl = Math.hypot(v[0]!, v[1]!, v[2]!);
    r.send("admin", { cmd: "teleport", args: { x: (v[0]! / vl) * R, y: (v[1]! / vl) * R, z: (v[2]! / vl) * R } });
    r.send("admin", { cmd: "unprotect" });
    await waitFor(() => !(me(r).flags & 3));
    await sleep(200);
    let last: any = null;
    let yous = 0;
    r.onMessage("you", (m: any) => {
      yous++;
      last = m;
    });
    const shots = count(r, "shot", (m) => m.by === r.sessionId);
    for (let i = 0; i < 9; i++) {
      const p = me(r);
      const l = Math.hypot(p.x, p.y, p.z);
      const o = [p.x + (p.x / l) * 1.6, p.y + (p.y / l) * 1.6, p.z + (p.z / l) * 1.6];
      r.send("fire", { slot: 0, ox: o[0], oy: o[1], oz: o[2], dx: t[0]! / tl, dy: t[1]! / tl, dz: t[2]! / tl, t: Date.now() });
      await sleep(230);
    }
    await sleep(700);
    expect(shots.n).toBeGreaterThanOrEqual(7);
    expect(yous).toBeLessThanOrEqual(7);
    expect(yous).toBeLessThan(shots.n);
    expect(last.hotbar[0].mag).toBe(24 - shots.n);
  });
});
