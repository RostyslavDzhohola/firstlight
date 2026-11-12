// Security pass fixes (docs/reviews/2026-11-12-security-pass-gpt-6.1-sol.md, D-security-1…8): each
// block drives the real server in-process and fails on the code before its fix.

import type { Room } from "@colyseus/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@firstlight/shared/net/protocol";
import { PLAY_GATE } from "../src/world/playGate.ts";
import { banAccount } from "../src/social/moderation.ts";
import type { Game } from "../src/app.ts";
import { isTestAccount } from "../src/db/index.ts";
import { BOT_BUDGET } from "../src/world/botBudget.ts";
import { TOOL_GUESSES } from "../src/auth/loadtest.ts";
import { api, Browser, play, startAuthServer, userIdOf, type AuthServer } from "./auth-helpers.ts";
import { joinAs, playRequest, safeLeave, startServer } from "./helpers.ts";

/** A load-test secret strong enough to switch the load-test features on (D-security-2). */
export const STRONG_SECRET = "lt-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH";

let game: Game | null = null;
let server: AuthServer | null = null;
const rooms: Room[] = [];
const budget = { ...BOT_BUDGET };
const guesses = { ...TOOL_GUESSES };
const gate = { ...PLAY_GATE };

afterEach(async () => {
  for (const r of rooms.splice(0)) await safeLeave(r);
  await game?.close();
  game = null;
  await server?.close();
  server = null;
  Object.assign(BOT_BUDGET, budget);
  Object.assign(TOOL_GUESSES, guesses);
  Object.assign(PLAY_GATE, gate);
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
