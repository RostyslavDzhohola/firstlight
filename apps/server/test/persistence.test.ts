// The game.db persistence API the rooms call (temp SQLite file per test).

import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  awardMedal,
  banUser,
  blockUser,
  claimFirst,
  discoverPad,
  dropPile,
  endSession,
  ensureAccount,
  fileReport,
  getAccount,
  getPile,
  isBanned,
  isBlockedEitherWay,
  isIpBanned,
  killCharacter,
  linkAccounts,
  listBlocked,
  listDiscoveredPads,
  listHallOfFirsts,
  listMedals,
  listPiles,
  listReports,
  loadCharacter,
  openGameDb,
  retention,
  saveCharacter,
  saveCharacters,
  sessionStats,
  setDisplayName,
  setTitleMedal,
  startSession,
  takeAll,
  takeCoins,
  takeItem,
  updateSession,
  type CharacterData,
  type Db,
} from "../src/db/index.ts";
import { isOffensiveName, nameShapeProblem } from "../src/db/names.ts";
import { MIGRATIONS } from "../src/db/schema.ts";
import { reserveOtpSend, releaseOtpSend } from "../src/db/otp-budget.ts";
import { tempDir } from "./auth-helpers.ts";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = tempDir();
  db = openGameDb(join(dir, "game.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const char = (level: number, extra: Partial<CharacterData> = {}): CharacterData => ({
  starter: "tide",
  palette: 1,
  level,
  xp: level * 10,
  coins: 25,
  hp: 80,
  body: "portus",
  copyHint: null,
  x: 0,
  y: 600,
  z: 0,
  heading: 0,
  inventory: [{ id: "carbine", ammo: 12 }],
  missionState: { find: true },
  lifeStartedAt: 1,
  protectedUntil: 0,
  ...extra,
});

describe("game.db", () => {
  it("migrations are idempotent across reopen and use WAL", () => {
    ensureAccount(db, "u1");
    db.close();
    db = openGameDb(join(dir, "game.db"));
    expect(getAccount(db, "u1")).not.toBeNull();
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
  });
});

describe("piles", () => {
  it("take-all is first-taker-wins", () => {
    const { pile } = dropPile(db, { body: "arcadia", x: 1, y: 2, z: 3, items: ["sword", "potion"], coins: 30, ownerId: "u1", ownerName: "Ann" });
    const first = takeAll<string>(db, pile.id);
    const second = takeAll<string>(db, pile.id);
    expect(first).toEqual({ ok: true, items: ["sword", "potion"], coins: 30, emptied: true, pile: null });
    expect(second).toEqual({ ok: false, reason: "gone" });
  });

  it("taking one item: the same item can't be taken twice, and the last take deletes the pile", () => {
    const { pile } = dropPile(db, { body: "arcadia", x: 0, y: 0, z: 0, items: ["a", "b"], coins: 5, ownerName: "Ann" });
    expect(takeItem<string>(db, pile.id, 0)).toMatchObject({ ok: true, items: ["a"], emptied: false });
    expect(takeItem<string>(db, pile.id, 0)).toEqual({ ok: false, reason: "taken" });
    // keys are stable: key 1 is still "b" after "a" was removed
    expect(takeItem<string>(db, pile.id, 1)).toMatchObject({ ok: true, items: ["b"], emptied: false });
    expect(takeCoins(db, pile.id)).toMatchObject({ ok: true, coins: 5, emptied: true });
    expect(getPile(db, pile.id)).toBeNull();
    expect(takeCoins(db, pile.id)).toEqual({ ok: false, reason: "gone" });
  });

  it("are per body, never expire, and the oldest are evicted beyond the cap", () => {
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) ids.push(dropPile(db, { body: "meridian", x: i, y: 0, z: 0, items: [i], coins: 0, ownerName: "B", now: 1000 + i }, 3).pile.id);
    dropPile(db, { body: "arcadia", x: 0, y: 0, z: 0, items: [], coins: 1, ownerName: "C" }, 3);
    const r = dropPile(db, { body: "meridian", x: 9, y: 0, z: 0, items: [9], coins: 0, ownerName: "B", now: 2000 }, 3);
    expect(r.evicted).toEqual([ids[1]]); // ids[0] was evicted by the 4th drop
    expect(listPiles(db, "meridian").map((p) => p.x)).toEqual([2, 3, 9]);
    expect(listPiles(db, "arcadia")).toHaveLength(1);
    // ids are never reused after eviction (a stale client can't loot a newer pile by id)
    expect(r.pile.id).toBeGreaterThan(Math.max(...ids));
  });
});

describe("hall of firsts", () => {
  it("engraves only the first finder of each secret", () => {
    expect(claimFirst(db, "arcadia-egg-1", "u1", "Ann", 10)).toEqual({ won: true, entry: { secretId: "arcadia-egg-1", userId: "u1", displayName: "Ann", foundAt: 10 } });
    expect(claimFirst(db, "arcadia-egg-1", "u2", "Bob", 20)).toEqual({ won: false, entry: { secretId: "arcadia-egg-1", userId: "u1", displayName: "Ann", foundAt: 10 } });
    expect(claimFirst(db, "arcadia-egg-2", "u2", "Bob", 30).won).toBe(true);
    expect(listHallOfFirsts(db).map((e) => e.displayName)).toEqual(["Ann", "Bob"]);
  });
});

describe("characters and death", () => {
  it("save/load round-trips, and saving needs the account row", () => {
    expect(saveCharacter(db, "ghost", char(2))).toBe(false);
    ensureAccount(db, "u1");
    expect(saveCharacter(db, "u1", char(2), 555)).toBe(true);
    expect(loadCharacter(db, "u1")).toEqual({ ...char(2), userId: "u1", updatedAt: 555 });
    ensureAccount(db, "u2");
    expect(saveCharacters(db, [{ userId: "u1", data: char(3) }, { userId: "u2", data: char(1) }, { userId: "nobody", data: char(1) }])).toBe(2);
    expect(loadCharacter(db, "u1")?.level).toBe(3);
  });

  it("death resets level/xp/items/coins/missions; account, name, medals, Hall of Firsts and pads are kept", () => {
    ensureAccount(db, "u1");
    setDisplayName(db, "u1", "Ann");
    saveCharacter(db, "u1", char(7));
    awardMedal(db, "u1", "survivor");
    discoverPad(db, "u1", "hollowmere", "pad-1");
    claimFirst(db, "egg", "u1", "Ann");
    const dead = killCharacter(db, "u1");
    expect(dead?.level).toBe(7);
    expect(loadCharacter(db, "u1")).toBeNull();
    expect(getAccount(db, "u1")?.displayName).toBe("Ann");
    expect(listMedals(db, "u1").map((m) => m.medalId)).toEqual(["survivor"]);
    expect(listDiscoveredPads(db, "u1")).toEqual([{ body: "hollowmere", padId: "pad-1" }]);
    expect(listHallOfFirsts(db)[0]?.userId).toBe("u1");
    // rebirth
    expect(saveCharacter(db, "u1", char(1, { inventory: [] }))).toBe(true);
    expect(loadCharacter(db, "u1")).toMatchObject({ level: 1, inventory: [] });
  });

  it("medals are earned once and can be worn as a title", () => {
    ensureAccount(db, "u1");
    expect(awardMedal(db, "u1", "m1")).toBe(true);
    expect(awardMedal(db, "u1", "m1")).toBe(false);
    expect(setTitleMedal(db, "u1", "m2")).toBe(false);
    expect(setTitleMedal(db, "u1", "m1")).toBe(true);
    expect(getAccount(db, "u1")?.titleMedal).toBe("m1");
    expect(discoverPad(db, "u1", "portus", "p")).toBe(true);
    expect(discoverPad(db, "u1", "portus", "p")).toBe(false);
  });
});

describe("linking a guest to an account", () => {
  it("moves everything and is idempotent", () => {
    ensureAccount(db, "guest", 100);
    setDisplayName(db, "guest", "Mira");
    saveCharacter(db, "guest", char(4));
    awardMedal(db, "guest", "m1");
    discoverPad(db, "guest", "arcadia", "p1");
    blockUser(db, "guest", "troll");
    blockUser(db, "fan", "guest");
    claimFirst(db, "egg", "guest", "Mira");
    dropPile(db, { body: "arcadia", x: 0, y: 0, z: 0, items: [], coins: 1, ownerId: "guest", ownerName: "Mira" });
    fileReport(db, { reporter: "guest", target: "troll", reason: "spam" });
    const sid = startSession(db, { userId: "guest", startedAt: 100 });

    const r = linkAccounts(db, "guest", "acct", 200);
    expect(r).toEqual({ character: "guest", displayName: "Mira", merged: false });
    expect(getAccount(db, "guest")).toBeNull();
    expect(getAccount(db, "acct")).toMatchObject({ displayName: "Mira", createdAt: 100 });
    expect(loadCharacter(db, "acct")?.level).toBe(4);
    expect(listMedals(db, "acct")).toHaveLength(1);
    expect(listDiscoveredPads(db, "acct")).toHaveLength(1);
    expect(listBlocked(db, "acct")).toEqual(["troll"]);
    expect(isBlockedEitherWay(db, "fan", "acct")).toBe(true);
    expect(listHallOfFirsts(db)[0]?.userId).toBe("acct");
    expect(listPiles(db, "arcadia")[0]?.ownerId).toBe("acct");
    expect(listReports(db)[0]?.reporter).toBe("acct");
    endSession(db, sid, { endedAt: 300 });
    expect(sessionStats(db).players).toBe(1);

    // running it again changes nothing
    expect(linkAccounts(db, "guest", "acct", 300)).toEqual({ character: "account", displayName: "Mira", merged: true });
    expect(loadCharacter(db, "acct")?.level).toBe(4);
    expect(setDisplayName(db, "other", "mira")).toEqual({ ok: false, error: "taken" });
  });

  it("merge: higher-level character wins (either side), medals and pads union, target name kept", () => {
    ensureAccount(db, "acct");
    setDisplayName(db, "acct", "Keeper");
    saveCharacter(db, "acct", char(3));
    awardMedal(db, "acct", "a");
    ensureAccount(db, "g1");
    setDisplayName(db, "g1", "Visitor");
    saveCharacter(db, "g1", char(9));
    awardMedal(db, "g1", "a");
    awardMedal(db, "g1", "b");
    discoverPad(db, "g1", "portus", "x");
    expect(linkAccounts(db, "g1", "acct")).toEqual({ character: "guest", displayName: "Keeper", merged: true });
    expect(loadCharacter(db, "acct")?.level).toBe(9);
    expect(listMedals(db, "acct").map((m) => m.medalId).sort()).toEqual(["a", "b"]);
    // the guest's name is released
    expect(setDisplayName(db, "someone", "Visitor").ok).toBe(true);

    ensureAccount(db, "g2");
    saveCharacter(db, "g2", char(2));
    expect(linkAccounts(db, "g2", "acct").character).toBe("account");
    expect(loadCharacter(db, "acct")?.level).toBe(9);
    expect(loadCharacter(db, "g2")).toBeNull();
  });

  it("a banned guest stays banned after saving", () => {
    ensureAccount(db, "g", 1, "iphash");
    banUser(db, { userId: "g", reason: "x" });
    linkAccounts(db, "g", "acct");
    expect(isBanned(db, "acct")).toBe(true);
    expect(isIpBanned(db, "iphash")).toBe(true);
  });
});

describe("bans", () => {
  it("ban the account and its last IP; temporary bans expire", () => {
    ensureAccount(db, "u1", 1, "h1");
    banUser(db, { userId: "u1", until: 1000, now: 0 });
    expect(isBanned(db, "u1", 500)).toBe(true);
    expect(isIpBanned(db, "h1", 500)).toBe(true);
    expect(isBanned(db, "u1", 1500)).toBe(false);
    expect(getAccount(db, "u1")?.bannedUntil).toBe(1000);
  });
});

describe("session log and retention", () => {
  it("summarises sessions and computes D1/D7 return", () => {
    const DAY = 86_400_000;
    const day0 = 20_000 * DAY;
    // a: plays day 0, day 1 and day 7; b: day 0 only; c: day 1 only
    for (const [u, d, len] of [["a", 0, 5], ["a", 1, 20], ["a", 7, 70], ["b", 0, 0.5], ["c", 1, 3]] as const) {
      const id = startSession(db, { userId: u, startedAt: day0 + d * DAY + 1000, backend: u === "b" ? "webgl2" : "webgpu", tier: "high" });
      updateSession(db, id, { deaths: 1, maxLevel: 2, bodyTime: { portus: 1000 } });
      endSession(db, id, { endedAt: day0 + d * DAY + 1000 + len * 60_000 });
    }
    const r = retention(db, day0 + 8 * DAY, 30);
    expect(r.cohorts).toEqual([
      { day: new Date(day0).toISOString().slice(0, 10), cohort: 2, d1: 1, d7: 1 },
      { day: new Date(day0 + DAY).toISOString().slice(0, 10), cohort: 1, d1: 0, d7: 0 },
    ]);
    expect(r.d1Rate).toBeCloseTo(1 / 3);
    const s = sessionStats(db);
    expect(s).toMatchObject({ sessions: 5, players: 3, open: 0, deaths: 5, backend: { webgpu: 4, webgl2: 1 }, bodyTimeMs: { portus: 5000 } });
    expect(s.playtime).toEqual({ "<1m": 1, "1-5m": 1, "5-15m": 1, "15-30m": 1, "30-60m": 0, "60m+": 1 });
  });
});

describe("reports and blocks", () => {
  it("files and lists reports; blocks are one-way but checked both ways", () => {
    fileReport(db, { reporter: "a", target: "b", body: "arcadia", pos: [1, 2, 3], reason: "rude", now: 5 });
    expect(listReports(db)).toEqual([{ id: 1, reporter: "a", target: "b", body: "arcadia", pos: [1, 2, 3], reason: "rude", createdAt: 5 }]);
    expect(blockUser(db, "a", "b")).toBe(true);
    expect(blockUser(db, "a", "a")).toBe(false);
    expect(isBlockedEitherWay(db, "b", "a")).toBe(true);
    expect(isBlockedEitherWay(db, "b", "c")).toBe(false);
  });
});

describe("OTP send budget", () => {
  it("allows 3 per email per hour and a global daily cap; released sends don't count", () => {
    const lim = { perEmailPerHour: 3, perDay: 5 };
    const t = 50 * 86_400_000;
    for (let i = 0; i < 3; i++) expect(reserveOtpSend(db, "e1", lim, t + i).ok).toBe(true);
    expect(reserveOtpSend(db, "e1", lim, t + 10)).toEqual({ ok: false, reason: "email" });
    expect(reserveOtpSend(db, "e1", lim, t + 3_600_001).ok).toBe(true); // an hour later
    const r = reserveOtpSend(db, "e2", lim, t + 3_600_002);
    expect(r.ok).toBe(true);
    expect(reserveOtpSend(db, "e3", lim, t + 3_600_003)).toEqual({ ok: false, reason: "global" });
    if (r.ok) releaseOtpSend(db, r.id);
    expect(reserveOtpSend(db, "e3", lim, t + 3_600_004).ok).toBe(true);
    expect(reserveOtpSend(db, "e4", lim, t + 86_400_000).ok).toBe(true); // next UTC day
  });
});

describe("display-name filter", () => {
  it("checks shape and catches slurs in common disguises without flagging ordinary names", () => {
    expect(nameShapeProblem("ab")).toBe("length");
    expect(nameShapeProblem("abc")).toBeNull();
    expect(nameShapeProblem("a".repeat(16))).toBeNull();
    expect(nameShapeProblem("a-b-c")).toBe("chars");
    for (const bad of ["n1gg3r", "xX_fag_Xx", "FagLord", "kike99", "Sh1tHead", "f_u_c_k", "retard_9", "HitlerFan", "spic_lord", "tranny"]) {
      expect(isOffensiveName(bad), bad).toBe(true);
    }
    for (const ok of ["Ann_1", "Scunthorpe", "classic", "assassin", "Grass_Hopper", "Cassie", "Hancock", "Therapist", "Wanderer_42", "Japan", "Niger_River"]) {
      expect(isOffensiveName(ok), ok).toBe(false);
    }
  });
});
