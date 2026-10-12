// Procedural NPC models, built in code from unit primitives (see parts.ts). Local frame: +y up,
// +z forward (facing), +x right; sizes in metres at the def's real scale. All designs are original:
// - Brightbits (Arcadia): chunky voxel boxes, 4-colour palettes, emissive faces and screens.
// - Hollow Court (Hollowmere): bone-white skeletons and robed figures, violet emissive eyes, teal grave-light.
// - Meridian Oversight: identical slate-grey segmented hardsuits (matte) with one amber slit visor and a
//   hexagonal corporate glyph, plus hovering drones (content §3.4). Kept clearly apart from Unit 7
//   (ivory plates, one round lens) and from white-armour clone-trooper looks (F12 review).
// - Wildlife: fluffy Woolbacks (wool colour per planet), slate Dusk Wolves with amber eyes, three beasts.
// - Bosses: Tidewrath (crocodilian-turtle, stone-and-coral shell, cyan vents and chest weak point),
//   the Hollow King (gaunt robed monarch, bone cage-crown with bells, chain veil, bell sceptre),
//   The Receiver (12 m chrome-and-red walker with a dish head, amber floodlights and a rear reactor hatch).

import type { BodyId } from "@firstlight/shared";
import { NPC_DEFS } from "@firstlight/shared/content/npcs";
import type { GeoKey, MatKey } from "./parts.ts";

export type AnimKey = "legL" | "legR" | "legL2" | "legR2" | "armL" | "armR" | "wingL" | "wingR" | "head" | "jaw" | "tail" | "spin" | "roll" | "pulse";
export type Tag = "weak" | "shield" | "aura";
type V = [number, number, number];

export interface PartDef {
  g: GeoKey;
  m: MatKey;
  c: number;
  p: V;
  s: V;
  r?: V;
  a?: AnimKey;
  pv?: V;
  /** Detail part: skipped beyond the detail distance. */
  d?: boolean;
  tag?: Tag;
  /** Linewyrm body segment index (hidden as HP drops). */
  seg?: number;
  /** Glow intensity (glow material only). */
  i?: number;
}

export interface ModelDef {
  style: "hop" | "walk" | "hover" | "float" | "heavy" | "roll" | "swim";
  parts: PartDef[];
  /** Colour of spawn/death light particles, projectiles and wind-up glints. */
  fx: number;
  /** Death bursts into square light-pixels (Brightbits). */
  pixels?: boolean;
  /** Gait phase per metre walked. */
  gait?: number;
}

type O = Omit<Partial<PartDef>, "g" | "m" | "c" | "p" | "s">;
const mk = (g: GeoKey, m: MatKey) => (c: number, p: V, s: V, o: O = {}): PartDef => ({ g, m, c, p, s, ...o });
const box = mk("box", "std"), mbox = mk("box", "metal"), gbox = mk("box", "glow");
const sph = mk("sph", "std"), msph = mk("sph", "metal"), gsph = mk("sph", "glow");
const cyl = mk("cyl", "std"), mcyl = mk("cyl", "metal"), gcyl = mk("cyl", "glow");
const cone = mk("cone", "std"), gcone = mk("cone", "glow");
const tor = mk("tor", "std"), gtor = mk("tor", "glow"), mtor = mk("tor", "metal");
const arc = mk("arc", "std");

/** Left/right pair: `f(side, L)` where side = −1 (left) or +1 (right) and L picks the anim key. */
function pair(f: (s: number, k: (l: AnimKey, r: AnimKey) => AnimKey) => PartDef[]): PartDef[] {
  return [...f(-1, (l) => l), ...f(1, (_l, r) => r)];
}

const HALF_PI = Math.PI / 2;

// ------------------------------------------------------------------------------------ Brightbits

function hopbit(golden = false): ModelDef {
  const MAIN = golden ? 0xffc93a : 0xff7a59, LIGHT = golden ? 0xfff0a0 : 0xffd6a5, ACC = golden ? 0xfff27a : 0xffe14d, DARK = golden ? 0xb8860b : 0x7a2e3a;
  return {
    style: "hop", fx: golden ? 0xffd700 : 0xffe14d, pixels: true, gait: 2.4,
    parts: [
      box(MAIN, [0, 0.42, 0], [0.8, 0.68, 0.78]),
      box(LIGHT, [0, 0.34, 0.33], [0.5, 0.4, 0.14], { d: true }),
      ...pair((s) => [box(MAIN, [0.22 * s, 0.9, -0.05], [0.14, 0.36, 0.14]), gbox(ACC, [0.22 * s, 1.1, -0.05], [0.15, 0.08, 0.15], { d: true, i: 2 })]),
      ...pair((s) => [gbox(golden ? 0xffffff : 0x9ff7ff, [0.17 * s, 0.56, 0.4], [0.13, 0.13, 0.04], { i: 2.6 })]),
      gbox(ACC, [0, 0.38, 0.4], [0.26, 0.05, 0.03], { i: 2 }),
      ...pair((s, k) => [box(DARK, [0.24 * s, 0.06, 0.12], [0.22, 0.12, 0.3], { a: k("legL", "legR"), pv: [0.24 * s, 0.12, 0] })]),
    ],
  };
}

function sparkfly(): ModelDef {
  return {
    style: "hover", fx: 0xfff59a, pixels: true,
    parts: [
      box(0x31d6c4, [0, 0.45, 0], [0.55, 0.5, 0.55]),
      gbox(0xfff59a, [0, 0.45, 0.2], [0.3, 0.3, 0.2], { i: 2.8, a: "pulse" }),
      ...pair((s, k) => [box(0xbff8ff, [0.42 * s, 0.62, -0.05], [0.5, 0.05, 0.32], { a: k("wingL", "wingR"), pv: [0.27 * s, 0.62, 0] })]),
      cyl(0x1d4a52, [0, 0.8, 0.1], [0.04, 0.25, 0.04], { d: true }),
      gbox(0xff5c9a, [0, 0.95, 0.1], [0.08, 0.08, 0.08], { d: true, i: 2.5 }),
      ...pair((s) => [gbox(0xffffff, [0.12 * s, 0.52, 0.28], [0.08, 0.08, 0.03], { i: 2.4 })]),
    ],
  };
}

function linewyrm(): ModelDef {
  const parts: PartDef[] = [
    box(0x9b5cff, [0, 0.45, 0], [0.85, 0.8, 0.85]),
    ...pair((s) => [gbox(0xff4d6d, [0.2 * s, 0.6, 0.43], [0.14, 0.12, 0.03], { i: 2.8 })]),
    box(0x4b2a9a, [0, 0.18, 0.3], [0.7, 0.14, 0.4], { a: "jaw", pv: [0, 0.25, 0.1] }),
  ];
  for (let i = 0; i < 5; i++) {
    parts.push(box(i % 2 ? 0x7a48e0 : 0x6a3dd1, [0, 0.38, -0.85 * (i + 1)], [0.7 - i * 0.05, 0.65 - i * 0.04, 0.7], { seg: i }));
    parts.push(gbox(0x3df5ff, [0, 0.73 - i * 0.02, -0.85 * (i + 1)], [0.32, 0.05, 0.32], { seg: i, i: 2, d: true }));
  }
  return { style: "hop", fx: 0x3df5ff, pixels: true, gait: 2.2, parts };
}

function bomblet(): ModelDef {
  return {
    style: "hop", fx: 0xff9a3d, pixels: true, gait: 2.4,
    parts: [
      box(0x3b2a5a, [0, 0.47, 0], [0.9, 0.85, 0.9]),
      box(0x5b3f8a, [0, 0.47, 0], [0.96, 0.25, 0.96], { d: true }),
      ...pair((s) => [gbox(0xff9a3d, [0.2 * s, 0.6, 0.46], [0.16, 0.16, 0.03], { i: 2.6 })]),
      cyl(0x222222, [0, 0.99, 0], [0.06, 0.25, 0.06]),
      gbox(0xffdd55, [0, 1.15, 0], [0.13, 0.13, 0.13], { a: "pulse", i: 3 }),
      ...pair((s, k) => [box(0x231a36, [0.25 * s, 0.05, 0.1], [0.24, 0.1, 0.3], { a: k("legL", "legR"), pv: [0.25 * s, 0.1, 0] })]),
    ],
  };
}

function pixelLancer(): ModelDef {
  return {
    style: "walk", fx: 0xffd23f, pixels: true, gait: 1.6,
    parts: [
      ...pair((s, k) => [box(0x2b3f8f, [0.17 * s, 0.38, 0], [0.22, 0.76, 0.26], { a: k("legL", "legR"), pv: [0.17 * s, 0.76, 0] })]),
      box(0x4f7bff, [0, 1.15, 0], [0.7, 0.8, 0.48]),
      box(0xe9eef8, [0, 1.2, 0.25], [0.5, 0.5, 0.04], { d: true }),
      box(0xe9eef8, [0, 1.75, 0], [0.48, 0.46, 0.48]),
      gbox(0xffd23f, [0, 1.77, 0.25], [0.36, 0.08, 0.02], { i: 3 }),
      box(0xff5c7a, [0, 2.05, -0.05], [0.08, 0.2, 0.4], { d: true }),
      box(0x4f7bff, [0.45, 1.2, 0.05], [0.2, 0.62, 0.2], { a: "armR", pv: [0.45, 1.48, 0] }),
      cone(0xffd23f, [0.45, 1.0, 1.15], [0.22, 2.2, 0.22], { r: [HALF_PI, 0, 0], a: "armR", pv: [0.45, 1.48, 0] }),
      box(0x2b3f8f, [-0.45, 1.15, 0.15], [0.1, 0.8, 0.6], { a: "armL", pv: [-0.45, 1.48, 0] }),
      gbox(0xffd23f, [-0.51, 1.18, 0.15], [0.02, 0.22, 0.22], { a: "armL", pv: [-0.45, 1.48, 0], d: true, i: 2 }),
    ],
  };
}

function cabinetGolem(): ModelDef {
  return {
    style: "heavy", fx: 0x3df5ff, pixels: true, gait: 1.1,
    parts: [
      ...pair((s, k) => [box(0x3a1d2e, [0.42 * s, 0.55, 0], [0.42, 1.1, 0.5], { a: k("legL", "legR"), pv: [0.42 * s, 1.1, 0] })]),
      box(0xb3243c, [0, 2.1, 0], [1.5, 1.9, 1.15]),
      gbox(0x3df5ff, [0, 2.35, 0.58], [1.05, 0.75, 0.03], { i: 2.2 }),
      ...pair((s) => [box(0x0a2a33, [0.22 * s, 2.42, 0.6], [0.16, 0.16, 0.02])]),
      box(0x0a2a33, [0, 2.18, 0.6], [0.4, 0.06, 0.02]),
      gbox(0xffd23f, [0, 3.0, 0.52], [1.3, 0.2, 0.04], { i: 2.4 }),
      box(0x222222, [0, 1.75, 0.68], [1.3, 0.15, 0.35]),
      gbox(0xff4d6d, [-0.35, 1.84, 0.72], [0.12, 0.05, 0.12], { d: true, i: 2.5 }),
      gbox(0x4dff88, [0, 1.84, 0.72], [0.12, 0.05, 0.12], { d: true, i: 2.5 }),
      gbox(0x4d9bff, [0.35, 1.84, 0.72], [0.12, 0.05, 0.12], { d: true, i: 2.5 }),
      ...pair((s, k) => [
        box(0x7a1428, [0.98 * s, 2.0, 0], [0.42, 1.3, 0.42], { a: k("armL", "armR"), pv: [0.98 * s, 2.6, 0] }),
        box(0x5a0e1e, [0.98 * s, 1.25, 0], [0.55, 0.45, 0.55], { a: k("armL", "armR"), pv: [0.98 * s, 2.6, 0] }),
      ]),
    ],
  };
}

// ------------------------------------------------------------------------------------ Hollow Court

const BONE = 0xe9e1cc;
const VIOLET = 0xb26bff;
const TEAL = 0x4ff0d0;

function skeleton(extra: PartDef[], opts: { blade?: boolean; hood?: boolean } = {}): ModelDef {
  const parts: PartDef[] = [
    sph(BONE, [0, 1.68, 0.02], [0.36, 0.38, 0.38]),
    box(BONE, [0, 1.52, 0.08], [0.22, 0.08, 0.18], { a: "jaw", pv: [0, 1.56, 0] }),
    ...pair((s) => [gbox(VIOLET, [0.08 * s, 1.7, 0.17], [0.07, 0.06, 0.03], { i: 3 })]),
    cyl(BONE, [0, 1.22, -0.02], [0.07, 0.6, 0.07]),
    tor(BONE, [0, 1.36, 0], [0.42, 0.42, 0.5], { r: [HALF_PI, 0, 0] }),
    tor(BONE, [0, 1.24, 0], [0.38, 0.38, 0.5], { r: [HALF_PI, 0, 0], d: true }),
    tor(BONE, [0, 1.12, 0], [0.32, 0.32, 0.5], { r: [HALF_PI, 0, 0], d: true }),
    box(BONE, [0, 0.92, 0], [0.36, 0.14, 0.2]),
    box(0x3a2f4f, [0, 1.05, -0.12], [0.42, 0.4, 0.05], { d: true }),
    ...pair((s, k) => [
      cyl(BONE, [0.12 * s, 0.47, 0], [0.07, 0.9, 0.07], { a: k("legL", "legR"), pv: [0.12 * s, 0.92, 0] }),
      cyl(BONE, [0.27 * s, 1.2, 0], [0.06, 0.62, 0.06], { a: k("armL", "armR"), pv: [0.27 * s, 1.48, 0] }),
    ]),
    ...extra,
  ];
  if (opts.blade) {
    parts.push(mbox(0xb9c7d6, [0.3, 0.78, 0.38], [0.05, 0.08, 0.9], { a: "armR", pv: [0.27, 1.48, 0] }));
    parts.push(gbox(TEAL, [0.3, 0.83, 0.38], [0.02, 0.02, 0.86], { a: "armR", pv: [0.27, 1.48, 0], d: true, i: 2.4 }));
  }
  if (opts.hood) parts.push(cone(0x3a2f4f, [0, 1.86, -0.02], [0.46, 0.5, 0.46], { d: true }));
  return { style: "walk", fx: TEAL, gait: 1.7, parts };
}

function gnawer(): ModelDef {
  return {
    style: "walk", fx: VIOLET, gait: 1.4,
    parts: [
      sph(0x8a8f7a, [0, 0.75, 0], [0.7, 0.55, 1.1], { r: [-0.25, 0, 0] }),
      sph(0xa3a690, [0, 0.85, 0.62], [0.42, 0.38, 0.46], { a: "head", pv: [0, 0.8, 0.45] }),
      box(0x5c5f50, [0, 0.7, 0.78], [0.3, 0.08, 0.25], { a: "jaw", pv: [0, 0.75, 0.65] }),
      ...pair((s) => [gbox(VIOLET, [0.11 * s, 0.92, 0.82], [0.07, 0.05, 0.03], { a: "head", pv: [0, 0.8, 0.45], i: 3 })]),
      ...pair((s, k) => [
        cyl(0x6f735f, [0.25 * s, 0.38, 0.35], [0.1, 0.75, 0.1], { a: k("legL", "legR"), pv: [0.25 * s, 0.75, 0.35] }),
        cyl(0x6f735f, [0.25 * s, 0.35, -0.4], [0.1, 0.7, 0.1], { a: k("legL2", "legR2"), pv: [0.25 * s, 0.7, -0.4] }),
      ]),
      cone(0xc9c4b0, [0, 1.06, 0.1], [0.1, 0.25, 0.1], { d: true }),
      cone(0xc9c4b0, [0, 1.02, -0.25], [0.1, 0.22, 0.1], { d: true }),
    ],
  };
}

function cantor(): ModelDef {
  return {
    style: "walk", fx: VIOLET, gait: 1.5,
    parts: [
      cone(0x4a2a6a, [0, 0.8, 0], [0.9, 1.6, 0.9]),
      cyl(0x3a1f55, [0, 1.45, 0], [0.42, 0.5, 0.36]),
      sph(0x2e1a45, [0, 1.78, 0], [0.5, 0.55, 0.5]),
      sph(0x120a1c, [0, 1.74, 0.12], [0.32, 0.36, 0.2]),
      ...pair((s) => [gbox(VIOLET, [0.07 * s, 1.77, 0.23], [0.06, 0.05, 0.02], { i: 3.2 })]),
      cyl(0x3a1f55, [0.32, 1.35, 0.15], [0.12, 0.5, 0.12], { a: "armR", pv: [0.3, 1.55, 0] }),
      cyl(0xf1e6c8, [0.32, 1.2, 0.3], [0.06, 0.28, 0.06], { a: "armR", pv: [0.3, 1.55, 0] }),
      gbox(0xffb347, [0.32, 1.4, 0.3], [0.08, 0.14, 0.08], { a: "armR", pv: [0.3, 1.55, 0], i: 3 }),
      mtor(0x8c8f99, [0, 1.3, 0], [0.5, 0.5, 0.5], { r: [HALF_PI, 0, 0.3], d: true }),
      cone(0xd9b45a, [-0.3, 1.1, 0.1], [0.14, 0.16, 0.14], { d: true }),
    ],
  };
}

function marshWisp(): ModelDef {
  return {
    style: "float", fx: 0x8affd8,
    parts: [
      gsph(0xc9fff2, [0, 0.45, 0], [0.32, 0.32, 0.32], { a: "pulse", i: 3.2 }),
      gsph(0x2a9a7a, [0, 0.45, 0], [0.62, 0.62, 0.62], { i: 1.4 }),
      gsph(0x6affc8, [0, 0.4, -0.38], [0.15, 0.15, 0.15], { i: 2, d: true }),
      gsph(0x6affc8, [0, 0.35, -0.62], [0.09, 0.09, 0.09], { i: 2, d: true }),
    ],
  };
}

function cryptSentinel(): ModelDef {
  return {
    style: "heavy", fx: TEAL, gait: 1.1,
    parts: [
      ...pair((s, k) => [box(0x5b5566, [0.3 * s, 0.55, 0], [0.34, 1.1, 0.4], { a: k("legL", "legR"), pv: [0.3 * s, 1.1, 0] })]),
      box(0x6e6878, [0, 1.75, 0], [1.0, 1.1, 0.65]),
      tor(BONE, [0, 1.8, 0.05], [0.7, 0.7, 0.8], { r: [HALF_PI, 0, 0], d: true }),
      sph(BONE, [0, 2.5, 0.05], [0.42, 0.44, 0.42]),
      box(0x4a4554, [0, 2.68, 0.0], [0.5, 0.18, 0.5]),
      ...[-0.18, 0, 0.18].map((x) => cone(BONE, [x, 2.9, 0], [0.08, 0.3, 0.08], { d: true })),
      ...pair((s) => [gbox(VIOLET, [0.09 * s, 2.52, 0.24], [0.08, 0.06, 0.02], { i: 3 })]),
      box(0x3f3a48, [-0.7, 1.6, 0.35], [0.14, 1.5, 0.9], { a: "armL", pv: [-0.6, 2.1, 0] }),
      gbox(TEAL, [-0.79, 1.65, 0.35], [0.02, 0.4, 0.4], { a: "armL", pv: [-0.6, 2.1, 0], i: 2, d: true }),
      box(0x6e6878, [0.68, 1.75, 0.1], [0.3, 0.8, 0.3], { a: "armR", pv: [0.6, 2.1, 0] }),
      cyl(0x6b5a45, [0.75, 1.3, 0.45], [0.1, 1.0, 0.1], { r: [0.9, 0, 0], a: "armR", pv: [0.6, 2.1, 0] }),
      msph(0x8d8f99, [0.75, 1.62, 0.88], [0.42, 0.42, 0.42], { a: "armR", pv: [0.6, 2.1, 0] }),
    ],
  };
}

// ------------------------------------------------------------------------------------ Meridian Oversight

// Slate hardsuit plates over a darker segmented undersuit; matte (std material), no chrome.
const SLATE = 0x56606b;
const SLATE_DARK = 0x3a424b;
const GUNMETAL = 0x2c3138;
const AMBER = 0xffb547;
/** Drone casings stay metallic (they're machines, not suits). */
const CHROME = 0x8c96a2;
/** The Receiver's warning lights (boss look, content §4.4). */
const RED = 0xff2a3d;

function trooper(extra: PartDef[] = [], bulk = 1): ModelDef {
  const b = bulk;
  return {
    style: "walk", fx: AMBER, gait: 1.6,
    parts: [
      ...pair((s, k) => [
        box(SLATE, [0.13 * s * b, 0.45, 0], [0.2 * b, 0.9, 0.24 * b], { a: k("legL", "legR"), pv: [0.13 * s * b, 0.9, 0] }),
        box(SLATE_DARK, [0.13 * s * b, 0.5, 0.13 * b], [0.18 * b, 0.12, 0.04], { a: k("legL", "legR"), pv: [0.13 * s * b, 0.9, 0], d: true }),
        box(SLATE, [0.36 * s * b, 1.25, 0], [0.15 * b, 0.55, 0.15 * b], { a: k("armL", "armR"), pv: [0.36 * s * b, 1.5, 0] }),
        box(SLATE_DARK, [0.36 * s * b, 1.48, 0], [0.21 * b, 0.12, 0.21 * b], { d: true }),
      ]),
      // Segmented torso: three horizontal plates with dark gaps.
      box(SLATE_DARK, [0, 1.25, 0], [0.54 * b, 0.62, 0.32 * b]),
      ...[1.06, 1.27, 1.48].map((y) => box(SLATE, [0, y, 0.01], [0.57 * b, 0.17, 0.34 * b])),
      box(GUNMETAL, [0, 0.95, 0], [0.5 * b, 0.08, 0.32 * b], { d: true }),
      // Angular helmet with one narrow amber slit across the face (not a rounded dome, not a T).
      box(SLATE, [0, 1.71, 0], [0.32, 0.34, 0.36]),
      box(SLATE_DARK, [0, 1.6, 0.08], [0.3, 0.12, 0.24], { d: true }),
      gbox(AMBER, [0, 1.74, 0.185], [0.24, 0.035, 0.02], { i: 3.4 }),
      // Hexagonal corporate glyph on the chest.
      gcyl(AMBER, [0, 1.37, 0.18 * b], [0.12, 0.02, 0.12], { r: [HALF_PI, 0, 0], i: 1.4, d: true }),
      gbox(AMBER, [-0.3 * b, 1.45, 0.06], [0.03, 0.08, 0.08], { i: 2, d: true }),
      ...extra,
    ],
  };
}

function associate(): ModelDef {
  return trooper([mbox(0x2c3138, [0.22, 1.18, 0.42], [0.08, 0.12, 0.72], { a: "armR", pv: [0.36, 1.5, 0] })]);
}

function enforcer(): ModelDef {
  return trooper([
    mbox(0x7d8794, [-0.12, 1.15, 0.52], [0.85, 1.3, 0.06], { tag: "shield", a: "armL", pv: [-0.4, 1.5, 0] }),
    gbox(AMBER, [-0.12, 1.75, 0.56], [0.6, 0.04, 0.02], { tag: "shield", a: "armL", pv: [-0.4, 1.5, 0], i: 2 }),
    cyl(0x22262c, [0.42, 0.95, 0.35], [0.06, 0.7, 0.06], { r: [0.6, 0, 0], a: "armR", pv: [0.4, 1.5, 0] }),
  ], 1.15);
}

function complianceOfficer(): ModelDef {
  return trooper([
    box(0x2f353d, [0, 0.82, -0.14], [0.5, 0.75, 0.05]),
    ...pair((s) => [gbox(0xffb547, [0.33 * s, 1.56, 0], [0.18, 0.05, 0.16], { i: 2.2 })]),
    mbox(0x2c3138, [0.22, 1.18, 0.3], [0.07, 0.14, 0.32], { a: "armR", pv: [0.36, 1.5, 0] }),
    gtor(0xffb547, [0, 0.08, 0], [1.6, 1.6, 1.6], { r: [HALF_PI, 0, 0], i: 1.6, tag: "aura" }),
  ]);
}

function collector(): ModelDef {
  return {
    style: "hover", fx: AMBER,
    parts: [
      msph(CHROME, [0, 0.4, 0], [0.7, 0.5, 0.7]),
      gtor(AMBER, [0, 0.4, 0], [0.72, 0.72, 0.72], { r: [HALF_PI, 0, 0], i: 2.6 }),
      gbox(AMBER, [0, 0.42, 0.33], [0.16, 0.08, 0.04], { i: 3.4 }),
      ...pair((s) => [
        box(0x2c3138, [0.38 * s, 0.5, 0], [0.3, 0.06, 0.08], { d: true }),
        cyl(0x2c3138, [0.55 * s, 0.56, 0], [0.42, 0.03, 0.42], { a: "spin" }),
      ]),
      cyl(0x2c3138, [0, 0.1, 0.1], [0.04, 0.25, 0.04], { d: true }),
    ],
  };
}

function auditor(): ModelDef {
  return {
    style: "hover", fx: AMBER,
    parts: [
      box(SLATE, [0, 0.5, 0], [1.2, 0.55, 1.0]),
      mbox(CHROME, [0, 0.2, 0], [1.0, 0.12, 0.85]),
      ...[-0.32, 0, 0.32].map((x) => mcyl(0x2c3138, [x, 0.95, -0.1], [0.18, 0.5, 0.18], { r: [-0.3, 0, 0] })),
      gbox(AMBER, [0, 0.55, 0.51], [0.5, 0.08, 0.03], { i: 3.4 }),
      gtor(0x9a6a1a, [0, 0.12, 0], [1.3, 1.3, 1.3], { r: [HALF_PI, 0, 0], a: "spin", i: 1.6 }),
    ],
  };
}

// ------------------------------------------------------------------------------------ wildlife

const WOOL: Record<BodyId, number> = { portus: 0xf3ead2, arcadia: 0xf3ead2, hollowmere: 0x6e5040, meridian: 0xfbfaf5 };

function woolback(body: BodyId): ModelDef {
  const W = WOOL[body];
  const FACE = 0x3a2e28;
  return {
    style: "walk", fx: 0xfff6dc, gait: 2.4,
    parts: [
      sph(W, [0, 0.7, 0], [1.0, 0.75, 1.25]),
      sph(W, [0.3, 0.82, 0.2], [0.5, 0.5, 0.5], { d: true }),
      sph(W, [-0.3, 0.82, 0.2], [0.5, 0.5, 0.5], { d: true }),
      sph(W, [0, 0.98, -0.15], [0.55, 0.5, 0.6], { d: true }),
      sph(W, [0.28, 0.76, -0.4], [0.45, 0.45, 0.45], { d: true }),
      sph(W, [-0.28, 0.76, -0.4], [0.45, 0.45, 0.45], { d: true }),
      box(FACE, [0, 0.72, 0.68], [0.34, 0.34, 0.36], { a: "head", pv: [0, 0.75, 0.5] }),
      sph(W, [0, 0.92, 0.62], [0.3, 0.22, 0.3], { a: "head", pv: [0, 0.75, 0.5] }),
      ...pair((s, k) => [
        box(FACE, [0.22 * s, 0.82, 0.6], [0.16, 0.06, 0.1], { a: "head", pv: [0, 0.75, 0.5], d: true }),
        box(0xffffff, [0.09 * s, 0.76, 0.86], [0.05, 0.05, 0.02], { a: "head", pv: [0, 0.75, 0.5], d: true }),
        cyl(FACE, [0.22 * s, 0.2, 0.32], [0.09, 0.4, 0.09], { a: k("legL", "legR"), pv: [0.22 * s, 0.4, 0.32] }),
        cyl(FACE, [0.22 * s, 0.2, -0.32], [0.09, 0.4, 0.09], { a: k("legL2", "legR2"), pv: [0.22 * s, 0.4, -0.32] }),
      ]),
    ],
  };
}

function duskWolf(): ModelDef {
  const FUR = 0x3b3f55;
  return {
    style: "walk", fx: 0xffb347, gait: 1.3,
    parts: [
      sph(FUR, [0, 0.75, 0], [0.55, 0.55, 1.25]),
      sph(FUR, [0, 0.8, 0.45], [0.58, 0.62, 0.6], { d: true }),
      sph(0x6d6a7c, [0, 0.62, 0.2], [0.38, 0.3, 0.8], { d: true }),
      box(FUR, [0, 0.95, 0.78], [0.36, 0.34, 0.38], { a: "head", pv: [0, 0.9, 0.6] }),
      box(0x2a2d3d, [0, 0.88, 1.02], [0.2, 0.18, 0.3], { a: "head", pv: [0, 0.9, 0.6] }),
      box(0x2a2d3d, [0, 0.78, 0.98], [0.18, 0.06, 0.26], { a: "jaw", pv: [0, 0.82, 0.85] }),
      ...pair((s, k) => [
        cone(FUR, [0.11 * s, 1.18, 0.72], [0.12, 0.2, 0.1], { a: "head", pv: [0, 0.9, 0.6] }),
        gbox(0xffb347, [0.1 * s, 1.0, 0.97], [0.06, 0.04, 0.02], { a: "head", pv: [0, 0.9, 0.6], i: 3 }),
        cyl(FUR, [0.15 * s, 0.3, 0.42], [0.1, 0.62, 0.1], { a: k("legL", "legR"), pv: [0.15 * s, 0.6, 0.42] }),
        cyl(FUR, [0.15 * s, 0.3, -0.42], [0.1, 0.62, 0.1], { a: k("legL2", "legR2"), pv: [0.15 * s, 0.6, -0.42] }),
      ]),
      cyl(FUR, [0, 0.85, -0.85], [0.1, 0.6, 0.1], { r: [-1.0, 0, 0], a: "tail", pv: [0, 0.85, -0.6] }),
    ],
  };
}

function bramblehorn(): ModelDef {
  const MOSS = 0x4f7a3a, BARK = 0x6b5236, FLOWER = 0xff8fc7;
  const H: V = [0, 3.3, 1.5];
  const antlers: PartDef[] = [];
  for (const s of [-1, 1]) {
    antlers.push(cyl(BARK, [0.45 * s, 4.95, 2.2], [0.13, 1.3, 0.13], { r: [0, 0, -0.45 * s], a: "head", pv: H }));
    antlers.push(cyl(BARK, [0.85 * s, 5.55, 2.1], [0.09, 0.8, 0.09], { r: [0.2, 0, -1.0 * s], a: "head", pv: H }));
    antlers.push(cyl(BARK, [0.6 * s, 5.7, 2.35], [0.08, 0.7, 0.08], { r: [-0.4, 0, -0.2 * s], a: "head", pv: H, d: true }));
    antlers.push(gsph(FLOWER, [1.15 * s, 5.85, 2.1], [0.24, 0.24, 0.24], { a: "head", pv: H, i: 2.2 }));
    antlers.push(gsph(0xfff3a0, [0.65 * s, 6.05, 2.45], [0.18, 0.18, 0.18], { a: "head", pv: H, i: 2.2, d: true }));
    antlers.push(gsph(FLOWER, [0.3 * s, 5.5, 2.0], [0.16, 0.16, 0.16], { a: "head", pv: H, i: 2, d: true }));
  }
  return {
    style: "heavy", fx: FLOWER, gait: 0.55,
    parts: [
      ...pair((s, k) => [
        cyl(BARK, [0.75 * s, 1.3, 1.2], [0.45, 2.6, 0.45], { a: k("legL", "legR"), pv: [0.75 * s, 2.6, 1.2] }),
        cyl(BARK, [0.75 * s, 1.3, -1.2], [0.45, 2.6, 0.45], { a: k("legL2", "legR2"), pv: [0.75 * s, 2.6, -1.2] }),
      ]),
      sph(MOSS, [0, 3.1, 0], [2.4, 1.9, 3.6]),
      sph(0x6f9a48, [0.5, 3.9, -0.4], [1.1, 0.6, 1.3], { d: true }),
      sph(0x6f9a48, [-0.6, 3.8, 0.6], [1.0, 0.55, 1.2], { d: true }),
      cyl(MOSS, [0, 3.7, 1.75], [0.7, 1.4, 0.7], { r: [0.7, 0, 0], a: "head", pv: H }),
      box(MOSS, [0, 4.2, 2.35], [0.9, 0.8, 1.2], { a: "head", pv: H }),
      box(0x3f5f2e, [0, 3.95, 2.95], [0.6, 0.45, 0.4], { a: "head", pv: H }),
      ...pair((s) => [gbox(0xd8ff9a, [0.42 * s, 4.35, 2.7], [0.06, 0.1, 0.12], { a: "head", pv: H, i: 2.6 })]),
      ...antlers,
      cyl(MOSS, [0, 3.3, -1.9], [0.25, 1.0, 0.25], { r: [-0.8, 0, 0], a: "tail", pv: [0, 3.5, -1.7], d: true }),
    ],
  };
}

function fenstalker(): ModelDef {
  const GREY = 0x8c86a3, VIO = 0x6a5f8c, BEAK = 0xe8b33a;
  const H: V = [0, 4.8, 0.6];
  return {
    style: "heavy", fx: 0xd6cfff, gait: 0.5,
    parts: [
      ...pair((s, k) => [
        cyl(0x4c475e, [0.35 * s, 1.9, 0], [0.14, 3.8, 0.14], { a: k("legL", "legR"), pv: [0.35 * s, 3.8, 0] }),
        sph(0x4c475e, [0.35 * s, 2.0, 0], [0.24, 0.24, 0.24], { a: k("legL", "legR"), pv: [0.35 * s, 3.8, 0], d: true }),
        box(0x4c475e, [0.35 * s, 0.05, 0.25], [0.15, 0.08, 0.7], { a: k("legL", "legR"), pv: [0.35 * s, 3.8, 0] }),
        box(VIO, [0.65 * s, 4.6, -0.3], [0.15, 0.9, 2.1], { a: k("wingL", "wingR"), pv: [0.55 * s, 5.0, -0.3] }),
      ]),
      sph(GREY, [0, 4.4, -0.2], [1.4, 1.2, 2.4]),
      cyl(GREY, [0, 5.4, 0.7], [0.22, 1.9, 0.22], { r: [0.5, 0, 0], a: "head", pv: H }),
      sph(GREY, [0, 6.25, 1.2], [0.42, 0.38, 0.5], { a: "head", pv: H }),
      cone(BEAK, [0, 6.2, 1.85], [0.14, 0.95, 0.14], { r: [HALF_PI, 0, 0], a: "head", pv: H }),
      gbox(0xffe36e, [0.16, 6.32, 1.32], [0.04, 0.06, 0.06], { a: "head", pv: H, i: 3 }),
      gbox(0xffe36e, [-0.16, 6.32, 1.32], [0.04, 0.06, 0.06], { a: "head", pv: H, i: 3 }),
      box(VIO, [0, 6.5, 0.9], [0.06, 0.25, 0.7], { r: [-0.3, 0, 0], a: "head", pv: H, d: true }),
      box(VIO, [0, 4.1, -1.5], [0.6, 0.15, 0.9], { r: [0.4, 0, 0], d: true }),
    ],
  };
}

function dunebreaker(): ModelDef {
  const SALT = 0xefe9dc, PLATE = 0xcbbfa6, DARK = 0x6b5a46;
  const C: V = [0, 1.75, 0];
  return {
    style: "roll", fx: 0xfff3dc, gait: 0.9,
    parts: [
      sph(PLATE, [0, 1.75, 0], [3.2, 3.0, 3.8], { a: "roll", pv: C }),
      ...[-1.1, -0.35, 0.4, 1.15].map((z) => tor(SALT, [0, 1.75, z], [3.1, 2.95, 3.1], { a: "roll", pv: C })),
      ...[-0.8, 0, 0.8].map((x) => cone(SALT, [x, 3.3, 0.2], [0.3, 0.5, 0.3], { a: "roll", pv: C, d: true })),
      box(DARK, [0, 1.3, 1.95], [0.9, 0.8, 0.7], { a: "head", pv: [0, 1.4, 1.6] }),
      ...pair((s, k) => [
        gbox(0xff7a3d, [0.25 * s, 1.45, 2.31], [0.12, 0.08, 0.02], { a: "head", pv: [0, 1.4, 1.6], i: 3 }),
        box(DARK, [1.05 * s, 0.35, 0.9], [0.45, 0.7, 0.55], { a: k("legL", "legR"), pv: [1.05 * s, 0.7, 0.9] }),
        box(DARK, [1.05 * s, 0.35, -0.9], [0.45, 0.7, 0.55], { a: k("legL2", "legR2"), pv: [1.05 * s, 0.7, -0.9] }),
      ]),
      cone(PLATE, [0, 1.2, -2.3], [0.6, 1.4, 0.6], { r: [-HALF_PI, 0, 0], a: "tail", pv: [0, 1.2, -1.7] }),
    ],
  };
}

// ------------------------------------------------------------------------------------ bosses

function tidewrath(): ModelDef {
  const STONE = 0x2b2a30, CORAL = 0xff7a5c, CORAL2 = 0xffb38a, VENT = 0x3df5ff, SKIN = 0x3e5a52;
  const H: V = [0, 2.2, 3.6];
  const spikes: PartDef[] = [];
  const spots: [number, number, number, number][] = [[0, 5.2, -0.5, 3.4], [1.6, 4.8, 0.6, 2.6], [-1.7, 4.7, 0.4, 2.8], [2.2, 4.2, -1.9, 2.2], [-2.3, 4.3, -1.6, 2.5], [0.9, 5.0, -2.6, 2.1], [-0.8, 5.1, 1.6, 2.4], [0, 4.6, -3.6, 1.8], [2.8, 3.6, 0.8, 1.6], [-2.9, 3.5, 0.9, 1.7]];
  spots.forEach(([x, y, z, h], i) => spikes.push(cone(i % 2 ? CORAL2 : CORAL, [x, y + h / 2 - 0.3, z], [0.6, h, 0.6], { r: [z * -0.06, 0, x * 0.08] })));
  return {
    style: "swim", fx: VENT, gait: 0.35,
    parts: [
      sph(STONE, [0, 3.2, -0.5], [7.5, 4.2, 9.0]),
      tor(0x3d3b44, [0, 2.3, -0.5], [7.6, 9.1, 3.0], { r: [HALF_PI, 0, 0], d: true }),
      ...spikes,
      ...[-1, 1].flatMap((s) => [gbox(VENT, [3.35 * s, 3.4, 0.6], [0.2, 0.5, 1.4], { i: 2.4 }), gbox(VENT, [3.0 * s, 3.9, -2.2], [0.2, 0.4, 1.1], { i: 2.2 })]),
      box(SKIN, [0, 2.0, 5.3], [2.2, 1.3, 3.6], { a: "head", pv: H }),
      box(0x2f4740, [0, 1.35, 5.2], [2.0, 0.5, 3.2], { a: "jaw", pv: [0, 1.6, 3.6] }),
      ...[-0.7, -0.25, 0.25, 0.7].map((x) => cone(0xf3ecd8, [x, 1.75, 6.6], [0.16, 0.35, 0.16], { r: [Math.PI, 0, 0], a: "head", pv: H, d: true })),
      ...pair((s) => [gbox(0xffd23f, [0.85 * s, 2.6, 4.3], [0.3, 0.2, 0.1], { a: "head", pv: H, i: 3 })]),
      cone(CORAL, [0.6, 3.1, 4.4], [0.35, 1.1, 0.35], { a: "head", pv: H }),
      cone(CORAL2, [-0.6, 3.1, 4.4], [0.35, 1.2, 0.35], { a: "head", pv: H }),
      gsph(VENT, [0, 2.1, 3.3], [1.4, 1.4, 1.0], { tag: "weak", i: 1.6 }),
      ...pair((s, k) => [
        cyl(SKIN, [3.3 * s, 1.0, 2.6], [1.0, 2.4, 1.0], { r: [0, 0, 0.6 * s], a: k("legL", "legR"), pv: [2.8 * s, 2.0, 2.6] }),
        cyl(SKIN, [3.3 * s, 1.0, -2.6], [1.0, 2.4, 1.0], { r: [0, 0, 0.6 * s], a: k("legL2", "legR2"), pv: [2.8 * s, 2.0, -2.6] }),
      ]),
      cyl(SKIN, [0, 1.8, -5.8], [1.2, 3.5, 1.2], { r: [-1.3, 0, 0], a: "tail", pv: [0, 2.0, -4.3] }),
    ],
  };
}

function hollowKing(): ModelDef {
  const ROBE = 0x3b1f5c, ROBE2 = 0x22113a, GOLD = 0xd9b45a;
  const crown: PartDef[] = [];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    crown.push(cone(BONE, [Math.cos(a) * 0.3, 4.3, 0.05 + Math.sin(a) * 0.3], [0.08, 0.7, 0.08], { r: [Math.sin(a) * 0.25, 0, -Math.cos(a) * 0.25] }));
    if (k % 2 === 0) crown.push(cone(GOLD, [Math.cos(a) * 0.36, 4.0, 0.05 + Math.sin(a) * 0.36], [0.1, 0.12, 0.1], { d: true }));
  }
  const veil: PartDef[] = [-0.2, -0.1, 0, 0.1, 0.2].map((x) => mcyl(0x8c8f99, [x, 3.55, 0.34], [0.025, 0.6, 0.025]));
  return {
    style: "heavy", fx: VIOLET, gait: 0.9,
    parts: [
      cone(ROBE, [0, 1.4, 0], [2.0, 2.8, 2.0]),
      ...[0, 1, 2, 3, 4, 5].map((k) => box(ROBE2, [Math.cos(k) * 0.8, 0.2, Math.sin(k) * 0.8], [0.35, 0.4, 0.05], { r: [0, -k, 0], d: true })),
      cyl(ROBE2, [0, 2.9, 0], [0.8, 1.0, 0.6]),
      ...pair((s) => [sph(ROBE, [0.55 * s, 3.3, 0], [0.55, 0.5, 0.55])]),
      sph(BONE, [0, 3.75, 0.05], [0.55, 0.62, 0.55]),
      ...pair((s) => [gbox(VIOLET, [0.12 * s, 3.8, 0.28], [0.09, 0.07, 0.02], { i: 3.4 })]),
      ...veil,
      ...crown,
      ...pair((s, k) => [
        cyl(ROBE, [0.75 * s, 2.9, 0.1], [0.22, 1.2, 0.22], { a: k("armL", "armR"), pv: [0.6 * s, 3.4, 0] }),
        sph(BONE, [0.78 * s, 2.25, 0.2], [0.2, 0.24, 0.2], { a: k("armL", "armR"), pv: [0.6 * s, 3.4, 0] }),
      ]),
      cyl(BONE, [0.8, 2.6, 0.45], [0.08, 2.6, 0.08], { a: "armR", pv: [0.6, 3.4, 0] }),
      cone(GOLD, [0.8, 4.0, 0.45], [0.35, 0.4, 0.35], { a: "armR", pv: [0.6, 3.4, 0] }),
      gsph(0xffe9a8, [0.8, 3.82, 0.45], [0.14, 0.14, 0.14], { a: "armR", pv: [0.6, 3.4, 0], i: 2.6 }),
      gsph(VIOLET, [0, 2.75, 0.32], [0.5, 0.6, 0.2], { tag: "weak", i: 0.8 }),
    ],
  };
}

function receiver(): ModelDef {
  const DARK = 0x2c3138, REDP = 0xc8102e, AMBER = 0xffb547;
  return {
    style: "heavy", fx: RED, gait: 0.35,
    parts: [
      ...pair((s, k) => {
        const pv: V = [1.6 * s, 8.6, 0];
        const a = k("legL", "legR");
        return [
          mbox(CHROME, [1.6 * s, 7.2, 0], [1.2, 3.2, 1.4], { a, pv }),
          box(REDP, [1.6 * s, 3.6, 0.2], [1.1, 4.0, 1.3], { a, pv }),
          mcyl(DARK, [1.6 * s, 5.6, -0.7], [0.3, 3.4, 0.3], { a, pv, d: true }),
          mbox(DARK, [1.6 * s, 0.5, 0.5], [1.8, 1.0, 2.6], { a, pv }),
          mbox(CHROME, [2.6 * s, 9.2, 0.6], [0.8, 2.4, 0.8], { a: k("armL", "armR"), pv: [2.6 * s, 10.6, 0] }),
          mbox(DARK, [2.6 * s, 7.9, 1.6], [0.25, 0.18, 2.4], { a: k("armL", "armR"), pv: [2.6 * s, 10.6, 0] }),
          gbox(s < 0 ? AMBER : 0xff5c3a, [2.5 * s, 11.0, 0], [0.2, 1.4, 2.2], { i: 1.8 }),
          gbox(AMBER, [1.2 * s, 10.9, 1.45], [0.5, 0.35, 0.1], { i: 3.2 }),
        ];
      }),
      mbox(DARK, [0, 8.6, 0], [3.6, 1.0, 1.8]),
      mbox(CHROME, [0, 10.2, 0], [4.2, 2.4, 2.8]),
      box(REDP, [0, 10.2, 1.42], [3.0, 1.6, 0.05]),
      gbox(RED, [0, 10.2, 1.46], [0.6, 0.6, 0.02], { i: 2, d: true }),
      mcyl(DARK, [0, 11.7, 0], [0.6, 0.8, 0.6]),
      mcyl(CHROME, [0, 12.4, 0.4], [2.6, 0.35, 2.6], { r: [HALF_PI - 0.3, 0, 0], a: "head", pv: [0, 11.8, 0] }),
      mcyl(DARK, [0, 12.5, 0.65], [0.15, 0.9, 0.15], { r: [HALF_PI - 0.3, 0, 0], a: "head", pv: [0, 11.8, 0] }),
      gsph(RED, [0, 12.62, 1.05], [0.4, 0.4, 0.4], { a: "head", pv: [0, 11.8, 0], i: 3.4 }),
      gbox(0xff5a2a, [0, 10.0, -1.45], [1.4, 1.4, 0.08], { tag: "weak", i: 1.4 }),
    ],
  };
}

// ------------------------------------------------------------------------------------ registry

export function buildModels(body: BodyId): ModelDef[] {
  const byId: Record<string, () => ModelDef> = {
    hopbit: () => hopbit(),
    golden_hopbit: () => hopbit(true),
    sparkfly,
    linewyrm,
    bomblet,
    pixel_lancer: pixelLancer,
    cabinet_golem: cabinetGolem,
    bonewalker: () => skeleton([], { blade: true }),
    bone_archer: () => skeleton([arc(0x6b4b2b, [-0.32, 1.25, 0.32], [1.0, 1.0, 1.0], { r: [0, -HALF_PI, -HALF_PI], a: "armL", pv: [-0.27, 1.48, 0] }), cyl(0x5a3d22, [0, 1.3, -0.2], [0.14, 0.55, 0.14], { r: [0.3, 0, 0], d: true })], { hood: true }),
    gnawer,
    cantor,
    marsh_wisp: marshWisp,
    crypt_sentinel: cryptSentinel,
    associate,
    enforcer,
    collector,
    auditor,
    compliance_officer: complianceOfficer,
    woolback: () => woolback(body),
    dusk_wolf: duskWolf,
    bramblehorn,
    fenstalker,
    dunebreaker,
    tidewrath,
    hollow_king: hollowKing,
    the_receiver: receiver,
  };
  return NPC_DEFS.map((d) => (byId[d.model] ?? (() => hopbit()))());
}
