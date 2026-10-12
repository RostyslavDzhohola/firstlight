// Esc menu (shown when the mouse is released): Resume, Log out (30 s outside safe zones),
// controls list. Also the "logged out" screen.

import { PF } from "@firstlight/shared/net/schema";
import type { Game } from "../game/Game.ts";
import { showSavePrompt } from "./account.ts";
import { getPlayToken, isDevGuest, readClaims } from "../net/auth.ts";
import { openVoicePanel } from "../voice/index.ts";

const CONTROLS = [
  ["WASD", "move"], ["Mouse", "aim"], ["Left click", "attack"], ["Right click", "aim / block / charge"],
  ["Shift", "sprint"], ["Space", "jump"], ["C", "dodge"], ["R", "reload"], ["1–4", "weapons"], ["E", "pick up"],
  ["G (hold)", "phrase wheel"], ["V", "push to talk"], ["B", "radio"], ["Shift+Esc", "mute all voices"],
  ["F3", "performance"], ["Esc", "this menu"],
];

export class Menu {
  private readonly el: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private suppressed = false;

  constructor(private readonly game: Game) {
    this.el = document.createElement("div");
    this.el.className = "fl-overlay";
    this.el.style.display = "none";
    this.panel = document.createElement("div");
    this.panel.className = "fl-panel";
    this.el.appendChild(this.panel);
    document.body.appendChild(this.el);
    document.addEventListener("pointerlockchange", () => {
      const locked = !!document.pointerLockElement;
      if (locked) this.el.style.display = "none";
      else if (!this.suppressed && !document.querySelector(".fl-overlay:not([style*='none']) .fl-starters, .fl-overlay h2")) this.showPause();
    });
  }

  hideAll() {
    this.el.style.display = "none";
  }

  showPause() {
    if (this.game.combat?.deadUntilRespawn) return;
    this.panel.innerHTML = "";
    const h = document.createElement("h2");
    h.textContent = "PAUSED";
    const note = document.createElement("p");
    note.textContent = "The world doesn't pause — you can still be attacked outside safe zones.";
    const resume = this.button("Resume", () => this.game.input.lock());
    const logout = this.button("Log out", () => {
      const room = this.game.net.room;
      const me = (room?.state as any)?.players?.get(room?.sessionId ?? "");
      room?.send("logout", { start: true });
      if (me && !(me.flags & PF.SAFE)) {
        this.game.hud.toast("Logging out in 30 s — don't move. Log out in a safe zone to leave instantly.", "warn");
        this.game.input.lock();
      }
    }, true);
    const ctl = document.createElement("div");
    ctl.style.cssText = "display:grid;grid-template-columns:auto auto;gap:4px 16px;justify-content:center;margin:14px 0;font-size:13px;color:#c9c2e0";
    for (const [k, v] of CONTROLS) {
      const a = document.createElement("b");
      a.textContent = k!;
      const b = document.createElement("span");
      b.textContent = v!;
      ctl.append(a, b);
    }
    const voice = this.button("Voice & radio", () => openVoicePanel(), true);
    this.panel.append(h, note, ctl, resume, voice, logout);
    if (!isDevGuest()) {
      void getPlayToken().then((t) => {
        const c = readClaims(t);
        if (c?.guest) this.panel.append(this.button("Save your character", () => void showSavePrompt({ name: c.name }), true));
      }).catch(() => {});
    }
    this.el.style.display = "grid";
  }

  showLoggedOut() {
    this.suppressed = true;
    this.panel.innerHTML = "";
    const h = document.createElement("h2");
    h.textContent = "LOGGED OUT";
    const p = document.createElement("p");
    p.textContent = "Your character is saved where you left it.";
    this.panel.append(h, p, this.button("Play again", () => {
      this.suppressed = false;
      void this.game.resume();
    }));
    this.el.style.display = "grid";
  }

  /** A full-screen notice (connection lost, playing elsewhere, banned) with an optional action. */
  showNotice(title: string, text: string, action: string | null, fn: (() => void) | null) {
    this.suppressed = true;
    this.panel.innerHTML = "";
    const h = document.createElement("h2");
    h.textContent = title;
    const p = document.createElement("p");
    p.textContent = text;
    this.panel.append(h, p);
    if (action && fn) {
      this.panel.append(this.button(action, () => {
        this.suppressed = false;
        fn();
      }));
    }
    this.el.style.display = "grid";
  }

  private button(text: string, fn: () => void, ghost = false): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = `fl-btn${ghost ? " ghost" : ""}`;
    b.textContent = text;
    b.onclick = fn;
    return b;
  }
}
