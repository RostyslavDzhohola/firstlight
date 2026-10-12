// Guest pruning (F12): abandoned level-1 guests are deleted from auth.db and game.db so the databases
// don't grow without bound and their display names are released. Runs at boot and daily.

import { afterEach, describe, expect, it } from "vitest";
import { awardMedal, getAccount, loadCharacter, saveCharacter, type CharacterData } from "../src/db/index.ts";
import { stmt } from "../src/db/game-db.ts";
import { GUEST_PRUNE, pruneGuests } from "../src/auth/prune.ts";
import { api, Browser, decodeJwt, play, startAuthServer, type AuthServer } from "./auth-helpers.ts";

let server: AuthServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

const DAY = 86_400_000;

function charData(level: number): CharacterData {
  return { starter: "ember", palette: 0, level, xp: 0, coins: 0, hp: 100, body: "portus", copyHint: 0, x: 0, y: 0, z: 0, heading: 0, inventory: [], missionState: {}, lifeStartedAt: 0, protectedUntil: 0 };
}

/** A guest who played once (account row via /api/play), optionally with a name, level and medal. */
async function guest(s: AuthServer, ip: string, opts: { name?: string; level?: number; medal?: boolean } = {}) {
  const b = new Browser(s, ip);
  const token = await b.playToken();
  const id = String(decodeJwt(token).sub);
  expect((await play(s, token)).json.ok).toBe(true);
  if (opts.name) expect((await api(s, "/api/account/name", token, { body: { name: opts.name } })).json.ok).toBe(true);
  saveCharacter(s.accounts.db, id, charData(opts.level ?? 1));
  if (opts.medal) awardMedal(s.accounts.db, id, "first-blood");
  return { b, token, id };
}

/** Make the account look last active `days` ago in both databases. */
function age(s: AuthServer, id: string, days: number) {
  const iso = new Date(Date.now() - days * DAY).toISOString();
  s.accounts.authDb.prepare(`UPDATE "user" SET "createdAt" = ?, "updatedAt" = ? WHERE id = ?`).run(iso, iso, id);
  s.accounts.authDb.prepare(`UPDATE "session" SET "createdAt" = ?, "updatedAt" = ? WHERE "userId" = ?`).run(iso, iso, id);
  stmt(s.accounts.db, "UPDATE account SET last_seen_at = ?, created_at = ? WHERE user_id = ?").run(Date.now() - days * DAY, Date.now() - days * DAY, id);
}

const authUser = (s: AuthServer, id: string) => s.accounts.authDb.prepare(`SELECT id FROM "user" WHERE id = ?`).get(id);
const authSessions = (s: AuthServer, id: string) => (s.accounts.authDb.prepare(`SELECT COUNT(*) AS n FROM "session" WHERE "userId" = ?`).get(id) as { n: number }).n;

describe("guest pruning", () => {
  it("deletes guests idle for 30+ days at level 1 with nothing earned, and releases their names; keeps everyone else", async () => {
    server = await startAuthServer();
    const s = server;
    const gone = await guest(s, "198.51.100.70", { name: "Squatter" });
    const levelled = await guest(s, "198.51.100.71", { level: 2 });
    const medalled = await guest(s, "198.51.100.72", { medal: true });
    const recent = await guest(s, "198.51.100.73");
    const saved = await guest(s, "198.51.100.74");
    await saved.b.saveWithEmail("kept@example.test");
    const savedId = String(decodeJwt((await saved.b.client.token()).data!.token).sub);
    stmt(s.accounts.db, "UPDATE character SET level = 1 WHERE user_id = ?").run(savedId);
    for (const id of [gone.id, levelled.id, medalled.id, savedId]) age(s, id, GUEST_PRUNE.INACTIVE_DAYS + 1);
    age(s, recent.id, GUEST_PRUNE.INACTIVE_DAYS - 1);

    expect(pruneGuests(s.accounts.authDb, s.accounts.db)).toBe(1);
    expect(authUser(s, gone.id)).toBeUndefined();
    expect(authSessions(s, gone.id)).toBe(0);
    expect(getAccount(s.accounts.db, gone.id)).toBeNull();
    expect(loadCharacter(s.accounts.db, gone.id)).toBeNull();
    expect((await play(s, gone.token)).status).toBe(401);
    // The name is free again.
    const other = await guest(s, "198.51.100.75");
    expect((await api(s, "/api/account/name", other.token, { body: { name: "Squatter" } })).json).toEqual({ ok: true, name: "Squatter" });

    for (const id of [levelled.id, medalled.id, recent.id, savedId]) {
      expect(authUser(s, id)).toBeTruthy();
      expect(getAccount(s.accounts.db, id)).not.toBeNull();
    }
    expect(pruneGuests(s.accounts.authDb, s.accounts.db)).toBe(0);
  });

  it("runs at boot", async () => {
    server = await startAuthServer();
    const dir = server.dir;
    const g = await guest(server, "198.51.100.76");
    age(server, g.id, GUEST_PRUNE.INACTIVE_DAYS + 5);
    await server.close(true);
    server = await startAuthServer({ dir });
    expect(authUser(server, g.id)).toBeUndefined();
    expect(getAccount(server.accounts.db, g.id)).toBeNull();
  });
});
