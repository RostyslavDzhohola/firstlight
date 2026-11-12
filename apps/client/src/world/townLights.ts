// Portus' evening air (D-gfx-hub-8): a halo round every lantern and brazier with a core bright
// enough to bloom, each portal's colour hanging in the air round its arch (so the walls behind it
// read as lit by it), the scoreboard's glow at its emitter, and lantern motes that drift up from the
// lamps and fires. Camera-facing additive quads, all in one mesh and one draw; they come up with the
// lamplight. Not lights: nothing is lit or shadowed.
//
// A quad's four vertices share its centre (`position`) and carry their corner in `uv` (−1 … 1): the
// vertex shader spreads them along the camera's right and up. `aLight` = size (m), phase, drift (m:
// 0 a fixed halo, more a mote that wanders and rises that far), share kept by day. `aShape` = core
// and skirt strength.

import * as THREE from "three/webgpu";
import { attribute, cameraWorldMatrix, exp, float, fract, mix, positionLocal, sin, smoothstep, time, uniform, uv, vec3, vec4 } from "three/tsl";
import type { BodyId, Terrain } from "@firstlight/shared";
import { TOWN_FIXED, TOWN_LAYOUT, TOWN_PREFABS } from "@firstlight/shared/content/portusTown";
import { townDir } from "@firstlight/shared/planet/townFrame";
import type { Game } from "../game/Game.ts";
import type { ClientSystem, ClientSystemFactory } from "../game/systems.ts";
import { atmo } from "../render/atmosphere.ts";
import { disposeTree } from "../render/dispose.ts";
import { HOLO_AT } from "./HoloBoard.ts";
import { PORTAL_COLORS } from "./Portals.ts";

export interface TownLight {
  /** East, north of the plaza's centre and height above the ground (m). */
  at: readonly [number, number, number];
  /** Radius of the quad (m). */
  size: number;
  color: number;
  /** Brightness at the centre (over ~1.3 it blooms) and of the wide skirt round it. */
  core: number;
  skirt: number;
  /** 0: a fixed halo. More: a mote that wanders and rises this far (m), then starts again. */
  drift: number;
  /** Where on its clock a mote starts, 0 … 1. */
  phase: number;
  /** Share kept by day, 0 … 1. */
  day: number;
}

const LAMP = 0xffb463;
const EMBER = 0xff8a3c;
/** Height of a lamp post's lantern and of a brazier's fire above the ground (m). */
export const LANTERN_M = 2.92;
export const BRAZIER_M = 1.55;
/** Motes per lamp post and per brazier. */
export const MOTES_PER_LAMP = 5;
export const MOTES_PER_BRAZIER = 6;

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/** Portus' lights: lantern and brazier halos, the portals' and the scoreboard's glow, the motes. Pure. */
export function portusTownLights(): TownLight[] {
  const out: TownLight[] = [];
  const rnd = lcg(0x70c5);
  const of = (name: string) => {
    const i = TOWN_PREFABS.findIndex((p) => p.name === name);
    return TOWN_LAYOUT.filter((l) => l[0] === i).map((l) => [l[1], l[2]] as const);
  };
  for (const [e, n] of of("lamp_post")) {
    out.push({ at: [e, n, LANTERN_M], size: 1.5, color: LAMP, core: 2.3, skirt: 0.34, drift: 0, phase: 0, day: 0 });
    for (let k = 0; k < MOTES_PER_LAMP; k++) {
      out.push({ at: [e + (rnd() - 0.5) * 3.2, n + (rnd() - 0.5) * 3.2, 0.6 + rnd() * 2.2], size: 0.045 + rnd() * 0.035, color: LAMP, core: 2.4, skirt: 0.5, drift: 2.4 + rnd() * 2.2, phase: rnd(), day: 0 });
    }
  }
  for (const [e, n] of of("brazier")) {
    out.push({ at: [e, n, BRAZIER_M], size: 1.35, color: EMBER, core: 1.9, skirt: 0.36, drift: 0, phase: 0, day: 0.25 });
    for (let k = 0; k < MOTES_PER_BRAZIER; k++) {
      out.push({ at: [e + (rnd() - 0.5) * 0.7, n + (rnd() - 0.5) * 0.7, BRAZIER_M + rnd() * 0.5], size: 0.03 + rnd() * 0.03, color: EMBER, core: 2.6, skirt: 0.4, drift: 2.8 + rnd() * 2.6, phase: rnd(), day: 0.3 });
    }
  }
  for (const [to, [e, n]] of Object.entries(TOWN_FIXED.portals) as [BodyId, readonly [number, number]][]) {
    // The destination's colour in the air round the arch: wide, weak, no core (the vortex is the core).
    out.push({ at: [e, n, 3.3], size: 8.5, color: PORTAL_COLORS[to], core: 0, skirt: 0.2, drift: 0, phase: 0, day: 0.12 });
  }
  out.push({ at: [HOLO_AT[0], HOLO_AT[1], 0.5], size: 2.4, color: 0x7fe9ff, core: 0.9, skirt: 0.3, drift: 0, phase: 0, day: 0.2 });
  return out;
}

/** Every light as one quad at its centre (planet space) on `terrain`: position, uv corner, colour, aLight, aShape. */
export function townLightGeometry(lights: readonly TownLight[], terrain: Terrain): THREE.BufferGeometry {
  const R = terrain.body.radius;
  const pos: number[] = [], uvs: number[] = [], col: number[] = [], par: number[] = [], shape: number[] = [], idx: number[] = [];
  const c = new THREE.Color();
  const d: [number, number, number] = [0, 0, 0];
  const corners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (const l of lights) {
    townDir(l.at[0], l.at[1], R, d);
    const h = R + terrain.groundHeight(d[0], d[1], d[2]) + l.at[2];
    c.setHex(l.color);
    const base = pos.length / 3;
    for (const [u, v] of corners) {
      pos.push(d[0] * h, d[1] * h, d[2] * h);
      uvs.push(u, v);
      col.push(c.r, c.g, c.b);
      par.push(l.size, l.phase, l.drift, l.day);
      shape.push(l.core, l.skirt);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute("aLight", new THREE.Float32BufferAttribute(par, 4));
  g.setAttribute("aShape", new THREE.Float32BufferAttribute(shape, 2));
  g.setIndex(idx);
  return g;
}

/** Overall strength (1 = as designed): one float, for tuning in a running game. */
export const townLightGain = uniform(1);

let mat: THREE.MeshBasicNodeMaterial | null = null;
/**
 * The lights' one additive material. `up`, `east` and `north` are the plaza's frame (the town is
 * small against the planet: one frame serves every mote).
 */
export function townLightMaterial(frame: { up: THREE.Vector3; east: THREE.Vector3; north: THREE.Vector3 }): THREE.MeshBasicNodeMaterial {
  if (mat) return mat;
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true, fog: false });
  m.name = "town_lights";
  const a = attribute("aLight", "vec4");
  const sh = attribute("aShape", "vec2");
  const size = a.x, phase = a.y, drift = a.z;
  const up = vec3(frame.up.x, frame.up.y, frame.up.z), east = vec3(frame.east.x, frame.east.y, frame.east.z), north = vec3(frame.north.x, frame.north.y, frame.north.z);
  // A mote's life: it rises `drift` metres while it wanders, fades in and out, and starts again.
  const life = fract(time.mul(phase.mul(0.03).add(0.045)).add(phase));
  const wander = east.mul(sin(time.mul(0.31).add(phase.mul(40))).mul(0.5)).add(north.mul(sin(time.mul(0.23).add(phase.mul(71))).mul(0.5)));
  const moved = up.mul(life.mul(drift)).add(wander.mul(drift.min(1)));
  // Face the camera: spread the corners along its right and up.
  const right = cameraWorldMatrix.mul(vec4(1, 0, 0, 0)).xyz;
  const camUp = cameraWorldMatrix.mul(vec4(0, 1, 0, 0)).xyz;
  m.positionNode = positionLocal.add(moved).add(right.mul(uv().x.mul(size))).add(camUp.mul(uv().y.mul(size)));

  const r2 = uv().x.mul(uv().x).add(uv().y.mul(uv().y));
  const edge = float(1).sub(r2).clamp(0, 1);
  // A small hot core and a long, soft skirt that is gone at the quad's edge.
  const glow = exp(r2.mul(-26)).mul(sh.x).add(edge.mul(edge).mul(edge).mul(sh.y));
  const isMote = smoothstep(0.0, 0.01, drift);
  const breath = mix(sin(time.mul(1.7).add(phase.mul(31))).mul(0.06).add(0.94), sin(life.mul(Math.PI)).mul(sin(time.mul(5).add(phase.mul(90))).mul(0.25).add(0.75)), isMote);
  const level = mix(a.w, float(1), atmo.lamps);
  m.colorNode = attribute("color", "vec3").mul(glow.mul(breath).mul(level).mul(townLightGain));
  m.userData.gain = townLightGain;
  mat = m;
  return m;
}

/** Client system: Portus' evening lights (offline too). Medium and up, `?notownlights`. */
export const createTownLights: ClientSystemFactory = (game: Game): ClientSystem | null => {
  if (game.planet.body.terrain.kind !== "hub") return null;
  const R = game.planet.body.radius;
  const o = townDir(0, 0, R), e = townDir(1, 0, R), n = townDir(0, 1, R);
  const up = new THREE.Vector3(o[0], o[1], o[2]).normalize();
  const east = new THREE.Vector3(e[0] - o[0], e[1] - o[1], e[2] - o[2]).normalize();
  const north = new THREE.Vector3(n[0] - o[0], n[1] - o[1], n[2] - o[2]).normalize();
  const mesh = new THREE.Mesh(townLightGeometry(portusTownLights(), game.planet.terrain), townLightMaterial({ up, east, north }));
  mesh.name = "townLights";
  mesh.renderOrder = 4;
  // The quads grow from their centres in the shader: the bounds are the town's, not the centres'.
  mesh.frustumCulled = false;
  game.ctx.scene.add(mesh);
  const apply = () => void (mesh.visible = game.ctx.settings.on.townlights);
  apply();
  const off = game.ctx.onChange(apply);
  return {
    update() {},
    dispose() {
      off();
      mesh.removeFromParent();
      disposeTree(mesh);
    },
  };
};
createTownLights.offline = true;
