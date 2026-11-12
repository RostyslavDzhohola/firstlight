// The portal vortex (D-gfx-hub-2): what fills a portal's opening on Medium and up. One flat mesh and
// one draw per portal, like the plain membrane it replaces; everything is in the fragment shader:
//   - three swirl layers at different depths behind the opening (the view direction shifts the deep
//     ones: parallax, so the portal reads as a tunnel, not a decal);
//   - at the far end, the destination's sky (its zenith and horizon colours);
//   - a bright rim along the opening's edge, motes drifting inwards;
//   - a pulse (a ring racing outwards and a flash) when someone passes through (Portals.pulseNear).
// Brighter at night through the shared glow uniform, so it carries across the plaza at any hour.

import * as THREE from "three/webgpu";
import {
  abs, atan, cameraPosition, exp, float, floor, fract, length, log, max, min, mix, modelWorldMatrixInverse, normalize, positionLocal, sin,
  smoothstep, time, uniform, vec2, vec3, vec4,
} from "three/tsl";
import type { BodyId } from "@firstlight/shared";
import { atmo } from "../render/atmosphere.ts";
import { LOOKS } from "../render/looks.ts";

/** The opening in the mesh's own frame (x right, y up): an arch (gate A) or a disc (the ring). */
export type VortexShape = { kind: "arch"; base: number; spring: number; half: number } | { kind: "disc"; radius: number };

/** Seconds a pulse lasts (the uniform holds its age; anything older is no pulse). */
export const PULSE_SECONDS = 1.6;

export interface PortalVortex {
  material: THREE.MeshBasicNodeMaterial;
  /** Age of the last pulse in seconds (PULSE_SECONDS or more: none). */
  pulseAge: { value: number };
}

/** Distance from `p` (m, the opening's frame) to the opening's edge, positive inside (pure; the shader's formula). */
export function vortexEdge(shape: VortexShape, x: number, y: number): number {
  if (shape.kind === "disc") return shape.radius - Math.hypot(x, y);
  return Math.min(shape.half - Math.hypot(x, Math.max(y - shape.spring, 0)), y - shape.base);
}

export function vortexMaterial(to: BodyId, color: number, shape: VortexShape): PortalVortex {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  m.name = "portal_vortex";
  const pulseAge = uniform(PULSE_SECONDS);
  const tint = vec3(...new THREE.Color(color).toArray());
  const look = LOOKS[to];
  const zenith = vec3(...new THREE.Color(look.zenith).toArray());
  const horizon = vec3(...new THREE.Color(look.horizon).toArray());

  const P = positionLocal.xy;
  // The opening's centre and half-height, and the distance to its edge.
  const cy = shape.kind === "arch" ? (shape.base + shape.spring + shape.half) / 2 : 0;
  const halfH = shape.kind === "arch" ? (shape.spring + shape.half - shape.base) / 2 : shape.radius;
  const halfW = shape.kind === "arch" ? shape.half : shape.radius;
  const edge =
    shape.kind === "arch"
      ? min(float(shape.half).sub(length(vec2(P.x, max(P.y.sub(shape.spring), 0)))), P.y.sub(shape.base))
      : float(shape.radius).sub(length(P));

  // Parallax: the view ray's slope in the mesh's frame moves the deeper layers.
  const camLocal = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
  const ray = normalize(positionLocal.sub(camLocal));
  const slope = ray.xy.div(max(abs(ray.z), 0.3));
  const squash = vec2(1, halfW / halfH); // the swirl fills a tall opening as an ellipse
  const layer = (depth: number) => P.sub(vec2(0, cy)).add(slope.mul(depth)).mul(squash);
  const swirl = (q: any, arms: number, twist: number, speed: number) =>
    sin(atan(q.y, q.x).mul(arms).add(log(length(q).add(0.12)).mul(twist)).sub(time.mul(speed))).mul(0.5).add(0.5);

  const qFar = layer(2.2);
  const qMid = layer(0.9);
  const qNear = layer(0.0);
  const rFar = length(qFar);
  const rNear = length(qNear);

  // The far end: the destination's sky, a soft sun low in it, seen down the tunnel.
  const tunnel = smoothstep(halfW * 0.95, halfW * 0.1, rFar);
  const skyUp = smoothstep(-halfW * 0.5, halfW * 0.6, qFar.y);
  const sky = mix(horizon, zenith, skyUp).mul(0.75).add(horizon.mul(exp(length(qFar.sub(vec2(0, -halfW * 0.12))).mul(-2.6)).mul(1.4)));
  const farArms = swirl(qFar, 2, 5.5, 0.5);
  const deep = sky.mul(tunnel).mul(farArms.mul(0.35).add(0.65));

  // The arms: wide and slow behind, thin and quick in front; dark towards the centre so the sky shows.
  const mid = swirl(qMid, 3, 4.2, 0.9);
  const near = swirl(qNear, 5, 7.0, 1.6).pow(3);
  const out = smoothstep(halfW * 0.05, halfW * 0.85, rNear);
  const arms = tint.mul(mid.mul(0.55).add(near.mul(0.95)).mul(out.mul(0.8).add(0.2)));

  // The rim, and the membrane's soft edge.
  const rim = exp(edge.max(0).mul(-3.4));
  const rimGlow = tint.mul(rim.mul(2.1));

  // Motes drifting inwards: one per angular cell, each on its own clock.
  const CELLS = 26;
  const ang = atan(qNear.y, qNear.x).div(Math.PI * 2).add(0.5).mul(CELLS);
  const cell = floor(ang);
  const h = fract(sin(cell.mul(12.9898)).mul(43758.5453));
  const along = fract(time.mul(h.mul(0.16).add(0.1)).add(h.mul(7.0)));
  const at = float(1).sub(along).mul(halfW * 1.05);
  const dot = smoothstep(0.1, 0.0, abs(rNear.sub(at))).mul(smoothstep(0.26, 0.04, abs(fract(ang).sub(0.5)))).mul(smoothstep(0.0, 0.25, along)).mul(float(1).sub(along));
  const motes = mix(tint, vec3(1, 1, 1), 0.5).mul(dot.mul(2.4));

  // A pulse: a ring racing out from the centre and a flash over the whole opening.
  const age = pulseAge;
  const live = smoothstep(PULSE_SECONDS, PULSE_SECONDS * 0.6, age);
  const ringAt = age.mul(halfH * 1.9);
  const ring = exp(rNear.sub(ringAt).pow(2).mul(-7)).mul(live);
  const flash = exp(age.mul(-5)).mul(0.55);
  const pulse = mix(tint, vec3(1, 1, 1), 0.65).mul(ring.mul(2.6).add(flash));

  m.colorNode = deep.add(arms).add(rimGlow).add(motes).add(pulse).mul(atmo.glowBoost);
  // Mostly opaque (the far side of the gate doesn't show through), feathered at the very edge.
  m.opacityNode = mix(float(0.86), float(1), max(rim, near.mul(0.5))).mul(smoothstep(0.0, 0.07, edge));
  return { material: m, pulseAge };
}

/**
 * A fast-travel pad's sky beam (D-gfx-hub-4): a tall tapered column, bright at the pad and gone by
 * its top, faint by day and strong from dusk (the lamplight uniform). Additive, one draw per pad.
 */
export function beamMaterial(color: number): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
  m.name = "pad_beam";
  const tint = vec3(...new THREE.Color(color).toArray());
  // The cylinder's own frame: y from -H/2 (the pad) to +H/2.
  const v = positionLocal.y.div(BEAM_HEIGHT).add(0.5);
  const fall = float(1).sub(v).pow(2.4);
  const drift = sin(v.mul(60).sub(time.mul(1.4))).mul(0.12).add(0.88);
  const strength = mix(float(0.22), float(1.25), atmo.lamps);
  m.colorNode = tint.mul(fall.mul(drift).mul(strength));
  return m;
}

export const BEAM_HEIGHT = 260;
