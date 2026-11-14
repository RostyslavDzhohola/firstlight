import { describe, expect, it } from "vitest";
import { CHARACTERS, DIALOGUE, dialogueFor, hasSlots, missionSpeaker, SPOKEN_LINES, textKey, type CharacterId } from "./dialogue.ts";
import { BOSS_DEFS } from "./npcs.ts";
import { MISSIONS } from "./missions.ts";
import { WORLD_OBJECT_BY_ID } from "./world.ts";
import { LINE_TOPICS, linesFor, RESIDENT_LINES, ROLE_VOICE, VOICES } from "./residentLines.ts";

describe("dialogue", () => {
  it("every character stands at a world object (or is a boss) and the people you talk to greet and see you off", () => {
    const bosses = new Set(BOSS_DEFS.map((b) => b.id));
    for (const [id, c] of Object.entries(CHARACTERS) as [CharacterId, (typeof CHARACTERS)[CharacterId]][]) {
      if (bosses.has(c.object)) continue;
      expect(WORLD_OBJECT_BY_ID.get(c.object)?.name, id).toContain(c.name);
      expect(dialogueFor(id, "farewell").length, id).toBeGreaterThan(0);
      expect(dialogueFor(id, "idle").length, id).toBeGreaterThan(0);
      // Sela's greeting is her progress line (gleams.ts), the guides' first is GUIDES[].greeting.
      if (id !== "sela") expect(dialogueFor(id, "greet").length, id).toBeGreaterThan(0);
    }
  });

  it("ids are unique, lines are short and slot-free", () => {
    const ids = SPOKEN_LINES.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(DIALOGUE.map((l) => l.id)).size).toBe(DIALOGUE.length);
    for (const l of SPOKEN_LINES) {
      expect(hasSlots(l.text), l.id).toBe(false);
      expect(l.text.length, l.id).toBeLessThanOrEqual(140);
      expect(l.id, l.id).toMatch(/^[a-z0-9_]+(\.[A-Za-z0-9_]+)+$/);
    }
  });

  it("every mission's offer has a speaker, and every boss line is spoken", () => {
    for (const m of MISSIONS) expect(missionSpeaker(m.id), m.id).not.toBeNull();
    for (const b of BOSS_DEFS) for (const t of ["engage", "phase2", "defeat"]) expect(SPOKEN_LINES.some((l) => l.id === `boss.${b.id}.${t}`)).toBe(true);
  });

  it("every resident voice has its own line on every topic, and a tip for every level band", () => {
    for (const v of VOICES) {
      for (const t of LINE_TOPICS) expect(RESIDENT_LINES.some((l) => l.voice === v && l.topic === t), `${v}.${t}`).toBe(true);
      for (const lv of [1, 5, 10, 20]) expect(linesFor(v, "tip", lv).every((l) => !l.levels || (lv >= l.levels[0] && lv <= l.levels[1])), `${v} at ${lv}`).toBe(true);
      // Greetings can be spoken: no slots in them.
      expect(linesFor(v, "greet").every((l) => !hasSlots(l.text)), v).toBe(true);
    }
    // Roles still fall back to the first four voices.
    expect(Object.values(ROLE_VOICE).every((v) => VOICES.slice(0, 4).includes(v))).toBe(true);
  });

  it("the text key is stable and changes with the words", () => {
    expect(textKey("Mind the lake.")).toBe(textKey("Mind the lake."));
    expect(textKey("Mind the lake.")).not.toBe(textKey("Mind the lake!"));
  });
});
