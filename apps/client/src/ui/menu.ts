// Esc menu (verdict: Entry B): shown when the mouse is released. Rows with descriptions, an inline
// 30 s logout countdown with Cancel, an "outside a safe zone" warning, How to play with keys next to
// their labels, Settings, and Save your character for guests. Also the full-screen notices
// (logged out, connection lost, playing elsewhere, banned).

import "./menu.css";
import { PF } from "@firstlight/shared/net/schema";
import { STARTERS } from "@firstlight/shared/content/weapons";
import type { Game } from "../game/Game.ts";
import { showSavePrompt } from "./account.ts";
import { getPlayToken, isDevGuest, readClaims } from "../net/auth.ts";
import { button, el, icon, isOverlayOpen, keycaps, sprite, uiRoot } from "./dom.ts";
import { installSprites, portraitSprite } from "./sprites.ts";
import { openSettings } from "./settingsScreen.ts";
import { openVoicePanel, voice } from "../voice/index.ts";

type Ctl = [keys: string[] | "mouse-l" | "mouse-r" | "mouse-move", label: string];

/** How to play. Every key the game binds (SPEC §4.4). */
export const CONTROLS: { title: string; rows: Ctl[] }[] = [
  {
    title: "Move",
    rows: [[["W", "A", "S", "D"], "Move"], ["mouse-move", "Look"], [["Space"], "Jump"], [["Shift"], "Sprint"], [["C"], "Dodge-roll"]],
  },
  {
    title: "Fight",
    rows: [["mouse-l", "Attack"], ["mouse-r", "Aim · block"], [["1", "2", "3", "4"], "Weapons"], [["R"], "Reload"], [["G"], "Phrase wheel (hold)"]],
  },
  {
    title: "World",
    rows: [[["E"], "Interact · pick up"], [["I"], "Inventory"], [["M"], "Map · fast travel"], [["J"], "Journal"], [["Tab"], "Players"], [["P"], "Screenshot"], [["F9"], "Photo mode"]],
  },
  {
    title: "Voice",
    rows: [[["V"], "Push to talk"], [["B"], "Talk on radio"], [["Shift", "Esc"], "Mute everyone"]],
  },
];

/** Extra pause-menu rows other systems offer while they apply (onboarding: "Skip tutorial"). */
export interface PauseExtra {
  icon: string;
  title: string;
  sub: string;
  onClick: () => void;
}
export const pauseExtras = new Set<() => PauseExtra | null>();

const RULES: [sprite: string, title: string, text: string][] = [
  ["heart", "One life", "Die and everything you carry drops in a pile of light. Anyone can loot it."],
  ["prism", "Pads are safe", "A 12 m ring around every pad: no damage in or out. All of Portus is safe."],
  ["crown", "Bosses need friends", "No boss can be beaten alone. The game won't tell you why."],
];

const MOUSE: Record<string, string> = {
  "mouse-l": `<svg viewBox="0 0 16 20" aria-hidden="true"><rect x="1" y="1" width="14" height="18" rx="7" fill="none" stroke="#efe9df" stroke-width="1.4"/><path d="M8 1v7H1.2A7 7 0 0 1 8 1z" fill="#f3ae5b"/><path d="M1 8h14M8 1v7" stroke="#efe9df" stroke-width="1.2"/></svg>`,
  "mouse-r": `<svg viewBox="0 0 16 20" aria-hidden="true"><rect x="1" y="1" width="14" height="18" rx="7" fill="none" stroke="#efe9df" stroke-width="1.4"/><path d="M8 1v7h6.8A7 7 0 0 0 8 1z" fill="#f3ae5b"/><path d="M1 8h14M8 1v7" stroke="#efe9df" stroke-width="1.2"/></svg>`,
  "mouse-move": `<svg viewBox="0 0 16 20" aria-hidden="true"><rect x="1" y="1" width="14" height="18" rx="7" fill="none" stroke="#efe9df" stroke-width="1.4"/><path d="M1 8h14M8 1v7" stroke="#efe9df" stroke-width="1.2"/><path d="M8 11l-2 2h4zM8 17l-2-2h4z" fill="#f3ae5b"/></svg>`,
};
const MOUSE_LABEL: Record<string, string> = { "mouse-l": "Left mouse button", "mouse-r": "Right mouse button", "mouse-move": "Mouse" };

export function buildHowTo(parent: HTMLElement): HTMLElement {
  const panel = el("section", "fl-howto fl-panel", parent);
  const head = el("header", "", panel);
  el("h2", "", head, "How to play");
  el("span", "", head, "Esc frees the mouse · click the world to go back");
  const cols = el("div", "fl-howto__cols", panel);
  for (const g of CONTROLS) {
    const col = el("div", "", cols);
    el("h3", "", col, g.title);
    const dl = el("dl", "", col);
    for (const [keys, label] of g.rows) {
      const dt = el("dt", "", dl);
      if (typeof keys === "string") {
        const m = el("span", "fl-mouse", dt);
        m.innerHTML = MOUSE[keys]!;
        m.setAttribute("aria-label", MOUSE_LABEL[keys]!);
      } else keycaps(keys, dt);
      el("dd", "", dl, label);
    }
  }
  const rules = el("div", "fl-howto__rules", panel);
  for (const [sp, title, text] of RULES) {
    const r = el("div", "fl-rule", rules);
    sprite(sp, "", r);
    el("b", "", r, title);
    el("span", "", r, text);
  }
  return panel;
}

export class Menu {
  private readonly el: HTMLDivElement;
  private suppressed = false;
  private mode: "hidden" | "pause" | "settings" | "notice" = "hidden";
  private ticker = 0;
  private closeSettings: (() => void) | null = null;
  // live pause-menu refs
  private zone: HTMLElement | null = null;
  private lede: HTMLElement | null = null;
  private logoutItem: HTMLButtonElement | null = null;
  private logoutTitle: HTMLElement | null = null;
  private logoutSub: HTMLElement | null = null;
  private logoutRight: HTMLElement | null = null;
  private logoutBar: HTMLElement | null = null;
  private last = { safe: null as boolean | null, secs: -2 };
  private logoutRequestedAt = 0;

  constructor(private readonly game: Game) {
    installSprites();
    this.el = el("div", "fl-overlay fl-ui fl-menu", uiRoot());
    this.el.hidden = true;
    this.el.addEventListener("mousedown", (e) => {
      // "Resume, or click anywhere": a click on the empty scrim goes back to the game.
      if (this.mode === "pause" && (e.target === this.el || (e.target as HTMLElement).classList.contains("fl-menu__screen"))) this.game.input.lock();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.mode === "settings") this.showPause();
    });
    document.addEventListener("pointerlockchange", () => {
      const locked = !!document.pointerLockElement;
      if (locked) this.hideAll();
      else if (!this.suppressed && !isOverlayOpen()) this.showPause();
    });
  }

  hideAll() {
    this.closeSettings?.();
    this.closeSettings = null;
    this.el.hidden = true;
    this.mode = "hidden";
    clearInterval(this.ticker);
  }

  private reset(cls: string) {
    this.closeSettings?.();
    this.closeSettings = null;
    clearInterval(this.ticker);
    this.el.className = `fl-overlay fl-ui fl-menu${cls ? ` ${cls}` : ""}`;
    this.el.replaceChildren();
    el("div", "fl-scrim", this.el);
    this.el.hidden = false;
    this.zone = this.lede = this.logoutItem = this.logoutTitle = this.logoutSub = this.logoutRight = this.logoutBar = null;
    this.last = { safe: null, secs: -2 };
  }

  private me() {
    const room = this.game.net.room;
    return (room?.state as any)?.players?.get(room?.sessionId ?? "") as { name: string; starter: number; level: number; flags: number } | undefined;
  }

  showPause() {
    if (this.game.combat?.deadUntilRespawn) return;
    this.reset("");
    this.mode = "pause";
    const screen = el("main", "fl-menu__screen", this.el);
    const left = el("section", "fl-menu__left", screen);
    const me = this.me();

    const id = el("div", "fl-menu__me", left);
    const face = el("div", "fl-face", id);
    sprite(portraitSprite(me?.starter ?? Number(localStorage.getItem("fl.starter") ?? 0)), "", face);
    const who = el("div", "", id);
    el("b", "", who, me?.name || "You");
    const sub = el("span", "", who, [STARTERS[me?.starter ?? 0]?.name, me ? `Level ${me.level}` : null].filter(Boolean).join(" · "));

    this.zone = el("div", "fl-menu__zone", left);
    el("h1", "", left, "The world doesn't pause.");
    this.lede = el("p", "fl-menu__lede", left);

    const items = el("ul", "fl-menu__items", left);
    items.setAttribute("role", "menu");
    const item = (iconName: string, title: string, small: string, cls = "", li = el("li", "", items)): { b: HTMLButtonElement; title: HTMLElement; sub: HTMLElement; right: HTMLElement } => {
      const b = button("", `fl-menu__item${cls ? ` ${cls}` : ""}`, li);
      b.setAttribute("role", "menuitem");
      icon(iconName, "", b);
      const t = el("span", "", b);
      const tt = el("b", "", t, title);
      const ss = el("small", "", t, small);
      const right = el("span", "", b);
      return { b, title: tt, sub: ss, right };
    };

    const resume = item("resume", "Resume", "or click anywhere in the world", "is-resume");
    resume.b.onclick = () => this.game.input.lock();

    const settings = item("sliders", "Settings", "Graphics, controls, audio, comfort");
    icon("chev-r", "", settings.right);
    settings.b.onclick = () => this.showSettings();

    const vc = voice();
    const voiceRow = item("mic", "Voice & radio", vc?.optedIn ? "Mutes, block, report, radio channel" : "Off until you opt in (16+). Never recorded.");
    icon("chev-r", "", voiceRow.right);
    voiceRow.b.onclick = () => openVoicePanel();
    voiceRow.b.disabled = !vc;

    const lo = item("logout", "Log out", "");
    this.logoutItem = lo.b;
    this.logoutTitle = lo.title;
    this.logoutSub = lo.sub;
    this.logoutRight = lo.right;
    this.logoutBar = el("span", "fl-menu__lobar", lo.b);
    el("i", "", this.logoutBar);
    lo.b.onclick = () => this.logoutClick();

    const saveSlot = el("li", "", items);
    saveSlot.hidden = true;
    if (!isDevGuest()) {
      void getPlayToken()
        .then((t) => {
          const c = readClaims(t);
          if (!c?.guest || this.mode !== "pause") return;
          sub.textContent += " · Guest";
          const save = item("save", "Save your character", `Keep ${c.name || "this character"} on any browser with an email code`, "", saveSlot);
          el("span", "fl-menu__badge", save.right, "Guest");
          save.b.onclick = () => void showSavePrompt({ name: c.name });
          saveSlot.hidden = false;
        })
        .catch(() => {});
    }

    for (const extra of pauseExtras) {
      const x = extra();
      if (!x) continue;
      const row = item(x.icon, x.title, x.sub);
      row.b.onclick = () => {
        x.onClick();
        this.game.input.lock();
      };
    }

    const howto = item("book", "How to play", "Controls and the three rules", "is-on");
    icon("chev-r", "", howto.right);
    howto.b.setAttribute("aria-expanded", "true");

    const foot = el("footer", "fl-menu__foot", left);
    const mute = el("span", "", foot);
    keycaps(["Shift"], mute);
    mute.append("+");
    keycaps(["Esc"], mute);
    mute.append("Mute everyone");
    const perf = el("span", "", foot);
    keycaps(["F3"], perf);
    perf.append("Performance");
    const photo = el("span", "", foot);
    keycaps(["F9"], photo);
    photo.append("Photo mode");

    buildHowTo(screen);
    this.tick();
    this.ticker = window.setInterval(() => this.tick(), 250);
  }

  private logoutClick() {
    const room = this.game.net.room;
    const endsAt = this.game.hud?.you?.logoutEndsAt;
    if (endsAt) {
      room?.send("logout", { start: false });
      return;
    }
    this.logoutRequestedAt = performance.now();
    room?.send("logout", { start: true });
  }

  /** 4 Hz while the pause menu is open: zone status and the logout countdown. DOM writes only on change. */
  private tick() {
    if (this.mode !== "pause" || !this.zone || !this.lede || !this.logoutItem) return;
    const me = this.me();
    const safe = !!me && !!(me.flags & PF.SAFE);
    const body = this.game.bodyId ? this.game.bodyId[0]!.toUpperCase() + this.game.bodyId.slice(1) : "the world";
    if (safe !== this.last.safe) {
      this.last.safe = safe;
      this.zone.className = `fl-menu__zone${safe ? " is-safe" : ""}`;
      this.zone.replaceChildren();
      icon(safe ? "shield" : "alert", "", this.zone);
      const s = el("span", "", this.zone);
      el("b", "", s, safe ? "In a safe zone" : "Outside a safe zone");
      s.append(safe ? " · no damage in or out" : " · anyone can hit you");
      this.lede.textContent = safe
        ? `You're standing in ${body}, inside a safe zone. Nobody can hurt you here.`
        : `You're still standing in ${body}. Anyone nearby can see you, and hit you.`;
      this.last.secs = -2; // re-render the logout row for the new zone
    }
    const endsAt = this.game.hud?.you?.logoutEndsAt ?? null;
    const now = Date.now() + (this.game.net.serverOffset ?? 0);
    const left = endsAt ? Math.max(0, endsAt - now) : -1;
    const denied = left < 0 && this.logoutRequestedAt > 0 && performance.now() - this.logoutRequestedAt > 1200;
    const secs = left < 0 ? (denied ? -3 : -1) : Math.ceil(left / 1000);
    if (secs === this.last.secs) return;
    this.last.secs = secs;
    const b = this.logoutItem;
    b.classList.toggle("is-logout", secs >= 0);
    b.classList.toggle("is-denied", secs === -3);
    this.logoutRight!.replaceChildren();
    this.logoutBar!.hidden = secs < 0;
    if (secs >= 0) {
      this.logoutTitle!.textContent = `Logging out · ${secs} s`;
      this.logoutSub!.textContent = "Stay still. Moving or taking damage cancels.";
      el("span", "fl-btn fl-btn--sm", this.logoutRight, "Cancel");
      (this.logoutBar!.firstElementChild as HTMLElement).style.setProperty("--fill", (1 - left / 30_000).toFixed(3));
    } else {
      this.logoutTitle!.textContent = "Log out";
      this.logoutSub!.textContent = denied
        ? "Not right now: you were in a fight in the last 10 s."
        : safe ? "Instant here: you're in a safe zone." : "Takes 30 s out here, standing still. Instant on a pad.";
      const t = el("span", "fl-menu__timer", this.logoutRight);
      icon("clock", "", t);
      t.append(safe ? "now" : "30 s");
      if (denied) this.logoutRequestedAt = 0;
    }
  }

  showSettings() {
    this.reset("");
    this.mode = "settings";
    this.closeSettings = openSettings(this.game, this.el, () => this.showPause());
  }

  showLoggedOut() {
    this.suppressed = true;
    this.showNoticeCard("Logged out", "Your character is saved where you left it.", "Play again", () => void this.game.resume());
  }

  /** A full-screen notice (connection lost, playing elsewhere, banned) with an optional action. */
  showNotice(title: string, text: string, action: string | null, fn: (() => void) | null) {
    this.suppressed = true;
    this.showNoticeCard(title, text, action, fn);
  }

  private showNoticeCard(title: string, text: string, action: string | null, fn: (() => void) | null) {
    this.reset("fl-menu--notice");
    this.mode = "notice";
    const card = el("section", "fl-notice fl-panel", this.el);
    card.setAttribute("role", "alertdialog");
    const mark = el("div", "fl-wordmark fl-wordmark--sm", card, "First");
    el("b", "", mark, "light");
    el("h2", "", card, title);
    el("p", "", card, text);
    if (action && fn) {
      const b = button(action, "fl-btn fl-btn--primary fl-btn--lg", card, () => {
        this.suppressed = false;
        this.hideAll();
        fn();
      });
      b.focus();
    }
  }
}
