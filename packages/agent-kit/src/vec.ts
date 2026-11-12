// Small vector helpers on a sphere, as plain number triples (no three.js: the kit runs in Node).
//
// Bearings are compass degrees in the local frame the game's content uses (shared
// content/places.ts tangentFrame): 0 = north, 90 = east, clockwise seen from above.

import { tangentFrame } from "@firstlight/shared/content/places";

export type V3 = [number, number, number];

export const len = (a: readonly number[]): number => Math.hypot(a[0]!, a[1]!, a[2]!);
export const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
export const add = (a: readonly number[], b: readonly number[]): V3 => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
export const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
export const scale = (a: readonly number[], k: number): V3 => [a[0]! * k, a[1]! * k, a[2]! * k];
export const addScaled = (a: readonly number[], b: readonly number[], k: number): V3 => [a[0]! + b[0]! * k, a[1]! + b[1]! * k, a[2]! + b[2]! * k];
export const dist = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
export const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];

export function norm(a: readonly number[]): V3 {
  const l = len(a) || 1;
  return [a[0]! / l, a[1]! / l, a[2]! / l];
}

/** `v` without its part along unit `up`, normalised; null when nothing is left (v is vertical). */
export function tangent(up: readonly number[], v: readonly number[]): V3 | null {
  const k = dot(v, up);
  const t: V3 = [v[0]! - up[0]! * k, v[1]! - up[1]! * k, v[2]! - up[2]! * k];
  const l = len(t);
  return l > 1e-9 ? [t[0] / l, t[1] / l, t[2] / l] : null;
}

/** Metres along the ground between two positions (the arc at `a`'s radius). */
export function groundDistance(a: readonly number[], b: readonly number[]): number {
  const la = len(a), lb = len(b);
  if (!(la > 0) || !(lb > 0)) return 0;
  const k = Math.max(-1, Math.min(1, dot(a, b) / (la * lb)));
  return Math.acos(k) * la;
}

/** Compass bearing (degrees, 0 = north, 90 = east) of a tangent direction at unit `up`. */
export function bearingOfDir(up: readonly number[], dir: readonly number[]): number {
  const f = tangentFrame(up as V3);
  const deg = (Math.atan2(dot(dir, f.east), dot(dir, f.north)) * 180) / Math.PI;
  return Math.round(((deg % 360) + 360) % 360);
}

/** Compass bearing from position `from` to position `to` (0 when they are on top of each other). */
export function bearingTo(from: readonly number[], to: readonly number[]): number {
  const up = norm(from);
  const t = tangent(up, sub(to, from));
  return t ? bearingOfDir(up, t) : 0;
}

/** Unit tangent at unit `up` pointing along a compass bearing. */
export function dirOfBearing(up: readonly number[], bearing: number): V3 {
  const f = tangentFrame(up as V3);
  const r = (bearing * Math.PI) / 180;
  return norm([f.north[0] * Math.cos(r) + f.east[0] * Math.sin(r), f.north[1] * Math.cos(r) + f.east[1] * Math.sin(r), f.north[2] * Math.cos(r) + f.east[2] * Math.sin(r)]);
}

/** Turn unit tangent `d` about unit `up` by `deg` degrees (clockwise seen from above: towards east from north). */
export function turn(up: readonly number[], d: readonly number[], deg: number): V3 {
  const r = (deg * Math.PI) / 180;
  // right = d × up is 90° clockwise from d (east from north).
  const right = cross(d, up);
  return norm([d[0]! * Math.cos(r) + right[0] * Math.sin(r), d[1]! * Math.cos(r) + right[1] * Math.sin(r), d[2]! * Math.cos(r) + right[2] * Math.sin(r)]);
}

/** Eight-point compass name of a bearing ("N", "NE", …). */
export function compass(bearing: number): string {
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round((((bearing % 360) + 360) % 360) / 45) % 8]!;
}
