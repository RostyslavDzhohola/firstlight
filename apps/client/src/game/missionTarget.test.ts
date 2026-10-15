import { describe, expect, it } from "vitest";
import { BODIES, padDirs } from "@firstlight/shared";
import { resolveAreaDir } from "@firstlight/shared/content/arenas";
import { MISSION_BY_ID } from "@firstlight/shared/content/missions";
import { NPC_AREAS, NPC_INDEX } from "@firstlight/shared/content/npcs";
import { missionTarget } from "./missionTarget.ts";

const flat = () => 0;
const on = (body: "arcadia" | "hollowmere" | "meridian", d: readonly number[]): [number, number, number] => {
  const R = BODIES[body].radius;
  return [d[0]! * R, d[1]! * R, d[2]! * R];
};
let seq = 0;
const npc = (kind: string, p: [number, number, number], hp = 20, id = `n${++seq}`) => ({ id, kind: NPC_INDEX.get(kind)!, hp, x: p[0], y: p[1], z: p[2] });
const toward = (a: readonly number[], b: readonly number[], t: number) => {
  const v = [a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t, a[2]! + (b[2]! - a[2]!) * t];
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [v[0]! / l, v[1]! / l, v[2]! / l];
};

describe("the tracked hunt mission's pointer (no word from the server: the shared rule on the spot)", () => {
  const A1 = MISSION_BY_ID.get("A1")!;
  const pad = padDirs(BODIES.arcadia)[0]!;
  const clover = resolveAreaDir(BODIES.arcadia, NPC_AREAS.find((a) => a.id === "clover_fields")!.at);
  const me = on("arcadia", pad);

  it("points at the nearest live Hopbit inside Clover Fields (A1 counts only those)", () => {
    const inside = on("arcadia", toward(pad, clover, 0.6));
    const nearer = on("arcadia", toward(pad, clover, 0.5));
    const dead = on("arcadia", toward(pad, clover, 0.45));
    const t = missionTarget(A1, "arcadia", me, [npc("hopbit", inside), npc("hopbit", nearer), npc("hopbit", dead, 0), npc("woolback", me)], flat);
    expect(t).toEqual({ at: nearer, title: "Hopbit", creep: true });
  });

  it("falls back to the area when no counting creep is in view", () => {
    const outside = on("arcadia", toward(pad, clover, -1)); // the other way from Dawnpad: not in Clover Fields
    const t = missionTarget(A1, "arcadia", me, [npc("hopbit", outside)], flat);
    expect(t?.title).toBe("Clover Fields");
    expect(t?.creep).toBe(false);
    expect(Math.hypot(t!.at[0] - clover[0]! * 500, t!.at[1] - clover[1]! * 500, t!.at[2] - clover[2]! * 500)).toBeLessThan(0.01);
  });

  it("a hunt without an area points at a target in view, or nowhere; other bodies and missions: nowhere", () => {
    const H1 = MISSION_BY_ID.get("H1")!;
    const hp = padDirs(BODIES.hollowmere)[0]!;
    const near = on("hollowmere", toward(hp, padDirs(BODIES.hollowmere)[1]!, 0.05));
    expect(missionTarget(H1, "hollowmere", on("hollowmere", hp), [npc("cantor", near)], flat)?.title).toBe("Cantor");
    expect(missionTarget(H1, "hollowmere", on("hollowmere", hp), [npc("bonewalker", near)], flat)).toBeNull();
    expect(missionTarget(A1, "hollowmere", on("hollowmere", hp), [], flat)).toBeNull();
    expect(missionTarget(MISSION_BY_ID.get("A2")!, "arcadia", me, [], flat)).toBeNull();
  });
});

describe("the pointer follows the server's huntTargets and quotas", () => {
  const A1 = MISSION_BY_ID.get("A1")!;
  const M1 = MISSION_BY_ID.get("M1")!;
  const pad = padDirs(BODIES.arcadia)[0]!;
  const clover = resolveAreaDir(BODIES.arcadia, NPC_AREAS.find((a) => a.id === "clover_fields")!.at);
  const me = on("arcadia", pad);

  it("a Hopbit lured out of Clover Fields still counts (its spawn area does) and one wandering in from the wilds doesn't", () => {
    const lured = npc("hopbit", on("arcadia", toward(pad, clover, -1)), 20, "lured"); // outside the circle now
    const stray = npc("hopbit", on("arcadia", toward(pad, clover, 0.5)), 20, "stray"); // inside it, from the wilds
    const t = missionTarget(A1, "arcadia", me, [lured, stray], flat, { eligible: new Set(["lured"]) });
    expect(t).toMatchObject({ title: "Hopbit", creep: true, at: [lured.x, lured.y, lured.z] });
    // Nothing eligible in view: the area.
    expect(missionTarget(A1, "arcadia", me, [stray], flat, { eligible: new Set() })?.title).toBe("Clover Fields");
  });

  it("M1: after six Associates the Compliance Officer is the target, in either order", () => {
    const mp = padDirs(BODIES.meridian)[0]!;
    const cp = resolveAreaDir(BODIES.meridian, NPC_AREAS.find((a) => a.id === "checkpoint_seven")!.at);
    const mme = on("meridian", toward(mp, cp, 0.98));
    const assoc = npc("associate", on("meridian", toward(mp, cp, 0.99)));
    const officer = npc("compliance_officer", on("meridian", cp));
    // Associates done: the nearer Associate no longer wins.
    expect(missionTarget(M1, "meridian", mme, [assoc, officer], flat, { counts: [6, 0] })?.title).toBe("Compliance Officer");
    // The Officer done first: the Associate is the target.
    expect(missionTarget(M1, "meridian", mme, [assoc, officer], flat, { counts: [2, 1] })?.title).toBe("Associate");
    // Both done (the server would have completed it): just the area.
    expect(missionTarget(M1, "meridian", mme, [assoc, officer], flat, { counts: [6, 1] })?.creep).toBe(false);
  });
});
