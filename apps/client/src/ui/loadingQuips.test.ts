import { describe, expect, it } from "vitest";
import { loaderQuips, OPEN_SOURCE_QUIPS, QUIPS, quipDeck, reportsTrouble } from "./loadingQuips.ts";

/** A small seeded PRNG (mulberry32) so every case is repeatable. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const deal = <T>(d: { next(): T }, n: number) => Array.from({ length: n }, () => d.next());

describe("quipDeck (a shuffled deck of loader lines)", () => {
  it("deals every line once before any line comes back, round after round", () => {
    const lines = ["a", "b", "c", "d", "e", "f", "g"];
    const d = quipDeck(lines, seeded(7));
    for (let round = 0; round < 6; round++) {
      expect([...deal(d, lines.length)].sort()).toEqual(lines);
    }
  });

  it("never shows the same line twice in a row, also across a reshuffle", () => {
    // Three lines: a reshuffle that starts with the line just shown is likely (1 in 3), so a deck
    // that doesn't guard the seam repeats within a few hundred seeds.
    for (let seed = 1; seed <= 400; seed++) {
      const seq = deal(quipDeck(["a", "b", "c"], seeded(seed)), 30);
      for (let i = 1; i < seq.length; i++) expect(seq[i], `seed ${seed}, line ${i}`).not.toBe(seq[i - 1]);
    }
  });

  it("is deterministic for a given random, and the first line depends on it", () => {
    const a = deal(quipDeck(QUIPS, seeded(42)), 60);
    const b = deal(quipDeck(QUIPS, seeded(42)), 60);
    expect(a).toEqual(b);
    const firsts = new Set(Array.from({ length: 40 }, (_, s) => quipDeck(QUIPS, seeded(s + 1)).next()));
    expect(firsts.size).toBeGreaterThan(10);
  });

  it("copes with one line (deals it forever) and keeps its own copy of the list", () => {
    expect(deal(quipDeck(["only"], seeded(1)), 4)).toEqual(["only", "only", "only", "only"]);
    const lines = ["x", "y"];
    const d = quipDeck(lines, seeded(3));
    lines.length = 0;
    expect([...deal(d, 2)].sort()).toEqual(["x", "y"]);
  });
});

describe("QUIPS (the loader's funny lines)", () => {
  it("has the owner's three and ~25 more, each short and different", () => {
    for (const q of ["Putting better graphics in…", "Looking for the meaning of life…", "Contemplating the universe…"]) expect(QUIPS).toContain(q);
    expect(QUIPS.length).toBeGreaterThanOrEqual(28);
    expect(new Set(QUIPS).size).toBe(QUIPS.length);
    for (const q of QUIPS) {
      expect(q.length, q).toBeLessThanOrEqual(45);
      expect(q, "nothing that reads like an error").not.toMatch(/error|fail|crash|broke|wrong|stuck|retry/i);
    }
  });
});

describe("OPEN_SOURCE_QUIPS (with the repo public, D-showcase-3)", () => {
  it("say it's open source: contribute, or clone it and build your own; same rules as the rest", () => {
    expect(OPEN_SOURCE_QUIPS.length).toBeGreaterThanOrEqual(3);
    expect(OPEN_SOURCE_QUIPS.length).toBeLessThanOrEqual(6); // a few among ~30, not a sales pitch
    const all = OPEN_SOURCE_QUIPS.join(" ");
    expect(all).toMatch(/open source/i);
    expect(all).toMatch(/\bhelp\b|contribut/i);
    expect(all).toMatch(/\b(clone|fork)\b/i);
    expect(all).toMatch(/your own/i);
    expect(new Set([...QUIPS, ...OPEN_SOURCE_QUIPS]).size).toBe(QUIPS.length + OPEN_SOURCE_QUIPS.length);
    for (const q of OPEN_SOURCE_QUIPS) {
      expect(q.length, q).toBeLessThanOrEqual(45);
      expect(q, "nothing that reads like an error").not.toMatch(/error|fail|crash|broke|wrong|stuck|retry/i);
      expect(reportsTrouble(q), q).toBe(false);
    }
  });

  it("join the deck only when the repo is public", () => {
    expect(loaderQuips(false)).toEqual(QUIPS);
    expect(loaderQuips(true)).toEqual([...QUIPS, ...OPEN_SOURCE_QUIPS]);
  });
});

describe("reportsTrouble (loader lines that get no quip under them)", () => {
  it("is true for lines that report a problem", () => {
    for (const t of ["The server couldn't save just now. Rejoining shortly…", "Reconnecting…", "Reconnecting… (try 3)", "Connection lost. Rejoining…", "Disconnected from the server…", "Lost the connection…", "Saving trouble: rejoining…", "Couldn't reach the server. Trying again…", "Something failed"]) {
      expect(reportsTrouble(t), t).toBe(true);
    }
  });

  it("is false for every normal loading line", () => {
    for (const t of ["Loading the game…", "Starting the renderer…", "Travelling to Arcadia…", "Connecting…", "Building the world…", "Loading characters…", "Raising the town…", "Raising the outpost…", "Tuning graphics for this computer…", "Preparing shaders…", "Preparing shaders 120/242", "Warming up shaders…", "Applying graphics settings…"]) {
      expect(reportsTrouble(t), t).toBe(false);
    }
  });
});
