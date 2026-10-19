// The HUD missions panel (top right, under the minimap): the open missions, one row each. A click on
// its header collapses it to that line and back; Settings → "Missions" hides it (#3). Both live in
// uiSettings, so they survive reloads. The mission pointer and the journal (J) don't depend on it.

import { el } from "./dom.ts";
import type { MissionLine } from "./hud.ts";
import { uiSettings } from "./uiSettings.ts";

export class MissionsPanel {
  readonly root: HTMLElement;
  private lines: MissionLine[] = [];
  private header = "";
  private key = "";
  private readonly off: () => void;

  constructor(parent: HTMLElement) {
    this.root = el("section", "fl-missions fl-holo fl-corners", parent);
    this.root.hidden = true;
    this.off = uiSettings.onChange((s, prev) => {
      if (s.missions !== prev.missions || s.missionsCollapsed !== prev.missionsCollapsed) this.render();
    });
  }

  set(lines: MissionLine[], header = "") {
    const key = JSON.stringify([lines, header]);
    if (key === this.key) return;
    this.key = key;
    this.lines = lines;
    this.header = header;
    this.render();
  }

  dispose() {
    this.off();
    this.root.remove();
  }

  private render() {
    const { missions, missionsCollapsed } = uiSettings.get();
    // The header button is rebuilt below: keep the keyboard focus on it across a toggle.
    const focused = !!this.root.querySelector("header button") && this.root.querySelector("header button") === document.activeElement;
    this.root.hidden = !missions || this.lines.length === 0;
    this.root.replaceChildren();
    if (this.root.hidden) return;
    this.root.classList.toggle("is-collapsed", missionsCollapsed);
    const h = el("header", "", this.root);
    const b = el("button", "hit-area", h);
    b.type = "button";
    b.setAttribute("aria-expanded", String(!missionsCollapsed));
    b.title = missionsCollapsed ? "Show missions" : "Collapse missions";
    b.onclick = () => uiSettings.set({ missionsCollapsed: !uiSettings.get().missionsCollapsed });
    el("span", "fl-label", b, "Missions");
    el("span", "", b, this.header);
    if (focused) b.focus();
    if (missionsCollapsed) return;
    for (const m of this.lines) {
      const row = el("div", `fl-mission${m.state && m.state !== "open" ? ` is-${m.state}` : ""}`, this.root);
      el("i", "fl-mission__st", row);
      const d = el("div", "", row);
      el("b", "", d, m.title);
      el("span", "", d, m.detail);
      el("span", "fl-mission__r num", row, m.progress);
    }
  }
}
