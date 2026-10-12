// Fast-travel pads (icosahedron or dodecahedron vertices) and feature anchors.
// Pure arithmetic: no trig, so client and server agree exactly.

import type { BodyDef, FeatureAnchor } from "./bodies.ts";

export type Dir = readonly [number, number, number];

const PHI = (1 + Math.sqrt(5)) / 2;

function normalize(v: [number, number, number]): Dir {
  const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

function sortDirs(dirs: Dir[]): Dir[] {
  return dirs.sort((a, b) => b[1] - a[1] || b[0] - a[0] || b[2] - a[2]);
}

function icosahedron(): Dir[] {
  const v: [number, number, number][] = [];
  for (const s1 of [1, -1]) {
    for (const s2 of [1, -1]) {
      v.push([0, s1, s2 * PHI], [s1, s2 * PHI, 0], [s2 * PHI, 0, s1]);
    }
  }
  return sortDirs(v.map(normalize));
}

function dodecahedron(): Dir[] {
  const v: [number, number, number][] = [];
  for (const a of [1, -1]) for (const b of [1, -1]) for (const c of [1, -1]) v.push([a, b, c]);
  const ip = 1 / PHI;
  for (const s1 of [1, -1]) {
    for (const s2 of [1, -1]) {
      v.push([0, s1 * ip, s2 * PHI], [s1 * ip, s2 * PHI, 0], [s2 * PHI, 0, s1 * ip]);
    }
  }
  return sortDirs(v.map(normalize));
}

const ICOSA = icosahedron();
const DODECA = dodecahedron();
const HUB_ARRIVAL: Dir[] = [[0, 1, 0]];

/** Pad directions for a body. Pad 0 is the main pad (portal home + mission guide). */
export function padDirs(body: BodyDef): readonly Dir[] {
  if (body.padLayout === "icosa") return ICOSA;
  if (body.padLayout === "dodeca") return DODECA;
  return HUB_ARRIVAL;
}

/** Resolve a feature anchor to a unit direction. */
export function anchorDir(body: BodyDef, at: FeatureAnchor): Dir {
  const pads = padDirs(body);
  const sum: [number, number, number] = [0, 0, 0];
  const idx = "pad" in at ? [at.pad] : "mid" in at ? at.mid : at.tri;
  for (const i of idx) {
    const p = pads[i];
    if (!p) throw new Error(`${body.id}: anchor pad ${i} does not exist`);
    sum[0] += p[0];
    sum[1] += p[1];
    sum[2] += p[2];
  }
  return normalize(sum);
}

/** Straight-line (chord) distance in metres between two unit directions on a sphere of radius r. */
export function chordMetres(a: Dir, bx: number, by: number, bz: number, r: number): number {
  const dx = a[0] - bx;
  const dy = a[1] - by;
  const dz = a[2] - bz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) * r;
}

/** Safe-zone radius around every pad (D15). */
export const PAD_SAFE_RADIUS = 12;
/** Flat platform radius around a pad, and where it fully blends back into terrain. */
export const PAD_FLAT_INNER = 10;
export const PAD_FLAT_OUTER = 26;

/** Index of the pad whose safe ring contains this position, or -1. Portus is safe everywhere. */
export function safePadAt(body: BodyDef, x: number, y: number, z: number): number {
  if (body.terrain.kind === "hub") return 0;
  const l = Math.sqrt(x * x + y * y + z * z);
  const pads = padDirs(body);
  for (let i = 0; i < pads.length; i++) {
    if (chordMetres(pads[i]!, x / l, y / l, z / l, body.radius) <= PAD_SAFE_RADIUS) return i;
  }
  return -1;
}

export function isSafe(body: BodyDef, x: number, y: number, z: number): boolean {
  return safePadAt(body, x, y, z) >= 0;
}
