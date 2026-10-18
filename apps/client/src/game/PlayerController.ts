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
import { mountedSpeed, rideCamera } from "./mount.ts";
import { ADMIN_MODE } from "@firstlight/shared/content/admin";

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
}

export const MOVE = {
  run: 6,
  sprint: 9,
  swim: 3,
  gravity: 18,
  jumpSpeed: 6.6,
  dodgeDistance: 4.5,
  dodgeTime: 0.3,
  dodgeCooldown: 1.2,
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

/** Collision substep limits (m): sideways under half a fence's blocking depth, vertically under a top's landing band. */
const SUBSTEP_H = 0.25;
const SUBSTEP_V = 0.25;
const MAX_SUBSTEPS = 16;

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
/**
 * The camera stops this far (m) short of a structure between the head and where it would be; with
 * the player pressed against a wall (the wall under CAMERA_WALL_GAP × 2 behind the head) it keeps half
 * the way to the wall instead, so the lens never ends up inside the wall (browser check, round 2).
 */
export const CAMERA_WALL_GAP = 0.3;
/** How fast (m per placement) the camera eases back out once the structure is out of the way. */
const CAMERA_EASE_OUT = 0.25;
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);
/** Server corrections closer than this (metres) keep the camera heading (F12 confirm Sonnet N-6). */
export const CORRECT_KEEP_HEADING_M = 25;

export class PlayerController {
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  /** Unit tangent the character faces. */
  readonly facing = new THREE.Vector3(0, 0, 1);
  /** Unit tangent the camera looks along (yaw only). */
  readonly camForward = new THREE.Vector3(0, 0, 1);
  camPitch = -0.15;
  camDistance = 4.6;
  /** How far behind the head the camera may sit now (a structure in the way pulls it in). */
  private camReach = Infinity;
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
    for (const v of [this.camForward, this.facing]) {
      v.addScaledVector(up, -v.dot(up));
      if (v.lengthSq() < 1e-8) {
        const ref = Math.abs(up.z) < 0.9 ? AXIS_Z : AXIS_X;
        v.copy(ref).addScaledVector(up, -ref.dot(up));
      }
      v.normalize();
    }
    this.fallStartRadius = this.pos.length();
  }

  /** Place the player (arrival, travel, respawn): the camera faces the body's reference direction. */
  teleport(x: number, y: number, z: number) {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    const up = _up.copy(this.pos).normalize();
    const ref = Math.abs(up.z) < 0.9 ? AXIS_Z : AXIS_X;
    this.camForward.copy(ref).addScaledVector(up, -ref.dot(up)).normalize();
    this.facing.copy(this.camForward);
    this.fallStartRadius = this.pos.length();
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
   * One frame. `dt` is the simulation step (Game clamps it to 50 ms, so a slow frame runs in slow
   * motion); `now` is the wall clock (ms), which the dodge cooldown is a deadline on, like the
   * server's 1.2 s: a stall of any length counts in full (D-combat-3). Without `now` the clock is
   * the sum of the steps.
   */
  update(dt: number, input: Input, aiming: boolean, now = this.simMs + dt * 1000) {
    this.simMs = now;
    const R = this.terrain.body.radius;
    const up = _up.copy(this.pos).normalize();
    // Parallel-transport camera and facing to the new tangent plane.
    this.camForward.addScaledVector(up, -this.camForward.dot(up)).normalize();
    this.facing.addScaledVector(up, -this.facing.dot(up)).normalize();

    if (input.locked && !this.frozen) {
      const yaw = -input.mouseDX * input.sensitivity;
      this.camForward.applyAxisAngle(up, yaw).normalize();
      this.camPitch += (input.invertY ? 1 : -1) * input.mouseDY * input.sensitivity;
      this.camPitch = Math.max(-1.25, Math.min(0.9, this.camPitch));
      if (input.wheel) this.camDistance = Math.max(2.5, Math.min(9, this.camDistance + input.wheel * 0.5));
    }
    const right = _right.crossVectors(this.camForward, up).normalize();

    // Desired move direction from WASD relative to the camera.
    let mx = 0, mz = 0;
    if (!this.frozen) {
      if (input.down("KeyW")) mz += 1;
      if (input.down("KeyS")) mz -= 1;
      if (input.down("KeyD")) mx += 1;
      if (input.down("KeyA")) mx -= 1;
    }
    const wish = _wish.set(0, 0, 0).addScaledVector(this.camForward, mz).addScaledVector(right, mx);
    if (wish.lengthSq() > 0) wish.normalize();
    const sprint = input.down("ShiftLeft") || input.down("ShiftRight");
    const speed = (this.swimming ? MOVE.swim : this.mounted ? mountedSpeed(sprint, MOVE.slow, MOVE.noSprint) : sprint && mz > 0 && !aiming ? MOVE.sprint : MOVE.run) * this.adminSpeed;

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
      vH.lerp(target, Math.min(1, a * dt));
      // A roll's extra speed bleeds off at the ground rate even in the air (off an edge, or rolled
      // over one): the server's dodge reserve assumes that slowdown, and air control alone kept a
      // 15 m/s tail long enough to be refused (Codex review).
      if (this.rollTail) {
        const len = vH.length();
        if (len > speed) vH.multiplyScalar((speed + (len - speed) * Math.max(0, 1 - MOVE.accel * dt)) / len);
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
    } else if (r <= groundR) {
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

    if (this.onGround || this.swimming) {
      this.airTime = 0;
      this.jumped = false;
    } else this.airTime += dt;
    // Flying: a fall only counts from where flying stops (like the server).
    if (this.adminFly) this.fallStartRadius = this.pos.length();

    // Face movement (or the camera when aiming; a roll keeps facing where it goes).
    const hSpeed = vH.length();
    if (aiming && this.dodgeT <= 0) this.facing.lerp(this.camForward, Math.min(1, 18 * dt)).normalize();
    else if (hSpeed > 0.5) this.facing.lerp(_dir.copy(vH).normalize(), Math.min(1, (this.mounted ? 6 : 10) * dt)).normalize();

    this.anim = this.dodgeT > 0 ? ANIM.DODGE
      : this.swimming ? ANIM.SWIM
      : !this.onGround && !this.adminFly ? (this.vel.dot(newUp) > 0 ? ANIM.JUMP : ANIM.FALL)
      : hSpeed > 7 ? ANIM.SPRINT
      : hSpeed > 3.5 ? ANIM.RUN
      : hSpeed > 0.3 ? ANIM.WALK
      : ANIM.IDLE;
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

  placeCamera(camera: THREE.PerspectiveCamera) {
    const up = _up.copy(this.pos).normalize();
    const right = _right.crossVectors(this.camForward, up).normalize();
    const look = _look.copy(this.camForward).applyAxisAngle(right, this.camPitch);
    const ride = rideCamera(this.rideBlend); // in the saddle: eyes higher, camera further back
    const head = _head.copy(this.pos).addScaledVector(up, 1.65 + ride.lift);
    const camPos = _cam.copy(head).addScaledVector(look, -(this.camDistance + ride.back)).addScaledVector(right, 0.55).addScaledVector(up, 0.25);
    // Above the ground first, so the structure check below sees the lens where it will be: lifted
    // after it, a low look (aiming up) put the lens into a counter or a planter beside the line (#22).
    this.aboveGround(camPos);
    // Not through a structure (a house, a tower, a stall's awning): the camera comes in to just short of it
    // along the line from the head, and eases back out once it's clear (no popping in and out).
    const dir = _camDir.copy(camPos).sub(head);
    const full = dir.length();
    dir.divideScalar(full);
    const s = this.structures;
    const hit = Math.min((s?.cameraRay ?? s?.raycast)?.(head, dir, full + CAMERA_WALL_GAP) ?? Infinity, this.nature?.cameraRay?.(head, dir, full + CAMERA_WALL_GAP) ?? Infinity);
    const want = hit < Infinity ? hit - Math.min(CAMERA_WALL_GAP, hit / 2) : full;
    this.camReach = want < this.camReach ? want : Math.min(want, this.camReach + CAMERA_EASE_OUT);
    if (this.camReach < full) camPos.copy(head).addScaledVector(dir, this.camReach);
    this.aboveGround(camPos); // pulled in along the line from the head: a bump of ground on the way can still need it
    camera.position.copy(camPos);
    camera.up.copy(up);
    camera.lookAt(head.addScaledVector(look, 6).addScaledVector(right, 0.55));
  }
}
