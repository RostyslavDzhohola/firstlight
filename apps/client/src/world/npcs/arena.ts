// Boss lair dressing from the shared deterministic layout: Tide Stones / Override Consoles (lit by
// the server's plate events) and breakable cover (hidden when the server says it broke).
// Drawn through the part batcher (no extra draw calls). ?noarena disables it (if the world lane
// builds these props itself, it should use bossArena() for the same positions).

import * as THREE from "three/webgpu";
import type { Terrain } from "@firstlight/shared";
import { bossArena, type ArenaLayout } from "@firstlight/shared/content/arenas";
import type { BossEventMsg } from "@firstlight/shared/content/npcs";
import type { PartBatcher } from "./parts.ts";

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpP = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const basis = new THREE.Matrix4();
const col = new THREE.Color();

export class ArenaView {
  /** Computed once when the body loads (the client system is created behind the loading screen). */
  readonly layout: ArenaLayout | null;
  private held = [0, 0];
  private progress = 0;
  private darkUntil = 0;
  private windowUntil = 0;
  private readonly broken = new Set<number>();

  constructor(terrain: Terrain) {
    this.layout = terrain.body.terrain.kind === "hub" ? null : bossArena(terrain);
  }

  onEvent(m: BossEventMsg, now: number) {
    if (m.type === "plates") {
      this.held = m.held ?? [0, 0];
      this.progress = m.progress ?? 0;
      this.darkUntil = m.dark ? now + m.dark * 1000 : 0;
    } else if (m.type === "window") {
      this.windowUntil = m.ms ? now + m.ms : 0;
    } else if (m.type === "mechanic" && m.mech === "cover" && m.pts) {
      this.broken.add(m.pts[0]!);
    } else if (m.type === "snapshot") {
      // Late joiners / players arriving at the lair: the current state, not the default.
      this.broken.clear();
      for (const id of m.broken ?? []) this.broken.add(id);
      this.windowUntil = m.windowMs ? now + m.windowMs : 0;
      this.held = m.held ?? [0, 0];
      this.progress = m.progress ?? 0;
      this.darkUntil = m.dark ? now + m.dark * 1000 : 0;
    } else if (m.type === "reset" || m.type === "respawn") {
      this.broken.clear();
      this.windowUntil = 0;
      this.held = [0, 0];
    }
  }

  draw(batch: PartBatcher, player: THREE.Vector3, now: number) {
    const a = this.layout;
    if (!a) return;
    const c = new THREE.Vector3(...a.centre);
    if (c.distanceTo(player) > 320) return;
    const up = c.clone().normalize();
    const axis = new THREE.Vector3(...a.axis);
    const side = new THREE.Vector3().crossVectors(up, axis);
    const tidewrath = a.boss === "tidewrath";
    a.plates.forEach((p, i) => {
      const pos = new THREE.Vector3(...p);
      const pu = pos.clone().normalize();
      this.place(batch, "cyl", "std", pos, pu, axis, [2.6, 0.35, 2.6], 0.12, tidewrath ? 0x34303a : 0x2c3138);
      const open = now < this.windowUntil;
      const dark = now < this.darkUntil;
      let k = dark ? 0.12 : 0.9 + (this.held[i] ? 1.2 + this.progress * 2 * (0.6 + 0.4 * Math.sin(now / 70)) : 0);
      if (open) k = 3 + Math.sin(now / 90);
      col.setHex(tidewrath ? 0x3df5ff : 0xffb547).multiplyScalar(k);
      this.place(batch, "cyl", "glow", pos, pu, axis, [2.0, 0.08, 2.0], 0.33, col);
    });
    for (const cv of a.cover) {
      if (this.broken.has(cv.id)) continue;
      const pos = new THREE.Vector3(...cv.pos);
      const pu = pos.clone().normalize();
      switch (cv.kind) {
        case "coral":
          this.place(batch, "cyl", "std", pos, pu, axis, [cv.radius * 2, cv.height, cv.radius * 2], cv.height / 2, 0x3d3b44);
          this.place(batch, "cone", "std", pos.clone().addScaledVector(pu, cv.height).addScaledVector(side, 0.3), pu, axis, [0.7, 1.6, 0.7], 0.8, 0xff7a5c);
          this.place(batch, "cone", "std", pos.clone().addScaledVector(pu, cv.height - 0.6).addScaledVector(side, -0.5), pu, axis, [0.5, 1.2, 0.5], 0.6, 0xffb38a);
          break;
        case "pillar":
          this.place(batch, "cyl", "std", pos, pu, axis, [cv.radius * 2, cv.height, cv.radius * 2], cv.height / 2, 0x8a8296);
          this.place(batch, "box", "std", pos, pu, axis, [cv.radius * 2.6, 0.5, cv.radius * 2.6], cv.height, 0x6c6478);
          break;
        case "container":
          this.place(batch, "box", "std", pos, pu, axis, [2.4, cv.height, 6.0], cv.height / 2, [0xa8452c, 0x2f7f86, 0xd9d2c3, 0x5a6b3a][cv.id % 4]!);
          break;
        case "crane":
          this.place(batch, "box", "metal", pos, pu, axis, [cv.radius * 2, cv.height, cv.radius * 2], cv.height / 2, 0xd9a23a);
          break;
      }
    }
  }

  private place(batch: PartBatcher, g: "cyl" | "box" | "cone", m: "std" | "glow" | "metal", base: THREE.Vector3, up: THREE.Vector3, axis: THREE.Vector3, size: [number, number, number], lift: number, color: number | THREE.Color) {
    const f = axis.clone().addScaledVector(up, -axis.dot(up)).normalize();
    const r = new THREE.Vector3().crossVectors(up, f);
    basis.makeBasis(r, up, f);
    tmpQ.setFromRotationMatrix(basis);
    tmpP.copy(base).addScaledVector(up, lift);
    tmpS.set(size[0], size[1], size[2]);
    tmpM.compose(tmpP, tmpQ, tmpS);
    if (typeof color === "number") col.setHex(color);
    else col.copy(color);
    batch.push(g, m, tmpM, col.r, col.g, col.b);
  }
}
