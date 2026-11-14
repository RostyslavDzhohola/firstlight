import { describe, expect, it } from "vitest";
import { WORLD_OBJECT_BY_ID } from "@firstlight/shared/content/world";
import { objectLabel, pickLooked } from "./missionObjects.ts";

const o = (id: string) => WORLD_OBJECT_BY_ID.get(id)!;

describe("mission objects say what they are (#86)", () => {
  it("a kite panel, a ring and a shard of an open mission name themselves and their place in the set", () => {
    expect(objectLabel(o("a4_kite_2"), [{ id: "A4", done: false, counts: [0, 0, 0, 0, 0] }])).toEqual({ title: "Kite panel 2 of 5", sub: "Kite Season · walk into it to pick it up", mission: "A4" });
    expect(objectLabel(o("t1_ring_1"), [{ id: "T1", done: false }])?.title).toBe("Ring 1 of 8");
    expect(objectLabel(o("t3_shard_8"), [{ id: "T3", done: false }])?.title).toBe("Gleam shard 8 of 8");
  });

  it("nothing for a mission not taken, done, or a piece already picked up", () => {
    expect(objectLabel(o("a4_kite_1"), [])).toBeNull();
    expect(objectLabel(o("a4_kite_1"), [{ id: "A4", done: true }])).toBeNull();
    expect(objectLabel(o("a4_kite_1"), [{ id: "A4", done: false, counts: [1, 0, 0, 0, 0] }])).toBeNull();
  });

  it("picks the object nearest the view direction, within reach", () => {
    const cam = [0, 0, 0] as const;
    const fwd = [0, 0, 1] as const;
    expect(pickLooked(cam, fwd, [[3, 0, 20], [0.5, 0, 20], [0, 0, -10]])).toBe(1);
    expect(pickLooked(cam, fwd, [[0, 0, 60]])).toBe(-1); // too far
    expect(pickLooked(cam, fwd, [[10, 0, 10]])).toBe(-1); // 45° off
    expect(pickLooked(cam, fwd, [[1.5, 0, 5]])).toBe(0); // up close the cone is wider
  });
});
