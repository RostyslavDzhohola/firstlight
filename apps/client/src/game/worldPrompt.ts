// The E prompt over an interactable world object (QuestClient). Pure, so it is tested without a scene.

import { GLEAMS, gleamsWon } from "@firstlight/shared/content/gleams";
import { SHOP_SPOT_BY_ID } from "@firstlight/shared/content/shops";
import type { WorldObjectDef } from "@firstlight/shared/content/world";

/**
 * The E prompt over a world object. The Gleam Vault counts the gleams until it can open
 * (D-polish-ux-5): "E — Gleam Vault · 1 of 3 gleams", then "E — Open the Gleam Vault".
 */
export function worldPrompt(o: Pick<WorldObjectDef, "id" | "look" | "name">, you: { missions?: readonly { id: string; done: boolean }[]; gleamVault?: unknown } | null): string {
  if (o.look === "keeper") return `E — Trade with ${SHOP_SPOT_BY_ID.get(o.id)?.keeper ?? o.name}`;
  if (o.look === "guide" || o.look === "curator") return `E — Talk to ${o.name}`;
  if (o.look === "vault" && !you?.gleamVault) {
    const won = gleamsWon(you?.missions ?? []);
    if (won < GLEAMS.trials.length) return `E — Gleam Vault · ${won} of ${GLEAMS.trials.length} gleams`;
  }
  return `E — ${o.name}`;
}
