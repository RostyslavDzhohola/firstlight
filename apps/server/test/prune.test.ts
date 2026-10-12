// Guest pruning (F12): abandoned guests (level 1, or no further than the tutorial) are deleted from
// auth.db and game.db so the databases don't grow without bound and their display names are released.
// Runs at boot and daily.

import { afterEach, describe, expect, it } from "vitest";
import { awardMedal, getAccount, listMedals, loadCharacter, saveCharacter, type CharacterData } from "../src/db/index.ts";
import { stmt } from "../src/db/game-db.ts";
import { GUEST_PRUNE, pruneGuests, TOMBSTONE } from "../src/auth/prune.ts";
import { hub } from "../src/world/hub.ts";
import { api, Browser, decodeJwt, joinWithToken, play, startAuthServer, type AuthServer } from "./auth-helpers.ts";
import { waitFor } from "./helpers.ts";

let server: AuthServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

const DAY = 86_400_000;

function charData(level: number, extra: Partial<CharacterData> = {}): CharacterData {
  return { starter: "ember", palette: 0, level, xp: 0, coins: 0, hp: 100, body: "portus", copyHint: 0, x: 0, y: 0, z: 0, heading: 0, inventory: [], missionState: {}, lifeStartedAt: 0, protectedUntil: 0, ...extra };
}

/** A guest who played once (account row via /api/play), optionally with a name, level, XP and medals. */
async function guest(s: AuthServer, ip: string, opts: { name?: string; level?: number; xp?: number; medals?: string[]; loot?: boolean } = {}) {
  const b = new Browser(s, ip);
  const token = await b.playToken();
  const id = String(decodeJwt(token).sub);
  expect((await play(s, token)).json.ok).toBe(true);
  if (opts.name) expect((await api(s, "/api/account/name", token, { body: { name: opts.name } })).json.ok).toBe(true);
  saveCharacter(s.accounts.db, id, charData(opts.level ?? 1, { xp: opts.xp ?? 0, ...(opts.loot ? { coins: 480, inventory: [{ id: "hexquill" }, { id: "radio" }] } : {}) }));
  for (const m of opts.medals ?? []) awardMedal(s.accounts.db, id, m);
  return { b, token, id };
}

/** Make the account look last active `days` ago everywhere: sign-in, character save, play sessions. */
function age(s: AuthServer, id: string, days: number) {
  const ms = Date.now() - days * DAY;
  const iso = new Date(ms).toISOString();
  s.accounts.authDb.prepare(`UPDATE "user" SET "createdAt" = ?, "updatedAt" = ? WHERE id = ?`).run(iso, iso, id);
  s.accounts.authDb.prepare(`UPDATE "session" SET "createdAt" = ?, "updatedAt" = ? WHERE "userId" = ?`).run(iso, iso, id);
  stmt(s.accounts.db, "UPDATE account SET last_seen_at = ?, created_at = ? WHERE user_id = ?").run(ms, ms, id);
  stmt(s.accounts.db, "UPDATE character SET updated_at = ? WHERE user_id = ?").run(ms, id);
  stmt(s.accounts.db, "UPDATE session_log SET started_at = ?, ended_at = CASE WHEN ended_at IS NULL THEN NULL ELSE ? END WHERE user_id = ?").run(ms, ms, id);
}

const authUser = (s: AuthServer, id: string) => s.accounts.authDb.prepare(`SELECT id FROM "user" WHERE id = ?`).get(id);
const authSessions = (s: AuthServer, id: string) => (s.accounts.authDb.prepare(`SELECT COUNT(*) AS n FROM "session" WHERE "userId" = ?`).get(id) as { n: number }).n;

describe("guest pruning", () => {
  it("deletes guests idle for 30+ days who got no further than the tutorial, and releases their names; keeps everyone else", async () => {
    server = await startAuthServer();
    const s = server;
    // Level-1 coins and items don't keep an abandoned guest (policy, see prune.ts).
    const gone = await guest(s, "198.51.100.70", { name: "Squatter", loot: true });
    // Finishing the tutorial pays exactly 50 XP (level 2) and the Spark medal: still abandoned (F12 final review S5).
    const trainee = await guest(s, "198.51.100.69", { name: "Trainee", level: 2, xp: 50, medals: ["spark"] });
    const levelled = await guest(s, "198.51.100.71", { level: 2, xp: 60 }); // XP past the tutorial
    const level3 = await guest(s, "198.51.100.80", { level: 3, xp: 190 });
    const medalled = await guest(s, "198.51.100.72", { medals: ["first-blood"] });
    const sparkPlus = await guest(s, "198.51.100.81", { level: 2, xp: 50, medals: ["spark", "first-blood"] });
    const recent = await guest(s, "198.51.100.73", { level: 2, xp: 50, medals: ["spark"] });
    const saved = await guest(s, "198.51.100.74");
    await saved.b.saveWithEmail("kept@example.test");
    const savedId = String(decodeJwt((await saved.b.client.token()).data!.token).sub);
    stmt(s.accounts.db, "UPDATE character SET level = 1, xp = 0 WHERE user_id = ?").run(savedId);
    const kept = [levelled.id, level3.id, medalled.id, sparkPlus.id, savedId];
    for (const id of [gone.id, trainee.id, ...kept]) age(s, id, GUEST_PRUNE.INACTIVE_DAYS + 1);
    age(s, recent.id, GUEST_PRUNE.INACTIVE_DAYS - 1);

    expect(pruneGuests(s.accounts.authDb, s.accounts.db)).toBe(2);
    for (const g of [gone, trainee]) {
      expect(authUser(s, g.id)).toBeUndefined();
      expect(authSessions(s, g.id)).toBe(0);
      expect(getAccount(s.accounts.db, g.id)).toBeNull();
      expect(loadCharacter(s.accounts.db, g.id)).toBeNull();
      expect((await play(s, g.token)).status).toBe(401);
    }
    expect(listMedals(s.accounts.db, trainee.id)).toEqual([]);
    // The names are free again.
    const other = await guest(s, "198.51.100.75");
    expect((await api(s, "/api/account/name", other.token, { body: { name: "Squatter" } })).json).toEqual({ ok: true, name: "Squatter" });
    const other2 = await guest(s, "198.51.100.82");
    expect((await api(s, "/api/account/name", other2.token, { body: { name: "Trainee" } })).json).toEqual({ ok: true, name: "Trainee" });

    for (const id of [...kept, recent.id]) {
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

  it("keeps a guest whose long session just ended, or whose character was saved recently", async () => {
    server = await startAuthServer();
    const s = server;
    const b = new Browser(s, "198.51.100.77");
    const token = await b.playToken();
    const id = String(decodeJwt(token).sub);
    const room = await joinWithToken(s, token, "portus");
    await waitFor(() => !!hub.get(id));
    age(s, id, GUEST_PRUNE.INACTIVE_DAYS + 3); // signed in once, a month-long session ago
    expect(pruneGuests(s.accounts.authDb, s.accounts.db)).toBe(0); // still playing
    await room.leave();
    await waitFor(() => !hub.get(id));
    expect(pruneGuests(s.accounts.authDb, s.accounts.db)).toBe(0); // the session just ended
    expect(authUser(s, id)).toBeTruthy();

    // Old sign-in and sessions, but the character was saved just now (autosave, logout, shutdown).
    const saver = await guest(s, "198.51.100.78");
    age(s, saver.id, GUEST_PRUNE.INACTIVE_DAYS + 3);
    saveCharacter(s.accounts.db, saver.id, charData(1));
    expect(pruneGuests(s.accounts.authDb, s.accounts.db)).toBe(0);
    expect(authUser(s, saver.id)).toBeTruthy();
  });

  it("keeps a guest whose long session was cut by a restart", async () => {
    server = await startAuthServer();
    const dir = server.dir;
    const b = new Browser(server, "198.51.100.79");
    const token = await b.playToken();
    const id = String(decodeJwt(token).sub);
    const room = await joinWithToken(server, token, "portus");
    room.onLeave(() => {});
    await waitFor(() => !!hub.get(id));
    age(server, id, GUEST_PRUNE.INACTIVE_DAYS + 3);
    await server.close(true);
    expect(hub.get(id)).toBeUndefined();
    server = await startAuthServer({ dir }); // boot pruning runs here
    expect(authUser(server, id)).toBeTruthy();
    expect(getAccount(server.accounts.db, id)).not.toBeNull();
  });

  it("a failure between the two databases is harmless and the next run finishes the job", async () => {
    server = await startAuthServer();
    const s = server;
    const boom = () => {
      throw new Error("injected");
    };
    // Stopped after the auth delete: the player can't sign in; the next run removes the game rows.
    const half = await guest(s, "198.51.100.86", { name: "HalfGone" });
    age(s, half.id, GUEST_PRUNE.INACTIVE_DAYS + 1);
    expect(() => pruneGuests(s.accounts.authDb, s.accounts.db, { faults: { afterAuth: boom } })).toThrow("injected");
    expect(authUser(s, half.id)).toBeUndefined();
    expect(getAccount(s.accounts.db, half.id)?.lastSeenAt).toBe(TOMBSTONE);
    expect(pruneGuests(s.accounts.authDb, s.accounts.db)).toBe(1);
    expect(getAccount(s.accounts.db, half.id)).toBeNull();
    expect(loadCharacter(s.accounts.db, half.id)).toBeNull();
    const other = await guest(s, "198.51.100.87");
    expect((await api(s, "/api/account/name", other.token, { body: { name: "HalfGone" } })).json).toEqual({ ok: true, name: "HalfGone" });

    // Stopped after the tombstone: nothing is lost, and a player who comes back keeps everything.
    const back = await guest(s, "198.51.100.88", { name: "Returner" });
    age(s, back.id, GUEST_PRUNE.INACTIVE_DAYS + 1);
    expect(() => pruneGuests(s.accounts.authDb, s.accounts.db, { faults: { afterTombstone: boom } })).toThrow("injected");
    expect(authUser(s, back.id)).toBeTruthy();
    expect(loadCharacter(s.accounts.db, back.id)).not.toBeNull();
    expect((await play(s, back.token)).json.ok).toBe(true); // signing in clears the tombstone
    expect(pruneGuests(s.accounts.authDb, s.accounts.db)).toBe(0);
    expect(getAccount(s.accounts.db, back.id)?.displayName).toBe("Returner");
  });
});
