// Local player movement on a sphere: run/sprint/jump/dodge/swim/fall damage, client-predicted.
// The server validates (SPEC §5.3); `correct` messages snap us back. Intact breakable props block
// (the player slides along them) and can be stood on (MoveColliders, set by the destruction view),
// and so do the body's structures: the Portus town's, a planet outpost's and its waystones (setStructures:
// the shared solids the server checks, D38, D42), and the natural solids: tree trunks, boulders, spires
// and big rocks (setNature, D-solid-1).
// Runs every frame: module scratch vectors, no allocations.

import * as THREE from "three/webgpu";
import type { Terrain } from "@firstlight/shared";
import { emptyContact, resetContact, type PropContact } from "@firstlight/shared/planet/collide";
import { ANIM } from "@firstlight/shared/net/schema";
import { deepWater, SWIM_FLOAT } from "@firstlight/shared/planet/water";
import type { Input } from "./input.ts";
import { easeShare, stepsFor } from "./frameClock.ts";
import { mountedSpeed, rideCamera } from "./mount.ts";
import { ADMIN_MODE } from "@firstlight/shared/content/admin";
import { BASE_MOVE, starterMove } from "@firstlight/shared/content/starters";
import { EyeFollow, smoothBlend, stepBlend, VIEW, viewFor, wheelView, type ViewMode } from "./view.ts";

/** Solid things the player can't walk through (intact breakable props). */
export interface MoveColliders {
  /** Push `pos` (feet, planet space) out of solid props; fills `out` (push direction, floor under the feet). */
  resolve(pos: THREE.Vector3, out: PropContact): boolean;
  /** Distance along a ray (unit `d`) to the first solid prop within `maxT`, or Infinity (tracers). */
  raycast?(o: THREE.Vector3, d: THREE.Vector3, maxT: number): number;
  /**
   * The camera's ray, if it sees other solids than `raycast`: fewer (natural ones: only boulders and
   * spires) or more (structures: the shop stalls' awnings too, D-view-5); else `raycast`.
   */
  cameraRay?(o: THREE.Vector3, d: THREE.Vector3, maxT: number): number;
  /**
   * Feet `pos` held in a pocket of these solids that walking can't leave: move them to the nearest
   * clear spot close by (game/stepOut.ts). True if they moved (#34).
   */
  stepOut?(pos: THREE.Vector3): boolean;
}

export const MOVE = {
  /** Run/sprint/dodge cooldown: the local starter's (setStarterMove), with NPC effects applied on top. */
  run: BASE_MOVE.run,
  sprint: BASE_MOVE.sprint,
  swim: 3,
  gravity: 18,
  jumpSpeed: 6.6,
  dodgeDistance: 4.5,
  dodgeTime: 0.3,
  dodgeCooldown: BASE_MOVE.dodgeCooldown,
  /** A press this early still rolls (the cooldown ending, landing): content §0's input buffer. */
  dodgeBuffer: 0.1,
  /** Stepping off an edge (or a low frame rate losing the ground on a slope) still rolls this long after. */
  dodgeGroundGrace: 0.12,
  accel: 12,
  mountAccel: 5, // a horse has weight: slower to speed up, stop and turn
  airAccel: 3,
  fallSafe: 8,
  fallLethal: 20.5,
  /** NPC movement effects (set by world/npcs/NpcRenderer; on foot it rewrites run/sprint instead):
   *  riding reads them through mountedSpeed. */
  slow: 0,
  noSprint: false,
};

/**
 * The local starter's own pace and roll before NPC effects (content/starters.ts, issue #9): the server
 * validates movement from the same row (movement.ts moveLimits), so prediction never fights it.
 * NpcRenderer scales these for chill, slow and Cease-and-Desist.
 */
export const MOVE_BASE = { run: MOVE.run, sprint: MOVE.sprint, dodgeDistance: MOVE.dodgeDistance, dodgeCooldown: MOVE.dodgeCooldown };
let appliedStarter = -1;

/** Use this starter's run, sprint and dodge cooldown (the server's `starter` for the local player). */
export function setStarterMove(starter: number) {
  if (starter === appliedStarter) return;
  appliedStarter = starter;
  const m = starterMove(starter);
  MOVE_BASE.run = MOVE.run = m.run;
  MOVE_BASE.sprint = MOVE.sprint = m.sprint;
  MOVE_BASE.dodgeCooldown = MOVE.dodgeCooldown = m.dodgeCooldown;
}

/** Collision substep limits (m): sideways under half a fence's blocking depth, vertically under a top's landing band. */
const SUBSTEP_H = 0.25;
const SUBSTEP_V = 0.25;
const MAX_SUBSTEPS = 16;

const NO_PRESSES: ReadonlySet<string> = new Set();

const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _vH = new THREE.Vector3();
const _newUp = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _look = new THREE.Vector3();
const _head = new THREE.Vector3();
const _cam = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _start = new THREE.Vector3();
const _lens = new THREE.Vector3();
const _lensF = new THREE.Vector3();
const _lensR = new THREE.Vector3();
const _lensU = new THREE.Vector3();
const _corner = new THREE.Vector3();
const _target = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _lensMoved = new THREE.Vector3();
const _lensPush = new THREE.Vector3();
const _lensSide = new THREE.Vector3();
const _probeTarget = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _eyeTarget = new THREE.Vector3();
const _eyeBase = new THREE.Vector3();
const _eyeDir = new THREE.Vector3();
/** First person: the eye may back off a solid in front of it this far (m) behind the head's centre (the head is cut away). */
export const EYE_BACKOFF = 0.3;
/**
 * Third person pressed in closer than this (m) to the head (a wall or a crate behind the player): the
 * camera moves to the eyes instead, the head cut away, until its line is clear past CLOSE_OUT (#34).
 */
export const CLOSE_IN = 0.6;
export const CLOSE_OUT = 0.9;
/**
 * The camera stops this far (m) short of a structure between the head and where it would be; with
 * the player pressed against a wall (the wall under CAMERA_WALL_GAP × 2 behind the head) it keeps half
 * the way to the wall instead, so the lens never ends up inside the wall (browser check, round 2).
 */
export const CAMERA_WALL_GAP = 0.3;
/** How fast (m/s) the camera eases back out once the structure is out of the way (0.25 m a frame at 60 fps). */
export const CAMERA_EASE_OUT_MPS = 15;
/**
 * The lens is a near plane, not a point (#34): its corners stay this far (m) clear of a solid too,
 * the camera coming in by CAMERA_LENS_STEP at a time until no corner is in or behind one.
 */
export const CAMERA_LENS_PAD = 0.05;
const CAMERA_LENS_STEP = 0.1;
/** The camera sits this far (m) to the side of the head, over the right shoulder (or the left, #34). */
const CAMERA_SHOULDER = 0.55;
/** Its line over the shoulder cut shorter than this (m) and the other's this much longer: swap. */
const CAMERA_SWAP_REACH = 1;
const CAMERA_SWAP_GAIN = 0.5;
/** How fast it moves over (shoulder units per second, 2 = right to left): ~0.42 s at any frame rate (review B2). */
export const CAMERA_SHOULDER_PER_S = 4.8;
/**
 * Walking but held in place this long (s): ask the solids for a step-out, which they give only in a
 * pocket walking can't leave (#34; the issue's bar is 2 s stuck).
 */
export const PIN_STEP_OUT_S = 0.5;
/**
 * Feet this close (m) above a prop top after the frame's move land on it: a top is flat, so its
 * radius grows off its centre (1e-5 m at 0.1 m), and a hair of drift after the mid-frame landing
 * left a fall hovering over it for a frame (review B2: the eased drift changed by a hair).
 */
const TOP_LAND_SLACK = 1e-3;
/** Pinned: covering less than this share of the wanted speed over a frame. */
const PIN_PROGRESS = 0.2;
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);
/** Server corrections closer than this (metres) keep the camera heading (F12 confirm Sonnet N-6). */
export const CORRECT_KEEP_HEADING_M = 25;
/**
 * Outside first person the drawn body follows the (already eased) facing this fast (1/s): it is
 * there within a few frames, and leaving first person mid-turn doesn't snap it.
 */
const BODY_CATCH_UP = 40;

export class PlayerController {
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  /**
   * Unit tangent the character faces for gameplay: sent to the server, which swings melee along it.
   * In first person on foot it is the camera's heading at once (the swing goes to the crosshair).
   */
  readonly facing = new THREE.Vector3(0, 0, 1);
  /** The facing the own avatar is drawn with: `facing`, eased where first person snaps it (review finding 1). */
  readonly bodyFacing = new THREE.Vector3(0, 0, 1);
  /** Unit tangent the camera looks along (yaw only). */
  readonly camForward = new THREE.Vector3(0, 0, 1);
  camPitch = -0.15;
  camDistance = 4.6;
  /** The view the player chose (game/view.ts); `dead` pulls the camera out to third person meanwhile. */
  view: ViewMode = "third";
  dead = false;
  /** 0 third person … 1 first person: where the camera is on its way between the two. */
  viewBlend = 0;
  /** 0 … 1: third person squeezed against the head, framed from the eyes instead (CLOSE_IN, #34). */
  closeBlend = 0;
  private closeGoal = 0;
  /** The scroll wheel changed the view (Game stores the choice). */
  onViewChange: ((v: ViewMode) => void) | null = null;
  /** The first-person eye (feet-relative, eased) and the head it follows (Game sets it from the avatar each frame). */
  readonly eye = new EyeFollow();
  private readonly headPoint = new THREE.Vector3();
  private hasHead = false;
  /** How far behind the head the camera may sit now (a structure in the way pulls it in). */
  private camReach = Infinity;
  /** Where the lens was put on its line last time (the near-plane check can bring it in further). */
  private lensReach = Infinity;
  /** Which shoulder the camera looks over (1 right, -1 left) and where it is on the way there. */
  private shoulderGoal = 1;
  private shoulder = 1;
  /** How far (m) the camera may ease back out in this placement (CAMERA_EASE_OUT_MPS × its dt). */
  private camEaseOut = CAMERA_EASE_OUT_MPS / 60;
  /** The full length of the line cameraLine last placed a lens on. */
  private lineFull = 0;
  onGround = false;
  swimming = false;
  anim: number = ANIM.IDLE;
  private dodgeT = 0;
  /** Wall-clock time (ms, the `now` update gets) when the next roll may start (D-combat-3). */
  private dodgeReadyAt = -Infinity;
  /** The clock when no `now` is given (tests, tools): the sum of the simulation steps. */
  private simMs = 0;
  /** Seconds a C press stays wanted (MOVE.dodgeBuffer), so a press a moment early isn't lost. */
  private dodgeWanted = 0;
  /** Seconds since the feet last touched ground, and whether a jump took them off it. */
  private airTime = Infinity;
  private jumped = false;
  /** A roll just ended and its extra speed is still bleeding off. */
  private rollTail = false;
  private readonly dodgeDir = new THREE.Vector3();
  private fallStartRadius = 0;
  /** Fall damage as a fraction of max HP, reported to the game for the server to apply. */
  pendingFallDamage = 0;
  frozen = false;
  /** Riding a horse (HorseClient sets it from the server's flag): horse speed, heavier turns, no dodge. */
  mounted = false;
  /** 0 → 1 riding camera blend (HorseClient). */
  rideBlend = 0;
  /** Riding or just off the horse (HorseClient): weapons stay lowered (CombatClient), as on the server. */
  saddleLocked = false;
  /**
   * Admin mode (AdminModeClient sets them from the server's `you.adminMode`; the server checks the
   * moves): flying (Space up, C down, no gravity, no fall damage, no dodge) and the speed multiplier.
   */
  adminFly = false;
  adminSpeed = 1;
  private colliders: MoveColliders | null = null;
  private structures: MoveColliders | null = null;
  private readonly contact = emptyContact();
  private readonly structureContact = emptyContact();
  private readonly natureContact = emptyContact();
  private nature: MoveColliders | null = null;
  /** Seconds walked without getting anywhere (PIN_STEP_OUT_S). */
  private pinnedT = 0;

  constructor(private terrain: Terrain, private waterLevel: number) {}

  setTerrain(terrain: Terrain, waterLevel: number) {
    this.terrain = terrain;
    this.waterLevel = waterLevel;
  }

  /** Solid props for this body (null: nothing blocks but the ground). */
  setColliders(c: MoveColliders | null) {
    this.colliders = c;
  }

  getColliders(): MoveColliders | null {
    return this.colliders;
  }

  /** Indestructible structures of this body (the Portus town, a planet's outpost and waystones; null if none). */
  setStructures(c: MoveColliders | null) {
    this.structures = c;
  }

  getStructures(): MoveColliders | null {
    return this.structures;
  }

  /**
   * Natural solids of this body (tree trunks, boulders, spires, big rocks: shared natureSolids,
   * D-solid-1): the player slides round them like the server expects; `raycast` (boulders and
   * spires only) keeps the camera out of the big ones.
   */
  setNature(c: MoveColliders | null) {
    this.nature = c;
  }

  getNature(): MoveColliders | null {
    return this.nature;
  }

  /**
   * The server put us somewhere (a refused move, a fall it resolved, an admin or quest teleport).
   * Within CORRECT_KEEP_HEADING_M the camera keeps its heading and the body its facing (carried onto
   * the new ground plane); further than that it is a teleport and the camera resets.
   */
  correct(x: number, y: number, z: number) {
    const far = !(Math.hypot(x - this.pos.x, y - this.pos.y, z - this.pos.z) <= CORRECT_KEEP_HEADING_M);
    if (far) return this.teleport(x, y, z);
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    const up = _up.copy(this.pos).normalize();
    for (const v of [this.camForward, this.facing, this.bodyFacing]) {
      v.addScaledVector(up, -v.dot(up));
      if (v.lengthSq() < 1e-8) {
        const ref = Math.abs(up.z) < 0.9 ? AXIS_Z : AXIS_X;
        v.copy(ref).addScaledVector(up, -ref.dot(up));
      }
      v.normalize();
    }
    this.fallStartRadius = this.pos.length();
  }

  /**
   * After a blink the server placed (Skipstep: its `correct` came first and stopped the body): move on
   * with `vel`, the velocity from before it, along the new ground, and keep a jump that was still
   * rising (#78: the hop was cut off 26 ms in and the body dropped where it landed). A fall's speed
   * is not kept (the blink put the feet on the ground there).
   */
  resumeAfterBlink(vel: THREE.Vector3) {
    const up = _up.copy(this.pos).normalize();
    const along = vel.dot(up);
    const rise = Math.max(0, along);
    this.vel.copy(vel).addScaledVector(up, rise - along);
    if (rise > 0) this.onGround = false;
  }

  /** Place the player (arrival, travel, respawn): the camera faces the body's reference direction. */
  teleport(x: number, y: number, z: number) {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    const up = _up.copy(this.pos).normalize();
    const ref = Math.abs(up.z) < 0.9 ? AXIS_Z : AXIS_X;
    this.camForward.copy(ref).addScaledVector(up, -ref.dot(up)).normalize();
    this.facing.copy(this.camForward);
    this.bodyFacing.copy(this.facing);
    this.fallStartRadius = this.pos.length();
    // A new place: the camera starts out at full reach over the right shoulder, nothing pinned.
    this.camReach = Infinity;
    this.lensReach = Infinity;
    this.shoulder = this.shoulderGoal = 1;
    this.pinnedT = 0;
    this.eye.snap();
    this.closeBlend = this.closeGoal = 0;
  }

  /** How far the camera is towards the eye framing (first person, or third squeezed against the head). */
  get eyeBlend(): number {
    return Math.max(this.viewBlend, this.closeBlend);
  }

  /** The view the camera is heading to now (the choice, unless a state pulls it out: game/view.ts viewFor). */
  get viewNow(): ViewMode {
    return viewFor(this.view, { dead: this.dead });
  }

  /** In first person (or on the way there past half-way): the body faces where the camera looks. */
  get firstPerson(): boolean {
    return this.viewNow === "first" && this.viewBlend > 0.5;
  }

  /**
   * The avatar's eye point this frame (planet space: its face socket), or null without a skinned model
   * (the eye then stands at VIEW.eyeHeight). Set before placeCamera.
   */
  setHead(p: THREE.Vector3 | null) {
    this.hasHead = !!p;
    if (p) this.headPoint.copy(p);
  }

  /** A shove (m/s) along `dir` (projected onto the ground plane), with a little lift. */
  knockback(dir: THREE.Vector3, strength: number) {
    if (this.frozen || strength <= 0) return;
    const up = _up.copy(this.pos).normalize();
    const h = _dir.copy(dir).addScaledVector(up, -dir.dot(up));
    if (h.lengthSq() < 1e-6) return;
    this.vel.addScaledVector(h.normalize(), strength).addScaledVector(up, strength * 0.4);
    this.onGround = false;
  }

  up(out = new THREE.Vector3()) {
    return out.copy(this.pos).normalize();
  }

  /**
   * One frame. `dt` is the frame's game time (Game's frameClock: up to 250 ms, 200 ms riding, #33); a frame longer
   * than 50 ms runs as equal steps of at most 50 ms, with the frame's mouse look and key presses
   * applied on the first step only. `now` is the wall clock (ms) of the frame, which the dodge
   * cooldown is a deadline on, like the server's 1.2 s: a stall of any length counts in full
   * (D-combat-3), and every step of a frame reads the same `now`, so a press is judged when it's
   * read and a roll's deadline matches the server's. Without `now` the clock is the sum of the steps.
   */
  update(dt: number, input: Input, aiming: boolean, now = this.simMs + dt * 1000) {
    const steps = stepsFor(dt);
    if (steps === 1) return this.step(dt, input, aiming, now);
    const h = dt / steps;
    // Later steps see only the keys held down: no mouse movement, wheel or fresh presses.
    const held = Object.create(input) as Input;
    Object.assign(held, { mouseDX: 0, mouseDY: 0, lookYaw: 0, lookPitch: 0, wheel: 0, pressed: NO_PRESSES });
    for (let k = 0; k < steps; k++) this.step(h, k === 0 ? input : held, aiming, now);
  }

  /** One movement step of at most 50 ms. */
  private step(dt: number, input: Input, aiming: boolean, now: number) {
    this.simMs = now;
    const R = this.terrain.body.radius;
    _start.copy(this.pos);
    const up = _up.copy(this.pos).normalize();
    // Parallel-transport camera and facing to the new tangent plane.
    this.camForward.addScaledVector(up, -this.camForward.dot(up)).normalize();
    this.facing.addScaledVector(up, -this.facing.dot(up)).normalize();

    // Look: the mouse (pointer locked) plus a stick or a touch drag (radians, already scaled), D-controls-5.
    if (input.captured && !this.frozen) {
      const yaw = -input.mouseDX * input.sensitivity - (input.lookYaw || 0);
      this.camForward.applyAxisAngle(up, yaw).normalize();
      this.camPitch += (input.invertY ? 1 : -1) * input.mouseDY * input.sensitivity + (input.lookPitch || 0);
      this.camPitch = Math.max(-1.25, Math.min(0.9, this.camPitch));
      if (input.wheel) {
        // All the way in goes into first person, and out of it again (game/view.ts wheelView).
        const w = wheelView(this.view, this.camDistance, input.wheel);
        this.camDistance = w.distance;
        if (w.view !== this.view) {
          this.view = w.view;
          this.onViewChange?.(w.view);
        }
      }
    }
    const right = _right.crossVectors(this.camForward, up).normalize();

    // Desired move direction from WASD relative to the camera.
    let mx = 0, mz = 0;
    // A stick's push (0..1) scales the pace: a light push walks (D-controls-5). Keys are always full.
    let push = 1;
    if (!this.frozen) {
      if (input.down("KeyW")) mz += 1;
      if (input.down("KeyS")) mz -= 1;
      if (input.down("KeyD")) mx += 1;
      if (input.down("KeyA")) mx -= 1;
      if (mx === 0 && mz === 0 && (input.moveX || input.moveY)) {
        mx = input.moveX;
        mz = input.moveY;
        push = Math.min(1, Math.hypot(mx, mz));
      }
    }
    const wish = _wish.set(0, 0, 0).addScaledVector(this.camForward, mz).addScaledVector(right, mx);
    if (wish.lengthSq() > 0) wish.normalize();
    const walking = wish.lengthSq() > 0;
    const sprint = input.down("ShiftLeft") || input.down("ShiftRight");
    const forward = mz > 0 && mz >= Math.abs(mx) * 0.5; // a stick a little off straight ahead still sprints
    const speed = push * (this.swimming ? MOVE.swim : this.mounted ? mountedSpeed(sprint, MOVE.slow, MOVE.noSprint) : sprint && forward && !aiming ? MOVE.sprint : MOVE.run) * this.adminSpeed;

    // Dodge-roll: starts this frame (no wind-up, no server round trip; the server checks the move).
    // A press up to MOVE.dodgeBuffer early is kept; one earlier in the cooldown is dropped, never
    // stored for a roll a second later. The body turns to the roll at once, so a back or side roll
    // reads as a roll (the clip tumbles forward).
    if (input.pressed.has("KeyC") && !this.adminFly) this.dodgeWanted = MOVE.dodgeBuffer; // flying: C goes down
    const footing = this.onGround || (!this.jumped && this.airTime <= MOVE.dodgeGroundGrace);
    if (this.dodgeWanted > 0 && !this.frozen && !this.mounted && now >= this.dodgeReadyAt && footing && !this.swimming) {
      this.dodgeWanted = 0;
      this.dodgeT = MOVE.dodgeTime;
      this.dodgeReadyAt = now + MOVE.dodgeCooldown * 1000;
      this.dodgeDir.copy(wish.lengthSq() > 0 ? wish : this.facing);
      this.facing.copy(this.dodgeDir);
    }
    this.dodgeWanted = Math.max(0, this.dodgeWanted - dt);

    // Split velocity into vertical (radial) and horizontal (tangent) parts.
    const vUp = this.vel.dot(up);
    const vH = _vH.copy(this.vel).addScaledVector(up, -vUp);
    if (this.dodgeT > 0) {
      this.dodgeT -= dt;
      vH.copy(this.dodgeDir).multiplyScalar(MOVE.dodgeDistance / MOVE.dodgeTime);
      if (this.dodgeT <= 0) this.rollTail = true;
    } else {
      const target = wish.multiplyScalar(speed);
      const a = this.onGround || this.swimming || this.adminFly ? (this.mounted ? MOVE.mountAccel : MOVE.accel) : MOVE.airAccel;
      vH.lerp(target, easeShare(a, dt));
      // A roll's extra speed bleeds off at the ground rate even in the air (off an edge, or rolled
      // over one): the server's dodge reserve assumes that slowdown, and air control alone kept a
      // 15 m/s tail long enough to be refused (Codex review).
      if (this.rollTail) {
        const len = vH.length();
        if (len > speed) vH.multiplyScalar((speed + (len - speed) * (1 - easeShare(MOVE.accel, dt))) / len);
        else this.rollTail = false;
      }
    }

    let vUpNew = vUp;
    if (this.adminFly && !this.frozen) {
      // Flying: no gravity; Space climbs, C descends.
      const climb = ADMIN_MODE.climbSpeed * this.adminSpeed;
      vUpNew = (input.down("Space") ? climb : 0) - (input.down("KeyC") ? climb : 0);
      if (vUpNew > 0) this.onGround = false;
    } else if (this.swimming) {
      vUpNew = 0;
    } else {
      vUpNew -= MOVE.gravity * dt;
      if (this.onGround && !this.frozen && input.pressed.has("Space")) {
        vUpNew = MOVE.jumpSpeed;
        this.onGround = false;
        this.jumped = true;
        this.fallStartRadius = this.pos.length();
      }
    }
    this.vel.copy(vH).addScaledVector(up, vUpNew);
    if (this.adminFly) {
      // The server's flying allowance counts every metre of a step, up and down included.
      const max = ADMIN_MODE.flySpeed * this.adminSpeed;
      const v = this.vel.length();
      if (v > max) this.vel.multiplyScalar(max / v);
    }

    // Props: shoved out sideways (and the motion into them dropped, so we slide along), or a floor.
    // The move is split into substeps short enough that a dodge, a gallop or a low frame rate can't
    // carry the body across a thin prop (a fence blocks 0.47 m either side of its middle), and a
    // fast fall can't skip a top's 0.4 m landing band.
    let floorR = 0;
    if (!this.colliders && !this.structures && !this.nature) this.pos.addScaledVector(this.vel, dt);
    else {
      const c = this.contact;
      const sc = this.structureContact;
      const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(Math.max((vH.length() * dt) / SUBSTEP_H, (Math.abs(vUpNew) * dt) / SUBSTEP_V))));
      const h = dt / steps;
      for (let k = 0; k < steps; k++) {
        this.pos.addScaledVector(this.vel, h);
        // Feet never below the ground mid-frame: uphill a step along the old tangent plane ends under
        // it, where a solid on the slope (its base is the ground at its centre) is checked against
        // feet lower than they will stand, and the snap below then lifted them into it (Codex review).
        if (!this.swimming) this.liftToGround(R);
        if (this.colliders) this.colliders.resolve(this.pos, c);
        else resetContact(c);
        if (c.pushed) this.slide(c, vH);
        if (this.structures) {
          this.structures.resolve(this.pos, sc);
          if (sc.pushed) this.slide(sc, vH);
          if (sc.floor > c.floor) c.floor = sc.floor;
        }
        if (this.nature) {
          const nc = this.natureContact;
          this.nature.resolve(this.pos, nc);
          if (nc.pushed) this.slide(nc, vH);
          if (nc.floor > c.floor) c.floor = nc.floor;
        }
        // A prop top only catches a player who isn't rising (a jump past an edge keeps going up).
        const su = _newUp.copy(this.pos).normalize();
        floorR = c.floor > 0 && this.vel.dot(su) <= 0.5 ? c.floor : 0;
        if (floorR > 0 && this.pos.length() < floorR) {
          // Landed mid-frame: stand on the top for the rest of it.
          this.pos.copy(su).multiplyScalar(floorR);
          const vu = this.vel.dot(su);
          if (vu < 0) this.vel.addScaledVector(su, -vu);
        }
      }
    }

    // Ground (terrain or a prop top) and water.
    const newUp = _newUp.copy(this.pos).normalize();
    const ground = this.terrain.groundHeight(newUp.x, newUp.y, newUp.z);
    const r = this.pos.length();
    const waterR = R + this.waterLevel;
    const groundR = Math.max(R + ground, floorR);
    const deep = deepWater(ground, this.waterLevel) && floorR === 0; // the server's rule too
    const wasOnGround = this.onGround;
    if (deep && r <= waterR - 1.0) {
      this.swimming = true;
      this.onGround = false;
      this.pos.copy(newUp).multiplyScalar(waterR - SWIM_FLOAT);
      this.fallStartRadius = this.pos.length();
    } else if (r <= groundR + (floorR > 0 ? TOP_LAND_SLACK : 0)) {
      this.pos.copy(newUp).multiplyScalar(groundR);
      if (!wasOnGround) {
        const drop = this.fallStartRadius - groundR;
        if (drop > MOVE.fallSafe && !this.swimming && !this.adminFly) this.pendingFallDamage += Math.min(1, ((drop - MOVE.fallSafe) * 0.08));
      }
      this.onGround = true;
      this.swimming = false;
      const vu = this.vel.dot(newUp);
      if (vu < 0) this.vel.addScaledVector(newUp, -vu);
      this.fallStartRadius = this.pos.length();
    } else {
      if (this.swimming && !deep) this.swimming = false;
      if (this.onGround && r > groundR + 0.35) {
        this.onGround = false;
        this.fallStartRadius = r;
      } else if (this.onGround) {
        this.pos.copy(newUp).multiplyScalar(groundR); // stick to slopes when walking downhill
      }
      if (!this.onGround) this.fallStartRadius = Math.max(this.fallStartRadius, r);
    }

    // Where the snap put the feet: clear of the solids (the server refuses feet inside one).
    if (this.structures || this.nature) this.clearAfterSnap(R, vH);
    this.stepOutIfPinned(dt, walking ? speed : 0);

    if (this.onGround || this.swimming) {
      this.airTime = 0;
      this.jumped = false;
    } else this.airTime += dt;
    // Flying: a fall only counts from where flying stops (like the server).
    if (this.adminFly) this.fallStartRadius = this.pos.length();

    // Face movement (or the camera when aiming; a roll keeps facing where it goes).
    const hSpeed = vH.length();
    // First person on foot faces the camera at once, so the swing and the cast go where the crosshair
    // is on the frame of a turn; the drawn body turns after it (bodyFacing).
    const fpFacing = this.firstPerson && !this.mounted && this.dodgeT <= 0;
    if (fpFacing) this.facing.copy(this.camForward);
    else if (aiming && this.dodgeT <= 0) this.facing.lerp(this.camForward, easeShare(18, dt)).normalize();
    else if (hSpeed > 0.5) this.facing.lerp(_dir.copy(vH).normalize(), easeShare(this.mounted ? 6 : 10, dt)).normalize();
    this.easeBody(fpFacing ? 18 : BODY_CATCH_UP, dt);

    this.anim = this.dodgeT > 0 ? ANIM.DODGE
      : this.swimming ? ANIM.SWIM
      : !this.onGround && !this.adminFly ? (this.vel.dot(newUp) > 0 ? ANIM.JUMP : ANIM.FALL)
      : hSpeed > 7 ? ANIM.SPRINT
      : hSpeed > 3.5 ? ANIM.RUN
      : hSpeed > 0.3 ? ANIM.WALK
      : ANIM.IDLE;
  }

  /** Ease the drawn facing towards the gameplay one at `rate` (1/s), kept on this frame's ground plane. */
  private easeBody(rate: number, dt: number) {
    const up = _up.copy(this.pos).normalize();
    const b = this.bodyFacing;
    b.addScaledVector(up, -b.dot(up));
    if (b.lengthSq() < 1e-8 || b.dot(this.facing) < -0.999) b.copy(this.facing);
    else b.normalize().lerp(this.facing, easeShare(rate, dt)).normalize();
  }

  /** Lift feet that are under the terrain up onto it (radially). */
  private liftToGround(R: number) {
    const l = this.pos.length();
    const g = R + this.terrain.groundHeight(this.pos.x / l, this.pos.y / l, this.pos.z / l);
    if (l < g) this.pos.multiplyScalar(g / l);
  }

  /**
   * After the frame's ground snap: push the feet out of any structure or natural solid they ended
   * in (sliding along it), and if that moved them, onto the ground there.
   */
  private clearAfterSnap(R: number, vH: THREE.Vector3) {
    let moved = false;
    for (let pass = 0; pass < 2; pass++) {
      let pushed = false;
      if (this.structures) {
        const sc = this.structureContact;
        this.structures.resolve(this.pos, sc);
        if (sc.pushed) {
          this.slide(sc, vH);
          pushed = true;
        }
      }
      if (this.nature) {
        const nc = this.natureContact;
        this.nature.resolve(this.pos, nc);
        if (nc.pushed) {
          this.slide(nc, vH);
          pushed = true;
        }
      }
      if (!pushed) break;
      moved = true;
      if (this.onGround && !this.swimming) {
        const l = this.pos.length();
        const g = R + this.terrain.groundHeight(this.pos.x / l, this.pos.y / l, this.pos.z / l);
        if (g > l || l - g < 0.35) this.pos.multiplyScalar(g / l);
      }
    }
    if (moved && this.onGround) this.fallStartRadius = this.pos.length();
  }

  /**
   * Walking at `speed` (0: not walking) but held where the feet are for PIN_STEP_OUT_S: step out of
   * the pocket (MoveColliders.stepOut), standing still on the ground there. Pressed against a plain
   * wall the feet can walk out (along it, away from it) and nothing moves; the check then waits
   * another PIN_STEP_OUT_S.
   */
  private stepOutIfPinned(dt: number, speed: number) {
    const held = speed > 0 && !this.frozen && !this.adminFly && !this.swimming && this.dodgeT <= 0 && this.pos.distanceTo(_start) < speed * dt * PIN_PROGRESS;
    this.pinnedT = held ? this.pinnedT + dt : 0;
    if (this.pinnedT < PIN_STEP_OUT_S) return;
    this.pinnedT = 0;
    if (!(this.structures?.stepOut?.(this.pos) || this.nature?.stepOut?.(this.pos))) return;
    const up = _up.copy(this.pos).normalize();
    this.vel.set(0, 0, 0);
    this.onGround = true;
    this.fallStartRadius = this.pos.length();
    this.facing.addScaledVector(up, -this.facing.dot(up)).normalize();
  }

  /** Over-the-shoulder camera. */
  /** Drop the motion into a push (`c` from a resolve), so the body slides along what pushed it. */
  private slide(c: PropContact, vH: THREE.Vector3) {
    const n = _dir.set(c.nx, c.ny, c.nz);
    const into = this.vel.dot(n);
    if (into < 0) this.vel.addScaledVector(n, -into);
    const intoH = vH.dot(n);
    if (intoH < 0) vH.addScaledVector(n, -intoH);
    const intoDodge = this.dodgeDir.dot(n);
    if (this.dodgeT > 0 && intoDodge < 0) this.dodgeDir.addScaledVector(n, -intoDodge);
  }

  /** Lift `p` (planet space) to at least 0.4 m above the ground under it. */
  private aboveGround(p: THREE.Vector3) {
    const cu = _camUp.copy(p).normalize();
    const g = this.terrain.groundHeight(cu.x, cu.y, cu.z) + this.terrain.body.radius + 0.4;
    if (p.length() < g) p.copy(cu).multiplyScalar(g);
  }

  /** `dt`: the game time since the last placement (s); the eases move by it, not by a step per placement (review B2). */
  placeCamera(camera: THREE.PerspectiveCamera, dt = 1 / 60) {
    const t = Math.max(0, dt);
    const wantFirst = this.viewNow === "first";
    const was = this.eyeBlend;
    const wasView = this.viewBlend;
    this.viewBlend = stepBlend(this.viewBlend, wantFirst ? 1 : 0, t);
    // Leaving first person: the third-person camera grows back out from the head (eased, never through a wall).
    if (wasView === 1 && this.viewBlend < 1) this.camReach = this.lensReach = 0;
    const up = _up.copy(this.pos).normalize();
    const right = _right.crossVectors(this.camForward, up).normalize();
    const look = _look.copy(this.camForward).applyAxisAngle(right, this.camPitch);
    if (this.viewBlend >= 1) {
      // All the way in: the eye only, no third-person line to check.
      this.closeBlend = this.closeGoal = 0;
      if (was === 0) this.eye.snap();
      this.placeEye(camera, up, right, look, t);
      camera.position.copy(_eye);
      camera.up.copy(up);
      camera.lookAt(_eyeTarget);
      return;
    }
    this.placeThird(camera, up, right, look, t);
    // Squeezed against the head: frame from the eyes until the line behind is clear again (#34).
    const near = _cam.distanceTo(_head);
    if (wantFirst) this.closeGoal = 0;
    else if (near < CLOSE_IN) this.closeGoal = 1;
    else if (near > CLOSE_OUT) this.closeGoal = 0;
    if (this.closeGoal || this.closeBlend > 0 || this.viewBlend > 0) {
      if (was === 0) this.eye.snap();
      // The eyes only if they have a clear view themselves; else the third-person lens stays (it is clear).
      if (!this.placeEye(camera, up, right, look, t) && !wantFirst) this.closeGoal = 0;
    }
    this.closeBlend = stepBlend(this.closeBlend, this.closeGoal, t);
    const k = smoothBlend(this.eyeBlend);
    if (k > 0) {
      _cam.lerp(_eye, k);
      _target.lerp(_eyeTarget, k);
    }
    camera.position.copy(_cam);
    camera.up.copy(up);
    camera.lookAt(_target);
  }

  /**
   * The first-person eye into `_eye` and its look target into `_eyeTarget`: the head's height and lean
   * (eased, no sway or roll: game/view.ts EyeFollow), a little in front of the face. A solid right in
   * front (pressed against a wall) backs the eye off along the heading until the near plane is clear.
   */
  private placeEye(camera: THREE.PerspectiveCamera, up: THREE.Vector3, right: THREE.Vector3, look: THREE.Vector3, t: number): boolean {
    if (this.hasHead) {
      const d = _eyeDir.copy(this.headPoint).sub(this.pos);
      this.eye.follow(d.dot(up), d.dot(this.camForward), d.dot(right), t);
    } else this.eye.rest(rideCamera(this.rideBlend).lift, t);
    const base = _eyeBase.copy(this.pos).addScaledVector(up, this.eye.up).addScaledVector(right, this.eye.side);
    const ahead = this.eye.forward + VIEW.eyeForward;
    // From in front of the face back along the heading, down to EYE_BACKOFF behind the head's centre:
    // the first spot nothing stands between the head and, with the whole near plane clear.
    for (let along = ahead; along >= -EYE_BACKOFF - 1e-6; along -= CAMERA_LENS_STEP) {
      _eye.copy(base).addScaledVector(this.camForward, along);
      _eyeTarget.copy(_eye).addScaledVector(look, 6);
      if (this.eyeReachable(base, _eye) && !this.lensBlocked(camera, _eye, _eyeTarget, up)) return true;
    }
    // Nowhere clear (a face in a wall under a low beam): at the head's centre, the best there is.
    _eye.copy(base);
    _eyeTarget.copy(_eye).addScaledVector(look, 6);
    return false;
  }

  /** Nothing solid between the head's centre `base` and the eye at `p` (with the lens pad). */
  private eyeReachable(base: THREE.Vector3, p: THREE.Vector3): boolean {
    const d = _eyeDir.copy(p).sub(base);
    const l = d.length();
    if (l < 1e-6) return true;
    return this.cameraHit(base, d.divideScalar(l), l + CAMERA_LENS_PAD) > l + CAMERA_LENS_PAD;
  }

  /** The over-the-shoulder camera into `_cam`, its look target into `_target`. */
  private placeThird(camera: THREE.PerspectiveCamera, up: THREE.Vector3, right: THREE.Vector3, look: THREE.Vector3, t: number) {
    this.camEaseOut = CAMERA_EASE_OUT_MPS * t;
    const ride = rideCamera(this.rideBlend); // in the saddle: eyes higher, camera further back
    const head = _head.copy(this.pos).addScaledVector(up, 1.65 + ride.lift);
    const back = this.camDistance + ride.back;
    const toGo = this.shoulderGoal - this.shoulder;
    const over = CAMERA_SHOULDER_PER_S * t;
    this.shoulder = Math.abs(toGo) <= over ? this.shoulderGoal : this.shoulder + Math.sign(toGo) * over;
    const target = _target.copy(head).addScaledVector(look, 6).addScaledVector(right, CAMERA_SHOULDER * this.shoulder);
    const reach = this.cameraLine(camera, head, look, right, up, back, this.shoulder, true, _cam, target);
    // Over the other shoulder when this one's line is cut short (a wall at the player's side) and
    // the other's reaches clearly further (#34); back over the right one once its line is clear.
    // Only once it has got where it was going, and on the lines' own lengths, not the eased reach
    // (just over, that is still the old side's short one): otherwise it flaps between the two.
    const settled = this.shoulder === this.shoulderGoal;
    if (settled && reach < CAMERA_SWAP_REACH) {
      const own = this.cameraLine(camera, head, look, right, up, back, this.shoulderGoal, false, _probe, _probeTarget);
      const other = own < CAMERA_SWAP_REACH ? this.cameraLine(camera, head, look, right, up, back, -this.shoulderGoal, false, _probe, _probeTarget) : 0;
      if (other > own + CAMERA_SWAP_GAIN) this.shoulderGoal = -this.shoulderGoal;
    } else if (settled && this.shoulderGoal < 0 && this.cameraLine(camera, head, look, right, up, back, 1, false, _probe, _probeTarget) >= this.lineFull) this.shoulderGoal = 1;
  }

  /**
   * The camera on the line over shoulder `side` (1 right, -1 left, between while swapping): written
   * to `out` (its look target to `target`, unless `eased`, where the caller set it), and how far from
   * the head it ends up; `lineFull` gets the line's full length. Above the ground first, so the
   * checks see the lens where it will be: lifted after them, a low look (aiming up) put the lens into
   * a counter or a planter beside the line (#22). Not through a structure (a house, a tower, a
   * stall's awning) or a natural solid: in to just short of it along the line from the head. `eased`
   * (the real camera, not a probe): it eases back out once the way is clear (no popping in and out).
   */
  private cameraLine(camera: THREE.PerspectiveCamera, head: THREE.Vector3, look: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3, back: number, side: number, eased: boolean, out: THREE.Vector3, target: THREE.Vector3): number {
    if (!eased) target.copy(head).addScaledVector(look, 6).addScaledVector(right, CAMERA_SHOULDER * side);
    out.copy(head).addScaledVector(look, -back).addScaledVector(right, CAMERA_SHOULDER * side).addScaledVector(up, 0.25);
    this.aboveGround(out);
    const dir = _camDir.copy(out).sub(head);
    const full = dir.length();
    this.lineFull = full;
    dir.divideScalar(full);
    const hit = this.cameraHit(head, dir, full + CAMERA_WALL_GAP);
    const want = hit < Infinity ? hit - Math.min(CAMERA_WALL_GAP, hit / 2) : full;
    let reach = want;
    if (eased) {
      this.camReach = want < this.camReach ? want : Math.min(want, this.camReach + this.camEaseOut);
      reach = this.camReach;
    }
    reach = Math.min(reach, full);
    // The whole near plane clear, not just its centre: a ray grazing a wall or a crate stopped the
    // lens beside it with half the view inside (#34). In a step at a time until no corner is in one
    // (an eighth of the way at most, so a long line costs no more than a short one), then the edge
    // bisected. Every candidate is checked where it would stand, lifted over the ground like the
    // lens. The search starts from the eased reach of the line, not the last lens position: a lens
    // pulled in to the head by a wall there would otherwise never get out again.
    const step = Math.max(CAMERA_LENS_STEP, reach / 8);
    if (this.lensBlocked(camera, this.lensAt(head, dir, reach), target, up)) {
      let blocked = reach;
      reach = Math.max(0, reach - step);
      while (reach > 0 && this.lensBlocked(camera, this.lensAt(head, dir, reach), target, up)) {
        blocked = reach;
        reach = Math.max(0, reach - step);
      }
      for (let k = 0; k < 5 && reach > 0; k++) {
        const mid = (reach + blocked) / 2;
        if (this.lensBlocked(camera, this.lensAt(head, dir, mid), target, up)) blocked = mid;
        else reach = mid;
      }
    }
    if (eased) {
      // Out again at the easing pace too, while the way out is clear (through a blocked stretch, at once).
      const next = this.lensReach + this.camEaseOut;
      if (next < reach && !this.lensBlocked(camera, this.lensAt(head, dir, next), target, up)) reach = next;
      this.lensReach = reach;
    }
    out.copy(this.lensAt(head, dir, Math.min(reach, full)));
    // Right in at the head and still in a wall beside it (the body is 0.38 m round, the near plane
    // twice that wide): off the wall, into the player's own (faded) space, if that clears it.
    if (reach <= 0 && this.lensBlocked(camera, out, target, up)) this.lensOffWall(camera, head, out, target, up);
    return reach;
  }

  /**
   * Move `lens` (looking at `target`) across its view, away from the near-plane corners that are in a
   * solid, by how far each is in, a few passes; kept only if that clears the whole near plane and
   * nothing stands between the head and where it got to (it would see past a stall's edge).
   */
  private lensOffWall(camera: THREE.PerspectiveCamera, head: THREE.Vector3, lens: THREE.Vector3, target: THREE.Vector3, up: THREE.Vector3) {
    const moved = _lensMoved.copy(lens);
    for (let pass = 0; pass < 3; pass++) {
      const push = _lensPush.set(0, 0, 0);
      const f = _lensF.copy(target).sub(moved).normalize();
      for (let i = 0; i < 4; i++) {
        const l = this.lensCorner(camera, f, up, i);
        const t = this.cameraHit(moved, _corner, l);
        if (t > l) continue;
        // Back off the corner's sideways part (across the view), by how far it is in.
        const side = _lensSide.copy(_corner).addScaledVector(f, -_corner.dot(f));
        const sl = side.length();
        if (sl > 1e-6) push.addScaledVector(side, -(l - t) / sl);
      }
      if (push.lengthSq() === 0) break;
      moved.add(push);
      this.aboveGround(moved);
    }
    if (this.lensBlocked(camera, moved, target, up)) return;
    const d = _lensSide.copy(moved).sub(head);
    const l = d.length();
    if (l > 1e-6 && this.cameraHit(head, d.divideScalar(l), l + CAMERA_LENS_PAD) <= l + CAMERA_LENS_PAD) return;
    lens.copy(moved);
  }

  /** The lens `reach` m along unit `dir` from the head, lifted over the ground (`_lens`, scratch). */
  private lensAt(head: THREE.Vector3, dir: THREE.Vector3, reach: number): THREE.Vector3 {
    _lens.copy(head).addScaledVector(dir, reach);
    this.aboveGround(_lens); // pulled in along the line from the head: a bump of ground on the way can still need it
    return _lens;
  }

  /** Distance along the ray (unit `d`) to the first solid the camera stops at, within `maxT`, or Infinity. */
  private cameraHit(o: THREE.Vector3, d: THREE.Vector3, maxT: number): number {
    const s = this.structures;
    return Math.min(
      (s?.cameraRay ?? s?.raycast)?.(o, d, maxT) ?? Infinity,
      this.nature?.cameraRay?.(o, d, maxT) ?? Infinity,
      this.colliders?.raycast?.(o, d, maxT) ?? Infinity, // intact breakables: crates, walls of a camp
    );
  }

  /**
   * Is a corner of `camera`'s near plane (padded by CAMERA_LENS_PAD) inside a solid, or behind one
   * seen from the lens, with the lens at `lens` looking at `target`? Scratch vectors only.
   */
  private lensBlocked(camera: THREE.PerspectiveCamera, lens: THREE.Vector3, target: THREE.Vector3, up: THREE.Vector3): boolean {
    const f = _lensF.copy(target).sub(lens).normalize();
    for (let i = 0; i < 4; i++) {
      const l = this.lensCorner(camera, f, up, i);
      if (this.cameraHit(lens, _corner, l) <= l) return true;
    }
    return false;
  }

  /**
   * Padded near-plane corner `i` (0..3) of `camera` looking along unit `f`: its unit direction from
   * the lens into `_corner`; returns its distance.
   */
  private lensCorner(camera: THREE.PerspectiveCamera, f: THREE.Vector3, up: THREE.Vector3, i: number): number {
    const r = _lensR.crossVectors(f, up).normalize();
    const u = _lensU.crossVectors(r, f);
    const half = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.near;
    const hh = half + CAMERA_LENS_PAD;
    const hw = half * camera.aspect + CAMERA_LENS_PAD;
    const c = _corner.copy(f).multiplyScalar(camera.near).addScaledVector(r, i & 1 ? hw : -hw).addScaledVector(u, i & 2 ? hh : -hh);
    const l = c.length();
    c.divideScalar(l);
    return l;
  }
}
