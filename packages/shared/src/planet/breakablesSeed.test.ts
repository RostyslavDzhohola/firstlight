// The client's fracture worker places a body's breakables and sends the list back; the main thread
// seeds its cache with that copy (Codex review of D-solid-1: the natural solids' first chunk placed
// the whole layout on the main thread, 50–90 ms in one task).
import { describe, expect, it } from "vitest";
import { bodyBreakables, bodyBreakablesReady, placeBreakables, seedBodyBreakables } from "./breakables.ts";
import { createTerrain } from "./terrain.ts";

describe("seeding the breakables layout", () => {
  it("a seeded copy (as the worker sends it) is what bodyBreakables returns, and equals the placement", () => {
    const t = createTerrain("arcadia");
    const placed = placeBreakables(t);
    expect(bodyBreakablesReady("arcadia")).toBe(false);
    const copy = structuredClone(placed);
    seedBodyBreakables("arcadia", copy);
    expect(bodyBreakablesReady("arcadia")).toBe(true);
    expect(bodyBreakables(t)).toBe(copy);
    expect(copy).toEqual(placed);
    // Seeding again doesn't replace it.
    seedBodyBreakables("arcadia", []);
    expect(bodyBreakables(t)).toBe(copy);
  });
});
