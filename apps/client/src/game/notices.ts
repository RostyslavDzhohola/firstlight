// Player-facing text for the server's attack refusals (`denied {action: "fire" | "melee", reason}`),
// and a gate so a held attack button shows each notice once, not at the weapon's fire rate.

const ATTACK_DENIED: Record<string, string> = {
  "safe zone": "Weapons are holstered in safe zones",
  protected: "Arrival protection: weapons ready in a moment",
  swimming: "Can't attack while swimming",
  mounted: "No weapons from the saddle: E to get off",
  overheated: "Overheated: cooling down",
  reloading: "Reloading…",
  empty: "Reloading…",
};

/** The notice for a refused attack, or null (not an attack, or a reason players needn't see, like the rate limit). */
export function attackDeniedText(action: string, reason: string): string | null {
  if (action !== "fire" && action !== "melee") return null;
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
