// Small vector helpers for planet-centred positions (V3 tuples).

import type { V3 } from "../geometry.ts";

export function len(v: V3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

export function normalize(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

export function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function add(a: V3, b: V3, k = 1): V3 {
  return [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
}

export function scale(a: V3, k: number): V3 {
  return [a[0] * k, a[1] * k, a[2] * k];
}

export function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function dist(a: V3, b: V3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function dist2(a: V3, b: V3): number {
  const x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2];
  return x * x + y * y + z * z;
}

export function up(p: V3): V3 {
  return normalize(p);
}

/** Unit tangent at `from` pointing toward `to` (zero vector if they coincide). */
export function tangentDir(from: V3, to: V3): V3 {
  const u = up(from);
  const d = sub(to, from);
  const k = dot(d, u);
  const t: V3 = [d[0] - u[0] * k, d[1] - u[1] * k, d[2] - u[2] * k];
  const l = Math.hypot(t[0], t[1], t[2]);
  return l < 1e-6 ? [0, 0, 0] : [t[0] / l, t[1] / l, t[2] / l];
}

/** Project a vector onto the tangent plane at `p` and normalise it. */
export function tangentize(p: V3, v: V3): V3 {
  const u = up(p);
  const k = dot(v, u);
  const t: V3 = [v[0] - u[0] * k, v[1] - u[1] * k, v[2] - u[2] * k];
  const l = Math.hypot(t[0], t[1], t[2]);
  return l < 1e-6 ? [0, 0, 0] : [t[0] / l, t[1] / l, t[2] / l];
}

/** Rotate tangent `t` around the local up at `p` by `deg` degrees. */
export function rotateAboutUp(p: V3, t: V3, deg: number): V3 {
  const u = up(p);
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const x = cross(u, t);
  return normalize([t[0] * c + x[0] * s, t[1] * c + x[1] * s, t[2] * c + x[2] * s]);
}

/** A stable tangent at `p` (for idle facing and grid movement axes). */
export function stableTangentAt(p: V3): V3 {
  const u = up(p);
  const ref: V3 = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  return tangentize(p, ref);
}

/** Horizontal (tangent-plane) distance and height difference between two points. */
export function flatDist(a: V3, b: V3): number {
  const u = up(a);
  const d = sub(b, a);
  const k = dot(d, u);
  return Math.hypot(d[0] - u[0] * k, d[1] - u[1] * k, d[2] - u[2] * k);
}

export function heightDiff(a: V3, b: V3): number {
  return len(b) - len(a);
}
