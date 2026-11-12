// Race / defend / collect attempts on the client (2026-11-12): the world markers (rings, beacon,
// shards; world/TrialMarkers.ts), a HUD strip with the trial's progress and clock under the top
// bar (trialState.ts formats it from the server's `trial` messages) and the sounds of each step:
// a ring passed or a shard taken, the clock starting, the finish, a failure.

import "../ui/trial.css";
import { objectPos, objectsOn } from "@firstlight/shared/content/world";
import { el } from "../ui/dom.ts";
import { TrialMarkers } from "../world/TrialMarkers.ts";
import type { Game } from "./Game.ts";
import type { ClientSystem } from "./systems.ts";
import { onTrial, trialHud, trialNow, trialSeen, type TrialSeen } from "./trialState.ts";

class TrialClient implements ClientSystem {
  private readonly game: Game;
  private readonly markers: TrialMarkers;
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly off: () => void;
  private last = "";
  private prev: TrialSeen | null = null;
  /** Walk-in objective spots on this body (rings, shards, kite panels), for the e2e hook's snapshot. */
  readonly trialSpots = new Map<string, { pos: [number, number, number] }>();

  constructor(game: Game) {
    this.game = game;
    this.markers = new TrialMarkers(game.ctx.scene, game.bodyId, game.planet.terrain);
    const terrain = game.planet.terrain;
    for (const o of objectsOn(game.bodyId)) if (o.look === "ring" || o.look === "shard") this.trialSpots.set(o.id, { pos: objectPos(o, (x, y, z) => terrain.groundHeight(x, y, z)) });
    const top = game.hud.root.querySelector<HTMLElement>(".fl-hud__top") ?? game.hud.root;
    this.root = el("section", "fl-trial fl-holo fl-corners", top);
    this.root.dataset.e2e = "trial-hud";
    this.root.hidden = true;
    const text = el("div", "fl-trial__text", this.root);
    this.title = el("span", "fl-trial__title", text);
    this.progress = el("span", "fl-trial__progress", text);
    this.clock = el("span", "fl-trial__clock", this.root);
    this.prev = trialSeen();
    this.off = onTrial((t) => this.onStep(t));
  }

  private onStep(t: TrialSeen) {
    const a = this.game.audio;
    const p = this.prev?.msg;
    const m = t.msg;
    this.prev = t;
    if (m.state === "done") {
      a.play("levelUp");
      a.play("coins", null, 0.8, 1.25);
    } else if (m.state === "failed") a.play("denied");
    else if (m.state === "paused") a.play("denied", null, 0.6, 1.3);
    else if (m.state === "running" && (!p || p.id !== m.id || p.state !== "running")) a.play("portal", null, 0.5, 1.4); // the clock starts
    else if (m.state === "running" && p && m.progress > p.progress) a.play("coins", null, 0.7, 1 + Math.min(0.6, m.progress / Math.max(1, m.goal) * 0.6)); // rising chime per ring / shard
  }

  update(dt: number) {
    const g = this.game;
    const now = trialNow(); // the server clock the attempt's deadline is on
    const seen = trialSeen();
    this.markers.update(dt, { missions: g.hud.you?.missions ?? [], trial: seen?.msg ?? null });
    const line = seen && seen.msg.id && g.bodyId !== "portus" ? trialHud(seen, now) : null;
    const key = line ? `${line.title}|${line.progress}|${line.clock}|${line.tone}` : "";
    if (key === this.last) return;
    this.last = key;
    this.root.hidden = !line;
    if (!line) return;
    this.title.textContent = line.title;
    this.progress.textContent = line.progress;
    this.clock.textContent = line.clock;
    this.root.className = `fl-trial fl-holo fl-corners is-${line.tone}`;
  }

  dispose() {
    this.off();
    this.markers.dispose();
    this.root.remove();
  }
}

/** Every body with a room (Portus has no trial sites; its markers stay empty). */
export function createTrialClient(game: Game): ClientSystem | null {
  return game.net.room ? new TrialClient(game) : null;
}
