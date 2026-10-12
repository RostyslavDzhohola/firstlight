// Seam 1: seat reservations from /api/play (F12 review B5 stale seats, S2 seat hoarding, new
// characters start home, protocol-version gate).

import { afterEach, describe, expect, it } from "vitest";
import { Client, type Room } from "@colyseus/sdk";
import { PROTOCOL_VERSION } from "@firstlight/shared/net/protocol";
import type { Game } from "../src/app.ts";
import { BodyRoom } from "../src/world/BodyRoom.ts";
import { Browser, play, startAuthServer, type AuthServer } from "./auth-helpers.ts";
import { grantTravel, joinAs, playRequest, safeLeave, startServer, waitFor } from "./helpers.ts";

let game: Game | null = null;
let server: AuthServer | null = null;
const rooms: Room[] = [];

afterEach(async () => {
  for (const r of rooms.splice(0)) await safeLeave(r);
  await game?.close();
  game = null;
  await server?.close();
  server = null;
});

const st = (r: Room) => r.state as any;

/** Try to use a reservation; resolves to the room, or null when the server refuses the seat. */
async function consume(base: string, reservation: unknown): Promise<Room | null> {
  try {
    const r = await new Client(base).consumeSeatReservation(reservation as never);
    rooms.push(r);
    // A seat refused after joining closes at once; give it a moment.
    let closed = false;
    r.onLeave(() => (closed = true));
    await new Promise((ok) => setTimeout(ok, 300));
    return closed ? null : r;
  } catch {
    return null;
  }
}

async function post(port: number, token: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/api/play`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

describe("stale seats are revalidated when used (F12 B5)", () => {
  it("a seat reserved before travelling can't be used to go back", async () => {
    game = await startServer();
    const portus = await joinAs(game, "hopper", "portus");
    rooms.push(portus);
    const old = await playRequest(game, "dev:hopper:hopper", { body: "portus" });
    expect(old.ok).toBe(true);
    grantTravel("hopper", "arcadia");
    const arcadia = await joinAs(game, "hopper", "arcadia");
    rooms.push(arcadia);
    await waitFor(() => !!st(arcadia).players?.get(arcadia.sessionId));
    expect(await consume(`http://127.0.0.1:${game.port}`, (old as any).reservation)).toBeNull();
    // Still in Arcadia, not taken over.
    expect(st(arcadia).players.get(arcadia.sessionId)).toBeTruthy();
  });

  it("a guest's seat can't be used after the guest saved (no guest account comes back)", async () => {
    server = await startAuthServer();
    const b = new Browser(server);
    const token = await b.playToken();
    const r = await play(server, token, { body: "portus" });
    expect(r.json.ok).toBe(true);
    await b.saveWithEmail("stale@example.test");
    expect(await consume(server.base, (r.json as any).reservation)).toBeNull();
  });

  it("a seat can't be used after signing out", async () => {
    server = await startAuthServer();
    const b = new Browser(server);
    const token = await b.playToken();
    const r = await play(server, token, { body: "portus" });
    expect(r.json.ok).toBe(true);
    await b.client.signOut();
    expect(await consume(server.base, (r.json as any).reservation)).toBeNull();
  });
});

describe("where characters may enter", () => {
  it("a brand-new character starts in Portus: any other body sends it home", async () => {
    game = await startServer();
    expect(await playRequest(game, "dev:newbie:newbie", { body: "meridian" })).toEqual({ ok: false, error: "travel", body: "portus" });
    expect((await playRequest(game, "dev:newbie:newbie", { body: "portus" })).ok).toBe(true);
  });
});

describe("seat hoarding (F12 S2)", () => {
  it("an account holds at most 2 unused seats; using one frees a slot", async () => {
    game = await startServer();
    const a = await playRequest(game, "dev:hoarder:hoarder", { body: "portus" });
    const b = await playRequest(game, "dev:hoarder:hoarder", { body: "portus" });
    expect(a.ok && b.ok).toBe(true);
    const third = await post(game.port, "dev:hoarder:hoarder", { body: "portus", v: PROTOCOL_VERSION });
    expect(third.status).toBe(429);
    expect(await consume(`http://127.0.0.1:${game.port}`, (a as any).reservation)).not.toBeNull();
    expect((await playRequest(game, "dev:hoarder:hoarder", { body: "portus" })).ok).toBe(true);
  });

  it("one address holds at most 10 unused seats across accounts", async () => {
    game = await startServer();
    const ip = { "x-real-ip": "203.0.113.9" };
    for (let i = 0; i < 10; i++) expect((await post(game.port, `dev:ipu${i}:ipu${i}`, { body: "portus", v: PROTOCOL_VERSION }, ip)).json.ok).toBe(true);
    expect((await post(game.port, "dev:ipu10:ipu10", { body: "portus", v: PROTOCOL_VERSION }, ip)).status).toBe(429);
    // Another address is unaffected.
    expect((await post(game.port, "dev:ipv0:ipv0", { body: "portus", v: PROTOCOL_VERSION }, { "x-real-ip": "203.0.113.10" })).json.ok).toBe(true);
  });
});

describe("seat caps hold under concurrent requests (F12 re-review S4)", () => {
  /** Slow every seat reservation down by 100 ms, so concurrent requests overlap in the await. */
  function slowReservations(): () => void {
    const proto = BodyRoom.prototype as unknown as { _reserveSeat: (...a: unknown[]) => Promise<unknown> };
    const orig = proto._reserveSeat;
    proto._reserveSeat = async function (this: unknown, ...a: unknown[]) {
      await new Promise((ok) => setTimeout(ok, 100));
      return orig.apply(this, a);
    };
    return () => {
      proto._reserveSeat = orig;
    };
  }

  it("one account gets at most 2 unused seats from concurrent requests, within one body and across bodies", async () => {
    game = await startServer();
    const restore = slowReservations();
    try {
      const token = "dev:racer:racer:admin"; // admins may ask for any body
      const bodies = ["portus", "arcadia", "portus", "hollowmere", "meridian", "arcadia"];
      const results = await Promise.all(bodies.map((body) => post(game!.port, token, { body, v: PROTOCOL_VERSION })));
      expect(results.filter((r) => r.json.ok).length).toBeLessThanOrEqual(2);
      expect(results.filter((r) => r.json.ok).length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  it("one address gets at most 10 unused seats from concurrent requests", async () => {
    game = await startServer();
    const restore = slowReservations();
    try {
      const ip = { "x-real-ip": "203.0.113.77" };
      const results = await Promise.all(Array.from({ length: 16 }, (_, i) => post(game!.port, `dev:crowd${i}:crowd${i}`, { body: "portus", v: PROTOCOL_VERSION }, ip)));
      expect(results.filter((r) => r.json.ok).length).toBe(10);
    } finally {
      restore();
    }
  });

  it("a failed request frees its claim", async () => {
    game = await startServer({ globalCap: 0 }); // everyone is queued: no seat is ever reserved
    const ip = { "x-real-ip": "203.0.113.78" };
    for (let i = 0; i < 12; i++) {
      const r = await post(game.port, `dev:queued${i}:queued${i}`, { body: "portus", v: PROTOCOL_VERSION }, ip);
      expect("queue" in r.json).toBe(true);
    }
  });
});

describe("protocol version gate", () => {
  it("a client without the current protocol version is told to reload", async () => {
    game = await startServer();
    const stale = await post(game.port, "dev:stale:stale", { body: "portus" });
    expect(stale.status).toBe(409);
    expect(stale.json).toEqual({ ok: false, error: "version", version: PROTOCOL_VERSION });
    expect((await post(game.port, "dev:stale:stale", { body: "portus", v: PROTOCOL_VERSION - 1 })).json.error).toBe("version");
    expect((await post(game.port, "dev:stale:stale", { body: "portus", v: PROTOCOL_VERSION })).json.ok).toBe(true);
  });
});

