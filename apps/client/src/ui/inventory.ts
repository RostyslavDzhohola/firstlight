// Inventory panel (I): the 4 hotbar + 16 backpack slots as arcade frames, the item card for the slot
// under the pointer or keyboard focus, what you can do with it, and the drop zone (kit markup:
// src/ui/README.md "Item slot + tooltip", styles/kit.css). Mouse: drag, or click to pick and click to
// place; right-click uses. Keys: arrows, Enter, 1–4, E, X, I / Esc. The logic is inventoryModel.ts;
// this file only draws and forwards. Plain DOM (D25).

import "./styles/kit.css";
import "./inventory.css";
import { BACKPACK_SLOTS, HOTBAR_SLOTS } from "@firstlight/shared/content/character";
import { slotItem } from "@firstlight/shared/content/inventory";
import { RARITY_STYLE } from "@firstlight/shared/content/items";
import type { Game } from "../game/Game.ts";
import { button, el, icon, sprite } from "./dom.ts";
import { InvCursor, invSlots, itemDetails, quickAction, type InvAction, type InvSlot, type InvState } from "./inventoryModel.ts";
import { Panel } from "./panels.ts";

const DRAG_START_PX = 5;
const EMPTY: InvState = { hotbar: [null, null, null, null], backpack: Array(BACKPACK_SLOTS).fill(null), selected: 0, level: 1 };

export class InventoryPanel extends Panel {
  protected closeKeys = ["KeyI"];
  readonly cursor: InvCursor;
  private readonly slotEls: HTMLDivElement[] = [];
  private readonly slotKeys: string[] = [];
  private coinsEl!: HTMLElement;
  private countEl!: HTMLElement;
  private tipWrap!: HTMLElement;
  private actsEl!: HTMLElement;
  private dropZone!: HTMLElement;
  private ghost: HTMLElement | null = null;
  private press: { slot: number; x: number; y: number } | null = null;
  private dragFrom: number | null = null;
  private target: number | "drop" | null = null;
  private tipKey = "";
  private actsKey = "";

  private readonly onKeys = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.code === "Escape" && this.dragFrom !== null) {
      this.endDrag();
      this.swallow(e);
      return;
    }
    const r = this.cursor.key(e.code);
    if (!r.handled) return;
    this.swallow(e);
    this.send(r.actions);
  };
  private readonly onMove = (e: PointerEvent) => this.pointerMove(e);
  private readonly onUp = (e: PointerEvent) => this.pointerUp(e);

  constructor(game: Game) {
    super(game, "fl-inv");
    this.overlay.className = "fl-overlay fl-ui fl-overlay--modal";
    this.cursor = new InvCursor(() => this.state());
    this.build();
  }

  open() {
    if (this.isOpen) return;
    // Before Panel's own capture listener, so Esc can drop a held item without closing the panel.
    window.addEventListener("keydown", this.onKeys, true);
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
    this.cursor.cancel();
    this.cursor.focus = this.game.hud.you?.selected ?? 0;
    super.open();
  }

  close(relock = true) {
    window.removeEventListener("keydown", this.onKeys, true);
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
    this.endDrag();
    this.press = null;
    super.close(relock);
  }

  private swallow(e: KeyboardEvent) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  state(): InvState {
    const y = this.you();
    if (!y) return EMPTY;
    return { hotbar: y.hotbar, backpack: y.backpack, selected: y.selected, level: y.level, worn: y.worn };
  }

  // ---------------------------------------------------------------------------------------------- build (once)

  private build() {
    const b = this.box;
    b.setAttribute("role", "dialog");
    b.setAttribute("aria-label", "Inventory");
    const head = el("header", "", b);
    const h1 = el("h1", "", head, "Inventory");
    el("small", "", h1, "Drag or click to move · right-click to use · drop it to leave it in the world");
    const purse = el("div", "fl-inv__purse", head);
    sprite("coin", "", purse);
    this.coinsEl = el("b", "num", purse, "0");

    const cols = el("div", "fl-inv__cols", b);
    const left = el("div", "", cols);
    const hot = el("div", "fl-inv__group", left);
    const hl = el("div", "fl-label", hot, "Hotbar");
    el("span", "", hl, "1–4");
    const hotGrid = el("div", "fl-inv__grid", hot);
    const pack = el("div", "fl-inv__group", left);
    const pl = el("div", "fl-label", pack, "Backpack");
    this.countEl = el("span", "num", pl, `0 / ${BACKPACK_SLOTS}`);
    const packGrid = el("div", "fl-inv__grid", pack);
    for (let slot = 0; slot < HOTBAR_SLOTS + BACKPACK_SLOTS; slot++) {
      const d = el("div", "fl-islot fl-arcade is-empty", slot < HOTBAR_SLOTS ? hotGrid : packGrid);
      d.dataset.slot = String(slot);
      d.setAttribute("role", "button");
      this.slotEls.push(d);
      this.slotKeys.push("");
    }

    this.tipWrap = el("div", "fl-inv__tipwrap", cols);
    this.tipWrap.setAttribute("aria-live", "polite");
    const aside = el("aside", "", cols);
    this.actsEl = el("div", "fl-panel fl-panel--quiet fl-panel--pad fl-inv__acts", aside);
    this.dropZone = el("div", "fl-dropzone fl-inv__drop", aside);
    this.dropZone.dataset.drop = "";
    const dz = el("b", "", this.dropZone);
    icon("drop", "", dz);
    dz.append("Drop here");
    this.dropZone.append("It stays on the ground. Anyone can pick it up.");
    this.dropZone.onclick = () => this.send(this.cursor.dropHeld());

    const foot = el("footer", "", b);
    const keyHint = (parent: HTMLElement, k: string) => el("span", "fl-key", parent, k);
    const f1 = el("span", "", foot);
    keyHint(f1, "I");
    f1.append("Close");
    const f2 = el("span", "", foot);
    keyHint(f2, "1");
    f2.append("–");
    keyHint(f2, "4");
    f2.append("To hotbar");
    const f3 = el("span", "", foot);
    keyHint(f3, "E");
    f3.append("Use");
    const f4 = el("span", "", foot);
    keyHint(f4, "X");
    f4.append("Drop");
    el("span", "fl-end", foot, "Everything here drops when you die.");

    // Pointer: press → click (pick/place) or drag; hover focuses; right-click is the quick action.
    b.addEventListener("pointerdown", (e) => {
      const slot = slotOf(e.target);
      if (slot === null || e.button !== 0) return;
      e.preventDefault();
      this.press = { slot, x: e.clientX, y: e.clientY };
    });
    b.addEventListener("pointerover", (e) => {
      const slot = slotOf(e.target);
      if (slot !== null && this.dragFrom === null && this.cursor.hover(slot)) this.render();
    });
    b.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const slot = slotOf(e.target);
      if (slot === null) return;
      this.cursor.cancel();
      this.cursor.hover(slot);
      this.send(quickAction(this.state(), slot)?.actions ?? []);
    });
  }

  // ---------------------------------------------------------------------------------------------- pointer

  private pointerMove(e: PointerEvent) {
    if (this.press && this.dragFrom === null) {
      if (Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y) < DRAG_START_PX) return;
      if (!slotItem(this.state(), this.press.slot)) return;
      this.startDrag(this.press.slot);
    }
    if (this.dragFrom === null || !this.ghost) return;
    this.ghost.style.transform = `translate(${Math.round(e.clientX)}px, ${Math.round(e.clientY)}px) translate(-50%, -50%)`;
    const t = dropTarget(document.elementFromPoint(e.clientX, e.clientY));
    if (t !== this.target) {
      this.target = t;
      this.render();
    }
  }

  private pointerUp(e: PointerEvent) {
    const press = this.press;
    this.press = null;
    if (this.dragFrom !== null) {
      const from = this.dragFrom;
      const to = dropTarget(document.elementFromPoint(e.clientX, e.clientY));
      this.endDrag();
      this.send(this.cursor.dragDrop(from, to));
      return;
    }
    if (!press || e.button !== 0) return;
    if (slotOf(document.elementFromPoint(e.clientX, e.clientY)) !== press.slot) return;
    this.send(this.cursor.click(press.slot));
  }

  private startDrag(slot: number) {
    this.dragFrom = slot;
    this.cursor.cancel();
    const v = invSlots(this.state())[slot]!;
    this.ghost = el("div", "fl-inv__ghost fl-islot fl-arcade fl-arcade--lit", this.overlay);
    sprite(v.sprite, "", this.ghost);
    this.box.classList.add("is-dragging");
    this.render();
  }

  private endDrag() {
    this.ghost?.remove();
    this.ghost = null;
    this.dragFrom = null;
    this.target = null;
    this.box.classList.remove("is-dragging");
  }

  // ---------------------------------------------------------------------------------------------- actions

  private send(actions: InvAction[]) {
    const room = this.game.net.room;
    for (const a of actions) {
      switch (a.type) {
        case "move":
          room?.send("move", { from: a.from, to: a.to });
          break;
        case "drop":
          room?.send("drop", { slot: a.slot });
          break;
        case "use":
          room?.send("use", { slot: a.slot });
          break;
        case "wear":
          room?.send("wear", { slot: a.slot });
          break;
        case "takeoff":
          room?.send("wear", { remove: a.cosmeticSlot });
          break;
        case "equip":
          room?.send("equip", { slot: a.slot });
          break;
      }
    }
    if (this.isOpen) this.render();
  }

  // ---------------------------------------------------------------------------------------------- render (in place)

  /** Called on open and whenever `you` changes; touches only what changed. */
  render() {
    const s = this.state();
    this.cursor.sync();
    this.coinsEl.textContent = (this.you()?.coins ?? 0).toLocaleString("en-US");
    this.countEl.textContent = `${s.backpack.filter(Boolean).length} / ${BACKPACK_SLOTS}`;
    const views = invSlots(s);
    const held = this.dragFrom ?? this.cursor.held;
    for (const v of views) this.renderSlot(v, held);
    this.renderTip(s, views);
    this.renderActs(s, views);
    const armed = held !== null;
    this.dropZone.classList.toggle("is-armed", armed);
    this.dropZone.classList.toggle("is-target", this.target === "drop");
  }

  private renderSlot(v: InvSlot, held: number | null) {
    const focus = this.cursor.focus === v.slot;
    const flags = { hover: focus, sel: held === v.slot, target: this.target === v.slot && this.dragFrom !== v.slot };
    const key = `${v.sprite}|${v.tier}|${v.corner}|${v.gated}|${v.empty}|${v.active}|${v.rarity}|${flags.hover}|${flags.sel}|${flags.target}`;
    if (key === this.slotKeys[v.slot]) return;
    this.slotKeys[v.slot] = key;
    const d = this.slotEls[v.slot]!;
    d.className = "fl-islot fl-arcade";
    d.classList.toggle("is-empty", v.empty);
    d.classList.toggle("is-gated", v.gated);
    d.classList.toggle("fl-arcade--lit", v.active);
    d.classList.toggle("is-hover", flags.hover);
    d.classList.toggle("is-sel", flags.sel);
    d.classList.toggle("is-target", flags.target);
    d.replaceChildren();
    if (v.key) el("span", "fl-islot__k", d, v.key);
    d.setAttribute("aria-label", v.empty ? `${v.key ? `Hotbar ${v.key}` : "Backpack"}: empty` : `${v.name}${v.corner ? `, ${v.corner}` : ""}`);
    if (v.empty) return;
    sprite(v.sprite, "", d);
    if (v.tier > 0) {
      const t = el("span", "fl-tier", d);
      for (let i = 1; i <= 3; i++) el("i", i <= v.tier ? "on" : "", t);
    }
    if (v.rarity) el("span", `fl-rar fl-rar--${v.rarity}`, d);
    if (v.gated) sprite("lock", "fl-islot__lock", d);
    if (v.corner) el("span", `fl-islot__q num${v.gated ? " fl-danger" : ""}`, d, v.corner);
  }

  /** The item card for the focused slot (keyboard or pointer), else the held one. */
  private renderTip(s: InvState, views: InvSlot[]) {
    const slot = this.dragFrom ?? this.cursor.focus;
    const item = slotItem(s, slot);
    const key = `${slot}|${JSON.stringify(item)}|${s.level}|${s.selected}|${JSON.stringify(s.worn ?? {})}|${JSON.stringify(s.hotbar[s.selected] ?? null)}`;
    if (key === this.tipKey) return;
    this.tipKey = key;
    const w = this.tipWrap;
    w.replaceChildren();
    if (!item) {
      const v = views[slot]!;
      const p = el("p", "fl-inv__hint", w);
      if (v.key) {
        el("b", "", p, `Hotbar ${v.key} · empty`);
        p.append(v.active ? "In hand: you fight with your fists. " : "");
        p.append(`Drag a weapon here, or point at one and press ${v.key}.`);
      } else {
        el("b", "", p, "Backpack · empty");
        p.append("Loot, cosmetics and the radio land in the backpack first; weapons and tonics in the hotbar.");
      }
      return;
    }
    const d = itemDetails(item, s);
    const tip = el("div", "fl-itip fl-itip--static", w);
    const head = el("div", "fl-itip__head", tip);
    sprite(d.sprite, "", head);
    const hd = el("div", "", head);
    el("b", "", hd, d.name);
    const meta = el("div", "fl-itip__meta", hd);
    if (d.tierBadge) el("span", "fl-tierbadge", meta, d.tierBadge);
    if (d.rarity) el("span", `fl-rar fl-rar--${d.rarity}`, meta, RARITY_STYLE[d.rarity].label);
    meta.append(d.meta.join(" · "));
    if (d.gate) {
      const g = el("div", "fl-itip__gate", tip);
      sprite("lock", "", g);
      el("span", "", g, d.gate);
    }
    if (d.stats.length) {
      const dl = el("dl", "fl-stats", tip);
      for (const r of d.stats) {
        el("dt", "", dl, r.label);
        const bar = el("span", "fl-bar", dl);
        el("i", "", bar).style.setProperty("--fill", r.fill.toFixed(3));
        const dd = el("dd", "", dl, r.value);
        if (r.delta) el("span", r.delta > 0 ? "is-up" : "is-down", dd, `${r.delta > 0 ? "+" : "−"}${Math.abs(r.delta)}`);
      }
    }
    if (d.note) el("p", "fl-itip__note", tip, d.note);
    const foot = el("div", "fl-itip__foot", tip);
    el("span", "", foot, d.sell > 0 ? "Sells for" : "Juno won't buy it");
    if (d.sell > 0) el("span", "fl-coin", foot, d.sell.toLocaleString("en-US"));
  }

  /** What you can do with the focused (or held) item, as buttons with their keys. */
  private renderActs(s: InvState, views: InvSlot[]) {
    const held = this.cursor.held;
    const slot = held ?? this.cursor.focus;
    const item = slotItem(s, slot);
    const qa = item ? quickAction(s, slot) : null;
    const key = `${slot}|${held}|${JSON.stringify(item)}|${qa?.label ?? ""}|${this.dragFrom}`;
    if (key === this.actsKey) return;
    this.actsKey = key;
    const a = this.actsEl;
    a.replaceChildren();
    const v = views[slot]!;
    el("div", "fl-label", a, v.key ? `Hotbar ${v.key}` : `Backpack ${slot - HOTBAR_SLOTS + 1}`);
    if (!item) {
      el("p", "", a, "Nothing here.");
      return;
    }
    el("b", "", a, `${v.name}${v.qty > 1 ? ` ×${v.qty}` : ""}`);
    const btn = (label: string, k: string, cls: string, fn: () => void) => {
      const b = button(label, `fl-btn fl-btn--sm fl-btn--block${cls}`, a, fn);
      el("span", "fl-key", b, k);
    };
    if (held !== null) {
      el("p", "", a, "Click a slot to put it there, or the drop zone to leave it on the ground.");
      btn("Cancel", "Esc", " fl-btn--ghost", () => {
        this.cursor.cancel();
        this.render();
      });
      return;
    }
    if (qa) btn(qa.label, "E", "", () => this.send(qa.actions));
    btn("Drop", "X", " fl-btn--danger", () => this.send([{ type: "drop", slot }]));
  }
}

function slotOf(t: EventTarget | null): number | null {
  const s = t instanceof Element ? t.closest<HTMLElement>("[data-slot]") : null;
  return s ? Number(s.dataset.slot) : null;
}

function dropTarget(t: Element | null): number | "drop" | null {
  if (!t) return null;
  if (t.closest("[data-drop]")) return "drop";
  return slotOf(t);
}
