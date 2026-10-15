import { describe, expect, it } from "vitest";
import { WAYPOINT_REACH, WaypointStore } from "./waypoint.ts";

function memStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

const R = 500;

describe("waypoint (client-only destination, one per body)", () => {
  it("keeps one waypoint per body and survives a reload", () => {
    const store = memStore();
    const a = new WaypointStore(store);
    a.set("arcadia", [0, 2, 0]);
    a.set("portus", [1, 0, 0]);
    expect(a.get("arcadia")).toEqual([0, 1, 0]); // normalised
    expect(a.get("hollowmere")).toBeNull();
    const b = new WaypointStore(store);
    expect(b.get("arcadia")).toEqual([0, 1, 0]);
    expect(b.get("portus")).toEqual([1, 0, 0]);
    b.clear("arcadia");
    expect(new WaypointStore(store).get("arcadia")).toBeNull();
    expect(new WaypointStore(store).get("portus")).toEqual([1, 0, 0]);
  });

  it("ignores corrupt or foreign storage", () => {
    for (const raw of ["{nope", "[1,2]", '["a","b","c"]', "[0,0,0]", '{"x":1}', "[NaN,1,2]"]) {
      expect(new WaypointStore(memStore({ "fl.waypoint.arcadia": raw })).get("arcadia")).toBeNull();
    }
    expect(new WaypointStore(null).get("arcadia")).toBeNull();
  });

  it("clears itself when you arrive, once", () => {
    const s = new WaypointStore(memStore());
    s.set("arcadia", [0, 1, 0]);
    const far: [number, number, number] = [0.2 * R, 0.98 * R, 0];
    expect(s.arrive("arcadia", far, R)).toBe(false);
    expect(s.get("arcadia")).not.toBeNull();
    const near: [number, number, number] = [(WAYPOINT_REACH - 1), R + 3, 0]; // a few metres up a slope still counts
    expect(s.arrive("arcadia", near, R)).toBe(true);
    expect(s.get("arcadia")).toBeNull();
    expect(s.arrive("arcadia", near, R)).toBe(false);
  });

  it("tells listeners about changes", () => {
    const s = new WaypointStore(memStore());
    const seen: string[] = [];
    const off = s.onChange((body, d) => seen.push(`${body}:${d ? "set" : "clear"}`));
    s.set("meridian", [0, 0, 1]);
    s.clear("meridian");
    s.clear("meridian"); // already clear: no event
    off();
    s.set("meridian", [0, 0, 1]);
    expect(seen).toEqual(["meridian:set", "meridian:clear"]);
  });
});
