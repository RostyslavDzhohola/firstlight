// Speaker subtitles (characters' and bosses' spoken lines, residents answering you). One line at a
// time: each show returns a token, and only the line still on screen can be held longer or hidden by
// it (audio/speech.ts holds a line while its recording plays). Part of the HUD (data-hud): photo
// mode hides it.

import { el, uiRoot } from "./dom.ts";

let box: HTMLDivElement | null = null;
let who: HTMLElement | null = null;
let line: HTMLElement | null = null;
let timer = 0;
let shown = 0;

/** Show a line for `ms`; returns its token (for holdSubtitle and hideSubtitle). */
export function showSubtitle(speaker: string, text: string, ms = 4500): number {
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
  hideIn(ms);
  return ++shown;
}

function hideIn(ms: number) {
  clearTimeout(timer);
  timer = window.setTimeout(() => box?.classList.add("is-off"), ms);
}

/** Keep line `token` up (again) for `ms` from now, if it is still the line on screen. */
export function holdSubtitle(token: number, ms: number): void {
  if (token !== shown || !box) return;
  box.classList.remove("is-off");
  hideIn(ms);
}

/** Take line `token` down now, if it is still the line on screen. */
export function hideSubtitle(token: number): void {
  if (token !== shown || !box) return;
  clearTimeout(timer);
  box.classList.add("is-off");
}
