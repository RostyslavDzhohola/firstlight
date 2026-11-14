// What the right mouse does with the item in hand (#76), for the chip beside the hotbar. The same rule
// CombatClient follows when RMB goes down: block with blades and staffs, charge a heavy with the axe and
// hammer, draw a bow, aim a gun, hold a hand seal, patch yourself with a Patchkit. Pure (tested).

import type { TierStats, WeaponDef } from "@firstlight/shared/content/weapons";
import { heavyName } from "./specialCooldown.ts";

export function rmbAction(def: WeaponDef | undefined, tier: TierStats | undefined): string | null {
  if (!def || !tier) return null;
  if (def.id === "patchkit") return "Patch yourself";
  if (def.delivery === "melee") {
    if (tier.heavy !== undefined) return `Hold to charge: ${heavyName(def)}`;
    if (tier.block) return `Hold to block (${Math.round(tier.block * 100)}% off hits from the front)`;
    return null;
  }
  if (def.delivery === "arrow") return "Hold to draw";
  if (def.special) return "Hold a hand seal";
  if (def.id === "stillshot" || def.delivery === "hitscan" || def.delivery === "pellets") return "Aim";
  return null;
}
