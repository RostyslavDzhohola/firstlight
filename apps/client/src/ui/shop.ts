// The shop panel (round 2): one in every safe zone (content/shops.ts). Buy lists every item in the game
// from ui/shopModel.ts, grouped (weapons by family with their three tiers, support, tonics, gear,
// cosmetics by slot, trophies, secrets): what you can buy now has a price button, the rest is greyed
// with the exact reason (a level, coins short, where it drops). Sell lists your bags at 25%. Opens with
// E at the keeper with the mouse free; Esc or Close goes back into the game (Panel).

import "./shop.css";
import { itemName, sellValue } from "@firstlight/shared/content/items";
import { SHOP_SPOTS, type ShopSpot } from "@firstlight/shared/content/shops";
import type { InvItem } from "@firstlight/shared/net/protocol";
import type { Game } from "../game/Game.ts";
import type { YouPlus } from "./hud.ts";
import { HIDDEN_ITEMS, shownItem } from "./hudFormat.ts";
import { el, icon, sprite } from "./dom.ts";
import { Panel } from "./panels.ts";
import { installSprites, itemSprite } from "./sprites.ts";
import { offerCounts, shopCatalogue, tiered, type Lock, type Offer, type ShopContext, type ShopRow } from "./shopModel.ts";

const TIER = ["", "I", "II", "III"];

/** The lock as a sentence (tooltip, screen readers). */
function lockWords(lock: Lock, name: string): string {
  if (lock.kind === "level") return `${name} unlocks at level ${lock.level}`;
  if (lock.kind === "coins") return `You need ${lock.short} more coins`;
  return lock.text;
}
const QTYS = [1, 3, 5, 10];

export class ShopPanel extends Panel {
  private tab: "buy" | "sell" = "buy";
  private onlyOpen = false;
  private readonly qty = new Map<string, number>();
  private spot: ShopSpot = SHOP_SPOTS[0]!;

  constructor(game: Game) {
    super(game, "fl-q fl-shop");
    installSprites();
  }

  /** Open at a shop (the keeper the player pressed E at). */
  openAt(spot: ShopSpot) {
    this.spot = spot;
    this.open();
  }

  private context(you: YouPlus | null): ShopContext {
    return { level: you?.level ?? 1, coins: you?.coins ?? 0, horses: !!you?.horses, extras: !!you?.cosmeticsExtras, hidden: HIDDEN_ITEMS };
  }

  render() {
    const you = this.you();
    const b = this.box;
    b.replaceChildren();
    b.setAttribute("role", "dialog");
    b.setAttribute("aria-label", this.spot.name);
    b.dataset.e2e = "shop";

    const head = el("header", "fl-shop__head", b);
    const t = el("div", "", head);
    el("h2", "", t, this.spot.name);
    el("p", "sub", t, `${this.spot.keeper}: “Everything there is, and what it takes to get it.” Buys back at 25%.`);
    const purse = el("div", "fl-shop__purse", head);
    el("span", "fl-chip fl-chip--dawn", purse, `LV ${you?.level ?? 1}`);
    const coins = el("span", "fl-shop__coins num", purse);
    sprite("coin", "", coins);
    coins.append(`${you?.coins ?? 0}`);

    const bar = el("div", "fl-shop__bar", b);
    const tabs = el("div", "tabs", bar);
    tabs.setAttribute("role", "tablist");
    for (const k of ["buy", "sell"] as const) {
      const x = el("button", `tab${this.tab === k ? " on" : ""}`, tabs, k === "buy" ? "Buy" : "Sell");
      x.type = "button";
      x.setAttribute("role", "tab");
      x.setAttribute("aria-selected", String(this.tab === k));
      x.onclick = () => {
        this.tab = k;
        this.render();
      };
    }
    const body = el("div", "body fl-shop__body", b);
    if (this.tab === "buy") {
      const groups = shopCatalogue(this.context(you), (id) => this.qty.get(id) ?? 1);
      const { open, total } = offerCounts(groups);
      const tools = el("div", "fl-shop__tools", bar);
      el("span", "fl-shop__count", tools, `You can buy ${open} of ${total} here now`);
      const lab = el("label", "fl-shop__only", tools);
      const box = el("input", "fl-check", lab);
      box.type = "checkbox";
      box.checked = this.onlyOpen;
      box.onchange = () => {
        this.onlyOpen = box.checked;
        this.refresh();
      };
      lab.append("Only what I can buy");
      for (const g of groups) {
        const rows = this.onlyOpen ? g.rows.filter((r) => r.offers.some((o) => !o.lock)) : g.rows;
        if (!rows.length) continue;
        el("h3", "cat", body, g.title);
        const list = el("ul", "fl-shop__rows", body);
        for (const r of rows) this.renderRow(list, r);
      }
    } else this.renderSell(body, you);

    const foot = el("div", "foot", b);
    el("span", "", foot, "Locked items show what they take. Esc to close.");
    const close = el("button", "btn ghost", foot, "Close");
    close.type = "button";
    close.onclick = () => this.close();
  }

  private renderRow(list: HTMLElement, r: ShopRow) {
    const li = el("li", `fl-shop__row${r.offers.length && r.offers.every((o) => o.lock) ? " is-locked" : ""}${r.offers.length ? "" : " is-unsold"}`, list);
    li.dataset.item = r.itemId || r.key;
    const ic = el("span", "fl-shop__icon", li);
    sprite(r.sprite ? itemSprite(r.sprite) : "star", "", ic);
    const txt = el("div", "fl-shop__name", li);
    const nm = el("b", "", txt, r.name);
    if (r.rarity) nm.classList.add(`is-${r.rarity}`);
    el("span", "", txt, r.meta);
    const right = el("div", "fl-shop__offers", li);
    if (!r.offers.length) {
      const why = el("span", "fl-shop__why", right);
      icon("lock", "", why);
      why.append(r.lock?.text ?? "Not sold");
      if (r.sells) el("span", "fl-shop__sells num", right, `sells for ${r.sells} ◎`);
      return;
    }
    const stack = r.offers[0]!.stack;
    if (stack > 1) {
      const sel = el("select", "fl-shop__qty", right);
      sel.setAttribute("aria-label", `How many ${r.name}`);
      for (const q of QTYS.filter((q) => q <= stack)) {
        const o = el("option", "", sel, `×${q}`);
        o.value = String(q);
        o.selected = q === (this.qty.get(r.itemId) ?? 1);
      }
      sel.onchange = () => {
        this.qty.set(r.itemId, Number(sel.value));
        this.refresh();
      };
    }
    for (const o of r.offers) this.renderOffer(right, r, o);
  }

  private renderOffer(parent: HTMLElement, r: ShopRow, o: Offer) {
    const q = o.stack > 1 ? (this.qty.get(r.itemId) ?? 1) : 1;
    const price = o.price * q;
    const name = `${r.name}${o.label ? ` ${o.label}` : ""}`;
    if (o.lock) {
      const cell = el("div", `fl-shop__offer is-locked is-${o.lock.kind}`, parent);
      const why = lockWords(o.lock, name);
      cell.setAttribute("aria-label", `${name}: locked, ${why}`);
      cell.title = why;
      const top = el("span", "t", cell);
      if (o.label) el("b", "", top, o.label);
      if (o.stat) top.append(o.stat);
      const reason = el("span", "p", cell);
      icon("lock", "", reason);
      reason.append(o.lock.text);
      el("span", "c num", cell, `${price} ◎`);
      return;
    }
    const cell = el("button", "fl-shop__offer", parent);
    cell.type = "button";
    cell.setAttribute("aria-label", `Buy ${q > 1 ? `${q} × ` : ""}${name} for ${price} coins`);
    const top = el("span", "t", cell);
    if (o.label) el("b", "", top, o.label);
    if (o.stat) top.append(o.stat);
    el("span", "p num", cell, `${price} ◎`);
    el("span", "c", cell, "Buy");
    cell.onclick = () => this.game.net.room?.send("buy", { itemId: o.itemId, tier: o.tier, qty: q } as never);
  }

  private renderSell(body: HTMLElement, you: YouPlus | null) {
    if (!you) return;
    const items: { slot: number; it: InvItem }[] = [];
    you.hotbar.forEach((it, i) => shownItem(it) && items.push({ slot: i, it: it! }));
    you.backpack.forEach((it, i) => shownItem(it) && items.push({ slot: i + 4, it: it! }));
    if (!items.length) {
      el("p", "sub", body, "Your bags are empty.");
      return;
    }
    const list = el("ul", "fl-shop__rows", body);
    for (const { slot, it } of items) {
      const li = el("li", "fl-shop__row", list);
      sprite(itemSprite(it.id), "", el("span", "fl-shop__icon", li));
      const txt = el("div", "fl-shop__name", li);
      el("b", "", txt, `${itemName(it)}${tiered(it) ? ` ${TIER[it.tier]}` : ""}${it.qty > 1 ? ` ×${it.qty}` : ""}`);
      el("span", "", txt, slot < 4 ? `Hotbar ${slot + 1}` : "Backpack");
      const right = el("div", "fl-shop__offers", li);
      const value = sellValue(it);
      if (value <= 0) {
        const why = el("span", "fl-shop__why", right);
        icon("lock", "", why);
        why.append("Won't buy this");
        continue;
      }
      const cell = el("button", "fl-shop__offer is-sell", right);
      cell.type = "button";
      cell.setAttribute("aria-label", `Sell ${itemName(it)} for ${value} coins`);
      el("span", "p num", cell, `${value} ◎`);
      el("span", "c", cell, "Sell");
      cell.onclick = () => this.game.net.room?.send("sell", { slot } as never);
    }
  }
}
