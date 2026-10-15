// The tracked hunt mission's world callout (D-zones-2): on a planet, the first open mission given
// out there (the HUD tracker's tracked one, unless an older planet's mission is still open) points
// at the nearest creep in view that counts for it, or at its area. Pinned to the screen edge with
// an arrow when the point is off screen (placeCallout).

import "../ui/missionPointer.css";
import * as THREE from "three/webgpu";
import { MISSION_BY_ID, missionGoal } from "@firstlight/shared/content/missions";
import { placeCallout } from "../ui/calloutPlace.ts";
import { el } from "../ui/dom.ts";
import type { Game } from "./Game.ts";
import { missionTarget, type PointerNpc, type PointerTarget } from "./missionTarget.ts";
import type { ClientSystem } from "./systems.ts";

/** Pick the target this often (ms); the callout itself follows it every frame. */
const PICK_MS = 250;

const _p = new THREE.Vector3();
const _u = new THREE.Vector3();

class MissionPointer implements ClientSystem {
  private readonly game: Game;
  private readonly root: HTMLElement;
  private readonly callout: HTMLElement;
  private readonly box: HTMLElement;
  private readonly title: HTMLElement;
  private readonly sub: HTMLElement;
  private target: PointerTarget | null = null;
  private mission = "";
  private pickedAt = -Infinity;
  private last = { text: "", key: "" };
  private boxSize: { w: number; h: number } | null = null;

  constructor(game: Game) {
    this.game = game;
    const layer = game.hud.root.querySelector<HTMLElement>(".fl-hud__layer") ?? game.hud.root;
    this.root = el("div", "fl-mpoint", layer);
    this.callout = el("div", "fl-callout", this.root);
    this.callout.hidden = true;
    el("div", "fl-callout__line", this.callout);
    el("div", "fl-callout__dot", this.callout);
    el("div", "fl-callout__arrow", this.callout);
    this.box = el("div", "fl-callout__box fl-holo", this.callout);
    this.title = el("span", "", this.box);
    this.sub = el("small", "", this.box);
  }

  update(_dt: number, now: number) {
    const g = this.game;
    const room = g.net.room;
    if (!room) return this.hide();
    const p = g.player.pos;
    if (now - this.pickedAt >= PICK_MS) {
      this.pickedAt = now;
      // The first open mission given out on this planet (missions from other planets can't point here).
      const open = g.hud.you?.missions.find((m) => !m.done && MISSION_BY_ID.get(m.id)?.body === g.bodyId);
      const def = open ? MISSION_BY_ID.get(open.id) : undefined;
      this.mission = def ? `${def.name} · ${open!.progress}/${missionGoal(def)}` : "";
      const npcs: PointerNpc[] = [];
      (room.state as any).npcs?.forEach((n: any) => npcs.push(n));
      const terrain = g.planet.terrain;
      this.target = def ? missionTarget(def, g.bodyId, [p.x, p.y, p.z], npcs, (x, y, z) => terrain.groundHeight(x, y, z)) : null;
    }
    const t = this.target;
    if (!t || g.photo?.active) return this.hide();
    const metres = Math.round(Math.hypot(t.at[0] - p.x, t.at[1] - p.y, t.at[2] - p.z));
    const text = `${t.title} · ${metres} m\u0001${this.mission}`;
    if (text !== this.last.text) {
      this.last.text = text;
      this.title.textContent = `${t.title} · ${metres} m`;
      this.sub.textContent = this.mission;
      this.boxSize = null;
    }
    // A creep's chest, or a little above the area's centre.
    const up = _u.set(t.at[0], t.at[1], t.at[2]).normalize();
    const ndc = _p.set(t.at[0], t.at[1], t.at[2]).addScaledVector(up, t.creep ? 1.2 : 3).project(g.ctx.camera);
    this.callout.hidden = false;
    if (!this.boxSize) {
      const w = this.box.offsetWidth;
      const h = this.box.offsetHeight;
      if (w > 0 && h > 0) this.boxSize = { w, h };
    }
    const c = placeCallout(ndc, innerWidth, innerHeight, this.boxSize ?? { w: 160, h: 48 }, null);
    const key = `${Math.round(c.x)},${Math.round(c.y)},${c.edge ? Math.round(c.angle * 20) : "-"},${c.flip ? 1 : 0}`;
    if (key === this.last.key) return;
    this.last.key = key;
    this.callout.style.setProperty("--x", `${Math.round(c.x)}px`);
    this.callout.style.setProperty("--y", `${Math.round(c.y)}px`);
    this.callout.style.setProperty("--a", `${c.angle.toFixed(3)}rad`);
    this.callout.classList.toggle("is-edge", c.edge);
    this.callout.classList.toggle("is-flip", c.flip);
  }

  private hide() {
    if (!this.callout.hidden) this.callout.hidden = true;
    this.last.key = "";
  }

  dispose() {
    this.root.remove();
  }
}

/** Planets only: Portus has no missions (its tutorial has its own callout). */
export function createMissionPointer(game: Game): ClientSystem | null {
  return game.net.room && game.bodyId !== "portus" ? new MissionPointer(game) : null;
}
