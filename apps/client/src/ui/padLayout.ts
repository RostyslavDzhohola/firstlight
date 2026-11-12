// The gamepad layout as a list (the pause menu's How to play and Settings), in the pad's own labels.

import { padControls, type PadFamily } from "../game/padMapping.ts";

const FAMILY_NAME: Record<PadFamily, string> = { xbox: "Xbox-style", playstation: "PlayStation-style", nintendo: "Switch Pro-style" };

export function padLayoutList(parent: HTMLElement, family: PadFamily): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "fl-padkeys";
  wrap.dataset.e2e = "pad-layout";
  wrap.setAttribute("aria-label", `Gamepad controls (${FAMILY_NAME[family]} labels)`);
  for (const g of padControls(family)) {
    const col = document.createElement("div");
    const h = document.createElement("h3");
    h.textContent = g.title;
    col.appendChild(h);
    const dl = document.createElement("dl");
    for (const [glyph, label] of g.rows) {
      const dt = document.createElement("dt");
      for (const part of glyph.split(" · ")) {
        const k = document.createElement("span");
        k.className = "fl-padglyph";
        k.textContent = part;
        dt.appendChild(k);
      }
      const dd = document.createElement("dd");
      dd.textContent = label;
      dl.append(dt, dd);
    }
    col.appendChild(dl);
    wrap.appendChild(col);
  }
  parent.appendChild(wrap);
  return wrap;
}
