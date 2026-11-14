// Quests lane panels (plain DOM, D25): the base Panel (the shop is ui/shop.ts), the planet guide's missions, the journal
// (missions, medals and titles, wardrobe), the E7 keypad, the HUD mission tracker and the admin
// console. Panels free the mouse while open and give it back on close.

import { WILD_SITES } from "@firstlight/shared/content/wildSites";
import "./quests.css";
import { BODIES, BODY_IDS, type BodyId } from "@firstlight/shared";
import { COSMETIC_BY_ID, COSMETIC_SLOTS, RARITY_STYLE, isExtraCosmetic, itemName } from "@firstlight/shared/content/items";
import { MEDALS } from "@firstlight/shared/content/medals";
import { GUIDES, MISSION_BY_ID, MISSIONS, missionGiver, missionsFrom, missionsOn, type MissionDef } from "@firstlight/shared/content/missions";
import { trackerRows } from "./trackerRows.ts";
import { trialWay } from "../game/nextSteps.ts";
import { missionTrack } from "../game/missionTrack.ts";
import { MISSIONS_KEY } from "./missionsPanel.ts";
import { uiSettings } from "./uiSettings.ts";
import { spellCost, spellEffect, spellPower } from "../game/spellInfo.ts";
import { SPELLS } from "@firstlight/shared/content/spells";
import { LEVEL_CAP } from "@firstlight/shared/content/progression";
import { GLEAMS, gleamsWon } from "@firstlight/shared/content/gleams";
import type { InvItem } from "@firstlight/shared/net/protocol";
import type { Game } from "../game/Game.ts";
import type { Hud, YouPlus } from "./hud.ts";
import { overlayClosed, overlayOpened } from "./dom.ts";
import { parseSkyArgs, SKY_HELP } from "./skyCommand.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

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
      // Esc too goes back into the game: the panel freed the pointer itself, so the browser lets the
      // page take it back without a click (if it refuses, the "Click to look around" hint shows).
      this.close(true);
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
    this.game.input.clearKeys();
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

// The shop panel lives in ui/shop.ts (every safe zone has one, round 2).

// ---------------------------------------------------------------- guide missions

function missionCard(parent: HTMLElement, def: MissionDef, you: YouPlus | null, actions: (row: HTMLElement) => void) {
  const state = you?.missions.find((m) => m.id === def.id);
  const card = el("div", `mission${state?.done ? " done" : ""}`, parent);
  const top = el("div", "top", card);
  el("b", "", top, `${def.name}`);
  el("span", "ty", top, def.type);
  el("div", "obj", card, def.objective);
  const way = trialWay(def);
  if (way) el("div", "rw way", card, way);
  const items = def.reward.items.filter((i) => !isExtraCosmetic(i.id) || !!you?.cosmeticsExtras).map((i) => `${i.qty} × ${itemName(i)}`);
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

/** Bodies with a guide at the main pad (every planet and the moon; Portus has Sela instead). */
export function guideBody(body: BodyId): body is Exclude<BodyId, "portus"> {
  return body !== "portus" && !!GUIDES[body as Exclude<BodyId, "portus">];
}

/** Who gives a mission and where, for a "given by" line ("Lark on Arcadia"). */
function giverWhere(id: string): string {
  const g = Object.values(GUIDES).find((x) => x.id === id);
  return g ? `${g.name} on ${BODIES[g.body].name}` : id === GLEAMS.curator.id ? `${GLEAMS.curator.name} in Portus` : id;
}

/**
 * A guide's panel: the missions this guide hands out (accept / abandon), then the missions on this
 * body that someone else gives (Lark sends players to Lumen with L1), read-only with their progress,
 * so Surveyor Odile can tell you how the hunt is going.
 */
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
    for (const def of missionsFrom(g.id)) {
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
    for (const def of MISSIONS.filter((m) => m.body === this.body && missionGiver(m) !== g.id && !m.trial)) {
      missionCard(body, def, you, (row) => {
        el("span", "rw", row, `${giverWhere(missionGiver(def))} gives this one.`);
      });
    }
    const foot = el("div", "foot", b);
    el("span", "", foot, "Missions reset when you die. Rewards pay the moment you finish.");
    el("button", "btn ghost", foot, "Close").onclick = () => this.close();
  }
}

/**
 * Sela Marchbank's panel (Portus Plaza): the Three Gleams. Her line follows your progress; the three
 * trials as mission cards (planet, recommended level, objective, accept / abandon) and the vault's
 * reward. The vault itself is opened at the vault (E), not here.
 */
export class CuratorPanel extends Panel {
  render() {
    const you = this.you();
    const b = this.box;
    b.innerHTML = "";
    const c = GLEAMS.curator;
    el("h2", "", b, c.name.toUpperCase());
    el("p", "sub", b, `${c.role[0]!.toUpperCase()}${c.role.slice(1)} · ${GLEAMS.name}`);
    const won = gleamsWon(you?.missions ?? []);
    const opened = !!you?.gleamVault;
    el("p", "quote", b, `“${opened ? GLEAMS.lines.opened : won >= GLEAMS.trials.length ? GLEAMS.lines.all : won > 0 ? GLEAMS.lines.some : GLEAMS.lines.none}”`);
    const body = el("div", "body", b);
    const trials = missionsFrom(c.id);
    for (const def of trials) {
      missionCard(body, def, you, (row) => {
        el("span", "rw", row, `Trial ${def.trial}`); // the card's way line names the planet (D-polish-ux-3)
        el("span", "quote", row, `“${def.pitch}”`).style.margin = "0";
        const state = you?.missions.find((m) => m.id === def.id);
        if (!state) el("button", "btn", row, "Accept").onclick = () => send(this.game, "mission", { action: "accept", id: def.id });
        else if (!state.done) el("button", "btn ghost", row, "Abandon").onclick = () => send(this.game, "mission", { action: "abandon", id: def.id });
      });
    }
    const vault = el("div", `mission${opened ? " done" : ""}`, body);
    const top = el("div", "top", vault);
    el("b", "", top, "The Gleam Vault");
    el("span", "ty", top, `${won} / ${GLEAMS.trials.length}`);
    el("div", "obj", vault, opened ? "Opened in this life." : "Bring all three gleams to the vault beside me and press E.");
    el("div", "rw", vault, `Reward: Gleamweave Cape (Legendary), ${GLEAMS.reward.coins} ◎, the title “Gleamkeeper”, and the first ever to open it is engraved on the Hall of Firsts.`);
    const foot = el("div", "foot", b);
    el("span", "", foot, "Gleams are lost when you die, like missions. The medal and title are yours for good.");
    el("button", "btn ghost", foot, "Close").onclick = () => this.close();
  }
}

// ---------------------------------------------------------------- journal

export class JournalPanel extends Panel {
  private tab: "missions" | "spells" | "medals" | "wardrobe" | "sites" = "missions";
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
    for (const t of ["missions", "spells", "medals", "wardrobe", "sites"] as const) {
      const x = el("button", `tab${this.tab === t ? " on" : ""}`, tabs, t[0]!.toUpperCase() + t.slice(1));
      x.onclick = () => {
        this.tab = t;
        this.render();
      };
    }
    const body = el("div", "body", b);
    if (this.tab === "missions") this.renderMissions(body, you);
    else if (this.tab === "spells") this.renderSpells(body, you);
    else if (this.tab === "medals") this.renderMedals(body, you);
    else if (this.tab === "sites") this.renderSites(body, you);
    else this.renderWardrobe(body, you);
    const foot = el("div", "foot", b);
    el("span", "", foot, "J or Esc to close");
    el("button", "btn ghost", foot, "Close").onclick = () => this.close();
  }

  private renderMissions(body: HTMLElement, you: YouPlus | null) {
    const mine = you?.missions ?? [];
    // Review #4: the HUD missions panel folds here too (L on a keyboard), so a pad and a touch screen,
    // which reach the journal from the pause menu, can fold it; the focus navigator reaches this button.
    const folded = uiSettings.get().missionsCollapsed;
    const fold = el("button", "btn ghost", el("div", "top", body), `${folded ? "Unfold" : "Fold"} the missions panel (${MISSIONS_KEY.cap})`);
    fold.dataset.e2e = "journal-fold-missions";
    fold.onclick = () => {
      uiSettings.set({ missionsCollapsed: !uiSettings.get().missionsCollapsed });
      this.render();
    };
    if (!mine.length) el("p", "sub", body, "No missions yet. Each planet's guide waits at its main pad: Lark on Arcadia, Sexton Mabry on Hollowmere, Rook Calder on Meridian. In Portus Plaza, Sela Marchbank gives the three trials of the Three Gleams.");
    for (const m of mine) {
      const def = MISSION_BY_ID.get(m.id);
      if (!def) continue;
      missionCard(body, def, you, (row) => {
        el("span", "rw", row, `${def.body[0]!.toUpperCase()}${def.body.slice(1)} · ${def.trial ? `${GLEAMS.name}, trial ${def.trial}` : def.guide}`);
        if (!m.done) {
          const tracked = missionTrack.chosen === def.id;
          const t = el("button", `btn${tracked ? "" : " ghost"}`, row, tracked ? "Tracking" : "Track");
          t.dataset.e2e = `journal-track-${def.id}`;
          t.disabled = tracked;
          t.onclick = () => {
            missionTrack.choose(def.id);
            this.render();
          };
          el("button", "btn ghost", row, "Abandon").onclick = () => send(this.game, "mission", { action: "abandon", id: def.id });
        }
      });
    }
    el("div", "rw", body, `${mine.filter((m) => m.done).length} of ${MISSIONS.length} missions done this life.`).style.marginTop = "8px";
  }

  /** #79: each spell's numbers at your level, and what the next level adds. */
  private renderSpells(body: HTMLElement, you: YouPlus | null) {
    const level = you?.level ?? 1;
    const starter = this.game.hud.starterIndex;
    el("p", "sub", body, `At level ${level}. Spell damage grows 3% a level (and with your starter's spell power); cooldowns and costs stay the same.`);
    for (const s of SPELLS) {
      const row = el("div", "row", body);
      row.dataset.e2e = `journal-spell-${s.id}`;
      const left = el("div", "", row);
      el("div", "nm", left, `${s.keycap} · ${s.name}`);
      if (level < s.level) {
        el("div", "meta", left, `Unlocks at level ${s.level}. ${s.blurb}`);
        continue;
      }
      el("div", "", left, spellEffect(s, level, starter));
      const now = spellPower(s, level, starter);
      const next = level < LEVEL_CAP ? spellPower(s, level + 1, starter) : null;
      el("div", "meta", left, `${spellCost(s)}${now && next && next.value !== now.value ? ` · level ${level + 1}: ${next.value} ${now.unit}` : ""}`);
    }
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

  /** Wild sites found this life (content/wildSites.ts), by planet, with their level band. */
  private renderSites(body: HTMLElement, you: YouPlus | null) {
    const found = new Set(you?.sites ?? []);
    el("p", "sub", body, `${found.size} of ${WILD_SITES.length} sites found this life. Each guards a chest; finding one is worth XP once per life.`);
    // Every body with sites, in body order (Lumen's Quietfall Wreck too: it counts in the total).
    for (const planet of BODY_IDS.filter((b) => WILD_SITES.some((x) => x.body === b))) {
      el("div", "cat", body, planet);
      for (const s of WILD_SITES.filter((x) => x.body === planet)) {
        const row = el("div", "row", body);
        const left = el("div", "", row);
        if (!found.has(s.id)) {
          el("div", "nm", left, "???");
          el("div", "meta", left, `An unfound place · levels ${s.levels[0]}–${s.levels[1]}`);
          continue;
        }
        el("div", "nm", left, `${s.name} · Lv ${s.levels[0]}–${s.levels[1]}`);
        el("div", "meta", left, s.blurb);
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

// ---------------------------------------------------------------- keypads

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
    el("h2", "", b, this.target === "e12_safe" ? "TIMEBOX" : "WALL SAFE");
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
  /** Open mission ids at the last update (null before the first): a new one is the mission just taken. */
  private static openIds: Set<string> | null = null;
  private readonly offTrack = missionTrack.onChange(() => {
    this.last = "";
  });

  constructor(
    private readonly hud: Pick<Hud, "setMissions"> | HTMLElement,
    private readonly onMore: () => void = () => {},
  ) {}

  /** `body`: where the player is; `trial`: the mission of the running trial attempt, if any (trialState.ts). */
  update(you: YouPlus | null, body: BodyId, trial: string | null = null) {
    const all = you?.missions ?? [];
    if (you) {
      const open = new Set(all.filter((m) => !m.done).map((m) => m.id));
      const prev = MissionTracker.openIds;
      // #69: the one tracked stays tracked; a mission just taken is tracked only if nothing was.
      missionTrack.settle(all, body, prev ? [...open].filter((id) => !prev.has(id)) : []);
      MissionTracker.openIds = open;
    }
    const key = JSON.stringify([all, body, trial, missionTrack.chosen]);
    if (key === this.last || this.hud instanceof HTMLElement) return;
    this.last = key;
    const rows = trackerRows(all, body, { trial, tracked: missionTrack.chosen });
    this.hud.setMissions(rows.lines, rows.header, rows.more ? { count: rows.more, open: this.onMore } : null);
  }

  dispose() {
    this.offTrack();
    if (!(this.hud instanceof HTMLElement)) this.hud.setMissions([]);
  }
}

// ---------------------------------------------------------------- admin console (Shift+` ; ` alone is the performance overlay)

const CONSOLE_HELP = `stage <1-5> [all] · coins <n> · level <n> · give <id> [tier] [qty] · medal <id> · egg <E1-E12> · heal · unprotect · spells · announce <text> · ${SKY_HELP}`;

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
    case "sky":
      return { cmd, args: parseSkyArgs(rest) };
    case "spells":
      // `spells` (or `spells refill`): full aether and no cooldowns (server world/spells).
      return { cmd, args: { refill: true } };
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
        this.close(true); // back into the game (Panel.onKey explains why Esc may re-lock)
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
