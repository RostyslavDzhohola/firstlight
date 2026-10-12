// Seeded 3D simplex noise (after Stefan Gustavson's public-domain reference) and fbm.
// Uses only + - * and floor, so client (browser) and server (Node) agree exactly.

import { mulberry32 } from "./rng.ts";

const G3 = [
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0,
  1, -1, 0, -1, -1,
];
const F3 = 1 / 3;
const G3C = 1 / 6;

export type Noise3 = (x: number, y: number, z: number) => number;

export function createNoise3(seed: number): Noise3 {
  const rand = mulberry32(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = p[i]!;
    p[i] = p[j]!;
    p[j] = t;
  }
  const perm = new Uint8Array(512);
  const permMod12 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255]!;
    permMod12[i] = perm[i]! % 12;
  }

  return (x, y, z) => {
    const s = (x + y + z) * F3;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const k = Math.floor(z + s);
    const t = (i + j + k) * G3C;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const z0 = z - (k - t);
    let i1: number, j1: number, k1: number, i2: number, j2: number, k2: number;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }
    const x1 = x0 - i1 + G3C, y1 = y0 - j1 + G3C, z1 = z0 - k1 + G3C;
    const x2 = x0 - i2 + 2 * G3C, y2 = y0 - j2 + 2 * G3C, z2 = z0 - k2 + 2 * G3C;
    const x3 = x0 - 1 + 3 * G3C, y3 = y0 - 1 + 3 * G3C, z3 = z0 - 1 + 3 * G3C;
    const ii = i & 255, jj = j & 255, kk = k & 255;
    let n = 0;
    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
      const g = permMod12[ii + perm[jj + perm[kk]!]!]! * 3;
      t0 *= t0;
      n += t0 * t0 * (G3[g]! * x0 + G3[g + 1]! * y0 + G3[g + 2]! * z0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
      const g = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]!]!]! * 3;
      t1 *= t1;
      n += t1 * t1 * (G3[g]! * x1 + G3[g + 1]! * y1 + G3[g + 2]! * z1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) {
      const g = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]!]!]! * 3;
      t2 *= t2;
      n += t2 * t2 * (G3[g]! * x2 + G3[g + 1]! * y2 + G3[g + 2]! * z2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
      const g = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]!]!]! * 3;
      t3 *= t3;
      n += t3 * t3 * (G3[g]! * x3 + G3[g + 1]! * y3 + G3[g + 2]! * z3);
    }
    return 32 * n; // roughly [-1, 1]
  };
}

/** Fractal Brownian motion: `octaves` layers, each at double frequency and `gain` amplitude. */
export function fbm(noise: Noise3, x: number, y: number, z: number, octaves: number, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * freq, y * freq, z * freq);
    norm += amp;
    amp *= gain;
    freq *= 2;
  }
  return sum / norm;
}
