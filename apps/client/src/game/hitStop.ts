// Hit-stop (content.md §0, local only): a landed hit holds our own avatar's animation for a beat,
// so the blow reads as contact. Light 40 ms, heavy 80 ms, a kill 120 ms, a boss kill 400 ms. Only
// the pose is held: movement, the camera and the network carry on (the server never hears of it).
// Pure; Game.frame asks `frozen(now)` when it advances the avatar.

export type HitWeight = "light" | "heavy" | "kill" | "bossKill";

export const HIT_STOP_MS: Readonly<Record<HitWeight, number>> = { light: 40, heavy: 80, kill: 120, bossKill: 400 };

/** A hit we landed: weak points and a quarter of the target's health in one blow count as heavy. */
export function hitWeight(amount: number, weak: boolean, targetMaxHp = 0): HitWeight {
  return weak || (targetMaxHp > 0 && amount >= targetMaxHp * 0.25) ? "heavy" : "light";
}

export class HitStop {
  private until = 0;

  /** Start (or extend) a stop; a shorter one never cuts a longer one short. */
  hit(weight: HitWeight, now: number): void {
    this.until = Math.max(this.until, now + HIT_STOP_MS[weight]);
  }

  frozen(now: number): boolean {
    return now < this.until;
  }
}
