// Compass strip at the top of the HUD: N/E/S/W relative to the camera, party members on the same
// body, and the way back to safety while you're outside safe zones: the nearest pad's 12 m ring, or
// on Portus the nearest town gate (shared zones.ts).

import { BODIES, nearestSafeEntry, type BodyId } from "@firstlight/shared";
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
}

export class Compass {
  readonly root = el("div", "fl-compass");
  private readonly ticks: HTMLElement[] = [];
  private readonly cards: { deg: number; e: HTMLElement }[] = [];
  private readonly markers = new Map<string, { e: HTMLElement; dot: HTMLElement; text: HTMLElement }>();
  private readonly pad = el("div", "mk pad");
  private readonly padText: HTMLElement;

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
  }

  setVisible(on: boolean) {
    this.root.style.display = on ? "" : "none";
  }

  /**
   * @param pos     player position
   * @param forward camera forward tangent
   * @param body    current body (pads)
   * @param safe    standing in a safe zone (hides the pad marker)
   */
  update(pos: V3, forward: V3, body: BodyId, safe: boolean, markers: CompassMarker[]) {
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

    // Party members.
    const seen = new Set<string>();
    for (const m of markers) {
      seen.add(m.key);
      let v = this.markers.get(m.key);
      if (!v) {
        const e = el("div", "mk", this.root);
        const dot = el("i", "", e);
        const text = el("span", "", e);
        v = { e, dot, text };
        this.markers.set(m.key, v);
      }
      v.dot.style.background = m.colour;
      const dist = Math.round(Math.hypot(m.pos[0] - pos[0], m.pos[1] - pos[1], m.pos[2] - pos[2]));
      v.text.textContent = `${m.label} ${dist} m`;
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
