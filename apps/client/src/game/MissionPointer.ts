// The tracked mission's world callout (D-zones-2): on a planet, the mission the player tracks
// (game/missionTrack.ts, #69) points at the nearest creep in view whose kill would count (the
// server's huntTargets), its area, or its next ring, beacon or piece. Pinned to the screen edge with an
// arrow when the point is off screen (placeCallout). The same point is a marker on the compass with
// its distance, in the mission's colour (#70): the long-range way; the callout is the close-range cue.

import "../ui/missionPointer.css";
import * as THREE from "three/webgpu";
import { MISSION_BY_ID, missionGoal, trackedMission, type MissionDef } from "@firstlight/shared/content/missions";
import { objectPos, WORLD_OBJECT_BY_ID } from "@firstlight/shared/content/world";
import { placeCallout, type Rect } from "../ui/calloutPlace.ts";
import { el } from "../ui/dom.ts";
import type { Game } from "./Game.ts";
import { huntTargets } from "./huntTargets.ts";
import { missionTarget, type PointerNpc, type PointerTarget } from "./missionTarget.ts";
import type { ClientSystem } from "./systems.ts";
import { objectiveObject, trialSeen } from "./trialState.ts";
import { missionTrack } from "./missionTrack.ts";
import { compassGuides, type CompassMarker } from "../social/compass.ts";
import { missionColour } from "../ui/missionColour.ts";

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
  /** The tracked mission's id and name, for the compass marker. */
  private missionId = "";
  private missionName = "";
  private pickedAt = -Infinity;
  private readonly compassGuide = (): CompassMarker[] =>
    this.target && this.missionId ? [{ key: "mission", label: this.missionName, colour: missionColour(this.missionId), pos: this.target.at, kind: "mission" }] : [];
  private last = { text: "", key: "" };
  private boxSize: { w: number; h: number } | null = null;

  constructor(game: Game) {
    this.game = game;
    const layer = game.hud.root.querySelector<HTMLElement>(".fl-hud__layer") ?? game.hud.root;
    this.root = el("div", "fl-mpoint", layer);
    this.callout = el("div", "fl-callout", this.root);
    this.callout.dataset.e2e = "mission-pointer";
    this.callout.hidden = true;
    el("div", "fl-callout__line", this.callout);
    el("div", "fl-callout__dot", this.callout);
    el("div", "fl-callout__arrow", this.callout);
    this.box = el("div", "fl-callout__box fl-holo", this.callout);
    this.title = el("span", "", this.box);
    this.sub = el("small", "", this.box);
    compassGuides.add(this.compassGuide);
  }

  update(_dt: number, now: number) {
    const g = this.game;
    const room = g.net.room;
    if (!room) return this.hide();
    const p = g.player.pos;
    if (now - this.pickedAt >= PICK_MS) {
      this.pickedAt = now;
      // The HUD tracker's mission; missions from other planets don't point here (missionTarget).
      const open = trackedMission(g.hud.you?.missions ?? [], g.bodyId, missionTrack.chosen);
      const def = open ? MISSION_BY_ID.get(open.id) : undefined;
      this.mission = def ? `${def.name} · ${open!.progress}/${missionGoal(def)}` : "";
      this.missionId = def?.id ?? "";
      this.missionName = def?.name ?? "";
      const npcs: PointerNpc[] = [];
      (room.state as any).npcs?.forEach((n: any, id: string) => npcs.push({ id, kind: n.kind, hp: n.hp, x: n.x, y: n.y, z: n.z }));
      const terrain = g.planet.terrain;
      // The server's list, held since the join (huntTargets.ts): null until one came (older servers never send it).
      const hunt = huntTargets();
      const eligible = hunt && open && hunt.id === open.id ? hunt.npcs : null;
      this.target = def ? (def.race || def.defend || def.collect ? this.objective(def, open!.counts, [p.x, p.y, p.z]) : missionTarget(def, g.bodyId, [p.x, p.y, p.z], npcs, (x, y, z) => terrain.groundHeight(x, y, z), { eligible, counts: open!.counts })) : null;
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
    const c = placeCallout(ndc, innerWidth, innerHeight, this.boxSize ?? { w: 160, h: 48 }, null, this.keepClear());
    const key = `${Math.round(c.x)},${Math.round(c.y)},${c.edge ? Math.round(c.angle * 20) : "-"},${c.flip ? 1 : 0}`;
    if (key === this.last.key) return;
    this.last.key = key;
    this.callout.style.setProperty("--x", `${Math.round(c.x)}px`);
    this.callout.style.setProperty("--y", `${Math.round(c.y)}px`);
    this.callout.style.setProperty("--a", `${c.angle.toFixed(3)}rad`);
    this.callout.classList.toggle("is-edge", c.edge);
    this.callout.classList.toggle("is-flip", c.flip);
  }

  private clear: { w: number; h: number; rects: Rect[] } | null = null;

  /**
   * Where the label never goes (D-polish-ux-6): the crosshair, and the top-centre column (zone
   * banner, boss bar, trial strip, earned banners). From the window size and the HUD's size unit
   * (tokens.css `--u`), recomputed only on resize: no layout reads.
   */
  private keepClear(): Rect[] {
    const w = innerWidth;
    const h = innerHeight;
    if (this.clear?.w === w && this.clear.h === h) return this.clear.rects;
    const u = Math.min(19, Math.max(14, w * 0.00390625 + 9)); // tokens.css --u
    const rects: Rect[] = [
      { left: w / 2 - 3 * u, top: h / 2 - 3 * u, right: w / 2 + 3 * u, bottom: h / 2 + 3 * u },
      { left: w / 2 - 22 * u, top: 0, right: w / 2 + 22 * u, bottom: 13 * u },
    ];
    this.clear = { w, h, rects };
    return rects;
  }

  private readonly objAt = new Map<string, [number, number, number]>();

  /** Race / defend / collect: the next ring, the beacon, or the nearest piece left (trialState.ts). */
  private objective(def: MissionDef, counts: readonly number[] | undefined, me: [number, number, number]): PointerTarget | null {
    if (def.body !== this.game.bodyId) return null;
    const posOf = (id: string): [number, number, number] | null => {
      let at = this.objAt.get(id);
      const o = WORLD_OBJECT_BY_ID.get(id);
      if (!at && o && o.body === this.game.bodyId) {
        const t = this.game.planet.terrain;
        at = objectPos(o, (x, y, z) => t.groundHeight(x, y, z));
        this.objAt.set(id, at);
      }
      return at ?? null;
    };
    const trial = trialSeen()?.msg ?? null;
    const id = objectiveObject(def, counts, trial, me, posOf);
    const at = id ? posOf(id) : null;
    if (!id || !at) return null;
    const o = WORLD_OBJECT_BY_ID.get(id)!;
    const name = o.name.replace(/^Light the /, "");
    const title = name[0]!.toUpperCase() + name.slice(1); // "Ring 4", "Beacon", "Vigil lamp", "Gleam shard"
    return { at, title, creep: false };
  }

  private hide() {
    if (!this.callout.hidden) this.callout.hidden = true;
    this.last.key = "";
  }

  dispose() {
    compassGuides.delete(this.compassGuide);
    this.root.remove();
  }
}

/** Planets only: Portus has no missions (its tutorial has its own callout). */
export function createMissionPointer(game: Game): ClientSystem | null {
  return game.net.room && game.bodyId !== "portus" ? new MissionPointer(game) : null;
}
