// Single-scattering sky (Rayleigh + Mie), integrated on the CPU into a small sky-view LUT.
//
// The sun sits at a fixed elevation in the player's local frame on each body (it follows the
// player), so the sky only depends on (view elevation, azimuth from the sun). We integrate the
// classic single-scatter model (Nishita-style; constants as in wwwtyro/glsl-atmosphere, Earth-like
// proportions in km) once per body with 16 primary / 8 light steps and upload a 64×32 half-float
// texture. The shader samples it with one fetch, so background, fog colour and water reflections
// all agree and the per-pixel cost doesn't depend on the step count.

import * as THREE from "three/webgpu";
import type { BodyLook } from "./looks.ts";

export const LUT_W = 64;
export const LUT_H = 32;
/** Slices by sun elevation (day/night): the atlas is LUT_W × (LUT_H · LUT_SLICES). */
export const LUT_SLICES = 12;

const R_PLANET = 6371; // km
const R_ATMOS = 6471;
const VIEW_ALT = 1.0;
const SH_RLH = 8.0;
const SH_MIE = 1.2;
const K_RLH = [5.5e-3, 13.0e-3, 22.4e-3]; // per km
const K_MIE = 21e-3;
const G = 0.758;

/** Ray-sphere intersection (sphere at origin). Returns [near, far] or null. */
function rsi(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, r: number): [number, number] | null {
  const b = 2 * (dx * ox + dy * oy + dz * oz);
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const d = b * b - 4 * c;
  if (d < 0) return null;
  const s = Math.sqrt(d);
  return [(-b - s) / 2, (-b + s) / 2];
}

export interface ScatterParams {
  sunElev: number;
  /** Overall brightness multiplier. */
  gain?: number;
  rayleigh: [number, number, number];
  mie: number;
  steps: [number, number];
}

/** Radiance (relative units) towards dir for a sun at `sun` (both unit vectors, up = +Y). */
function scatter(dx: number, dy: number, dz: number, sx: number, sy: number, sz: number, p: ScatterParams, out: number[]) {
  const ox = 0, oy = R_PLANET + VIEW_ALT, oz = 0;
  const kR = [K_RLH[0]! * p.rayleigh[0], K_RLH[1]! * p.rayleigh[1], K_RLH[2]! * p.rayleigh[2]];
  const kM = K_MIE * p.mie;
  const hit = rsi(ox, oy, oz, dx, dy, dz, R_ATMOS)!;
  const tMax = hit[1];
  const [iSteps, jSteps] = p.steps;
  const ds = tMax / iSteps;
  let odR = 0, odM = 0;
  const totR = [0, 0, 0];
  const totM = [0, 0, 0];
  for (let i = 0; i < iSteps; i++) {
    const t = ds * (i + 0.5);
    const px = ox + dx * t, py = oy + dy * t, pz = oz + dz * t;
    const h = Math.hypot(px, py, pz) - R_PLANET;
    const hr = Math.exp(-h / SH_RLH) * ds;
    const hm = Math.exp(-h / SH_MIE) * ds;
    odR += hr;
    odM += hm;
    // Light ray to the sun.
    const lh = rsi(px, py, pz, sx, sy, sz, R_ATMOS);
    if (!lh) continue;
    const dl = lh[1] / jSteps;
    let lR = 0, lM = 0;
    let shadowed = false;
    for (let j = 0; j < jSteps; j++) {
      const tl = dl * (j + 0.5);
      const qx = px + sx * tl, qy = py + sy * tl, qz = pz + sz * tl;
      const lhgt = Math.hypot(qx, qy, qz) - R_PLANET;
      if (lhgt < 0) {
        shadowed = true;
        break;
      }
      lR += Math.exp(-lhgt / SH_RLH) * dl;
      lM += Math.exp(-lhgt / SH_MIE) * dl;
    }
    if (shadowed) continue;
    for (let c = 0; c < 3; c++) {
      const att = Math.exp(-(kM * (odM + lM) + kR[c]! * (odR + lR)));
      totR[c] += hr * att;
      totM[c] += hm * att;
    }
  }
  const mu = dx * sx + dy * sy + dz * sz;
  const pR = (3 / (16 * Math.PI)) * (1 + mu * mu);
  const gg = G * G;
  const pM = (3 / (8 * Math.PI)) * ((1 - gg) * (mu * mu + 1)) / (Math.pow(1 + gg - 2 * mu * G, 1.5) * (2 + gg));
  const k = p.gain ?? 1;
  for (let c = 0; c < 3; c++) out[c] = (pR * kR[c]! * totR[c]! + pM * kM * totM[c]!) * k;
}

/**
 * Build one LUT slice (RGBA float, linear) for a sun elevation. Texel (i, j): azimuth from the sun
 * φ = (i + .5)/W·π, elevation sine e = s² with s = (j + .5)/H (upper hemisphere only, dense at the
 * horizon; below the horizon the shader blends to the art haze colour). `gains` (per row, per
 * channel) are applied when given.
 */
function buildSlice(sunElev: number, p: Omit<ScatterParams, "sunElev">, gain: number, gains: Float32Array | null, out: Float32Array, offset: number) {
  const sx = Math.cos(sunElev), sy = Math.sin(sunElev), sz = 0;
  const params: ScatterParams = { ...p, sunElev, gain };
  const px = [0, 0, 0];
  for (let j = 0; j < LUT_H; j++) {
    const s = (j + 0.5) / LUT_H;
    const e = Math.max(0.002, s * s);
    const ca = Math.sqrt(Math.max(0, 1 - e * e));
    for (let i = 0; i < LUT_W; i++) {
      const phi = ((i + 0.5) / LUT_W) * Math.PI;
      scatter(ca * Math.cos(phi), e, ca * Math.sin(phi), sx, sy, sz, params, px);
      const o = offset + (j * LUT_W + i) * 4;
      for (let c = 0; c < 3; c++) out[o + c] = px[c]! * (gains ? gains[j * 3 + c]! : 1);
      out[o + 3] = 1;
    }
  }
}

/**
 * Build the LUT atlas for a body: LUT_SLICES slices for sun elevations spanning the body's day
 * (`elevRange`), stacked vertically. The shader picks two slices by the current sun elevation
 * and blends them, so the sky follows the day/night clock with uniforms only.
 *
 * Art calibration happens once, at the body's reference sun elevation (`look.sunElev`): each row is
 * scaled per channel so its azimuth-averaged colour equals the art gradient at that elevation.
 * The same gains apply to every slice, so dusk reddens and night darkens physically while the
 * body keeps its palette.
 */
export function buildSkyLutData(look: BodyLook, p: Omit<ScatterParams, "sunElev">, elevRange: [number, number] = [look.sunElev, look.sunElev]): Float32Array {
  const sliceSize = LUT_W * LUT_H * 4;
  const data = new Float32Array(sliceSize * LUT_SLICES);
  const hz = new THREE.Color(look.horizon);
  const md = new THREE.Color(look.mid);
  const zn = new THREE.Color(look.zenith);
  const ref = Math.max(elevRange[0], Math.min(elevRange[1], look.sunElev));
  const out = [0, 0, 0];
  // Brightness: bring the raw model to the palette's luminance at the reference elevation.
  let gain = 1;
  {
    const params: ScatterParams = { ...p, sunElev: ref };
    const sx = Math.cos(ref), sy = Math.sin(ref);
    let lum = 0, n = 0;
    for (let k = 0; k < 64; k++) {
      const e = 0.05 + (k / 63) * 0.9;
      const ca = Math.sqrt(1 - e * e);
      const phi = ((k % 8) / 8) * Math.PI;
      scatter(ca * Math.cos(phi), e, ca * Math.sin(phi), sx, sy, 0, params, out);
      lum += 0.2126 * out[0]! + 0.7152 * out[1]! + 0.0722 * out[2]!;
      n++;
    }
    const artLum = (0.2126 * (hz.r + md.r + zn.r) + 0.7152 * (hz.g + md.g + zn.g) + 0.0722 * (hz.b + md.b + zn.b)) / 3;
    gain = lum > 0 ? artLum / (lum / n) : 1;
  }
  // Per-row channel gains at the reference elevation.
  const refSlice = new Float32Array(sliceSize);
  buildSlice(ref, p, gain, null, refSlice, 0);
  const gains = new Float32Array(LUT_H * 3);
  for (let j = 0; j < LUT_H; j++) {
    const s = (j + 0.5) / LUT_H;
    const e = Math.max(0.002, s * s);
    const avg = [0, 0, 0];
    for (let i = 0; i < LUT_W; i++) for (let c = 0; c < 3; c++) avg[c] += refSlice[(j * LUT_W + i) * 4 + c]! / LUT_W;
    const target = artSkyRow(hz, md, zn, e);
    for (let c = 0; c < 3; c++) gains[j * 3 + c] = Math.max(0.1, Math.min(10, target[c]! / Math.max(1e-6, avg[c]!)));
  }
  for (let k = 0; k < LUT_SLICES; k++) {
    const elev = sliceElev(k, elevRange);
    buildSlice(elev, p, gain, gains, data, k * sliceSize);
  }
  return data;
}

/** Sun elevation of slice k for a body's elevation range. */
export function sliceElev(k: number, [lo, hi]: [number, number]): number {
  return lo + ((hi - lo) * k) / (LUT_SLICES - 1);
}

/** Fractional slice index for a sun elevation (clamped). */
export function sliceFor(elev: number, [lo, hi]: [number, number]): number {
  if (hi - lo < 1e-6) return 0;
  return Math.max(0, Math.min(LUT_SLICES - 1, ((elev - lo) / (hi - lo)) * (LUT_SLICES - 1)));
}

/** Mid-sky stop elevation (sine). Shared with the shader's art gradient. */
export const SKY_MID_E = 0.22;

const smooth01 = (t: number) => t * t * (3 - 2 * t);

/** The art gradient at elevation sine e (same formula as skyColor's analytic part). */
export function artSkyRow(hz: THREE.Color, md: THREE.Color, zn: THREE.Color, e: number): [number, number, number] {
  const t1 = smooth01(Math.min(1, Math.max(0, e / SKY_MID_E)));
  const t2 = Math.pow(Math.min(1, Math.max(0, (e - SKY_MID_E) / (1 - SKY_MID_E))), 0.6);
  const a = [hz.r + (md.r - hz.r) * t1, hz.g + (md.g - hz.g) * t1, hz.b + (md.b - hz.b) * t1];
  return [a[0]! + (zn.r - a[0]!) * t2, a[1]! + (zn.g - a[1]!) * t2, a[2]! + (zn.b - a[2]!) * t2];
}

let lutTexture: THREE.DataTexture | null = null;

/** The shared LUT atlas (one object for the app; its pixels change per body). */
export function skyLutTexture(): THREE.DataTexture {
  if (!lutTexture) {
    const data = new Uint16Array(LUT_W * LUT_H * LUT_SLICES * 4);
    data.fill(THREE.DataUtils.toHalfFloat(0.5));
    lutTexture = new THREE.DataTexture(data, LUT_W, LUT_H * LUT_SLICES, THREE.RGBAFormat, THREE.HalfFloatType);
    lutTexture.magFilter = THREE.LinearFilter;
    lutTexture.minFilter = THREE.LinearFilter;
    lutTexture.wrapS = THREE.ClampToEdgeWrapping;
    lutTexture.wrapT = THREE.ClampToEdgeWrapping;
    lutTexture.generateMipmaps = false;
    lutTexture.colorSpace = THREE.NoColorSpace;
    lutTexture.name = "skyLut";
    lutTexture.needsUpdate = true;
  }
  return lutTexture;
}

const cache = new Map<string, Uint16Array>();

/**
 * Fill the shared LUT atlas for a body (cached per body; ~100 ms the first time, behind the loading
 * screen). `elevRange` = the body's sun elevation range over the day.
 */
export function applySkyLut(bodyKey: string, look: BodyLook, elevRange: [number, number]) {
  const tex = skyLutTexture();
  const key = `${bodyKey}:${elevRange[0].toFixed(3)}:${elevRange[1].toFixed(3)}`;
  let half = cache.get(key);
  if (!half) {
    const f = buildSkyLutData(look, { rayleigh: look.scatter.rayleigh, mie: look.scatter.mie, steps: [12, 6] }, elevRange);
    half = new Uint16Array(f.length);
    for (let i = 0; i < f.length; i++) half[i] = THREE.DataUtils.toHalfFloat(Math.min(f[i]!, 60000));
    cache.set(key, half);
  }
  (tex.image.data as Uint16Array).set(half);
  tex.needsUpdate = true;
}
