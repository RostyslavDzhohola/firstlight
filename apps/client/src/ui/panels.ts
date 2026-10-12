// Quests lane panels (plain DOM, D25): the Portus Exchange, the planet guide's missions, the journal
// (missions, medals and titles, wardrobe), the E7 keypad, the HUD mission tracker and the admin
// console. Panels free the mouse while open and give it back on close.

import "./quests.css";
import type { BodyId } from "@firstlight/shared";
import { HORSE_WHISTLE } from "@firstlight/shared/content/horse";
import { COSMETIC_BY_ID, COSMETIC_SLOTS, RARITY_STYLE, SHOP, SHOP_KEEPER, SHOP_NAME, itemName, sellValue, type ShopCategory } from "@firstlight/shared/content/items";
import { MEDALS } from "@firstlight/shared/content/medals";
import { GUIDES, MISSION_BY_ID, MISSIONS, missionsOn, type MissionDef } from "@firstlight/shared/content/missions";
import type { InvItem } from "@firstlight/shared/net/protocol";
import type { Game } from "../game/Game.ts";
import type { Hud, MissionLine, YouPlus } from "./hud.ts";
import { overlayClosed, overlayOpened } from "./dom.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

const TIER = ["", "I", "II", "III"];
const send = (game: Game, type: string, msg: unknown) => game.net.room?.send(type, msg as never);

/** A modal panel. Only one is open at a time. */
export class Panel {
  static current: Panel | null = null;
  readonly overlay = el("div", "fl-overlay");
  readonly box: HTMLDivElement;
  protected readonly game: Game;
  private readonly onKey = (e: KeyboardEvent) => {
    if (e.code === "Escape" || (this.closeKeys.includes(e.code) && !(e.target instanceof HTMLInputElement))) {
      e.preventDefault();
      e.stopPropagation();
      this.close(e.code !== "Escape");
    }
  };
  protected closeKeys: string[] = [];

  constructor(game: Game, cls = "fl-q") {
    this.game = game;
    this.box = el("div", `fl-panel ${cls}`, this.overlay);
    this.overlay.addEventListener("mousedown", (e) => {
      if (e.target === this.overlay) this.close(true);
    });
  }

  get isOpen() {
    return this.overlay.isConnected;
  }

  open() {
    Panel.current?.close(false);
    Panel.current = this;
    this.render();
    document.body.appendChild(this.overlay);
    this.game.input.enabled = false;
    this.game.input.keys.clear();
    window.addEventListener("keydown", this.onKey, true);
    overlayOpened("panel"); // keeps the Esc menu away while the mouse is free
    document.exitPointerLock?.();
  }

  close(relock = true) {
    if (!this.isOpen) return;
    this.overlay.remove();
    window.removeEventListener("keydown", this.onKey, true);
    if (Panel.current === this) Panel.current = null;
    overlayClosed("panel");
    this.game.input.enabled = true;
    if (relock) this.game.input.lock();
  }

  /** Called on open and whenever `you` changes while open. */
  render() {}

  /** Re-render in place, keeping the list's scroll position (buying shouldn't jump to the top). */
  refresh() {
    const scroll = this.box.querySelector(".body")?.scrollTop ?? 0;
    this.render();
    const body = this.box.querySelector(".body");
    if (body) body.scrollTop = scroll;
  }

  protected you(): YouPlus | null {
    return this.game.hud.you;
  }
}

// ---------------------------------------------------------------- Portus Exchange

const CATEGORY_NAMES: Record<ShopCategory, string> = { consumables: "Tonics", weapons: "Weapons", support: "Support", gear: "Gear", cosmetics: "Cosmetics" };

export class ShopPanel extends Panel {
  private tab: "buy" | "sell" = "buy";
  private qty = new Map<string, number>();

  render() {
    const you = this.you();
    const b = this.box;
    b.innerHTML = "";
    const head = el("div", "head", b);
    el("h2", "", head, SHOP_NAME.toUpperCase());
    el("div", "coins", head, `${you?.coins ?? 0} ◎`);
    el("p", "sub", b, `${SHOP_KEEPER}: “Anyone can buy anything. Whether you can use it is your business.” Sells back at 25%.`);
    const tabs = el("div", "tabs", b);
    for (const t of ["buy", "sell"] as const) {
      const x = el("button", `tab${this.tab === t ? " on" : ""}`, tabs, t === "buy" ? "Buy" : "Sell");
      x.onclick = () => {
        this.tab = t;
        this.render();
      };
    }
    const body = el("div", "body", b);
    if (this.tab === "buy") this.renderBuy(body, you);
    else this.renderSell(body, you);
    const foot = el("div", "foot", b);
    el("span", "", foot, "Tier II needs level 6 to equip, tier III level 12. Esc to close.");
    el("button", "btn ghost", foot, "Close").onclick = () => this.close();
  }

  private renderBuy(body: HTMLElement, you: YouPlus | null) {
    const coins = you?.coins ?? 0;
    const level = you?.level ?? 1;
    let cat: ShopCategory | null = null;
    const order: ShopCategory[] = ["consumables", "weapons", "support", "gear", "cosmetics"];
    // Horses behind their server flag (you.horses): no whistle for sale when they are off.
    const entries = SHOP.filter((e) => e.itemId !== HORSE_WHISTLE || !!you?.horses).sort((a, c) => order.indexOf(a.category) - order.indexOf(c.category) || a.name.localeCompare(c.name) || a.tier - c.tier);
    for (const e of entries) {
      if (e.category !== cat) {
        cat = e.category;
        el("div", "cat", body, CATEGORY_NAMES[cat]);
      }
      const key = `${e.itemId}:${e.tier}`;
      const q = e.stack > 1 ? (this.qty.get(key) ?? 1) : 1;
      const row = el("div", "row", body);
      const left = el("div", "", row);
      const cos = COSMETIC_BY_ID.get(e.itemId);
      const nm = el("div", "nm", left, `${e.name}${e.category === "weapons" || e.category === "support" ? ` ${TIER[e.tier]}` : ""}`);
      if (cos) {
        const r = RARITY_STYLE[cos.rarity];
        const tag = el("span", "rar", nm, `  ${r.icon} ${r.label}`);
        tag.style.color = r.color;
      }
      const meta = el("div", "meta", left);
      if (e.level > level) el("span", "gate", meta, `needs LV ${e.level} to equip`);
      else if (cos) meta.textContent = `${cos.slot}`;
      else if (e.stack > 1) meta.textContent = `stacks to ${e.stack}`;
      el("div", "price", row, `${e.price * q} ◎`);
      const act = el("div", "", row);
      if (e.stack > 1) {
        const sel = el("select", "tab", act);
        for (const n of [1, 3, 5, 10].filter((n) => n <= e.stack)) {
          const o = el("option", "", sel, `×${n}`);
          o.value = String(n);
          o.selected = n === q;
        }
        sel.onchange = () => {
          this.qty.set(key, Number(sel.value));
          this.render();
        };
        sel.style.marginRight = "6px";
      }
      const buy = el("button", "btn", act, "Buy");
      buy.disabled = coins < e.price * q;
      buy.onclick = () => send(this.game, "buy", { itemId: e.itemId, tier: e.tier, qty: q });
    }
  }

  private renderSell(body: HTMLElement, you: YouPlus | null) {
    if (!you) return;
    const items: { slot: number; it: InvItem }[] = [];
    you.hotbar.forEach((it, i) => it && items.push({ slot: i, it }));
    you.backpack.forEach((it, i) => it && items.push({ slot: i + 4, it }));
    if (!items.length) el("p", "sub", body, "Your bags are empty.");
    for (const { slot, it } of items) {
      const row = el("div", "row", body);
      const left = el("div", "", row);
      el("div", "nm", left, `${itemName(it)}${it.skin || COSMETIC_BY_ID.has(it.id) ? "" : ` ${TIER[it.tier] ?? ""}`}${it.qty > 1 ? ` ×${it.qty}` : ""}`);
      el("div", "meta", left, slot < 4 ? `hotbar ${slot + 1}` : "backpack");
      const value = sellValue(it);
      el("div", "price", row, value > 0 ? `${value} ◎` : "—");
      const btn = el("button", "btn ghost", row, "Sell");
      btn.disabled = value <= 0;
      btn.onclick = () => send(this.game, "sell", { slot });
    }
  }
}

// ---------------------------------------------------------------- guide missions

function missionCard(parent: HTMLElement, def: MissionDef, you: YouPlus | null, actions: (row: HTMLElement) => void) {
  const state = you?.missions.find((m) => m.id === def.id);
  const card = el("div", `mission${state?.done ? " done" : ""}`, parent);
  const top = el("div", "top", card);
  el("b", "", top, `${def.name}`);
  el("span", "ty", top, def.type);
  el("div", "obj", card, def.objective);
  const items = def.reward.items.map((i) => `${i.qty} × ${itemName(i)}`);
  el("div", "rw", card, `Recommended LV ${def.recLevel[0]}–${def.recLevel[1]} · Reward ${def.reward.xp} XP, ${def.reward.coins} ◎${items.length ? `, ${items.join(", ")}` : ""}`);
  if (state && !state.done) {
    const bar = el("div", "bar", card);
    el("i", "", bar).style.width = `${Math.round((state.progress / Math.max(1, state.goal)) * 100)}%`;
    el("div", "rw", card, `${state.progress} / ${state.goal}`);
  }
  if (state?.done) el("div", "rw", card, "Done this life.");
  const row = el("div", "top", card);
  row.style.marginTop = "8px";
  actions(row);
}

export class GuidePanel extends Panel {
  private readonly body: Exclude<BodyId, "portus">;
  constructor(game: Game, body: Exclude<BodyId, "portus">) {
    super(game);
    this.body = body;
  }

  render() {
    const g = GUIDES[this.body];
    const you = this.you();
    const b = this.box;
    b.innerHTML = "";
    el("h2", "", b, g.name.toUpperCase());
    el("p", "sub", b, `${g.role[0]!.toUpperCase()}${g.role.slice(1)} at the main pad`);
    el("p", "quote", b, `“${g.greeting}”`);
    const body = el("div", "body", b);
    for (const def of missionsOn(this.body)) {
      missionCard(body, def, you, (row) => {
        el("span", "quote", row, `“${def.pitch}”`).style.margin = "0";
        const state = you?.missions.find((m) => m.id === def.id);
        if (!state) {
          el("button", "btn", row, "Accept").onclick = () => send(this.game, "mission", { action: "accept", id: def.id });
        } else if (!state.done) {
          el("button", "btn ghost", row, "Abandon").onclick = () => send(this.game, "mission", { action: "abandon", id: def.id });
        }
      });
    }
    const foot = el("div", "foot", b);
    el("span", "", foot, "Missions reset when you die. Rewards pay the moment you finish.");
    el("button", "btn ghost", foot, "Close").onclick = () => this.close();
  }
}

// ---------------------------------------------------------------- journal

export class JournalPanel extends Panel {
  private tab: "missions" | "medals" | "wardrobe" = "missions";
  protected closeKeys = ["KeyJ"];

  show(tab?: JournalPanel["tab"]) {
    if (tab) this.tab = tab;
    this.open();
  }

  render() {
    const you = this.you();
    const b = this.box;
    b.innerHTML = "";
    const head = el("div", "head", b);
    el("h2", "", head, "JOURNAL");
    const title = you?.title ? MEDALS.find((m) => m.id === you.title)?.title : null;
    el("div", "sub", head, title ? `Title: ${title}` : "No title worn");
    const tabs = el("div", "tabs", b);
    for (const t of ["missions", "medals", "wardrobe"] as const) {
      const x = el("button", `tab${this.tab === t ? " on" : ""}`, tabs, t[0]!.toUpperCase() + t.slice(1));
      x.onclick = () => {
        this.tab = t;
        this.render();
      };
    }
    const body = el("div", "body", b);
    if (this.tab === "missions") this.renderMissions(body, you);
    else if (this.tab === "medals") this.renderMedals(body, you);
    else this.renderWardrobe(body, you);
    const foot = el("div", "foot", b);
    el("span", "", foot, "J or Esc to close");
    el("button", "btn ghost", foot, "Close").onclick = () => this.close();
  }

  private renderMissions(body: HTMLElement, you: YouPlus | null) {
    const mine = you?.missions ?? [];
    if (!mine.length) el("p", "sub", body, "No missions yet. Each planet's guide waits at its main pad: Lark on Arcadia, Sexton Mabry on Hollowmere, Rook Calder on Meridian.");
    for (const m of mine) {
      const def = MISSION_BY_ID.get(m.id);
      if (!def) continue;
      missionCard(body, def, you, (row) => {
        el("span", "rw", row, `${def.body[0]!.toUpperCase()}${def.body.slice(1)} · ${def.guide}`);
        if (!m.done) el("button", "btn ghost", row, "Abandon").onclick = () => send(this.game, "mission", { action: "abandon", id: def.id });
      });
    }
    el("div", "rw", body, `${mine.filter((m) => m.done).length} of ${MISSIONS.length} missions done this life.`).style.marginTop = "8px";
  }

  private renderMedals(body: HTMLElement, you: YouPlus | null) {
    const got = new Set(you?.medals ?? []);
    el("p", "sub", body, `${got.size} of ${MEDALS.length} medals. Medals stay with your account when you die.`);
    const grid = el("div", "medals", body);
    for (const m of MEDALS) {
      const has = got.has(m.id);
      const c = el("div", `medal ${has ? "got" : "locked"}`, grid);
      if (m.hidden && !has) {
        el("div", "nm", c, "???");
        el("div", "cond", c, "A hidden medal. Somewhere, a secret.");
        continue;
      }
      el("div", "nm", c, `${has ? "★ " : ""}${m.name}`);
      el("div", "cond", c, m.condition + (m.scope === "life" ? " (in one life)" : ""));
      const row = el("div", "top", c);
      el("span", "tt", row, `Title: ${m.title}`);
      if (has) {
        const worn = you?.title === m.id;
        const btn = el("button", `btn${worn ? " ghost" : ""}`, row, worn ? "Remove" : "Wear");
        btn.onclick = () => send(this.game, "title", { medalId: worn ? null : m.id });
      }
    }
  }

  private renderWardrobe(body: HTMLElement, you: YouPlus | null) {
    if (!you) return;
    const worn = you.worn ?? {};
    el("p", "sub", body, "Cosmetics are items: they drop with everything else when you die.");
    for (const slot of COSMETIC_SLOTS) {
      el("div", "cat", body, slot);
      const id = worn[slot];
      const items: { slot: number; it: InvItem }[] = [];
      you.hotbar.forEach((it, i) => it && COSMETIC_BY_ID.get(it.id)?.slot === slot && items.push({ slot: i, it }));
      you.backpack.forEach((it, i) => it && COSMETIC_BY_ID.get(it.id)?.slot === slot && items.push({ slot: i + 4, it }));
      if (!items.length) el("div", "meta", body, "Nothing for this slot in your bags.");
      for (const { slot: s, it } of items) {
        const def = COSMETIC_BY_ID.get(it.id)!;
        const row = el("div", "row", body);
        const left = el("div", "", row);
        el("div", "nm", left, def.name);
        const r = RARITY_STYLE[def.rarity];
        const rar = el("div", "rar", left, `${r.icon} ${r.label} · ${def.source}`);
        rar.style.color = r.color;
        el("div", "", row);
        const on = id === def.id;
        const btn = el("button", `btn${on ? " ghost" : ""}`, row, on ? "Take off" : "Wear");
        btn.onclick = () => send(this.game, "wear", on ? { remove: slot } : { slot: s });
      }
    }
  }
}

// ---------------------------------------------------------------- keypad (egg E7)

export class KeypadPanel extends Panel {
  private target = "";
  private code = "";
  private readonly onDigit = (e: KeyboardEvent) => {
    if (/^(Digit|Numpad)\d$/.test(e.code)) this.press(e.code.slice(-1));
    else if (e.code === "Enter" || e.code === "NumpadEnter") this.press("OK");
    else if (e.code === "Backspace") this.press("C");
  };

  constructor(game: Game) {
    super(game, "fl-keypad");
  }

  show(target: string) {
    this.target = target;
    this.code = "";
    this.open();
    window.addEventListener("keydown", this.onDigit);
  }

  close(relock = true) {
    window.removeEventListener("keydown", this.onDigit);
    super.close(relock);
  }

  render() {
    const b = this.box;
    b.innerHTML = "";
    el("h2", "", b, "WALL SAFE");
    el("div", "disp", b, this.code.padEnd(4, "·"));
    const keys = el("div", "keys", b);
    for (const k of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "OK"]) {
      el("button", "", keys, k).onclick = () => this.press(k);
    }
  }

  private press(k: string) {
    if (k === "C") this.code = "";
    else if (k === "OK") {
      if (this.code.length === 4) {
        send(this.game, "interact", { target: this.target, code: this.code });
        this.close();
        return;
      }
    } else if (this.code.length < 4) this.code += k;
    this.render();
  }
}

// ---------------------------------------------------------------- HUD mission tracker

/**
 * Active missions in the HUD's missions panel (top-right, in one column with the toasts: verdict fix 2).
 * Accepts the HUD (or, for older callers, its root element: then the HUD is looked up lazily).
 */
export class MissionTracker {
  private last = "";

  constructor(private readonly hud: Pick<Hud, "setMissions"> | HTMLElement) {}

  update(you: YouPlus | null) {
    const all = you?.missions ?? [];
    const key = JSON.stringify(all);
    if (key === this.last || this.hud instanceof HTMLElement) return;
    this.last = key;
    // Open missions first, then the ones done this life; at most three lines.
    const rows = [...all.filter((m) => !m.done), ...all.filter((m) => m.done)].slice(0, 3);
    const lines: MissionLine[] = [];
    let body = "";
    let guide = "";
    rows.forEach((m, i) => {
      const def = MISSION_BY_ID.get(m.id);
      if (!def) return;
      body ||= def.body[0]!.toUpperCase() + def.body.slice(1);
      guide ||= def.guide;
      lines.push({
        id: m.id,
        title: def.name,
        detail: def.objective,
        progress: m.done ? "Done" : `${m.progress}/${m.goal}`,
        state: m.done ? "done" : i === 0 ? "tracked" : "open",
      });
    });
    this.hud.setMissions(lines, [guide, body].filter(Boolean).join(" · "));
  }

  dispose() {
    if (!(this.hud instanceof HTMLElement)) this.hud.setMissions([]);
  }
}

// ---------------------------------------------------------------- admin console (` key)

const CONSOLE_HELP = "stage <1-5> [all] · coins <n> · level <n> · give <id> [tier] [qty] · medal <id> · egg <E1-E9> · heal · unprotect · announce <text>";

/** Parse a console line into an admin message. */
export function parseAdminLine(line: string): { cmd: string; args: Record<string, unknown> } | null {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  if (!cmd) return null;
  const n = (i: number, d = 0) => (rest[i] !== undefined && Number.isFinite(Number(rest[i])) ? Number(rest[i]) : d);
  switch (cmd) {
    case "stage":
      return { cmd, args: { n: n(0, 1), all: rest.includes("all") } };
    case "coins":
      return { cmd, args: { amount: n(0, 100) } };
    case "level":
      return { cmd, args: { level: n(0, 1) } };
    case "give":
      return { cmd, args: { id: rest[0] ?? "carbine", tier: n(1, 1), qty: n(2, 1) } };
    case "medal":
      return { cmd, args: { id: rest[0] ?? "" } };
    case "egg":
      return { cmd, args: { id: rest[0] ?? "", ...(rest[1] ? { step: rest[1] } : {}) } };
    case "announce":
      return { cmd, args: { text: rest.join(" ") } };
    default:
      return { cmd, args: {} };
  }
}

export class AdminConsole {
  private readonly game: Game;
  private wrap: HTMLDivElement | null = null;

  constructor(game: Game) {
    this.game = game;
  }

  get isOpen() {
    return !!this.wrap;
  }

  toggle() {
    if (this.wrap) return this.close();
    // An overlay with a heading keeps the pause menu away while the mouse is free.
    const wrap = el("div", "fl-overlay fl-console-wrap", document.body);
    el("h2", "", wrap, "admin").style.display = "none";
    const box = el("div", "fl-console", wrap);
    const input = el("input", "", box);
    input.placeholder = "admin command…";
    el("div", "h", box, CONSOLE_HELP);
    this.wrap = wrap;
    this.game.input.enabled = false;
    overlayOpened("console");
    document.exitPointerLock?.();
    setTimeout(() => input.focus(), 0);
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.code === "Escape" || e.code === "Backquote") {
        e.preventDefault();
        this.close();
      } else if (e.code === "Enter") {
        const m = parseAdminLine(input.value);
        if (m) this.game.net.room?.send("admin", m as never);
        this.close(true);
      }
    };
  }

  close(relock = false) {
    this.wrap?.remove();
    this.wrap = null;
    overlayClosed("console");
    this.game.input.enabled = true;
    if (relock) this.game.input.lock();
  }
}
