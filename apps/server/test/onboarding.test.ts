// Onboarding (SPEC §6.12, content.md §1.1): the server counts training-dummy hits in Portus, pays
// 3 × 10 + 20 = 50 XP and the Spark medal once per account, and a skip pays nothing more.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BODIES } from "@firstlight/shared";
import { dummyPos, ONBOARDING, TRAINING_DUMMIES } from "@firstlight/shared/content/onboarding";
import { offsetDir, placeDir } from "@firstlight/shared/content/places";
import { WEAPON_BY_ID } from "@firstlight/shared/content/weapons";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dummyStat } from "@firstlight/shared/content/onboarding";
import type { CharacterData } from "@firstlight/shared/content/character";
import { openGameDb } from "../src/db/index.ts";
import { characterRepo } from "../src/world/characters.ts";
import { OnboardingSystem } from "../src/world/onboarding.ts";
import { pileStore } from "../src/world/piles.ts";
import { progressStore, SqliteProgressStore } from "../src/world/quests/store.ts";
import { SqliteCharacterRepo, SqlitePileStore } from "../src/world/sqliteStores.ts";
import { safeLeave, startServer } from "./helpers.ts";
import { bot, ground, harness, me, serverRoom, sleep, terrain, tpAndWait, until, type Bot } from "./quest-helpers.ts";

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

/** Hit dummy `i` until it's down, waiting out the weapon's attack rate between swings. */
async function knockDown(b: Bot, i: number, weaponId: string) {
  const gap = WEAPON_BY_ID.get(weaponId)!.tiers[0].rate * 1000 + 60;
  for (let n = 0; n < HITS; n++) {
    b.send("train", aim(b, i));
    await until(`hit ${n + 1} on dummy ${i}`, () => b.you.onboarding === undefined || b.you.onboarding.hits[i] >= n + 1, 3000);
    await sleep(gap);
  }
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

  it("counts melee hits on the server, at the weapon's rate, and pays 10 XP per dummy", async () => {
    const b = await bot("swordling", "portus", "admin", { starter: 1 }); // Brother Ash: Sunbrand
    await tpAndWait(b, inFront(0, 1.3));
    b.send("train", aim(b, 0));
    b.send("train", aim(b, 0)); // too soon after the first: not counted
    await until("first hit", () => b.you.onboarding?.hits[0] === 1);
    await sleep(600);
    expect(b.you.onboarding.hits[0]).toBe(1);
    expect(b.last("train")).toEqual({ dummy: 0, hits: 1, down: false });
    await knockDown(b, 0, "sunbrand");
    await until("down", () => b.you.onboarding.hits[0] === HITS);
    expect(b.last("train")).toEqual({ dummy: 0, hits: HITS, down: true });
    expect(b.you.xp).toBe(ONBOARDING.DUMMY_XP);
    // Out of reach: no hit.
    await tpAndWait(b, inFront(1, 8));
    await sleep(500);
    b.send("train", aim(b, 1));
    await sleep(400);
    expect(b.you.onboarding.hits[1]).toBe(0);
  });

  it("counts ranged hits along the aim ray and ignores misses", async () => {
    const b = await bot("gunner", "portus", "admin", { starter: 3 }); // Unit 7: Pocket Carbine
    await tpAndWait(b, inFront(1, 8));
    b.send("train", aim(b, 1, true));
    await sleep(400);
    expect(b.you.onboarding.hits).toEqual([0, 0, 0]);
    b.send("train", aim(b, 1));
    await until("hit", () => b.you.onboarding.hits[1] === 1);
    expect(me(b).hp).toBe(me(b).maxHp); // nobody got hurt: it's a safe zone
  });

  it("finishing pays 50 XP in all, level 2 and the Spark medal, once per account", async () => {
    const b = await bot("graduate", "portus", "admin", { starter: 3 });
    for (let i = 0; i < N; i++) {
      await tpAndWait(b, inFront(i, 6));
      await knockDown(b, i, "carbine");
    }
    await until("done", () => b.you.onboarding === undefined && b.count("onboarding") > 0);
    expect(b.last("onboarding")).toEqual({ state: "done", xp: 50 });
    await until("spark", () => b.you.medals.includes("spark"));
    expect(b.you.level).toBe(2);
    expect(totalXp(b)).toBe(50);
    await safeLeave(b.room);
    const again = await bot("graduate", "portus");
    expect(again.you.onboarding).toBeUndefined();
    expect(again.you.level).toBe(2);
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
    await safeLeave(b.room);
    const again = await bot("skipper", "portus");
    expect(again.you.onboarding).toBeUndefined();
  });

  it("keeps knocked-down dummies across a rejoin (no second payout)", async () => {
    const b = await bot("returner", "portus", "admin", { starter: 3 });
    await tpAndWait(b, inFront(2, 6));
    await knockDown(b, 2, "carbine");
    await until("paid", () => b.you.xp === ONBOARDING.DUMMY_XP);
    await safeLeave(b.room);
    const again = await bot("returner", "portus");
    expect(again.you.onboarding).toEqual({ hits: [0, 0, HITS] });
    expect(again.you.xp).toBe(ONBOARDING.DUMMY_XP);
  });

  it("isn't offered to characters that have already lived (died before, or past level 1)", async () => {
    const b = await bot("veteran", "portus");
    await safeLeave(b.room);
    const c = characterRepo.current.load("veteran")!;
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
});

const onboardingOf = (b: Bot) => serverRoom(b).systems.find((x): x is OnboardingSystem => x instanceof OnboardingSystem)!;

describe("onboarding rewards are atomic (SQLite, D26)", () => {
  it("a failed save leaves no payout flag, completion, XP or medal behind, and a retry pays exactly once", async () => {
    const db = openGameDb(join(mkdtempSync(join(tmpdir(), "fl-onb-")), "game.db"));
    const repo = new SqliteCharacterRepo(db);
    characterRepo.current = repo;
    pileStore.current = new SqlitePileStore(db);
    progressStore.current = new SqliteProgressStore(db);
    const store = progressStore.current;
    const b = await bot("fragile", "portus", "admin", { starter: 3 });
    for (const i of [0, 1]) {
      await tpAndWait(b, inFront(i, 6));
      await knockDown(b, i, "carbine");
    }
    await until("two paid", () => b.you.xp === 2 * ONBOARDING.DUMMY_XP);
    await tpAndWait(b, inFront(2, 6));
    for (let n = 1; n < HITS; n++) {
      await sleep(300);
      b.send("train", aim(b, 2));
      await until(`hit ${n}`, () => b.you.onboarding.hits[2] === n);
    }
    // The payout transaction's character save (the one carrying the new XP) fails once.
    const save = repo.save.bind(repo);
    let failing = true;
    repo.save = (uid: string, c: CharacterData) => {
      if (failing && uid === "fragile" && c.xp > 2 * ONBOARDING.DUMMY_XP) throw new Error("disk I/O error (injected)");
      save(uid, c);
    };
    await sleep(300);
    b.send("train", aim(b, 2));
    await sleep(600);
    expect(b.you.onboarding.hits[2]).toBe(HITS - 1); // the hit is undone
    expect(b.count("onboarding")).toBe(0);
    expect(b.last("train")).toEqual({ dummy: 2, hits: HITS - 1, down: false });
    expect(store.stat("fragile", dummyStat(2))).toBe(0);
    expect(store.stat("fragile", ONBOARDING.STAT)).toBe(0);
    expect(store.medals("fragile")).not.toContain("spark");
    expect(repo.load("fragile")!.xp).toBe(2 * ONBOARDING.DUMMY_XP);
    expect(b.you.medals).not.toContain("spark");
    // Retry once saving works again: everything lands together, once.
    failing = false;
    b.send("train", aim(b, 2));
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
