// One body transition at a time (travel, rejoin, resume: Game.travelling). A move the server orders
// while another is running must not be dropped: the rebirth's Portus travel can arrive while the
// account's rejoin (after saving from the death screen, 4101) is still arriving, and the server keeps
// the character dead until it reaches Portus (Codex review round 2). It waits for that transition.
// Portal steps and other moves the player can simply repeat are dropped as before. Pure (unit-tested).

export class TravelQueue<B extends string> {
  private next: B | null = null;

  /** "go": start now. "queued": a transition is running and this move must happen after it. */
  ask(to: B, busy: boolean, mustHappen: boolean): "go" | "queued" | "dropped" {
    if (!busy) return "go";
    if (!mustHappen) return "dropped";
    this.next = to; // the last order wins
    return "queued";
  }

  /** A transition ended: the queued move to make now, if any (none after the game stopped). */
  take(stopped: boolean): B | null {
    const to = this.next;
    this.next = null;
    return stopped ? null : to;
  }
}
