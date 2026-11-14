// Onboarding (SPEC §6.12, content.md §1.1, #68): one training swing in Portus finishes the attack
// lesson (a dummy in reach falls with it), pays 50 XP in all and the Spark medal once per account,
// and a skip pays nothing more.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BODIES } from "@firstlight/shared";
import { dummyPos, ONBOARDING, TRAINING_DUMMIES } from "@firstlight/shared/content/onboarding";
import { offsetDir, placeDir } from "@firstlight/shared/content/places";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dummyStat } from "@firstlight/shared/content/onboarding";
import type { CharacterData } from "@firstlight/shared/content/character";
import { openGameDb } from "../src/db/index.ts";
import { characterRepo } from "../src/world/characters.ts";
import { completionXp, OnboardingSystem, TUTORIAL_TOTAL_XP } from "../src/world/onboarding.ts";
import { OTP_MIN_LEVEL } from "../src/auth/better-auth.ts";
import { pileStore } from "../src/world/piles.ts";
import { progressStore, SqliteProgressStore } from "../src/world/quests/store.ts";
import { copyRestrictions } from "../src/world/quests/restrictions.ts";
import { roomCopyKey } from "../src/world/copyState.ts";
import { SqliteCharacterRepo, SqlitePileStore } from "../src/world/sqliteStores.ts";
import { safeLeave, startServer } from "./helpers.ts";
import { bot, ground, offPad, harness, me, serverRoom, sleep, terrain, tpAndWait, until, type Bot } from "./quest-helpers.ts";

beforeEach(async () => {
  harness.game = await startServer();
});
afterEach(async () => {
  for (const r of harness.rooms.splice(0)) await safeLeave(r);
  await harness.game!.close();
});

const N = TRAINING_DUMMIES.length;
const HITS = ONBOARDING.HITS_PER_DUMMY;
const feet = (i: number) => dummyPos(i, (x, y, z) => terrain("portus").groundHeight(x, y, z));

/** A spot `metres` from dummy `i`, toward the plaza centre (in front of it). */
function inFront(i: number, metres: number): [number, number, number] {
  const d = TRAINING_DUMMIES[i]!;
  const l = Math.hypot(d.east, d.north);
  const dir = offsetDir(placeDir("portus_plaza"), d.east - (d.east / l) * metres, d.north - (d.north / l) * metres, BODIES.portus.radius);
  return ground("portus", dir);
}

/** Camera-style ray from 1.6 m above our feet toward the dummy's chest (or `away` from it). */
function aim(b: Bot, i: number, away = false) {
  const p = me(b);
  const l = Math.hypot(p.x, p.y, p.z);
  const o = [p.x + (p.x / l) * 1.6, p.y + (p.y / l) * 1.6, p.z + (p.z / l) * 1.6];
  const f = feet(i);
  const fl = Math.hypot(f[0], f[1], f[2]);
  const t = [f[0] + (f[0] / fl) * 1.1, f[1] + (f[1] / fl) * 1.1, f[2] + (f[2] / fl) * 1.1];
  let d = [t[0]! - o[0]!, t[1]! - o[1]!, t[2]! - o[2]!];
  if (away) d = [-d[0]!, -d[1]!, -d[2]!];
  const dl = Math.hypot(d[0]!, d[1]!, d[2]!);
  return { ox: o[0]!, oy: o[1]!, oz: o[2]!, dx: d[0]! / dl, dy: d[1]! / dl, dz: d[2]! / dl };
}

/** One training swing at dummy `i` (or `away` from it). */
function swing(b: Bot, i: number, away = false) {
  b.send("train", aim(b, i, away));
}

const totalXp = (b: Bot) => b.you.xp + (b.you.level > 1 ? 50 : 0); // level 2 starts at 50

describe("onboarding", () => {
  it("is offered to a new character in Portus only", async () => {
    const b = await bot("rookie", "portus");
    expect(b.you.onboarding).toEqual({ hits: [0, 0, 0] });
    await safeLeave(b.room);
    const c = await bot("rookie", "arcadia");
    expect(c.you.onboarding).toBeUndefined();
  });

  it("one swing that misses everything still finishes it: 50 XP, level 2 and the Spark medal, once per account", async () => {
    const b = await bot("graduate", "portus", "admin", { starter: 3 });
    await tpAndWait(b, inFront(1, 30)); // well away from the dummies (#68: any swing counts)
    swing(b, 1, true);
    await until("done", () => b.you.onboarding === undefined && b.count("onboarding") > 0);
    expect(b.last("onboarding")).toEqual({ state: "done", xp: 50 });
    expect(b.count("train")).toBe(0); // nothing was hit
    await until("spark", () => b.you.medals.includes("spark"));
    expect(b.you.level).toBe(2);
    expect(totalXp(b)).toBe(50);
    expect(me(b).hp).toBe(me(b).maxHp); // nobody got hurt: it's a safe zone
    await safeLeave(b.room);
    const again = await bot("graduate", "portus");
    expect(again.you.onboarding).toBeUndefined();
    expect(again.you.level).toBe(2);
  });

  it("a melee swing in reach knocks that dummy down with the one hit, and the total is still 50 XP", async () => {
    const b = await bot("swordling", "portus", "admin", { starter: 1 }); // Brother Ash: Sunbrand
    await tpAndWait(b, inFront(0, 1.3));
    swing(b, 0);
    swing(b, 0); // too soon after the first: ignored
    await until("done", () => b.count("onboarding") > 0);
    expect(b.last("train")).toEqual({ dummy: 0, hits: HITS, down: true });
    expect(b.count("train")).toBe(1);
    expect(b.last("onboarding")).toEqual({ state: "done", xp: 50 });
    expect(progressStore.current.stat("swordling", dummyStat(0))).toBe(1);
    await until("level 2", () => b.you.level === 2);
    expect(totalXp(b)).toBe(50);
  });

  it("a shot along the aim ray knocks down the dummy it hits", async () => {
    const b = await bot("gunner", "portus", "admin", { starter: 3 }); // Unit 7: Pocket Carbine
    await tpAndWait(b, inFront(1, 8));
    swing(b, 1);
    await until("done", () => b.count("onboarding") > 0);
    expect(b.last("train")).toEqual({ dummy: 1, hits: HITS, down: true });
    await until("level 2", () => b.you.level === 2);
    expect(totalXp(b)).toBe(50);
  });

  it("skip ends it for good with no completion XP or medal", async () => {
    const b = await bot("skipper", "portus");
    b.send("onboarding", { action: "skip" });
    await until("skipped", () => b.you.onboarding === undefined && b.count("onboarding") > 0);
    expect(b.last("onboarding")).toEqual({ state: "skipped", xp: 0 });
    expect(b.you.xp).toBe(0);
    expect(b.you.medals).not.toContain("spark");
    b.send("train", aim(b, 0));
    await sleep(300);
    expect(b.count("train")).toBe(0);
    expect(b.count("onboarding")).toBe(1);
    await safeLeave(b.room);
    const again = await bot("skipper", "portus");
    expect(again.you.onboarding).toBeUndefined();
  });

  it("isn't offered to characters that have already lived (died before, or past level 1)", async () => {
    // A character that died before the tutorial was ever offered to its account.
    const b = await bot("donor", "portus");
    await safeLeave(b.room);
    const c = characterRepo.current.load("donor")!;
    c.deaths = 1;
    characterRepo.current.save("veteran", c);
    const again = await bot("veteran", "portus");
    expect(again.you.onboarding).toBeUndefined();
    const d = await bot("climber", "portus");
    d.send("admin", { cmd: "level", args: { level: 3 } });
    await until("level 3", () => d.you.level === 3);
    await safeLeave(d.room);
    const e = await bot("climber", "portus");
    expect(e.you.onboarding).toBeUndefined();
  });

  it("an account whose dummies were all paid before an interrupted finish completes on its next join", async () => {
    const b = await bot("interrupted", "portus");
    await safeLeave(b.room);
    for (let i = 0; i < N; i++) progressStore.current.addStat("interrupted", dummyStat(i), 1);
    const again = await bot("interrupted", "portus");
    await until("done", () => again.count("onboarding") > 0);
    expect(again.last("onboarding")).toEqual({ state: "done", xp: 50 });
    expect(progressStore.current.stat("interrupted", ONBOARDING.STAT)).toBe(1);
  });
});

describe("dying mid-tutorial (D-fixes-2)", () => {
  it("keeps the tutorial after the rebirth in Portus, and its one swing still lands on level 2", async () => {
    const b = await bot("faller", "portus", "admin", { starter: 3 });
    // Out in the wild (Arcadia here), killed, reborn: the rebirth sends the client to Portus.
    await safeLeave(b.room);
    const out = await bot("faller", "arcadia");
    await tpAndWait(out, offPad("arcadia", 0, 40));
    out.send("admin", { cmd: "unprotect" });
    await sleep(120);
    out.send("admin", { cmd: "damage", args: { amount: 5000 } });
    await until("dead", () => out.count("death") > 0);
    out.send("respawn", { starter: 3, palette: 0 });
    await until("reborn", () => out.count("reborn") > 0);
    await safeLeave(out.room);
    expect(characterRepo.current.load("faller")!.deaths).toBe(1);
    const again = await bot("faller", "portus");
    expect(again.you.onboarding).toEqual({ hits: [0, 0, 0] });
    expect(again.you.level).toBe(1);
    await tpAndWait(again, inFront(2, 6));
    swing(again, 2);
    await until("done", () => again.count("onboarding") > 0);
    await until("level 2", () => again.you.level === 2);
    expect(again.last("onboarding")).toEqual({ state: "done", xp: TUTORIAL_TOTAL_XP });
    const saved = characterRepo.current.load("faller")!;
    expect(saved.xp).toBe(TUTORIAL_TOTAL_XP);
    expect(saved.level).toBeGreaterThanOrEqual(OTP_MIN_LEVEL);
    expect(progressStore.current.stat("faller", ONBOARDING.STAT)).toBe(1);
    // Dying again pays nothing more and brings no tutorial back: nothing to farm.
    await safeLeave(again.room);
    const out2 = await bot("faller", "arcadia");
    await tpAndWait(out2, offPad("arcadia", 0, 40));
    out2.send("admin", { cmd: "unprotect" });
    await sleep(120);
    out2.send("admin", { cmd: "damage", args: { amount: 5000 } });
    await until("dead again", () => out2.count("death") > 0);
    out2.send("respawn", { starter: 3, palette: 0 });
    await until("reborn again", () => out2.count("reborn") > 0);
    await safeLeave(out2.room);
    const third = await bot("faller", "portus");
    expect(third.you.onboarding).toBeUndefined();
    expect(characterRepo.current.load("faller")!.xp).toBe(0);
  });
});

describe("completionXp (D-fixes-4)", () => {
  it("tops a level-1 trainee up to the 50 XP total, whatever a dummy already paid", () => {
    expect(TUTORIAL_TOTAL_XP).toBe(50);
    expect(completionXp(1, 3 * ONBOARDING.DUMMY_XP)).toBe(ONBOARDING.DONE_XP);
    expect(completionXp(1, 3 * ONBOARDING.DUMMY_XP + 15)).toBe(ONBOARDING.DONE_XP);
    expect(completionXp(1, 0)).toBe(50);
    expect(completionXp(1, ONBOARDING.DUMMY_XP)).toBe(40);
    expect(completionXp(2, 0)).toBe(ONBOARDING.DONE_XP);
  });
});

const onboardingOf = (b: Bot) => serverRoom(b).systems.find((x): x is OnboardingSystem => x instanceof OnboardingSystem)!;

function sqliteStores() {
  const db = openGameDb(join(mkdtempSync(join(tmpdir(), "fl-onb-")), "game.db"));
  const repo = new SqliteCharacterRepo(db);
  characterRepo.current = repo;
  pileStore.current = new SqlitePileStore(db);
  progressStore.current = new SqliteProgressStore(db);
  return { repo, store: progressStore.current };
}

describe("onboarding rewards are atomic (SQLite, D26)", () => {
  it("a failed save leaves no payout flag, completion, XP or medal behind, and a retry pays exactly once", async () => {
    const { repo, store } = sqliteStores();
    const b = await bot("fragile", "portus", "admin", { starter: 3 });
    await tpAndWait(b, inFront(2, 6));
    // The payout transaction's character save (the one carrying the new XP) fails once.
    const save = repo.save.bind(repo);
    let failing = true;
    repo.save = (uid: string, c: CharacterData) => {
      if (failing && uid === "fragile" && c.xp > 0) throw new Error("disk I/O error (injected)");
      save(uid, c);
    };
    swing(b, 2);
    await until("the hit undone", () => b.count("train") === 1);
    expect(b.last("train")).toEqual({ dummy: 2, hits: 0, down: false });
    await sleep(300);
    expect(b.you.onboarding.hits[2]).toBe(0);
    expect(b.count("onboarding")).toBe(0);
    expect(store.stat("fragile", dummyStat(2))).toBe(0);
    expect(store.stat("fragile", ONBOARDING.STAT)).toBe(0);
    expect(store.medals("fragile")).not.toContain("spark");
    expect(repo.load("fragile")!.xp).toBe(0);
    expect(b.you.medals).not.toContain("spark");
    // Retry once saving works again: everything lands together, once.
    failing = false;
    await sleep(300);
    swing(b, 2);
    await until("done", () => b.count("onboarding") === 1 && b.you.onboarding === undefined);
    expect(b.last("onboarding")).toEqual({ state: "done", xp: 50 });
    expect(store.stat("fragile", dummyStat(2))).toBe(1);
    expect(store.stat("fragile", ONBOARDING.STAT)).toBe(1);
    expect(store.medals("fragile")).toContain("spark");
    expect(repo.load("fragile")!.xp).toBe(50);
    await until("spark in you", () => b.you.medals.includes("spark"));
    expect(b.toasts.filter((t) => t.startsWith("Medal earned: Spark"))).toHaveLength(1);
  }, 30_000);
});

describe("onboarding completion pays once (SQLite, F12 final B2)", () => {
  it("a write failing after the completion committed can't leave the trainee behind to be paid again", async () => {
    const { repo, store } = sqliteStores();
    const b = await bot("doubled", "portus", "admin", { starter: 3 });
    await tpAndWait(b, inFront(2, 6));
    // The completion's save goes through; every later save fails (the probe's second write).
    const save = repo.save.bind(repo);
    let committed = false;
    repo.save = (uid: string, c: CharacterData) => {
      if (committed) throw new Error("disk I/O error (injected, after the commit)");
      save(uid, c);
      if (c.xp >= 50) committed = true;
    };
    swing(b, 2);
    await until("done", () => b.count("onboarding") === 1);
    expect(store.stat("doubled", ONBOARDING.STAT)).toBe(1);
    expect(onboardingOf(b).trainees.has("doubled")).toBe(false);
    // Another training attack after the cooldown: nothing more is paid.
    await sleep(600);
    swing(b, 1);
    await sleep(400);
    repo.save = save;
    expect(store.stat("doubled", ONBOARDING.STAT)).toBe(1);
    expect(repo.load("doubled")!.xp).toBe(50);
    expect(serverRoom(b).actors.get(b.id)!.char.xp).toBe(50);
    expect(b.toasts.filter((t) => t.startsWith("Medal earned: Spark"))).toHaveLength(1);
  }, 30_000);

  it("a trainee still active after its completion committed is retired without a second payout", async () => {
    const { repo, store } = sqliteStores();
    const b = await bot("leftover", "portus", "admin", { starter: 3 });
    await tpAndWait(b, inFront(2, 6));
    swing(b, 2);
    await until("done", () => b.count("onboarding") === 1);
    expect(repo.load("leftover")!.xp).toBe(50);
    // As if the after-commit step had failed before retiring it: the trainee is back.
    const sys = onboardingOf(b);
    sys.trainees.set("leftover", { sessionId: b.id, hits: [HITS, HITS, HITS], lastAt: 0 });
    swing(b, 2);
    await until("retired", () => !sys.trainees.has("leftover"));
    await sleep(200);
    expect(store.stat("leftover", ONBOARDING.STAT)).toBe(1);
    expect(repo.load("leftover")!.xp).toBe(50);
    expect(serverRoom(b).actors.get(b.id)!.char.xp).toBe(50);
  }, 30_000);
});

describe("onboarding in a staged Portus copy (F12 final Opus SF3)", () => {
  it("still earns the Spark medal (onboarding is offered once)", async () => {
    const b = await bot("staged_newbie", "portus", "admin", { starter: 3 });
    copyRestrictions.current.set(roomCopyKey(serverRoom(b)), { stagedUntil: Date.now() + 30 * 60_000, assistedUntil: 0 });
    await tpAndWait(b, inFront(0, 6));
    swing(b, 0);
    await until("done", () => b.count("onboarding") === 1);
    expect(progressStore.current.stat("staged_newbie", ONBOARDING.STAT)).toBe(1);
    expect(progressStore.current.medals("staged_newbie")).toContain("spark");
    await until("spark in you", () => b.you.medals.includes("spark"));
  }, 30_000);
});

describe("onboarding sessions", () => {
  it("a takeover from another window leaves exactly one trainee (the new session)", async () => {
    const a = await bot("twin", "portus");
    const sysA = onboardingOf(a);
    const b = await bot("twin", "portus");
    const sysB = onboardingOf(b);
    await until("one trainee", () => sysB.trainees.size === 1 && (sysA === sysB || sysA.trainees.size === 0), 4000);
    expect([...sysB.trainees.values()][0]!.sessionId).toBe(b.id);
    expect(b.you.onboarding).toEqual({ hits: [0, 0, 0] });
    // Leave hooks for the old session (late or repeated) must not remove the new entry.
    sysB.onPlayerLeave(a.id);
    sysB.onPlayerLeave(a.id);
    expect(sysB.trainees.size).toBe(1);
  });
});
