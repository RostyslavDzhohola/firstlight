// Test accounts (D-home-6), on the real path with SQLite and Better Auth: guests our tools create carry
// LOADTEST_SECRET and are flagged; no public surface (leaderboard, Hall of Firsts, online now, worlds'
// counts, /api/home, /api/online, /stats figures) shows them; a real guest shows; the header without
// the right secret does nothing; the one-off backfill flags exactly the listed automation guests.

import type { Room } from "@colyseus/sdk";
import Database from "better-sqlite3";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HomeData } from "@firstlight/shared/net/home";
import { awardMedal, BACKFILL_ID, claimFirst, isTestAccount, listHallOfFirsts, sessionStats, testSessionCount } from "../src/db/index.ts";
import { mountHome, publicOnlineCount } from "../src/ops/home.ts";
import { characterRepo, MemoryCharacterRepo } from "../src/world/characters.ts";
import { SqliteCharacterRepo } from "../src/world/sqliteStores.ts";
import { api, Browser, joinWithToken, startAuthServer, userIdOf, type AuthServer } from "./auth-helpers.ts";
import { safeLeave, waitFor } from "./helpers.ts";

const SECRET = "tool-secret-for-tests-0123456789";
let server: AuthServer | null = null;
const rooms: Room[] = [];

afterEach(async () => {
  for (const r of rooms.splice(0)) await safeLeave(r);
  await server?.close();
  server = null;
  characterRepo.current = new MemoryCharacterRepo();
});

async function start(over: Parameters<typeof startAuthServer>[0] = {}) {
  server = await startAuthServer({ loadtestSecret: SECRET, extraRoutes: (app, a) => mountHome(app, { db: a.db }), ...over });
  characterRepo.current = new SqliteCharacterRepo(server.accounts.db); // rooms load and save game.db, like production
  return server;
}

/** A guest with a display name and a level-`level` character; `tool` sends our tools' header. */
async function guest(s: AuthServer, name: string, level: number, ip: string, header?: string) {
  const b = new Browser(s, ip);
  const token = await b.playToken();
  const headers = header ? { "x-loadtest-secret": header } : undefined;
  const named = await api(s, "/api/account/name", token, { body: { name }, headers });
  expect(named.json, name).toMatchObject({ ok: true, name });
  await b.levelUp(level);
  return { b, token, id: userIdOf(token) };
}

describe("test accounts (D-home-6)", () => {
  it("never shows our tools' guests on a public surface; a real guest shows everywhere", async () => {
    const s = await start();
    const db = s.accounts.db;
    const real = await guest(s, "Meadowlark", 4, "198.51.100.10");
    const tool = await guest(s, "SmokeBot9", 9, "198.51.100.11", SECRET);
    expect(isTestAccount(db, tool.id)).toBe(true);
    expect(isTestAccount(db, real.id)).toBe(false);

    // Both play: they're in the world, so the Tab list and the game see them as players.
    rooms.push(await joinWithToken(s, real.token), await joinWithToken(s, tool.token));
    await waitFor(() => (db.prepare("SELECT COUNT(*) AS n FROM session_log").get() as { n: number }).n === 2);
    awardMedal(db, real.id, "spark");
    awardMedal(db, tool.id, "spark");
    awardMedal(db, tool.id, "ten_down");
    // The tool found a secret first; then a real player found it: the plaque is the real player's.
    expect(claimFirst(db, "E2", tool.id, "SmokeBot9").won).toBe(true);
    expect(listHallOfFirsts(db)).toEqual([]);
    expect(claimFirst(db, "E2", real.id, "Meadowlark").won).toBe(true);
    expect(claimFirst(db, "E3", real.id, "Meadowlark").won).toBe(true);
    expect(claimFirst(db, "E3", tool.id, "SmokeBot9").won).toBe(false); // a tool never takes a real find

    const home = (await api(s, "/api/home", null)).json as HomeData;
    expect(home.board!.levels.map((r) => r.name)).toEqual(["Meadowlark"]);
    expect(home.board!.medals.map((r) => r.name)).toEqual(["Meadowlark"]);
    expect(home.board!.hall.map((h) => [h.id, h.name])).toEqual([["E2", "Meadowlark"], ["E3", "Meadowlark"]]);
    expect(home.online.total).toBe(1);
    expect(home.online.bodies.portus).toEqual({ players: 1, names: ["Meadowlark"] });
    expect((await api(s, "/api/online", null)).json.online).toBe(1);
    expect(JSON.stringify(home)).not.toContain("SmokeBot9");

    // /stats figures: real players only; the tool's session counted apart.
    expect(sessionStats(db).players).toBe(1);
    expect(testSessionCount(db)).toEqual({ sessions: 1, players: 1 });
  });

  it("ignores the header without the right secret, without a secret configured, and for saved accounts", async () => {
    const s = await start();
    const db = s.accounts.db;
    const wrong = await guest(s, "Fernwick", 2, "198.51.100.20", "not-the-secret");
    expect(isTestAccount(db, wrong.id)).toBe(false);
    const empty = await guest(s, "Ashlyn", 2, "198.51.100.21", "");
    expect(isTestAccount(db, empty.id)).toBe(false);

    // A saved account (email linked) can't be flagged, even with the right secret.
    const saved = await guest(s, "Corvina", 2, "198.51.100.22");
    await saved.b.saveWithEmail("corvina@example.test", "Corvina");
    const savedToken = (await saved.b.client.token()).data!.token;
    await api(s, "/api/account/me", savedToken, { headers: { "x-loadtest-secret": SECRET } });
    expect(isTestAccount(db, userIdOf(savedToken))).toBe(false);
    await s.close();

    // No LOADTEST_SECRET on the server: the header means nothing at all.
    server = null;
    const off = await start({ loadtestSecret: "" });
    const g = await guest(off, "Quillon", 2, "198.51.100.23", SECRET);
    expect(isTestAccount(off.accounts.db, g.id)).toBe(false);
  });

  it("a tools' guest that saves into a new account stays a test account", async () => {
    const s = await start();
    const tool = await guest(s, "SaveProbe", 2, "198.51.100.30", SECRET);
    await tool.b.saveWithEmail("probe@example.test", "SaveProbe");
    const savedToken = (await tool.b.client.token()).data!.token;
    expect(isTestAccount(s.accounts.db, userIdOf(savedToken))).toBe(true);
  });

  it("a player already in the world drops out of public counts the moment a tool flags them", async () => {
    const s = await start();
    const g = await guest(s, "LateFlag", 2, "198.51.100.60");
    rooms.push(await joinWithToken(s, g.token));
    await waitFor(() => publicOnlineCount() === 1);
    await api(s, "/api/account/me", g.token, { headers: { "x-loadtest-secret": SECRET } });
    expect(isTestAccount(s.accounts.db, g.id)).toBe(true);
    expect(publicOnlineCount()).toBe(0);
  });

  it("a tools' guest signing into an existing account doesn't flag it, and its sessions stay its own", async () => {
    const s = await start();
    const db = s.accounts.db;
    // A real player saved an account a while ago (created more than a minute before the link).
    const owner = await guest(s, "Wayfarer", 2, "198.51.100.70");
    await owner.b.saveWithEmail("wayfarer@example.test", "Wayfarer");
    const ownerId = userIdOf((await owner.b.client.token()).data!.token);
    s.accounts.authDb.prepare(`UPDATE "user" SET "createdAt" = ? WHERE id = ?`).run(new Date(Date.now() - 3_600_000).toISOString(), ownerId);
    // A test guest plays, then signs in with that email on its browser.
    const tool = await guest(s, "ProbeTwo", 2, "198.51.100.71", SECRET);
    rooms.push(await joinWithToken(s, tool.token));
    await waitFor(() => (db.prepare("SELECT COUNT(*) AS n FROM session_log WHERE user_id = ?").get(tool.id) as { n: number }).n === 1);
    await tool.b.saveWithEmail("wayfarer@example.test");
    expect(userIdOf((await tool.b.client.token()).data!.token)).toBe(ownerId);
    expect(isTestAccount(db, ownerId)).toBe(false);
    expect((db.prepare("SELECT COUNT(*) AS n FROM session_log WHERE user_id = ?").get(tool.id) as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM session_log WHERE user_id = ?").get(ownerId) as { n: number }).n).toBe(0);
  });

  it("the backfill flags exactly the listed automation guests, once, and logs how many", async () => {
    const s = await start();
    const dir = s.dir;
    const db = s.accounts.db;
    const ids: Record<string, string> = {};
    for (const [i, name] of ["SmokeTest", "TutorialRun3", "BugScout_5817", "ros", "smokethree", "Meadowlark"].entries()) ids[name] = (await guest(s, name, 2, `198.51.100.${40 + i}`)).id;
    // Saved (email linked) with an automation name: not a guest, left alone.
    const saved = await guest(s, "ChromeTester", 2, "198.51.100.50");
    await saved.b.saveWithEmail("chrome@example.test", "ChromeTester");
    ids.ChromeTester = userIdOf((await saved.b.client.token()).data!.token);
    // As if these accounts predate the backfill: forget that it ran, then boot again.
    db.prepare("DELETE FROM data_migration WHERE id = ?").run(BACKFILL_ID);
    await s.close(true);
    server = null;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const again = await start({ dir });
      const db2 = again.accounts.db;
      expect(log.mock.calls.map((c) => String(c[0]))).toContain("test accounts backfill: flagged 3 automation guest account(s)");
      const flagged = Object.entries(ids).filter(([, id]) => isTestAccount(db2, id)).map(([n]) => n).sort();
      expect(flagged).toEqual(["BugScout_5817", "SmokeTest", "TutorialRun3"]);
      expect(db2.prepare("SELECT changed FROM data_migration WHERE id = ?").get(BACKFILL_ID)).toEqual({ changed: 3 });
      // Nothing deleted: every account is still there.
      expect((db2.prepare("SELECT COUNT(*) AS n FROM account").get() as { n: number }).n).toBe(7);
      await again.close(true);
      // A later boot doesn't run it again.
      server = null;
      log.mockClear();
      const third = await start({ dir });
      expect(log.mock.calls.some((c) => String(c[0]).startsWith("test accounts backfill"))).toBe(false);
      expect(isTestAccount(third.accounts.db, ids.ros!)).toBe(false);
    } finally {
      log.mockRestore();
    }
    const raw = new Database(join(dir, "game.db"), { readonly: true });
    expect((raw.prepare("SELECT COUNT(*) AS n FROM test_account").get() as { n: number }).n).toBe(3);
    raw.close();
  });
});
