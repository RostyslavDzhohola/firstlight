// Keycap glyphs follow the last-used device (D-controls-5): "E" on the keyboard, X (or □) on a pad,
// "Use" on touch. One helper, glyphFor, decides; GlyphSync applies it to the HUD's and the tutorial's
// keycaps without touching the code that writes them: it sets `data-glyph` on each keycap and
// controls.css draws that instead of the key's text. The observer runs only while a pad or touch is
// the device, so keyboard players pay nothing.

import { padGlyph, touchGlyph, type PadFamily } from "../game/padMapping.ts";
import type { Device } from "../game/input.ts";

/**
 * What a keycap shows on `device`: the key's own text (null) on the keyboard; otherwise the pad or
 * touch label, "" to hide it (A/S/D next to the stick's W, hotbar numbers).
 */
export function glyphFor(cap: string, device: Device, family: PadFamily = "xbox", where: "key" | "slot" = "key"): string | null {
  if (device === "kbm") return null;
  if (where === "slot") return ""; // hotbar numbers: LB/RB (or a tap) pick slots, not numbers
  const g = device === "pad" ? padGlyph(cap, family) : touchGlyph(cap);
  return g ?? "";
}

/** Keycaps the HUD, the interaction prompt and the tutorial print. Menus keep the keyboard's. */
const SELECTOR = ".fl-hud .fl-key, .fl-onb .fl-key, .fl-hud .fl-spell__k, .fl-hud .fl-slot__k";

export class GlyphSync {
  private device: Device = "kbm";
  private family: PadFamily = "xbox";
  private observer: MutationObserver | null = null;
  private queued = false;

  constructor(private readonly root: () => ParentNode = () => document) {}

  set(device: Device, family: PadFamily): void {
    if (device === this.device && family === this.family) return;
    this.device = device;
    this.family = family;
    document.documentElement.classList.toggle("fl-glyphs", device !== "kbm");
    document.documentElement.dataset.device = device;
    this.apply();
    if (device === "kbm") {
      this.observer?.disconnect();
      this.observer = null;
    } else if (!this.observer && typeof MutationObserver !== "undefined") {
      // Keycaps are created and rewritten as prompts change: re-apply after each batch of DOM changes.
      this.observer = new MutationObserver(() => this.queue());
      this.observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    }
  }

  private queue(): void {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      this.apply();
    });
  }

  /** Write data-glyph on every keycap (or remove it on the keyboard). */
  apply(): void {
    for (const k of this.root().querySelectorAll<HTMLElement>(SELECTOR)) {
      const g = glyphFor(k.textContent ?? "", this.device, this.family, k.classList.contains("fl-slot__k") ? "slot" : "key");
      if (g === null) {
        if (k.dataset.glyph !== undefined) delete k.dataset.glyph;
      } else if (k.dataset.glyph !== g) k.dataset.glyph = g;
    }
  }
}
