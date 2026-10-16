// Admin mode on the client (D-admin-1): the Esc menu's Admin row (admins only) opens the panel, the
// server's `you.adminMode` drives the controller (flying, speed) and a badge on the player card, so
// screenshots taken in admin mode say so. The server decides everything (server/world/adminMode.ts).

import type { AdminModeState } from "@firstlight/shared/content/admin";
import { ADMIN_MODE } from "@firstlight/shared/content/admin";
import type { YouState } from "@firstlight/shared/net/protocol";
import { PF } from "@firstlight/shared/net/schema";
import { AdminPanel } from "../ui/adminPanel.ts";
import { pauseExtras, type PauseExtra } from "../ui/menu.ts";
import type { Game } from "./Game.ts";
import type { ClientSystem } from "./systems.ts";

/** The badge text: "ADMIN TEST · FLY · GOD · ×2" during a test session, else null. */
export function adminBadge(m: AdminModeState | undefined): string | null {
  if (!m || (!m.session && !m.fly && !m.god && !m.speed)) return null;
  return ["ADMIN TEST", m.fly && "FLY", m.god && "GOD", m.speed && `×${ADMIN_MODE.speedMult}`].filter(Boolean).join(" · ");
}

export class AdminModeClient implements ClientSystem {
  private readonly game: Game;
  private readonly panel: AdminPanel;
  private badge: HTMLElement | null = null;
  private readonly pauseRow = (): PauseExtra | null =>
    this.isAdmin() ? { icon: "key", title: "Admin", sub: "Fly, god mode, speed, max level, every item", onClick: () => this.panel.open() } : null;

  constructor(game: Game) {
    this.game = game;
    this.panel = new AdminPanel(game);
    pauseExtras.add(this.pauseRow);
    const room = game.net.room!;
    if (game.hud.you) this.apply(game.hud.you.adminMode);
    room.onMessage("you", (m: YouState) => {
      this.apply(m.adminMode);
      if (this.panel.isOpen) this.panel.refresh();
    });
  }

  private isAdmin(): boolean {
    const room = this.game.net.room;
    const me = (room?.state as { players?: Map<string, { flags: number }> } | undefined)?.players?.get(room!.sessionId);
    return !!me && (me.flags & PF.ADMIN) !== 0;
  }

  private apply(m: AdminModeState | undefined) {
    const p = this.game.player;
    p.adminFly = !!m?.fly;
    p.adminSpeed = m?.speed ? ADMIN_MODE.speedMult : 1;
    const text = adminBadge(m);
    if (!text) {
      this.badge?.remove();
      this.badge = null;
      return;
    }
    if (!this.badge) {
      // On the player card, next to the safe / danger chip.
      const row = this.game.hud.root.querySelector(".fl-me__zone")?.parentElement ?? this.game.hud.root;
      this.badge = document.createElement("span");
      this.badge.className = "fl-chip admin";
      this.badge.dataset.e2e = "admin-badge";
      row.appendChild(this.badge);
    }
    this.badge.textContent = text;
  }

  update() {}

  dispose() {
    pauseExtras.delete(this.pauseRow);
    this.panel.close(false);
    this.badge?.remove();
    this.game.player.adminFly = false;
    this.game.player.adminSpeed = 1;
  }
}

export function createAdminModeClient(game: Game): ClientSystem | null {
  return game.net.room ? new AdminModeClient(game) : null;
}
