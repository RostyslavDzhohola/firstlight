// Spell visuals (content §2.7): Skipstep's trail and flashes, Frostbloom's ring of frost and ice
// shards, Wishfall's warning ring, falling star, landing and scorch, the Glasswing Ward's faceted shell.
//
// Five node materials for all of it, built once: timing, style and colour ride on per-mesh vertex
// attributes and one shared clock uniform drives the animation (the telegraph decals' trick,
// world/npcs/telegraphs.ts), so nothing is created or compiled when a spell is cast. Every mesh
// is pooled and made up front; the hidden pool is in the scene, so the loading-screen warm-up
// compiles each pipeline (warmup() shows hidden meshes) and the first cast doesn't stall a frame.
// Plain TSL on MeshBasicNodeMaterial: the same graph builds for WebGPU and the WebGL2 fallback.

import * as THREE from "three/webgpu";
import {
  abs, attribute, clamp, cos, dot, exp, float, floor, fract, max, min, mix, normalLocal, normalView, positionViewDirection, pow, sin,
  smoothstep, step, uniform, uv, vec3,
} from "three/tsl";
import type { Terrain } from "@firstlight/shared";
import { releaseObjects } from "./dispose.ts";

export const SPELL_COLORS = {
  skipstep: 0x7fe9ff,
  skipstepCore: 0xf2fdff,
  frost: 0x9fdcff,
  frostDeep: 0x4aa8ff,
  star: 0xffb648,
  starCore: 0xfff6dc,
  ember: 0xff9a3c,
  ward: 0x9fd0ff,
  wardEdge: 0xcbb6ff,
} as const;

const DECAL_LIFT = 0.16;
const DECAL_RINGS = 7;
const DECAL_SEGS = 40;
const SHARDS_PER_BLOOM = 14;
const POOL = { decals: 8, beams: 6, tails: 4, glows: 12, shards: SHARDS_PER_BLOOM * 2, wards: 4 };

/** Wishfall's star: where it comes from, how it falls and what it leaves. */
const STAR = {
  /** It starts this high over the ground point and this far to one side (about 18° off straight down). */
  heightM: 55,
  leanM: 18,
  /** Position along the fall = (time share)^ease: it gathers speed, and is low enough to see for the last third. */
  ease: 1.4,
  /** The tail's length (m) when it lands; it starts at under half of that. */
  tailM: 26,
  /** The landing's shockwave runs out to this many blast radii over `landMs`. */
  shockRadii: 1.5,
  landMs: 1300,
  /** The scorch mark's radius (of the blast's) and how long it stays; embers lift off it for `emberS`. */
  scorchRadii: 0.95,
  scorchMs: 7000,
  emberS: 3.2,
} as const;

const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _q = new THREE.Quaternion();

/** The five shared materials and their clock (seconds since the system was made). */
function makeMaterials() {
  const clock = uniform(0);
  const fx = attribute("aFx", "vec4"); // start s, end s, style (or the ward's last hit time), seed
  const col = attribute("aCol", "vec3");
  const prog = clamp(clock.sub(fx.x).div(max(fx.y.sub(fx.x), 0.001)), 0, 1);
  const age = max(clock.sub(fx.x), 0);
  const is0 = float(1).sub(step(0.5, fx.z));
  const is1 = step(0.5, fx.z).mul(float(1).sub(step(1.5, fx.z)));
  const is2 = step(1.5, fx.z);
  // How squarely a surface faces the camera (1 = head on, 0 = at the silhouette).
  const facing = abs(dot(normalView, positionViewDirection));

  // ---- ground decals: u.x = radius 0…1, u.y = angle 0…1 --------------------------------------
  const decal = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  decal.name = "spellDecal";
  decal.polygonOffset = true;
  decal.polygonOffsetFactor = -2;
  decal.polygonOffsetUnits = -4;
  {
    const u = uv();
    const r = u.x;
    const ang = u.y.mul(Math.PI * 2);
    const rim = smoothstep(0.8, 0.92, r).mul(float(1).sub(smoothstep(0.985, 1.0, r)));
    const span = max(fx.y.sub(fx.x), 0.001);
    const d2 = is2.mul(float(1).sub(step(2.5, fx.z)));
    const d3 = step(2.5, fx.z);
    // 0: Wishfall's warning. The rim beats and rings sweep in from it to the centre, slowly at first
    // and faster as the star nears (2 beats a second rising to 9: the phase is the integral of that,
    // so it never jumps). One ring closes on the centre over the whole warning, eight spokes turn,
    // and the middle heats up at the end.
    const beat = age.mul(float(2).add(age.div(span).mul(3.5)));
    const pulse = pow(sin(beat.mul(Math.PI * 2)).mul(0.5).add(0.5), 2);
    const sweep = smoothstep(0.08, 0.0, abs(r.sub(float(1).sub(fract(beat))))).mul(float(0.35).add(prog.mul(0.65)));
    const closing = smoothstep(0.07, 0.0, abs(r.sub(float(1).sub(prog))));
    const spokes = pow(abs(cos(ang.mul(4).add(clock.mul(1.4)))), 14).mul(smoothstep(0.18, 0.3, r)).mul(float(1).sub(smoothstep(0.7, 0.84, r)));
    const heat = float(1).sub(smoothstep(0.0, float(0.3).add(prog.mul(0.25)), r)).mul(pow(prog, 2));
    const warn = float(0.14).add(prog.mul(0.2))
      .add(rim.mul(float(0.7).add(pulse.mul(0.6))))
      .add(sweep.mul(0.75))
      .add(closing.mul(0.85))
      .add(spokes.mul(0.45))
      .add(heat.mul(0.9))
      .mul(smoothstep(0.0, 0.08, age));
    // 1: Frostbloom. A front races out to the edge, leaving crystal veins that hold, then melt.
    const out = float(1).sub(pow(float(1).sub(clamp(age.div(0.32), 0, 1)), 3));
    const front = smoothstep(0.14, 0.0, abs(r.sub(out))).mul(float(1).sub(clamp(age.div(0.5), 0, 1)));
    const veins = abs(sin(ang.mul(7).add(sin(r.mul(9).add(fx.w)).mul(1.6)))).mul(abs(sin(r.mul(13).add(fx.w.mul(3)).add(ang.mul(3)))));
    const crystal = smoothstep(0.5, 0.92, veins);
    const melt = float(1).sub(smoothstep(0.62, 1.0, prog));
    const frost = front.mul(1.2).add(float(0.2).add(crystal.mul(0.6)).add(rim.mul(0.6)).mul(melt).mul(step(r, out)));
    // 2: Wishfall's landing. A white-hot flash on the ground, gone in a third of the time; a
    // shockwave that runs out to the edge with a fainter ring behind it; a glow that dies down.
    const wave = pow(prog, 0.45);
    const shock = smoothstep(0.16, 0.0, abs(r.sub(wave))).mul(pow(float(1).sub(prog), 1.2)).mul(1.9);
    const wake = smoothstep(0.1, 0.0, abs(r.sub(wave.mul(0.72)))).mul(pow(float(1).sub(prog), 2)).mul(0.8);
    const flash = float(1).sub(smoothstep(0.0, 0.85, r)).mul(pow(float(1).sub(clamp(prog.mul(3.2), 0, 1)), 2)).mul(1.4);
    const afterglow = float(1).sub(smoothstep(0.0, 0.6, r)).mul(pow(float(1).sub(prog), 1.5)).mul(0.7);
    const land = shock.add(wake).add(flash).add(afterglow);
    // 3: the scorch a star leaves. A charred patch with a ragged edge; the cracks in it glow like
    // embers and cool in the first half; the whole mark fades in the last third.
    const ragged = sin(ang.mul(5).add(fx.w)).mul(0.06).add(sin(ang.mul(11).add(fx.w.mul(2.3))).mul(0.04));
    const char = float(1).sub(smoothstep(float(0.5).add(ragged), float(0.92).add(ragged), r));
    const cooling = pow(float(1).sub(clamp(prog.mul(2.2), 0, 1)), 2);
    const cracks = smoothstep(0.55, 0.95, veins).mul(float(1).sub(smoothstep(0.15, 0.9, r))).mul(cooling);
    const twinkle = sin(clock.mul(9).add(r.mul(40)).add(ang.mul(13))).mul(0.25).add(0.75);
    const scorch = char.mul(0.62).add(cracks.mul(0.5)).mul(float(1).sub(smoothstep(0.65, 1.0, prog))).mul(smoothstep(0.0, 0.03, prog));
    const scorchColour = mix(vec3(0.03, 0.022, 0.018), col.mul(3.2).mul(twinkle), clamp(cracks.mul(1.4), 0, 1));
    decal.colorNode = mix(col.mul(float(2.4).add(rim.mul(1.2)).add(heat.mul(is0).mul(2)).add(flash.mul(d2).mul(1.5))), scorchColour, d3);
    decal.opacityNode = clamp(warn.mul(is0).add(frost.mul(is1)).add(land.mul(d2)).add(scorch.mul(d3)), 0, 1);
  }

  // ---- beams: an open tube along +Z, u.y = 0 at its start, 1 at its end ------------------------
  const beam = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false });
  beam.name = "spellBeam";
  {
    const u = uv();
    const along = u.y;
    const around = u.x.mul(Math.PI * 2);
    const soft = pow(facing, 1.6);
    // 0: Skipstep's trail. A twist of light that streams toward the far end and thins out.
    const ends = smoothstep(0.0, 0.1, along).mul(smoothstep(1.0, 0.8, along));
    const twist = sin(around.mul(2).add(along.mul(22)).sub(clock.mul(26))).mul(0.35).add(0.65);
    const chase = smoothstep(prog.mul(1.3).sub(0.55), prog.mul(1.3), along).mul(0.6).add(0.4);
    const trail = ends.mul(twist).mul(chase).mul(pow(float(1).sub(prog), 1.4));
    // 1: Wishfall's streak, drawn on a cone that is wide at the star and a point far behind it.
    // Hot at the head with a long cooling tail and filaments that stream back along it. A cone seen
    // end-on (from under the star) keeps a floor of light, so the fall reads from any angle.
    const flicker = sin(clock.mul(47).add(along.mul(31))).mul(0.12).add(0.88);
    const filaments = sin(around.mul(3).add(along.mul(9)).sub(clock.mul(30))).mul(0.2).add(0.8);
    const streak = pow(along, 1.7).mul(flicker).mul(filaments).mul(smoothstep(0.0, 0.06, prog));
    const allRound = mix(float(0.4), float(1), pow(facing, 1.3));
    // 2: Wishfall's path: a thin line of light from the ground point up the way the star comes,
    // faint at first and brighter as it nears, with light running down it. It is what a frame shows
    // while the star itself is still above the view.
    const running = sin(along.mul(46).add(clock.mul(22))).mul(0.3).add(0.7);
    const path = pow(float(1).sub(along), 1.3).mul(running).mul(float(0.16).add(pow(prog, 2).mul(0.6))).mul(smoothstep(0.0, 0.1, prog));
    beam.colorNode = col.mul(5);
    beam.opacityNode = clamp(trail.mul(is0).mul(soft).add(streak.mul(is1).add(path.mul(is2)).mul(allRound)), 0, 1);
  }

  // ---- glows: a ball of light, bright in the middle and gone at the rim -------------------------
  const glow = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  glow.name = "spellGlow";
  {
    // 0: a flash that dies away. 1: a steady, flickering light (the star's head).
    const flash = pow(float(1).sub(prog), 2);
    const steady = sin(clock.mul(41).add(fx.w)).mul(0.14).add(0.86).mul(smoothstep(0.0, 0.1, prog)).mul(float(1).sub(smoothstep(0.92, 1.0, prog)));
    glow.colorNode = col.mul(5);
    glow.opacityNode = pow(facing, 2.2).mul(flash.mul(is0).add(steady.mul(is1.add(is2))));
  }

  // ---- ice shards: four-sided crystals, bright at their edges, glinting facet by facet ----------
  const shard = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  shard.name = "spellShard";
  {
    const rimLight = pow(float(1).sub(facing), 2);
    const facet = fract(sin(dot(normalLocal, vec3(12.9898, 78.233, 37.719)).add(fx.w)).mul(43758.5453));
    const glint = step(0.86, fract(facet.add(floor(clock.mul(7)).mul(0.37))));
    const tip = uv().y;
    shard.colorNode = mix(col, vec3(1, 1, 1), clamp(rimLight.add(tip.mul(0.5)).add(glint.mul(0.6)), 0, 1)).mul(float(1.5).add(glint.mul(2.2)));
    shard.opacityNode = float(0.5).add(rimLight.mul(0.45)).mul(float(1).sub(smoothstep(0.72, 1.0, prog)));
  }

  // ---- the ward: a faceted shell. fx.z = when it last took a hit (clock seconds) -----------------
  const ward = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false });
  ward.name = "spellWard";
  {
    const bary = attribute("aBary", "vec3");
    const edge = float(1).sub(smoothstep(0.0, 0.055, min(bary.x, min(bary.y, bary.z))));
    const facet = fract(sin(dot(normalLocal, vec3(127.1, 311.7, 74.7))).mul(43758.5453));
    const shimmer = pow(max(sin(clock.mul(2.6).add(facet.mul(6.283)).add(fx.w)), 0), 8);
    const rimLight = pow(float(1).sub(facing), 2.4);
    const sinceHit = clock.sub(fx.z);
    const struck = exp(max(sinceHit, 0).mul(-6)).mul(step(0, sinceHit));
    const appear = smoothstep(0.0, 0.22, age);
    const vanish = float(1).sub(smoothstep(0.9, 1.0, prog));
    ward.colorNode = mix(col, vec3(1, 1, 1), clamp(shimmer.mul(0.55).add(struck.mul(0.8)), 0, 1)).mul(float(2).add(struck.mul(2)));
    ward.opacityNode = clamp(float(0.05).add(rimLight.mul(0.5)).add(edge.mul(0.5)).add(shimmer.mul(0.3)).add(struck.mul(0.55)), 0, 1).mul(appear).mul(vanish);
  }

  return { clock, decal, beam, glow, shard, ward };
}

let shared: ReturnType<typeof makeMaterials> | null = null;
/** One set for the session: a new body's effects reuse the node builds the first one compiled. */
function sharedMaterials() {
  return (shared ??= makeMaterials());
}

/** A geometry's per-mesh attributes: `aFx` and `aCol`, the same on every vertex. */
function withFx(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = geo.getAttribute("position").count;
  geo.setAttribute("aFx", new THREE.BufferAttribute(new Float32Array(n * 4), 4));
  geo.setAttribute("aCol", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  return geo;
}

function discGeometry(): THREE.BufferGeometry {
  const n = (DECAL_RINGS + 1) * (DECAL_SEGS + 1);
  const uvs = new Float32Array(n * 2);
  const idx: number[] = [];
  for (let j = 0; j <= DECAL_RINGS; j++) {
    for (let i = 0; i <= DECAL_SEGS; i++) {
      const v = j * (DECAL_SEGS + 1) + i;
      uvs[v * 2] = j / DECAL_RINGS;
      uvs[v * 2 + 1] = i / DECAL_SEGS;
      if (j < DECAL_RINGS && i < DECAL_SEGS) idx.push(v, v + DECAL_SEGS + 1, v + 1, v + 1, v + DECAL_SEGS + 1, v + DECAL_SEGS + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(n * 3).fill(0), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return withFx(g);
}

function beamGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(1, 1, 1, 14, 1, true);
  g.translate(0, 0.5, 0);
  g.rotateX(Math.PI / 2); // along +Z, uv.y from 0 (start) to 1 (end)
  return withFx(g);
}

/** The star's tail: a cone along +Z, a point at its start (uv.y = 0) and one unit wide at its end, the star. */
function tailGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(1, 0.03, 1, 14, 4, true);
  g.translate(0, 0.5, 0);
  g.rotateX(Math.PI / 2);
  return withFx(g);
}

function shardGeometry(): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(1, 1, 4, 1, true).toNonIndexed();
  g.translate(0, 0.5, 0); // base on the ground, tip up
  g.computeVertexNormals(); // flat facets
  return withFx(g);
}

function wardGeometry(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const flat = g.index ? g.toNonIndexed() : g;
  flat.computeVertexNormals(); // one normal per facet
  const n = flat.getAttribute("position").count;
  const bary = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) bary[i * 3 + (i % 3)] = 1;
  flat.setAttribute("aBary", new THREE.BufferAttribute(bary, 3));
  return withFx(flat);
}

interface Slot {
  mesh: THREE.Mesh;
  /** Clock time (s) this slot is busy until; 0 = free. */
  until: number;
  update: ((t: number, dt: number) => void) | null;
  key: string | number | null;
}

function setFx(mesh: THREE.Mesh, start: number, end: number, style: number, seed: number, color: number) {
  const fx = mesh.geometry.getAttribute("aFx") as THREE.BufferAttribute;
  const col = mesh.geometry.getAttribute("aCol") as THREE.BufferAttribute;
  const c = new THREE.Color(color);
  const a = fx.array as Float32Array, b = col.array as Float32Array;
  for (let i = 0; i < fx.count; i++) {
    a[i * 4] = start; a[i * 4 + 1] = end; a[i * 4 + 2] = style; a[i * 4 + 3] = seed;
    b[i * 3] = c.r; b[i * 3 + 1] = c.g; b[i * 3 + 2] = c.b;
  }
  fx.needsUpdate = true;
  col.needsUpdate = true;
}

/** The sparks a falling star sheds (one shared object: the fall asks for them ~30 times a second). */
const STAR_SPARKS: NonNullable<Parameters<Burst>[3]> = { speed: [0.3, 1.8], life: [0.4, 0.9], size: [0.07, 0.18], intensity: 7, lift: -1 };
/** The embers that lift off the scorch for a few seconds after the landing: slow, long-lived, drifting up. */
const STAR_EMBERS: NonNullable<Parameters<Burst>[3]> = { speed: [0.15, 0.9], life: [1.6, 3.2], size: [0.05, 0.12], intensity: 5, lift: 0.7, spread: 0.6 };

export type Burst = (at: THREE.Vector3, color: number, count: number, opts?: { speed?: [number, number]; life?: [number, number]; size?: [number, number]; intensity?: number; lift?: number; spread?: number }) => void;

export class SpellFx {
  readonly group = new THREE.Group();
  private readonly mats = sharedMaterials();
  private readonly decals: Slot[] = [];
  private readonly beams: Slot[] = [];
  /** Wishfall's tails: the beam material on a cone. */
  private readonly tails: Slot[] = [];
  private readonly glows: Slot[] = [];
  private readonly shards: Slot[] = [];
  private readonly wards: Slot[] = [];
  /** Every pool, for the per-frame walk (made once: `update` allocates nothing). */
  private readonly pools: readonly Slot[][] = [this.decals, this.beams, this.tails, this.glows, this.shards, this.wards];
  private t = 0;
  private seed = 1;

  constructor(scene: THREE.Scene, private terrain: () => Terrain, private readonly burst: Burst) {
    this.group.name = "spellFx";
    const fill = (list: Slot[], n: number, geo: () => THREE.BufferGeometry, mat: THREE.Material, name: string, order = 6) => {
      for (let i = 0; i < n; i++) {
        const mesh = new THREE.Mesh(geo(), mat);
        mesh.name = `${name}${i}`;
        mesh.visible = false;
        mesh.frustumCulled = false;
        mesh.renderOrder = order;
        this.group.add(mesh);
        list.push({ mesh, until: 0, update: null, key: null });
      }
    };
    const glowGeo = new THREE.SphereGeometry(1, 20, 14);
    fill(this.decals, POOL.decals, discGeometry, this.mats.decal, "spellDecal", 4);
    fill(this.beams, POOL.beams, beamGeometry, this.mats.beam, "spellBeam");
    fill(this.tails, POOL.tails, tailGeometry, this.mats.beam, "spellTail");
    fill(this.glows, POOL.glows, () => withFx(glowGeo.clone()), this.mats.glow, "spellGlow");
    fill(this.shards, POOL.shards, shardGeometry, this.mats.shard, "spellShard", 5);
    fill(this.wards, POOL.wards, wardGeometry, this.mats.ward, "spellWard", 7);
    glowGeo.dispose();
    scene.add(this.group);
  }

  /** One mesh of each look (tests: shader generation; the pool itself is what the warm-up compiles). */
  get samples(): THREE.Mesh[] {
    return [this.decals[0]!.mesh, this.beams[0]!.mesh, this.glows[0]!.mesh, this.shards[0]!.mesh, this.wards[0]!.mesh];
  }

  /** Effects showing right now (tests, the perf overlay). */
  get live(): number {
    let n = 0;
    for (let i = 0; i < this.pools.length; i++) {
      const l = this.pools[i]!;
      for (let j = 0; j < l.length; j++) if (l[j]!.until > 0) n++;
    }
    return n;
  }

  private take(list: Slot[], ms: number, key: string | number | null = null): Slot {
    // A free slot, or the one that ends soonest.
    let best = list[0]!;
    for (const s of list) {
      if (s.until === 0) {
        best = s;
        break;
      }
      if (s.until < best.until) best = s;
    }
    best.until = this.t + ms / 1000;
    best.update = null;
    best.key = key;
    best.mesh.visible = true;
    best.mesh.scale.setScalar(1);
    best.mesh.quaternion.identity();
    return best;
  }

  private free(s: Slot) {
    s.until = 0;
    s.update = null;
    s.key = null;
    s.mesh.visible = false;
  }

  private nextSeed(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return (this.seed % 1000) / 159;
  }

  // ---------------------------------------------------------------------------------- pieces

  /** A ground disc of `radius` m, moulded to the terrain round `centre`. */
  private decal(centre: THREE.Vector3, radius: number, ms: number, style: number, color: number, key: string | number | null = null): Slot {
    const s = this.take(this.decals, ms, key);
    const terrain = this.terrain();
    const R = terrain.body.radius, water = terrain.body.waterLevel;
    const up = _a.copy(centre).normalize();
    const ref = Math.abs(up.y) < 0.9 ? Y : Z;
    const f = _b.crossVectors(up, ref).normalize();
    const side = _c.crossVectors(up, f);
    const pos = s.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const p = pos.array as Float32Array;
    for (let j = 0; j <= DECAL_RINGS; j++) {
      const r = (radius * j) / DECAL_RINGS;
      for (let i = 0; i <= DECAL_SEGS; i++) {
        const th = (i / DECAL_SEGS) * Math.PI * 2;
        const cx = Math.cos(th) * r, sx = Math.sin(th) * r;
        let x = centre.x + f.x * cx + side.x * sx, y = centre.y + f.y * cx + side.y * sx, z = centre.z + f.z * cx + side.z * sx;
        const l = Math.hypot(x, y, z);
        x /= l; y /= l; z /= l;
        const h = R + Math.max(terrain.groundHeight(x, y, z), water) + DECAL_LIFT;
        const o = (j * (DECAL_SEGS + 1) + i) * 3;
        p[o] = x * h; p[o + 1] = y * h; p[o + 2] = z * h;
      }
    }
    pos.needsUpdate = true;
    s.mesh.position.set(0, 0, 0);
    setFx(s.mesh, this.t, this.t + ms / 1000, style, this.nextSeed(), color);
    return s;
  }

  private glowAt(at: THREE.Vector3, size: number, ms: number, color: number, style = 0, grow = 1.6): Slot {
    const s = this.take(this.glows, ms);
    s.mesh.position.copy(at);
    s.mesh.scale.setScalar(size);
    const born = this.t, life = ms / 1000;
    setFx(s.mesh, born, born + life, style, this.nextSeed(), color);
    if (style === 0) s.update = (t) => void s.mesh.scale.setScalar(size * (1 + (grow - 1) * Math.min(1, (t - born) / life)));
    return s;
  }

  private beamBetween(from: THREE.Vector3, to: THREE.Vector3, width: number, ms: number, style: number, color: number, key: string | number | null = null): Slot {
    const s = this.take(this.beams, ms, key);
    s.mesh.position.copy(from);
    s.mesh.quaternion.setFromUnitVectors(Z, _a.copy(to).sub(from).normalize());
    s.mesh.scale.set(width, width, Math.max(0.01, from.distanceTo(to)));
    setFx(s.mesh, this.t, this.t + ms / 1000, style, this.nextSeed(), color);
    return s;
  }

  // ---------------------------------------------------------------------------------- spells

  /** Skipstep: a streaming trail from where they were, a pop of light at both ends, motes along the way. */
  blink(from: THREE.Vector3, to: THREE.Vector3) {
    const up = from.clone().normalize();
    const a = from.clone().addScaledVector(up, 1.0), b = to.clone().addScaledVector(to.clone().normalize(), 1.0);
    this.beamBetween(a, b, 0.42, 420, 0, SPELL_COLORS.skipstep);
    this.beamBetween(a, b, 0.16, 300, 0, SPELL_COLORS.skipstepCore);
    this.glowAt(a, 0.9, 260, SPELL_COLORS.skipstep, 0, 0.3); // folds in where they left
    this.glowAt(b, 0.38, 360, SPELL_COLORS.skipstepCore, 0, 2.6); // opens where they land
    this.burst(a, SPELL_COLORS.skipstep, 14, { speed: [0.4, 1.8], life: [0.3, 0.7], size: [0.03, 0.08], intensity: 5, lift: 0.4 });
    this.burst(b, SPELL_COLORS.skipstepCore, 22, { speed: [1.2, 4], life: [0.3, 0.8], size: [0.03, 0.09], intensity: 6, lift: 0.6 });
    const steps = 6;
    for (let i = 1; i < steps; i++) this.burst(_a.copy(a).lerp(b, i / steps), SPELL_COLORS.skipstep, 3, { speed: [0.1, 0.6], life: [0.25, 0.6], size: [0.02, 0.05], intensity: 5, lift: 0.2 });
  }

  /** Frostbloom: the frost ring on the ground, a burst of cold light, shards standing up round the edge. */
  frost(centre: THREE.Vector3, radius: number, ms: number) {
    const up = centre.clone().normalize();
    this.decal(centre, radius, Math.max(ms, 1200), 1, SPELL_COLORS.frost);
    this.glowAt(centre.clone().addScaledVector(up, 0.8), 1.2, 420, SPELL_COLORS.frost, 0, radius * 0.9);
    this.burst(centre.clone().addScaledVector(up, 0.6), SPELL_COLORS.frost, 60, { speed: [3, radius * 2.2], life: [0.35, 0.9], size: [0.03, 0.1], intensity: 5, lift: -0.6, spread: 1 });
    const terrain = this.terrain();
    const R = terrain.body.radius;
    const ref = Math.abs(up.y) < 0.9 ? Y : Z;
    const f = new THREE.Vector3().crossVectors(up, ref).normalize();
    const side = new THREE.Vector3().crossVectors(up, f);
    const life = Math.max(ms, 1200) / 1000;
    const turn = this.nextSeed();
    for (let i = 0; i < SHARDS_PER_BLOOM; i++) {
      const s = this.take(this.shards, life * 1000);
      const th = turn + (i / SHARDS_PER_BLOOM) * Math.PI * 2 + (this.nextSeed() - 3) * 0.05;
      const r = radius * (0.72 + 0.26 * ((i * 7) % 5) / 4);
      const p = s.mesh.position.copy(centre).addScaledVector(f, Math.cos(th) * r).addScaledVector(side, Math.sin(th) * r);
      const l = p.length();
      p.multiplyScalar((R + terrain.groundHeight(p.x / l, p.y / l, p.z / l) - 0.05) / l);
      // Leaning outward from the centre, each its own size.
      const out = _a.copy(p).sub(centre).normalize();
      const lean = _b.copy(p).normalize().addScaledVector(out, 0.35 + 0.25 * ((i * 3) % 4) / 3).normalize();
      s.mesh.quaternion.setFromUnitVectors(Y, lean).multiply(_q.setFromAxisAngle(Y, th * 3));
      const h = 0.9 + 1.2 * ((i * 5) % 7) / 6, w = 0.2 + 0.14 * ((i * 3) % 5) / 4;
      const born = this.t + (r / radius) * 0.22 + i * 0.006; // the front reaches them on its way out
      setFx(s.mesh, born, born + life, 0, this.nextSeed(), i % 3 === 0 ? SPELL_COLORS.frostDeep : SPELL_COLORS.frost);
      s.mesh.scale.set(w, 0.001, w);
      s.update = (t) => {
        const k = Math.max(0, Math.min(1, (t - born) / 0.16));
        const e = 1 - (1 - k) * (1 - k);
        const sink = Math.max(0, (t - born - life * 0.75) / (life * 0.25));
        s.mesh.scale.set(w, Math.max(0.001, h * (e * (1 + 0.18 * Math.sin(k * Math.PI)) - sink * 0.6)), w);
      };
    }
  }

  /** A drift of frost on something slowed (called now and then while the slow lasts). */
  chill(at: THREE.Vector3) {
    this.burst(at, SPELL_COLORS.frost, 3, { speed: [0.1, 0.5], life: [0.4, 0.9], size: [0.02, 0.05], intensity: 4, lift: -0.5, spread: 1 });
  }

  /**
   * Wishfall, cast: the warning ring, the line of light the star will come down, and the star
   * itself: a hot head in a corona with a tapering tail, from high above at a slight angle, landing
   * when the ring closes.
   */
  starFall(id: number, at: THREE.Vector3, radius: number, ms: number) {
    this.decal(at, radius, ms + 80, 0, SPELL_COLORS.star, id);
    const up = at.clone().normalize();
    const ref = Math.abs(up.y) < 0.9 ? Y : Z;
    // Which side it leans in from depends on the star, so two in a row differ and everyone watching sees the same.
    const lean = new THREE.Vector3().crossVectors(up, ref).normalize().applyAxisAngle(up, id * 2.399963);
    const from = at.clone().addScaledVector(up, STAR.heightM).addScaledVector(lean, STAR.leanM);
    const dir = at.clone().sub(from).normalize();
    const life = ms / 1000, born = this.t;
    this.beamBetween(at, from, 0.22, ms, 2, SPELL_COLORS.star, id);
    const tail = this.take(this.tails, ms, id);
    const core = this.take(this.tails, ms, id);
    setFx(tail.mesh, born, born + life, 1, this.nextSeed(), SPELL_COLORS.star);
    setFx(core.mesh, born, born + life, 1, this.nextSeed(), SPELL_COLORS.starCore);
    const head = this.take(this.glows, ms, id);
    const corona = this.take(this.glows, ms, id);
    setFx(head.mesh, born, born + life, 1, this.nextSeed(), SPELL_COLORS.starCore);
    setFx(corona.mesh, born, born + life, 1, this.nextSeed(), SPELL_COLORS.star);
    const quat = new THREE.Quaternion().setFromUnitVectors(Z, dir);
    tail.mesh.quaternion.copy(quat);
    core.mesh.quaternion.copy(quat);
    const pos = new THREE.Vector3();
    let nextSpark = 0;
    const place = (t: number) => {
      const k = Math.min(1, Math.max(0, (t - born) / life));
      pos.copy(from).lerp(at, Math.pow(k, STAR.ease));
      head.mesh.position.copy(pos);
      head.mesh.scale.setScalar(1.1 + 0.7 * k);
      corona.mesh.position.copy(pos);
      corona.mesh.scale.setScalar(2.6 + 1.6 * k);
      // The tail's wide end is the star; it lengthens as the star gathers speed.
      const len = STAR.tailM * (0.45 + 0.55 * k);
      tail.mesh.position.copy(pos).addScaledVector(dir, -len);
      tail.mesh.scale.set(1.15, 1.15, len);
      core.mesh.position.copy(tail.mesh.position);
      core.mesh.scale.set(0.42, 0.42, len);
      if (t >= nextSpark) {
        nextSpark = t + 0.03;
        this.burst(pos, SPELL_COLORS.ember, 3, STAR_SPARKS);
      }
    };
    place(born);
    tail.update = place;
  }

  /**
   * Wishfall, landed: the ring and the star go; a flash on the ground and in the air, a shockwave
   * running out past the blast, a pillar of light, a spray of embers, then a scorch mark that
   * smoulders (embers lift off it for a few seconds) and fades.
   */
  starImpact(id: number, at: THREE.Vector3, radius: number) {
    for (const list of [this.decals, this.beams, this.tails, this.glows]) for (const s of list) if (s.key === id && s.until > 0) this.free(s);
    const up = at.clone().normalize();
    const c = at.clone().addScaledVector(up, 0.5);
    this.decal(at, radius * STAR.shockRadii, STAR.landMs, 2, SPELL_COLORS.star);
    this.glowAt(c, radius * 0.75, 220, SPELL_COLORS.starCore, 0, 2.2); // the flash
    this.glowAt(c, radius * 0.5, 650, SPELL_COLORS.starCore, 0, 3);
    this.glowAt(c, radius * 0.35, 1100, SPELL_COLORS.ember, 0, 4.2);
    this.beamBetween(at, at.clone().addScaledVector(up, radius * 3), 0.9, 520, 0, SPELL_COLORS.starCore); // a pillar of light
    this.burst(c, SPELL_COLORS.ember, 90, { speed: [4, 14], life: [0.6, 1.5], size: [0.07, 0.2], intensity: 7, lift: -7, spread: 0.85 });
    this.burst(c, SPELL_COLORS.starCore, 50, { speed: [1, 7], life: [0.4, 1.0], size: [0.05, 0.14], intensity: 8, lift: 1.5 });
    // The scorch, and the embers that keep lifting off it.
    const scorchR = radius * STAR.scorchRadii;
    const scorch = this.decal(at, scorchR, STAR.scorchMs, 3, SPELL_COLORS.ember);
    const ref = Math.abs(up.y) < 0.9 ? Y : Z;
    const f = new THREE.Vector3().crossVectors(up, ref).normalize();
    const side = new THREE.Vector3().crossVectors(up, f);
    const centre = at.clone().addScaledVector(up, 0.2);
    const born = this.t;
    let next = born + 0.12;
    scorch.update = (t) => {
      if (t < next || t > born + STAR.emberS) return;
      next = t + 0.2;
      const th = this.nextSeed(), rr = scorchR * 0.8 * Math.sqrt(this.nextSeed() / 6.29);
      this.burst(_a.copy(centre).addScaledVector(f, Math.cos(th) * rr).addScaledVector(side, Math.sin(th) * rr), SPELL_COLORS.ember, 2, STAR_EMBERS);
    };
  }

  /**
   * Glasswing Ward: a shell that follows `where()` (feet; null = gone) for `ms`. `quiet`: it was
   * already up when we arrived, so it is simply there (no burst of light at its start).
   */
  ward(key: string, where: () => THREE.Vector3 | null, ms: number, quiet = false) {
    this.wardEnd(key, false, true);
    const s = this.take(this.wards, ms, key);
    const born = this.t;
    setFx(s.mesh, born, born + ms / 1000, -1e6, this.nextSeed(), SPELL_COLORS.ward);
    let spin = 0;
    const follow = (_t: number, dt: number) => {
      const p = where();
      if (!p) return void this.free(s);
      const up = _a.copy(p).normalize();
      s.mesh.position.copy(p).addScaledVector(up, 0.95);
      spin += dt * 0.35;
      s.mesh.quaternion.setFromUnitVectors(Y, up).multiply(_q.setFromAxisAngle(Y, spin));
      s.mesh.scale.set(1.1, 1.35, 1.1);
    };
    follow(born, 0);
    s.update = follow;
    const p = quiet ? null : where();
    if (p) this.burst(p.clone().addScaledVector(p.clone().normalize(), 1), SPELL_COLORS.wardEdge, 26, { speed: [0.6, 2.4], life: [0.3, 0.8], size: [0.02, 0.07], intensity: 5, lift: 1.2 });
  }

  /** The ward took a hit: it lights up. */
  wardHit(key: string) {
    const s = this.wards.find((w) => w.key === key && w.until > 0);
    if (!s) return;
    const fx = s.mesh.geometry.getAttribute("aFx") as THREE.BufferAttribute;
    const a = fx.array as Float32Array;
    for (let i = 0; i < fx.count; i++) a[i * 4 + 2] = this.t;
    fx.needsUpdate = true;
    this.burst(s.mesh.position, SPELL_COLORS.ward, 8, { speed: [1, 3], life: [0.2, 0.5], size: [0.02, 0.06], intensity: 6, lift: 0 });
  }

  /** The ward is gone; a broken one bursts into splinters of light. */
  wardEnd(key: string, broke: boolean, quiet = false) {
    const s = this.wards.find((w) => w.key === key && w.until > 0);
    if (!s) return;
    const at = s.mesh.position.clone();
    this.free(s);
    if (quiet) return;
    if (broke) {
      this.glowAt(at, 1.2, 320, SPELL_COLORS.wardEdge, 0, 2.2);
      this.burst(at, SPELL_COLORS.ward, 46, { speed: [2, 7], life: [0.3, 0.9], size: [0.03, 0.09], intensity: 6, lift: -3 });
    } else this.burst(at, SPELL_COLORS.ward, 12, { speed: [0.3, 1.2], life: [0.4, 0.9], size: [0.02, 0.05], intensity: 4, lift: 0.8 });
  }

  /** `dt` seconds of animation. */
  update(dt: number) {
    this.t += dt;
    this.mats.clock.value = this.t;
    // Indexed loops over the pools made in the constructor: no arrays or iterators per frame (review 6).
    for (let i = 0; i < this.pools.length; i++) {
      const list = this.pools[i]!;
      for (let j = 0; j < list.length; j++) {
        const s = list[j]!;
        if (s.until === 0) continue;
        if (this.t >= s.until) this.free(s);
        else s.update?.(this.t, dt);
      }
    }
  }

  dispose() {
    this.group.removeFromParent();
    releaseObjects(this.group);
    for (const list of this.pools) for (const s of list) s.mesh.geometry.dispose();
    // The materials are the session's (sharedMaterials): kept.
  }
}
