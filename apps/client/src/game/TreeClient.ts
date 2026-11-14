// The build tree on the client (#81): U opens the panel while playing; the pause menu has a row for
// it on every device (a pad or a touch screen has no U); a level-up says a point is waiting with a
// toast that names the key, never a card that needs the mouse; refusals come back as toasts. The
// numbers the tree changes are predicted where they are used (PlayerController's pace and rolls,
// CombatClient's heavy cooldown and draw, the spell tooltips).

import { PF } from "@firstlight/shared/net/schema";
import type { TreeYou } from "@firstlight/shared/content/tree";
import type { YouState } from "@firstlight/shared/net/protocol";
import { pauseExtras, type PauseExtra } from "../ui/menu.ts";
import { Panel } from "../ui/panels.ts";
import { treeMenuSub, treeView } from "../ui/treeModel.ts";
import { TreePanel } from "../ui/treePanel.ts";
import type { Game } from "./Game.ts";
import { HOTKEYS, hits } from "./keys.ts";
import type { ClientSystem } from "./systems.ts";

/** What a refusal says (the server's reasons, protocol.ts `tree`). */
export const TREE_REFUSAL_TEXT: Record<string, string> = {
  points: "Not enough points for that node yet",
  locked: "Take the node above it first",
  taken: "Already taken",
  dead: "",
  nothing: "Nothing to respec",
  "safe zone": "Respec only in a safe zone",
  coins: "Not enough coins to respec",
  "try again": "Couldn't save that choice; nothing changed. Try again",
  unknown: "",
};

/** The toast when points are waiting, or null when there is nothing new to say. */
export function pointToast(prev: TreeYou | undefined, next: TreeYou | undefined, keycap: string): string | null {
  if (!next || next.points <= 0) return null;
  if (prev && next.points <= prev.points) return null;
  return `${next.points} build point${next.points === 1 ? "" : "s"} to spend: press ${keycap} (or Esc → Build)`;
}

class TreeClient implements ClientSystem {
  private readonly game: Game;
  private readonly panel: TreePanel;
  private readonly offs: (() => void)[] = [];
  private last: TreeYou | undefined;
  private readonly onKey = (e: KeyboardEvent) => this.key(e);
  private readonly extra = (): PauseExtra | null => {
    const you = this.game.hud.you;
    if (!you?.tree || you.dead) return null;
    const v = treeView({ starter: this.game.hud.starterIndex, level: you.level, tree: you.tree.nodes, coins: you.coins, safe: this.safe() });
    return { icon: "star", title: v.points > 0 ? "Build · points to spend" : "Build", sub: treeMenuSub(v, HOTKEYS.build.caps.join(" ")), onClick: () => queueMicrotask(() => this.panel.open()) };
  };

  constructor(game: Game) {
    this.game = game;
    this.panel = new TreePanel(game, () => this.safe());
    window.addEventListener("keydown", this.onKey);
    pauseExtras.add(this.extra);
    this.last = game.hud.you?.tree;
    const room = game.net.room!;
    const on = (type: string, cb: (m: never) => void) => {
      const off = room.onMessage(type, cb as (m: unknown) => void) as unknown;
      if (typeof off === "function") this.offs.push(off as () => void);
    };
    on("you", (y: YouState & { dead?: boolean }) => {
      const text = y.dead ? null : pointToast(this.last, y.tree, HOTKEYS.build.caps.join(" "));
      // Calm moments only: the first `you` of a session says nothing (the banner is for level-ups).
      if (text && this.last) game.hud.toast(text, "xp");
      this.last = y.tree;
      if (this.panel.isOpen) {
        if (y.dead) this.panel.close(false);
        else queueMicrotask(() => this.panel.refresh()); // after the HUD has the new `you`
      }
    });
    on("denied", (m: { action: string; reason: string }) => {
      if (m.action !== "tree") return;
      const text = TREE_REFUSAL_TEXT[m.reason] ?? m.reason;
      if (text) game.hud.toast(text, "warn");
    });
  }

  /** The local player stands in a safe zone (the server's SAFE flag; the server checks again). */
  private safe(): boolean {
    const room = this.game.net.room;
    const me = (room?.state as { players?: Map<string, { flags: number }> } | undefined)?.players?.get(room?.sessionId ?? "");
    return !!me && (me.flags & PF.SAFE) !== 0;
  }

  private key(e: KeyboardEvent) {
    if (!hits(HOTKEYS.build, e.code, e.shiftKey) || e.repeat) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
    if (Panel.current) return; // an open panel closes itself (this one on U too)
    if (this.game.combat.deadUntilRespawn || !this.game.input.inPlay || this.game.photo?.active) return;
    if (!this.game.hud.you?.tree) return;
    e.preventDefault();
    this.panel.open();
  }

  update() {}

  dispose() {
    window.removeEventListener("keydown", this.onKey);
    pauseExtras.delete(this.extra);
    this.panel.close(false);
    for (const off of this.offs.splice(0)) off();
  }
}

export function createTreeClient(game: Game): ClientSystem | null {
  return game.net.room ? new TreeClient(game) : null;
}
