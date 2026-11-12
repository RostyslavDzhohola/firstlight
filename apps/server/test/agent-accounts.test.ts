// Agent accounts (D-agents-1) on the real path, SQLite and Better Auth: the kit signs in as a guest
// the way a browser does, the guest account is flagged as an agent's for good, and no people's
// surface (levels and medals boards, online now, play statistics) counts it. A person shows everywhere.

import type { Room } from "@colyseus/sdk";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FirstlightAgent } from "@firstlight/agent-kit";
import type { HomeData } from "@firstlight/shared/net/home";
import { agentSessionCount, awardMedal, endSession, isAgentAccount, isTestAccount, linkAccounts, markAgentAccount, openGameDb, retention, sessionStats, setDisplayName, startSession } from "../src/db/index.ts";
import { MIGRATIONS } from "../src/db/schema.ts";
import { mountHome } from "../src/ops/home.ts";
import { characterRepo, MemoryCharacterRepo } from "../src/world/characters.ts";
import { SqliteCharacterRepo } from "../src/world/sqliteStores.ts";
import { resetAgentSlots } from "../src/world/agents.ts";
import { liveRooms } from "../src/social/index.ts";
import { api, Browser, decodeJwt, joinWithToken, ORIGIN, play, startAuthServer, userIdOf, type AuthServer } from "./auth-helpers.ts";
import { safeLeave, waitFor } from "./helpers.ts";

let server: AuthServer | null = null;
const rooms: Room[] = [];
const agents: FirstlightAgent[] = [];

afterEach(async () => {
  for (const a of agents.splice(0)) await a.close();
  for (const r of rooms.splice(0)) await safeLeave(r);
  await server?.close();
  server = null;
  characterRepo.current = new MemoryCharacterRepo();
  resetAgentSlots();
});

async function start() {
  server = await startAuthServer({ extraRoutes: (app, a) => mountHome(app, { db: a.db }) });
  characterRepo.current = new SqliteCharacterRepo(server.accounts.db);
  return server;
}

describe("agent accounts (D-agents-1)", () => {
  it("the kit's guest flow makes a flagged agent that no people's surface counts; it comes back as the same character", async () => {
    const s = await start();
    const db = s.accounts.db;
    const sessionFile = join(mkdtempSync(join(tmpdir(), "fl-agent-")), "session.json");
    const connect = async () => {
      const a = new FirstlightAgent();
      agents.push(a);
      const r = await a.connect({ url: s.base, authOrigin: ORIGIN, name: "Scout_7", starter: "kappa", sessionFile });
      return { a, r };
    };
    const first = await connect();
    expect(first.r).toMatchObject({ ok: true, name: "Scout_7", body: "portus", starter: "kappa" });
    const room = first.a.room!;
    const me = (room.state as any).players.get(room.sessionId);
    expect(me.agent).toBe(true);
    const id: string = me.userId;
    expect(isAgentAccount(db, id)).toBe(true);
    expect(isTestAccount(db, id)).toBe(false); // an agent is a player, not our automation

    // A person plays too.
    const person = new Browser(s, "198.51.100.20");
    const token = await person.playToken();
    expect((await api(s, "/api/account/name", token, { body: { name: "Meadowlark" } })).json).toMatchObject({ ok: true });
    await person.levelUp(3);
    rooms.push(await joinWithToken(s, token));
    expect(isAgentAccount(db, userIdOf(token))).toBe(false);
    await waitFor(() => (db.prepare("SELECT COUNT(*) AS n FROM session_log").get() as { n: number }).n === 2);
    awardMedal(db, id, "spark");
    awardMedal(db, id, "ten_down");
    awardMedal(db, userIdOf(token), "spark");

    const home = (await api(s, "/api/home", null)).json as HomeData;
    expect(home.board!.levels.map((r) => r.name)).toEqual(["Meadowlark"]);
    expect(home.board!.medals.map((r) => r.name)).toEqual(["Meadowlark"]);
    expect(home.online.total).toBe(1);
    expect(home.online.bodies.portus).toEqual({ players: 1, names: ["Meadowlark"] });
    expect(JSON.stringify(home)).not.toContain("Scout_7");
    expect((await api(s, "/api/online", null)).json).toEqual({ online: 1, agents: 1 });
    expect(sessionStats(db).players).toBe(1);
    expect(agentSessionCount(db)).toEqual({ sessions: 1, players: 1 });

    // The session file is the character: the next run is the same account, still an agent's.
    await first.a.close();
    await waitFor(() => !(room.state as any).players?.has(room.sessionId) || true);
    const again = await connect();
    expect(again.r).toMatchObject({ ok: true, name: "Scout_7" });
    expect((again.a.room!.state as any).players.get(again.a.room!.sessionId).userId).toBe(id);
  }, 60_000);

  it("play tokens are bound to the guest session (D-security-5): a drop brings the same character back, an ended session never turns into someone else mid-run", async () => {
    const s = await start();
    const db = s.accounts.db;
    const sessionFile = join(mkdtempSync(join(tmpdir(), "fl-agent-")), "session.json");
    const log: string[] = [];
    const a = new FirstlightAgent();
    agents.push(a);
    const first = await a.connect({ url: s.base, authOrigin: ORIGIN, starter: "unit7", sessionFile, log: (l) => log.push(l) });
    expect(first.ok).toBe(true);
    expect(first.newGuest).toBeUndefined();
    const userOf = (x: FirstlightAgent): string => (x.room!.state as any).players.get(x.room!.sessionId).userId;
    const id = userOf(a);
    // The session file holds the cookie; the tokens it buys carry that session's id.
    const cookie = (JSON.parse(readFileSync(sessionFile, "utf8")) as { cookie: string }).cookie;
    const auth = { Origin: ORIGIN, Cookie: cookie };
    const token = ((await (await fetch(`${s.base}/api/auth/token`, { headers: auth })).json()) as { token: string }).token;
    expect(userIdOf(token)).toBe(id);
    expect(decodeJwt(token).sid).toBeTruthy();

    // The server drops the connection: the kit rejoins with its session and is the same character.
    const drop = (x: FirstlightAgent) => [...liveRooms].find((r) => r.actors.has(x.sessionId))!.actors.get(x.sessionId)!.client.leave(4050);
    const room1 = a.room;
    drop(a);
    await waitFor(() => a.status === "playing" && !!a.room && a.room !== room1, 20_000);
    expect(userOf(a)).toBe(id);
    expect(a.events.some((e) => e.text === "reconnected")).toBe(true);

    // The session is signed out: its tokens and seats are dead. The body in the world stays until it
    // leaves; coming back for it is refused, and the kit stops instead of joining as a new guest.
    expect((await fetch(`${s.base}/api/auth/sign-out`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: "{}" })).ok).toBe(true);
    expect((await play(s, token, { body: "portus" })).status).toBe(401);
    drop(a);
    await waitFor(() => a.status === "offline", 30_000);
    expect(a.events.some((e) => e.text.startsWith("the guest session ended"))).toBe(true);
    expect(await a.moveTo({ bearing: 0, distance: 5 })).toMatchObject({ ok: false, reason: "not connected" });
    expect(isAgentAccount(db, id)).toBe(true);

    // A new run with the same file: a new guest, and the result says that this is another character.
    const b = new FirstlightAgent();
    agents.push(b);
    const second = await b.connect({ url: s.base, authOrigin: ORIGIN, starter: "unit7", sessionFile, log: (l) => log.push(l) });
    expect(second).toMatchObject({ ok: true, newGuest: true });
    expect(userOf(b)).not.toBe(id);
    expect(isAgentAccount(db, userOf(b))).toBe(true);
    expect(log.some((l) => l.includes("the saved guest session has ended"))).toBe(true);
  }, 90_000);

  it("the flag sticks to a guest that once played as an agent, and follows it into a new saved account only", async () => {
    const s = await start();
    const db = s.accounts.db;
    const b = new Browser(s, "198.51.100.21");
    const token = await b.playToken();
    const id = userIdOf(token);
    // Asked for a seat as an agent once (the header alone is enough)…
    expect((await play(s, token, { body: "portus" }, { "x-firstlight-agent": "1" })).json.ok).toBe(true);
    expect(isAgentAccount(db, id)).toBe(true);
    // …and a later plain request from the same guest is still an agent's.
    await new Promise((ok) => setTimeout(ok, 50));
    const room = await joinWithToken(s, token);
    rooms.push(room);
    await waitFor(() => !!(room.state as any).players?.get(room.sessionId));
    expect((room.state as any).players.get(room.sessionId).agent).toBe(true);
    // Saved to a brand-new account: still an agent's. Merged into an account that existed: that one isn't flagged.
    setDisplayName(db, id, "AgentGuest");
    linkAccounts(db, id, "saved-new", Date.now(), { targetIsNew: true });
    expect(isAgentAccount(db, "saved-new")).toBe(true);
    const other = userIdOf(await new Browser(s, "198.51.100.22").playToken());
    expect((await play(s, await new Browser(s, "198.51.100.23").playToken(), { body: "portus" })).json.ok).toBe(true);
    db.prepare("INSERT OR IGNORE INTO agent_account (user_id, source, marked_at) VALUES (?, 'test', 0)").run("agent-guest-2");
    linkAccounts(db, "agent-guest-2", other, Date.now(), { targetIsNew: false });
    expect(isAgentAccount(db, other)).toBe(false);
  }, 40_000);

  // Review 2026-11-12 (agent kit) #5: sessions were classed by the account's flag as it stood when
  // the statistics were read, so a saved account's agent session counted as a person's play and a
  // link reclassified history. The row carries its own flag now (migration 10).
  it("a session is an agent's or a person's by its own row, whatever its account is or becomes", () => {
    const db = openGameDb(join(mkdtempSync(join(tmpdir(), "fl-agent-db-")), "game.db"));
    try {
      const DAY = 86_400_000;
      const now = Date.now();
      const day0 = (Math.floor(now / DAY) - 3) * DAY;
      const session = (userId: string, startedAt: number, agent?: boolean) => endSession(db, startSession(db, { userId, startedAt, agent }), { endedAt: startedAt + 60_000 });
      // A saved account, never flagged, plays by hand one day and through an agent the next.
      session("saved", day0 + 1000);
      session("saved", day0 + DAY + 1000, true);
      expect(isAgentAccount(db, "saved")).toBe(false);
      expect(sessionStats(db)).toMatchObject({ sessions: 1, players: 1 });
      expect(agentSessionCount(db)).toEqual({ sessions: 1, players: 1 });
      // The agent's session a day later isn't a person coming back.
      expect(retention(db, now).cohorts).toEqual([{ day: new Date(day0).toISOString().slice(0, 10), cohort: 1, d1: 0, d7: null }]);
      // An agent's guest is merged into that account: the account isn't flagged, and the guest's
      // sessions are still agent sessions under their new owner.
      markAgentAccount(db, "agent-guest", "play", now);
      session("agent-guest", day0 + 2000, true);
      linkAccounts(db, "agent-guest", "saved", now, { targetIsNew: false });
      expect(isAgentAccount(db, "saved")).toBe(false);
      expect(db.prepare("SELECT COUNT(*) AS n FROM session_log WHERE user_id = 'saved'").get()).toEqual({ n: 3 });
      expect(sessionStats(db)).toMatchObject({ sessions: 1, players: 1 });
      expect(agentSessionCount(db)).toEqual({ sessions: 2, players: 1 });
      expect(retention(db, now).cohorts).toEqual([{ day: new Date(day0).toISOString().slice(0, 10), cohort: 1, d1: 0, d7: null }]);
      // Rows from before the column: the migration classes them by the account's flag as it stood.
      markAgentAccount(db, "old-agent", "play", now);
      session("old-agent", day0 + 3000);
      expect(agentSessionCount(db).sessions).toBe(2);
      db.exec(MIGRATIONS[9]!.replace(/ALTER TABLE[^;]*;/, ""));
      expect(agentSessionCount(db)).toEqual({ sessions: 3, players: 2 });
      expect(sessionStats(db)).toMatchObject({ sessions: 1, players: 1 });
    } finally {
      db.close();
    }
  });
});
