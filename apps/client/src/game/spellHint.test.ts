import { describe, expect, it } from "vitest";
import { SpellHint, type SpellHintNow } from "./spellHint.ts";

const store = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const out: SpellHintNow = { safe: false, ready: true, playing: true, tutorial: false };

describe("the first spell hint", () => {
  it("waits for the wilds, a ready Skipstep, a playable world and the end of the tutorial", () => {
    const h = new SpellHint(store());
    expect(h.due({ ...out, safe: true })).toBe(false);
    expect(h.due({ ...out, ready: false })).toBe(false);
    expect(h.due({ ...out, playing: false })).toBe(false);
    expect(h.due({ ...out, tutorial: true })).toBe(false);
    expect(h.seen).toBe(false);
    expect(h.due(out)).toBe(true);
  });

  it("shows once, and is remembered by the browser", () => {
    const s = store();
    const h = new SpellHint(s);
    expect(h.due(out)).toBe(true);
    expect(h.due(out)).toBe(false);
    expect(new SpellHint(s).seen).toBe(true);
    expect(new SpellHint(s).due(out)).toBe(false);
  });

  it("a player who casts first never sees it", () => {
    const s = store();
    const h = new SpellHint(s);
    h.cast();
    expect(h.due(out)).toBe(false);
    expect(new SpellHint(s).seen).toBe(true);
  });

  it("works without storage (once per page)", () => {
    const h = new SpellHint(null);
    expect(h.due(out)).toBe(true);
    expect(h.due(out)).toBe(false);
  });
});
