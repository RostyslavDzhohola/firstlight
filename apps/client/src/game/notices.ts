// Player-facing text for the server's attack refusals (`denied {action: "fire" | "melee", reason}`),
// and a gate so a held attack button shows each notice once, not at the weapon's fire rate. The
// client's own safe-zone holster check uses the same text and gate, so one press shows one notice.

import type { BodyId } from "@firstlight/shared";

const ATTACK_DENIED: Record<string, string> = {
  "safe zone": "Weapons are holstered in safe zones",
  protected: "Arrival protection: weapons ready in a moment",
  swimming: "Can't attack while swimming",
  mounted: "No weapons from the saddle: E to get off",
  overheated: "Overheated: cooling down",
  reloading: "Reloading…",
  empty: "Reloading…",
};

/** The safe-zone refusal with the way out of this zone (D-zones-1): the town's gates, or the pad's ring. */
export function holsteredText(body: BodyId | null | undefined): string {
  if (body === "portus") return "Weapons are holstered in town: head out of the gates to fight";
  if (body) return "Weapons are holstered on the pad: step out of the ring to fight";
  return ATTACK_DENIED["safe zone"]!;
}

const IMMUNE: Record<string, string> = {
  spawning: "It's still arriving: no damage for a moment",
  evading: "It's running home: no damage until it gets there",
  invulnerable: "It can't be hurt right now",
  shield: "Its shield took that: hit it from the side or back",
};

/** The notice for a hit that landed on an NPC and did nothing (server `immune`), or null. */
export function immuneText(reason: string): string | null {
  return IMMUNE[reason] ?? null;
}

/** The notice for a refused attack, or null (not an attack, or a reason players needn't see, like the rate limit). */
export function attackDeniedText(action: string, reason: string, body?: BodyId): string | null {
  if (action !== "fire" && action !== "melee") return null;
  if (reason === "safe zone") return holsteredText(body);
  return ATTACK_DENIED[reason] ?? null;
}

/**
 * Each notice once per press of an attack button: a held carbine is refused at its fire rate (and
 * through all 5 s of arrival protection), so a time throttle still stacked the same notice. A
 * reason shown during this hold stays quiet until the next press; a different one shows at once.
 */
export class NoticeGate {
  private readonly shown = new Set<string>();

  /** A fresh press of an attack button: every reason may show again. */
  press() {
    this.shown.clear();
  }

  allow(text: string): boolean {
    if (this.shown.has(text)) return false;
    this.shown.add(text);
    return true;
  }
}
