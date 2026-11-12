// Screen shake as trauma (content §0: 0.2 light / 0.4 heavy / 0.8 the biggest; roll ≤ 2°; a toggle in
// settings). Events add trauma, it drains at a steady rate, and the camera is turned by trauma²
// times smooth noise, so a small knock barely shows and a big one lands hard. Pure numbers (no
// three): the caller turns the camera by what `step` returns. The player controller places the
// camera afresh every frame, so a turn applied after it never builds up.

export const SHAKE = {
  light: 0.2,
  heavy: 0.4,
  max: 0.8,
  /** Trauma drained per second. */
  decayPerS: 1.5,
  /** The largest turn, at trauma 1 (degrees). */
  maxRollDeg: 2,
  maxTurnDeg: 1.1,
  /** How fast the noise moves (Hz). */
  hz: 17,
} as const;

export interface ShakeTurn {
  pitch: number;
  yaw: number;
  roll: number;
}

const DEG = Math.PI / 180;

/** Smooth noise in −1…1 from two sines that never line up. */
const noise = (t: number, a: number, b: number, phase: number) => Math.sin(t * a + phase) * 0.6 + Math.sin(t * b + phase * 2.7) * 0.4;

export class CameraShake {
  trauma = 0;
  private t = 0;
  private readonly out: ShakeTurn = { pitch: 0, yaw: 0, roll: 0 };

  /** Add trauma (0…1); it tops out at 1. */
  add(amount: number) {
    if (amount > 0) this.trauma = Math.min(1, this.trauma + amount);
  }

  /**
   * `dt` seconds on: the turn to give the camera this frame, in radians (the object is reused).
   * With the setting off the trauma still drains, and the turn is zero.
   */
  step(dt: number, enabled: boolean): ShakeTurn {
    this.t += dt;
    const k = enabled ? this.trauma * this.trauma : 0;
    const w = this.t * SHAKE.hz * Math.PI * 2;
    this.out.pitch = k === 0 ? 0 : k * SHAKE.maxTurnDeg * DEG * noise(w, 1, 1.63, 0.3);
    this.out.yaw = k === 0 ? 0 : k * SHAKE.maxTurnDeg * DEG * noise(w, 0.87, 1.41, 1.9);
    this.out.roll = k === 0 ? 0 : k * SHAKE.maxRollDeg * DEG * noise(w, 0.73, 1.29, 4.1);
    this.trauma = Math.max(0, this.trauma - SHAKE.decayPerS * dt);
    return this.out;
  }
}

/**
 * Trauma for a blast of `radius` m felt `distance` m away: the most there is inside the blast,
 * falling to nothing at `reach` m.
 */
export function blastTrauma(distance: number, radius: number, reach = 40): number {
  if (distance <= radius) return SHAKE.max;
  const k = Math.max(0, 1 - (distance - radius) / Math.max(1e-6, reach - radius));
  return SHAKE.max * k * k;
}
