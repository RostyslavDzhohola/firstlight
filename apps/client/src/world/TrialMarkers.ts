// World markers for race / defend / collect missions (2026-11-12): race rings, the beacon's ring and
// column, and shards (also Lark's kite panels). Pooled: one InstancedMesh per kind per body, sized to
// that body's objects, sharing module-level emissive node materials (MeshBasicNodeMaterial: works on
// WebGPU and the WebGL2 fallback) that the shader warm-up compiles from kept samples
// (trialWarmupHook, registered in Game.warmupHook). Positions come from the shared world-object table,
// so they match the server's triggers (quests/trials.ts).

import * as THREE from "three/webgpu";
import { materialColor } from "three/tsl";
import type { BodyId, Terrain } from "@firstlight/shared";
import { MISSION_BY_ID, type MissionDef } from "@firstlight/shared/content/missions";
import { objectPos, objectsOn, type WorldObjectDef } from "@firstlight/shared/content/world";
import type { TrialMsg } from "@firstlight/shared/net/protocol";
import { atmo } from "../render/atmosphere.ts";
import { keptSamples } from "../render/warmup.ts";

/** Ring centres stand this high (the server's TRIAL_RULES.RING_LIFT). */
export const RING_LIFT = 1.6;

let mat: THREE.MeshBasicNodeMaterial | null = null;
let geos: { ring: THREE.BufferGeometry; flat: THREE.BufferGeometry; column: THREE.BufferGeometry; shard: THREE.BufferGeometry } | null = null;

/** One emissive material for every marker; instance colours carry the state (white → bloom-ready). */
function material(): THREE.MeshBasicNodeMaterial {
  if (!mat) {
    mat = new THREE.MeshBasicNodeMaterial({ color: 0xffffff, toneMapped: true });
    mat.name = "trialMarker";
    mat.colorNode = materialColor.mul(atmo.glowBoost); // brighter at night, like the quest props
  }
  return mat;
}

function geometries() {
  geos ??= {
    ring: new THREE.TorusGeometry(2.6, 0.16, 8, 40),
    flat: new THREE.TorusGeometry(1, 0.012, 4, 64), // scaled to the beacon radius on the ground
    column: new THREE.CylinderGeometry(0.22, 0.32, 7, 10, 1, true),
    shard: new THREE.OctahedronGeometry(0.42, 0),
  };
  return geos;
}

// Colours (linear, >1 to catch the bloom).
const C = {
  next: new THREE.Color(2.6, 1.9, 0.6), // gold
  later: new THREE.Color(0.55, 0.75, 1.1), // pale blue
  idle: new THREE.Color(0.7, 1.4, 1.6), // cyan
  lit: new THREE.Color(2.8, 2.2, 0.9),
  paused: new THREE.Color(2.4, 0.7, 0.5),
  shard: new THREE.Color(1.6, 2.3, 2.6),
  kite: new THREE.Color(2.4, 1.3, 1.6),
};

interface Spot {
  def: WorldObjectDef;
  pos: THREE.Vector3;
  up: THREE.Vector3;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

export interface TrialMarkerState {
  /** Your open missions (you.missions), with counts for collects. */
  missions: readonly { id: string; done: boolean; counts?: readonly number[] }[];
  /** The latest attempt message (trialState.ts), if any. */
  trial: TrialMsg | null;
}

export class TrialMarkers {
  readonly group = new THREE.Group();
  private readonly body: BodyId;
  private readonly rings: Spot[];
  private readonly beacons: Spot[];
  private readonly shards: Spot[];
  private readonly ringMesh: THREE.InstancedMesh | null;
  private readonly flatMesh: THREE.InstancedMesh | null;
  private readonly columnMesh: THREE.InstancedMesh | null;
  private readonly shardMesh: THREE.InstancedMesh | null;
  private t = 0;

  constructor(scene: THREE.Scene, body: BodyId, terrain: Terrain) {
    this.body = body;
    this.group.name = "trialMarkers";
    const spot = (def: WorldObjectDef): Spot => {
      const p = objectPos(def, (x, y, z) => terrain.groundHeight(x, y, z));
      const pos = new THREE.Vector3(p[0], p[1], p[2]);
      return { def, pos, up: pos.clone().normalize() };
    };
    const objs = objectsOn(body);
    this.rings = objs.filter((o) => o.look === "ring").map(spot);
    this.beacons = objs.filter((o) => o.look === "beacon").map(spot);
    this.shards = objs.filter((o) => o.look === "shard").map(spot);
    const g = geometries();
    const make = (geo: THREE.BufferGeometry, n: number, name: string) => {
      if (!n) return null;
      const m = new THREE.InstancedMesh(geo, material(), n);
      m.name = `trialMarkers:${name}`;
      m.frustumCulled = false; // spread over hundreds of metres; a handful of instances
      m.castShadow = false;
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
      for (let i = 0; i < n; i++) m.setMatrixAt(i, HIDDEN);
      this.group.add(m);
      return m;
    };
    this.ringMesh = make(g.ring, this.rings.length, "rings");
    this.flatMesh = make(g.flat, this.beacons.length, "beaconRing");
    this.columnMesh = make(g.column, this.beacons.length, "beaconColumn");
    this.shardMesh = make(g.shard, this.shards.length, "shards");
    scene.add(this.group);
  }

  /** Orientation at a spot: local up, facing `toward` (a tangent) if given. */
  private frame(s: Spot, toward: THREE.Vector3 | null): THREE.Quaternion {
    const up = s.up;
    let fwd = toward ? _a.copy(toward).sub(s.pos) : _a.set(0, 0, 1);
    fwd.addScaledVector(up, -fwd.dot(up));
    if (fwd.lengthSq() < 1e-6) fwd = _a.set(1, 0, 0).addScaledVector(up, -up.x);
    fwd.normalize();
    const right = _b.crossVectors(up, fwd).normalize();
    return _q.setFromRotationMatrix(_m.makeBasis(right, up, fwd));
  }

  update(dt: number, st: TrialMarkerState) {
    this.t += dt;
    const open = new Map<string, { def: MissionDef; counts?: readonly number[] }>();
    for (const m of st.missions) {
      const def = MISSION_BY_ID.get(m.id);
      if (!m.done && def && def.body === this.body) open.set(m.id, { def, counts: m.counts });
    }
    const trial = st.trial;
    let any = false;

    // Race rings: upright, facing along the route; the next one gold, the rest pale; passed ones gone.
    if (this.ringMesh) {
      this.rings.forEach((s, i) => {
        const mission = s.def.mission ? open.get(s.def.mission) : undefined;
        const race = mission?.def.race;
        const k = race ? race.rings.indexOf(s.def.id) : -1;
        const running = !!trial && trial.id === s.def.mission && trial.state === "running";
        const next = running ? trial!.progress : 0;
        if (!race || k < 0 || (running && k < next)) {
          this.ringMesh!.setMatrixAt(i, HIDDEN);
          return;
        }
        any = true;
        const toward = this.rings.find((r) => r.def.id === race.rings[Math.min(k + 1, race.rings.length - 1)]) ?? this.rings.find((r) => r.def.id === race.rings[Math.max(0, k - 1)]);
        const q = this.frame(s, toward && toward !== s ? toward.pos : null);
        const pulse = k === next ? 1 + Math.sin(this.t * 4) * 0.05 : 0.85;
        _p.copy(s.pos).addScaledVector(s.up, RING_LIFT);
        this.ringMesh!.setMatrixAt(i, _m.compose(_p, q, _s.set(pulse, pulse, pulse)));
        this.ringMesh!.setColorAt(i, k === next ? C.next : C.later);
      });
      this.ringMesh.instanceMatrix.needsUpdate = true;
      if (this.ringMesh.instanceColor) this.ringMesh.instanceColor.needsUpdate = true;
    }

    // Beacons: a ground ring at the hold radius and a column; lit while held, coral while paused.
    if (this.flatMesh && this.columnMesh) {
      this.beacons.forEach((s, i) => {
        const mission = s.def.mission ? open.get(s.def.mission) : undefined;
        const d = mission?.def.defend;
        if (!d) {
          this.flatMesh!.setMatrixAt(i, HIDDEN);
          this.columnMesh!.setMatrixAt(i, HIDDEN);
          return;
        }
        any = true;
        const mine = !!trial && trial.id === s.def.mission;
        const col = mine && trial!.state === "paused" ? C.paused : mine && trial!.state === "running" ? C.lit : C.idle;
        const q = this.frame(s, null);
        // The flat ring lies on the ground: rotate the torus (XY plane) to the tangent plane.
        const flatQ = _q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(_a.set(1, 0, 0), Math.PI / 2));
        _p.copy(s.pos).addScaledVector(s.up, 0.15);
        this.flatMesh!.setMatrixAt(i, _m.compose(_p, flatQ, _s.set(d.radius, d.radius, d.radius * 8)));
        this.flatMesh!.setColorAt(i, col);
        const breathe = mine && trial!.state === "running" ? 1 + Math.sin(this.t * 3) * 0.12 : 0.7;
        _p.copy(s.pos).addScaledVector(s.up, 3.5);
        this.columnMesh!.setMatrixAt(i, _m.compose(_p, q, _s.set(breathe, 1, breathe)));
        this.columnMesh!.setColorAt(i, col);
      });
      for (const m of [this.flatMesh, this.columnMesh]) {
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
    }

    // Shards and kite panels: bobbing, spinning; gone once taken.
    if (this.shardMesh) {
      this.shards.forEach((s, i) => {
        const mission = s.def.mission ? open.get(s.def.mission) : undefined;
        const c = mission?.def.collect;
        const k = c ? c.pieces.indexOf(s.def.id) : -1;
        if (!c || k < 0 || mission!.counts?.[k]) {
          this.shardMesh!.setMatrixAt(i, HIDDEN);
          return;
        }
        any = true;
        const q = this.frame(s, null).multiply(new THREE.Quaternion().setFromAxisAngle(_a.set(0, 1, 0), this.t * 1.6 + i));
        _p.copy(s.pos).addScaledVector(s.up, 1.1 + Math.sin(this.t * 2 + i) * 0.15);
        this.shardMesh!.setMatrixAt(i, _m.compose(_p, q, _s.set(1, 1.5, 1)));
        this.shardMesh!.setColorAt(i, s.def.mission === "A4" ? C.kite : C.shard);
      });
      this.shardMesh.instanceMatrix.needsUpdate = true;
      if (this.shardMesh.instanceColor) this.shardMesh.instanceColor.needsUpdate = true;
    }
    this.group.visible = any;
  }

  dispose() {
    this.group.removeFromParent();
    for (const c of this.group.children) (c as THREE.InstancedMesh).dispose?.(); // geometry and material are shared
  }
}

/**
 * Shader warm-up (render/warmup.ts WarmupHooks): while forced on, stands one instanced sample of each
 * marker geometry with the shared material in front of the player, kept for the session.
 */
export function trialWarmupHook(scene: THREE.Object3D, at: () => THREE.Vector3): { forceAll(on: boolean): void } {
  return {
    forceAll(on) {
      if (!on) {
        keptSamples("trialWarmup")?.removeFromParent();
        return;
      }
      const group = keptSamples("trialWarmup", () => {
        const g = geometries();
        return [g.ring, g.flat, g.column, g.shard].map((geo, i) => {
          const m = new THREE.InstancedMesh(geo, material(), 1);
          m.name = `trialWarmup:${i}`;
          m.frustumCulled = false;
          m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array([1, 1, 1]), 3);
          m.setMatrixAt(0, new THREE.Matrix4());
          return m;
        });
      });
      if (!group) return;
      group.position.copy(at());
      scene.add(group);
    },
  };
}
