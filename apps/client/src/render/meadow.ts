// Graphics-uplift prototype (HANDOFF 6g, docs/research/graphics-uplift.md), behind `?meadow` and
// off by default. Everything here is opt-in and reversible: with the flag absent no material,
// geometry or shader changes. Pieces:
//
// - Meadow grass: each grass instance becomes a clump of thin, curved blades plus an optional
//   wildflower (daisy, buttercup, clover or a lavender spike) that appears in drifts. Same cells,
//   same instance counts and one draw per cell as today's single blades; more vertices per
//   instance. Colour varies by clump (lush ↔ dry straw), roots darken (fake AO), sun-facing views
//   light the tips (translucency) and travelling wind waves bend and brighten the field.
// - Clouds: a cumulus layer on a shell around the planet, ray-hit from the camera and sampled from
//   the existing tileable noise texture (no downloads). Fixed to the planet, drifts with time,
//   lit by the sun (bright tops, grey-blue cores), fades into the horizon haze.
// - Ground: the terrain under grass is pushed from saturated green toward a darker olive so the
//   blades read as dense cover rather than stubble on a lawn.
// - Rocks: a moss blend on up-facing rock surfaces.
//
// - Grade: ACES tone mapping (deeper sky, natural greens) plus a little contrast and saturation
//   after the per-body grade.
//
// `?meadow=nograde,noclouds,nograss,noground,norocks` switches single pieces off for A/B.

import * as THREE from "three/webgpu";
import {
  abs, attribute, cameraPosition, cameraViewMatrix, clamp, cos, cross, dot, float, floor, Fn, fract, hash, length, max,
  mix, mx_noise_float, normalize, normalWorld, positionGeometry, positionPrevious, positionWorld, pow, select, sin,
  smoothstep, sqrt, time, transformDirection, uniform, varying, vec3, vec4, renderGroup,
} from "three/tsl";
import { flags } from "../config.ts";
import { atmo } from "./atmosphere.ts";
import { biplanar } from "./terrainMaterial.ts";
import { detailNoiseTexture } from "./noiseTexture.ts";

const raw = flags.get("meadow");
const off = new Set((raw ?? "").split(",").map((s) => s.trim()).filter(Boolean));
/** The prototype as a whole (`?meadow`). */
export const MEADOW = flags.has("meadow");
export const meadowOn = {
  grade: MEADOW && !off.has("nograde"),
  grass: MEADOW && !off.has("nograss"),
  clouds: MEADOW && !off.has("noclouds"),
  ground: MEADOW && !off.has("noground"),
  rocks: MEADOW && !off.has("norocks"),
};

export const meadowUniforms = {
  /** Cloud cover threshold (lower = more cloud). */
  cover: uniform(0.5).setGroup(renderGroup),
  /** Cloud shell height above the planet radius (m). */
  cloudHeight: uniform(320).setGroup(renderGroup),
};

// ---------------------------------------------------------------------------------------------
// Meadow grass

/** Grass cells whose centre is nearer than this (m) use the full clump; farther ones the lite one. */
export const MEADOW_NEAR = 14;

/**
 * One clump in clump space. position: x across the blade (±0.5) or the head disc (x, z in ±1),
 * y = height fraction. `bl` = (root offset x, root offset z, blade yaw, height scale);
 * `part` = 0 blade, 1 flower stem, 2 flower head. Full: 5 curved blades (2 segments) and a
 * 6-petal head (22 triangles); lite (far cells): 3 straight blades and a 4-point head (8).
 */
export function meadowClumpGeometry(lite: boolean): THREE.BufferGeometry {
  const blades = lite ? 3 : 5;
  const segs = lite ? 1 : 2;
  const rim = lite ? 4 : 6;
  const pos: number[] = [];
  const bl: number[] = [];
  const part: number[] = [];
  const idx: number[] = [];
  let rng = 0x2f6b9d;
  const rand = () => {
    rng = (rng * 1664525 + 1013904223) >>> 0;
    return rng / 4294967296;
  };
  const vert = (x: number, y: number, z: number, b: readonly number[], kind: number) => {
    pos.push(x, y, z);
    bl.push(...b);
    part.push(kind);
  };
  const blade = (b: readonly number[], kind: number, n: number) => {
    const first = pos.length / 3;
    for (let s = 0; s < n; s++) {
      const y = s / n;
      const w = kind === 1 ? 0.35 : 1 - Math.pow(y, 1.6);
      vert(-0.5 * w, y, 0, b, kind);
      vert(0.5 * w, y, 0, b, kind);
    }
    vert(0, 1, 0, b, kind);
    for (let s = 0; s < n - 1; s++) {
      const a = first + s * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    const a = first + (n - 1) * 2;
    idx.push(a, a + 1, first + n * 2);
  };
  for (let i = 0; i < blades; i++) {
    const ang = (i / blades) * Math.PI * 2 + rand() * 0.9;
    const r = 0.25 + rand() * 0.75;
    blade([Math.cos(ang) * r, Math.sin(ang) * r, rand() * Math.PI, 0.6 + rand() * 0.55], 0, segs);
  }
  // Flower stem (collapsed in the shader unless this clump flowers) and head (a fan disc).
  const fb = [0.1, -0.05, 0.4, 1.0] as const;
  blade(fb, 1, 1);
  const centre = pos.length / 3;
  vert(0, 1, 0, fb, 2);
  for (let i = 0; i < rim; i++) {
    const a = (i / rim) * Math.PI * 2;
    vert(Math.cos(a), 1, Math.sin(a), fb, 2);
  }
  for (let i = 0; i < rim; i++) idx.push(centre, centre + 1 + i, centre + 1 + ((i + 1) % rim));
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("bl", new THREE.Float32BufferAttribute(bl, 4));
  g.setAttribute("part", new THREE.Float32BufferAttribute(part, 1));
  g.setIndex(idx);
  return g;
}

/** Integer-lattice hash → [0, 1). */
function hash3(x: number, y: number, z: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1440662683)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth 3-D value noise in [0, 1) (CPU; per clump when a grass cell is filled). */
export function valueNoise(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const s = (t: number) => t * t * (3 - 2 * t);
  const u = s(x - xi), v = s(y - yi), w = s(z - zi);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
    l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Per-clump meadow data written next to `iPos` (planet-space root, `r` a uniform random):
 * x = dryness 0..1 (straw patches), y = flower (0 none, 1 daisy, 2 buttercup, 3 clover,
 * 4 lavender), z = a second random, w = 0. Flowers grow in drifts, one species per drift.
 */
export function meadowMeta(x: number, y: number, z: number, r: number, r2: number, out: Float32Array, o: number) {
  const dry = smooth(0.45, 0.8, valueNoise(x * 0.05, y * 0.05, z * 0.05) * 0.7 + valueNoise(x * 0.17, y * 0.17, z * 0.17) * 0.3);
  const drift = smooth(0.42, 0.75, valueNoise(x * 0.09 + 17.3, y * 0.09 + 4.1, z * 0.09 + 9.7));
  const flowers = r < drift * MEADOW_FLOWER_SHARE + 0.025;
  const sp = Math.min(3, Math.floor(valueNoise(x * 0.035 + 3.3, y * 0.035 + 8.8, z * 0.035 + 1.1) * 4.6 + (r2 - 0.5) * 0.8));
  out[o] = dry;
  out[o + 1] = flowers ? Math.max(0, sp) + 1 : 0;
  out[o + 2] = r2;
  out[o + 3] = 0;
}
/** Flower share of clumps at the heart of a drift. */
export const MEADOW_FLOWER_SHARE = 0.6;

export interface MeadowGrassInputs {
  radius: any;
  height: any;
  width: any;
  windDir: any;
  windStrength: any;
  root: any;
  tip: any;
}

const col = (hex: number) => {
  const c = new THREE.Color(hex);
  return vec3(c.r, c.g, c.b);
};

/** The meadow grass material: same instance attribute (`iPos`) and uniforms as the plain grass. */
export function meadowGrassMaterial(u: MeadowGrassInputs): THREE.MeshLambertNodeMaterial {
  const m = new THREE.MeshLambertNodeMaterial({ side: THREE.DoubleSide });
  m.name = "grass-meadow";
  const ip = attribute("iPos", "vec4");
  const base = ip.xyz;
  const w = ip.w;
  const scale = floor(w).mul(0.01);
  const yaw = fract(w).mul(Math.PI * 2);
  const up = normalize(base);
  const ref = select(abs(up.y).lessThan(0.95), vec3(0, 1, 0), vec3(1, 0, 0));
  const t0 = normalize(cross(ref, up));
  const t1 = cross(up, t0);
  const seed = hash(w.mul(13.7));
  const bl = attribute("bl", "vec4");
  const part = attribute("part", "float");
  const isFlower = part.greaterThan(0.5);
  const isHead = part.greaterThan(1.5);
  const hf = positionGeometry.y;

  // Per-clump data from the CPU (meadowMeta): dryness, flower species, a second random.
  const meta = attribute("iMeta", "vec4");
  const flowerOn = meta.y.greaterThan(0.5);
  const species = meta.y.sub(1.0); // 0 daisy, 1 buttercup, 2 clover, 3 lavender
  const lavender = species.greaterThan(2.5);

  const cy = cos(yaw), sy = sin(yaw);
  const ox = bl.x.mul(cy).sub(bl.y.mul(sy));
  const oz = bl.x.mul(sy).add(bl.y.mul(cy));
  const clumpR = float(0.13);
  const outward = t0.mul(ox).add(t1.mul(oz));
  const root = base.add(outward.mul(clumpR));
  const yaw2 = yaw.add(bl.z);
  const side = t0.mul(cos(yaw2)).add(t1.mul(sin(yaw2)));
  const facing = cross(side, up);

  m.positionNode = Fn((builder: any) => {
    const dist = length(base.sub(cameraPosition));
    const fade = smoothstep(u.radius, u.radius.mul(0.72), dist);
    const keep = select(isFlower, select(flowerOn, float(1), float(0)), float(1));
    const hStem = float(1.25).add(seed.mul(0.3));
    const height = u.height.mul(1.45).mul(scale).mul(select(isFlower, hStem, bl.w)).mul(fade).mul(keep);
    const hfe = select(isHead, float(1), hf);
    // Wind: travelling waves across the field + gusts + per-clump flutter.
    const along = dot(base, u.windDir);
    const across = dot(base, cross(up, u.windDir));
    const wave = sin(along.mul(0.32).sub(time.mul(1.7)).add(sin(across.mul(0.11)).mul(1.5)));
    const gust = sin(along.mul(0.05).sub(time.mul(0.8)).add(sin(across.mul(0.045)).mul(2.0))).mul(0.5).add(0.5);
    const flutter = sin(time.mul(2.6).add(seed.mul(6.283)).add(bl.z.mul(3.0))).mul(0.08);
    const bend = gust.mul(u.windStrength).add(wave.mul(0.22)).add(flutter).mul(hfe.mul(hfe));
    // Blades splay out of the clump and curve; flowers stand straighter.
    const splay = select(isFlower, float(0.12), float(0.55).add(seed.mul(0.25)));
    const lean = hfe.mul(hfe).mul(splay);
    const leanDir = normalize(outward.add(facing.mul(0.35)));
    const stemTop = root
      .add(up.mul(hfe.mul(height)))
      .add(u.windDir.mul(bend).add(leanDir.mul(lean)).mul(height));
    const bladeW = u.width.mul(0.55).mul(select(isFlower, float(0.5), float(1)));
    const bladeP = stemTop.add(side.mul(positionGeometry.x.mul(bladeW).mul(fade.mul(0.5).add(0.5))));
    // Head: a flat disc for daisies, buttercups and clover; an upright spike for lavender.
    const headR = select(species.lessThan(0.5), float(0.075), select(species.lessThan(1.5), float(0.05), float(0.045))).mul(keep).mul(fade);
    // Heads tilt halfway toward the camera so they read as flowers, not slivers.
    const toCam = normalize(cameraPosition.sub(root));
    const tc = normalize(toCam.sub(up.mul(dot(toCam, up))).add(t0.mul(0.001)));
    const a1 = cross(up, tc);
    const a2 = normalize(mix(tc, up, 0.5));
    const disc = a1.mul(positionGeometry.x).add(a2.mul(positionGeometry.z)).mul(headR);
    const spike = side.mul(positionGeometry.x.mul(0.026)).add(up.mul(positionGeometry.z.mul(0.5).add(0.5).mul(0.17))).mul(keep).mul(fade);
    const headP = stemTop.add(select(lavender, spike, disc));
    const p = select(isHead, headP, bladeP);
    if (builder?.needsPreviousData?.()) positionPrevious.assign(p);
    return p;
  })();

  const nW = varying(normalize(mix(up.mul(0.8).add(facing.mul(0.2)), up, select(isHead, float(1), float(0)))), "vMeadowN");
  m.normalNode = transformDirection(nW, cameraViewMatrix);

  // Per-vertex values handed to the fragment stage.
  const vHf = varying(select(isHead, float(1), hf), "vMeadowHf");
  const vPart = varying(part, "vMeadowPart");
  const vDry = varying(meta.x, "vMeadowDry");
  const vSeed = varying(seed, "vMeadowSeed");
  const vSpecies = varying(species, "vMeadowSpecies");
  const vRim = varying(length(positionGeometry.xz), "vMeadowRim");

  // Meadow palette: the body's grass colours pulled toward olive and straw.
  const rootC = mix(mix(u.root, col(0x1c3014), 0.7), col(0x34340f), vDry.mul(0.4));
  const tipC = mix(mix(u.tip, col(0x9fb04c), 0.75), col(0xcdb46a), vDry);
  const ao = mix(float(0.32), float(1), smoothstep(0.0, 0.5, vHf));
  const bladeCol = mix(rootC, tipC, pow(vHf, 0.85)).mul(vSeed.mul(0.28).add(0.74)).mul(ao);
  const petal = select(vSpecies.lessThan(0.5), col(0xf4f1e6),
    select(vSpecies.lessThan(1.5), col(0xf2c21b), select(vSpecies.lessThan(2.5), col(0xe8a0b8), col(0x8a6ad6))));
  const centre = select(vSpecies.lessThan(0.5), col(0xf0b020), petal.mul(0.8));
  const headCol = mix(centre, petal, smoothstep(0.25, 0.45, vRim));
  const stemCol = mix(u.root, u.tip, 0.5).mul(0.8);
  const c: any = select(vPart.greaterThan(1.5), headCol, select(vPart.greaterThan(0.5), stemCol, bladeCol));
  m.colorNode = c.mul(mix(float(1), float(0.8), atmo.wet));

  // Translucency: looking toward the sun, thin blades and petals glow at the tips.
  const view = normalize(positionWorld.sub(cameraPosition));
  const back = pow(max(dot(view, atmo.sunDir), 0.0), 3.0);
  const day = smoothstep(-0.02, 0.15, dot(atmo.sunDir, normalize(positionWorld)));
  // NodeMaterial.setupLighting() honours emissiveNode; the Lambert typings omit it (as in Horses.ts).
  (m as THREE.MeshLambertNodeMaterial & { emissiveNode: THREE.Node | null }).emissiveNode =
    (atmo.sunColor as any).mul(c).mul(back.mul(vHf).mul(0.55).mul(day));
  return m;
}

// ---------------------------------------------------------------------------------------------
// Clouds

/** Cloud density 0..1 at a planet-space point on the cloud shell. */
const cloudDensity = Fn(([p]: [any]) => {
  const tex = detailNoiseTexture();
  const n = normalize(p);
  const drift = vec3(time.mul(1.6), time.mul(0.4), time.mul(-1.1));
  const q = p.add(drift);
  const a = biplanar(tex, q.div(900.0), n).g;
  const a2 = biplanar(tex, q.div(610.0).add(vec3(0.37, 0.11, 0.73)), n).g;
  const b = biplanar(tex, q.div(260.0), n).r;
  return a.mul(0.5).add(a2.mul(0.32)).add(b.mul(0.18));
});

/**
 * Cloud colour (rgb) and coverage (a) towards a unit view direction, for the sky background.
 * `sky` = the clear-sky colour in that direction (clouds fade into it near the horizon).
 */
export const cloudLayer = Fn(([dir, sky]: [any, any]) => {
  const c = cameraPosition;
  const rs = atmo.planetR.add(meadowUniforms.cloudHeight);
  const b = dot(c, dir);
  const cc = dot(c, c).sub(rs.mul(rs));
  const t = b.negate().add(sqrt(max(b.mul(b).sub(cc), 0.0)));
  const p = c.add(dir.mul(t));
  const d = cloudDensity(p);
  // A second tap toward the sun: density rising toward the sun = the far side is lit (bright
  // tops, darker bellies) without any ray marching.
  const toSun = normalize(atmo.sunDir.sub(normalize(p).mul(dot(atmo.sunDir, normalize(p)))).add(normalize(p).mul(0.15)));
  const dSun = cloudDensity(p.add(toSun.mul(70.0)));
  const cover = meadowUniforms.cover;
  const e = dot(dir, atmo.up);
  const horizon = smoothstep(-0.02, 0.16, e);
  const alpha = smoothstep(cover, cover.add(0.16), d).mul(horizon).mul(0.94);
  // Self-shadow from the sun tap, plus thick cores a little darker; silver lining toward the sun.
  const core = clamp(dSun.sub(d).mul(5.0).add(0.35), 0.0, 1.0).mul(0.75).add(smoothstep(cover.add(0.1), cover.add(0.35), d).mul(0.25));
  const sunUp = smoothstep(-0.08, 0.2, dot(atmo.sunDir, atmo.up));
  const toward = pow(max(dot(dir, atmo.sunDir), 0.0), 6.0);
  // Kept under the bloom threshold: a bright cloud deck would veil the whole frame with bloom.
  const lit = mix(vec3(1.0, 0.98, 0.95), atmo.sunColor, 0.45).mul(sunUp.mul(0.82).add(0.06));
  const shade = mix(atmo.zenith, atmo.horizon, 0.45).mul(mix(float(0.55), float(0.95), sunUp));
  const rgb = mix(lit, shade, core.mul(0.7)).add(atmo.sunColor.mul(toward.mul(float(1).sub(core)).mul(0.35).mul(sunUp)));
  // Aerial perspective: far clouds near the horizon take the sky colour.
  const far = smoothstep(500.0, 1600.0, t).mul(0.65);
  return vec4(mix(rgb, sky, far), alpha);
});

/** Wrap a sky background colour node with the cloud layer. */
export function withClouds(dir: any, sky: any): any {
  const cl = cloudLayer(dir, sky);
  return mix(sky, cl.rgb, cl.a);
}

// ---------------------------------------------------------------------------------------------
// Ground and rocks

/** Terrain colour under grass: saturated green → darker olive (meadow ground). */
export function meadowGround(colIn: any, rock: any): any {
  const g = colIn.g.sub(max(colIn.r, colIn.b));
  const grassy = smoothstep(0.02, 0.12, g).mul(float(1).sub(rock));
  const lum = dot(colIn, vec3(0.2126, 0.7152, 0.0722));
  const olive = vec3(lum).mul(vec3(0.5, 0.74, 0.2));
  return mix(colIn, mix(colIn.mul(0.42), olive.mul(0.8), 0.6), grassy);
}

/** Moss on up-facing rock (planet up), broken up by noise. */
export function mossy(colIn: any): any {
  const upness = dot(normalize(normalWorld), normalize(positionWorld));
  const n = mx_noise_float(positionWorld.mul(0.9)).mul(0.5).add(0.5);
  const moss = smoothstep(0.35, 0.8, upness.add(n.mul(0.35).sub(0.15)));
  return mix(colIn, col(0x4a5a22).mul(clamp(n.add(0.5), 0.6, 1.2)), moss.mul(0.85));
}

// ---------------------------------------------------------------------------------------------
// Grade

/** After the per-body grade (display space): a gentle S-curve and a saturation lift (+18 %). */
export function meadowGrade(rgb: any): any {
  const c: any = clamp(rgb, 0.0, 1.0);
  const s: any = c.mul(c).mul(float(3).sub(c.mul(2)));
  const curved: any = mix(c, s, 0.45);
  const l: any = dot(curved, vec3(0.2126, 0.7152, 0.0722));
  return mix(vec3(l, l, l), curved, 1.18);
}
