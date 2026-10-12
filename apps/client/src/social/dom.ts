// Small DOM helpers for the social UI (plain DOM, D25).

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", parent?: HTMLElement | null, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

export function sbtn(label: string, onClick: () => void, cls = "", parent?: HTMLElement | null, title?: string): HTMLButtonElement {
  const b = el("button", `fl-sbtn${cls ? ` ${cls}` : ""}`, parent, label);
  b.type = "button";
  if (title) b.title = title;
  b.onclick = (e) => {
    e.stopPropagation();
    onClick();
  };
  return b;
}

/** Keys typed into our fields must not reach the game's window listeners. */
export function isolateKeys(e: HTMLElement): void {
  for (const type of ["keydown", "keyup", "keypress"]) e.addEventListener(type, (ev) => ev.stopPropagation());
}

/** True when the event comes from a text field (don't treat it as a game key). */
export function typing(ev: KeyboardEvent): boolean {
  const t = ev.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

export function uiRoot(): HTMLElement {
  return document.getElementById("ui") ?? document.body;
}
