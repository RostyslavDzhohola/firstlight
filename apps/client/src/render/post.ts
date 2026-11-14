// Post pipeline (SPEC §7.1): scene pass → [GTAO (WebGPU High/Ultra)] → [TRAA (opt-in)] → bloom →
// [DoF (photo mode)] → renderOutput (tone map + sRGB) → grade (cdl + saturation + hue) → tone (a gentle
// filmic S-curve and split toning per body, D-gfx-hub-5: a few instructions in the same pass) →
// vignette → grain → FXAA.
// Everything per-body is a shared uniform, so changing planets never rebuilds shaders; only tier or
// feature changes rebuild the pipeline.

import * as THREE from "three/webgpu";
import {
  cdl, convertToTexture, float, rtt, fract, hue, interleavedGradientNoise, luminance, mix, mrt, output, pass, renderOutput,
  screenCoordinate, smoothstep, time, uniform, vec2, vec3, vec4, velocity, renderGroup,
} from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { fxaa } from "three/addons/tsl/display/FXAANode.js";
import { ao } from "three/addons/tsl/display/GTAONode.js";
import { denoise } from "three/addons/tsl/display/DenoiseNode.js";
import { dof } from "three/addons/tsl/display/DepthOfFieldNode.js";
import { traa } from "three/addons/tsl/display/TRAANode.js";
import { vignette } from "three/addons/tsl/display/CRT.js";
import type { BodyId } from "@firstlight/shared";
import type { ResolvedSettings } from "./quality.ts";

export interface GradeParams {
  slope: [number, number, number];
  offset: [number, number, number];
  power: [number, number, number];
  saturation: number;
  /** Hue rotation in radians. */
  hue: number;
}

export const NEUTRAL_GRADE: GradeParams = { slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], saturation: 1, hue: 0 };
/** Look rule 1: menus, lobby and loading are muted. */
export const MENU_GRADE: GradeParams = { slope: [0.96, 0.96, 1.0], offset: [0.01, 0.01, 0.015], power: [1.05, 1.05, 1.0], saturation: 0.62, hue: 0 };

/** Shared post uniforms (one instance per renderer). */
export const postUniforms = {
  bloomStrength: uniform(0.35).setGroup(renderGroup),
  bloomRadius: uniform(0.45).setGroup(renderGroup),
  bloomThreshold: uniform(1.15).setGroup(renderGroup),
  gradeSlope: uniform(new THREE.Vector3(1, 1, 1)).setGroup(renderGroup),
  gradeOffset: uniform(new THREE.Vector3(0, 0, 0)).setGroup(renderGroup),
  gradePower: uniform(new THREE.Vector3(1, 1, 1)).setGroup(renderGroup),
  gradeSat: uniform(1).setGroup(renderGroup),
  gradeHue: uniform(0).setGroup(renderGroup),
  vignette: uniform(0.28).setGroup(renderGroup),
  grain: uniform(0.035).setGroup(renderGroup),
  aoStrength: uniform(0.75).setGroup(renderGroup),
  // Tone (D-gfx-hub-5): S-curve amount, and how far highlights warm and shadows cool.
  toneContrast: uniform(0).setGroup(renderGroup),
  toneSplit: uniform(0).setGroup(renderGroup),
  // Photo mode depth of field (only in the pipeline while photo mode is on).
  dofFocus: uniform(12).setGroup(renderGroup),
  dofFocal: uniform(6).setGroup(renderGroup),
  dofBokeh: uniform(2).setGroup(renderGroup),
};

export function setGrade(g: GradeParams) {
  postUniforms.gradeSlope.value.set(...g.slope);
  postUniforms.gradeOffset.value.set(...g.offset);
  postUniforms.gradePower.value.set(...g.power);
  postUniforms.gradeSat.value = g.saturation;
  postUniforms.gradeHue.value = g.hue;
}

/** Per body: `contrast` 0 … 1 of the filmic S-curve, `split` 0 … 1 of the warm-highlight / cool-shadow toning. */
export interface ToneParams {
  contrast: number;
  split: number;
}

/**
 * The bodies' tone on top of their grade (D-gfx-hub-5). Portus leans warm: its lit windows and lamps
 * read as firelight against the evening. Hollowmere is already dark and moody: the lightest curve.
 */
export const BODY_TONE: Record<BodyId, ToneParams> = {
  portus: { contrast: 0.22, split: 0.55 },
  arcadia: { contrast: 0.18, split: 0.25 },
  hollowmere: { contrast: 0.12, split: 0.3 },
  meridian: { contrast: 0.2, split: 0.35 },
  lumen: { contrast: 0.24, split: 0.15 },
};
export const NEUTRAL_TONE: ToneParams = { contrast: 0, split: 0 };

/** Highlights lean towards this, shadows towards that (display space, luminance-neutral shifts). */
export const SPLIT_WARM: readonly [number, number, number] = [0.07, 0.012, -0.075];
export const SPLIT_COOL: readonly [number, number, number] = [-0.028, 0.0, 0.04];

export function setTone(t: ToneParams) {
  postUniforms.toneContrast.value = t.contrast;
  postUniforms.toneSplit.value = t.split;
}

/** The S-curve on one display-space channel (pure; the shader's formula): fixed at 0, ½ and 1. */
export function toneCurve(c: number, contrast: number): number {
  const x = Math.min(1, Math.max(0, c));
  return x + (x * x * (3 - 2 * x) - x) * contrast;
}

/** The split-tone shift of one channel `i` for a pixel of luminance `l` (pure; the shader's formula). */
export function splitShift(l: number, i: 0 | 1 | 2, split: number): number {
  const sm = (e0: number, e1: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  return (SPLIT_WARM[i] * sm(0.5, 1.0, l) + SPLIT_COOL[i] * sm(0.45, 0.0, l)) * split;
}

export interface PostBuild {
  outputNode: THREE.Node;
  scenePass: ReturnType<typeof pass>;
  dispose(): void;
}

/**
 * Where GTAO's denoise runs when TRAA is off (#66): "full" inline in the full-resolution composite
 * (three's way: 16 taps, each rebuilding a normal from depth, per screen pixel), "ao" into a target at
 * the AO's own resolution and upsampled, "off" raw GTAO (bench only: it is noisy).
 */
export type AoDenoise = "full" | "ao" | "off";

/** Bench-only GTAO override (`?bench=passes`, #52, #66): sample count, resolution scale, denoise. */
export interface AoOverride {
  samples: number;
  scale: number;
  denoise?: AoDenoise;
}

/** The denoise the tiers ship with (D-metrics-6). */
export const AO_DENOISE: AoDenoise = "full";

/** Build the pipeline's output node for the given settings. */
export function buildPost(scene: THREE.Scene, camera: THREE.Camera, s: ResolvedSettings, photo = false, aoOverride: AoOverride | null = null): PostBuild {
  const disposables: { dispose(): void }[] = [];
  const scenePass = pass(scene, camera);
  disposables.push(scenePass);
  if (s.on.traa) scenePass.setMRT(mrt({ output, velocity }));

  let color: any = scenePass.getTextureNode("output");

  if (s.on.ao) {
    // Depth-only GTAO (normals reconstructed from depth): no normal MRT, so materials keep one
    // pipeline variant. WebGPU High/Ultra only (gated in resolveSettings). Raw GTAO is noisy:
    // with TRAA it filters temporally, otherwise a DenoiseNode pass cleans it (three's guidance).
    const depth = scenePass.getTextureNode("depth");
    const aoNode = ao(depth, null as unknown as THREE.Node, camera);
    aoNode.resolutionScale = aoOverride?.scale ?? (s.post.ao === "full" ? 1 : 0.5);
    if (aoOverride) aoNode.samples.value = aoOverride.samples;
    aoNode.radius.value = 0.6;
    aoNode.useTemporalFiltering = s.on.traa;
    disposables.push(aoNode);
    let occ: any = aoNode.getTextureNode().r;
    const mode = aoOverride?.denoise ?? AO_DENOISE;
    if (!s.on.traa && mode !== "off") {
      const dn = denoise(aoNode.getTextureNode(), depth, null as unknown as THREE.Node, camera);
      disposables.push(dn);
      if (mode === "ao") {
        // Denoise once per AO texel, not per screen pixel: a target at the AO's scale, sampled bilinearly.
        const t = rtt(dn as any, null, null, { resolutionScale: aoNode.resolutionScale } as any);
        disposables.push(t);
        occ = (t as any).r;
      } else occ = (dn as any).r;
    }
    color = vec4(color.rgb.mul(mix(float(1), occ, postUniforms.aoStrength)), color.a);
  }

  if (s.on.traa) {
    // Explicit RTT so its render target is ours to dispose (traa() would create it implicitly).
    const input = convertToTexture(color);
    if (input !== color) disposables.push(input);
    const t = traa(input, scenePass.getTextureNode("depth"), scenePass.getTextureNode("velocity"), camera);
    disposables.push(t);
    color = t;
  }

  if (s.on.bloom) {
    const b = bloom(color, postUniforms.bloomStrength, postUniforms.bloomRadius, postUniforms.bloomThreshold);
    b.smoothWidth.value = 0.35;
    b.setResolutionScale(s.post.bloomScale);
    disposables.push(b);
    color = color.add(b);
  }

  if (photo) {
    // Photo mode only: a pipeline rebuild on enter/exit is fine there (no gameplay hitch budget).
    const d = dof(color, scenePass.getViewZNode(), postUniforms.dofFocus, postUniforms.dofFocal, postUniforms.dofBokeh);
    disposables.push(d);
    color = d;
  }

  let out: any = renderOutput(color as any);

  if (s.on.grade) {
    out = cdl(out, postUniforms.gradeSlope, postUniforms.gradeOffset, postUniforms.gradePower, postUniforms.gradeSat);
    out = vec4(hue(out.rgb, postUniforms.gradeHue), out.a);
    // Tone: an S-curve (deeper shadows, brighter highlights, mid-grey where it was), then highlights
    // towards firelight and shadows towards dusk blue. Uniforms: a body change builds nothing.
    const c = out.rgb.clamp(0, 1);
    const curved = c.add(c.mul(c).mul(float(3).sub(c.mul(2))).sub(c).mul(postUniforms.toneContrast));
    const l = luminance(curved);
    const split = vec3(...SPLIT_WARM).mul(smoothstep(0.5, 1.0, l)).add(vec3(...SPLIT_COOL).mul(smoothstep(0.45, 0.0, l)));
    out = vec4(curved.add(split.mul(postUniforms.toneSplit)), out.a);
  }
  if (s.on.vignette) out = vec4(vignette(out.rgb, postUniforms.vignette, float(0.55)), out.a);
  if (s.on.grain) {
    const jitter = vec2(fract(time.mul(7.13)).mul(64), fract(time.mul(3.71)).mul(64));
    const n = interleavedGradientNoise(screenCoordinate.xy.add(jitter)).sub(0.5);
    // Strongest in the mid-tones, like film.
    const l = luminance(out.rgb);
    const w = l.mul(float(1).sub(l)).mul(4).clamp(0.25, 1);
    out = vec4(out.rgb.add(vec3(n.mul(postUniforms.grain).mul(w))), out.a);
  }
  if (s.on.fxaa) {
    const input = convertToTexture(out);
    if (input !== out) disposables.push(input);
    const f = fxaa(input);
    disposables.push(f);
    out = f;
  }

  return {
    outputNode: out,
    scenePass,
    dispose() {
      for (const d of disposables) {
        try {
          d.dispose();
        } catch {
          /* already gone */
        }
      }
    },
  };
}
