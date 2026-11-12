// Gamepad focus navigation for every menu (D-controls-5): the pause menu, Settings, inventory, shop,
// journal, map, starter pick, death screen, the mission panels and cards. No menu registers anything:
// the navigator moves the browser's focus among the controls a player can actually see and click
// (the top layer: a control covered by a modal's scrim doesn't count), picks the nearest one in the
// pushed direction, and A clicks it. B sends Esc, which every panel already handles. A visible ring
// (`fl-padfocus`, controls.css) marks the focused control.

export type Dir = "up" | "down" | "left" | "right";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const VEC: Record<Dir, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

/**
 * The best target from `from` in direction `dir` among `boxes` (index, or -1). A candidate must lie
 * ahead (its centre past `from`'s centre along the direction); the score is the distance along the
 * direction plus twice the sideways offset, with a bonus for overlapping `from` across the direction
 * (the next row of a list beats a nearer item off to the side).
 */
export function pickNext(from: Box, boxes: readonly Box[], dir: Dir): number {
  const [dx, dy] = VEC[dir];
  const fx = from.x + from.w / 2;
  const fy = from.y + from.h / 2;
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]!;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const along = (cx - fx) * dx + (cy - fy) * dy;
    if (along <= 1) continue;
    const side = Math.abs((cx - fx) * dy) + Math.abs((cy - fy) * dx);
    // Overlap across the direction: rows for up/down, columns for left/right.
    const overlap = dx === 0 ? Math.min(b.x + b.w, from.x + from.w) - Math.max(b.x, from.x) : Math.min(b.y + b.h, from.y + from.h) - Math.max(b.y, from.y);
    const score = along + side * 2 - (overlap > 0 ? 40 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

const FOCUSABLE = 'button, [href], input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"]), [role="button"], [role="tab"], [role="radio"]';

/** Can this element take a click right now (shown, enabled, not inert)? */
function usable(el: HTMLElement): boolean {
  if ((el as HTMLButtonElement).disabled) return false;
  if (el.closest("[hidden], [inert], [aria-hidden='true']")) return false;
  if (el.getClientRects().length === 0) return false;
  const st = getComputedStyle(el);
  return st.visibility !== "hidden" && st.pointerEvents !== "none";
}

/** The nearest scrolling ancestor (for controls in a long list scrolled out of view). */
function scroller(el: HTMLElement, self = false): HTMLElement | null {
  for (let p = self ? el : el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if ((o === "auto" || o === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/**
 * On the top layer: a hit test at the control's visible middle lands on it (or inside it). A control
 * scrolled out of its list counts when the list itself is on top. Without layout (tests), everything does.
 */
export function onTop(el: HTMLElement, doc: Document = document): boolean {
  if (typeof doc.elementFromPoint !== "function") return true;
  const r = el.getBoundingClientRect();
  const vw = doc.documentElement.clientWidth || innerWidth;
  const vh = doc.documentElement.clientHeight || innerHeight;
  const x = Math.min(Math.max(r.left + r.width / 2, 1), vw - 1);
  const y = Math.min(Math.max(r.top + r.height / 2, 1), vh - 1);
  const inView = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
  if (inView) {
    const hit = doc.elementFromPoint(x, y);
    if (hit === null) return true; // no layout (happy-dom): trust the visibility checks
    if (hit === el || el.contains(hit) || hit.contains(el)) return true;
    // Partly scrolled out: try the list's visible part.
  }
  const s = scroller(el);
  if (!s) return false;
  const sr = s.getBoundingClientRect();
  const hit = doc.elementFromPoint(Math.min(Math.max(sr.left + sr.width / 2, 1), vw - 1), Math.min(Math.max(sr.top + sr.height / 2, 1), vh - 1));
  return hit === null || s.contains(hit);
}

/** Every control a player can reach right now, in document order. */
export function reachable(root: ParentNode = document): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const el of root.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (el.closest(".fl-touch")) continue; // the touch overlay's own buttons
    if (usable(el) && onTop(el)) out.push(el);
  }
  return out;
}

const box = (el: HTMLElement): Box => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};

const RING = "fl-padfocus";

/** Moves focus with a gamepad; clicks; adjusts sliders and selects sideways. */
export class FocusNav {
  private ringed: HTMLElement | null = null;

  constructor(private readonly doc: Document = document) {}

  /** The focused control, if it is still reachable. */
  current(): HTMLElement | null {
    const a = this.doc.activeElement as HTMLElement | null;
    if (!a || a === this.doc.body || !a.matches?.(FOCUSABLE)) return null;
    return usable(a) && onTop(a, this.doc) ? a : null;
  }

  /** Is there anything to navigate (a menu, panel or card is up)? */
  hasTargets(): boolean {
    return reachable(this.doc).length > 0;
  }

  /** Focus the preferred first control: the menu's Resume, a primary button, else the first. */
  focusFirst(): HTMLElement | null {
    const all = reachable(this.doc);
    const pick = all.find((e) => e.matches(".is-resume, .fl-btn--primary, [autofocus]")) ?? all[0] ?? null;
    if (pick) this.focus(pick);
    return pick;
  }

  move(dir: Dir): HTMLElement | null {
    const cur = this.current();
    if (!cur) return this.focusFirst();
    // Sliders and selects take left/right as a change of value.
    if ((dir === "left" || dir === "right") && this.adjust(cur, dir === "right" ? 1 : -1)) return cur;
    const all = reachable(this.doc).filter((e) => e !== cur);
    const i = pickNext(box(cur), all.map(box), dir);
    if (i < 0) return cur;
    this.focus(all[i]!);
    return all[i]!;
  }

  /** A: click the focused control (or focus one first). */
  accept(): void {
    const cur = this.current();
    if (!cur) {
      this.focusFirst();
      return;
    }
    if (cur instanceof HTMLInputElement && (cur.type === "range" || cur.type === "text" || cur.type === "email" || cur.type === "search")) {
      if (cur.type !== "range") cur.select?.();
      return;
    }
    cur.click();
  }

  /** Right stick in a menu: scroll the focused control's list (or the page). */
  scroll(dy: number): void {
    const cur = this.current();
    const s = cur ? scroller(cur, true) : null; // a focused scrolling panel (How to play) scrolls itself
    (s ?? this.doc.scrollingElement)?.scrollBy?.({ top: dy });
  }

  focus(el: HTMLElement): void {
    this.ringed?.classList.remove(RING);
    el.focus({ preventScroll: true });
    el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    el.classList.add(RING);
    this.ringed = el;
  }

  /** Drop the ring (the player went back to the mouse or into the game). */
  clearRing(): void {
    this.ringed?.classList.remove(RING);
    this.ringed = null;
  }

  private adjust(el: HTMLElement, step: 1 | -1): boolean {
    if (el instanceof HTMLInputElement && el.type === "range") {
      // By hand: stepUp/stepDown throw on some engines for a value off the step grid.
      const min = Number(el.min || 0), max = Number(el.max || 100), st = Number(el.step) || 1;
      const v = Math.min(max, Math.max(min, Number(el.value) + step * st));
      el.value = String(Math.round(v / st) * st === v ? v : Number(v.toFixed(6)));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    if (el instanceof HTMLSelectElement) {
      const n = el.options.length;
      if (!n) return false;
      el.selectedIndex = Math.min(n - 1, Math.max(0, el.selectedIndex + step));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    return false;
  }
}
