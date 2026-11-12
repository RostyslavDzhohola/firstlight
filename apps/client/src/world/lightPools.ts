// Light pools on Portus' ground (D-gfx-hub-6): a warm pool under every lamp post, each portal's
// colour spilling onto the paving in front of it, the scoreboard's glow under its emitter. Soft
// additive discs draped on the ground, all in one mesh and one draw; they come up with the lamplight
// (the portals' and the board's keep a little by day). No lights: nothing is lit or shadowed, so no
// material in the town changes.

import * as THREE from "three/webgpu";
import { attribute, float, mix, uv } from "three/tsl";
import type { BodyId, Terrain } from "@firstlight/shared";
import { TOWN_FIXED, TOWN_LAYOUT, TOWN_PREFABS } from "@firstlight/shared/content/portusTown";
import { townDir } from "@firstlight/shared/planet/townFrame";
import type { Game } from "../game/Game.ts";
import type { ClientSystem, ClientSystemFactory } from "../game/systems.ts";
import { atmo } from "../render/atmosphere.ts";
import { disposeTree } from "../render/dispose.ts";
import { HOLO_AT } from "./HoloBoard.ts";
import { PORTAL_COLORS } from "./Portals.ts";

export interface LightPool {
  /** East, north of the plaza's centre (m). */
  at: readonly [number, number];
  radius: number;
  color: number;
  /** Brightness kept by day, 0 … 1 (lamps: 0, they are out). */
  day: number;
  /** Peak brightness at night. */
  strength: number;
}

const LAMP = 0xffb463;
/** Metres above the ground: over the paving decal (2–7.5 cm, townDecal.ts). */
export const POOL_LIFT = 0.11;
const RINGS = 4, SPOKES = 18;

/** Portus' pools: lamp posts, the three portals (towards the plaza), the scoreboard. Pure. */
export function portusLightPools(): LightPool[] {
  const pools: LightPool[] = [];
  const lamp = TOWN_PREFABS.findIndex((p) => p.name === "lamp_post");
  for (const [prefab, e, n] of TOWN_LAYOUT) if (prefab === lamp) pools.push({ at: [e, n], radius: 5.4, color: LAMP, day: 0, strength: 1.5 });
  for (const [to, [e, n]] of Object.entries(TOWN_FIXED.portals) as [BodyId, readonly [number, number]][]) {
    // In front of the arch: 3.4 m towards the plaza's centre.
    const d = Math.hypot(e, n) || 1;
    pools.push({ at: [e - (e / d) * 3.4, n - (n / d) * 3.4], radius: 6.0, color: PORTAL_COLORS[to], day: 0.22, strength: 0.9 });
  }
  pools.push({ at: HOLO_AT, radius: 3.6, color: 0x7fe9ff, day: 0.22, strength: 1.1 });
  return pools;
}

/** Every pool as a fan of rings draped on `terrain` (planet space): position, uv.x = radius 0 … 1, colour, aPool = (day, strength). */
export function lightPoolGeometry(pools: readonly LightPool[], terrain: Terrain): THREE.BufferGeometry {
  const R = terrain.body.radius;
  const pos: number[] = [], uvs: number[] = [], col: number[] = [], par: number[] = [], idx: number[] = [];
  const c = new THREE.Color();
  const d: [number, number, number] = [0, 0, 0];
  for (const p of pools) {
    c.setHex(p.color);
    const base = pos.length / 3;
    const put = (e: number, n: number, r: number) => {
      townDir(e, n, R, d);
      const h = R + terrain.groundHeight(d[0], d[1], d[2]) + POOL_LIFT;
      pos.push(d[0] * h, d[1] * h, d[2] * h);
      uvs.push(r, 0);
      col.push(c.r, c.g, c.b);
      par.push(p.day, p.strength);
    };
    put(p.at[0], p.at[1], 0);
    for (let k = 1; k <= RINGS; k++) {
      for (let s = 0; s < SPOKES; s++) {
        const a = (s / SPOKES) * Math.PI * 2, r = (k / RINGS) * p.radius;
        put(p.at[0] + Math.cos(a) * r, p.at[1] + Math.sin(a) * r, k / RINGS);
      }
    }
    for (let s = 0; s < SPOKES; s++) idx.push(base, base + 1 + s, base + 1 + ((s + 1) % SPOKES));
    for (let k = 1; k < RINGS; k++) {
      for (let s = 0; s < SPOKES; s++) {
        const a = base + 1 + (k - 1) * SPOKES + s, b = base + 1 + (k - 1) * SPOKES + ((s + 1) % SPOKES);
        idx.push(a, a + SPOKES, b, b, a + SPOKES, b + SPOKES);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute("aPool", new THREE.Float32BufferAttribute(par, 2));
  g.setIndex(idx);
  return g;
}

export function lightPoolMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  m.name = "light_pools";
  m.polygonOffset = true;
  m.polygonOffsetFactor = -2;
  m.polygonOffsetUnits = -2;
  const a = attribute("aPool", "vec2");
  const fall = float(1).sub(uv().x).clamp(0, 1);
  // Bright under the lamp, a long soft skirt. (Additive light on dark paving needs a strength near
  // 1 to read at all: at 0.4 the pools were invisible.)
  const shape = fall.mul(fall.mul(0.55).add(0.45));
  m.colorNode = attribute("color", "vec3").mul(shape.mul(a.y).mul(mix(a.x, float(1), atmo.lamps)));
  return m;
}

/** Client system: Portus' light pools (offline too). Medium and up, `?nopools`. */
export const createLightPools: ClientSystemFactory = (game: Game): ClientSystem | null => {
  if (game.planet.body.terrain.kind !== "hub") return null;
  const mesh = new THREE.Mesh(lightPoolGeometry(portusLightPools(), game.planet.terrain), lightPoolMaterial());
  mesh.name = "lightPools";
  mesh.renderOrder = 2;
  game.ctx.scene.add(mesh);
  const apply = () => void (mesh.visible = game.ctx.settings.on.pools);
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
createLightPools.offline = true;
