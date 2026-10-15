// Tiny DOM helpers for the plain-DOM UI (D25) and a registry of open full-screen overlays.

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", parent?: Element | null, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

/** `<i class="px px-name">` sprite (see sprites.ts). */
export function sprite(name: string, extra = "", parent?: Element | null): HTMLElement {
  return el("i", `px px-${name}${extra ? ` ${extra}` : ""}`, parent);
}

/** `<i class="li li-name">` line icon (see styles/icons.css). */
export function icon(name: string, extra = "", parent?: Element | null): HTMLElement {
  return el("i", `li li-${name}${extra ? ` ${extra}` : ""}`, parent);
}

export function button(label: string, cls = "fl-btn", parent?: Element | null, onClick?: () => void): HTMLButtonElement {
  const b = el("button", cls, parent, label);
  b.type = "button";
  if (onClick) b.onclick = onClick;
  return b;
}

/** Keycaps: keycaps(["W", "A", "S", "D"]) */
export function keycaps(keys: readonly string[], parent?: Element | null): HTMLElement {
  const wrap = el("span", "fl-keys", parent);
  for (const k of keys) el("span", `fl-key${k.length > 2 ? " fl-key--wide" : ""}`, wrap, k);
  return wrap;
}

/** Where UI goes: the #ui root (it carries the .fl-ui tokens). */
export function uiRoot(): HTMLElement {
  return document.getElementById("ui") ?? document.body;
}

/** Keys typed into our fields must not reach the game's window listeners. */
export function isolateKeys(e: HTMLElement): void {
  for (const type of ["keydown", "keyup", "keypress"]) e.addEventListener(type, (ev) => ev.stopPropagation());
}

// ------------------------------------------------------------------------------------------------ overlay registry

const open = new Set<string>();
const listeners = new Set<() => void>();

/** Mark a full-screen overlay as open (death, character pick, sign-in…). The Esc menu stays away while any is open. */
export function overlayOpened(name: string): void {
  if (open.has(name)) return;
  open.add(name);
  for (const fn of listeners) fn();
}

export function overlayClosed(name: string): void {
  if (!open.delete(name)) return;
  for (const fn of listeners) fn();
}

/** Called after an overlay opens or closes (the Esc menu's state follows: pauseFlow.ts). */
export function onOverlayChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function isOverlayOpen(except?: string): boolean {
  for (const n of open) if (n !== except) return true;
  return false;
}
