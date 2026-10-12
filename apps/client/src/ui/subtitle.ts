// Speaker subtitles (boss voice lines). Always shown, so the lines work with the sound off.
// Part of the HUD (data-hud): photo mode hides it.

import { el, uiRoot } from "./dom.ts";

let box: HTMLDivElement | null = null;
let who: HTMLElement | null = null;
let line: HTMLElement | null = null;
let timer = 0;

export function showSubtitle(speaker: string, text: string, ms = 4500): void {
  if (!box || !box.isConnected) {
    box = el("div", "fl-subtitle is-off", uiRoot());
    box.dataset.hud = "";
    box.setAttribute("role", "status");
    who = el("b", "", box);
    line = el("span", "", box);
  }
  who!.textContent = speaker;
  line!.textContent = text;
  box.classList.remove("is-off");
  clearTimeout(timer);
  timer = window.setTimeout(() => box?.classList.add("is-off"), ms);
}
