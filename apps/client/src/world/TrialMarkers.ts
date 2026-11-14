// World markers for race / defend / collect missions (2026-11-12): race rings, the beacon's ring and
// beam, gleam shards and Lark's kite panels (diamond kites since #86). Every piece glows in its
// mission's colour (ui/missionColour.ts), the colour of its row in the missions panel. Pooled: one InstancedMesh per kind per body, sized to
// that body's objects, sharing two module-level emissive node materials (a solid one and a
// see-through one) (MeshBasicNodeMaterial: works on
// WebGPU and the WebGL2 fallback) that the shader warm-up compiles from kept samples
// (trialWarmupHook, registered in Game.warmupHook). Positions come from the shared world-object table,
// so they match the server's triggers (quests/trials.ts).

import * as THREE from "three/webgpu";
import { abs, cameraPosition, dot, float, length, materialColor, mix, normalView, positionViewDirection, positionWorld, smoothstep } from "three/tsl";
import type { BodyId, Terrain } from "@firstlight/shared";
import { MISSION_BY_ID, type MissionDef } from "@firstlight/shared/content/missions";
import { objectPos, objectsOn, type WorldObjectDef } from "@firstlight/shared/content/world";
import type { TrialMsg } from "@firstlight/shared/net/protocol";
import { atmo } from "../render/atmosphere.ts";
import { keptSamples } from "../render/warmup.ts";
import { missionColourHex } from "../ui/missionColour.ts";

/** Ring centres stand this high (the server's TRIAL_RULES.RING_LIFT). */
export const RING_LIFT = 1.6;

let mat: THREE.MeshBasicNodeMaterial | null = null;
let softMat: THREE.MeshBasicNodeMaterial | null = null;
let geos: { ring: THREE.BufferGeometry; flat: THREE.BufferGeometry; fill: THREE.BufferGeometry; column: THREE.BufferGeometry; shard: THREE.BufferGeometry; kite: THREE.BufferGeometry } | null = null;

/** A diamond kite, about 0.8 × 1.2 m, a few centimetres thick (#86: a kite panel looks like a kite). */
function kiteGeometry(): THREE.BufferGeometry {
  const sh = new THREE.Shape();
  sh.moveTo(0, 0.62);
  sh.lineTo(0.4, 0.12);
  sh.lineTo(0, -0.62);
  sh.lineTo(-0.4, 0.12);
  sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, { depth: 0.05, bevelEnabled: false });
  g.translate(0, 0, -0.025);
  return g;
}

/** One emissive material for every marker; instance colours carry the state (white → bloom-ready). */
function material(): THREE.MeshBasicNodeMaterial {
  if (!mat) {
    mat = new THREE.MeshBasicNodeMaterial({ color: 0xffffff, toneMapped: true });
    mat.name = "trialMarker";
    mat.colorNode = materialColor.mul(atmo.glowBoost); // brighter at night, like the quest props
  }
  return mat;
}

/**
 * The see-through light (D-polish-8): the beacon's beam and the faint fill of its ground ring. Added
 * over the scene, never solid; soft at its silhouette and at grazing angles (so the ground fill seen
 * from a distance is a hint, not a white sheet), and nearly gone within a few metres of the lens,
 * the camera inside the beam included. Only a quarter of the night boost: Hollowmere is dark and the
 * same value reads far hotter there.
 */
function softMaterial(): THREE.MeshBasicNodeMaterial {
  if (!softMat) {
    softMat = new THREE.MeshBasicNodeMaterial({ color: 0xffffff, toneMapped: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    softMat.name = "trialMarkerSoft";
    softMat.colorNode = materialColor.mul(atmo.glowBoost.mul(0.25).add(0.75));
    const facing = abs(dot(normalView, positionViewDirection)).clamp(0, 1);
    const nearDim = mix(float(0.12), float(1), smoothstep(3.0, 14.0, length(positionWorld.sub(cameraPosition))));
    softMat.opacityNode = facing.mul(nearDim);
  }
  return softMat;
}

function geometries() {
  geos ??= {
    ring: new THREE.TorusGeometry(2.6, 0.16, 8, 40),
    flat: new THREE.TorusGeometry(1, 0.012, 4, 64), // scaled to the beacon radius on the ground
    fill: new THREE.CircleGeometry(1, 48), // the faint fill inside it (soft material)
    column: new THREE.CylinderGeometry(0.22, 0.32, 7, 10, 1, true),
    shard: new THREE.OctahedronGeometry(0.42, 0),
    kite: kiteGeometry(),
  };
  return geos;
}

// Colours (linear, >1 to catch the bloom).
const C = {
  next: new THREE.Color(2.6, 1.9, 0.6), // gold
  later: new THREE.Color(0.55, 0.75, 1.1), // pale blue
  // Ring posts (soft material, added light): a gold beam over the ring to run now, a short dim one over the rest.
  postNext: new THREE.Color(1.5, 1.05, 0.3),
  postLater: new THREE.Color(0.22, 0.32, 0.5),
  // The beacon stays under the bloom threshold (1.25) at night too, where glowBoost reaches 2: a thin
  // outline in these, and the beam and fill (soft material) in fractions of them.
  beaconIdle: new THREE.Color(0.28, 0.55, 0.62),
  beaconLit: new THREE.Color(0.62, 0.48, 0.18),
  beaconPaused: new THREE.Color(0.62, 0.2, 0.15),
};

interface Spot {
  def: WorldObjectDef;
  pos: THREE.Vector3;
  up: THREE.Vector3;
  /** Rings: the race this ring is on, its place in it, and the ring it faces (the next, or the previous for the last). */
  race?: { mission: string; k: number; toward: THREE.Vector3 | null };
  /** Shards: the collect this piece belongs to and its index in it. */
  piece?: { mission: string; k: number };
}

/** One of your open missions on this body, as update() looks it up (pooled per id, reused every frame). */
interface OpenEntry {
  def: MissionDef;
  counts: readonly number[] | undefined;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
/** A collect piece's glow: its mission's colour, lifted over the bloom threshold like the others. */
const pieceColours = new Map<string, THREE.Color>();
function pieceColour(mission: string): THREE.Color {
  let c = pieceColours.get(mission);
  if (!c) pieceColours.set(mission, (c = new THREE.Color(missionColourHex(mission)).multiplyScalar(2.4)));
  return c;
}

/** Scratch for the beacon's ground ring and the shard spin (update allocates nothing per frame). */
const _q2 = new THREE.Quaternion();
const _spin = new THREE.Quaternion();
const _yAxis = new THREE.Vector3(0, 1, 0);
/** The torus (XY plane) laid flat on the tangent plane. */
const LAY_FLAT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
const FACE_UP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const _s = new THREE.Vector3();
const _s2 = new THREE.Vector3();
const _c = new THREE.Color();
/** The torus's outer radius: a ring's post starts at its top. */
const RING_TOP = 2.76;
/** Ring posts (D-polish-9), as scales of the 7 m column: the next ring's is 16 m tall and 1 m wide, a later ring's 4 m. */
const POST_NEXT_H = 16 / 7;
const POST_NEXT_W = 1.9;
const POST_LATER_H = 4 / 7;
const POST_LATER_W = 0.9;
/** The beam's and the fill's share of the beacon colour (added light, so small). */
const BEAM_K = 1.5;
const FILL_K = 0.45;
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
  private readonly kites: Spot[];
  private readonly ringMesh: THREE.InstancedMesh | null;
  private readonly postMesh: THREE.InstancedMesh | null;
  private readonly flatMesh: THREE.InstancedMesh | null;
  private readonly fillMesh: THREE.InstancedMesh | null;
  private readonly columnMesh: THREE.InstancedMesh | null;
  private readonly shardMesh: THREE.InstancedMesh | null;
  private readonly kiteMesh: THREE.InstancedMesh | null;
  private t = 0;
  /** Open missions by id, refilled each frame from pooled entries (no per-frame Map or wrappers). */
  private readonly open = new Map<string, OpenEntry>();
  private readonly pool = new Map<string, OpenEntry>();

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
    const isKite = (o: WorldObjectDef) => o.look === "shard" && /kite/i.test(o.name);
    this.shards = objs.filter((o) => o.look === "shard" && !isKite(o)).map(spot);
    this.kites = objs.filter(isKite).map(spot);
    // Static race order and piece indices, worked out once (was a find() per ring per frame).
    for (const s of this.rings) {
      const race = s.def.mission ? MISSION_BY_ID.get(s.def.mission)?.race : undefined;
      const k = race ? race.rings.indexOf(s.def.id) : -1;
      if (!race || k < 0) continue;
      const byId = (id: string | undefined) => this.rings.find((r) => r.def.id === id);
      const t = byId(race.rings[Math.min(k + 1, race.rings.length - 1)]) ?? byId(race.rings[Math.max(0, k - 1)]);
      s.race = { mission: s.def.mission!, k, toward: t && t !== s ? t.pos : null };
    }
    for (const s of [...this.shards, ...this.kites]) {
      const c = s.def.mission ? MISSION_BY_ID.get(s.def.mission)?.collect : undefined;
      const k = c ? c.pieces.indexOf(s.def.id) : -1;
      if (c && k >= 0) s.piece = { mission: s.def.mission!, k };
    }
    const g = geometries();
    const make = (geo: THREE.BufferGeometry, n: number, name: string, soft = false) => {
      if (!n) return null;
      const m = new THREE.InstancedMesh(geo, soft ? softMaterial() : material(), n);
      m.name = `trialMarkers:${name}`;
      m.frustumCulled = false; // spread over hundreds of metres; a handful of instances
      m.castShadow = false;
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
      for (let i = 0; i < n; i++) m.setMatrixAt(i, HIDDEN);
      this.group.add(m);
      return m;
    };
    this.ringMesh = make(g.ring, this.rings.length, "rings");
    this.postMesh = make(g.column, this.rings.length, "ringPosts", true);
    this.flatMesh = make(g.flat, this.beacons.length, "beaconRing");
    this.fillMesh = make(g.fill, this.beacons.length, "beaconFill", true);
    this.columnMesh = make(g.column, this.beacons.length, "beaconColumn", true);
    this.shardMesh = make(g.shard, this.shards.length, "shards");
    this.kiteMesh = make(g.kite, this.kites.length, "kites");
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
    const open = this.open;
    open.clear();
    for (const m of st.missions) {
      if (m.done) continue;
      let e = this.pool.get(m.id);
      if (!e) {
        const def = MISSION_BY_ID.get(m.id);
        if (!def || def.body !== this.body) continue;
        this.pool.set(m.id, (e = { def, counts: undefined }));
      }
      e.counts = m.counts;
      open.set(m.id, e);
    }
    const trial = st.trial;
    let any = false;

    // Race rings: upright, facing along the route; the next one gold, the rest pale; passed ones gone.
    // A ring seen edge-on is a line in the grass, so each carries a post of light that reads from any
    // side: a tall gold beam over the one to run now, a short dim one over the rest.
    const ringMesh = this.ringMesh;
    const postMesh = this.postMesh;
    if (ringMesh && postMesh) {
      for (let i = 0; i < this.rings.length; i++) {
        const s = this.rings[i]!;
        const r = s.race;
        const running = !!r && !!trial && trial.id === r.mission && trial.state === "running";
        const next = running ? trial!.progress : 0;
        if (!r || !open.has(r.mission) || (running && r.k < next)) {
          ringMesh.setMatrixAt(i, HIDDEN);
          postMesh.setMatrixAt(i, HIDDEN);
          continue;
        }
        any = true;
        const q = this.frame(s, r.toward);
        const pulse = r.k === next ? 1 + Math.sin(this.t * 4) * 0.05 : 0.85;
        _p.copy(s.pos).addScaledVector(s.up, RING_LIFT);
        ringMesh.setMatrixAt(i, _m.compose(_p, q, _s.set(pulse, pulse, pulse)));
        ringMesh.setColorAt(i, r.k === next ? C.next : C.later);
        const h = r.k === next ? POST_NEXT_H : POST_LATER_H;
        const w = r.k === next ? POST_NEXT_W * pulse : POST_LATER_W;
        _p.copy(s.pos).addScaledVector(s.up, RING_LIFT + RING_TOP + h * 3.5);
        postMesh.setMatrixAt(i, _m.compose(_p, q, _s.set(w, h, w)));
        postMesh.setColorAt(i, r.k === next ? C.postNext : C.postLater);
      }
      postMesh.instanceMatrix.needsUpdate = true;
      if (postMesh.instanceColor) postMesh.instanceColor.needsUpdate = true;
      ringMesh.instanceMatrix.needsUpdate = true;
      if (ringMesh.instanceColor) ringMesh.instanceColor.needsUpdate = true;
    }

    // Beacons: a thin ground outline at the hold radius with a faint fill, and a soft beam; gold while
    // held, coral while paused.
    const flatMesh = this.flatMesh;
    const fillMesh = this.fillMesh;
    const columnMesh = this.columnMesh;
    if (flatMesh && fillMesh && columnMesh) {
      for (let i = 0; i < this.beacons.length; i++) {
        const s = this.beacons[i]!;
        const d = s.def.mission ? open.get(s.def.mission)?.def.defend : undefined;
        if (!d) {
          flatMesh.setMatrixAt(i, HIDDEN);
          fillMesh.setMatrixAt(i, HIDDEN);
          columnMesh.setMatrixAt(i, HIDDEN);
          continue;
        }
        any = true;
        const mine = !!trial && trial.id === s.def.mission;
        const col = mine && trial!.state === "paused" ? C.beaconPaused : mine && trial!.state === "running" ? C.beaconLit : C.beaconIdle;
        const q = this.frame(s, null);
        // The outline lies on the ground: rotate the torus (XY plane) to the tangent plane. A band
        // about 10 cm high (it was a metre-high wall, which bloomed into a solid disc).
        const flatQ = _q2.copy(q).multiply(LAY_FLAT);
        _p.copy(s.pos).addScaledVector(s.up, 0.15);
        flatMesh.setMatrixAt(i, _m.compose(_p, flatQ, _s.set(d.radius, d.radius, 4)));
        flatMesh.setColorAt(i, col);
        // The fill faces up (LAY_FLAT turns the circle's +Z down, so it is turned the other way).
        _p.copy(s.pos).addScaledVector(s.up, 0.2);
        fillMesh.setMatrixAt(i, _m.compose(_p, _q2.copy(q).multiply(FACE_UP), _s.set(d.radius, d.radius, 1)));
        fillMesh.setColorAt(i, _c.copy(col).multiplyScalar(FILL_K));
        const breathe = mine && trial!.state === "running" ? 1 + Math.sin(this.t * 3) * 0.12 : 0.7;
        _p.copy(s.pos).addScaledVector(s.up, 3.5);
        columnMesh.setMatrixAt(i, _m.compose(_p, q, _s.set(breathe, 1, breathe)));
        columnMesh.setColorAt(i, _c.copy(col).multiplyScalar(BEAM_K));
      }
      flatMesh.instanceMatrix.needsUpdate = true;
      fillMesh.instanceMatrix.needsUpdate = true;
      if (fillMesh.instanceColor) fillMesh.instanceColor.needsUpdate = true;
      columnMesh.instanceMatrix.needsUpdate = true;
      if (flatMesh.instanceColor) flatMesh.instanceColor.needsUpdate = true;
      if (columnMesh.instanceColor) columnMesh.instanceColor.needsUpdate = true;
    }

    // Shards and kite panels: bobbing, spinning in their mission's colour; gone once taken.
    if (this.pieces(this.shardMesh, this.shards, open, 1.6, _s.set(1, 1.5, 1))) any = true;
    if (this.pieces(this.kiteMesh, this.kites, open, 0.7, _s2.set(1, 1, 1))) any = true;
    this.group.visible = any;
  }

  /** Draw one kind of collect piece; true when any is shown. */
  private pieces(mesh: THREE.InstancedMesh | null, spots: readonly Spot[], open: ReadonlyMap<string, OpenEntry>, spin: number, scale: THREE.Vector3): boolean {
    if (!mesh) return false;
    let any = false;
    for (let i = 0; i < spots.length; i++) {
      const s = spots[i]!;
      const pc = s.piece;
      const mission = pc ? open.get(pc.mission) : undefined;
      if (!pc || !mission?.def.collect || mission.counts?.[pc.k]) {
        mesh.setMatrixAt(i, HIDDEN);
        continue;
      }
      any = true;
      const q = this.frame(s, null).multiply(_spin.setFromAxisAngle(_yAxis, this.t * spin + i));
      _p.copy(s.pos).addScaledVector(s.up, 1.1 + Math.sin(this.t * 2 + i) * 0.15);
      mesh.setMatrixAt(i, _m.compose(_p, q, scale));
      mesh.setColorAt(i, pieceColour(pc.mission));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return any;
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
        // The soft material is compiled once per geometry it is drawn with (fill, column).
        return ([[g.ring, false], [g.flat, false], [g.shard, false], [g.kite, false], [g.fill, true], [g.column, true]] as const).map(([geo, soft], i) => {
          const m = new THREE.InstancedMesh(geo, soft ? softMaterial() : material(), 1);
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
