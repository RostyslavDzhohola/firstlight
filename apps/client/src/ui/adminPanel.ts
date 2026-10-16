// Admin mode panel (D-admin-1, D-admin-3): the owner's test switches, opened from the Esc menu's
// Admin row (admins only). In the sandbox every button sends `admin {cmd: "adminmode", args}`; the
// server decides and answers with `you.adminMode` (server/world/adminMode.ts), and the panel
// re-renders from that. In the real world the first button asks for the sandbox instead and the
// command waits for the arrival (AdminModeClient); Back to normal leaves the sandbox.

import "./quests.css";
import { SANDBOX_BADGE, type AdminModeState, type AdminToggle } from "@firstlight/shared/content/admin";
import { COSMETICS } from "@firstlight/shared/content/items";
import { WEAPONS } from "@firstlight/shared/content/weapons";
import type { Game } from "../game/Game.ts";
import { el } from "./dom.ts";
import { HIDDEN_ITEMS } from "./hudFormat.ts";
import { Panel } from "./panels.ts";

const TIER = ["", "I", "II", "III"];

const TOGGLES: [AdminToggle, string, string][] = [
  ["fly", "Fly", "Space up, C down. No gravity, no fall damage."],
  ["god", "God mode", "You take no damage. Players in safe zones are still safe from you."],
  ["speed", "Speed ×2", "Running, sprinting, swimming and flying."],
];

/** Send one admin-mode command. */
export function adminMode(game: Game, args: Record<string, unknown>) {
  game.net.room?.send("admin" as never, { cmd: "adminmode", args } as never);
}

export class AdminPanel extends Panel {
  constructor(game: Game) {
    super(game, "fl-q fl-admin");
  }

  private state(): AdminModeState {
    return this.you()?.adminMode ?? { fly: false, god: false, speed: false, sandbox: false };
  }

  /** In the sandbox: send it. In the real world: into the sandbox first; it goes on arrival. */
  private send(args: Record<string, unknown>) {
    if (this.state().sandbox) return adminMode(this.game, args);
    this.game.sandboxPending = args;
    adminMode(this.game, { action: "sandbox" });
    this.close();
  }

  render() {
    const m = this.state();
    const b = this.box;
    b.innerHTML = "";
    el("h2", "", b, m.sandbox ? SANDBOX_BADGE.toUpperCase() : "ADMIN MODE");
    el("p", "sub", b, m.sandbox
      ? "Your sandbox: a private copy of this body. Nobody else is here and nothing you do or earn is kept. Travel stays in the sandbox. Back to normal returns to your real character, as and where you left it."
      : "Only for admins; the server checks every switch. The first one moves you into your sandbox, a private copy of this body where nothing is saved. Your real character stays as it is.");
    const body = el("div", "body", b);

    for (const [k, name, text] of TOGGLES) {
      const row = el("div", "row", body);
      const t = el("div", "", row);
      el("div", "nm", t, name);
      el("div", "meta", t, text);
      el("span", "meta", row, m[k] ? "ON" : "off");
      const btn = el("button", m[k] ? "btn" : "btn ghost", row, m[k] ? "Turn off" : "Turn on");
      btn.dataset.e2e = `admin-${k}`;
      btn.onclick = () => this.send({ [k]: !m[k] });
    }
    const action = (name: string, text: string, act: string, label: string, run = () => this.send({ action: act })) => {
      const row = el("div", "row", body);
      const t = el("div", "", row);
      el("div", "nm", t, name);
      el("div", "meta", t, text);
      el("span", "meta", row, "");
      const btn = el("button", "btn ghost", row, label);
      btn.dataset.e2e = `admin-${act}`;
      btn.onclick = run;
    };
    action("Max level", "The level cap and full health: every tier unlocks.", "maxlevel", "Apply");
    action("Every item", "One of every item in your hotbar and backpack (best tier for your level).", "giveall", "Fill");
    if (m.sandbox) {
      action("Back to normal", "Leave the sandbox: your real character, as and where you left it.", "normal", "Leave", () => {
        this.close();
        this.game.leaveSandbox();
      });
    }

    // The armoury: any item at any tier into your hand; a cosmetic goes on.
    el("h3", "", body, "Armoury").style.margin = "1em 0 .3em";
    el("p", "meta", body, "Click to hold it (your selected hotbar slot). Cosmetics go in your backpack and on.");
    for (const w of WEAPONS) {
      if (w.id === "fists" || HIDDEN_ITEMS.has(w.id)) continue;
      const row = el("div", "row", body);
      el("div", "nm", row, w.name);
      const tiers = el("span", "", row);
      for (let t = 1; t <= w.tiers.length; t++) {
        const btn = el("button", "btn ghost", tiers, TIER[t]!);
        btn.setAttribute("aria-label", `${w.name} ${TIER[t]}`);
        btn.style.marginLeft = ".3em";
        btn.onclick = () => this.send({ action: "hand", id: w.id, tier: t });
      }
      el("span", "", row);
    }
    const cos = el("div", "", body);
    cos.style.cssText = "display:flex;flex-wrap:wrap;gap:.3em;padding:.4em .6em";
    for (const c of COSMETICS) el("button", "btn ghost", cos, c.name).onclick = () => this.send({ action: "hand", id: c.id });

    const foot = el("div", "foot", b);
    el("span", "", foot, "Admin actions are logged on the server.");
    el("button", "btn ghost", foot, "Close").onclick = () => this.close();
  }
}
