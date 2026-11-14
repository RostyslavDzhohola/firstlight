// The spellbook on the HUD: four spell slots beside the hotbar (keycap, icon, cooldown sweep and
// seconds, "Lv N" while locked, a violet edge when aether is short) and the aether bar under HP.
// Plain DOM (D25). update() runs every frame and writes only what changed since the last one.

import "./spellBar.css";
import { SPELLS } from "@firstlight/shared/content/spells";
import type { SpellBarView } from "../game/spellBook.ts";
import { el, sprite } from "./dom.ts";
import { spellTooltip } from "../game/spellInfo.ts";

interface SlotRefs {
  root: HTMLElement;
  cd: HTMLElement;
  n: HTMLElement;
  lock: HTMLElement;
  cls: string;
  text: string;
  sweep: number;
}

/** What a slot shows: its state class, the text over the icon and the cooldown sweep (hundredths). */
export function slotLook(s: SpellBarView["slots"][number], ward: SpellBarView["ward"]): { cls: string; text: string; sweep: number } {
  if (s.locked) return { cls: "is-locked", text: `Lv ${s.level}`, sweep: 0 };
  // The ward's slot shows the shell while it is up.
  if (s.id === "glasswing" && ward) return { cls: "is-up", text: String(Math.max(0, Math.round(ward.hp))), sweep: 0 };
  if (s.cooldown > 0) return { cls: "is-cd", text: s.cooldown >= 9.5 ? String(Math.round(s.cooldown)) : s.cooldown.toFixed(s.cooldown < 3 ? 1 : 0), sweep: Math.ceil(s.cooldownFrac * 100) };
  if (s.short) return { cls: "is-short", text: String(s.cost), sweep: 0 };
  return { cls: "is-ready", text: "", sweep: 0 };
}

export class SpellBar {
  readonly root = el("div", "fl-spells");
  private readonly slots: SlotRefs[] = [];
  private readonly aether: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly val: HTMLElement;
  private last = { fill: -1, val: "", low: false };

  private numbersKey = "";

  /** Tooltips with each spell's numbers at `level` for this starter (#79); DOM only when they change. */
  setNumbers(level: number, starter: number) {
    const key = `${level}|${starter}`;
    if (key === this.numbersKey) return;
    this.numbersKey = key;
    SPELLS.forEach((s, i) => {
      const slot = this.slots[i];
      if (slot) slot.root.title = spellTooltip(s, level, starter);
    });
  }

  constructor(spellSlot: HTMLElement, aetherSlot: HTMLElement) {
    this.root.setAttribute("role", "toolbar");
    this.root.setAttribute("aria-label", "Spells");
    this.root.dataset.e2e = "spell-bar";
    for (const s of SPELLS) {
      const root = el("div", "fl-spell", this.root);
      root.dataset.spell = s.id;
      root.title = `${s.name} (${s.keycap}): ${s.blurb}`;
      el("span", "fl-spell__k", root, s.keycap);
      const box = el("div", "fl-spell__box fl-arcade", root);
      sprite(`spell-${s.id}`, "fl-spell__icon", box);
      const cd = el("i", "fl-spell__cd", box);
      const n = el("span", "fl-spell__n num", box);
      const lock = sprite("lock", "fl-spell__lock", box);
      lock.hidden = true;
      this.slots.push({ root, cd, n, lock, cls: "", text: "\u0000", sweep: -1 });
    }
    spellSlot.appendChild(this.root);

    this.aether = aetherSlot;
    sprite("aether", "", aetherSlot);
    const bar = el("div", "fl-aebar", aetherSlot);
    bar.setAttribute("role", "meter");
    bar.setAttribute("aria-label", "Aether");
    this.fill = el("i", "", bar);
    this.val = el("span", "v num", aetherSlot, "100");
    this.aether.dataset.e2e = "aether";
  }

  update(v: SpellBarView) {
    for (let i = 0; i < this.slots.length; i++) {
      const r = this.slots[i]!, s = v.slots[i];
      if (!s) continue;
      const look = slotLook(s, v.ward);
      if (look.cls !== r.cls) {
        if (r.cls) r.root.classList.remove(r.cls);
        r.root.classList.add(look.cls);
        r.lock.hidden = look.cls !== "is-locked";
        r.cls = look.cls;
      }
      if (look.text !== r.text) r.n.textContent = r.text = look.text;
      if (look.sweep !== r.sweep) {
        r.sweep = look.sweep;
        r.cd.style.setProperty("--cd", (look.sweep / 100).toFixed(2));
      }
    }
    // Half-percent steps: the bar moves smoothly without a style write every frame.
    const fill = Math.round((v.aether / v.max) * 200) / 200;
    if (fill !== this.last.fill) {
      this.last.fill = fill;
      this.fill.style.setProperty("--fill", String(fill));
    }
    const val = String(Math.floor(v.aether));
    if (val !== this.last.val) this.val.textContent = this.last.val = val;
    const low = v.aether < Math.min(...v.slots.filter((s) => !s.locked).map((s) => s.cost));
    if (low !== this.last.low) {
      this.last.low = low;
      this.aether.classList.toggle("is-low", low);
    }
  }

  /** A press landed (`cast`) or couldn't (`deny`): the slot jumps or shakes once. */
  pulse(index: number, kind: "cast" | "deny") {
    const r = this.slots[index]?.root;
    if (!r) return;
    const cls = kind === "cast" ? "is-cast" : "is-deny";
    r.classList.remove("is-cast", "is-deny");
    // Restart the animation next frame (no layout read here).
    requestAnimationFrame(() => {
      r.classList.add(cls);
      setTimeout(() => r.classList.remove(cls), 320);
    });
  }

  dispose() {
    this.root.remove();
    this.aether.replaceChildren();
  }
}
