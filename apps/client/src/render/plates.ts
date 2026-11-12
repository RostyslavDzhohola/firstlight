// Nameplates' look with range, and the health bars under them (D-gfx-hub-11).
//
// A plate is whole and slightly enlarged up close, shrinks a little and thins out with distance, and
// fades to nothing over its last metres instead of popping out at a fixed range. The health bar is its
// own element hanging just under the plate's anchor, so whatever the plate holds on its name line
// (the name, a chip after it such as the agents lane's "AI", a title under it) keeps its layout.

import * as THREE from "three/webgpu";
import { PF } from "@firstlight/shared/net/schema";

/** Beyond this a player has no plate (m). */
export const PLATE_RANGE_M = 60;
/** Up to here a plate is fully opaque; from PLATE_FADE_M it fades out to nothing at PLATE_RANGE_M. */
export const PLATE_FULL_M = 18;
export const PLATE_FADE_M = 46;
/** Height of the plate's anchor above the feet (m): over the tallest hat. */
export const PLATE_LIFT_M = 2.15;
/** A full-health bar shows only this close (m); a hurt player's shows as far as the plate does. */
export const BAR_FULL_HP_M = 22;

export interface PlateLook {
  opacity: number;
  scale: number;
}

/** A plate's opacity and size `dist` m away (written into `out`: no allocation per frame). */
export function plateLook(dist: number, out: PlateLook = { opacity: 1, scale: 1 }): PlateLook {
  const d = Math.max(0, dist);
  if (d >= PLATE_RANGE_M) out.opacity = 0;
  else if (d > PLATE_FADE_M) out.opacity = 0.62 * (1 - (d - PLATE_FADE_M) / (PLATE_RANGE_M - PLATE_FADE_M));
  else if (d > PLATE_FULL_M) out.opacity = 1 - 0.38 * ((d - PLATE_FULL_M) / (PLATE_FADE_M - PLATE_FULL_M));
  else out.opacity = 1;
  // 1.12 at arm's length, 1 at 14 m, 0.8 at the edge of range.
  out.scale = d < 14 ? 1.12 - 0.12 * (d / 14) : 1 - 0.2 * Math.min(1, (d - 14) / (PLATE_RANGE_M - 14));
  return out;
}

/** Whether a player's health bar shows: always when hurt, only near when at full health. */
export function barShows(hp: number, maxHp: number, dist: number): boolean {
  if (!(maxHp > 0) || dist >= PLATE_RANGE_M) return false;
  return hp < maxHp || dist <= BAR_FULL_HP_M;
}

interface Bar {
  el: HTMLDivElement;
  fill: HTMLElement;
  frac: number;
  low: boolean;
}

const _v = new THREE.Vector3();
const _look: PlateLook = { opacity: 1, scale: 1 };

/** Health bars under other players' nameplates (DOM, like the plates: crisp at any resolution). */
export class PlateBars {
  private readonly root = document.createElement("div");
  private readonly bars = new Map<string, Bar>();
  private readonly seen = new Set<string>();

  constructor() {
    this.root.className = "fl-platebars";
    this.root.dataset.hud = ""; // photo mode hides HUD roots
    document.body.appendChild(this.root);
  }

  /**
   * Place a bar under every living player in range. `avatars` are the drawn avatars by session id,
   * `players` the room's PlayerState map (hp, maxHp, flags), `me` the player's own position.
   */
  sync(camera: THREE.Camera, avatars: ReadonlyMap<string, { root: THREE.Object3D }>, players: { get(id: string): { hp: number; maxHp: number; flags: number } | undefined }, me: THREE.Vector3) {
    const seen = this.seen;
    seen.clear();
    for (const [id, a] of avatars) {
      const st = players.get(id);
      if (!st || st.flags & PF.DEAD) continue;
      const pos = a.root.position;
      const d = pos.distanceTo(me);
      if (!barShows(st.hp, st.maxHp, d)) continue;
      _v.copy(pos).multiplyScalar(1 + PLATE_LIFT_M / Math.max(1, pos.length())).project(camera);
      if (_v.z > 1 || Math.abs(_v.x) > 1.1 || Math.abs(_v.y) > 1.1) continue;
      seen.add(id);
      let b = this.bars.get(id);
      if (!b) {
        const el = document.createElement("div");
        el.className = "fl-platebar";
        const fill = document.createElement("i");
        el.appendChild(fill);
        this.root.appendChild(el);
        b = { el, fill, frac: -1, low: false };
        this.bars.set(id, b);
      }
      const frac = Math.min(1, Math.max(0, st.hp / st.maxHp));
      if (Math.abs(frac - b.frac) > 0.002) {
        b.frac = frac;
        b.fill.style.transform = `scaleX(${frac.toFixed(3)})`;
        const low = frac < 0.3;
        if (low !== b.low) {
          b.low = low;
          b.el.classList.toggle("low", low);
        }
      }
      const look = plateLook(d, _look);
      b.el.style.left = `${(_v.x * 0.5 + 0.5) * innerWidth}px`;
      b.el.style.top = `${(-_v.y * 0.5 + 0.5) * innerHeight}px`;
      b.el.style.opacity = look.opacity.toFixed(2);
      b.el.style.transform = `translate(-50%, 3px) scale(${look.scale.toFixed(3)})`;
    }
    for (const [id, b] of this.bars) {
      if (seen.has(id)) continue;
      b.el.remove();
      this.bars.delete(id);
    }
  }

  dispose() {
    this.root.remove();
    this.bars.clear();
  }
}
