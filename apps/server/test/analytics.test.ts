// Session analytics bookkeeping against a temp game.db (no server): travel, account re-key.

import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openGameDb, setGameDb, type Db } from "../src/db/index.ts";
import { stmt } from "../src/db/game-db.ts";
import { ANALYTICS, openTrackers, rekeyAnalytics, trackJoin, trackLeave } from "../src/social/analytics.ts";
import type { PlayerActor } from "../src/world/actors.ts";
import { tempDir } from "./auth-helpers.ts";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = tempDir();
  db = openGameDb(join(dir, "game.db"));
  setGameDb(db);
  ANALYTICS.END_GRACE_MS = 20;
});

afterEach(() => {
  ANALYTICS.END_GRACE_MS = 60_000;
  setGameDb(null);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const actor = (sessionId: string, userId: string, level = 1, deaths = 0) =>
  ({ id: sessionId, identity: { userId, name: userId, guest: true, admin: false, loadtest: false }, char: { level, deaths } }) as unknown as PlayerActor;
const rows = () => stmt(db, "SELECT user_id, ended_at, deaths, max_level FROM session_log ORDER BY id").all() as { user_id: string; ended_at: number | null; deaths: number; max_level: number }[];
const settle = () => new Promise((r) => setTimeout(r, 60));

describe("session analytics re-key", () => {
  it("a guest who saves into an account that was also playing: the displaced session ends, the live one continues and ends later", async () => {
    const acctOld = actor("sA", "acct", 4);
    const guest = actor("sG", "guest", 2);
    trackJoin(acctOld, "arcadia", 1_000);
    trackJoin(guest, "portus", 2_000);
    expect(openTrackers()).toBe(2);

    // linkAccounts moves the rows; the trackers follow.
    stmt(db, "UPDATE session_log SET user_id = 'acct' WHERE user_id = 'guest'").run();
    rekeyAnalytics("guest", "acct", 3_000);
    expect(openTrackers()).toBe(1);
    expect(rows().filter((r) => r.ended_at !== null)).toHaveLength(1);

    // The displaced browser's leave is ignored; the live session ends after its grace period.
    trackLeave("acct", "sA", 3_500);
    await settle();
    expect(openTrackers()).toBe(1);
    (guest.char as { deaths: number }).deaths = 1;
    trackLeave("acct", "sG", 4_000);
    await settle();
    expect(openTrackers()).toBe(0);
    const all = rows();
    expect(all.every((r) => r.ended_at !== null && r.user_id === "acct")).toBe(true);
    expect(all.find((r) => r.max_level === 2)?.deaths).toBe(1);
  });

  it("a guest who already left saves into an account playing elsewhere: the account's session carries on", async () => {
    const live = actor("sL", "acct3", 6);
    trackJoin(live, "meridian", 1_000);
    trackJoin(actor("sG3", "guest3"), "portus", 1_500);
    trackLeave("guest3", "sG3", 2_000);
    stmt(db, "UPDATE session_log SET user_id = 'acct3' WHERE user_id = 'guest3'").run();
    rekeyAnalytics("guest3", "acct3", 2_500);
    await settle();
    expect(openTrackers()).toBe(1); // the live account session
    const r = rows();
    expect(r.filter((x) => x.ended_at === null)).toHaveLength(1);
    expect(r.find((x) => x.ended_at !== null)!.ended_at).toBe(2_000);
    trackLeave("acct3", "sL", 3_000);
    await settle();
    expect(openTrackers()).toBe(0);
  });

  it("a pending end timer still fires after the key changes", async () => {
    trackJoin(actor("s1", "g2"), "portus", 1_000);
    trackLeave("g2", "s1", 2_000);
    rekeyAnalytics("g2", "a2");
    await settle();
    expect(openTrackers()).toBe(0);
    expect(rows()[0]!.ended_at).toBe(2_000);
  });
});
