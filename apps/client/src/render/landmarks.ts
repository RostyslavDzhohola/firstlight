// Horizon landmarks (D-gfx-worlds-1, #7 "landmarks so a place can be recognised"): far-field
// silhouettes that make each planet's skyline its own. Pure visuals: no collision, nothing the
// server knows, never reachable (they hang 140–520 m up).
//   Arcadia     floating rock islands with meadow tops and falls of light pouring off their rims
//   Hollowmere  a broken stone ring round the planet, and a second shattered arc crossing it
//   Meridian    orbital yards: truss frames with panel arrays, strobes, and tethers hung with
//               warning lights that blink in sequence
// Fixed to the planet, so they pass through the sky as you walk and work as bearings. Each body's
// set is one merged, flat-shaded mesh and one draw, lit by the scene's sun and sky like everything
// else and fogged by the scene fog, so the far ones sink into the haze. Loaded terrain ends 520 m
// out, so the planet itself is not there to hide what lies beyond the horizon: the material drops
// every fragment whose line of sight passes through the planet's sphere. One material for all
// bodies (colours and lights are vertex data): a travel compiles nothing.

import * as THREE from "three/webgpu";
import { attribute, cameraPosition, clamp, dot, float, fract, length, max, positionWorld, sin, smoothstep, step, time, vertexColor } from "three/tsl";
import { BODIES, padDirs, type BodyId } from "@firstlight/shared";
import { atmo } from "./atmosphere.ts";
import type { ResolvedSettings } from "./quality.ts";

type V3 = [number, number, number];

/** Deterministic random stream. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const rgb = (hex: number, k = 1): V3 => {
  const c = new THREE.Color(hex);
  return [c.r * k, c.g * k, c.b * k];
};

/** Glow modes of a vertex (`glow.z`): steady, blinking, flowing along `glow.y`. */
const STEADY = 0, BLINK = 1, FLOW = 2;

/** A local frame at a planet direction: metres east (x), up (y), north (z) from a point `h` above the radius. */
class Frame {
  readonly o: V3;
  readonly e: V3;
  readonly n: V3;
  readonly u: V3;
  constructor(dir: V3, radius: number, h: number, heading = 0) {
    this.u = norm(dir);
    const ref: V3 = Math.abs(this.u[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
    const e0 = norm(cross(ref, this.u));
    const n0 = cross(this.u, e0);
    const c = Math.cos(heading), s = Math.sin(heading);
    this.e = [e0[0] * c + n0[0] * s, e0[1] * c + n0[1] * s, e0[2] * c + n0[2] * s];
    this.n = cross(this.u, this.e);
    const r = radius + h;
    this.o = [this.u[0] * r, this.u[1] * r, this.u[2] * r];
  }
  at(x: number, y: number, z: number): V3 {
    const { o, e, n, u } = this;
    return [o[0] + e[0] * x + u[0] * y + n[0] * z, o[1] + e[1] * x + u[1] * y + n[1] * z, o[2] + e[2] * x + u[2] * y + n[2] * z];
  }
}

/** Flat-shaded triangle soup with a colour and a glow per vertex. */
export class SilhouetteBuilder {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly col: number[] = [];
  readonly glow: number[] = [];

  tri(a: V3, b: V3, c: V3, ca: V3, cb: V3 = ca, cc: V3 = ca, glow: V3 = [0, 0, 0], gb: V3 = glow, gc: V3 = glow) {
    const n = norm(cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]));
    this.pos.push(...a, ...b, ...c);
    this.nor.push(...n, ...n, ...n);
    this.col.push(...ca, ...cb, ...cc);
    this.glow.push(...glow, ...gb, ...gc);
  }

  quad(a: V3, b: V3, c: V3, d: V3, ca: V3, cb: V3 = ca, cc: V3 = ca, cd: V3 = ca, ga: V3 = [0, 0, 0], gb: V3 = ga, gc: V3 = ga, gd: V3 = ga) {
    this.tri(a, b, c, ca, cb, cc, ga, gb, gc);
    this.tri(a, c, d, ca, cc, cd, ga, gc, gd);
  }

  /** A box in a frame: centre (x, y, z), half sizes, yaw about the frame's up. `top`/`bottom` colours shade it. */
  box(f: Frame, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, yaw: number, top: V3, bottom: V3 = top, glow: V3 = [0, 0, 0]) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const p = (x: number, y: number, z: number): V3 => f.at(cx + x * c - z * s, cy + y, cz + x * s + z * c);
    const v = [p(-hx, -hy, -hz), p(hx, -hy, -hz), p(hx, -hy, hz), p(-hx, -hy, hz), p(-hx, hy, -hz), p(hx, hy, -hz), p(hx, hy, hz), p(-hx, hy, hz)] as const;
    const side = (a: number, b: number) => this.quad(v[a]!, v[b]!, v[b + 4]!, v[a + 4]!, bottom, bottom, top, top, glow);
    side(1, 0);
    side(2, 1);
    side(3, 2);
    side(0, 3);
    this.quad(v[4]!, v[5]!, v[6]!, v[7]!, top, top, top, top, glow);
    this.quad(v[3]!, v[2]!, v[1]!, v[0]!, bottom, bottom, bottom, bottom, glow);
  }

  get triangles(): number {
    return this.pos.length / 9;
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute("glow", new THREE.Float32BufferAttribute(this.glow, 3));
    g.computeBoundingSphere();
    return g;
  }
}

/** `n` directions spread evenly over the sphere (a Fibonacci lattice), turned by the body's own seed. */
export function spreadDirs(n: number, seed: number): V3[] {
  const r = rng(seed);
  const turn = r() * Math.PI * 2, tilt = r() * Math.PI;
  const ct = Math.cos(tilt), st = Math.sin(tilt);
  const out: V3[] = [];
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const rad = Math.sqrt(1 - y * y);
    const a = i * 2.399963 + turn;
    const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
    out.push([x, y * ct - z * st, y * st + z * ct]);
  }
  return out;
}

/** A direction `metres` along the ground from `from`, on a heading (radians from the frame's east). */
function offset(from: V3, metres: number, heading: number, radius: number): V3 {
  const f = new Frame(from, radius, 0, heading);
  const a = metres / radius;
  return norm([f.u[0] * Math.cos(a) + f.e[0] * Math.sin(a), f.u[1] * Math.cos(a) + f.e[1] * Math.sin(a), f.u[2] * Math.cos(a) + f.e[2] * Math.sin(a)]);
}

// ------------------------------------------------------------------------------------- Arcadia

/** Nothing of Arcadia's islands comes lower than this above the radius (Kestrel Peak is 95 m). */
const ISLAND_FLOOR = 130;

/**
 * One floating island (its top `h` above the radius). Second pass (D-gfx-worlds-6): a domed meadow
 * cap whose turf overhangs the rock, three bands of strata that step in and jut out as ledges, a
 * spire with hanging shards under it, pines and round-crowned trees, a broken arch with a lit rune
 * on the bigger ones, and falls of light with a bright head pouring off the rim. `big` islands get
 * the full set; the small companion rocks a simpler one.
 */
function island(b: SilhouetteBuilder, f: Frame, w: number, h: number, r: () => number, big = true) {
  const K = big ? 11 : 8;
  const turf = rgb(0x5fa046), turf2 = rgb(0x8fc85a), turfDark = rgb(0x3f7a34), earth = rgb(0x6b5238);
  const rockA = rgb(0xb9ad9a), rockB = rgb(0x8d8375), rockC = rgb(0x6f675c), deep = rgb(0x4b4540);
  const depth = w * (0.95 + r() * 0.55);
  const ang: number[] = [], rimR: number[] = [];
  for (let i = 0; i < K; i++) {
    ang.push((i / K) * Math.PI * 2 + (r() - 0.5) * 0.25);
    rimR.push(w * (0.7 + r() * 0.5));
  }
  const ringAt = (k: number, y: number, jitter: number, twist = 0): V3[] =>
    ang.map((a, i) => f.at(Math.cos(a + twist) * rimR[i]! * k * (1 + (r() - 0.5) * jitter), y + (r() - 0.5) * w * 0.05, Math.sin(a + twist) * rimR[i]! * k * (1 + (r() - 0.5) * jitter)));
  const band = (top: V3[], bot: V3[], ct: V3, cb: V3) => {
    for (let i = 0; i < K; i++) {
      const j = (i + 1) % K;
      b.quad(top[i]!, top[j]!, bot[j]!, bot[i]!, ct, ct, cb, cb);
    }
  };
  // The cap: a dome of meadow, its turf bulging out over the rock and tucking back under.
  const crown = f.at(w * (r() - 0.5) * 0.3, w * (0.16 + r() * 0.1), w * (r() - 0.5) * 0.3);
  const inner = ringAt(0.55, w * 0.1, 0.1);
  const rim = ringAt(1.0, 0, 0);
  const bulge = ringAt(1.07, -w * 0.07, 0.04);
  const tuck = ringAt(0.84, -w * 0.15, 0.06);
  for (let i = 0; i < K; i++) {
    const j = (i + 1) % K;
    b.tri(crown, inner[j]!, inner[i]!, turf2, turf2, turf2);
  }
  band(inner, rim, turf2, turf);
  band(rim, bulge, turf, turfDark);
  band(bulge, tuck, turfDark, earth);
  // Strata: each band steps in, then the next juts out again as a ledge (lit top, dark underside).
  let prev = tuck;
  let k = 0.84;
  let y = -w * 0.15;
  const bands = big ? 3 : 2;
  for (let s = 0; s < bands; s++) {
    const dy = (depth * 0.62) / bands;
    const kIn = k * (0.8 + r() * 0.08);
    const face = ringAt(kIn, y - dy * 0.8, 0.12, s * 0.15);
    band(prev, face, s % 2 ? rockB : rockA, s % 2 ? rockC : rockB);
    y -= dy;
    k = kIn * (s < bands - 1 ? 1.12 : 0.8);
    const ledge = ringAt(k, y, 0.14, s * 0.15 + 0.1);
    band(face, ledge, rockC, deep);
    prev = ledge;
  }
  const apex = f.at(w * (r() - 0.5) * 0.4, -depth, w * (r() - 0.5) * 0.4);
  for (let i = 0; i < K; i++) b.tri(prev[i]!, prev[(i + 1) % K]!, apex, rockC, rockC, deep);
  // Shards hanging under the ledges.
  for (let t = 0; t < (big ? 4 : 1); t++) {
    const a = r() * Math.PI * 2, d = w * (0.25 + r() * 0.3), len = w * (0.25 + r() * 0.35), s2 = w * (0.05 + r() * 0.05), y0 = -depth * (0.35 + r() * 0.2);
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    const tip = f.at(x, y0 - len, z);
    const p = [f.at(x + s2, y0, z), f.at(x - s2 * 0.5, y0, z + s2 * 0.87), f.at(x - s2 * 0.5, y0, z - s2 * 0.87)] as const;
    b.tri(tip, p[0], p[1], deep, rockB, rockB);
    b.tri(tip, p[1], p[2], deep, rockB, rockB);
    b.tri(tip, p[2], p[0], deep, rockB, rockB);
  }
  // Trees for scale: two-tier pines and round crowns on trunks.
  const pine = rgb(0x2f6a3a), pine2 = rgb(0x1f4a2a), leaf = rgb(0x4f9a3a), leaf2 = rgb(0x2f6a2c), bark = rgb(0x5a4030);
  const cone = (x: number, y0: number, z: number, hgt: number, rad: number, c0: V3, c1: V3) => {
    const tip = f.at(x, y0 + hgt, z);
    const p = [f.at(x + rad, y0, z), f.at(x - rad * 0.5, y0, z + rad * 0.87), f.at(x - rad * 0.5, y0, z - rad * 0.87)] as const;
    b.tri(tip, p[1], p[0], c0, c1, c1);
    b.tri(tip, p[2], p[1], c0, c1, c1);
    b.tri(tip, p[0], p[2], c0, c1, c1);
  };
  const trees = big ? 7 : 2;
  for (let t = 0; t < trees; t++) {
    const a = r() * Math.PI * 2, d = w * (0.12 + r() * 0.5), hgt = w * (0.16 + r() * 0.16);
    const x = Math.cos(a) * d, z = Math.sin(a) * d, y0 = w * (0.1 - (d / w) * 0.12);
    if (t % 3 === 2) {
      const cr = hgt * 0.42;
      b.box(f, x, y0 + hgt * 0.3, z, hgt * 0.05, hgt * 0.3, hgt * 0.05, a, bark);
      b.box(f, x, y0 + hgt * 0.75, z, cr, cr * 0.8, cr, a, leaf, leaf2);
      b.box(f, x + cr * 0.5, y0 + hgt * 0.95, z + cr * 0.3, cr * 0.6, cr * 0.55, cr * 0.6, a + 0.7, leaf, leaf2);
    } else {
      cone(x, y0, z, hgt * 0.75, hgt * 0.32, pine, pine2);
      cone(x, y0 + hgt * 0.4, z, hgt * 0.6, hgt * 0.22, pine, pine2);
    }
  }
  // A broken arch on the bigger islands: two pillars, half a lintel, fallen blocks, a rune that glows at night.
  if (big && w > 44) {
    const stone = rgb(0xd8d0c0), stone2 = rgb(0x9a9284), rune = rgb(0xffe7a0);
    const a = r() * Math.PI * 2, d = w * 0.3, x = Math.cos(a) * d, z = Math.sin(a) * d, s2 = w * 0.03, y0 = w * 0.07, ph = w * 0.3;
    const ex = Math.cos(a + 1.57) * s2 * 4, ez = Math.sin(a + 1.57) * s2 * 4;
    b.box(f, x - ex, y0 + ph / 2, z - ez, s2, ph / 2, s2, a, stone, stone2);
    b.box(f, x + ex, y0 + ph * 0.36, z + ez, s2, ph * 0.36, s2, a, stone, stone2);
    b.box(f, x - ex * 0.45, y0 + ph + s2 * 0.8, z - ez * 0.45, s2 * 1.1, s2 * 0.8, s2 * 3.2, a, stone, stone2);
    b.box(f, x + ex * 1.6, y0 + s2, z + ez * 1.6, s2 * 1.4, s2, s2 * 1.1, a + 0.5, stone, stone2);
    b.box(f, x - ex, y0 + ph * 0.7, z - ez, s2 * 1.08, s2 * 0.5, s2 * 1.08, a, rune, rune, [2.6, r() * 6.28, STEADY]);
  }
  // Falls of light: two crossed ribbons from the rim, a bright head where they leave the lip, thinning out below.
  const light = rgb(0xbff7ff), white = rgb(0xf4ffff);
  const falls = big ? 2 + Math.floor(r() * 2) : 1;
  for (let n = 0; n < falls; n++) {
    const i = Math.floor(r() * K);
    const a = ang[i]!;
    const x = Math.cos(a) * rimR[i]! * 1.03, z = Math.sin(a) * rimR[i]! * 1.03;
    // The light thins out in mid-air: it never reaches the ground.
    const len = Math.min(w * (1.6 + r() * 1.4), h - ISLAND_FLOOR), hw = w * 0.05, ph = r() * 10, head = len * 0.12;
    for (const [dx, dz] of [[Math.sin(a), -Math.cos(a)], [Math.cos(a), Math.sin(a)]] as const) {
      const g0: V3 = [5.5, ph, FLOW], g1: V3 = [3.0, ph + head * 0.06, FLOW], g2: V3 = [0, ph + len * 0.06, FLOW];
      const p0 = f.at(x - dx * hw, -w * 0.02, z - dz * hw), p1 = f.at(x + dx * hw, -w * 0.02, z + dz * hw);
      const m0 = f.at(x - dx * hw * 0.9, -head, z - dz * hw * 0.9), m1 = f.at(x + dx * hw * 0.9, -head, z + dz * hw * 0.9);
      b.quad(p0, p1, m1, m0, white, white, light, light, g0, g0, g1, g1);
      b.quad(m0, m1, f.at(x + dx * hw * 0.3, -len, z + dz * hw * 0.3), f.at(x - dx * hw * 0.3, -len, z - dz * hw * 0.3), light, light, light, light, g1, g1, g2, g2);
    }
  }
}

function arcadia(radius: number): SilhouetteBuilder {
  const b = new SilhouetteBuilder();
  const r = rng(0xa2cad1a);
  const pad = padDirs(BODIES.arcadia)[0] as V3;
  // One in view from the landing pad, the rest spread round the planet.
  const dirs: V3[] = [offset(pad, 230, 0.9, radius), offset(pad, 330, 3.6, radius), ...spreadDirs(13, 0x51a7)];
  dirs.forEach((d, i) => {
    // Tops 230–330 m up: the deepest spire (1.4 × the width) still ends above ISLAND_FLOOR.
    const w = 34 + r() * 36;
    const h = 230 + r() * 100;
    island(b, new Frame(d, radius, h, r() * 6.28), w, h, r);
    // A smaller rock or two keeping it company.
    if (i % 2 === 0) {
      const h2 = 190 + r() * 110;
      island(b, new Frame(offset(d, w * 2.2 + r() * 40, r() * 6.28, radius), radius, h2, r() * 6.28), 10 + r() * 10, h2, r, false);
    }
  });
  return b;
}

// ---------------------------------------------------------------------------------- Hollowmere

/** A ring of stone slabs in the plane normal to `axis`, `fill` of it standing; the rest is gaps and drifting rubble. */
function ring(b: SilhouetteBuilder, axis: V3, start: V3, ringR: number, segments: number, arc: number, width: number, thick: number, r: () => number) {
  const n = norm(axis);
  const e = norm(cross(n, cross(start, n)));
  const t = cross(n, e);
  const stone = rgb(0x9c8fb6), under = rgb(0x3d3356), rune = rgb(0xc9a0ff), crystal = rgb(0x7fffe0);
  const step_ = arc / segments;
  let gap = 0;
  for (let i = 0; i < segments; i++) {
    const a = i * step_;
    // Breaks come in runs: a few slabs missing, rubble drifting where they were.
    if (gap === 0 && r() < 0.085) gap = 2 + Math.floor(r() * 5);
    const dir: V3 = norm([e[0] * Math.cos(a) + t[0] * Math.sin(a), e[1] * Math.cos(a) + t[1] * Math.sin(a), e[2] * Math.cos(a) + t[2] * Math.sin(a)]);
    // Frame: up = outward from the planet, east = along the ring.
    const f = new Frame(dir, ringR, 0);
    const along = norm(cross(n, dir));
    const yaw = Math.atan2(along[0] * f.n[0] + along[1] * f.n[1] + along[2] * f.n[2], along[0] * f.e[0] + along[1] * f.e[1] + along[2] * f.e[2]);
    const len = ringR * step_ * 0.5;
    if (gap > 0) {
      gap--;
      for (let k = 0; k < 2; k++) {
        const s = 3 + r() * 9;
        b.box(f, (r() - 0.5) * len * 2, (r() - 0.5) * 60, (r() - 0.5) * width * 2.4, s, s * (0.5 + r()), s * (0.6 + r()), r() * 6.28, stone, under);
      }
      continue;
    }
    const lift = (r() - 0.5) * 5;
    b.box(f, 0, lift, 0, len * 0.94, thick / 2, width / 2, yaw, stone, under);
    // A lit seam of runes along the inner face of every third slab.
    if (i % 3 === 0) b.box(f, 0, lift - thick / 2 - 0.6, 0, len * 0.6, 0.7, width * 0.08, yaw, rune, rune, [2.2, r() * 6.28, BLINK]);
    // A steady seam down the middle of the others' undersides (the side the ground sees), and now and
    // then a pale crystal standing on a slab's rim: the ring reads as a line of lights at night.
    else b.box(f, 0, lift - thick / 2 - 0.4, 0, len * 0.5, 0.45, width * 0.03, yaw, rune, rune, [0.9, 0, STEADY]);
    if (i % 7 === 3) b.box(f, 0, lift + thick / 2 + 7, width * 0.36, 2.2, 7, 2.2, yaw + 0.6, crystal, crystal, [2.4, r() * 6.28, i % 14 === 3 ? BLINK : STEADY]);
    // Buttress teeth on the outer face.
    if (i % 4 === 1) b.box(f, 0, lift + thick / 2 + 5, 0, len * 0.22, 6, width * 0.3, yaw, stone, under);
  }
}

function hollowmere(radius: number): SilhouetteBuilder {
  const b = new SilhouetteBuilder();
  const r = rng(0x40110e3);
  const pad = padDirs(BODIES.hollowmere)[0] as V3;
  // The great ring passes 300 m from the landing pad; a second, shattered arc crosses it.
  const over = offset(pad, 300, 1.1, radius);
  const axisA = norm(cross(over, norm([0.31, 0.2, 0.93])));
  ring(b, axisA, over, radius * 1.42, 132, Math.PI * 2, 52, 16, r);
  const axisB = norm(cross(axisA, over));
  const tilted = norm([axisB[0] * 0.8 + axisA[0] * 0.6, axisB[1] * 0.8 + axisA[1] * 0.6, axisB[2] * 0.8 + axisA[2] * 0.6]);
  ring(b, tilted, offset(pad, 520, 4.1, radius), radius * 1.62, 96, Math.PI * 1.25, 34, 11, r);
  return b;
}

// ------------------------------------------------------------------------------------ Meridian

/** An orbital yard: a long truss with a cross spar, panel arrays, a mast, strobes, and a tether with chasing warning lights. */
function yard(b: SilhouetteBuilder, f: Frame, size: number, tetherTo: number, r: () => number) {
  const steel = rgb(0x5a6672), dark = rgb(0x262c34), panel = rgb(0x1f3a5c), hazard = rgb(0xd9842a);
  const red = rgb(0xff3a28), white = rgb(0xe8f4ff), cyan = rgb(0x6ff0ea), green = rgb(0x6aff8a), amber = rgb(0xffb040);
  const L = size, W = size * 0.055;
  b.box(f, 0, 0, 0, L / 2, W * 0.7, W, 0, steel, dark);
  b.box(f, L * 0.12, 0, 0, W, W * 0.6, L * 0.24, 0, steel, dark);
  // Truss ribs.
  for (let i = -3; i <= 3; i++) b.box(f, (i / 3.5) * L * 0.5, 0, 0, W * 0.25, W * 1.5, W * 1.6, 0, hazard, dark);
  // Panel arrays on both sides.
  for (const sx of [-0.32, -0.12, 0.3]) {
    for (const sz of [-1, 1]) b.box(f, sx * L, W * 0.2, sz * (W * 2 + L * 0.11), L * 0.07, 0.6, L * 0.1, 0, panel, dark, [0.22, 0, STEADY]);
  }
  // A habitat drum and a mast with a red beacon.
  b.box(f, -L * 0.2, W * 1.6, 0, L * 0.06, W * 1.2, W * 1.4, 0.4, steel, dark);
  b.box(f, L * 0.12, L * 0.11, 0, W * 0.18, L * 0.11, W * 0.18, 0, steel, dark);
  const s = Math.max(3.4, size * 0.018);
  b.box(f, L * 0.12, L * 0.22 + s, 0, s, s, s, 0, red, red, [7, r() * 6.28, BLINK]);
  // Strobes at the truss ends, running lights along the keel.
  b.box(f, L / 2, 0, 0, s, s, s, 0, white, white, [8, r() * 6.28, BLINK]);
  b.box(f, -L / 2, 0, 0, s, s, s, 0, white, white, [8, r() * 6.28, BLINK]);
  for (let i = -2; i <= 2; i++) b.box(f, (i / 2.5) * L * 0.5, -W * 0.9, 0, s * 0.7, s * 0.5, s * 0.7, 0, cyan, cyan, [3, 0, STEADY]);
  // A green docking beacon under the drum and amber work lights along the cross spar.
  b.box(f, -L * 0.2, -W * 1.2, 0, s, s * 0.6, s, 0, green, green, [5, r() * 6.28, BLINK]);
  for (const sz of [-1, 1]) b.box(f, L * 0.12, W * 0.8, sz * L * 0.22, s * 0.8, s * 0.6, s * 0.8, 0, amber, amber, [3.2, 0, STEADY]);
  // The tether: a cable down toward the ground (it stops well above it), warning lights chasing up it.
  const top = -W, len = tetherTo;
  b.box(f, -L * 0.05, top - len / 2, 0, 0.9, len / 2, 0.9, 0.3, dark, dark);
  const lights = Math.max(3, Math.floor(len / 55));
  for (let i = 1; i <= lights; i++) {
    const y = top - (i / lights) * len;
    b.box(f, -L * 0.05, y, 0, s * 0.8, s * 0.8, s * 0.8, 0, red, red, [6, i * 0.9, BLINK]);
  }
  // A counterweight at the cable's end.
  b.box(f, -L * 0.05, top - len - 5, 0, 5, 5, 5, 0.6, hazard, dark);
}

function meridian(radius: number): SilhouetteBuilder {
  const b = new SilhouetteBuilder();
  const r = rng(0x3e41d1a);
  const pad = padDirs(BODIES.meridian)[0] as V3;
  const dirs: V3[] = [offset(pad, 420, 2.2, radius), offset(pad, 560, 5.3, radius), ...spreadDirs(12, 0x7711)];
  for (const d of dirs) {
    const h = 430 + r() * 90;
    const size = 190 + r() * 140;
    // The tether ends 150 m above the radius: clear of Chrome Spires (110 m) and every mesa.
    yard(b, new Frame(d, radius, h, r() * 6.28), size, h - 150 - size * 0.055, r);
  }
  return b;
}

const BUILDERS: Partial<Record<BodyId, (radius: number) => SilhouetteBuilder>> = { arcadia, hollowmere, meridian };

/** The landmark soup of a body (null: the hub has none), for the mesh and the tests. */
export function buildLandmarks(body: BodyId): SilhouetteBuilder | null {
  return BUILDERS[body]?.(BODIES[body].radius) ?? null;
}

/** Built by the first landmarks in the session to need it, disposed with the last (Landmarks.dispose). */
let shared: THREE.MeshLambertNodeMaterial | null = null;
let sharedUsers = 0;

/** One material for every body's landmarks: vertex colour, lit by the scene's lights, fogged, self-lit where `glow` says. */
function landmarkMaterial(): THREE.MeshLambertNodeMaterial {
  if (shared) return shared;
  const m = new THREE.MeshLambertNodeMaterial({ alphaTest: 0.5, side: THREE.DoubleSide });
  m.name = "landmarks";
  const base = vertexColor().rgb;
  const glow = attribute("glow", "vec3");
  m.colorNode = base;
  // Self-light: steady, blinking (a short flash each ~1.6 s, offset by the vertex's phase) or flowing
  // (bands running down a fall of light). Brighter as the sky darkens, like every lamp in the game.
  const blink = smoothstep(0.82, 0.97, sin(time.mul(3.9).sub(glow.y)));
  const flow = fract(glow.y.mul(0.35).sub(time.mul(0.55))).mul(0.6).add(0.4);
  const pattern = float(1).mul(step(glow.z, 0.5)).add(blink.mul(step(0.5, glow.z)).mul(step(glow.z, 1.5))).add(flow.mul(step(1.5, glow.z)));
  // Bounce: what hangs in the sky is lit from below by the bright land and haze under it (the
  // scene's fill light has a dark ground colour, which left every underside a navy blob).
  const bounce = base.mul(atmo.horizon as any).mul(0.55);
  (m as THREE.MeshLambertNodeMaterial & { emissiveNode: THREE.Node | null }).emissiveNode = base.mul(glow.x).mul(pattern).mul(atmo.glowBoost).add(bounce);
  // Hidden by the planet: the closest point of the sight line to the planet's centre lies inside its sphere.
  const c = cameraPosition;
  const d = positionWorld.sub(c);
  const t = clamp(dot(c, d).negate().div(max(dot(d, d), 0.0001)), 0.0, 1.0);
  const closest = length(c.add(d.mul(t)));
  m.opacityNode = step(atmo.planetR.add(atmo.waterLevel).sub(6.0), closest);
  shared = m;
  return m;
}

/**
 * A body's landmark soup while a planet of it is up: shared by every Landmarks of that body, freed
 * with the last one (planet graphics review, finding 4: they used to stay for the session, three
 * bodies' vertex buffers after a tour, with no teardown).
 */
const geometries = new Map<BodyId, { geo: THREE.BufferGeometry; users: number }>();

export class Landmarks {
  readonly group = new THREE.Group();
  /** Null on the hub (it has none) and after dispose(). */
  mesh: THREE.Mesh | null = null;
  private readonly body: BodyId;

  constructor(body: BodyId, _radius: number) {
    this.group.name = "landmarks";
    this.body = body;
    let entry = geometries.get(body);
    if (!entry) {
      const b = buildLandmarks(body);
      if (!b) return;
      entry = { geo: b.geometry(), users: 0 };
      geometries.set(body, entry);
    }
    entry.users++;
    sharedUsers++;
    const mesh = new THREE.Mesh(entry.geo, landmarkMaterial());
    mesh.name = `landmarks:${body}`;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // One mesh round the whole planet: always in view somewhere.
    mesh.frustumCulled = false;
    (mesh as unknown as { static: boolean }).static = true;
    this.mesh = mesh;
    this.group.add(mesh);
  }

  applySettings(s: ResolvedSettings) {
    this.group.visible = s.on.landmarks;
  }

  update(_camera: THREE.Camera) {
    /* planet-fixed: nothing moves on the CPU */
  }

  /**
   * Leaving the body: its geometry goes with the last Landmarks that drew it, and the material with
   * the last Landmarks of any body (three frees their GPU buffers and shader build on `dispose`). The
   * next arrival builds both again in its constructor, so the arrival's warm-up compiles them.
   */
  dispose() {
    this.group.removeFromParent();
    const mesh = this.mesh;
    if (!mesh) return;
    this.mesh = null;
    this.group.remove(mesh);
    mesh.dispose(); // its own render state: a geometry or material that lives on would keep it (dispose.ts)
    const entry = geometries.get(this.body);
    if (entry && entry.geo === mesh.geometry && --entry.users <= 0) {
      geometries.delete(this.body);
      entry.geo.dispose();
    }
    if (--sharedUsers <= 0) {
      sharedUsers = 0;
      shared?.dispose();
      shared = null;
    }
  }
}
