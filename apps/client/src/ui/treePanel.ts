// The build-tree panel (#81; U, or the pause menu on any device): five branches side by side, each
// node a button (mouse, touch, and the pad's focus navigator all press it), the numbers for this
// character, points left and the respec. The server decides; a refusal comes back as a toast
// (game/TreeClient.ts). Plain DOM like the other panels (D25).

import "./tree.css";
import { HOTKEYS } from "../game/keys.ts";
import type { Game } from "../game/Game.ts";
import { Panel } from "./panels.ts";
import { treeView, type NodeView } from "./treeModel.ts";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

const STATE_TAG: Record<NodeView["state"], string> = { taken: "Taken", open: "Take", locked: "Locked", dear: "Later" };

export class TreePanel extends Panel {
  protected closeKeys = [HOTKEYS.build.code];
  /** Whether the local player stands in a safe zone now (the SAFE flag the server sets). */
  private readonly safe: () => boolean;
  /** A respec asked for and not yet confirmed (a second press does it). */
  private confirming = false;

  constructor(game: Game, safe: () => boolean) {
    super(game, "fl-q fl-tree");
    this.safe = safe;
  }

  override open() {
    this.confirming = false;
    super.open();
  }

  render() {
    const you = this.you();
    const b = this.box;
    b.innerHTML = "";
    b.dataset.e2e = "tree-panel";
    const view = treeView({ starter: this.game.hud.starterIndex, level: you?.level ?? 1, tree: you?.tree?.nodes, coins: you?.coins ?? 0, safe: this.safe() });
    const head = el("div", "head", b);
    el("h2", "", head, "Build");
    const pts = el("div", `fl-tree__pts${view.points > 0 ? " is-ready" : ""}`, head, `${view.points} point${view.points === 1 ? "" : "s"} to spend`);
    pts.dataset.e2e = "tree-points";
    el("p", "sub", b, `Level ${view.level}. Every level gives a point; spend them in any branch, top-down. Deeper nodes cost more. Points are lost with the level when you die.`);
    const grid = el("div", "body fl-tree__grid", b);
    for (const br of view.branches) {
      const col = el("section", "fl-tree__branch", grid);
      col.dataset.branch = br.id;
      const h = el("header", "", col);
      el("b", "", h, br.name);
      el("span", "", h, br.spent ? `${br.spent} pt` : "");
      el("p", "fl-tree__blurb", col, br.blurb);
      for (const n of br.nodes) {
        const btn = el("button", `fl-tree__node is-${n.state}`, col);
        btn.type = "button";
        btn.dataset.e2e = `tree-node-${n.id}`;
        btn.disabled = n.state === "locked";
        btn.setAttribute("aria-pressed", String(n.state === "taken"));
        const top = el("span", "fl-tree__top", btn);
        el("b", "", top, n.name);
        el("span", "fl-tree__cost", top, `${n.cost}`);
        el("span", "fl-tree__line", btn, n.line);
        el("span", "fl-tree__what", btn, n.blurb);
        el("span", "fl-tree__tag", btn, n.state === "open" ? `Take · ${n.cost} pt` : n.why || STATE_TAG[n.state]);
        if (n.state === "open") btn.onclick = () => this.game.net.room?.send("tree", { action: "spend", node: n.id });
      }
    }
    const foot = el("div", "foot", b);
    const r = view.respec;
    const respec = el("button", `btn ghost${this.confirming ? " is-confirm" : ""}`, foot, this.confirming ? `Press again: respec for ${r.cost} ◎` : r.cost ? `Respec · ${r.cost} ◎` : "Respec");
    respec.dataset.e2e = "tree-respec";
    respec.disabled = !r.can;
    respec.title = r.can ? "Take every point back, in a safe zone, for coins" : r.why;
    respec.onclick = () => {
      if (!this.confirming) {
        this.confirming = true;
        this.render();
        return;
      }
      this.confirming = false;
      this.game.net.room?.send("tree", { action: "respec" });
    };
    el("span", "", foot, r.can || !r.cost ? `${HOTKEYS.build.caps.join(" ")} or Esc to close` : `${r.why} · ${HOTKEYS.build.caps.join(" ")} or Esc to close`);
    el("button", "btn ghost", foot, "Close").onclick = () => this.close();
  }
}
