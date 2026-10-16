// Admin mode on the client (D-admin-1, D-admin-3): the Esc menu's Admin row (admins only) opens the
// panel. The first switch or action asks the server to move into the admin's sandbox (a private copy
// of the body where nothing is saved); the server saves the real character and answers `sandbox`,
// the game travels into it, and the command waiting for it is sent on arrival. In the sandbox
// `you.adminMode` drives the controller (flying, speed) and the badge on the player card, so
// screenshots say where they were taken. The server decides everything (server/world/adminMode.ts).

import type { AdminModeState } from "@firstlight/shared/content/admin";
import { ADMIN_MODE, SANDBOX_BADGE } from "@firstlight/shared/content/admin";
import type { BodyId } from "@firstlight/shared";
import type { YouState } from "@firstlight/shared/net/protocol";
import { PF } from "@firstlight/shared/net/schema";
import "../ui/admin.css";
import { AdminPanel, adminMode } from "../ui/adminPanel.ts";
import { pauseExtras, type PauseExtra } from "../ui/menu.ts";
import type { Game } from "./Game.ts";
import type { ClientSystem } from "./systems.ts";

/** The badge text: "SANDBOX — nothing here is saved · FLY · GOD · ×2" in a sandbox, else null. */
export function adminBadge(m: AdminModeState | undefined): string | null {
  if (!m?.sandbox) return null;
  return [SANDBOX_BADGE, m.fly && "FLY", m.god && "GOD", m.speed && `×${ADMIN_MODE.speedMult}`].filter(Boolean).join(" · ");
}

/** /api/play's sandbox refusals (server matchmaking.ts enterSandbox), as the toast says them. */
export const SANDBOX_REFUSALS: Readonly<Record<string, string>> = {
  forbidden: "No sandbox: admins only",
  "respawn first": "No sandbox while you're dead: respawn first",
  "in combat": "No sandbox in a fight: get clear first",
  "no character": "No sandbox yet: play once first",
};

/** The room's refusals of an admin-mode command, as the toast says them. */
const DENIED: Readonly<Record<string, string>> = {
  "sandbox:respawn first": SANDBOX_REFUSALS["respawn first"]!,
  "sandbox:in combat": SANDBOX_REFUSALS["in combat"]!,
  "admin:sandbox only": "Test switches only work in your sandbox",
  "admin:not from a sandbox": "Not from the sandbox: Back to normal first",
  "mod:not from a sandbox": "Not from the sandbox: Back to normal first",
};

export class AdminModeClient implements ClientSystem {
  private readonly game: Game;
  private readonly panel: AdminPanel;
  private badge: HTMLElement | null = null;
  private readonly pauseRow = (): PauseExtra | null =>
    this.isAdmin() ? { icon: "key", title: "Admin", sub: "Fly, god mode, speed, every item: in a private sandbox", onClick: () => this.panel.open() } : null;

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
    // The real character is saved: into the sandbox (the waiting command goes on arrival).
    room.onMessage("sandbox", (m: { home: BodyId }) => game.enterSandbox(m.home));
    room.onMessage("denied", (m: { action: string; reason: string }) => {
      const text = DENIED[`${m.action}:${m.reason}`];
      if (!text) return;
      if (m.action === "sandbox") game.sandboxPending = null;
      game.hud.toast(text, "warn");
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
    if (m?.sandbox) {
      this.game.sandbox ??= { home: m.home ?? this.game.bodyId };
      // Arrived: the command that asked for the sandbox.
      const pending = this.game.sandboxPending;
      this.game.sandboxPending = null;
      if (pending) adminMode(this.game, pending);
    }
    const text = adminBadge(m);
    if (!text) {
      this.badge?.remove();
      this.badge = null;
      return;
    }
    if (!this.badge) {
      // A line of its own on the player card, under the name (the notice is long).
      const row = this.game.hud.root.querySelector(".fl-me__id");
      this.badge = document.createElement("div");
      this.badge.className = "fl-chip admin fl-me__sandbox";
      this.badge.dataset.e2e = "admin-badge";
      if (row) row.after(this.badge);
      else this.game.hud.root.appendChild(this.badge);
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
