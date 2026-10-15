// Home page data (6a, 6f): the public leaderboard reads, the DataFast visit counts (cached, key kept
// on the server) and GET /api/home (online names per body, rate limit).

import type { Room } from "@colyseus/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newCharacter } from "@firstlight/shared/content/character";
import type { HomeData } from "@firstlight/shared/net/home";
import type { Game } from "../src/app.ts";
import { awardMedal, banUser, claimFirst, ensureAccount, medalLeaders, openGameDb, setDisplayName, setTitleMedal, topLevels, type Db } from "../src/db/index.ts";
import { dataFastVisits } from "../src/ops/datafast.ts";
import { HOME_LIMITS, mountHome, onlineSnapshot, readBoard } from "../src/ops/home.ts";
import { SqliteCharacterRepo } from "../src/world/sqliteStores.ts";
import { joinAs, safeLeave, startServer, waitFor } from "./helpers.ts";

function seed(db: Db, userId: string, name: string | null, level: number, xp = 0, extra: { dead?: boolean; starter?: number } = {}) {
  ensureAccount(db, userId);
  if (name) expect(setDisplayName(db, userId, name)).toMatchObject({ ok: true });
  const c = newCharacter(extra.starter ?? 0, 0);
  c.level = level;
  c.xp = xp;
  if (extra.dead) c.dead = true;
  new SqliteCharacterRepo(db).save(userId, c);
}

describe("leaderboard reads", () => {
  let db: Db;
  beforeEach(() => {
    db = openGameDb(":memory:");
  });
  afterEach(() => db.close());

  it("ranks live, named, unbanned characters by level then XP", () => {
    seed(db, "u1", "Wren_07", 7, 100, { starter: 3 });
    seed(db, "u2", "Mossback", 9, 0, { starter: 1 });
    seed(db, "u3", "Ashfall", 7, 400);
    seed(db, "u4", null, 20); // never picked a name: not listed
    seed(db, "u5", "Ghost", 15, 0, { dead: true }); // waiting to be reborn: not listed
    seed(db, "u6", "Cheater", 18);
    banUser(db, { userId: "u6", ipHash: null });
    seed(db, "u7", "Pardoned", 2);
    banUser(db, { userId: "u7", ipHash: null, until: Date.now() - 1000 }); // expired ban
    expect(topLevels(db).map((r) => [r.name, r.level])).toEqual([
      ["Mossback", 9],
      ["Ashfall", 7],
      ["Wren_07", 7],
      ["Pardoned", 2],
    ]);
    expect(topLevels(db, 2)).toHaveLength(2);
    const board = readBoard(db);
    expect(board.levels[0]).toEqual({ name: "Mossback", level: 9, starter: 1, title: null });
    expect(board.levels[2]).toMatchObject({ name: "Wren_07", starter: 3 });
    // Nothing but names, levels, starters and titles leaves the server.
    expect(Object.keys(board.levels[0]!).sort()).toEqual(["level", "name", "starter", "title"]);
  });

  it("counts medals per named account, shows the worn title, and lists the Hall of Firsts", () => {
    seed(db, "u1", "Wren_07", 3);
    seed(db, "u2", "Mossback", 3);
    seed(db, "u3", null, 3);
    awardMedal(db, "u1", "spark", 1000);
    awardMedal(db, "u1", "ten_down", 2000);
    awardMedal(db, "u2", "spark", 500);
    awardMedal(db, "u2", "grand_tour", 900);
    awardMedal(db, "u2", "regicide", 1500);
    awardMedal(db, "u3", "spark", 100);
    awardMedal(db, "u3", "ten_down", 100);
    awardMedal(db, "u3", "grand_tour", 100);
    expect(setTitleMedal(db, "u2", "regicide")).toBe(true);
    expect(medalLeaders(db).map((r) => [r.name, r.medals])).toEqual([
      ["Mossback", 3],
      ["Wren_07", 2],
    ]);
    claimFirst(db, "E2", "u1", "Wren_07", 5000);
    claimFirst(db, "boss:tidewrath", "u2", "Mossback", 4000);
    const board = readBoard(db);
    expect(board.medals[0]).toEqual({ name: "Mossback", medals: 3, title: "Regicide" });
    expect(board.hall).toEqual([
      { id: "boss:tidewrath", name: "Mossback", foundAt: 4000 },
      { id: "E2", name: "Wren_07", foundAt: 5000 },
    ]);
  });
});

describe("DataFast visit counts", () => {
  const ok = (data: unknown) => new Response(JSON.stringify({ status: "success", data: [data] }), { status: 200, headers: { "content-type": "application/json" } });

  it("is off without a key and never calls out", async () => {
    const fetch = vi.fn();
    const v = dataFastVisits({ apiKey: "  ", fetch: fetch as never });
    expect(v.configured).toBe(false);
    expect(await v.get()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads realtime visitors and all-time visits with the key, then caches them for a minute", async () => {
    let t = 1_000_000;
    const urls: string[] = [];
    const auth: string[] = [];
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      urls.push(url);
      auth.push((init.headers as Record<string, string>).Authorization!);
      return url.includes("/realtime") ? ok({ visitors: 7 }) : ok({ visitors: 900, sessions: 1234, pageviews: 5000 });
    });
    const v = dataFastVisits({ apiKey: "df_secret", fetch: fetch as never, now: () => t, ttlMs: 5_000 /* raised to 60 s */ });
    expect(v.configured).toBe(true);
    const [a, b] = await Promise.all([v.get(), v.get()]); // one request pair for concurrent callers
    expect(a).toEqual({ online: 7, total: 1234 });
    expect(b).toEqual(a);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(urls.sort()).toEqual(["https://datafa.st/api/v1/analytics/overview?fields=visitors,sessions", "https://datafa.st/api/v1/analytics/realtime?fields=visitors"]);
    expect(auth).toEqual(["Bearer df_secret", "Bearer df_secret"]);
    t += 59_000;
    await v.get();
    expect(fetch).toHaveBeenCalledTimes(2);
    t += 2_000;
    await v.get();
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("keeps the last numbers when DataFast fails, and doesn't retry for a minute", async () => {
    let t = 0;
    let fail = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fetch = vi.fn(async (url: string) => (fail ? new Response("nope", { status: 500 }) : url.includes("/realtime") ? ok({ visitors: 3 }) : ok({ visitors: 10 })));
      const v = dataFastVisits({ apiKey: "df_x", fetch: fetch as never, now: () => t });
      expect(await v.get()).toEqual({ online: 3, total: 10 }); // no sessions field: visitors
      fail = true;
      t += 61_000;
      expect(await v.get()).toEqual({ online: 3, total: 10 });
      const calls = fetch.mock.calls.length;
      t += 30_000;
      await v.get();
      expect(fetch.mock.calls.length).toBe(calls);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).not.toContain("df_x");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("GET /api/home", () => {
  let game: Game | null = null;
  let db: Db | null = null;
  const rooms: Room[] = [];

  afterEach(async () => {
    for (const r of rooms.splice(0)) await safeLeave(r);
    await game?.close();
    game = null;
    db?.close();
    db = null;
  });

  async function home(ip = "203.0.113.9"): Promise<{ status: number; body: HomeData; headers: Headers }> {
    const res = await fetch(`http://127.0.0.1:${game!.port}/api/home`, { headers: { Origin: "http://localhost:5173", "X-Real-IP": ip } });
    return { status: res.status, body: (await res.json()) as HomeData, headers: res.headers };
  }

  it("serves who's online per body with names, the leaderboard, and no visits without DataFast", async () => {
    db = openGameDb(":memory:");
    seed(db, "lead", "Topper", 12);
    const gdb = db;
    game = await startServer({}, { mountAfterJson: (app) => mountHome(app, { db: gdb }) });
    rooms.push(await joinAs(game, "pa", "portus", {}, "", false));
    rooms.push(await joinAs(game, "pb", "arcadia"));
    rooms.push(await joinAs(game, "bot1", "arcadia", { loadtest: true }, "loadtest"));
    await waitFor(() => true, 10);
    const r = await home();
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(r.body.online.total).toBe(2);
    expect(r.body.online.bodies.portus).toEqual({ players: 1, names: ["pa"] });
    expect(r.body.online.bodies.arcadia).toEqual({ players: 1, names: ["pb"] });
    expect(r.body.online.bodies.meridian).toEqual({ players: 0, names: [] });
    expect(r.body.board?.levels).toEqual([{ name: "Topper", level: 12, starter: 0, title: null }]);
    expect(r.body.visits).toBeNull();
  });

  it("rate-limits each address", async () => {
    game = await startServer({}, { mountAfterJson: (app) => mountHome(app, { db: null }) });
    for (let i = 0; i < HOME_LIMITS.perAddress; i++) expect((await home("198.51.100.1")).status).toBe(200);
    const refused = await home("198.51.100.1");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect((await home("198.51.100.2")).status).toBe(200); // another address is fine
  });

  it("passes DataFast numbers through when configured", async () => {
    const visits = { configured: true, get: async () => ({ online: 4, total: 321 }) };
    game = await startServer({}, { mountAfterJson: (app) => mountHome(app, { db: null, visits }) });
    const r = await home();
    expect(r.body.visits).toEqual({ online: 4, total: 321 });
    expect(r.body.board).toBeNull();
  });
});

describe("onlineSnapshot", () => {
  it("caps and de-duplicates names, skipping bots, load-test rooms and superseded actors", () => {
    const actor = (name: string, extra: object = {}) => ({ identity: {}, state: { name }, ...extra });
    const room = (body: string, list: object[], metadata: object | null = null) => ({ bodyDef: { id: body }, metadata, actors: new Map(list.map((a, i) => [String(i), a])) }) as never;
    const s = onlineSnapshot(
      [
        room("arcadia", [actor("Zed"), actor("amy"), actor("Bo"), actor("Bo"), actor("Bot", { identity: { loadtest: true } }), actor("Old", { superseded: true })]),
        room("hollowmere", [actor("Load")], { loadtest: true }),
      ],
      2,
    );
    expect(s.total).toBe(4);
    expect(s.bodies.arcadia).toEqual({ players: 4, names: ["amy", "Bo"] });
    expect(s.bodies.hollowmere.players).toBe(0);
  });
});
