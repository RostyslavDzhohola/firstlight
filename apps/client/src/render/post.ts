// Post pipeline (SPEC §7.1): scene pass → [GTAO (WebGPU High/Ultra)] → [TRAA (opt-in)] → bloom →
// [DoF (photo mode)] → renderOutput (tone map + sRGB) → grade (cdl + saturation + hue) → vignette → grain → FXAA.
// Everything per-body is a shared uniform, so changing planets never rebuilds shaders; only tier or
// feature changes rebuild the pipeline.

import * as THREE from "three/webgpu";
import {
  cdl, convertToTexture, float, fract, hue, interleavedGradientNoise, luminance, mix, mrt, output, pass, renderOutput,
  screenCoordinate, time, uniform, vec2, vec3, vec4, velocity, renderGroup,
} from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { fxaa } from "three/addons/tsl/display/FXAANode.js";
import { ao } from "three/addons/tsl/display/GTAONode.js";
import { denoise } from "three/addons/tsl/display/DenoiseNode.js";
import { dof } from "three/addons/tsl/display/DepthOfFieldNode.js";
import { traa } from "three/addons/tsl/display/TRAANode.js";
import { vignette } from "three/addons/tsl/display/CRT.js";
import type { ResolvedSettings } from "./quality.ts";
import { meadowGrade, meadowOn } from "./meadow.ts";

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

export interface PostBuild {
  outputNode: THREE.Node;
  scenePass: ReturnType<typeof pass>;
  dispose(): void;
}

/** Build the pipeline's output node for the given settings. */
export function buildPost(scene: THREE.Scene, camera: THREE.Camera, s: ResolvedSettings, photo = false): PostBuild {
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
    aoNode.resolutionScale = s.post.ao === "full" ? 1 : 0.5;
    aoNode.radius.value = 0.6;
    aoNode.useTemporalFiltering = s.on.traa;
    disposables.push(aoNode);
    let occ: any = aoNode.getTextureNode().r;
    if (!s.on.traa) {
      const dn = denoise(aoNode.getTextureNode(), depth, null as unknown as THREE.Node, camera);
      disposables.push(dn);
      occ = (dn as any).r;
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
  }
  // `?meadow` (graphics-uplift prototype, off by default): S-curve + saturation after the grade.
  if (meadowOn.grade) out = vec4(meadowGrade(out.rgb), out.a);
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
