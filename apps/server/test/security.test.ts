// Security pass fixes (docs/reviews/2026-11-12-security-pass-gpt-6.1-sol.md, D-security-1…8): each
// block drives the real server in-process and fails on the code before its fix.

import type { Room } from "@colyseus/sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { Game } from "../src/app.ts";
import { isTestAccount } from "../src/db/index.ts";
import { BOT_BUDGET } from "../src/world/botBudget.ts";
import { api, Browser, play, startAuthServer, userIdOf, type AuthServer } from "./auth-helpers.ts";
import { joinAs, playRequest, safeLeave, startServer } from "./helpers.ts";

/** A load-test secret strong enough to switch the load-test features on (D-security-2). */
export const STRONG_SECRET = "lt-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH";

let game: Game | null = null;
let server: AuthServer | null = null;
const rooms: Room[] = [];
const budget = { ...BOT_BUDGET };

afterEach(async () => {
  for (const r of rooms.splice(0)) await safeLeave(r);
  await game?.close();
  game = null;
  await server?.close();
  server = null;
  Object.assign(BOT_BUDGET, budget);
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
