// The water ripples' normal (planet graphics review, finding 2): continuous over the whole sphere,
// where the old tangent frame switched its reference axis at |up.y| = 0.95 and the normal jumped on
// those two latitude circles. Lakes cross them on Arcadia, Hollowmere and Meridian (one lies 49 m
// from Meridian's landing pad).
import { describe, expect, it } from "vitest";
import { detailNoiseTexture } from "./noiseTexture.ts";
import { CHOP_GAIN, CHOP_MEAN, chopTilt, RIPPLE_MIX, rippleVector, tangentPart, type Vec3 } from "./waterRipple.ts";

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Texels of the real detail noise, 0..1 per channel. */
const texels = (() => {
  const d = detailNoiseTexture().image.data as Uint8Array;
  const out: [number, number, number, number][] = [];
  for (let i = 0; i < d.length; i += 4 * 37) out.push([d[i]! / 255, d[i + 1]! / 255, d[i + 2]! / 255, d[i + 3]! / 255]);
  return out;
})();

/** The water normal at `up` for one noise tap, as the shader builds it (level 1, dry). */
const normalNow = (up: Vec3, s: readonly number[]): Vec3 => {
  const g = tangentPart(up, rippleVector(s[0]!, s[1]!, s[3]!));
  return norm([up[0] + g[0] * 0.13, up[1] + g[1] * 0.13, up[2] + g[2] * 0.13]);
};

/** The frame the shader used to build: world Y as the reference, or X within 18° of the poles; R and G as slopes along it. */
const normalBefore = (up: Vec3, s: readonly number[]): Vec3 => {
  const ref: Vec3 = Math.abs(up[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
  const t0 = norm(cross(ref, up));
  const t1 = cross(up, t0);
  const a = s[0]! - 0.5, b = s[1]! - 0.5;
  return norm([up[0] + (t0[0] * a + t1[0] * b) * 0.13, up[1] + (t0[1] * a + t1[1] * b) * 0.13, up[2] + (t0[2] * a + t1[2] * b) * 0.13]);
};

/** Unit directions a hair either side of the circle up.y = y, at longitude `a`. */
function across(y: number, a: number, eps = 1e-5): [Vec3, Vec3] {
  const at = (yy: number): Vec3 => {
    const r = Math.sqrt(1 - yy * yy);
    return [Math.cos(a) * r, yy, Math.sin(a) * r];
  };
  return [at(y - eps), at(y + eps)];
}

/**
 * How far the normal moves between two points a hair either side of the circle up.y = y, per unit of
 * the distance between them: the worst over the circle's longitudes and the noise. About 1 where the
 * normal just follows the surface; a step shows as hundreds.
 */
function worstStep(normal: (up: Vec3, s: readonly number[]) => Vec3, y: number): number {
  let worst = 0;
  for (let i = 0; i < 48; i++) {
    const [lo, hi] = across(y, (i / 48) * Math.PI * 2);
    const apart = dist(lo, hi);
    for (let k = 0; k < texels.length; k += 17) worst = Math.max(worst, dist(normal(lo, texels[k]!), normal(hi, texels[k]!)) / apart);
  }
  return worst;
}

describe("water ripples: no jump of the normal across a latitude (review finding 2)", () => {
  it("is continuous across the old switch latitude in both hemispheres, where the old frame stepped", () => {
    for (const y of [0.95, -0.95]) {
      expect(worstStep(normalNow, y), `up.y = ${y}`).toBeLessThan(1.5);
      // The frame it replaces: a few degrees of normal between two points 6e-5 apart.
      expect(worstStep(normalBefore, y), `the old frame at up.y = ${y}`).toBeGreaterThan(300);
    }
  });

  it("is continuous across every other latitude too, up to the poles", () => {
    for (const y of [-0.9999, -0.7, -0.3, 0, 0.3, 0.5, 0.8, 0.9, 0.99, 0.9999]) expect(worstStep(normalNow, y), `up.y = ${y}`).toBeLessThan(1.5);
  });

  it("tilts in the surface's own plane, as much wherever the lake lies as the old slopes did", () => {
    const rms = (up: Vec3) => {
      let sum = 0;
      for (const s of texels) {
        const g = tangentPart(up, rippleVector(s[0], s[1], s[3]));
        expect(Math.abs(dot(g, up))).toBeLessThan(1e-12);
        sum += dot(g, g);
      }
      return Math.sqrt(sum / texels.length);
    };
    let before = 0;
    for (const s of texels) before += (s[0] - 0.5) ** 2 + (s[1] - 0.5) ** 2;
    before = Math.sqrt(before / texels.length);
    const ups: Vec3[] = [[0, 1, 0], [1, 0, 0], [0, 0, 1], norm([1, 1, 1]), norm([0.31, 0.95, 0]), norm([-0.4, -0.2, 0.89])];
    for (const up of ups) {
      const now = rms(up);
      expect(now / before, `up ${up.map((x) => x.toFixed(2)).join(",")}`).toBeGreaterThan(0.9);
      expect(now / before).toBeLessThan(1.15);
    }
  });

  it("mixes the channels by a rotation", () => {
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) expect(dot(RIPPLE_MIX[i]!, RIPPLE_MIX[j]!)).toBeCloseTo(i === j ? 1 : 0, 12);
    }
    expect(len(rippleVector(0.9, 0.2, 0.6))).toBeCloseTo(Math.hypot(0.4, -0.3, 0.1), 12);
  });

  it("rain chop lies in the surface and leans no way on average (the ridged channel is centred on its own mean)", () => {
    const up = norm([0.31, 0.95, 0.05]);
    const mean: [number, number, number] = [0, 0, 0];
    let b = 0, sq = 0;
    for (const s of texels) {
      const c = chopTilt(up, rippleVector(s[0], s[1], s[3]), s[2]);
      expect(Math.abs(dot(c, up))).toBeLessThan(1e-12);
      for (let k = 0; k < 3; k++) mean[k]! += c[k]! / texels.length;
      sq += dot(c, c) / texels.length;
      b += s[2] / texels.length;
    }
    expect(b).toBeCloseTo(CHOP_MEAN, 2);
    expect(CHOP_GAIN).toBeGreaterThan(0);
    // The old chop read the ridged channel about 0.5 and leaned the whole lake 0.38 along one axis.
    expect(len(mean)).toBeLessThan(0.03);
    expect(Math.sqrt(sq)).toBeGreaterThan(0.15); // and it still roughens the water
    expect(Math.sqrt(sq)).toBeLessThan(0.4);
  });
});
