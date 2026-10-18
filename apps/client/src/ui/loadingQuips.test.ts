import { describe, expect, it } from "vitest";
import { QUIPS, quipDeck } from "./loadingQuips.ts";

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
