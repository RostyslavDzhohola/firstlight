import { describe, expect, it } from "vitest";
import { SAMPLE_FALLBACKS } from "../audio/sounds.ts";
import { PRESETS } from "../audio/presets.ts";
import { BANNER_GAP_MS, BANNER_IN_MS, BANNER_OUT_MS, bannerCovers, BannerQueue, levelMoments, medalMoment, missionMoments, MOMENT_SOUNDS, nextSpell, rewardLine, spellUnlocks, type Moment } from "./moments.ts";

const m = (title: string, over: Partial<Moment> = {}): Moment => ({ kind: "mission", kicker: "k", title, reward: "", sprite: "flag", ms: 1000, ...over });

describe("the banners' words", () => {
  it("a reward line leaves out what is zero", () => {
    expect(rewardLine(180, 60)).toBe("+180 XP · +60 ◎");
    expect(rewardLine(0, 600, "Gleamweave Cape")).toBe("+600 ◎ · Gleamweave Cape");
    expect(rewardLine(2400, 0)).toBe("+2,400 XP");
    expect(rewardLine(0, 0)).toBe("");
  });

  it("spells unlock at levels 3, 6 and 9, each with its key", () => {
    expect(spellUnlocks(1, 2)).toEqual([]);
    expect(spellUnlocks(2, 3).map((s) => s.id)).toEqual(["frostbloom"]);
    expect(spellUnlocks(5, 6).map((s) => s.keycap)).toEqual(["X"]);
    expect(spellUnlocks(8, 9).map((s) => s.name)).toEqual(["Glasswing Ward"]);
    // An admin jump across several levels names every spell on the way.
    expect(spellUnlocks(1, 9).map((s) => s.id)).toEqual(["frostbloom", "wishfall", "glasswing"]);
    expect(nextSpell(1)?.id).toBe("frostbloom");
    expect(nextSpell(9)).toBeNull();
  });

  it("a level-up says the level and what comes next; a spell level adds its own banner with the key", () => {
    expect(levelMoments(4, 4)).toEqual([]);
    expect(levelMoments(3, 2)).toEqual([]);
    const plain = levelMoments(3, 4);
    expect(plain).toHaveLength(1);
    expect(plain[0]).toMatchObject({ kind: "level", kicker: "Level up", title: "Level 4", reward: "More health and damage · Wishfall at level 6" });
    const withSpell = levelMoments(2, 3);
    expect(withSpell.map((x) => x.kind)).toEqual(["level", "spell"]);
    expect(withSpell[1]).toMatchObject({ kicker: "New spell", title: "Frostbloom", key: "F", sprite: "spell-frostbloom" });
    expect(levelMoments(9, 10)[0]!.reward).toBe("More health and damage");
  });

  it("a mission pays in one banner; a timed one is a trial won; a trial of the hunt adds its gleam", () => {
    expect(missionMoments("A3", 180, 60)).toMatchObject([{ kind: "mission", kicker: "Mission complete", title: "The Big Lake", reward: "+180 XP · +60 ◎" }]);
    expect(missionMoments("nope", 1, 1)).toEqual([]);
    const first = missionMoments("T1", 300, 80, []);
    expect(first.map((x) => x.kind)).toEqual(["trial", "gleam"]);
    expect(first[0]).toMatchObject({ kicker: "Trial won", title: "The Swift Gleam", reward: "+300 XP · +80 ◎ · All 8 rings" });
    expect(first[1]).toMatchObject({ kicker: "Gleam won · 1 of 3", title: "The Three Gleams", reward: "2 more open the vault in Portus Plaza" });
    // The player's list may or may not hold this one as done yet: the count is the same.
    const second = missionMoments("T2", 1000, 160, [{ id: "T1", done: true }, { id: "T2", done: false }]);
    expect(second[1]).toMatchObject({ kicker: "Gleam won · 2 of 3", reward: "1 more opens the vault in Portus Plaza" });
    expect(missionMoments("T2", 1000, 160, [{ id: "T1", done: true }, { id: "T2", done: true }])[1]!.kicker).toBe("Gleam won · 2 of 3");
    const third = missionMoments("T3", 2400, 350, [{ id: "T1", done: true }, { id: "T2", done: true }]);
    expect(third[1]!.kicker).toBe("Gleam won · 3 of 3");
    expect(third[1]!.reward).toContain("vault in Portus Plaza is waiting");
    // An untimed-with-pieces mission that isn't part of the hunt is a trial without a gleam.
    expect(missionMoments("A4", 100, 30).map((x) => x.kind)).toEqual(["trial"]);
  });

  it("the vault and a medal have their own banners", () => {
    expect(missionMoments("vault", 0, 600)).toMatchObject([{ kind: "vault", title: "The Gleam Vault opens", reward: "+600 ◎ · Gleamweave Cape" }]);
    expect(medalMoment("demolition_crew")).toMatchObject({ kind: "medal", kicker: "Medal earned", title: "Demolition Crew" });
    expect(medalMoment("demolition_crew")!.reward).toContain("“Wrecker”");
    expect(medalMoment("no_such_medal")).toBeNull();
  });

  it("names the server toasts a banner replaces, and no others", () => {
    for (const t of ["Level 3!", "Mission complete: The Big Lake · +180 XP · +60 ◎", "Medal earned: Spark — wear the title “Sparked” from the journal (J)", "Gleam won: 1 of 3 — The Three Gleams", "All three gleams won — Sela Marchbank's vault in Portus Plaza is waiting for you", "The Gleam Vault opens · +600 ◎ · Gleamweave Cape"]) {
      expect(bannerCovers(t), t).toBe(true);
    }
    for (const t of ["Training dummy down · +10 XP", "Title set: Wrecker", "Level 3 creeps ahead", "Picked up 2 item(s)", "Secret found: The Bell — Bell Charm", "First ever to open it — your name is engraved on the Hall of Firsts"]) {
      expect(bannerCovers(t), t).toBe(false);
    }
  });

  it("every banner kind has a sound made of sounds the game has", () => {
    const known = new Set([...Object.keys(SAMPLE_FALLBACKS), ...Object.keys(PRESETS)]);
    for (const [kind, cues] of Object.entries(MOMENT_SOUNDS)) {
      expect(cues.length, kind).toBeGreaterThan(0);
      for (const c of cues) expect(known.has(c.name), `${kind}: ${c.name}`).toBe(true);
    }
  });
});

describe("the banner queue", () => {
  it("shows one at a time: the next waits for the hold, the exit and a gap", () => {
    const q = new BannerQueue();
    q.push(m("a"), m("b"));
    expect(q.tick(0)).toEqual({ show: expect.objectContaining({ title: "a" }) });
    expect(q.showing?.title).toBe("a");
    expect(q.tick(500)).toBeNull();
    const leave = BANNER_IN_MS + 1000;
    expect(q.tick(leave - 1)).toBeNull();
    expect(q.tick(leave)).toEqual({ hide: true });
    // Still leaving: b doesn't show over it.
    expect(q.tick(leave + BANNER_OUT_MS)).toBeNull();
    expect(q.showing?.title).toBe("a");
    expect(q.tick(leave + BANNER_OUT_MS + BANNER_GAP_MS)).toEqual({ show: expect.objectContaining({ title: "b" }) });
    expect(q.length).toBe(0);
  });

  it("never reports a hide twice, and goes quiet when empty", () => {
    const q = new BannerQueue();
    q.push(m("a"));
    q.tick(0);
    expect(q.tick(5000)).toEqual({ hide: true });
    expect(q.tick(5001)).toBeNull();
    expect(q.tick(9000)).toBeNull();
    expect(q.showing).toBeNull();
    expect(q.tick(9001)).toBeNull();
  });

  it("a queued moment with the same merge key is replaced; the one on screen is not", () => {
    const q = new BannerQueue();
    q.push(m("Level 2", { merge: "level" }));
    q.tick(0);
    q.push(m("Level 3", { merge: "level" }), m("other"), m("Level 4", { merge: "level" }));
    expect(q.length).toBe(2);
    expect(q.showing?.title).toBe("Level 2");
    q.tick(10_000);
    expect(q.tick(20_000)).toEqual({ show: expect.objectContaining({ title: "Level 4" }) });
  });

  it("keeps at most six waiting (the oldest go) and clear empties it", () => {
    const q = new BannerQueue();
    q.push(...Array.from({ length: 9 }, (_, i) => m(`m${i}`)));
    expect(q.length).toBe(6);
    expect(q.tick(0)).toEqual({ show: expect.objectContaining({ title: "m3" }) });
    expect(q.clear()).toBe(true);
    expect(q.length).toBe(0);
    expect(q.showing).toBeNull();
    expect(q.tick(1)).toBeNull();
    q.push(m("after"));
    expect(q.tick(2)).toEqual({ show: expect.objectContaining({ title: "after" }) });
  });
});
