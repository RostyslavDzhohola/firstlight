// Sky life (D-gfx-hub-4): the sky's other worlds have traffic. Thin light trails arc between the sky
// planets and down towards our horizon, each carrying a few "ships" (a bright head and a fading
// tail); now and then a shooting star crosses the night; on High and up a soft aurora hangs low in
// the night sky. Two draws in all (trails + shooting stars in one mesh, the aurora in another),
// additive, no textures, nothing in the atmosphere code.
//
// Everything is built once per body in the local sky frame (x east, y up, z north on a unit sphere:
// sunFrame.ts), where the sky planets stand still; a frame writes one matrix per mesh (that frame at
// the camera, out at the sky planets' distance). The motion is the shader's, on the shared clock.

import * as THREE from "three/webgpu";
import { abs, attribute, exp, float, fract, max, mix, normalize, positionLocal, sin, smoothstep, step, time, uniform, uv } from "three/tsl";
import type { BodyId } from "@firstlight/shared";
import { atmo } from "./atmosphere.ts";
import { SKY_PLANET_PALETTES, type SkyPlanetSpec } from "./looks.ts";
import type { ResolvedSettings } from "./quality.ts";
import { localFrame, type V3 } from "./sunFrame.ts";

/** The sky planets' distance (skyPlanets.ts DIST), a little nearer so the trails draw over the haze shells. */
const DIST = 3900;
/** A trail's half-width on the unit sphere (radians): about a pixel and a half at 720p. */
export const TRAIL_HALF = 0.0019;
const SEGMENTS = 40;
export const SHOOTING_STARS = 7;
const KIND = { lane: 0, star: 1 } as const;

/** Unit direction for (elevation, azimuth) degrees in the local sky frame (x east, y up, z north). */
export function frameDir(elevDeg: number, azDeg: number): V3 {
  const e = (elevDeg * Math.PI) / 180, a = (azDeg * Math.PI) / 180;
  return [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)];
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export interface SkyLane {
  from: V3;
  to: V3;
  /** How far the middle of the arc lifts towards the zenith (0 = a great circle). */
  lift: number;
  color: number;
  seed: number;
  /** Fractions of the arc hidden at each end (inside a planet's disc). */
  trim: [number, number];
}

/** A point of a lane at `s` (0 … 1): the great circle from → to, lifted towards the zenith mid-way. */
export function lanePoint(l: SkyLane, s: number): V3 {
  const w = Math.acos(Math.min(1, Math.max(-1, dot(l.from, l.to))));
  const k = Math.sin(w) || 1;
  const a = Math.sin((1 - s) * w) / k, b = Math.sin(s * w) / k;
  const lift = l.lift * Math.sin(Math.PI * s);
  return norm([l.from[0] * a + l.to[0] * b, l.from[1] * a + l.to[1] * b + lift, l.from[2] * a + l.to[2] * b]);
}

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/**
 * The traffic lanes of a sky: one between each pair of sky planets, and one from each planet down
 * to our horizon (the ships coming here). Pure; the same for every player on the body.
 */
export function skyLanes(specs: readonly SkyPlanetSpec[]): SkyLane[] {
  const lanes: SkyLane[] = [];
  const dirs = specs.map((s) => frameDir(s.elevDeg, s.azDeg));
  const mixHex = (a: number, b: number) => new THREE.Color(a).lerp(new THREE.Color(b), 0.5).getHex();
  for (let i = 0; i < specs.length; i++) {
    for (let j = i + 1; j < specs.length; j++) {
      const w = Math.acos(Math.min(1, Math.max(-1, dot(dirs[i]!, dirs[j]!))));
      const rad = (d: number) => (d * Math.PI) / 180;
      lanes.push({
        from: dirs[i]!, to: dirs[j]!, lift: 0.22, seed: (i * 3 + j) * 0.37 + 0.11,
        color: mixHex(SKY_PLANET_PALETTES[specs[i]!.body].atmosphere, SKY_PLANET_PALETTES[specs[j]!.body].atmosphere),
        trim: [Math.min(0.4, rad(specs[i]!.sizeDeg * 1.3) / w), Math.min(0.4, rad(specs[j]!.sizeDeg * 1.3) / w)],
      });
    }
    // Down to our world: the horizon a little way round from under the planet.
    const s = specs[i]!;
    const to = frameDir(-1.5, s.azDeg + (i % 2 ? -38 : 38));
    const w = Math.acos(Math.min(1, Math.max(-1, dot(dirs[i]!, to))));
    lanes.push({ from: dirs[i]!, to, lift: 0.1, seed: i * 0.53 + 0.71, color: SKY_PLANET_PALETTES[s.body].atmosphere, trim: [Math.min(0.4, ((s.sizeDeg * 1.3 * Math.PI) / 180) / w), 0] });
  }
  return lanes;
}

/** Ribbons for the lanes and the shooting stars, in the local sky frame on the unit sphere. */
export function skyTrafficGeometry(specs: readonly SkyPlanetSpec[], seed = 1): THREE.BufferGeometry {
  const pos: number[] = [], uvs: number[] = [], lane: number[] = [], col: number[] = [], idx: number[] = [];
  const ribbon = (pt: (s: number) => V3, s0: number, s1: number, half: number, kind: number, sd: number, extra: number, color: THREE.Color, segs: number) => {
    const base = pos.length / 3;
    for (let k = 0; k <= segs; k++) {
      const s = s0 + ((s1 - s0) * k) / segs;
      const p = pt(s);
      const q = pt(Math.min(1, s + 0.01)), q0 = pt(Math.max(0, s - 0.01));
      const side = norm(cross(p, [q[0] - q0[0], q[1] - q0[1], q[2] - q0[2]]));
      for (const v of [-1, 1]) {
        pos.push(p[0] + side[0] * half * v, p[1] + side[1] * half * v, p[2] + side[2] * half * v);
        uvs.push(k / segs, v);
        lane.push(kind, sd, extra, 0);
        col.push(color.r, color.g, color.b);
      }
    }
    for (let k = 0; k < segs; k++) {
      const a = base + k * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  };
  for (const l of skyLanes(specs)) {
    const w = Math.acos(Math.min(1, Math.max(-1, dot(l.from, l.to))));
    // extra: how many ships the lane carries (longer lanes, more), signed by their direction.
    const ships = Math.max(2, Math.round(w * 2.2)) * (l.seed * 10 % 2 < 1 ? 1 : -1);
    ribbon((s) => lanePoint(l, s), l.trim[0], 1 - l.trim[1], TRAIL_HALF, KIND.lane, l.seed, ships, new THREE.Color(l.color), SEGMENTS);
  }
  const rnd = lcg(0x9e3779b9 ^ seed);
  for (let i = 0; i < SHOOTING_STARS; i++) {
    const from = frameDir(28 + rnd() * 45, rnd() * 360);
    const az = Math.atan2(from[2], from[0]) * (180 / Math.PI) + (rnd() - 0.5) * 50;
    const el = Math.asin(from[1]) * (180 / Math.PI) - 7 - rnd() * 9;
    const star: SkyLane = { from, to: frameDir(el, az), lift: 0, color: 0xffffff, seed: rnd(), trim: [0, 0] };
    // extra: the star's period in seconds (each on its own clock, so they never come as a volley).
    ribbon((s) => lanePoint(star, s), 0, 1, TRAIL_HALF * 1.25, KIND.star, star.seed, 45 + rnd() * 80, new THREE.Color(0xeaf4ff), 6);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute("aLane", new THREE.Float32BufferAttribute(lane, 4));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

/** Aurora band: azimuth span and elevations (degrees) in the local sky frame. */
export const AURORA = { az0: 150, az1: 330, elev0: 9, elev1: 44 } as const;

export function auroraGeometry(): THREE.BufferGeometry {
  const pos: number[] = [], uvs: number[] = [], idx: number[] = [];
  const NU = 48, NV = 5;
  for (let j = 0; j <= NV; j++) {
    for (let i = 0; i <= NU; i++) {
      const u = i / NU, v = j / NV;
      const d = frameDir(AURORA.elev0 + (AURORA.elev1 - AURORA.elev0) * v, AURORA.az0 + (AURORA.az1 - AURORA.az0) * u);
      pos.push(d[0], d[1], d[2]);
      uvs.push(u, v);
    }
  }
  for (let j = 0; j < NV; j++) {
    for (let i = 0; i < NU; i++) {
      const a = j * (NU + 1) + i;
      idx.push(a, a + 1, a + NU + 1, a + 1, a + NU + 2, a + NU + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

/** The aurora's two colours per body (low edge, high edge). */
export const AURORA_COLORS: Record<BodyId, [number, number]> = {
  portus: [0x58f0c8, 0xffc27a],
  arcadia: [0x5dffb0, 0x6fa8ff],
  hollowmere: [0x9a6bff, 0xff7edb],
  meridian: [0xffb060, 0xff6a8a],
};

export class SkyLife {
  readonly traffic: THREE.Mesh;
  readonly aurora: THREE.Mesh;
  private readonly auroraLow = uniform(new THREE.Color());
  private readonly auroraHigh = uniform(new THREE.Color());
  private readonly m = new THREE.Matrix4();
  private readonly e: V3 = [0, 0, 0];
  private readonly n: V3 = [0, 0, 0];

  constructor(private readonly scene: THREE.Scene, specs: readonly SkyPlanetSpec[], body: BodyId) {
    // Through the air: what is low in the sky sinks into the haze, like the sky planets.
    const height = normalize(positionLocal).y;
    const through = smoothstep(-0.02, 0.22, height);
    // Night, or Portus' late dusk (its sun never sets): what the trails and the aurora brighten with.
    const dark = max(atmo.stars, atmo.lamps.mul(0.55));

    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
    mat.name = "sky_traffic";
    {
      const a = attribute("aLane", "vec4");
      const u = uv().x;
      const across = float(1).sub(uv().y.mul(uv().y));
      const isStar = a.x.greaterThan(0.5);
      // Lanes: a faint thread, and ships along it (a sawtooth: the head at 1, the tail behind).
      const ships = abs(a.z);
      const dir = a.z.sign();
      const x = fract(u.mul(ships).sub(time.mul(0.045).mul(dir)).add(a.y.mul(7)));
      const saw = mix(x, float(1).sub(x), step(dir, 0)); // the tail trails behind whichever way it flies
      const ship = saw.pow(9).add(smoothstep(0.975, 1.0, saw).mul(1.6));
      const ends = smoothstep(0.0, 0.05, u).mul(smoothstep(1.0, 0.95, u));
      const laneLight = ship.mul(1.15).add(0.06).mul(ends).mul(mix(float(0.55), float(1.5), dark));
      // Shooting stars: each on its own period; lit only while its head crosses the ribbon.
      const phase = fract(time.div(a.z.max(1)).add(a.y));
      const run = phase.div(0.012); // 0 … 1 over about a second of an 80 s period
      const head = smoothstep(run.sub(0.7), run, u).mul(step(u, run)).mul(step(run, 1.3));
      const starLight = head.mul(3.2).mul(atmo.stars);
      const light = mix(laneLight, starLight, isStar.toFloat());
      mat.colorNode = attribute("color", "vec3").mul(light.mul(across).mul(through));
    }
    this.traffic = new THREE.Mesh(skyTrafficGeometry(specs), mat);
    this.traffic.name = "skyTraffic";

    const aur = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
    aur.name = "sky_aurora";
    {
      const u = uv().x, v = uv().y;
      const t = time;
      // Slow folds, and fine rays that shimmer inside them.
      const fold = sin(u.mul(17).add(sin(u.mul(5.3).add(t.mul(0.11))).mul(2.2)).add(t.mul(0.17))).mul(0.5).add(0.5);
      const rays = sin(u.mul(170).add(sin(u.mul(11).add(t.mul(0.4))).mul(3))).mul(0.5).add(0.5);
      // The curtain's lower edge rides the folds; it fades upwards.
      const foot = fold.mul(0.22).add(0.04);
      const body = smoothstep(foot, foot.add(0.1), v).mul(exp(v.sub(foot).max(0).mul(-3.2)));
      const sides = smoothstep(0.0, 0.14, u).mul(smoothstep(1.0, 0.86, u));
      const glow = body.mul(fold.mul(0.7).add(0.3)).mul(rays.mul(0.4).add(0.6)).mul(sides).mul(dark).mul(0.5);
      aur.colorNode = mix(this.auroraLow, this.auroraHigh, smoothstep(0.1, 0.75, v)).mul(glow).mul(through);
    }
    this.aurora = new THREE.Mesh(auroraGeometry(), aur);
    this.aurora.name = "skyAurora";
    for (const m of [this.traffic, this.aurora]) {
      m.frustumCulled = false;
      m.matrixAutoUpdate = false;
      m.renderOrder = -8; // after the sky planets and their halos
    }
    scene.add(this.traffic, this.aurora);
    this.setBody(specs, body, false);
  }

  /** Another body's sky: its lanes (a new small geometry) and aurora colours. Same shaders. */
  setBody(specs: readonly SkyPlanetSpec[], body: BodyId, rebuild = true) {
    if (rebuild) {
      this.traffic.geometry.dispose();
      this.traffic.geometry = skyTrafficGeometry(specs);
    }
    const [lo, hi] = AURORA_COLORS[body];
    this.auroraLow.value.setHex(lo);
    this.auroraHigh.value.setHex(hi);
  }

  applySettings(s: ResolvedSettings) {
    this.traffic.visible = s.on.skylife;
    this.aurora.visible = s.on.skylife && s.tier !== "medium" && s.tier !== "low";
  }

  /** Per frame: the local sky frame at the camera (one matrix, shared by both meshes). */
  update(camera: THREE.Camera) {
    if (!this.traffic.visible) return;
    const up = atmo.up.value;
    localFrame(up.x, up.y, up.z, this.e, this.n);
    const e = this.e, n = this.n, p = camera.position;
    this.m.set(
      e[0] * DIST, up.x * DIST, n[0] * DIST, p.x,
      e[1] * DIST, up.y * DIST, n[1] * DIST, p.y,
      e[2] * DIST, up.z * DIST, n[2] * DIST, p.z,
      0, 0, 0, 1,
    );
    this.traffic.matrix.copy(this.m);
    this.traffic.matrixWorldNeedsUpdate = true;
    if (this.aurora.visible) {
      this.aurora.matrix.copy(this.m);
      this.aurora.matrixWorldNeedsUpdate = true;
    }
  }

  dispose() {
    this.scene.remove(this.traffic, this.aurora);
    for (const m of [this.traffic, this.aurora]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      m.dispose();
    }
  }
}

const skies = new WeakMap<THREE.Scene, SkyLife>();

/** The scene's one sky-life set (created on first use, re-laid per body). */
export function skyLifeFor(scene: THREE.Scene, specs: readonly SkyPlanetSpec[], body: BodyId): SkyLife {
  let s = skies.get(scene);
  if (!s) skies.set(scene, (s = new SkyLife(scene, specs, body)));
  else s.setBody(specs, body);
  return s;
}
