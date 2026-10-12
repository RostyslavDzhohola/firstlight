// When the level-up "Save your character" card opens, and when a card may take keyboard focus (T9).
// Pure (unit-tested; no DOM). The onboarding tutorial pays level 2 within its first minute, so the
// offer waits while the tutorial is up (its tips and the "Tutorial complete" card) and opens once
// after it ends or is skipped. A card the game opens by itself never grabs the keyboard mid-play.

export class SaveOffer {
  private pending = false;
  private offered = false;

  /** Every `you` update: a rise to level 2 or more asks for the card (once per session). */
  levelUp(level: number, prevLevel: number): void {
    if (level > prevLevel && level >= 2 && !this.offered) this.pending = true;
  }

  /** Once per frame in the world; `held` while the tutorial is up. True on the one frame the card opens. */
  poll(held: boolean): boolean {
    if (!this.pending || this.offered || held) return false;
    this.pending = false;
    this.offered = true;
    return true;
  }
}

/**
 * Whether a card may put keyboard focus in its field on its own. Never while the game holds the
 * pointer (WASD would type into it); otherwise only when the player opened it (Esc menu, sign-in)
 * or has clicked or typed into it since it opened.
 */
export function mayAutofocus(s: { pointerLocked: boolean; requested: boolean; interacted: boolean }): boolean {
  return !s.pointerLocked && (s.requested || s.interacted);
}
