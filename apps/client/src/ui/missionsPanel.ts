// The HUD missions panel (top right, under the minimap): the open missions, one row each (#69). The
// tracked one shows its objective; the rest are one-line titles, and a click on one tracks it
// (game/missionTrack.ts). The header carries a visible collapse control with its key (L, or a click):
// collapsed, the panel is one line. Settings → "Missions" hides it (#3). Both live in uiSettings, so
// they survive reloads. The mission pointer and the journal (J) don't depend on it.

import { el } from "./dom.ts";
import type { MissionLine } from "./hud.ts";
import { uiSettings } from "./uiSettings.ts";
import { missionTrack } from "../game/missionTrack.ts";

/** The key that collapses and expands the panel (game/keys.ts BINDINGS, read in QuestClient). */
export const MISSIONS_KEY = { code: "KeyL", cap: "L" } as const;

/** The "+N more (J)" line: how many open missions aren't listed, and what a click on it does (open the journal). */
export interface MissionsMore {
  count: number;
  open: () => void;
}

export class MissionsPanel {
  readonly root: HTMLElement;
  private lines: MissionLine[] = [];
  private header = "";
  private more: MissionsMore | null = null;
  private key = "";
  private readonly off: () => void;

  constructor(parent: HTMLElement) {
    this.root = el("section", "fl-missions fl-holo fl-corners", parent);
    this.root.hidden = true;
    this.off = uiSettings.onChange((s, prev) => {
      if (s.missions !== prev.missions || s.missionsCollapsed !== prev.missionsCollapsed) this.render();
    });
  }

  set(lines: MissionLine[], header = "", more: MissionsMore | null = null) {
    const key = JSON.stringify([lines, header, more?.count ?? 0]);
    this.more = more;
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
    b.dataset.e2e = "missions-toggle";
    b.setAttribute("aria-expanded", String(!missionsCollapsed));
    b.title = `${missionsCollapsed ? "Show missions" : "Collapse missions"} (${MISSIONS_KEY.cap})`;
    b.onclick = () => uiSettings.set({ missionsCollapsed: !uiSettings.get().missionsCollapsed });
    el("span", "fl-label", b, "Missions");
    // Collapsed: the tracked mission's title and progress stay on the one line.
    const tracked = this.lines.find((l) => l.state === "tracked");
    el("span", "fl-missions__h", b, missionsCollapsed && tracked ? `${tracked.title} · ${tracked.progress}` : this.header);
    const ctl = el("span", "fl-missions__ctl", b);
    el("span", "fl-key", ctl, MISSIONS_KEY.cap);
    el("i", `fl-missions__chev${missionsCollapsed ? " is-closed" : ""}`, ctl);
    if (focused) b.focus();
    if (missionsCollapsed) return;
    for (const m of this.lines) {
      const open = m.state === "open";
      const row = el(open ? "button" : "div", `fl-mission${m.state && m.state !== "open" ? ` is-${m.state}` : ""}`, this.root);
      if (m.colour) row.style.setProperty("--mc", m.colour);
      row.dataset.e2e = `mission-row-${m.id}`;
      if (open && row instanceof HTMLButtonElement) {
        row.type = "button";
        row.title = "Track this mission";
        row.onclick = () => missionTrack.choose(m.id);
      }
      el("i", "fl-mission__st", row);
      const d = el("div", "", row);
      el("b", "", d, m.title);
      // Only the tracked mission says what to do (#69); the others are one line.
      if (m.state === "tracked") el("span", "", d, m.detail);
      el("span", "fl-mission__r num", row, m.state === "tracked" ? `▸ ${m.progress}` : m.progress);
    }
    if (this.more && this.more.count > 0) {
      const more = el("button", "fl-missions__more hit-area", this.root);
      more.type = "button";
      more.dataset.e2e = "missions-more";
      more.append(`+${this.more.count} more `);
      el("span", "fl-key", more, "J");
      more.onclick = () => this.more?.open();
    }
  }
}
