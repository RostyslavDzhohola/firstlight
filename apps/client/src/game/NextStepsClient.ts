// Shows the "what next" hints (nextSteps.ts, D-polish-ux-3) as toasts: a few seconds after arriving
// (the arrival card first), never while the tutorial's card is up, one at a time, each once per device.

import type { Game } from "./Game.ts";
import { markHintSeen, nextHints, seenHints } from "./nextSteps.ts";
import type { ClientSystem } from "./systems.ts";

const FIRST_AFTER_S = 6;
const GAP_S = 10;
const HINT_MS = 9000;

class NextStepsClient implements ClientSystem {
  private t = 0;
  private nextAt = FIRST_AFTER_S;

  constructor(private readonly game: Game) {}

  update(dt: number) {
    this.t += dt;
    if (this.t < this.nextAt) return;
    this.nextAt = this.t + 1; // check once a second
    const g = this.game;
    const you = g.hud.you;
    if (!you || g.combat.deadUntilRespawn || g.photo?.active || document.querySelector(".fl-onb")) return;
    const hint = nextHints({ body: g.bodyId, missions: you.missions ?? [], seen: seenHints() })[0];
    if (!hint) return;
    markHintSeen(hint.id);
    g.hud.toast(hint.text, "info", { title: hint.title, ms: HINT_MS }).dataset.e2e = `next-${hint.id}`;
    this.nextAt = this.t + GAP_S;
  }

  dispose() {}
}

export function createNextSteps(game: Game): ClientSystem | null {
  return game.net.room ? new NextStepsClient(game) : null;
}
