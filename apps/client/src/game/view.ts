// First- and third-person view (D-view-fp-1): which one the camera uses, and the first-person eye.
// Pure: PlayerController places the camera with it, Game feeds it the avatar's head each frame, and
// the tests check the maths without a scene.
//
// The player chooses a view (V, R3 held, the touch View button, scrolling all the way in or out, or
// Settings); it is stored with the other UI settings. The camera follows the choice except where a
// state reads better from behind (viewFor): dead (watch the body fall, the death card is over it).
// Everything else stays in first person: running, sprinting, jumping, rolling, blocking, riding and
// swimming, with the eye following the head's height and its lean forward but never its sway or roll.

export type ViewMode = "third" | "first";

/** What the camera does this frame for a chosen view and the player's state. */
export function viewFor(chosen: ViewMode, s: { dead: boolean }): ViewMode {
  if (chosen === "third") return "third";
  return s.dead ? "third" : "first";
}

/** The other view (the toggle). */
export function otherView(v: ViewMode): ViewMode {
  return v === "first" ? "third" : "first";
}

export const VIEW = {
  /** The third-person camera's zoom range (m behind the head), the scroll wheel's steps. */
  minDistance: 2.5,
  maxDistance: 9,
  wheelStep: 0.5,
  /** Seconds the camera takes to move between the views (eased, either way). */
  blendTime: 0.22,
  /** Without a skinned model (the capsule stand-in): the eye this far above the feet (m). */
  eyeHeight: 1.62,
  /** The eye sits this far (m) in front of the face socket, clear of the face (the head is cut away too). */
  eyeForward: 0.06,
  /** How fast the eye follows the head (1/s): up and down quickly (a roll, a landing), forward a little slower. */
  followUp: 14,
  followForward: 10,
  /** The head's sway sideways is let through only this far (m) and slowly: a walk's bob from side to side makes people sick. */
  maxSide: 0.06,
  followSide: 1.5,
  /** The eye never comes nearer the feet than this (m): a roll dips the view, it doesn't put it on the ground. */
  minEyeHeight: 0.75,
} as const;

/**
 * The scroll wheel (`wheel` > 0 out, < 0 in) on the camera: zoom the third-person camera; one more
 * notch in at the closest goes into first person, and a notch out of first person comes back out at
 * the closest. Returns the new view and distance.
 */
export function wheelView(view: ViewMode, distance: number, wheel: number): { view: ViewMode; distance: number } {
  if (!wheel) return { view, distance };
  if (view === "first") return wheel > 0 ? { view: "third", distance: VIEW.minDistance } : { view, distance };
  if (wheel < 0 && distance <= VIEW.minDistance + 1e-6) return { view: "first", distance: VIEW.minDistance };
  return { view, distance: Math.max(VIEW.minDistance, Math.min(VIEW.maxDistance, distance + wheel * VIEW.wheelStep)) };
}

/** Share of the way to a target an exponential ease covers in `dt` at `rate` (1/s). */
function ease(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * Math.max(0, dt));
}

/**
 * The first-person eye relative to the feet, in the body's frame: `up` (m above the feet), `forward`
 * (along the camera's heading) and `side` (to the right). `follow` eases it towards where the head is
 * (the avatar's face socket, measured the same way); `rest` puts it back at a standing eye with no
 * model to follow.
 */
export class EyeFollow {
  up: number = VIEW.eyeHeight;
  forward = 0;
  side = 0;
  private fresh = true;

  /** Next frame starts on the target, not eased towards it (a teleport, entering first person). */
  snap() {
    this.fresh = true;
  }

  follow(up: number, forward: number, side: number, dt: number) {
    const u = Math.max(VIEW.minEyeHeight, up);
    const s = Math.max(-VIEW.maxSide, Math.min(VIEW.maxSide, side));
    if (this.fresh) {
      this.up = u;
      this.forward = forward;
      this.side = s;
      this.fresh = false;
      return;
    }
    this.up += (u - this.up) * ease(VIEW.followUp, dt);
    this.forward += (forward - this.forward) * ease(VIEW.followForward, dt);
    this.side += (s - this.side) * ease(VIEW.followSide, dt);
  }

  rest(lift: number, dt: number) {
    this.follow(VIEW.eyeHeight + lift, 0, 0, dt);
  }
}

/** Ease `blend` (0 third … 1 first) towards `target` over VIEW.blendTime, smoothstepped by the caller. */
export function stepBlend(blend: number, target: number, dt: number): number {
  const step = Math.max(0, dt) / VIEW.blendTime;
  return target > blend ? Math.min(target, blend + step) : Math.max(target, blend - step);
}

/** Smoothstep of a 0..1 blend (the camera's path between the views starts and ends gently). */
export function smoothBlend(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}
