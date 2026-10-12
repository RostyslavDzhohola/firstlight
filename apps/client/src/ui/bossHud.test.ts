import { describe, expect, it } from "vitest";
import { bossBarState } from "./bossHud.ts";
import type { BossHud } from "../world/npcs/bossStore.ts";

const base: BossHud = { id: "n1", boss: "tidewrath", name: "Tidewrath", hp: 9520, maxHp: 16200, phase: 2, engaged: 3, weak: false, visible: true, voice: null, defeatedAt: 0 };

describe("boss bar from the NPC boss store", () => {
  it("hides when there is no boss or we are away from the lair", () => {
    expect(bossBarState(null)).toBeNull();
    expect(bossBarState({ ...base, visible: false })).toBeNull();
  });
  it("shows monsters red-hatched with phase names and thresholds", () => {
    expect(bossBarState(base)).toMatchObject({ name: "Tidewrath", variant: "monster", phase: 2, phaseName: "Undertow", level: 8, notches: [0.6, 0.25], note: "3 in the arena" });
    expect(bossBarState({ ...base, weak: true })!.phaseName).toBe("Undertow · Moored");
  });
  it("uses the Oversight look for The Receiver", () => {
    expect(bossBarState({ ...base, boss: "the_receiver", name: "The Receiver", phase: 3 })).toMatchObject({ variant: "oversight", phaseName: "Hostile Takeover", level: 20 });
  });
  it("keeps a defeated boss on screen at 0 HP", () => {
    expect(bossBarState({ ...base, visible: false, defeatedAt: Date.now() })).toMatchObject({ hp: 0, note: "Defeated", phase: undefined });
  });
});
