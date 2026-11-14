// The agent's body: the browser client's movement rules (apps/client PlayerController) without a
// browser. It walks on the shared terrain, slides round the same solids the server checks (intact
// breakables, structures, natural solids), swims where the water is deep and falls off tops, so
// every position it reports is one an honest client could have reported: the server's validator
// (apps/server world/movement.ts) accepts them without corrections.

import { ANIM } from "@firstlight/shared/net/schema";
import { emptyContact, resetContact, type PropContact, type XYZ } from "@firstlight/shared/planet/collide";
import { deepWater, SWIM_FLOAT } from "@firstlight/shared/planet/water";
import { BASE_MOVE, starterMove } from "@firstlight/shared/content/starters";
import { BASE_GRAVITY, bodyGravity } from "@firstlight/shared/planet/bodies";
import type { BodyWorld } from "./world.ts";
import { cross, dot, len, norm, tangent, type V3 } from "./vec.ts";

/**
 * The client's speeds (m/s) and the server's matching allowances (movement.ts MOVE). `run`, `sprint`
 * and `dodgeCooldownMs` are the shared base: each starter has its own (content/starters.ts), which a
 * Walker takes with `setStarter` and offers as `walker.run`, `walker.sprint` and `walker.dodgeCooldownMs`.
 */
export const WALK = {
  run: BASE_MOVE.run,
  sprint: BASE_MOVE.sprint,
  swim: 3,
  /** The base pull; each body's own (Lumen's is a quarter) is `bodyGravity` of the walker's body. */
  gravity: BASE_GRAVITY,
  dodgeSpeed: 15, // 4.5 m in 0.3 s
  dodgeTime: 0.3,
  /** A roll starts this much later than the server's cooldown allows, so clock skew can't refuse one. */
  dodgeSkewMs: 100,
  /** The base cooldown (1.2 s on the server) with the skew: starters differ (walker.dodgeCooldownMs). */
  dodgeCooldownMs: BASE_MOVE.dodgeCooldown * 1000 + 100,
} as const;

/** A movement effect the server enforces for a while (npc/effects.ts; Frostbloom's slow is one too). */
interface MoveFx {
  kind: "slow" | "nosprint";
  amount: number;
  until: number;
}

const SUBSTEP = 0.25;
const MAX_SUBSTEPS = 16;

export class Walker {
  readonly pos: XYZ = { x: 0, y: 0, z: 0 };
  /** Unit tangent the body faces. */
  facing: V3 = [0, 0, 1];
  anim: number = ANIM.IDLE;
  onGround = true;
  swimming = false;
  /** Metres moved along the ground by the last step. */
  lastMoved = 0;
  private vUp = 0;
  private dodgeLeft = 0;
  private dodgeDir: V3 = [0, 0, 1];
  dodgeReadyAt = 0;
  private readonly c = emptyContact();
  private readonly sc = emptyContact();
  private readonly nc = emptyContact();
  private world: BodyWorld;
  private isBroken: (id: string) => boolean;
  /** This starter's own pace and roll (content/starters.ts): the row the server validates against. */
  private baseRun: number = WALK.run;
  private baseSprint: number = WALK.sprint;
  private dodgeMs: number = WALK.dodgeCooldownMs;
  private readonly fx: MoveFx[] = [];

  constructor(world: BodyWorld, isBroken: (id: string) => boolean = () => false) {
    this.world = world;
    this.isBroken = isBroken;
  }

  setWorld(world: BodyWorld, isBroken: (id: string) => boolean) {
    this.world = world;
    this.isBroken = isBroken;
  }

  /** Take a starter's run and sprint speed and dodge cooldown from the shared table (STARTERS index). */
  setStarter(starter: number) {
    const m = starterMove(starter);
    this.baseRun = m.run;
    this.baseSprint = m.sprint;
    this.dodgeMs = m.dodgeCooldown * 1000 + WALK.dodgeSkewMs;
  }

  /** The server slowed this body (an `npcFx` message: chill, slow, no-sprint): predict it, as the client does. */
  addEffect(kind: string, amount: number, ms: number, now = Date.now()) {
    if (kind === "chill" || kind === "slow") this.fx.push({ kind: "slow", amount: Math.max(0, Math.min(1, amount)), until: now + ms });
    else if (kind === "nosprint") this.fx.push({ kind: "nosprint", amount: 0, until: now + ms });
  }

  private effects(now: number): { slow: number; noSprint: boolean } {
    let slow = 0, noSprint = false;
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const e = this.fx[i]!;
      if (e.until <= now) this.fx.splice(i, 1);
      else if (e.kind === "slow") slow = Math.max(slow, e.amount);
      else noSprint = true;
    }
    return { slow, noSprint };
  }

  /** Run speed right now (m/s): the starter's, less any slow. */
  get run(): number {
    return this.baseRun * (1 - this.effects(Date.now()).slow);
  }

  /** Sprint speed right now (m/s): the starter's, less any slow; a run while sprinting is forbidden. */
  get sprint(): number {
    const e = this.effects(Date.now());
    return (e.noSprint ? this.baseRun : this.baseSprint) * (1 - e.slow);
  }

  /** Milliseconds between rolls for this starter (the server's cooldown plus a little skew). */
  get dodgeCooldownMs(): number {
    return this.dodgeMs;
  }

  get p(): V3 {
    return [this.pos.x, this.pos.y, this.pos.z];
  }

  up(): V3 {
    return norm([this.pos.x, this.pos.y, this.pos.z]);
  }

  /** The server put the body here (join, correction, teleport): take it as it is. */
  place(x: number, y: number, z: number) {
    this.pos.x = x;
    this.pos.y = y;
    this.pos.z = z;
    this.vUp = 0;
    this.dodgeLeft = 0;
    const up = this.up();
    this.facing = tangent(up, this.facing) ?? tangent(up, [0, 0, 1]) ?? [1, 0, 0];
    const g = this.world.groundAt(this.p);
    const h = len(this.p) - this.world.R;
    this.swimming = deepWater(g, this.world.body.waterLevel) && h <= this.world.body.waterLevel - 1.0 + 0.2;
    this.onGround = !this.swimming && h - g <= 0.35;
  }

  /** Start a roll along `dir` (unit tangent) if one is ready; the next steps carry it. */
  dodge(dir: V3, now: number): boolean {
    if (now < this.dodgeReadyAt || !this.onGround || this.swimming) return false;
    const e = this.effects(now);
    if (e.noSprint || e.slow > 0) return false; // the server shrinks or refuses the burst while slowed
    this.dodgeReadyAt = now + this.dodgeMs;
    this.dodgeLeft = WALK.dodgeTime;
    this.dodgeDir = dir;
    this.facing = dir;
    return true;
  }

  get rolling(): boolean {
    return this.dodgeLeft > 0;
  }

  private solid = (i: number): boolean => !this.isBroken(this.world.breakables.list[i]!.id);

  private slide(c: PropContact, v: V3) {
    const into = v[0] * c.nx + v[1] * c.ny + v[2] * c.nz;
    if (into < 0) {
      v[0] -= c.nx * into;
      v[1] -= c.ny * into;
      v[2] -= c.nz * into;
    }
  }

  private scaleTo(r: number) {
    const l = Math.hypot(this.pos.x, this.pos.y, this.pos.z);
    const k = r / l;
    this.pos.x *= k;
    this.pos.y *= k;
    this.pos.z *= k;
  }

  private groundR(): number {
    const l = Math.hypot(this.pos.x, this.pos.y, this.pos.z);
    return this.world.R + this.world.terrain.groundHeight(this.pos.x / l, this.pos.y / l, this.pos.z / l);
  }

  /**
   * One step of `dt` seconds: walk along `wish` (unit tangent, or null to stand) at `speed` m/s.
   * `face` (unit tangent) overrides the facing (aiming at a target while moving or standing).
   * `hold`: don't move sideways at all this step (a roll in progress is put on hold too).
   */
  step(dt: number, wish: V3 | null, speed: number, face: V3 | null = null, hold = false) {
    const w = this.world;
    const R = w.R;
    const start = this.p;
    const up = this.up();
    let vH: V3 = [0, 0, 0];
    if (hold) {
      // Standing still on purpose (the server has stalled): a roll in progress waits too.
    } else if (this.dodgeLeft > 0) {
      this.dodgeLeft -= dt;
      const d = tangent(up, this.dodgeDir) ?? this.facing;
      vH = [d[0] * WALK.dodgeSpeed, d[1] * WALK.dodgeSpeed, d[2] * WALK.dodgeSpeed];
    } else if (wish) {
      const d = tangent(up, wish);
      const s = this.swimming ? Math.min(speed, WALK.swim) : Math.min(speed, this.sprint);
      if (d) vH = [d[0] * s, d[1] * s, d[2] * s];
    }
    if (this.swimming) this.vUp = 0;
    else this.vUp -= bodyGravity(this.world.body) * dt;
    const hSpeed0 = len(vH);

    let floorR = 0;
    const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(Math.max((hSpeed0 * dt) / SUBSTEP, (Math.abs(this.vUp) * dt) / SUBSTEP))));
    const h = dt / steps;
    for (let k = 0; k < steps; k++) {
      this.pos.x += (vH[0] + up[0] * this.vUp) * h;
      this.pos.y += (vH[1] + up[1] * this.vUp) * h;
      this.pos.z += (vH[2] + up[2] * this.vUp) * h;
      if (!this.swimming) {
        const g = this.groundR();
        if (Math.hypot(this.pos.x, this.pos.y, this.pos.z) < g) this.scaleTo(g);
      }
      const c = this.c;
      if (w.breakables.list.length) w.breakables.resolve(this.pos, this.solid, c);
      else resetContact(c);
      if (c.pushed) this.slide(c, vH);
      w.structures.resolve(this.pos, this.sc);
      if (this.sc.pushed) this.slide(this.sc, vH);
      if (this.sc.floor > c.floor) c.floor = this.sc.floor;
      w.nature.resolve(this.pos, this.nc);
      if (this.nc.pushed) this.slide(this.nc, vH);
      if (this.nc.floor > c.floor) c.floor = this.nc.floor;
      floorR = c.floor > 0 && this.vUp <= 0.5 ? c.floor : 0;
      if (floorR > 0 && Math.hypot(this.pos.x, this.pos.y, this.pos.z) < floorR) {
        this.scaleTo(floorR);
        if (this.vUp < 0) this.vUp = 0;
      }
    }

    // Ground (terrain or a top) and water: the client's rules, which are the server's too.
    const l = Math.hypot(this.pos.x, this.pos.y, this.pos.z);
    const ground = this.groundR() - R;
    const waterR = R + w.body.waterLevel;
    const groundR = Math.max(R + ground, floorR);
    const deep = deepWater(ground, w.body.waterLevel) && floorR === 0;
    if (deep && l <= waterR - 1.0) {
      this.swimming = true;
      this.onGround = false;
      this.scaleTo(waterR - SWIM_FLOAT);
      this.vUp = 0;
    } else if (l <= groundR) {
      this.scaleTo(groundR);
      this.onGround = true;
      this.swimming = false;
      if (this.vUp < 0) this.vUp = 0;
    } else {
      if (this.swimming && !deep) this.swimming = false;
      if (this.onGround && l > groundR + 0.35) this.onGround = false;
      else if (this.onGround) {
        this.scaleTo(groundR); // stick to slopes downhill
        this.vUp = 0;
      }
    }

    // Where the snap put the feet: clear of the solids (the server refuses feet inside one).
    for (let pass = 0; pass < 2; pass++) {
      let pushed = false;
      w.structures.resolve(this.pos, this.sc);
      if (this.sc.pushed) pushed = true;
      w.nature.resolve(this.pos, this.nc);
      if (this.nc.pushed) pushed = true;
      if (!pushed) break;
      if (this.onGround && !this.swimming) {
        const ll = Math.hypot(this.pos.x, this.pos.y, this.pos.z);
        const g = this.groundR();
        if (g > ll || ll - g < 0.35) this.scaleTo(g);
      }
    }

    // Facing and the animation everyone else sees.
    const end = this.p;
    const newUp = norm(end);
    const moved: V3 = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
    const along = tangent(newUp, moved);
    const radial = dot(moved, newUp);
    this.lastMoved = Math.sqrt(Math.max(0, dot(moved, moved) - radial * radial));
    const hSpeed = dt > 0 ? this.lastMoved / dt : 0;
    const want = face ? tangent(newUp, face) : this.dodgeLeft > 0 ? tangent(newUp, this.dodgeDir) : hSpeed > 0.5 ? along : null;
    this.facing = want ?? tangent(newUp, this.facing) ?? tangent(newUp, cross(newUp, [1, 0, 0])) ?? [0, 0, 1];
    this.anim = this.dodgeLeft > 0 ? ANIM.DODGE
      : this.swimming ? ANIM.SWIM
      : !this.onGround ? ANIM.FALL
      : hSpeed > 7 ? ANIM.SPRINT
      : hSpeed > 3.5 ? ANIM.RUN
      : hSpeed > 0.3 ? ANIM.WALK
      : ANIM.IDLE;
  }

  /**
   * How far (metres along the ground) a body would get walking `metres` from here along `dir`,
   * without moving this one: the steering probe. Deep water ahead counts as blocked unless `wet`.
   */
  probe(dir: V3, metres: number, wet: boolean): number {
    const w = this.world;
    const save = { x: this.pos.x, y: this.pos.y, z: this.pos.z };
    const q = this.pos;
    let got = 0;
    const n = Math.max(1, Math.ceil(metres / 0.4));
    const stepLen = metres / n;
    for (let i = 0; i < n; i++) {
      const bx = q.x, by = q.y, bz = q.z;
      const up = norm([q.x, q.y, q.z]);
      const d = tangent(up, dir);
      if (!d) break;
      q.x += d[0] * stepLen;
      q.y += d[1] * stepLen;
      q.z += d[2] * stepLen;
      const g = this.groundR();
      this.scaleTo(g);
      if (!wet && deepWater(g - w.R, w.body.waterLevel)) {
        q.x = bx; q.y = by; q.z = bz;
        break;
      }
      let pushed = false;
      if (w.breakables.list.length) {
        w.breakables.resolve(q, this.solid, this.c);
        pushed = pushed || this.c.pushed;
      }
      w.structures.resolve(q, this.sc);
      pushed = pushed || this.sc.pushed;
      w.nature.resolve(q, this.nc);
      pushed = pushed || this.nc.pushed;
      const made = (q.x - bx) * d[0] + (q.y - by) * d[1] + (q.z - bz) * d[2];
      got += Math.max(0, made);
      if (pushed && made < stepLen * 0.5) break;
    }
    this.pos.x = save.x;
    this.pos.y = save.y;
    this.pos.z = save.z;
    return got;
  }
}
