// Creature tags (#73): the level and name over a creature's health bar while it is being fought,
// coloured by how its level compares with yours, faded and shrunk with range like the players'
// nameplates (render/plates.ts plateLook). DOM, like the plates: crisp at any resolution. The level
// is the server's (NpcState.level, set from the creature catalogue), never a list kept here.
// Colour is never the only signal: harder tiers add "!" or "!!" after the level.

import * as THREE from "three/webgpu";
import { plateLook, type PlateLook } from "../../render/plates.ts";

export type LevelTone = "easy" | "even" | "hard" | "deadly";

/** How a creature `npc` levels compares with a player of level `me` (WoW-like bands, simpler). */
export function levelTone(npc: number, me: number): LevelTone {
  const d = npc - me;
  if (d <= -3) return "easy";
  if (d <= 1) return "even";
  if (d <= 3) return "hard";
  return "deadly";
}

/** "Lv 6!" for a hard one, "Lv 9!!" for a deadly one. */
export function levelText(npc: number, tone: LevelTone): string {
  return `Lv ${npc}${tone === "hard" ? "!" : tone === "deadly" ? "!!" : ""}`;
}

interface Tag {
  el: HTMLDivElement;
  lv: HTMLElement;
  name: HTMLElement;
  key: string;
  pos: string;
  look: string;
}

const _p = new THREE.Vector3();
const _look: PlateLook = { opacity: 1, scale: 1 };

export class NpcTags {
  readonly root = document.createElement("div");
  private readonly tags = new Map<string, Tag>();
  private readonly seen = new Set<string>();

  constructor() {
    this.root.className = "fl-npctags";
    this.root.dataset.hud = ""; // photo mode hides HUD roots
    document.body.appendChild(this.root);
  }

  begin() {
    this.seen.clear();
  }

  /** A tag over the bar at `at` (planet space), `dist` m from the player. */
  push(id: string, at: THREE.Vector3, camera: THREE.Camera, dist: number, name: string, npcLevel: number, myLevel: number) {
    _p.copy(at).project(camera);
    if (_p.z > 1 || Math.abs(_p.x) > 1.1 || Math.abs(_p.y) > 1.1) return;
    const look = plateLook(dist, _look);
    if (look.opacity <= 0.01) return;
    this.seen.add(id);
    let t = this.tags.get(id);
    if (!t) {
      const el = document.createElement("div");
      el.className = "fl-npctag";
      el.dataset.e2e = "npc-tag";
      const lv = document.createElement("b");
      const nm = document.createElement("span");
      el.append(lv, nm);
      this.root.appendChild(el);
      t = { el, lv, name: nm, key: "", pos: "", look: "" };
      this.tags.set(id, t);
    }
    const tone = levelTone(npcLevel, myLevel);
    const key = `${npcLevel}|${tone}|${name}`;
    if (key !== t.key) {
      t.key = key;
      t.el.dataset.tone = tone;
      t.lv.textContent = levelText(npcLevel, tone);
      t.name.textContent = name;
    }
    const pos = `${Math.round((_p.x * 0.5 + 0.5) * innerWidth)}px,${Math.round((-_p.y * 0.5 + 0.5) * innerHeight)}px`;
    const lk = `${look.opacity.toFixed(2)}|${look.scale.toFixed(2)}`;
    if (pos !== t.pos || lk !== t.look) {
      t.pos = pos;
      t.look = lk;
      t.el.style.transform = `translate(${pos}) translate(-50%, -100%) scale(${look.scale.toFixed(2)})`;
      t.el.style.opacity = look.opacity.toFixed(2);
    }
  }

  end() {
    for (const [id, t] of this.tags) {
      if (this.seen.has(id)) continue;
      t.el.remove();
      this.tags.delete(id);
    }
  }

  dispose() {
    this.root.remove();
    this.tags.clear();
  }
}
