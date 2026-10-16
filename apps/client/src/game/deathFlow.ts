// The client's side of dying and rising again (CombatClient), across rejoins. Saving from the death
// screen merges the guest into the account and the game rejoins as the account (close code 4101), so
// the room that showed the death isn't the one that must hear "respawn" (Codex review, should-fix 1):
//   - the new room re-sends `death` for a dead character: the screen stays up, and a pick made while
//     the old room was going away is sent again through this one;
//   - or its `you` says the character is alive (the account already had a living one): the screen
//     closes and the body unfreezes.
// Respawn always goes through whatever room we're in when it's sent. Pure (unit-tested; no DOM).

export interface RebirthChoice {
  starter: number;
  palette: number;
  /** STARTER_LOOKS index (older servers ignore it). */
  look?: number;
}

export interface DeathIO<M> {
  /** Show the death screen (and then the rebirth pick); null when it was closed without a pick. */
  showScreen(m: M): Promise<RebirthChoice | null>;
  /** Close the death screen without a pick: the character is alive after all. */
  closeScreen(): void;
  freeze(on: boolean): void;
  /** `respawn` through the room we're in now; false when there is none (a rejoin is under way). */
  sendRespawn(choice: RebirthChoice): boolean;
  /** Being dead blocks the pause flow; tell it when that changes. */
  changed(): void;
}

export class DeathFlow<M> {
  /** Dead until the server says otherwise (CombatClient.deadUntilRespawn). */
  dead = false;
  /** The rebirth pick, until the server answers `reborn` (re-sent after a rejoin). */
  private choice: RebirthChoice | null = null;
  private screenOpen = false;
  private readonly io: DeathIO<M>;

  constructor(io: DeathIO<M>) {
    this.io = io;
  }

  /** A `death` for us: a new one, or the one a rejoined room re-sends for a dead character. */
  async onDeath(m: M): Promise<void> {
    if (this.dead) {
      if (this.choice && !this.screenOpen) this.io.sendRespawn(this.choice);
      return;
    }
    this.dead = true;
    this.choice = null;
    this.io.freeze(true);
    this.screenOpen = true;
    const pick = await this.io.showScreen(m);
    this.screenOpen = false;
    if (!pick || !this.dead) return; // closed because the character is alive
    this.choice = pick;
    this.io.sendRespawn(pick);
  }

  /** Every `you`. Alive on this room ends a death the screen may still show. */
  onYou(dead: boolean): void {
    if (dead || !this.dead) return;
    this.dead = false;
    this.choice = null;
    if (this.screenOpen) {
      this.screenOpen = false;
      this.io.closeScreen();
    }
    this.io.freeze(false);
    this.io.changed();
  }

  /** `reborn`: the server took the pick (the game travels to Portus). */
  onReborn(): void {
    this.choice = null;
    this.io.freeze(false);
  }
}
