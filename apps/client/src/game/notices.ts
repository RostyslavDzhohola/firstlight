// Player-facing text for the server's attack refusals (`denied {action: "fire" | "melee", reason}`),
// and a gate so a held attack button doesn't stack the same notice at the weapon's fire rate.

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

/** Lets the same notice through at most once per `ms`; a different one at once. */
export class NoticeGate {
  private last = "";
  private at = -Infinity;

  constructor(private readonly ms = 1500) {}

  allow(text: string, now: number): boolean {
    if (text === this.last && now - this.at < this.ms) return false;
    this.last = text;
    this.at = now;
    return true;
  }
}
