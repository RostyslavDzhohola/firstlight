// A small tileable RGBA noise texture generated on the CPU at startup (no downloads).
// R: fine fbm, G: coarse blotches, B: ridged strata, A: very fine speckle. All centred on 0.5.

import * as THREE from "three/webgpu";
import { hash4 } from "@firstlight/shared";

const SIZE = 256;

function grad(ix: number, iy: number, period: number, seed: number): [number, number] {
  const h = hash4(((ix % period) + period) % period, ((iy % period) + period) % period, seed);
  const a = (h / 4294967296) * Math.PI * 2;
  return [Math.cos(a), Math.sin(a)];
}

/** Periodic 2-D gradient noise in about [-0.7, 0.7]. */
function perlin(x: number, y: number, period: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const g00 = grad(x0, y0, period, seed), g10 = grad(x0 + 1, y0, period, seed);
  const g01 = grad(x0, y0 + 1, period, seed), g11 = grad(x0 + 1, y0 + 1, period, seed);
  const n00 = g00[0] * fx + g00[1] * fy;
  const n10 = g10[0] * (fx - 1) + g10[1] * fy;
  const n01 = g01[0] * fx + g01[1] * (fy - 1);
  const n11 = g11[0] * (fx - 1) + g11[1] * (fy - 1);
  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return a + (b - a) * v;
}

function fbm(px: number, py: number, basePeriod: number, octaves: number, seed: number, ridged = false): number {
  let sum = 0, amp = 0.5, norm = 0, period = basePeriod;
  for (let o = 0; o < octaves; o++) {
    const f = period / SIZE;
    let n = perlin(px * f, py * f, period, seed + o * 101);
    if (ridged) n = 0.5 - Math.abs(n);
    sum += n * amp;
    norm += amp;
    amp *= 0.5;
    period *= 2;
  }
  return sum / norm;
}

let cached: THREE.DataTexture | null = null;

export function detailNoiseTexture(): THREE.DataTexture {
  if (cached) return cached;
  const data = new Uint8Array(SIZE * SIZE * 4);
  const to8 = (v: number) => Math.max(0, Math.min(255, Math.round((0.5 + v) * 255)));
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const o = (y * SIZE + x) * 4;
      data[o] = to8(fbm(x, y, 16, 3, 11) * 1.4);
      data[o + 1] = to8(fbm(x, y, 4, 3, 23) * 1.6);
      data[o + 2] = to8(fbm(x, y, 8, 3, 37, true) * 1.2);
      data[o + 3] = to8(fbm(x, y, 64, 2, 53) * 1.4);
    }
  }
  const tex = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.name = "detailNoise";
  tex.needsUpdate = true;
  cached = tex;
  return tex;
}
