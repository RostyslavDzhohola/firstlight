import { describe, expect, it } from "vitest";
import { BOSS_DEFS } from "@firstlight/shared/content/npcs";
import { BOSS_LINES } from "../../audio/bossLines.ts";

// The client picks the recorded clip by matching the server's line text, so the two tables must agree.
describe("boss voice lines", () => {
  it("every boss line the server sends has a recorded clip", () => {
    const ids: Record<string, keyof typeof BOSS_LINES> = { tidewrath: "tidewrath", hollow_king: "hollowking", the_receiver: "receiver" };
    for (const b of BOSS_DEFS) {
      const audio = ids[b.id];
      expect(audio, b.id).toBeDefined();
      expect(BOSS_LINES[audio!]).toEqual(b.voice);
    }
  });
});
