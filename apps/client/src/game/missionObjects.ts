// Mission objects say what they are (#86): look at a race ring, a defence beacon, a gleam shard or a
// kite panel of a mission you have open and a label stands over it ("Kite panel 2 of 5" / "Kite Season
// · walk into it"), in the mission's colour (ui/missionColour.ts, the colour of its row and its glow).
// `objectLabel` and `pickLooked` are pure (unit-tested); the system re-picks a few times a second and
// moves the label every frame (DOM only when its text or rounded place changes).

import "../ui/missionPointer.css";
import * as THREE from "three/webgpu";
import type { BodyId } from "@firstlight/shared";
import { MISSION_BY_ID } from "@firstlight/shared/content/missions";
import { objectPos, objectsOn, type WorldObjectDef } from "@firstlight/shared/content/world";
import { el } from "../ui/dom.ts";
import { missionColour } from "../ui/missionColour.ts";
import type { Game } from "./Game.ts";
import type { ClientSystem } from "./systems.ts";

export interface ObjectLabel {
  title: string;
  sub: string;
  mission: string;
}

interface OpenMission {
  id: string;
  done: boolean;
  counts?: readonly number[];
}

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** What a mission object's label says, or null when it isn't one of an open mission (or is already taken). */
export function objectLabel(o: WorldObjectDef, missions: readonly OpenMission[]): ObjectLabel | null {
  const m = o.mission ? missions.find((x) => x.id === o.mission && !x.done) : undefined;
  const def = m ? MISSION_BY_ID.get(m.id) : undefined;
  if (!m || !def) return null;
  if (def.race) {
    const k = def.race.rings.indexOf(o.id);
    if (k < 0) return null;
    return { title: `Ring ${k + 1} of ${def.race.rings.length}`, sub: `${def.name} · run through them in order`, mission: def.id };
  }
  if (def.collect) {
    const k = def.collect.pieces.indexOf(o.id);
    if (k < 0 || m.counts?.[k]) return null;
    return { title: `${cap(o.name)} ${k + 1} of ${def.collect.pieces.length}`, sub: `${def.name} · walk into it to pick it up`, mission: def.id };
  }
  if (def.defend && def.defend.beacon === o.id) return { title: "Beacon", sub: `${def.name} · stand in its ring to light it`, mission: def.id };
  return null;
}

/**
 * The object the camera looks at: the smallest angle off the view direction within `maxDeg`
 * (wider up close, so a ring you stand beside still counts) and `maxM` metres; -1 if none.
 */
export function pickLooked(cam: readonly [number, number, number], fwd: readonly [number, number, number], at: readonly (readonly [number, number, number])[], maxDeg = 7, maxM = 45): number {
  let best = -1;
  let bestA = Infinity;
  at.forEach((p, i) => {
    const d = [p[0] - cam[0], p[1] - cam[1], p[2] - cam[2]];
    const l = Math.hypot(d[0]!, d[1]!, d[2]!);
    if (l > maxM || l < 0.5) return;
    const cos = (d[0]! * fwd[0] + d[1]! * fwd[1] + d[2]! * fwd[2]) / l;
    const deg = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
    const allow = l < 8 ? maxDeg * 2.5 : maxDeg;
    if (deg <= allow && deg < bestA) {
      bestA = deg;
      best = i;
    }
  });
  return best;
}

const PICK_MS = 150;
const LIFT: Record<string, number> = { ring: 4.6, beacon: 3.2, shard: 2.2 };
const _p = new THREE.Vector3();
const _f = new THREE.Vector3();

class MissionObjects implements ClientSystem {
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly sub: HTMLElement;
  private readonly objs: { def: WorldObjectDef; at: [number, number, number] }[];
  private pickedAt = -Infinity;
  private current: { at: [number, number, number]; label: ObjectLabel } | null = null;
  private last = { text: "", pos: "" };

  constructor(private readonly game: Game, body: BodyId) {
    const t = game.planet.terrain;
    this.objs = objectsOn(body)
      .filter((o) => o.mission && (o.look === "ring" || o.look === "beacon" || o.look === "shard"))
      .map((def) => {
        const p = objectPos(def, (x, y, z) => t.groundHeight(x, y, z));
        const l = Math.hypot(p[0], p[1], p[2]) || 1;
        const k = LIFT[def.look] ?? 2;
        return { def, at: [p[0] + (p[0] / l) * k, p[1] + (p[1] / l) * k, p[2] + (p[2] / l) * k] as [number, number, number] };
      });
    const layer = game.hud.root.querySelector<HTMLElement>(".fl-hud__layer") ?? game.hud.root;
    this.root = el("div", "fl-objlabel fl-holo", layer);
    this.root.dataset.e2e = "mission-object-label";
    this.root.hidden = true;
    this.title = el("b", "", this.root);
    this.sub = el("small", "", this.root);
  }

  update(_dt: number, now: number) {
    const g = this.game;
    if (now - this.pickedAt >= PICK_MS) {
      this.pickedAt = now;
      this.current = null;
      const missions = g.hud.you?.missions ?? [];
      const live = this.objs.map((o) => ({ o, label: objectLabel(o.def, missions) })).filter((x) => x.label);
      if (live.length) {
        const cam = g.ctx.camera;
        cam.getWorldPosition(_p);
        cam.getWorldDirection(_f);
        const i = pickLooked([_p.x, _p.y, _p.z], [_f.x, _f.y, _f.z], live.map((x) => x.o.at));
        if (i >= 0) this.current = { at: live[i]!.o.at, label: live[i]!.label! };
      }
    }
    const c = this.current;
    if (!c || g.photo?.active) {
      if (!this.root.hidden) this.root.hidden = true;
      this.last.pos = "";
      return;
    }
    const ndc = _p.set(c.at[0], c.at[1], c.at[2]).project(g.ctx.camera);
    if (ndc.z > 1) {
      this.root.hidden = true;
      return;
    }
    const text = `${c.label.title}|${c.label.sub}`;
    if (text !== this.last.text) {
      this.last.text = text;
      this.title.textContent = c.label.title;
      this.sub.textContent = c.label.sub;
      this.root.style.setProperty("--mc", missionColour(c.label.mission));
    }
    const pos = `${Math.round((ndc.x * 0.5 + 0.5) * innerWidth)}px,${Math.round((-ndc.y * 0.5 + 0.5) * innerHeight)}px`;
    if (pos !== this.last.pos) {
      this.last.pos = pos;
      this.root.style.transform = `translate(${pos}) translate(-50%, -100%)`;
    }
    if (this.root.hidden) this.root.hidden = false;
  }

  dispose() {
    this.root.remove();
  }
}

/** Planets only (Portus has no mission objects). */
export function createMissionObjects(game: Game): ClientSystem | null {
  return game.net.room && game.bodyId !== "portus" ? new MissionObjects(game, game.bodyId) : null;
}
