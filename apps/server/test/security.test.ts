// Security pass fixes (docs/reviews/2026-11-12-security-pass-gpt-6.1-sol.md, D-security-1…8): each
// block drives the real server in-process and fails on the code before its fix.

import type { Room } from "@colyseus/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@firstlight/shared/net/protocol";
import { PLAY_GATE } from "../src/world/playGate.ts";
import { banAccount } from "../src/social/moderation.ts";
import { PLAY_LIMITS, type Game } from "../src/app.ts";
import { isTestAccount } from "../src/db/index.ts";
import { BOT_BUDGET } from "../src/world/botBudget.ts";
import { TOOL_GUESSES } from "../src/auth/loadtest.ts";
import { NAME_LIMITS } from "../src/auth/nameLimits.ts";
import { ClaimLimiter } from "../src/auth/routes.ts";
import { WindowLimiter } from "../src/auth/limiter.ts";
import { api, Browser, decodeJwt, play, startAuthServer, userIdOf, type AuthServer } from "./auth-helpers.ts";
import { Client } from "@colyseus/sdk";
import { joinAs, playRequest, safeLeave, startServer, waitFor } from "./helpers.ts";
import { BODIES, isSafe } from "@firstlight/shared";
import { dealDamage } from "../src/world/combat.ts";
import { fakeWorld } from "./npcWorld.ts";

/** A load-test secret strong enough to switch the load-test features on (D-security-2). */
export const STRONG_SECRET = "lt-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH";

let game: Game | null = null;
let server: AuthServer | null = null;
const rooms: Room[] = [];
const budget = { ...BOT_BUDGET };
const guesses = { ...TOOL_GUESSES };
const gate = { ...PLAY_GATE };
const names = { ...NAME_LIMITS };

afterEach(async () => {
  for (const r of rooms.splice(0)) await safeLeave(r);
  await game?.close();
  game = null;
  await server?.close();
  server = null;
  Object.assign(BOT_BUDGET, budget);
  Object.assign(TOOL_GUESSES, guesses);
  Object.assign(PLAY_GATE, gate);
  Object.assign(NAME_LIMITS, names);
  vi.restoreAllMocks();
});

const bot = (id: string) => `dev:${id}:${id}:loadtest`;

describe("finding 1: load-test bots have finite budgets of their own", () => {
  it("caps how many bots are online, in every load-test room together", async () => {
    BOT_BUDGET.population = 2;
    game = await startServer();
    rooms.push(await joinAs(game, "lt_a", "arcadia", { loadtest: true }, "loadtest"));
    rooms.push(await joinAs(game, "lt_b", "hollowmere", { loadtest: true }, "loadtest"));
    expect(await playRequest(game, bot("lt_c"), { body: "arcadia", loadtest: true })).toEqual({ ok: false, error: "loadtest full" });
  });

  it("caps load-test copies per body and how fast they open", async () => {
    BOT_BUDGET.copiesPerBody = 1;
    game = await startServer({ maxClients: 1 });
    rooms.push(await joinAs(game, "lt_a", "arcadia", { loadtest: true }, "loadtest"));
    // The only copy is full: no second load-test copy of Arcadia.
    expect(await playRequest(game, bot("lt_b"), { body: "arcadia", loadtest: true })).toEqual({ ok: false, error: "loadtest full" });
    // Another body may open one, until the per-minute creation budget is spent.
    BOT_BUDGET.roomsPerMinute = 2;
    rooms.push(await joinAs(game, "lt_c", "hollowmere", { loadtest: true }, "loadtest"));
    expect(await playRequest(game, bot("lt_d"), { body: "portus", loadtest: true })).toEqual({ ok: false, error: "loadtest full" });
  });

  it("caps unused bot seats and bot play calls", async () => {
    BOT_BUDGET.seats = 2;
    game = await startServer();
    for (const id of ["lt_a", "lt_b"]) expect((await playRequest(game, bot(id), { body: "arcadia", loadtest: true })).ok).toBe(true);
    expect(await playRequest(game, bot("lt_c"), { body: "arcadia", loadtest: true })).toEqual({ ok: false, error: "slow down" });

    BOT_BUDGET.seats = 100;
    BOT_BUDGET.playCallsPer10s = 4; // 3 calls above (the refused one counts too)
    expect((await playRequest(game, bot("lt_d"), { body: "arcadia", loadtest: true })).ok).toBe(true);
    expect(await playRequest(game, bot("lt_e"), { body: "arcadia", loadtest: true })).toEqual({ ok: false, error: "slow down" });
  });

  it("limits how fast bot tokens are minted", async () => {
    BOT_BUDGET.tokensPer10s = 2;
    server = await startAuthServer({ loadtestSecret: STRONG_SECRET });
    const mint = () => api(server!, "/api/test/bot-token", null, { method: "POST", body: {}, headers: { "x-loadtest-secret": STRONG_SECRET } });
    expect((await mint()).status).toBe(200);
    expect((await mint()).status).toBe(200);
    expect((await mint()).status).toBe(429);
  });

  it("production needs LOADTEST_ENABLED=1 as well as the secret; flagging test guests doesn't", async () => {
    server = await startAuthServer({ production: true, rateLimit: false, loadtestSecret: STRONG_SECRET });
    const mint = () => api(server!, "/api/test/bot-token", null, { method: "POST", body: { id: "bot1" }, headers: { "x-loadtest-secret": STRONG_SECRET } });
    expect((await mint()).status).toBe(404);
    // Our tools' guests are still flagged as test accounts (D-home-6).
    const token = await new Browser(server).playToken();
    expect((await play(server, token, { body: "portus" }, { "x-loadtest-secret": STRONG_SECRET })).json.ok).toBe(true);
    expect(isTestAccount(server.accounts.db, userIdOf(token))).toBe(true);
    // /api/metrics is off too.
    const saved = { NODE_ENV: process.env.NODE_ENV, LOADTEST_SECRET: process.env.LOADTEST_SECRET, LOADTEST_ENABLED: process.env.LOADTEST_ENABLED };
    try {
      Object.assign(process.env, { NODE_ENV: "production", LOADTEST_SECRET: STRONG_SECRET });
      delete process.env.LOADTEST_ENABLED;
      expect((await api(server, "/api/metrics", null, { headers: { "x-loadtest-secret": STRONG_SECRET } })).status).toBe(403);
      process.env.LOADTEST_ENABLED = "1";
      expect((await api(server, "/api/metrics", null, { headers: { "x-loadtest-secret": STRONG_SECRET } })).status).toBe(200);
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await server.close();

    server = await startAuthServer({ production: true, rateLimit: false, loadtestSecret: STRONG_SECRET, loadtestEnabled: true });
    const r = await mint();
    expect(r.status).toBe(200);
    expect((await play(server, r.json.token, { body: "arcadia", loadtest: true })).json.ok).toBe(true);
  });
});

/** Run `fn` with these process env values, then put the old ones back. */
async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (v: Record<string, string | undefined>) => {
    for (const [k, x] of Object.entries(v)) if (x === undefined) delete process.env[k];
    else process.env[k] = x;
  };
  apply(vars);
  try {
    await fn();
  } finally {
    apply(saved);
  }
}

describe("finding 2: the load-test secret is strong and can't be guessed at speed", () => {
  const mint = (s: AuthServer, secret: string, ip: string) =>
    api(s, "/api/test/bot-token", null, { method: "POST", body: {}, headers: { "x-loadtest-secret": secret, "x-real-ip": ip } });

  it("a short secret switches bot tokens off (test guests are still flagged)", async () => {
    server = await startAuthServer({ loadtestSecret: "lt-secret" });
    expect((await mint(server, "lt-secret", "198.51.100.20")).status).toBe(404);
    const token = await new Browser(server).playToken();
    await api(server, "/api/account/me", token, { headers: { "x-loadtest-secret": "lt-secret" } });
    expect(isTestAccount(server.accounts.db, userIdOf(token))).toBe(true);
  });

  it("limits wrong guesses per address, before comparing, on bot tokens and metrics alike", async () => {
    TOOL_GUESSES.perIp = 3;
    server = await startAuthServer({ loadtestSecret: STRONG_SECRET });
    for (let i = 0; i < 3; i++) expect((await mint(server, `wrong-${i}`, "198.51.100.21")).status).toBe(403);
    // The right secret from that address is refused too now: nothing is compared any more.
    expect((await mint(server, STRONG_SECRET, "198.51.100.21")).status).toBe(429);
    await withEnv({ LOADTEST_SECRET: STRONG_SECRET, NODE_ENV: "test" }, async () => {
      expect((await api(server!, "/api/metrics", null, { headers: { "x-loadtest-secret": STRONG_SECRET, "x-real-ip": "198.51.100.21" } })).status).toBe(429);
      // Another address still gets in.
      expect((await api(server!, "/api/metrics", null, { headers: { "x-loadtest-secret": STRONG_SECRET, "x-real-ip": "198.51.100.22" } })).status).toBe(200);
    });
    expect((await mint(server, STRONG_SECRET, "198.51.100.22")).status).toBe(200);
  });

  it("limits wrong guesses overall, across addresses", async () => {
    TOOL_GUESSES.global = 4;
    server = await startAuthServer({ loadtestSecret: STRONG_SECRET });
    await withEnv({ LOADTEST_SECRET: STRONG_SECRET, NODE_ENV: "test" }, async () => {
      for (let i = 0; i < 4; i++) {
        const r = i % 2 ? await mint(server!, "wrong", `198.51.100.${30 + i}`) : await api(server!, "/api/metrics", null, { headers: { "x-loadtest-secret": "wrong", "x-real-ip": `198.51.100.${30 + i}` } });
        expect(r.status).toBe(403);
      }
    });
    expect((await mint(server, STRONG_SECRET, "198.51.100.40")).status).toBe(429);
  });
});

/** A raw /api/play request: any token, any JSON body, from a given client address. */
async function rawPlay(port: number, token: string, body: unknown, ip?: string) {
  const res = await fetch(`http://127.0.0.1:${port}/api/play`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(ip ? { "x-real-ip": ip } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("finding 3: /api/play spends a budget before verifying anything", () => {
  const good = { body: "portus", v: PROTOCOL_VERSION };

  it("checks the body and version before the token", async () => {
    game = await startServer();
    expect(await rawPlay(game.port, "not-a-token", { body: "nowhere", v: PROTOCOL_VERSION })).toEqual({ status: 400, json: { ok: false, error: "bad body" } });
    expect((await rawPlay(game.port, "not-a-token", { body: "portus", v: -1 })).status).toBe(409);
    expect((await rawPlay(game.port, "not-a-token", good)).status).toBe(401);
  });

  it("limits requests per address and overall, invalid tokens included", async () => {
    PLAY_GATE.ipCalls = 3;
    game = await startServer({}, { production: true });
    for (let i = 0; i < 3; i++) expect((await rawPlay(game.port, "bad", good, "203.0.113.50")).status).toBe(401);
    expect((await rawPlay(game.port, "bad", good, "203.0.113.50")).status).toBe(429);
    // A valid token from that address waits too; another address doesn't.
    expect((await rawPlay(game.port, "dev:gate1:gate1", good, "203.0.113.50")).status).toBe(429);
    expect((await rawPlay(game.port, "dev:gate1:gate1", good, "203.0.113.51")).json.ok).toBe(true);
    // IPv6 addresses share their /64.
    for (let i = 0; i < 3; i++) await rawPlay(game.port, "bad", good, `2001:db8:1:2::${i + 1}`);
    expect((await rawPlay(game.port, "bad", good, "2001:db8:1:2:ffff::9")).status).toBe(429);

    PLAY_GATE.ipCalls = 100;
    PLAY_GATE.globalCalls = 2; // already spent above
    expect((await rawPlay(game.port, "bad", good, "203.0.113.60")).status).toBe(429);
  });

  it("verifies a refused token once, and the explainer still says banned", async () => {
    server = await startAuthServer({ explain: true });
    const token = await new Browser(server).playToken();
    banAccount(userIdOf(token), "test", null);
    const spy = vi.spyOn(server.accounts.auth.api, "verifyJWT");
    const r = await play(server, token);
    expect(r).toEqual({ status: 403, json: { ok: false, error: "banned" } });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("finding 4: one trusted-proxy rule for client addresses", () => {
  const good = { body: "portus", v: PROTOCOL_VERSION };
  const limits = { ...PLAY_LIMITS };
  afterEach(() => Object.assign(PLAY_LIMITS, limits));
  const send = (port: number, token: string, headers: Record<string, string>) =>
    fetch(`http://127.0.0.1:${port}/api/play`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers }, body: JSON.stringify(good) }).then((r) => r.status);

  it("ignores X-Forwarded-For and invalid X-Real-IP on direct routes", async () => {
    PLAY_GATE.ipCalls = 2;
    game = await startServer({}, { production: true });
    expect(await send(game.port, "bad", { "x-forwarded-for": "203.0.113.1, 198.51.100.1" })).toBe(401);
    expect(await send(game.port, "bad", { "x-forwarded-for": "203.0.113.2, 198.51.100.2" })).toBe(401);
    expect(await send(game.port, "bad", { "x-forwarded-for": "203.0.113.3, 198.51.100.3" })).toBe(429);
    await game.close();
    game = await startServer({}, { production: true });
    expect(await send(game.port, "bad", { "x-real-ip": "not-an-ip-1" })).toBe(401);
    expect(await send(game.port, "bad", { "x-real-ip": "not-an-ip-2" })).toBe(401);
    expect(await send(game.port, "bad", { "x-real-ip": "not-an-ip-3" })).toBe(429);
  });

  it("limits loopback in production (not in development) and IPv6 per /64 after verification", async () => {
    PLAY_LIMITS.ipCalls = 2;
    game = await startServer({}, { production: true });
    expect(await send(game.port, "dev:lo1:lo1", {})).toBe(200);
    expect(await send(game.port, "dev:lo2:lo2", {})).toBe(200);
    expect(await send(game.port, "dev:lo3:lo3", {})).toBe(429);
    for (const [i, ip] of ["2001:db8:5:6::1", "2001:db8:5:6::2"].entries()) expect(await send(game.port, `dev:v6${i}:v6${i}`, { "x-real-ip": ip })).toBe(200);
    expect(await send(game.port, "dev:v6x:v6x", { "x-real-ip": "2001:db8:5:6:aaaa::3" })).toBe(429);
    await game.close();
    game = await startServer();
    for (const id of ["dv1", "dv2", "dv3"]) expect(await send(game.port, `dev:${id}:${id}`, {})).toBe(200);
  });
});

/** Try to use a reservation; resolves to the room, or null when the server refuses the seat. */
async function consume(base: string, reservation: unknown): Promise<Room | null> {
  try {
    const r = await new Client(base).consumeSeatReservation(reservation as never);
    rooms.push(r);
    let closed = false;
    r.onLeave(() => (closed = true));
    await new Promise((ok) => setTimeout(ok, 300));
    return closed ? null : r;
  } catch {
    return null;
  }
}

describe("finding 5: play tokens are bound to the session that issued them", () => {
  it("signing out one session kills its tokens and seats; another session of the account keeps working", async () => {
    server = await startAuthServer();
    const a = new Browser(server, "198.51.100.90");
    await a.playToken(); // a guest first, who then saves
    await a.saveWithEmail("twosessions@example.test", "Twosess");
    const b = new Browser(server, "198.51.100.91");
    await b.saveWithEmail("twosessions@example.test");
    const ta = await a.playToken();
    const tb = await b.playToken();
    expect(userIdOf(ta)).toBe(userIdOf(tb));
    expect(decodeJwt(ta).sid).toBeTruthy();
    const seat = await play(server, ta, { body: "portus" });
    expect(seat.json.ok).toBe(true);

    await a.client.signOut();
    expect((await api(server, "/api/account/me", ta)).status).toBe(401);
    expect((await play(server, ta, { body: "portus" })).status).toBe(401);
    // A seat reserved before signing out can't be used either, though the account has another session.
    expect(await consume(server.base, (seat.json as any).reservation)).toBeNull();

    expect((await api(server, "/api/account/me", tb)).status).toBe(200);
    expect((await play(server, tb, { body: "portus" })).json.ok).toBe(true);
  });

  it("a guest's token dies with its session", async () => {
    server = await startAuthServer();
    const g = new Browser(server, "198.51.100.92");
    const token = await g.playToken();
    expect((await api(server, "/api/account/me", token)).status).toBe(200);
    await g.client.signOut();
    expect((await api(server, "/api/account/me", token)).status).toBe(401);
  });
});

describe("finding 6: name changes are limited", () => {
  const setName = (token: string, name: string, ip = "198.51.100.120") => api(server!, "/api/account/name", token, { body: { name }, headers: { "x-real-ip": ip } });

  it("answers an unchanged name without a change, and makes the next change wait", async () => {
    server = await startAuthServer();
    const token = await new Browser(server).playToken();
    expect((await setName(token, "Alpha_1")).json).toEqual({ ok: true, name: "Alpha_1" });
    const spy = vi.spyOn((await server.accounts.auth.$context).internalAdapter, "updateUser");
    expect((await setName(token, " Alpha_1 ")).json).toEqual({ ok: true, name: "Alpha_1" });
    expect(spy).not.toHaveBeenCalled();
    const again = await setName(token, "Beta_1");
    expect(again.status).toBe(429);
    expect(again.json.ok).toBe(false);
  });

  it("limits attempts per account and per address", async () => {
    NAME_LIMITS.perAccount = 3;
    NAME_LIMITS.cooldownMs = 0;
    server = await startAuthServer();
    const a = await new Browser(server).playToken();
    for (const n of ["x", "Gamma_1", "y"]) expect((await setName(a, n)).status).not.toBe(429);
    expect((await setName(a, "Delta_1")).status).toBe(429);

    NAME_LIMITS.perAccount = 100;
    NAME_LIMITS.perIp = 2;
    const b = await new Browser(server).playToken();
    const c = await new Browser(server).playToken();
    expect((await setName(b, "Epsilon_1", "198.51.100.130")).json.ok).toBe(true);
    expect((await setName(c, "Zeta_1", "198.51.100.130")).json.ok).toBe(true);
    expect((await setName(c, "Eta_1", "198.51.100.130")).status).toBe(429);
    expect((await setName(c, "Eta_1", "198.51.100.131")).json.ok).toBe(true);
  });
});

describe("finding 7: facing is a unit vector", () => {
  it("input facing is normalised, and a zero-length facing is refused", async () => {
    game = await startServer();
    const r = await joinAs(game, "facer", "portus");
    rooms.push(r);
    const me = () => (r.state as any).players?.get(r.sessionId);
    await waitFor(() => !!me());
    const { x, y, z } = me();
    r.send("input", { seq: 1, x, y, z, fx: 1, fy: 1, fz: 1, anim: 0, t: Date.now() });
    await waitFor(() => Math.abs(me().fx - 1 / Math.sqrt(3)) < 0.01 && Math.abs(me().fz - 1 / Math.sqrt(3)) < 0.01);
    r.send("input", { seq: 2, x, y, z, fx: 0, fy: 0, fz: 0, anim: 0, t: Date.now() });
    r.send("input", { seq: 3, x, y, z, fx: 1, fy: 1, fz: 1, anim: 0, t: Date.now() });
    await waitFor(() => me().seq === 3);
    expect(Math.hypot(me().fx, me().fy, me().fz)).toBeCloseTo(1, 2);
  });

  it("the block arc uses the facing's direction, whatever its length", () => {
    const w = fakeWorld("arcadia", { immortal: true });
    const body = BODIES.arcadia;
    let at: [number, number, number] | null = null;
    for (let i = 0; i < 200 && !at; i++) {
      const a = i * 2.399, zc = 1 - (2 * (i + 0.5)) / 200, rr = Math.sqrt(1 - zc * zc);
      const p = w.world.snapToGround([Math.cos(a) * rr * body.radius, zc * body.radius, Math.sin(a) * rr * body.radius]);
      if (Math.hypot(...p) - body.radius > body.waterLevel + 0.3 && !isSafe(body, p[0], p[1], p[2])) at = p;
    }
    const p = w.addPlayer("blocker", at!, 10);
    p.char.hotbar[0] = { id: "sunbrand", tier: 1, qty: 1 };
    p.char.selected = 0;
    p.blocking = true;
    // An over-long facing (1,1,1); the blow comes 70° off it, outside the 60° block half-angle.
    p.state.fx = p.state.fy = p.state.fz = 1;
    const u = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)], v = [1 / Math.SQRT2, -1 / Math.SQRT2, 0];
    const c = Math.cos((70 * Math.PI) / 180), s = Math.sin((70 * Math.PI) / 180);
    const from: [number, number, number] = [c * u[0]! + s * v[0]!, c * u[1]! + s * v[1]!, c * u[2]! + s * v[2]!];
    const hp = p.state.hp;
    expect(dealDamage(w.world.host, null, p, 10, false, from)).toBe(true);
    expect(hp - p.state.hp).toBeCloseTo(10, 0); // not blocked (blocked: 3)
  });
});

describe("finding 8: the admin-claim limiter stays bounded", () => {
  it("refuses before remembering an address once the global budget is spent", () => {
    const l = new ClaimLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < ClaimLimiter.GLOBAL; i++) expect(l.take(`198.51.100.${i}`, t0)).toBe(true);
    for (let i = 0; i < 500; i++) expect(l.take(`203.0.113.${i % 250}-${i}`, t0 + 1)).toBe(false);
    expect(l.size).toBe(ClaimLimiter.GLOBAL);
  });

  it("forgets idle addresses on any call, refused ones included", () => {
    const l = new ClaimLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) l.take(`198.51.100.${i}`, t0);
    expect(l.size).toBe(5);
    expect(l.take("198.51.100.9", t0 + ClaimLimiter.PER_IP_WINDOW_MS + 1)).toBe(true);
    expect(l.size).toBe(1);
  });

  it("caps the addresses it remembers (the shared limiter refuses new keys past its cap)", () => {
    const l = new WindowLimiter(5, 60_000, 3);
    for (const k of ["a", "b", "c"]) expect(l.take(k, 0)).toBe(true);
    expect(l.take("d", 1)).toBe(false);
    l.add("e", 1);
    expect(l.size).toBe(3);
    expect(l.take("a", 2)).toBe(true); // known keys still count
    expect(l.take("d", 60_001)).toBe(true); // once the others idle out
    expect(l.size).toBe(2);
  });
});
