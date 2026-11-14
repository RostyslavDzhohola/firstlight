// The Three Gleams (2026-11-12, D-hunt-1): the public hunt across the three planets. Sela Marchbank,
// a lamp-keeper in Portus Plaza, tends the Gleam Vault; its lock takes three gleams of first light,
// one won on each planet by a trial of a different skill (missions T1–T3, missions.ts): a ring race on
// Arcadia, holding a beacon on Hollowmere, gathering shards on Meridian. All three open the vault:
// a once-per-life cosmetic and coins, the account medal "The Three Gleams" (title Gleamkeeper) and,
// for the first account ever, a line on the Hall of Firsts. Progress belongs to the life (D-hunt-2).

import type { InvItem } from "../net/protocol.ts";
import type { MissionId } from "./missions.ts";

export const GLEAMS = {
  name: "The Three Gleams",
  curator: { id: "curator_sela", name: "Sela Marchbank", role: "the lamp-keeper of Portus Plaza" },
  vault: "gleam_vault",
  /** The trials, in their planets' order (any order works). */
  trials: ["T1", "T2", "T3"] as readonly MissionId[],
  /** What the vault pays, once per life. */
  reward: { coins: 600, items: [{ id: "gleamweave_cape", tier: 1, qty: 1 }] as readonly InvItem[] },
  medal: "three_gleams",
  /** Hall of Firsts id (secrets.ts PLAQUES). */
  firsts: "hunt:gleams",
  greeting: "Three gleams, one on each world. Bring them here and the vault opens. That's the whole of it, and it's plenty.",
  /** Sela's lines (the panel shows the one matching your progress). */
  lines: {
    none: "Arcadia, Hollowmere, Meridian. Each kept a gleam, and each makes you earn it differently. Win all three and this vault opens for you.",
    some: "Hear that hum? The vault knows what you're carrying. It's counting. So am I. Bring the rest.",
    all: "All three. Go on, the vault is listening.",
    opened: "The vault knows your face now. Win them again in another life and it will open again.",
  },
} as const;

/** How many trials of the Three Gleams this life has won (done missions T1–T3). */
export function gleamsWon(missions: readonly { id: string; done: boolean }[]): number {
  return GLEAMS.trials.filter((t) => missions.some((m) => m.id === t && m.done)).length;
}
