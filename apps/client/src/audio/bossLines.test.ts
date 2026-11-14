import { describe, expect, it } from "vitest";
import { BOSS_DEFS } from "@firstlight/shared/content/npcs";
import { spokenId } from "@firstlight/shared/content/dialogue";
import { bossTrigger } from "./bossLines.ts";
import { hasVoice } from "./speech.ts";

describe("boss lines", () => {
  it("every line the server sends maps to its trigger and has a recording made from that text", () => {
    for (const b of BOSS_DEFS) {
      for (const t of ["engage", "phase2", "defeat"] as const) {
        expect(bossTrigger(b.id, b.voice[t]), `${b.id} ${t}`).toBe(t);
        expect(hasVoice(spokenId.boss(b.id, t)), `${b.id} ${t}`).toBe(true);
      }
    }
    expect(bossTrigger("tidewrath", "Something else entirely.")).toBeNull();
  });
});
