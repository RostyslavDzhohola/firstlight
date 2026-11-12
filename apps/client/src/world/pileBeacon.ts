// The beacon over a loot pile (D-gfx-hub-10). A dead player's pile is anyone's: it has to be seen
// from far off and feel alive up close. One geometry, one additive material, one draw per pile:
//   - a tall tapered shaft of gold light, soft at its silhouette, bright enough at the foot to bloom,
//     that widens with distance so it still reads at 60 m and more, by day too;
//   - near the pile, ripples running out over the ground and sparks winding up round it (both fade
//     out with distance: they are the close-up shimmer, the shaft is the far signal).
// Everything moves on the shared clock; nothing is written per frame.

import * as THREE from "three/webgpu";
import { abs, attribute, cos, dot, float, fract, mix, modelViewPosition, normalView, positionLocal, positionViewDirection, select, sin, smoothstep, time, uv, vec3 } from "three/tsl";

/** The shaft's height and foot radius (m), and how far its width keeps growing with distance. */
export const PILE_BEAM_M = 34;
export const PILE_BEAM_R = 0.4;
/** The shaft is this many times wider from `PILE_FAR_M` on than up close (it grows in between). */
export const PILE_BEAM_WIDEN = 3.2;
export const PILE_FAR_M = 64;
export const PILE_SPARKS = 18;
/** The ripples' reach on the ground (m). */
export const PILE_RING_M = 2.3;
const KIND = { beam: 0, ring: 1, spark: 2 } as const;
const GOLD = 0xffc95a;

let geo: THREE.BufferGeometry | null = null;
/** Shaft, ground ring and sparks in one geometry (pile space: y up from the ground). */
export function pileBeaconGeometry(): THREE.BufferGeometry {
  if (geo) return geo;
  const pos: number[] = [], nrm: number[] = [], uvs: number[] = [], part: number[] = [], idx: number[] = [];
  const vert = (x: number, y: number, z: number, u: number, v: number, kind: number, a = 0, b = 0, c = 0, nx = 0, ny = 1, nz = 0) => {
    pos.push(x, y, z);
    nrm.push(nx, ny, nz);
    uvs.push(u, v);
    part.push(kind, a, b, c);
    return pos.length / 3 - 1;
  };
  const tube = (kind: number, r0: number, r1: number, y0: number, y1: number, seg: number) => {
    const base = pos.length / 3;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      vert(c * r0, y0, s * r0, i / seg, 0, kind, 0, 0, 0, c, 0, s);
      vert(c * r1, y1, s * r1, i / seg, 1, kind, 0, 0, 0, c, 0, s);
    }
    for (let i = 0; i < seg; i++) {
      const k = base + i * 2;
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  };
  tube(KIND.beam, PILE_BEAM_R, 0.07, 0, PILE_BEAM_M, 12);
  tube(KIND.ring, 0.25, PILE_RING_M, 0.06, 0.06, 28); // flat: uv.y 0 inner … 1 outer
  let s = 0x9e3779b1;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < PILE_SPARKS; i++) {
    // A small upright diamond; seeds: a = angle, b = radius and speed, c = phase.
    const a = rnd(), b = rnd(), c = rnd();
    const size = 0.03 + rnd() * 0.035;
    const base = pos.length / 3;
    const corners: [number, number][] = [[0, 1.8], [1, 0], [0, -1.8], [-1, 0]];
    for (const [ox, oy] of corners) vert(ox * size, oy * size, 0, ox, oy, KIND.spark, a, b, c);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute("aPart", new THREE.Float32BufferAttribute(part, 4));
  g.setIndex(idx);
  // The shader widens the shaft with distance: bounds for its widest.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, PILE_BEAM_M / 2, 0), PILE_BEAM_M / 2 + PILE_RING_M * PILE_BEAM_WIDEN);
  geo = g;
  return g;
}

/** How much wider the shaft is drawn `dist` m from the camera (pure: the shader does the same). */
export function pileBeamWiden(dist: number): number {
  return 1 + (PILE_BEAM_WIDEN - 1) * Math.min(1, Math.max(0, (dist - 14) / (PILE_FAR_M - 14)));
}

let mat: THREE.MeshBasicNodeMaterial | null = null;
export function pileBeaconMaterial(): THREE.MeshBasicNodeMaterial {
  if (mat) return mat;
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true, fog: false });
  m.name = "pile_beacon";
  const a = attribute("aPart", "vec4");
  const kind = a.x;
  const isRing = kind.greaterThan(0.5).and(kind.lessThan(1.5));
  const isSpark = kind.greaterThan(1.5);
  const gold = vec3(...new THREE.Color(GOLD).toArray());
  const cyan = vec3(...new THREE.Color(0x36f9f6).toArray());
  const dist = modelViewPosition.length();
  const widen = float(1).add(smoothstep(14, PILE_FAR_M, dist).mul(PILE_BEAM_WIDEN - 1));
  const near = smoothstep(46, 16, dist); // the close-up shimmer's share

  // Sparks wind up round the pile, each on its own clock.
  const life = fract(time.mul(a.z.mul(0.18).add(0.2)).add(a.w));
  const ang = a.y.mul(Math.PI * 2).add(time.mul(a.z.sub(0.5).mul(1.6))).add(life.mul(2.2));
  const rad = a.z.mul(0.75).add(0.4).mul(mix(float(1), float(0.5), life));
  const sparkPos = vec3(cos(ang).mul(rad), life.mul(a.z.mul(1.2).add(1.6)).add(0.15), sin(ang).mul(rad)).add(positionLocal);
  const beamPos = vec3(positionLocal.x.mul(widen), positionLocal.y, positionLocal.z.mul(widen));
  m.positionNode = select(isSpark, sparkPos, select(isRing, positionLocal, beamPos));

  const v = uv().y;
  // The shaft: light, not a tube (bright through the middle, gone at the silhouette), strongest at
  // the foot, with slow bands climbing it.
  const facing = abs(dot(normalView, positionViewDirection)).clamp(0, 1);
  const bands = sin(v.mul(46).sub(time.mul(2.4))).mul(0.14).add(0.86);
  const breathe = sin(time.mul(1.3)).mul(0.1).add(0.9);
  const beam = facing.pow(1.5).mul(float(1).sub(v).pow(1.35)).mul(bands).mul(breathe).mul(2.6);
  // Ripples run out over the ground and die at the rim.
  const ripple = smoothstep(0.16, 0.0, abs(fract(v.mul(1.6).sub(time.mul(0.45))).sub(0.5))).mul(float(1).sub(v).pow(1.2)).mul(smoothstep(0.0, 0.08, v));
  const ring = ripple.mul(1.5).add(float(1).sub(v).pow(3).mul(0.5)).mul(near);
  const spark = sin(life.mul(Math.PI)).mul(sin(time.mul(9).add(a.w.mul(60))).mul(0.3).add(0.7)).mul(2.8).mul(near);
  const sparkTint = mix(gold, cyan, smoothstep(0.62, 0.7, a.y));
  m.colorNode = select(isSpark, sparkTint.mul(spark), gold.mul(select(isRing, ring, beam)));
  mat = m;
  return m;
}
