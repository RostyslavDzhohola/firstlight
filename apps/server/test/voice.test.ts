// Proximity voice signalling (seam 1): the real server driven by SDK bots. Observable behaviour only:
// what each bot receives.

import type { Room } from "@colyseus/sdk";
import { BODIES, padDirs } from "@firstlight/shared";
import { PF } from "@firstlight/shared/net/schema";
import { VOICE } from "@firstlight/shared/net/voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Game } from "../src/app.ts";
import { accountLinks } from "../src/auth/links.ts";
import { banUser, isBlockedEitherWay, listReports, openGameDb, setGameDb, type Db } from "../src/db/index.ts";
import { env } from "../src/env.ts";
import { liveRooms, SOCIAL_RULES } from "../src/social/index.ts";
import { revokeVoiceForUser, VOICE_LIMITS, VoiceSystem } from "../src/world/voice/index.ts";
import { TURN_API, turnCredentials } from "../src/world/voice/turn.ts";
import { joinAs, safeLeave, startServer, waitFor } from "./helpers.ts";

let game: Game;
const rooms: Room[] = [];
// Blocks and admin mutes outlive a room (per account), so every test uses fresh account ids.
let run = 0;
const uid = (name: string) => `${name}${run}`;

// No test may reach Cloudflare (or anything off this machine): TURN is unconfigured unless a test
// installs a stub, TURN calls go only to that stub, and any other non-local fetch is refused. Real
// TURN keys from the environment are never restored in this file (late revoke retries must not
// find them).
const realFetch = globalThis.fetch;
let turnStub: ((url: string, init: RequestInit) => Promise<Response>) | null = null;
function guardFetch() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(TURN_API)) {
      if (!turnStub) throw new Error("test made an unmocked TURN call");
      return turnStub(url, init ?? {});
    }
    const host = new URL(url).hostname;
    if (host !== "127.0.0.1" && host !== "localhost") throw new Error(`test refused a non-local fetch to ${host}`);
    return realFetch(input as never, init);
  });
}

// Voice is off in this build (FEATURE_VOICE unset, D-controls-1): these tests turn it on.
const voiceWas = env.voice;
beforeEach(async () => {
  run++;
  env.voice = true;
  env.turnKeyId = "";
  env.turnKeyToken = "";
  turnStub = null;
  guardFetch();
  game = await startServer();
});
afterEach(async () => {
  for (const r of rooms.splice(0)) await safeLeave(r);
  await game.close();
  env.voice = voiceWas;
  env.turnKeyId = "";
  env.turnKeyToken = "";
  turnStub = null;
  vi.restoreAllMocks();
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
  for (const t of ["you", "toast", "denied", "phrase", "correct", "social:blocked", "party:state", "kicked"]) r.onMessage(t, () => {});
  await waitFor(() => !!(r.state as any).players?.get(r.sessionId));
  return r;
}

const got = (r: Room, type: string) => inbox.get(r)!.filter((m) => m.type === type).map((m) => m.data);
const me = (r: Room) => (r.state as any).players.get(r.sessionId);

let pingSeq = 0;
const lastPing = new WeakMap<Room, number>();
/** Every message sent by `r` before this call has been handled, and everything the server wrote to `r` before it has arrived. */
async function barrier(...rs: Room[]) {
  for (const r of rs) {
    // Pings are capped per client (20/s): keep barriers under that.
    const wait = 60 - (Date.now() - (lastPing.get(r) ?? 0));
    if (wait > 0) await new Promise((ok) => setTimeout(ok, wait));
    lastPing.set(r, Date.now());
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

  it("ignores signals to ids that aren't in the room (no reply, no relay)", async () => {
    const a = await bot("ann");
    await enable(a);
    for (let i = 0; i < 5; i++) a.send("voice:signal", { to: `ghost-${i}`, sdp: OFFER });
    await barrier(a);
    expect(got(a, "voice:unreachable")).toHaveLength(0);
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

  it("a block from the player list (social:block) also stops voice relay", async () => {
    const a = await bot("ann"), b = await bot("ben");
    await enable(a, b);
    expect(await relays(a, b)).toBe(true);
    b.send("social:block", { target: a.sessionId });
    await barrier(b);
    expect(await relays(a, b)).toBe(false);
    expect(await relays(b, a)).toBe(false);
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

describe("blocks from the Tab list", () => {
  it("hang up both voice clients, like a block from the voice panel", async () => {
    const a = await bot("tabblocker");
    const b = await bot("tabblocked");
    await waitFor(() => (a.state as any).players.size >= 2);
    a.send("social:block", { target: b.sessionId, on: true });
    await waitFor(() => got(a, "voice:drop").some((m) => m.peer === b.sessionId));
    await waitFor(() => got(b, "voice:drop").some((m) => m.peer === a.sessionId));
  });

  it("the voice panel's block shares the Tab list's block-list cap", async () => {
    const saved = SOCIAL_RULES.MAX_BLOCKS;
    SOCIAL_RULES.MAX_BLOCKS = 1;
    try {
      const a = await bot("ann"), b = await bot("ben"), c = await bot("cat");
      a.send("voice:block", { target: b.sessionId });
      await barrier(a);
      expect(got(a, "voice:blocked")).toContainEqual({ target: b.sessionId });
      a.send("voice:block", { target: c.sessionId });
      await barrier(a);
      expect(got(a, "voice:denied")).toContainEqual({ action: "voice:block", reason: "your block list is full" });
      expect(got(a, "voice:blocked")).not.toContainEqual({ target: c.sessionId });
    } finally {
      SOCIAL_RULES.MAX_BLOCKS = saved;
    }
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

  it("report limits are per account: a rejoin doesn't reset them, and Tab-list reports share them (F12 should-fix 15)", async () => {
    const bob = await bot("bob");
    const [ann, cat, dan, eve, fay, gus] = [await bot("ann"), await bot("cat"), await bot("dan"), await bot("eve"), await bot("fay"), await bot("gus")];
    bob.send("voice:report", { target: ann!.sessionId, reason: "Other" });
    await barrier(bob);
    expect(got(bob, "voice:reported")).toHaveLength(1);

    const rejoin = async (r: Room) => {
      await safeLeave(r);
      rooms.splice(rooms.indexOf(r), 1);
      return bot("bob");
    };
    const bob2 = await rejoin(bob);
    bob2.send("voice:report", { target: ann!.sessionId, reason: "Other" });
    await barrier(bob2);
    expect(got(bob2, "voice:denied")).toContainEqual({ action: "voice:report", reason: "too many reports" });

    // One budget of five per 10 minutes across the Tab list and the voice panel.
    bob2.send("report", { target: cat!.sessionId, reason: "harassment" });
    for (const t of [dan!, eve!, fay!]) bob2.send("voice:report", { target: t.sessionId, reason: "Other" });
    await barrier(bob2);
    expect(listReports(db)).toHaveLength(5);
    const bob3 = await rejoin(bob2);
    bob3.send("voice:report", { target: gus!.sessionId, reason: "Other" });
    await barrier(bob3);
    expect(got(bob3, "voice:denied")).toContainEqual({ action: "voice:report", reason: "too many reports" });
    expect(listReports(db)).toHaveLength(5);
  });
});

describe("TURN credentials", () => {
  let calls: { url: string; init: RequestInit }[];
  /** Mock Cloudflare: mint returns user-<n>; `revokeStatus` decides each revoke's HTTP status. */
  function mockTurn(opts: { mintStatus?: number | (() => number); revokeStatus?: () => number } = {}) {
    env.turnKeyId = "key-123";
    env.turnKeyToken = "tok-secret";
    calls = [];
    let n = 0;
    turnStub = async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/revoke")) return new Response(null, { status: opts.revokeStatus?.() ?? 204 });
      const mintStatus = typeof opts.mintStatus === "function" ? opts.mintStatus() : opts.mintStatus;
      if (mintStatus && mintStatus !== 201) return new Response("nope", { status: mintStatus });
      n++;
      return new Response(
        JSON.stringify({
          iceServers: [
            { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
            {
              urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:53?transport=udp", "turn:turn.cloudflare.com:3478?transport=tcp", "turns:turn.cloudflare.com:5349?transport=tcp", "turns:turn.cloudflare.com:443?transport=tcp"],
              username: `user-${n}-${run}`,
              credential: `cred-${n}`,
            },
          ],
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    };
  }
  const mintCalls = () => calls.filter((c) => c.url.endsWith("generate-ice-servers"));
  const revokes = (user: string) => calls.filter((c) => c.url.endsWith(`/credentials/${user}/revoke`));


  it("mints per-player relay credentials with the right request, filters STUN and :53, revokes on block and leave", async () => {
    mockTurn();
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
    const annUser = ice.iceServers[0].username;
    expect(ice.iceServers[0]).toMatchObject({ username: `user-1-${run}`, credential: "cred-1" });

    // Re-enabling inside the refresh window re-sends the same credential (no second mint).
    a.send("voice:enable", { age16: true });
    await waitFor(() => got(a, "voice:ice").length === 2);
    expect(mintCalls()).toHaveLength(1);

    // Blocking ann (who was talking to ben) revokes her relay credential and hands her a fresh one.
    b.send("voice:enable", { age16: true });
    await waitFor(() => got(b, "voice:ice").length > 0);
    expect(await relays(a, b)).toBe(true);
    b.send("voice:block", { target: a.sessionId });
    await waitFor(() => revokes(annUser).length > 0);
    await waitFor(() => got(a, "voice:ice").length === 3);
    expect(got(a, "voice:ice")[2].iceServers[0].username).not.toBe(annUser);

    // Leaving revokes what is left.
    const benUser = got(b, "voice:ice")[0].iceServers[0].username;
    await safeLeave(b);
    rooms.splice(rooms.indexOf(b), 1);
    await waitFor(() => revokes(benUser).length > 0);
    const revoke = revokes(benUser)[0]!;
    expect(revoke.init.method).toBe("POST");
    expect(new Headers(revoke.init.headers).get("authorization")).toBe("Bearer tok-secret");
  });

  it("keeps a credential whose revocation failed, so the next attempt retries it", async () => {
    let status = 503;
    mockTurn({ revokeStatus: () => status });
    const a = await bot("ann");
    await enable(a);
    const user = got(a, "voice:ice")[0].iceServers[0].username;
    expect(await revokeVoiceForUser(uid("ann"))).toBe(0);
    expect(revokes(user)).toHaveLength(1);
    status = 204;
    expect(await revokeVoiceForUser(uid("ann"))).toBe(1);
    expect(revokes(user)).toHaveLength(2);
    expect(await revokeVoiceForUser(uid("ann"))).toBe(0); // nothing left to revoke
    expect(revokes(user)).toHaveLength(2);
  });

  it("credentials follow the account when a guest saves", async () => {
    mockTurn();
    // Registry level: a credential minted for the guest is revoked by the account's id afterwards.
    turnCredentials.remember(uid("gus"), [`gus-user-${run}`]);
    turnCredentials.rekey(uid("gus"), uid("gus-acct"));
    expect(await revokeVoiceForUser(uid("gus"))).toBe(0);
    expect(await revokeVoiceForUser(uid("gus-acct"))).toBe(1);
    // In a room the merged guest session is retired (it rejoins as the account): its leave hook
    // revokes the credential exactly once (F12 B4) and nothing is left under either id.
    const a = await bot("ann");
    await enable(a);
    const user = got(a, "voice:ice")[0].iceServers[0].username;
    accountLinks.emit({ fromUserId: uid("ann"), toUserId: uid("acct"), name: "ann", character: "guest", merged: false, moved: null, displaced: null });
    await waitFor(() => revokes(user).length === 1);
    expect(await revokeVoiceForUser(uid("ann"))).toBe(0);
    expect(await revokeVoiceForUser(uid("acct"))).toBe(0);
    expect(revokes(user)).toHaveLength(1);
  });

  it("a ban ends the player's voice and revokes their relay credentials", async () => {
    mockTurn();
    const db = openGameDb(":memory:");
    setGameDb(db);
    try {
      const a = await bot("ann"), b = await bot("ben");
      await enable(a, b);
      const user = got(a, "voice:ice")[0].iceServers[0].username;
      banUser(db, { userId: uid("ann"), ipHash: null, reason: "test" });
      await waitFor(() => revokes(user).length > 0, 3000);
      await waitFor(() => got(b, "voice:drop").some((d) => d.peer === a.sessionId));
      await waitFor(() => !(me(a).flags & PF.VOICE));
      expect(await relays(b, a)).toBe(false);
      // Re-enabling is refused and mints nothing.
      const mintsBefore = mintCalls().length;
      a.send("voice:enable", { age16: true });
      await barrier(a);
      expect(got(a, "voice:denied")).toContainEqual({ action: "voice:enable", reason: "banned" });
      expect(me(a).flags & PF.VOICE).toBe(0);
      expect(mintCalls()).toHaveLength(mintsBefore);
    } finally {
      setGameDb(null);
      db.close();
    }
  });

  it("an admin ban from the player list revokes the banned player's relay credentials", async () => {
    mockTurn();
    const a = await bot("ann"), b = await bot("ben");
    await enable(b);
    const user = got(b, "voice:ice")[0].iceServers[0].username;
    a.send("mod", { action: "ban", target: b.sessionId, reason: "test" }); // ann is an admin
    await waitFor(() => revokes(user).length > 0);
    rooms.splice(rooms.indexOf(b), 1);
  });

  it("tells the client voice is unavailable when the relay can't be reached, and backs off (never falls back to direct)", async () => {
    mockTurn({ mintStatus: 500 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = await bot("ann");
    a.send("voice:enable", { age16: true });
    await waitFor(() => got(a, "voice:ice").length > 0);
    expect(got(a, "voice:ice")[0]).toMatchObject({ iceServers: [], relay: true, available: false });
    expect(warn.mock.calls.flat().join(" ")).not.toContain("tok-secret");
    // Asking again right away doesn't hit the TURN API again.
    a.send("voice:enable", { age16: true });
    await waitFor(() => got(a, "voice:ice").length === 2);
    expect(got(a, "voice:ice")[1]).toMatchObject({ available: false });
    expect(mintCalls()).toHaveLength(1);
  });

  const userOf = (r: Room, i = 0) => got(r, "voice:ice")[i].iceServers[0].username as string;
  const unavailable = (r: Room) => got(r, "voice:ice").filter((m) => !m.available);

  it("repeated blocks from someone who never talked to you don't touch your relay credentials (F12 B1)", async () => {
    mockTurn();
    const vic = await bot("vic"), eve = await bot("eve"); // eve never enables voice
    await enable(vic);
    const cred = userOf(vic);
    for (let i = 0; i < 11; i++) eve.send("social:block", { target: vic.sessionId, on: true });
    for (let i = 0; i < 3; i++) {
      eve.send("social:block", { target: vic.sessionId, on: false });
      eve.send("social:block", { target: vic.sessionId, on: true });
    }
    eve.send("voice:block", { target: vic.sessionId });
    await barrier(eve, vic);
    await barrier(vic);
    expect(revokes(cred)).toHaveLength(0);
    expect(mintCalls()).toHaveLength(1);
    expect(got(vic, "voice:ice")).toHaveLength(1);
    expect(unavailable(vic)).toHaveLength(0);
  });

  it("a block between players who talked rotates the blocked player's credential once per 10 minutes, outside their mint budget (F12 B1)", async () => {
    mockTurn();
    const vic = await bot("vic"), eve = await bot("eve");
    await enable(vic, eve);
    expect(await relays(eve, vic)).toBe(true);
    const cred = userOf(vic);
    eve.send("social:block", { target: vic.sessionId, on: true });
    await waitFor(() => got(vic, "voice:ice").length === 2);
    await waitFor(() => revokes(cred).length === 1);
    expect(userOf(vic, 1)).not.toBe(cred);

    // Blocking again, unblocking and re-blocking (Tab list or voice panel) rotates nothing more.
    for (let i = 0; i < 5; i++) eve.send("social:block", { target: vic.sessionId, on: true });
    for (let i = 0; i < 4; i++) {
      eve.send("social:block", { target: vic.sessionId, on: false });
      eve.send("social:block", { target: vic.sessionId, on: true });
    }
    eve.send("social:block", { target: vic.sessionId, on: false });
    eve.send("voice:block", { target: vic.sessionId });
    await barrier(eve, vic);
    await barrier(vic);
    expect(got(vic, "voice:ice")).toHaveLength(2);
    expect(unavailable(vic)).toHaveLength(0);
    expect(mintCalls()).toHaveLength(3); // vic, eve, one rotation

    // The rotation was not charged to vic: the enable used 1 of 10, so 9 more mints are allowed.
    for (let i = 0; i < 9; i++) expect(turnCredentials.allowMint(uid("vic"))).toBe(true);
    expect(turnCredentials.allowMint(uid("vic"))).toBe(false);
  });

  it("a rotation that can't mint keeps the blocked player's working credential (F12 B1)", async () => {
    let mintStatus = 201;
    mockTurn({ mintStatus: () => mintStatus });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const vic = await bot("vic"), eve = await bot("eve");
    await enable(vic, eve);
    expect(await relays(eve, vic)).toBe(true);
    const cred = userOf(vic);
    mintStatus = 500;
    eve.send("voice:block", { target: vic.sessionId });
    await waitFor(() => mintCalls().length === 3);
    await waitFor(() => warn.mock.calls.length > 0);
    await barrier(vic);
    expect(revokes(cred)).toHaveLength(0);
    expect(unavailable(vic)).toHaveLength(0);
    expect(got(vic, "voice:ice")).toHaveLength(1);
  });

  it("a second blocker inside the 10-minute rotation cooldown gets the hang-up and the relay cutoff, but no second revocation", async () => {
    // Documented limit (F12 review nit): the server cutoff for the second pair is signalling refusal
    // plus voice:drop to both clients; an honest blocker closes its own connection. Revoking again
    // would need revocation scoped to one pair's allocation, which TURN credentials don't offer.
    mockTurn();
    const vic = await bot("vic"), eve = await bot("eve"), ann = await bot("ann");
    await enable(vic, eve, ann);
    expect(await relays(eve, vic)).toBe(true);
    eve.send("voice:block", { target: vic.sessionId });
    await waitFor(() => got(vic, "voice:ice").length === 2);
    const rotated = userOf(vic, 1);
    expect(await relays(ann, vic)).toBe(true); // ann links up with vic on the new credential
    ann.send("voice:block", { target: vic.sessionId });
    await barrier(ann, vic);
    await barrier(vic);
    expect(got(ann, "voice:drop")).toContainEqual({ peer: vic.sessionId });
    expect(got(vic, "voice:drop")).toContainEqual({ peer: ann.sessionId });
    expect(await relays(ann, vic)).toBe(false);
    expect(await relays(vic, ann)).toBe(false);
    expect(revokes(rotated)).toHaveLength(0);
    expect(got(vic, "voice:ice")).toHaveLength(2);
  });

  it("a failed 6-hour refresh is retried after TURN_RETRY_MS instead of being postponed by every tick", async () => {
    const savedRetry = VOICE_LIMITS.TURN_RETRY_MS;
    VOICE_LIMITS.TURN_RETRY_MS = 2_500; // longer than the 1 s slow tick, like the real 30 s
    try {
      let mintStatus = 201;
      mockTurn({ mintStatus: () => mintStatus });
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const vic = await bot("vic");
      await enable(vic);
      const voice = [...liveRooms].flatMap((r) => r.systems).find((s): s is VoiceSystem => s instanceof VoiceSystem && s.sessions.has(vic.sessionId))!;
      mintStatus = 500;
      voice.sessions.get(vic.sessionId)!.mintedAt -= VOICE.REMINT_MS;
      await waitFor(() => mintCalls().length === 2, 4000); // the refresh failed
      mintStatus = 201;
      await waitFor(() => got(vic, "voice:ice").length === 2, 8000); // retried and recovered
      expect(got(vic, "voice:ice")[1]).toMatchObject({ available: true });
      expect(mintCalls()).toHaveLength(3);
      expect(unavailable(vic)).toHaveLength(0);
    } finally {
      VOICE_LIMITS.TURN_RETRY_MS = savedRetry;
    }
  });

  it("a failed 6-hour re-mint keeps credentials that are still valid, and drops them once expired", async () => {
    let mintStatus = 201;
    mockTurn({ mintStatus: () => mintStatus });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const vic = await bot("vic");
    await enable(vic);
    const voice = [...liveRooms].flatMap((r) => r.systems).find((s): s is VoiceSystem => s instanceof VoiceSystem && s.sessions.has(vic.sessionId))!;
    const session = voice.sessions.get(vic.sessionId)!;
    mintStatus = 500;
    session.mintedAt -= VOICE.REMINT_MS; // the 6-hour refresh is due
    await waitFor(() => mintCalls().length === 2, 4000);
    await barrier(vic);
    expect(unavailable(vic)).toHaveLength(0);
    expect(session.ice).not.toBeNull();
    session.mintedAt -= VOICE.TURN_TTL_S * 1000; // now past its lifetime
    await waitFor(() => unavailable(vic).length === 1, 4000);
    expect(session.ice).toBeNull();
  });
});

describe("voice off (this build: FEATURE_VOICE unset, D-controls-1)", () => {
  it("no voice system: requests are refused with \"off\", nothing is relayed, no TURN credential is minted, nobody is dropped", async () => {
    env.voice = false;
    env.turnKeyId = "key-123"; // a configured relay must still never be asked for credentials
    env.turnKeyToken = "tok-secret";
    const turnCalls: string[] = [];
    turnStub = async (url) => (turnCalls.push(url), new Response(null, { status: 500 }));
    const ann = await bot("quiet_ann");
    const ben = await bot("quiet_ben");
    await waitFor(() => (ann.state as any).players.size === 2);
    expect([...liveRooms].flatMap((r) => r.systems).some((s) => s instanceof VoiceSystem)).toBe(false);
    for (const type of ["voice:enable", "radio:tune", "radio:tx", "voice:block", "voice:report", "voice:mute"] as const) {
      const msg = { "voice:enable": { age16: true }, "radio:tune": { ch: 3 }, "radio:tx": { on: true }, "voice:block": { target: ben.sessionId }, "voice:report": { target: ben.sessionId, reason: "Other" }, "voice:mute": { target: ben.sessionId, on: true } }[type];
      ann.send(type, msg);
    }
    expect(await relays(ann, ben)).toBe(false);
    ann.send("voice:disable", {});
    await barrier(ann, ben);
    expect(got(ann, "voice:denied").map((d) => d.action)).toEqual(["voice:enable", "radio:tune", "radio:tx", "voice:block", "voice:report", "voice:mute"]);
    expect(got(ann, "voice:denied").every((d) => d.reason === "off")).toBe(true);
    expect(got(ann, "voice:ice")).toEqual([]);
    expect(turnCalls).toEqual([]);
    expect(me(ann).flags & (PF.VOICE | PF.RADIO_TX)).toBe(0);
    expect(me(ann).radioCh ?? 0).toBe(0);
    expect(ann.connection.isOpen && ben.connection.isOpen).toBe(true);
  });
});
