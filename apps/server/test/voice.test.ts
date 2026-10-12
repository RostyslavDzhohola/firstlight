// Proximity voice signalling (seam 1): the real server driven by SDK bots. Observable behaviour only:
// what each bot receives.

import type { Room } from "@colyseus/sdk";
import { BODIES, padDirs } from "@firstlight/shared";
import { PF } from "@firstlight/shared/net/schema";
import { VOICE } from "@firstlight/shared/net/voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Game } from "../src/app.ts";
import { isBlockedEitherWay, listReports, openGameDb, setGameDb, type Db } from "../src/db/index.ts";
import { env } from "../src/env.ts";
import { TURN_API } from "../src/world/voice/turn.ts";
import { joinAs, safeLeave, startServer, waitFor } from "./helpers.ts";

let game: Game;
const rooms: Room[] = [];
// Blocks and admin mutes outlive a room (per account), so every test uses fresh account ids.
let run = 0;
const uid = (name: string) => `${name}${run}`;

beforeEach(async () => {
  run++;
  game = await startServer();
});
afterEach(async () => {
  for (const r of rooms.splice(0)) await safeLeave(r);
  await game.close();
});

type Msg = { type: string; data: any };
const VOICE_TYPES = ["voice:ice", "voice:signal", "voice:drop", "voice:unreachable", "voice:denied", "radio:tuned", "voice:reported", "voice:blocked", "voice:muted"];
const inbox = new WeakMap<Room, Msg[]>();

/** Join as an admin bot (teleport/give) and record every voice message it receives. */
async function bot(name: string): Promise<Room> {
  const r = await joinAs(game, uid(name), "arcadia", {}, "admin");
  rooms.push(r);
  const box: Msg[] = [];
  inbox.set(r, box);
  for (const t of VOICE_TYPES) r.onMessage(t, (data: unknown) => box.push({ type: t, data }));
  r.onMessage("pong", (data: unknown) => box.push({ type: "pong", data }));
  for (const t of ["you", "toast", "denied", "phrase", "correct"]) r.onMessage(t, () => {});
  await waitFor(() => !!(r.state as any).players?.get(r.sessionId));
  return r;
}

const got = (r: Room, type: string) => inbox.get(r)!.filter((m) => m.type === type).map((m) => m.data);
const me = (r: Room) => (r.state as any).players.get(r.sessionId);

let pingSeq = 0;
/** Every message sent by `r` before this call has been handled, and everything the server wrote to `r` before it has arrived. */
async function barrier(...rs: Room[]) {
  for (const r of rs) {
    const t = ++pingSeq;
    r.send("ping", { t });
    await waitFor(() => got(r, "pong").some((p) => p.t === t));
  }
}

async function enable(...rs: Room[]) {
  for (const r of rs) r.send("voice:enable", { age16: true });
  await waitFor(() => rs.every((r) => got(r, "voice:ice").length > 0));
}

const OFFER = { type: "offer" as const, sdp: "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n" };

/** `from` sends one offer to `to`; resolves true if `to` received it (relayed). */
async function relays(from: Room, to: Room): Promise<boolean> {
  const before = got(to, "voice:signal").length;
  from.send("voice:signal", { to: to.sessionId, sdp: OFFER, candidates: [{ candidate: "candidate:1 1 udp 1 203.0.113.1 3478 typ relay", sdpMid: "0", sdpMLineIndex: 0 }] });
  await barrier(from, to);
  const after = got(to, "voice:signal");
  if (after.length === before) return false;
  const m = after[after.length - 1];
  expect(m.from).toBe(from.sessionId);
  expect(m.sdp).toEqual(OFFER);
  expect(m.candidates).toHaveLength(1);
  return true;
}

/** A surface point `metres` from Arcadia's main pad along a fixed tangent. */
function surface(metres: number): [number, number, number] {
  const R = BODIES.arcadia.radius;
  const d = padDirs(BODIES.arcadia)[0]!;
  const ref = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const k = ref[0]! * d[0] + ref[1]! * d[1] + ref[2]! * d[2];
  const t = [ref[0]! - k * d[0], ref[1]! - k * d[1], ref[2]! - k * d[2]];
  const tl = Math.hypot(t[0]!, t[1]!, t[2]!);
  const v = [d[0] + (t[0]! / tl) * (metres / R), d[1] + (t[1]! / tl) * (metres / R), d[2] + (t[2]! / tl) * (metres / R)];
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [(v[0]! / l) * R, (v[1]! / l) * R, (v[2]! / l) * R];
}

async function place(r: Room, metres: number) {
  const p = surface(metres);
  r.send("admin", { cmd: "teleport", args: { x: p[0], y: p[1], z: p[2] } });
  await barrier(r);
}

async function giveRadio(...rs: Room[]) {
  for (const r of rs) r.send("admin", { cmd: "give", args: { id: "radio" } });
  await barrier(...rs);
}

async function tune(r: Room, ch: number) {
  r.send("radio:tune", { ch });
  await barrier(r);
}

const dist = (a: Room, b: Room) => {
  const p = me(a), q = (a.state as any).players.get(b.sessionId);
  return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
};

describe("voice signalling relay", () => {
  it("relays offers and candidates between two enabled players in range", async () => {
    const a = await bot("ann"), b = await bot("ben");
    await enable(a, b);
    expect(got(a, "voice:ice")[0]).toMatchObject({ iceServers: [], relay: false, available: true }); // local dev: no TURN
    await waitFor(() => !!(me(a).flags & PF.VOICE) && !!((a.state as any).players.get(b.sessionId).flags & PF.VOICE));
    expect(await relays(a, b)).toBe(true);
    expect(await relays(b, a)).toBe(true);
    // A bare signal is a "please call me" ring, relayed too.
    b.send("voice:signal", { to: a.sessionId });
    await barrier(b, a);
    expect(got(a, "voice:signal").at(-1)).toEqual({ from: b.sessionId });
  });

  it("does not relay when either player has voice off", async () => {
    const a = await bot("ann"), b = await bot("ben");
    await enable(a);
    expect(await relays(a, b)).toBe(false);
    expect(got(a, "voice:unreachable")).toContainEqual({ peer: b.sessionId });
    await enable(b);
    expect(await relays(a, b)).toBe(true);
    b.send("voice:disable", {});
    await barrier(b, a);
    expect(got(a, "voice:drop")).toContainEqual({ peer: b.sessionId });
    expect(await relays(a, b)).toBe(false);
    expect(await relays(b, a)).toBe(false);
  });

  it("refuses to opt in without the 16+ declaration", async () => {
    const a = await bot("ann");
    a.send("voice:enable", { age16: false });
    await barrier(a);
    expect(got(a, "voice:denied")).toContainEqual({ action: "voice:enable", reason: "age" });
    expect(got(a, "voice:ice")).toHaveLength(0);
    expect(me(a).flags & PF.VOICE).toBe(0);
  });

  it("does not relay between players more than DROP metres apart", async () => {
    const a = await bot("ann"), b = await bot("ben");
    await enable(a, b);
    await place(a, 0);
    await place(b, 150);
    await waitFor(() => dist(a, b) > VOICE.DROP);
    expect(await relays(a, b)).toBe(false);
    expect(await relays(b, a)).toBe(false);
    await place(b, 30);
    await waitFor(() => dist(a, b) < VOICE.DROP);
    expect(await relays(a, b)).toBe(true);
  });

  it("does not relay once either player blocks the other, and tells both to hang up", async () => {
    const a = await bot("ann"), b = await bot("ben"), c = await bot("cat");
    await enable(a, b, c);
    expect(await relays(a, b)).toBe(true);
    b.send("voice:block", { target: a.sessionId });
    await barrier(b, a);
    expect(got(b, "voice:blocked")).toContainEqual({ target: a.sessionId });
    expect(got(b, "voice:drop")).toContainEqual({ peer: a.sessionId });
    expect(got(a, "voice:drop")).toContainEqual({ peer: b.sessionId });
    expect(await relays(a, b)).toBe(false); // blocked by the receiver
    expect(await relays(b, a)).toBe(false); // the blocker can't reach them either
    expect(await relays(a, c)).toBe(true); // everyone else is unaffected
  });

  it("does not relay to or from an admin-muted player", async () => {
    const a = await bot("ann"), b = await bot("ben");
    await enable(a, b);
    a.send("voice:mute", { target: b.sessionId, on: true }); // ann is an admin
    await barrier(a, b);
    expect(got(b, "voice:muted")).toContainEqual({ on: true });
    await waitFor(() => !!((a.state as any).players.get(b.sessionId).flags & PF.VOICE_MUTED));
    expect(await relays(a, b)).toBe(false);
    expect(await relays(b, a)).toBe(false);
    a.send("voice:mute", { target: b.sessionId, on: false });
    await barrier(a, b);
    expect(await relays(b, a)).toBe(true);
  });

  it("ignores voice mutes from non-admins", async () => {
    const a = await bot("ann");
    const b = await joinAs(game, uid("ben"), "arcadia"); // not an admin
    rooms.push(b);
    await waitFor(() => (a.state as any).players?.size === 2);
    b.send("voice:mute", { target: a.sessionId, on: true });
    b.send("ping", { t: 1 });
    await new Promise((r) => setTimeout(r, 150));
    expect(me(a).flags & PF.VOICE_MUTED).toBe(0);
  });

  it("rate-limits signal floods", async () => {
    const a = await bot("ann"), b = await bot("ben");
    await enable(a, b);
    for (let i = 0; i < 50; i++) a.send("voice:signal", { to: b.sessionId, candidate: { candidate: `candidate:${i}`, sdpMid: "0", sdpMLineIndex: 0 } });
    await barrier(a, b);
    const n = got(b, "voice:signal").length;
    expect(n).toBeGreaterThan(30);
    expect(n).toBeLessThan(50);
  });
});

describe("radio", () => {
  it("relays far apart on the same channel only when both own a radio and are tuned", async () => {
    const a = await bot("ann"), b = await bot("ben");
    await enable(a, b);
    await place(a, 0);
    await place(b, 200);
    await waitFor(() => dist(a, b) > VOICE.DROP);
    expect(await relays(a, b)).toBe(false);

    // Only ann has a radio: ben can't tune.
    await giveRadio(a);
    await tune(a, 3);
    await tune(b, 3);
    expect(got(a, "radio:tuned")).toContainEqual({ ch: 3 });
    expect(got(b, "voice:denied")).toContainEqual({ action: "radio:tune", reason: "no radio" });
    expect(await relays(a, b)).toBe(false);

    // Both own radios but on different channels.
    await giveRadio(b);
    await tune(b, 4);
    expect(await relays(a, b)).toBe(false);

    // Same channel: relayed at any distance, both ways.
    await tune(b, 3);
    await waitFor(() => (a.state as any).players.get(b.sessionId).radioCh === 3);
    expect(await relays(a, b)).toBe(true);
    expect(await relays(b, a)).toBe(true);

    // Tuning off ends it.
    await tune(b, 0);
    expect(await relays(a, b)).toBe(false);
  });

  it("caps a channel at 8 holders per room copy", async () => {
    const bots: Room[] = [];
    for (let i = 0; i < VOICE.RADIO_CAP + 1; i++) bots.push(await bot(`op${i}`));
    await giveRadio(...bots);
    for (const r of bots.slice(0, VOICE.RADIO_CAP)) await tune(r, 5);
    for (const r of bots.slice(0, VOICE.RADIO_CAP)) expect(got(r, "radio:tuned")).toContainEqual({ ch: 5 });
    const ninth = bots[VOICE.RADIO_CAP]!;
    await tune(ninth, 5);
    expect(got(ninth, "voice:denied")).toContainEqual({ action: "radio:tune", reason: "channel full" });
    expect(me(ninth).radioCh).toBe(0);
    await tune(ninth, 6); // other channels are free
    expect(got(ninth, "radio:tuned")).toContainEqual({ ch: 6 });
    await tune(bots[0]!, 0); // a slot frees up
    await tune(ninth, 5);
    expect(got(ninth, "radio:tuned")).toContainEqual({ ch: 5 });
  });

  it("refuses radio:tx without a radio, and allows it with one on a channel", async () => {
    const a = await bot("ann");
    await enable(a);
    a.send("radio:tx", { on: true });
    await barrier(a);
    expect(got(a, "voice:denied")).toContainEqual({ action: "radio:tx", reason: "no radio" });
    expect(me(a).flags & PF.RADIO_TX).toBe(0);

    await giveRadio(a);
    a.send("radio:tx", { on: true });
    await barrier(a);
    expect(got(a, "voice:denied")).toContainEqual({ action: "radio:tx", reason: "not tuned" });

    await tune(a, 2);
    a.send("radio:tx", { on: true });
    await barrier(a);
    await waitFor(() => !!(me(a).flags & PF.RADIO_TX));
    a.send("radio:tx", { on: false });
    await barrier(a);
    await waitFor(() => !(me(a).flags & PF.RADIO_TX));
  });
});

describe("voice safety persistence", () => {
  let db: Db;
  beforeEach(() => {
    db = openGameDb(":memory:");
    setGameDb(db);
  });
  afterEach(() => {
    setGameDb(null);
    db.close();
  });

  it("a block persists across a rejoin", async () => {
    const a = await bot("alice"), b = await bot("bob");
    await enable(a, b);
    expect(await relays(a, b)).toBe(true);
    a.send("voice:block", { target: b.sessionId });
    await barrier(a, b);
    expect(isBlockedEitherWay(db, uid("alice"), uid("bob"))).toBe(true);

    await safeLeave(a);
    rooms.splice(rooms.indexOf(a), 1);
    const a2 = await bot("alice");
    expect(a2.sessionId).not.toBe(a.sessionId);
    await enable(a2);
    expect(await relays(a2, b)).toBe(false);
    expect(await relays(b, a2)).toBe(false);
  });

  it("files a report with who, where and why (no audio)", async () => {
    const a = await bot("alice"), b = await bot("bob");
    b.send("voice:report", { target: a.sessionId, reason: "Harassment or bullying" });
    await barrier(b);
    expect(got(b, "voice:reported")).toContainEqual({ target: a.sessionId });
    const [r] = listReports(db);
    expect(r).toMatchObject({ reporter: uid("bob"), target: uid("alice"), body: "arcadia" });
    expect(r!.reason).toContain("Harassment or bullying");
    expect(r!.pos).toHaveLength(3);
    // The same target again within a minute is refused.
    b.send("voice:report", { target: a.sessionId, reason: "Other" });
    await barrier(b);
    expect(got(b, "voice:denied")).toContainEqual({ action: "voice:report", reason: "too many reports" });
    expect(listReports(db)).toHaveLength(1);
  });
});

describe("TURN credentials", () => {
  const saved = { id: env.turnKeyId, token: env.turnKeyToken };
  afterEach(() => {
    env.turnKeyId = saved.id;
    env.turnKeyToken = saved.token;
    vi.restoreAllMocks();
  });

  it("mints per-player relay credentials with the right request, filters STUN and :53, revokes on block and leave", async () => {
    env.turnKeyId = "key-123";
    env.turnKeyToken = "tok-secret";
    const realFetch = globalThis.fetch;
    const calls: { url: string; init: RequestInit }[] = [];
    let n = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith(TURN_API)) return realFetch(input as never, init);
      calls.push({ url, init: init ?? {} });
      if (url.endsWith("/revoke")) return new Response(null, { status: 204 });
      n++;
      return new Response(
        JSON.stringify({
          iceServers: [
            { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
            {
              urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:53?transport=udp", "turn:turn.cloudflare.com:3478?transport=tcp", "turns:turn.cloudflare.com:5349?transport=tcp", "turns:turn.cloudflare.com:443?transport=tcp"],
              username: `user-${n}`,
              credential: `cred-${n}`,
            },
          ],
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    });

    const a = await bot("ann"), b = await bot("ben");
    a.send("voice:enable", { age16: true });
    await waitFor(() => got(a, "voice:ice").length > 0);
    const mint = calls[0]!;
    expect(mint.url).toBe("https://rtc.live.cloudflare.com/v1/turn/keys/key-123/credentials/generate-ice-servers");
    expect(mint.init.method).toBe("POST");
    expect(new Headers(mint.init.headers).get("authorization")).toBe("Bearer tok-secret");
    expect(JSON.parse(String(mint.init.body))).toEqual({ ttl: VOICE.TURN_TTL_S });

    const ice = got(a, "voice:ice")[0];
    expect(ice.relay).toBe(true);
    expect(ice.available).toBe(true);
    const urls: string[] = ice.iceServers.flatMap((s: any) => s.urls);
    expect(urls.length).toBe(4);
    expect(urls.some((u) => u.startsWith("stun:"))).toBe(false);
    expect(urls.some((u) => /:53(\?|$)/.test(u))).toBe(false);
    expect(ice.iceServers[0]).toMatchObject({ username: "user-1", credential: "cred-1" });

    // Re-enabling inside the refresh window re-sends the same credential (no second mint).
    a.send("voice:enable", { age16: true });
    await waitFor(() => got(a, "voice:ice").length === 2);
    expect(calls.filter((c) => c.url.endsWith("generate-ice-servers"))).toHaveLength(1);

    // Blocking ann revokes her relay credential and hands her a fresh one.
    b.send("voice:enable", { age16: true });
    await waitFor(() => got(b, "voice:ice").length > 0);
    b.send("voice:block", { target: a.sessionId });
    await waitFor(() => calls.some((c) => c.url.endsWith("/credentials/user-1/revoke")));
    await waitFor(() => got(a, "voice:ice").length === 3);
    expect(got(a, "voice:ice")[2].iceServers[0].username).not.toBe("user-1");

    // Leaving revokes what is left.
    const benUser = got(b, "voice:ice")[0].iceServers[0].username;
    await safeLeave(b);
    rooms.splice(rooms.indexOf(b), 1);
    await waitFor(() => calls.some((c) => c.url.endsWith(`/credentials/${benUser}/revoke`)));
    const revoke = calls.find((c) => c.url.endsWith("/revoke"))!;
    expect(revoke.init.method).toBe("POST");
    expect(new Headers(revoke.init.headers).get("authorization")).toBe("Bearer tok-secret");
  });

  it("tells the client voice is unavailable when the relay can't be reached (never falls back to direct)", async () => {
    env.turnKeyId = "key-123";
    env.turnKeyToken = "tok-secret";
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(TURN_API)) return new Response("nope", { status: 500 });
      return realFetch(input as never, init);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await bot("ann");
    a.send("voice:enable", { age16: true });
    await waitFor(() => got(a, "voice:ice").length > 0);
    expect(got(a, "voice:ice")[0]).toMatchObject({ iceServers: [], relay: true, available: false });
    expect(warn.mock.calls.flat().join(" ")).not.toContain("tok-secret");
  });
});
