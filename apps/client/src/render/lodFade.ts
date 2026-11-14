// Dithered cross-fade between a prop's two detail levels (#74, D-metrics-2). Trees used to swap from
// the near mesh to the far card at one distance, so walking towards a tree line made every tree change
// shape at once. Now an instance inside the fade band is drawn by both levels, and a stable
// screen-door dither shares the pixels between them: the near mesh keeps the pixels whose threshold is
// at or above the blend, the far card the ones below, so together they cover the tree exactly once, with
// no holes, no blending and no sorting. The blend is a smoothstep of the instance's distance from the
// camera, computed in the shader from its centre (an `iCenter` attribute), so it changes every frame,
// not in the steps of the CPU's instance refresh.
//
// Hysteresis: the CPU refresh (props.ts) runs after the camera moves 2 m or every 400 ms. Each level's
// membership reaches LOD_SLACK m past the band on its own side, so between two refreshes no instance
// can be inside the band without both levels drawing it (no flicker at the band's edge), and the near
// mesh's reach (and so its triangle count) is the tier's `fullTo`, as before.
//
// Only materials that carry the dither may overlap: a kind still drawn with the procedural material
// (the vegetation assets failed to load, or haven't installed yet) keeps the old exclusive split at
// `fullTo` (lodRanges), so it never draws both shapes whole through the band.
//
// Shadows fade with the level (lodShadowKeep): the near mesh's shadow loses the same share of its
// shadow-map texels as its colour loses pixels, so it is gone by the band's end, before the CPU stops
// drawing the near mesh at `fullTo`, instead of dropping whole there. The far card casts no shadow. The
// occluder fade still never touches shadows. The shadow pass renders from the light, so its distance is
// measured from the view camera's position (`lodUniforms.eye`, set every frame by props.ts).

import * as THREE from "three/webgpu";
import { attribute, cameraPosition, float, interleavedGradientNoise, length, renderGroup, screenCoordinate, select, smoothstep, uniform } from "three/tsl";

/** How far (m) the camera can move between two instance refreshes (props.ts update: 2 m), plus a margin. */
export const LOD_SLACK = 2.5;
/** The band's width (m): this fraction of the near mesh's reach, within [LOD_BAND_MIN, LOD_BAND_MAX]. */
export const LOD_BAND_FRACTION = 0.35;
export const LOD_BAND_MIN = 5;
export const LOD_BAND_MAX = 16;

export interface LodBand {
  /** Below this distance only the near mesh shows (blend 0). */
  start: number;
  /** Above it only the far card shows (blend 1). */
  end: number;
  /** The near mesh draws instances nearer than this (the tier's fullTo). */
  nearTo: number;
  /** The far card draws instances at least this far. */
  farFrom: number;
}

/** The fade band for a tier whose near meshes reach `fullTo` m (pure; tested). fullTo 0: no near meshes, no band. */
export function lodBand(fullTo: number): LodBand {
  if (fullTo <= 0) return { start: 0, end: 0, nearTo: 0, farFrom: 0 };
  const end = Math.max(0, fullTo - LOD_SLACK);
  const width = Math.min(LOD_BAND_MAX, Math.max(LOD_BAND_MIN, fullTo * LOD_BAND_FRACTION));
  const start = Math.max(0, end - width);
  return { start, end, nearTo: fullTo, farFrom: Math.max(0, start - LOD_SLACK) };
}

/** Blend (0 near mesh … 1 far card) at distance `d`: the shader's smoothstep (pure; tested). */
export function lodBlend(d: number, band: Pick<LodBand, "start" | "end">): number {
  if (band.end <= band.start) return d >= band.end ? 1 : 0;
  const t = Math.min(1, Math.max(0, (d - band.start) / (band.end - band.start)));
  return t * t * (3 - 2 * t);
}

/** Does the `side` level (1 near, 2 far) keep a pixel whose dither threshold is `noise` (0…1)? Shader's rule (pure; tested). */
export function lodKeeps(side: 0 | 1 | 2, noise: number, blend: number): boolean {
  return side === 0 ? true : side === 1 ? noise >= blend : noise < blend;
}

/** The share of an instance's pixels (and, with lodShadowKeep, shadow texels) the `side` level keeps at distance `d` (pure; tested). */
export function lodCoverage(side: 0 | 1 | 2, d: number, band: Pick<LodBand, "start" | "end">): number {
  const blend = lodBlend(d, band);
  return side === 0 ? 1 : side === 1 ? 1 - blend : blend;
}

/**
 * Which distances each level draws (pure; tested). `faded`: the kind's materials carry the dither, so
 * the levels overlap through the band; otherwise one exclusive split at `fullTo`.
 */
export function lodRanges(fullTo: number, faded: boolean): { nearTo: number; farFrom: number } {
  if (!faded) return { nearTo: fullTo, farFrom: fullTo };
  const b = lodBand(fullTo);
  return { nearTo: b.nearTo, farFrom: b.farFrom };
}

export const lodUniforms = {
  start: uniform(0).setGroup(renderGroup),
  end: uniform(0).setGroup(renderGroup),
  /** The view camera's world position (the shadow pass's own camera is the light's). */
  eye: uniform(new THREE.Vector3()).setGroup(renderGroup),
};

/** Where the view camera is (props.ts, every frame). */
export function setLodEye(p: THREE.Vector3): void {
  lodUniforms.eye.value.copy(p);
}

/** Write the band into the shared uniforms (one per frame at most: props.ts applySettings). */
export function setLodBand(band: LodBand): void {
  lodUniforms.start.value = band.start;
  lodUniforms.end.value = band.end;
}

/** Which level an object draws: `userData.lodSide` 1 near, 2 far; anything else (warm-up samples) never fades. */
const side = uniform(0).onObjectUpdate(({ object }) => {
  const s = (object as THREE.Object3D).userData.lodSide;
  return s === 1 || s === 2 ? s : 0;
});

/** The keep rule for a fragment of an instance seen from `from` (screen coordinate: the pass's own target). */
function keepFrom(from: THREE.Node): THREE.Node {
  const d = length(attribute("iCenter", "vec3").sub(from as never));
  // No band (Low: far cards only, or before the first settings): the far level keeps every pixel.
  const blend = select(lodUniforms.end.greaterThan(lodUniforms.start), smoothstep(lodUniforms.start, lodUniforms.end, d), float(1));
  const noise = interleavedGradientNoise(screenCoordinate.xy);
  const near = noise.greaterThanEqual(blend);
  const far = noise.lessThan(blend);
  return select(side.lessThan(0.5), float(1), select(side.lessThan(1.5), select(near, float(1), float(0)), select(far, float(1), float(0)))).greaterThan(0.5) as unknown as THREE.Node;
}

let keepNode: THREE.Node | null = null;
let shadowKeepNode: THREE.Node | null = null;

/**
 * Keep (true) or drop (false) this fragment of a two-level prop. One node shared by every material
 * that uses it; the geometry must carry an instanced vec3 `iCenter` (the instance's position).
 */
export function lodKeep(): THREE.Node {
  return (keepNode ??= keepFrom(cameraPosition as unknown as THREE.Node));
}

/** The same rule for the shadow pass: the distance from the view camera, the dither in shadow-map texels. */
export function lodShadowKeep(): THREE.Node {
  return (shadowKeepNode ??= keepFrom(lodUniforms.eye as unknown as THREE.Node));
}

type Mask = { and(b: THREE.Node): THREE.Node };

/**
 * Add the cross-fade to `m`'s colour mask (after the occluder fade, so both apply) and to its shadow
 * mask (after the material's own shadow mask, which the occluder fade leaves whole).
 */
export function applyLodFade<M extends THREE.NodeMaterial>(m: M): M {
  const own = m.maskNode as unknown as Mask | null;
  const shadow = (m.maskShadowNode ?? own ?? null) as unknown as Mask | null;
  m.maskNode = own ? own.and(lodKeep()) : lodKeep();
  m.maskShadowNode = shadow ? shadow.and(lodShadowKeep()) : lodShadowKeep();
  return m;
}
