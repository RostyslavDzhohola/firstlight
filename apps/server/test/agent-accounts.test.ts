// Agent accounts (D-agents-1) on the real path, SQLite and Better Auth: the kit signs in as a guest
// the way a browser does, the guest account is flagged as an agent's for good, and no people's
// surface (levels and medals boards, online now, play statistics) counts it. A person shows everywhere.

import type { Room } from "@colyseus/sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FirstlightAgent } from "@firstlight/agent-kit";
import type { HomeData } from "@firstlight/shared/net/home";
import { agentSessionCount, awardMedal, isAgentAccount, isTestAccount, linkAccounts, sessionStats, setDisplayName } from "../src/db/index.ts";
import { mountHome } from "../src/ops/home.ts";
import { characterRepo, MemoryCharacterRepo } from "../src/world/characters.ts";
import { SqliteCharacterRepo } from "../src/world/sqliteStores.ts";
import { resetAgentSlots } from "../src/world/agents.ts";
import { api, Browser, joinWithToken, ORIGIN, play, startAuthServer, userIdOf, type AuthServer } from "./auth-helpers.ts";
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
});
