// Admin mode panel (D-admin-1): the owner's test switches, opened from the Esc menu's Admin row
// (admins only). Every button sends `admin {cmd: "adminmode", args}`; the server decides and answers
// with `you.adminMode` (server/world/adminMode.ts), and the panel re-renders from that.

import "./quests.css";
import type { AdminModeState, AdminToggle } from "@firstlight/shared/content/admin";
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
    return this.you()?.adminMode ?? { fly: false, god: false, speed: false, session: false };
  }

  render() {
    const m = this.state();
    const b = this.box;
    b.innerHTML = "";
    el("h2", "", b, "ADMIN MODE");
    el("p", "sub", b, m.session
      ? "Test session: nothing you earn is kept, and nothing leaves it (no drops, pickups, PvP or medals). Back to normal ends it, and so do travelling, closing the game or dying."
      : "Only for admins; the server checks every switch. Any switch starts a test session: your real character is kept safe and comes back with Back to normal.");
    const body = el("div", "body", b);

    for (const [k, name, text] of TOGGLES) {
      const row = el("div", "row", body);
      const t = el("div", "", row);
      el("div", "nm", t, name);
      el("div", "meta", t, text);
      el("span", "meta", row, m[k] ? "ON" : "off");
      const btn = el("button", m[k] ? "btn" : "btn ghost", row, m[k] ? "Turn off" : "Turn on");
      btn.dataset.e2e = `admin-${k}`;
      btn.onclick = () => adminMode(this.game, { [k]: !m[k] });
    }
    const action = (name: string, text: string, act: string, label: string) => {
      const row = el("div", "row", body);
      const t = el("div", "", row);
      el("div", "nm", t, name);
      el("div", "meta", t, text);
      el("span", "meta", row, "");
      const btn = el("button", "btn ghost", row, label);
      btn.dataset.e2e = `admin-${act}`;
      btn.onclick = () => adminMode(this.game, { action: act });
    };
    action("Max level", "The level cap and full health: every tier unlocks.", "maxlevel", "Apply");
    action("Every item", "One of every item in your hotbar and backpack (best tier for your level).", "giveall", "Fill");
    action("Back to normal", "Ends the test session: switches off, your character as it was.", "normal", "Restore");

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
        btn.style.marginLeft = ".3em";
        btn.onclick = () => adminMode(this.game, { action: "hand", id: w.id, tier: t });
      }
      el("span", "", row);
    }
    const cos = el("div", "", body);
    cos.style.cssText = "display:flex;flex-wrap:wrap;gap:.3em;padding:.4em .6em";
    for (const c of COSMETICS) el("button", "btn ghost", cos, c.name).onclick = () => adminMode(this.game, { action: "hand", id: c.id });

    const foot = el("div", "foot", b);
    el("span", "", foot, "Admin actions are logged on the server.");
    el("button", "btn ghost", foot, "Close").onclick = () => this.close();
  }
}
