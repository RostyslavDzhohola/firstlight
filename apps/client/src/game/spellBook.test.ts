import { describe, expect, it } from "vitest";
import { AETHER, SPELLS, type SpellsYou } from "@firstlight/shared/content/spells";
import { blockText, castDeniedText, SpellBook } from "./spellBook.ts";

const T = 1_000_000;
const you = (over: Partial<SpellsYou> = {}): SpellsYou => ({ aether: 100, t: T, regenAt: 0, ready: [0, 0, 0, 0], ...over });
const slot = (b: SpellBook, id: string, now = T) => b.view(now).slots.find((s) => s.id === id)!;

describe("the spellbook the HUD draws", () => {
  it("locks spells by level: 1 / 3 / 6 / 9, and says which level opens them", () => {
    const b = new SpellBook();
    b.setYou(you(), 1);
    expect(b.view(T).slots.map((s) => s.locked)).toEqual([false, true, true, true]);
    expect(b.view(T).slots.map((s) => s.keycap)).toEqual(["Q", "F", "X", "Z"]);
    expect(b.block("frostbloom", T)).toBe("level");
    expect(blockText(SPELLS[1]!, "level")).toBe("Frostbloom unlocks at level 3");
    b.setYou(you(), 6);
    expect(b.view(T).slots.map((s) => s.locked)).toEqual([false, false, false, true]);
    b.setYou(you(), 9);
    expect(b.view(T).slots.every((s) => s.ready)).toBe(true);
  });

  it("refills aether from the server's numbers: nothing during the pause, then 6 a second up to 100", () => {
    const b = new SpellBook();
    b.setYou(you({ aether: 40, regenAt: T + 1500 }), 9);
    expect(b.view(T + 1000).aether).toBe(40);
    expect(b.view(T + 2500).aether).toBeCloseTo(40 + AETHER.regenPerS, 5);
    expect(b.view(T + 60_000).aether).toBe(AETHER.max);
  });

  it("shows a cooldown as seconds left and a 1 → 0 sweep, then ready", () => {
    const b = new SpellBook();
    b.setYou(you({ ready: [T + 3000, 0, 0, 0] }), 1);
    const s = slot(b, "skipstep");
    expect(s.cooldown).toBeCloseTo(3);
    expect(s.cooldownFrac).toBeCloseTo(0.5);
    expect(s.ready).toBe(false);
    expect(b.block("skipstep", T)).toBe("cooldown");
    expect(slot(b, "skipstep", T + 3001).ready).toBe(true);
    expect(b.block("skipstep", T + 3001)).toBeNull();
  });

  it("marks a spell short of aether, and ready again once it has refilled", () => {
    const b = new SpellBook();
    b.setYou(you({ aether: 30 }), 9);
    expect(slot(b, "wishfall").short).toBe(true);
    expect(slot(b, "frostbloom").short).toBe(false);
    expect(b.block("wishfall", T)).toBe("aether");
    expect(slot(b, "wishfall", T + 3000).short).toBe(false); // 30 + 18 ≥ 45
  });

  it("shows a cast at once and takes it back when the server refuses", () => {
    const b = new SpellBook();
    b.setYou(you(), 9);
    b.predict("wishfall", T);
    expect(b.view(T).aether).toBe(55);
    expect(slot(b, "wishfall").cooldown).toBeCloseTo(14);
    expect(b.view(T + 1000).aether).toBe(55); // the pause
    b.refused(T + 200);
    expect(b.view(T + 200).aether).toBe(100);
    expect(slot(b, "wishfall", T + 200).ready).toBe(true);
    // The server's own state always wins.
    b.predict("skipstep", T);
    b.setYou(you({ aether: 80, regenAt: T + 1500, ready: [T + 6000, 0, 0, 0] }), 9);
    b.refused(T + 300); // a stale refusal changes nothing now
    expect(b.view(T + 300).aether).toBe(80);
  });

  it("two casts in a row, both refused: each refusal takes back its own cast and nothing is left over (review 5)", () => {
    const b = new SpellBook();
    b.setYou(you(), 9);
    // Q then F under arrival protection: the server will refuse both.
    b.predict("skipstep", T);
    b.predict("frostbloom", T + 50);
    expect(b.view(T + 50).aether).toBe(50);
    expect(slot(b, "skipstep", T + 50).cooldown).toBeGreaterThan(5);
    expect(slot(b, "frostbloom", T + 50).cooldown).toBeGreaterThan(9);
    // The first refusal answers the first cast: Skipstep is back, Frostbloom is still shown as cast.
    b.refused(T + 120);
    expect(b.view(T + 120).aether).toBe(70);
    expect(slot(b, "skipstep", T + 120).ready).toBe(true);
    expect(slot(b, "frostbloom", T + 120).cooldown).toBeGreaterThan(9);
    // The second answers the second: the book is as the server last said, no phantom cost or cooldown.
    b.refused(T + 140);
    expect(b.view(T + 140).aether).toBe(100);
    expect(b.view(T + 140).slots.every((s) => s.ready)).toBe(true);
  });

  it("two casts, the first lands and the second is refused: the server's state takes the first's place, the second comes off it", () => {
    const b = new SpellBook();
    b.setYou(you(), 9);
    const q = b.predict("skipstep", T);
    const f = b.predict("frostbloom", T + 50);
    expect([q, f]).toEqual([1, 2]);
    // The server's word after the first cast only (`req` says how far it has got): the second is still shown on top of it.
    b.setYou(you({ aether: 80, t: T + 30, regenAt: T + 1530, ready: [T + 6030, 0, 0, 0], req: q }), 9);
    expect(b.view(T + 60).aether).toBe(50);
    expect(slot(b, "frostbloom", T + 60).cooldown).toBeGreaterThan(9);
    // Its refusal names it.
    expect(b.refused(T + 120, f)).toBe("frostbloom");
    expect(b.view(T + 120).aether).toBe(80);
    expect(slot(b, "frostbloom", T + 120).ready).toBe(true);
    expect(slot(b, "skipstep", T + 120).cooldown).toBeGreaterThan(5); // the one that landed stays spent
    // A refusal for a cast already answered changes nothing.
    expect(b.refused(T + 130, f)).toBeNull();
    expect(b.view(T + 130).aether).toBe(80);
  });

  it("refusals are matched by number, in any order; a state from before a cast leaves its prediction up", () => {
    const b = new SpellBook();
    b.setYou(you(), 9);
    const q = b.predict("skipstep", T);
    const z = b.predict("glasswing", T + 20);
    // A `you` sent for another reason before the server saw either cast: both stay predicted.
    b.setYou(you({ req: 0 }), 9);
    expect(b.view(T + 40).aether).toBe(45);
    expect(b.refused(T + 60, z)).toBe("glasswing");
    expect(b.view(T + 60).aether).toBe(80);
    expect(b.refused(T + 70, q)).toBe("skipstep");
    expect(b.view(T + 70).aether).toBe(100);
  });

  it("a cast the server never answers (dropped by the rate limit) stops being shown after 2 s", () => {
    const b = new SpellBook();
    b.setYou(you(), 9);
    b.predict("wishfall", T);
    expect(b.view(T + 1400).aether).toBe(55);
    expect(slot(b, "wishfall", T + 1400).ready).toBe(false);
    expect(b.view(T + 2100).aether).toBe(100);
    expect(slot(b, "wishfall", T + 2100).ready).toBe(true);
    expect(b.block("wishfall", T + 2100)).toBeNull();
  });

  it("shows the ward while it is up", () => {
    const b = new SpellBook();
    b.setYou(you({ ward: { hp: 30, max: 54, until: T + 2000 } }), 9);
    expect(b.view(T).ward).toEqual({ hp: 30, max: 54, left: 2 });
    expect(b.view(T + 2500).ward).toBeNull();
  });

  it("before the server has said anything: a full book at the character's level", () => {
    const b = new SpellBook();
    expect(b.known).toBe(false);
    expect(b.view(T).aether).toBe(100);
    expect(b.block("skipstep", T)).toBeNull();
  });

  it("puts the server's refusals into words", () => {
    expect(castDeniedText("safe zone", SPELLS[0])).toBe("No spells in safe zones");
    expect(castDeniedText("blocked", SPELLS[0])).toBe("No room to Skipstep that way");
    expect(castDeniedText("blocked", SPELLS[2])).toBe("No clear ground there for Wishfall");
    expect(castDeniedText("aether", SPELLS[2])).toBe("Not enough aether for Wishfall");
    expect(castDeniedText("dir", SPELLS[0])).toBeNull();
  });
});
