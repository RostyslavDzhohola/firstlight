// Meadow grass (D-gfx-worlds-1; ported from the `?meadow` study, docs/research/graphics-uplift.md on
// lane/graphics-study). Each grass instance is a clump of thin, curved blades plus an optional
// ground-cover head on its own stem: a daisy, buttercup, clover or lavender spike on Arcadia, a
// glowing fungus cap, ghost bloom or pale reed on Hollowmere, a dry seed head on Meridian. Same
// cells, same instance counts and one draw per cell as the single blades; more vertices per instance.
// Colour varies by clump (lush ↔ dry, from the planet's regions), roots darken (fake AO), tips light
// up toward the sun, travelling wind waves bend the field. Geometry, not alpha cards: alpha test
// defeats hidden-surface removal on Apple GPUs. One material for every body: the species, colours
// and glow are shared uniforms (applyMeadowLook), so a travel compiles nothing.

import * as THREE from "three/webgpu";
import {
  abs, attribute, cameraPosition, cameraViewMatrix, cos, cross, dot, float, floor, Fn, fract, hash, length, max,
  mix, normalize, positionGeometry, positionPrevious, positionWorld, pow, select, sin,
  smoothstep, time, transformDirection, uniform, varying, vec3, renderGroup,
} from "three/tsl";
import type { BodyId } from "@firstlight/shared";
import { atmo } from "./atmosphere.ts";
import { regionLow, smooth01, valueNoise } from "./regionNoise.ts";
import { WORLD_LOOKS, type MeadowLook } from "./worldLooks.ts";

const color = (hex = 0xffffff) => uniform(new THREE.Color(hex)).setGroup(renderGroup);
const four = () => uniform(new THREE.Vector4(1, 1, 1, 1)).setGroup(renderGroup);

export const meadowUniforms = {
  head0: color(), head1: color(), head2: color(), head3: color(), eye: color(),
  glow: four(), stem: four(), size: four(),
  lushRoot: color(), lushTip: color(), dryRoot: color(), dryTip: color(),
  pull: uniform(0.7).setGroup(renderGroup),
  height: uniform(1.45).setGroup(renderGroup),
};

/** What the CPU side needs per clump (flower drifts, dryness): the current body's. */
let cpuLook: MeadowLook = WORLD_LOOKS.arcadia.meadow;

/** Load a body's ground cover into the shared uniforms (one body is live at a time). */
export function applyMeadowLook(body: BodyId) {
  const m = WORLD_LOOKS[body].meadow;
  cpuLook = m;
  const u = meadowUniforms;
  u.head0.value.setHex(m.heads[0]);
  u.head1.value.setHex(m.heads[1]);
  u.head2.value.setHex(m.heads[2]);
  u.head3.value.setHex(m.heads[3]);
  u.eye.value.setHex(m.eye);
  u.glow.value.set(...m.glow);
  u.stem.value.set(...m.stem);
  u.size.value.set(...m.size);
  u.lushRoot.value.setHex(m.lushRoot);
  u.lushTip.value.setHex(m.lushTip);
  u.dryRoot.value.setHex(m.dryRoot);
  u.dryTip.value.setHex(m.dryTip);
  u.pull.value = m.pull;
  u.height.value = m.height;
}

/** Grass cells whose centre is nearer than this (m) use the full clump; farther ones the lite one. */
export const MEADOW_NEAR = 14;

/**
 * One clump in clump space. position: x across the blade (±0.5) or the head disc (x, z in ±1),
 * y = height fraction. `bl` = (root offset x, root offset z, blade yaw, height scale);
 * `part` = 0 blade, 1 head stem, 2 head. Full: 5 curved blades (2 segments) and a 6-point head
 * (22 triangles); lite (far cells, and every cell on Medium): 3 straight blades and a 4-point head (8).
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
  // Head stem (collapsed in the shader unless this clump flowers) and head (a fan disc).
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

/**
 * What a grass cell works out once, at its four corners, for its clumps to interpolate (the slow
 * fields: the region's dryness, and which head species the drift here grows): 8 values, corner
 * order (0,0) (1,0) (0,1) (1,1).
 */
export type CellFields = Float32Array;
const low = { dry: 0, deep: 0 };

/** Fill `out` (8 floats) from the cell's corner points (planet space), in corner order. */
export function meadowCellFields(corners: readonly number[], out: CellFields): CellFields {
  for (let i = 0; i < 4; i++) {
    const x = corners[i * 3]!, y = corners[i * 3 + 1]!, z = corners[i * 3 + 2]!;
    out[i * 2] = regionLow(x, y, z, low).dry;
    out[i * 2 + 1] = valueNoise(x * 0.035 + 3.3, y * 0.035 + 8.8, z * 0.035 + 1.1);
  }
  return out;
}

/**
 * Per-clump data written next to `iPos` (planet-space root; `u`, `v` its place in the cell 0..1;
 * `r` and `r2` uniform randoms): x = dryness 0..1 (the planet's dry regions and straw patches),
 * y = head (0 none, 1–3 a disc species, 4 the spike), z = a second random, w = 0. Heads grow in
 * drifts, one species per drift. `look`: the body's ground cover (default: the one
 * applyMeadowLook loaded). Two noise taps per clump; the slow fields come from the cell.
 */
export function meadowMeta(x: number, y: number, z: number, u: number, v: number, cell: CellFields, r: number, r2: number, out: Float32Array, o: number, look: MeadowLook = cpuLook) {
  const w00 = (1 - u) * (1 - v), w10 = u * (1 - v), w01 = (1 - u) * v, w11 = u * v;
  const regionDry = cell[0]! * w00 + cell[2]! * w10 + cell[4]! * w01 + cell[6]! * w11;
  const speciesField = cell[1]! * w00 + cell[3]! * w10 + cell[5]! * w01 + cell[7]! * w11;
  const patch = valueNoise(x * 0.06 + 1.9, y * 0.06 + 7.3, z * 0.06 + 2.2) * 2 - 1;
  const dry = Math.min(1, Math.max(0, regionDry + look.dryBias + patch * 0.22));
  const drift = smooth01(0.42, 0.75, valueNoise(x * 0.09 + 17.3, y * 0.09 + 4.1, z * 0.09 + 9.7));
  const flowers = r < drift * look.flowerShare + look.flowerBase;
  const sp = Math.min(3, Math.floor(speciesField * 4.6 + (r2 - 0.5) * 0.8));
  out[o] = dry;
  out[o + 1] = flowers ? Math.max(0, sp) + 1 : 0;
  out[o + 2] = r2;
  out[o + 3] = 0;
}

export interface MeadowGrassInputs {
  radius: any;
  height: any;
  width: any;
  windDir: any;
  windStrength: any;
  root: any;
  tip: any;
}

/** One of four per-species values (a vec4 uniform's component, or one of four nodes) by species index. */
const bySpecies = (sp: any, a: any, b: any, c: any, d: any): any => select(sp.lessThan(0.5), a, select(sp.lessThan(1.5), b, select(sp.lessThan(2.5), c, d)));

/** The meadow grass material: same instance attribute (`iPos`) and uniforms as the plain grass, plus `iMeta`. */
export function meadowGrassMaterial(u: MeadowGrassInputs): THREE.MeshLambertNodeMaterial {
  const m = new THREE.MeshLambertNodeMaterial({ side: THREE.DoubleSide });
  m.name = "grass-meadow";
  const mu = meadowUniforms;
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

  // Per-clump data from the CPU (meadowMeta): dryness, head species, a second random.
  const meta = attribute("iMeta", "vec4");
  const flowerOn = meta.y.greaterThan(0.5);
  const species = meta.y.sub(1.0);
  const spike = species.greaterThan(2.5);
  const stemK = bySpecies(species, mu.stem.x, mu.stem.y, mu.stem.z, mu.stem.w);
  const sizeK = bySpecies(species, mu.size.x, mu.size.y, mu.size.z, mu.size.w);

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
    const hStem = stemK.mul(float(0.95).add(seed.mul(0.25)));
    const height = u.height.mul(mu.height).mul(scale).mul(select(isFlower, hStem, bl.w)).mul(fade).mul(keep);
    const hfe = select(isHead, float(1), hf);
    // Wind: travelling waves across the field + gusts + per-clump flutter.
    const along = dot(base, u.windDir);
    const across = dot(base, cross(up, u.windDir));
    const wave = sin(along.mul(0.32).sub(time.mul(1.7)).add(sin(across.mul(0.11)).mul(1.5)));
    const gust = sin(along.mul(0.05).sub(time.mul(0.8)).add(sin(across.mul(0.045)).mul(2.0))).mul(0.5).add(0.5);
    const flutter = sin(time.mul(2.6).add(seed.mul(6.283)).add(bl.z.mul(3.0))).mul(0.08);
    const bend = gust.mul(u.windStrength).add(wave.mul(0.22)).add(flutter).mul(hfe.mul(hfe));
    // Blades splay out of the clump and curve; heads stand straighter.
    const splay = select(isFlower, float(0.12), float(0.55).add(seed.mul(0.25)));
    const lean = hfe.mul(hfe).mul(splay);
    const leanDir = normalize(outward.add(facing.mul(0.35)));
    const stemTop = root
      .add(up.mul(hfe.mul(height)))
      .add(u.windDir.mul(bend).add(leanDir.mul(lean)).mul(height));
    const bladeW = u.width.mul(0.55).mul(select(isFlower, float(0.5), float(1)));
    const bladeP = stemTop.add(side.mul(positionGeometry.x.mul(bladeW).mul(fade.mul(0.5).add(0.5))));
    // Head: a flat disc (petals, a fungus cap), or an upright spike (lavender, a reed, a seed head).
    // Heads right in front of the lens would fill the frame as flat discs: they open from ~1.5 m out.
    const nearHead = smoothstep(1.2, 3.5, dist);
    const grow = keep.mul(fade).mul(nearHead).mul(sizeK);
    // Discs tilt halfway toward the camera so they read as flowers, not slivers.
    const toCam = normalize(cameraPosition.sub(root));
    const tc = normalize(toCam.sub(up.mul(dot(toCam, up))).add(t0.mul(0.001)));
    const a1 = cross(up, tc);
    const a2 = normalize(mix(tc, up, 0.5));
    const disc = a1.mul(positionGeometry.x).add(a2.mul(positionGeometry.z)).mul(float(0.075).mul(grow));
    const spikeP = a1.mul(positionGeometry.x.mul(0.026)).add(up.mul(positionGeometry.z.mul(0.5).add(0.5).mul(0.17))).mul(grow);
    const headP = stemTop.add(select(spike, spikeP, disc));
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

  // Blade palette: the body's grass colours pulled toward its lush colours, dry clumps toward straw.
  const rootC = mix(mix(u.root, mu.lushRoot, mu.pull), mu.dryRoot, vDry.mul(0.5));
  const tipC = mix(mix(u.tip, mu.lushTip, mu.pull), mu.dryTip, vDry);
  const ao = mix(float(0.32), float(1), smoothstep(0.0, 0.5, vHf));
  const bladeCol = mix(rootC, tipC, pow(vHf, 0.85)).mul(vSeed.mul(0.28).add(0.74)).mul(ao);
  const petal = bySpecies(vSpecies, mu.head0, mu.head1, mu.head2, mu.head3);
  const centre = select(vSpecies.lessThan(0.5), mu.eye, petal.mul(0.8));
  const headCol = mix(centre, petal, smoothstep(0.25, 0.45, vRim));
  const stemCol = mix(rootC, tipC, 0.5).mul(0.8);
  const isHeadF = vPart.greaterThan(1.5);
  const c: any = select(isHeadF, headCol, select(vPart.greaterThan(0.5), stemCol, bladeCol));
  m.colorNode = c.mul(mix(float(1), float(0.8), atmo.wet));

  // Translucency: looking toward the sun, thin blades and petals glow at the tips. Heads that light
  // themselves (fungi, ghost blooms) show as the light goes: full at night, faint by day.
  const view = normalize(positionWorld.sub(cameraPosition));
  const back = pow(max(dot(view, atmo.sunDir), 0.0), 3.0);
  const day = smoothstep(-0.02, 0.15, dot(atmo.sunDir, normalize(positionWorld)));
  const glowK = bySpecies(vSpecies, mu.glow.x, mu.glow.y, mu.glow.z, mu.glow.w);
  const selfLit = select(isHeadF, headCol.mul(glowK).mul(atmo.glowBoost.mul(0.9).sub(0.35)), vec3(0));
  // NodeMaterial.setupLighting() honours emissiveNode; the Lambert typings omit it (as in Horses.ts).
  (m as THREE.MeshLambertNodeMaterial & { emissiveNode: THREE.Node | null }).emissiveNode =
    (atmo.sunColor as any).mul(c).mul(back.mul(vHf).mul(0.55).mul(day)).add(selfLit);
  return m;
}

/** Moss on up-facing rock (planet up), broken up by position: for the scattered rock props. */
export function mossy(colIn: any, mossColor: any, amount: any, upness: any, breakup: any): any {
  const moss = smoothstep(0.35, 0.8, upness.add(breakup.mul(0.35).sub(0.15)));
  return mix(colIn, mossColor.mul(breakup.mul(0.6).add(0.6)), moss.mul(amount));
}
