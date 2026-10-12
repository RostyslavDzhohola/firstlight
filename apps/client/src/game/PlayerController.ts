// Local player movement on a sphere: run/sprint/jump/dodge/swim/fall damage, client-predicted.
// The server validates (SPEC §5.3); `correct` messages snap us back. Intact breakable props block
// (the player slides along them) and can be stood on (MoveColliders, set by the destruction view).
// Runs every frame: module scratch vectors, no allocations.

import * as THREE from "three/webgpu";
import type { Terrain } from "@firstlight/shared";
import { emptyContact, type PropContact } from "@firstlight/shared/planet/collide";
import { ANIM } from "@firstlight/shared/net/schema";
import type { Input } from "./input.ts";
import { mountedSpeed, rideCamera } from "./mount.ts";

/** Solid things the player can't walk through (intact breakable props). */
export interface MoveColliders {
  /** Push `pos` (feet, planet space) out of solid props; fills `out` (push direction, floor under the feet). */
  resolve(pos: THREE.Vector3, out: PropContact): boolean;
  /** Distance along a ray (unit `d`) to the first solid prop within `maxT`, or Infinity (tracers). */
  raycast?(o: THREE.Vector3, d: THREE.Vector3, maxT: number): number;
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
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

export class PlayerController {
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  /** Unit tangent the character faces. */
  readonly facing = new THREE.Vector3(0, 0, 1);
  /** Unit tangent the camera looks along (yaw only). */
  readonly camForward = new THREE.Vector3(0, 0, 1);
  camPitch = -0.15;
  camDistance = 4.6;
  onGround = false;
  swimming = false;
  anim: number = ANIM.IDLE;
  private dodgeT = 0;
  private dodgeCooldown = 0;
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
  private colliders: MoveColliders | null = null;
  private readonly contact = emptyContact();

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

  update(dt: number, input: Input, aiming: boolean) {
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
    const speed = this.swimming ? MOVE.swim : this.mounted ? mountedSpeed(sprint, MOVE.slow, MOVE.noSprint) : sprint && mz > 0 && !aiming ? MOVE.sprint : MOVE.run;

    this.dodgeCooldown = Math.max(0, this.dodgeCooldown - dt);
    if (!this.frozen && !this.mounted && input.pressed.has("KeyC") && this.dodgeCooldown <= 0 && this.onGround && !this.swimming) {
      this.dodgeT = MOVE.dodgeTime;
      this.dodgeCooldown = MOVE.dodgeCooldown;
      this.dodgeDir.copy(wish.lengthSq() > 0 ? wish : this.facing);
    }

    // Split velocity into vertical (radial) and horizontal (tangent) parts.
    const vUp = this.vel.dot(up);
    const vH = _vH.copy(this.vel).addScaledVector(up, -vUp);
    if (this.dodgeT > 0) {
      this.dodgeT -= dt;
      vH.copy(this.dodgeDir).multiplyScalar(MOVE.dodgeDistance / MOVE.dodgeTime);
    } else {
      const target = wish.multiplyScalar(speed);
      const a = this.onGround || this.swimming ? (this.mounted ? MOVE.mountAccel : MOVE.accel) : MOVE.airAccel;
      vH.lerp(target, Math.min(1, a * dt));
    }

    let vUpNew = vUp;
    if (this.swimming) {
      vUpNew = 0;
    } else {
      vUpNew -= MOVE.gravity * dt;
      if (this.onGround && !this.frozen && input.pressed.has("Space")) {
        vUpNew = MOVE.jumpSpeed;
        this.onGround = false;
        this.fallStartRadius = this.pos.length();
      }
    }
    this.vel.copy(vH).addScaledVector(up, vUpNew);
    this.pos.addScaledVector(this.vel, dt);

    // Props: shoved out sideways (and the motion into them dropped, so we slide along), or a floor.
    let floorR = 0;
    if (this.colliders) {
      const c = this.contact;
      this.colliders.resolve(this.pos, c);
      if (c.pushed) {
        const n = _dir.set(c.nx, c.ny, c.nz);
        const into = this.vel.dot(n);
        if (into < 0) this.vel.addScaledVector(n, -into);
        const intoH = vH.dot(n);
        if (intoH < 0) vH.addScaledVector(n, -intoH);
        const intoDodge = this.dodgeDir.dot(n);
        if (this.dodgeT > 0 && intoDodge < 0) this.dodgeDir.addScaledVector(n, -intoDodge);
      }
      // A prop top only catches a player who isn't rising (a jump past an edge keeps going up).
      if (c.floor > 0 && this.vel.dot(up) <= 0.5) floorR = c.floor;
    }

    // Ground (terrain or a prop top) and water.
    const newUp = _newUp.copy(this.pos).normalize();
    const ground = this.terrain.groundHeight(newUp.x, newUp.y, newUp.z);
    const r = this.pos.length();
    const waterR = R + this.waterLevel;
    const groundR = Math.max(R + ground, floorR);
    const deep = ground < this.waterLevel - 1.2 && floorR === 0;
    const wasOnGround = this.onGround;
    if (deep && r <= waterR - 1.0) {
      this.swimming = true;
      this.onGround = false;
      this.pos.copy(newUp).multiplyScalar(waterR - 1.05);
      this.fallStartRadius = this.pos.length();
    } else if (r <= groundR) {
      this.pos.copy(newUp).multiplyScalar(groundR);
      if (!wasOnGround) {
        const drop = this.fallStartRadius - groundR;
        if (drop > MOVE.fallSafe && !this.swimming) this.pendingFallDamage += Math.min(1, ((drop - MOVE.fallSafe) * 0.08));
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

    // Face movement (or the camera when aiming).
    const hSpeed = vH.length();
    if (aiming) this.facing.lerp(this.camForward, Math.min(1, 18 * dt)).normalize();
    else if (hSpeed > 0.5) this.facing.lerp(_dir.copy(vH).normalize(), Math.min(1, (this.mounted ? 6 : 10) * dt)).normalize();

    this.anim = this.dodgeT > 0 ? ANIM.DODGE
      : this.swimming ? ANIM.SWIM
      : !this.onGround ? (this.vel.dot(newUp) > 0 ? ANIM.JUMP : ANIM.FALL)
      : hSpeed > 7 ? ANIM.SPRINT
      : hSpeed > 3.5 ? ANIM.RUN
      : hSpeed > 0.3 ? ANIM.WALK
      : ANIM.IDLE;
  }

  /** Over-the-shoulder camera. */
  placeCamera(camera: THREE.PerspectiveCamera) {
    const up = _up.copy(this.pos).normalize();
    const right = _right.crossVectors(this.camForward, up).normalize();
    const look = _look.copy(this.camForward).applyAxisAngle(right, this.camPitch);
    const ride = rideCamera(this.rideBlend); // in the saddle: eyes higher, camera further back
    const head = _head.copy(this.pos).addScaledVector(up, 1.65 + ride.lift);
    const camPos = _cam.copy(head).addScaledVector(look, -(this.camDistance + ride.back)).addScaledVector(right, 0.55).addScaledVector(up, 0.25);
    // Keep the camera above ground.
    const cu = _camUp.copy(camPos).normalize();
    const g = this.terrain.groundHeight(cu.x, cu.y, cu.z) + this.terrain.body.radius + 0.4;
    if (camPos.length() < g) camPos.copy(cu).multiplyScalar(g);
    camera.position.copy(camPos);
    camera.up.copy(up);
    camera.lookAt(head.addScaledVector(look, 6).addScaledVector(right, 0.55));
  }
}
