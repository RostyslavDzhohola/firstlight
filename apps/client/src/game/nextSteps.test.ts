import { describe, expect, it } from "vitest";
import { MISSION_BY_ID } from "@firstlight/shared/content/missions";
import { markHintSeen, nextHints, seenHints, trialWay } from "./nextSteps.ts";

const ids = (l: { id: string }[]) => l.map((h) => h.id);
const none = new Set<string>();

describe("what next after the tutorial (D-polish-ux-3)", () => {
  it("Arcadia: points at Lark until a guide mission is taken (Sela's trial doesn't count)", () => {
    expect(ids(nextHints({ body: "arcadia", missions: [], seen: none }))).toEqual(["lark"]);
    expect(ids(nextHints({ body: "arcadia", missions: [{ id: "T1", done: false }], seen: none }))).toEqual(["lark"]);
    expect(nextHints({ body: "arcadia", missions: [{ id: "A1", done: false }], seen: none })).toEqual([]);
  });

  it("Portus: Sela and the board only after a first mission; Sela not once a trial is held", () => {
    expect(nextHints({ body: "portus", missions: [{ id: "A1", done: false }], seen: none })).toEqual([]);
    expect(ids(nextHints({ body: "portus", missions: [{ id: "A1", done: true }], seen: none }))).toEqual(["sela", "board"]);
    expect(ids(nextHints({ body: "portus", missions: [{ id: "A1", done: true }, { id: "T2", done: false }], seen: none }))).toEqual(["board"]);
  });

  it("each shows once: seen ones are left out, and seen is kept in storage", () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    markHintSeen("sela", store);
    expect(seenHints(store).has("sela")).toBe(true);
    expect(ids(nextHints({ body: "portus", missions: [{ id: "A1", done: true }], seen: seenHints(store) }))).toEqual(["board"]);
    expect(seenHints({ getItem: () => "{bad" }).size).toBe(0);
  });

  it("trials say how to get there from Portus", () => {
    expect(trialWay(MISSION_BY_ID.get("T2")!)).toBe("Hollowmere: through the plaza's violet portal, then south to Thornwood");
    expect(trialWay(MISSION_BY_ID.get("T1")!)).toContain("Arcadia: through the plaza's cyan portal");
    expect(trialWay(MISSION_BY_ID.get("A1")!)).toBe("");
  });
});
