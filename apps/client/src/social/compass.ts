// Compass strip at the top of the HUD: N/E/S/W relative to the camera, party members on the same
// body, the way back to safety while you're outside safe zones (the nearest pad's 12 m ring, or on
// Portus the nearest town gate: shared zones.ts), the nearest pad (on Portus: the plaza, home), your
// waypoint (ui/waypoint.ts), and markers other systems add (`compassGuides`: the tracked mission, the
// tutorial's next place), each with its distance (#70). Turning until a marker sits under the caret
// faces it.

import { BODIES, nearestSafeEntry, padDirs, type BodyId } from "@firstlight/shared";
import { placeDir } from "@firstlight/shared/content/places";
import { el } from "./dom.ts";
import { bearingTo, headingOf, stripX, surfaceDistance, type V3 } from "./compassMath.ts";

const HALF_SPAN = 95; // degrees visible either side of centre
const CARDINALS: [number, string][] = [[0, "N"], [45, "NE"], [90, "E"], [135, "SE"], [180, "S"], [225, "SW"], [270, "W"], [315, "NW"]];
/** Party slot colours (UI kit --party-1…4), always shown with the slot number or name. */
export { PARTY_SLOT_COLOURS as PARTY_COLOURS } from "../ui/partyFrames.ts";

export interface CompassMarker {
  key: string;
  label: string;
  colour: string;
  pos: V3;
  /** Party member (default), a guide (the tutorial's next place), the tracked mission or the nearest pad. */
  kind?: "party" | "guide" | "mission" | "home";
}

/**
 * Compass markers from other systems (#68, #70): the tutorial's way, the tracked mission. Each source
 * returns its markers every frame; SocialUi adds them to the party's.
 */
export const compassGuides = new Set<() => CompassMarker[]>();

export class Compass {
  readonly root = el("div", "fl-compass");
  private readonly ticks: HTMLElement[] = [];
  private readonly cards: { deg: number; e: HTMLElement }[] = [];
  private readonly markers = new Map<string, { e: HTMLElement; dot: HTMLElement; text: HTMLElement; label: string }>();
  private readonly pad = el("div", "mk pad");
  private readonly padText: HTMLElement;
  /** The nearest pad (on Portus, the plaza: home), hidden when you stand on it. */
  private readonly home = el("div", "mk home");
  private readonly homeText: HTMLElement;
  private homeLabel = "";
  private readonly wp = el("div", "mk wp");
  private readonly wpText: HTMLElement;
  private wpLabel = "";

  /** Mount inside the HUD root so it hides with the HUD (photo mode). */
  constructor(parent: HTMLElement = document.body) {
    parent.appendChild(this.root);
    this.root.style.display = "none"; // until the first update in a room
    for (let d = 0; d < 360; d += 15) {
      if (d % 45 === 0) continue;
      const t = el("div", "tk", this.root);
      t.dataset.deg = String(d);
      this.ticks.push(t);
    }
    for (const [deg, name] of CARDINALS) {
      const e = el("div", `cd${deg % 90 === 0 ? " main" : ""}${deg === 0 ? " n" : ""}`, this.root, name);
      this.cards.push({ deg, e });
    }
    el("i", "", this.pad);
    this.padText = el("span", "", this.pad);
    this.root.appendChild(this.pad);
    this.home.dataset.e2e = "compass-home";
    el("i", "", this.home);
    this.homeText = el("span", "", this.home);
    this.root.appendChild(this.home);
    this.wp.dataset.e2e = "compass-waypoint";
    this.wp.style.display = "none";
    el("i", "", this.wp);
    this.wpText = el("span", "", this.wp);
    this.root.appendChild(this.wp);
  }

  setVisible(on: boolean) {
    this.root.style.display = on ? "" : "none";
  }

  /**
   * @param pos     player position
   * @param forward camera forward tangent
   * @param body    current body (pads)
   * @param safe    standing in a safe zone (hides the pad marker)
   * @param waypoint your waypoint's unit direction on this body, if any
   */
  update(pos: V3, forward: V3, body: BodyId, safe: boolean, markers: CompassMarker[], waypoint: V3 | null = null) {
    if (this.root.style.display === "none") this.root.style.display = "";
    const heading = headingOf(pos, forward);
    const place = (e: HTMLElement, rel: number, hideOff = true) => {
      const s = stripX(rel, HALF_SPAN);
      e.style.left = `${(s.x * 100).toFixed(2)}%`;
      e.style.display = s.clamped && hideOff ? "none" : "";
      return s.clamped;
    };
    for (const t of this.ticks) place(t, Number(t.dataset.deg) - heading);
    for (const c of this.cards) place(c.e, c.deg - heading);

    // The way back to safety: the nearest pad's ring, or a Portus town gate.
    const def = BODIES[body];
    if (safe) this.pad.style.display = "none";
    else {
      const entry = nearestSafeEntry(def, pos[0], pos[1], pos[2]);
      const d = entry.dir;
      const R = def.radius;
      const target: V3 = [d[0] * R, d[1] * R, d[2] * R];
      const clamped = place(this.pad, bearingTo(pos, forward, target), false);
      this.pad.classList.toggle("edge", clamped);
      this.padText.textContent = `SAFE ${Math.max(0, Math.round(surfaceDistance(pos, target, R) - entry.edge))} m`;
    }

    // Home: the nearest pad on a planet, the plaza on Portus; always shown (pinned at the strip's end
    // when it's behind you) unless you're standing on it.
    {
      const R = def.radius;
      const dirs = def.terrain.kind === "hub" ? [placeDir("portus_plaza")] : padDirs(def);
      const up = Math.hypot(pos[0], pos[1], pos[2]) || 1;
      let best = dirs[0]!;
      let bestDot = -Infinity;
      for (const d of dirs) {
        const k = (d[0] * pos[0] + d[1] * pos[1] + d[2] * pos[2]) / up;
        if (k > bestDot) {
          bestDot = k;
          best = d;
        }
      }
      const target: V3 = [best[0] * R, best[1] * R, best[2] * R];
      const m = Math.round(surfaceDistance(pos, target, R));
      const label = m <= 15 ? "" : `${def.terrain.kind === "hub" ? "HOME" : "PAD"} ${m} m`;
      if (label !== this.homeLabel) {
        this.homeLabel = label;
        this.homeText.textContent = label;
        this.home.style.display = label ? "" : "none";
      }
      if (label) this.home.classList.toggle("edge", place(this.home, bearingTo(pos, forward, target), false));
    }

    // Waypoint: always shown, pinned to the strip's end when it's behind you.
    if (!waypoint) {
      if (this.wpLabel) {
        this.wp.style.display = "none";
        this.wpLabel = "";
      }
    } else {
      const R = def.radius;
      const target: V3 = [waypoint[0] * R, waypoint[1] * R, waypoint[2] * R];
      this.wp.classList.toggle("edge", place(this.wp, bearingTo(pos, forward, target), false));
      const label = `${Math.round(surfaceDistance(pos, target, R))} m`;
      if (label !== this.wpLabel) {
        this.wpLabel = label;
        this.wpText.textContent = label;
      }
    }

    // Party members, then the other systems' markers (the tracked mission, the tutorial's way).
    const seen = new Set<string>();
    for (const m of markers) {
      seen.add(m.key);
      let v = this.markers.get(m.key);
      if (!v) {
        const e = el("div", `mk${m.kind && m.kind !== "party" ? ` ${m.kind}` : ""}`, this.root);
        if (m.kind && m.kind !== "party") e.dataset.e2e = `compass-${m.kind}`;
        const dot = el("i", "", e);
        const text = el("span", "", e);
        v = { e, dot, text, label: "" };
        this.markers.set(m.key, v);
      }
      if (v.dot.style.background !== m.colour) v.dot.style.background = m.colour;
      const dist = Math.round(Math.hypot(m.pos[0] - pos[0], m.pos[1] - pos[1], m.pos[2] - pos[2]));
      const label = `${m.label} ${dist > 50 ? Math.round(dist / 5) * 5 : dist} m`;
      if (label !== v.label) {
        v.label = label;
        v.text.textContent = label;
      }
      const clamped = place(v.e, bearingTo(pos, forward, m.pos), false);
      v.e.classList.toggle("edge", clamped);
    }
    for (const [k, v] of this.markers) {
      if (!seen.has(k)) {
        v.e.remove();
        this.markers.delete(k);
      }
    }
  }

  dispose() {
    this.root.remove();
  }
}
