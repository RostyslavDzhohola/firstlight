import { describe, expect, it } from "vitest";
import { partyFrames } from "./partyFrames.ts";

const member = (userId: string, name: string, over: Record<string, unknown> = {}) => ({ userId, name, level: 5, online: true, body: "arcadia", roomId: "r1", sessionId: null, x: 0, y: 0, z: 0, ...over });

describe("party frames", () => {
  it("skips us, keeps party slots, and reads live HP for members in our copy", () => {
    const members = [member("me", "Wren"), member("u2", "Mossback", { sessionId: "s2" }), member("u3", "Ashfall", { body: "meridian" })];
    const players = new Map([["s2", { userId: "u2", level: 7, starter: 2, hp: 75, maxHp: 100, x: 3, y: 4, z: 0 }]]);
    const frames = partyFrames(members, { userId: "me", x: 0, y: 0, z: 0 }, players, "arcadia", (sid) => (sid === "s2" ? { speaking: true, radio: false, muted: false } : null));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ slot: 2, name: "Mossback", level: 7, starter: 2, hp: 75, maxHp: 100, distance: 5, speaking: true });
    expect(frames[1]).toMatchObject({ slot: 3, name: "Ashfall", distance: null });
  });
  it("marks offline members", () => {
    const frames = partyFrames([member("me", "Wren"), member("u4", "Pip", { online: false })], { userId: "me", x: 0, y: 0, z: 0 }, null, "arcadia");
    expect(frames[0]).toMatchObject({ slot: 2, hp: 0, distance: null, title: "Offline" });
  });
});
