// Inventory (I, SPEC §4.4): opens the inventory panel from play, keeps it in step with the `you`
// message, and closes it on death or when the body changes.

import { InventoryPanel } from "../ui/inventory.ts";
import { Panel } from "../ui/panels.ts";
import type { Game } from "./Game.ts";
import type { ClientSystem } from "./systems.ts";

export class InventoryClient implements ClientSystem {
  readonly panel: InventoryPanel;
  private readonly game: Game;
  private lastYou: unknown = null;
  private readonly onKey = (e: KeyboardEvent) => {
    if (e.code !== "KeyI" || e.repeat) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
    const g = this.game;
    if (Panel.current || !g.input.locked || g.photo?.active || g.combat.deadUntilRespawn || !g.net.room) return;
    e.preventDefault();
    this.panel.open();
  };

  constructor(game: Game) {
    this.game = game;
    this.panel = new InventoryPanel(game);
    window.addEventListener("keydown", this.onKey);
  }

  update() {
    const you = this.game.hud.you;
    if (you === this.lastYou) return;
    this.lastYou = you;
    if (!this.panel.isOpen) return;
    if (you?.dead) this.panel.close(false);
    else this.panel.refresh();
  }

  dispose() {
    window.removeEventListener("keydown", this.onKey);
    if (this.panel.isOpen) this.panel.close(false);
  }
}

export function createInventoryClient(game: Game): ClientSystem | null {
  return game.net.room ? new InventoryClient(game) : null;
}
