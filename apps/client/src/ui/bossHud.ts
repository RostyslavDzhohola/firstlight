// Boss bar from the NPC lane's boss store (world/npcs/bossStore.ts, also window.__boss / `fl:boss`).
// Tidewrath and the Hollow King get the red hatched monster bar; The Receiver (Meridian Oversight)
// the slate + amber monospaced one. Voice-line subtitles are not shown here: audio/bossLines.ts
// shows them with the recorded line.

import { BOSS_DEFS } from "@firstlight/shared/content/npcs";
import type { BossHud } from "../world/npcs/bossStore.ts";
import type { BossBarState } from "./hud.ts";

/** Phase names (content.md §4.2–4.4) and the weak-window name the boss visibly shows. */
const PHASES: Record<string, { names: [string, string, string]; weak: string; oversight?: boolean }> = {
  tidewrath: { names: ["Rising", "Undertow", "Riptide"], weak: "Moored" },
  hollow_king: { names: ["Audience", "Procession", "Requiem"], weak: "Ribs open" },
  the_receiver: { names: ["Audit", "Restructuring", "Hostile Takeover"], weak: "Asset Freeze", oversight: true },
};

/** Map the store's state to the bar; null hides it. */
export function bossBarState(s: BossHud | null): BossBarState | null {
  if (!s) return null;
  const defeated = s.defeatedAt > 0;
  if (!s.visible && !defeated) return null;
  const def = BOSS_DEFS.find((b) => b.id === s.boss);
  const info = PHASES[s.boss];
  const phase = Math.max(1, Math.min(3, s.phase || 1));
  let phaseName = info?.names[phase - 1];
  if (s.weak && info) phaseName = `${phaseName} · ${info.weak}`;
  return {
    name: s.name,
    hp: defeated ? 0 : s.hp,
    max: s.maxHp,
    level: def?.level,
    phase: defeated ? undefined : phase,
    phaseName: defeated ? undefined : phaseName,
    variant: info?.oversight ? "oversight" : "monster",
    notches: def ? [...def.phases] : undefined,
    note: defeated ? "Defeated" : s.engaged > 0 ? `${s.engaged} in the arena` : "",
  };
}
