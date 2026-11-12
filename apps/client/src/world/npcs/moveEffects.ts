// The movement effects the server has put on the local player (`npcFx`: chill, slow, no sprint),
// as the client predicts them. The server enforces them in its movement budget (server
// npc/effects.ts); what is predicted here has to be what is enforced there, or the body rubber-bands.
// Pure (no three, no DOM).

import type { StatusEffect } from "@firstlight/shared/content/npcs";

export interface MoveEffect {
  kind: StatusEffect["kind"];
  /** When it ends (the clock the caller uses, ms). */
  until: number;
  amount: number;
}

/**
 * Take an `npcFx` message into the running effects. With `set` on a slow or chill, the message is
 * the whole slow the server holds now (its amount and time left), so every slow and chill already
 * here goes first: the server kept one of them or replaced them, and says which (review 4).
 */
export function takeMoveEffect(effects: MoveEffect[], m: { kind: StatusEffect["kind"]; ms: number; amount: number; set?: boolean }, now: number): void {
  if (m.set && (m.kind === "slow" || m.kind === "chill")) {
    for (let i = effects.length - 1; i >= 0; i--) {
      const k = effects[i]!.kind;
      if (k === "slow" || k === "chill") effects.splice(i, 1);
    }
  }
  effects.push({ kind: m.kind, until: now + m.ms, amount: m.amount });
}

const out = { slow: 0, noSprint: false };

/** The slow (0…1) and no-sprint in force at `now`; effects that have ended are dropped. The result is reused. */
export function moveEffectsAt(effects: MoveEffect[], now: number): { slow: number; noSprint: boolean } {
  let slow = 0;
  let noSprint = false;
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i]!;
    if (now > e.until) {
      effects.splice(i, 1);
      continue;
    }
    if (e.kind === "chill" || e.kind === "slow") slow = Math.max(slow, e.amount);
    if (e.kind === "nosprint") noSprint = true;
  }
  out.slow = slow;
  out.noSprint = noSprint;
  return out;
}
