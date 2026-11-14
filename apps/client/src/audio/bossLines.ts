// Boss voice lines: the text is BOSS_DEFS[].voice (shared content/npcs.ts), which the server sends;
// the recordings are spoken lines like every other character's (speech.ts, tools/voice), with each
// boss's treatment baked in (tools/voice/cast.ts). Heard everywhere in the arena, not positional.

import { BOSS_DEFS } from "@firstlight/shared/content/npcs";
import { CHARACTER_BY_OBJECT, CHARACTERS, spokenId } from "@firstlight/shared/content/dialogue";
import type { GameAudio } from "./Audio.ts";
import { say } from "./speech.ts";

export type BossTrigger = "engage" | "phase2" | "defeat";

/** Which of a boss's three lines this text is (the server sends the text), or null. */
export function bossTrigger(bossId: string, line: string): BossTrigger | null {
  const v = BOSS_DEFS.find((b) => b.id === bossId)?.voice;
  return v ? ((Object.keys(v) as BossTrigger[]).find((t) => v[t] === line) ?? null) : null;
}

/** Play a boss line with its subtitle (the subtitle shows even when the audio can't play). */
export function playBossLine(audio: GameAudio, bossId: string, trigger: BossTrigger) {
  const who = CHARACTER_BY_OBJECT.get(bossId);
  const name = who ? CHARACTERS[who].name : bossId;
  say(audio, spokenId.boss(bossId, trigger), { name });
}
