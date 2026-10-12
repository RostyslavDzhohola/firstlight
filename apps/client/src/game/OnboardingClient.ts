// Onboarding on Portus (SPEC §6.12; server: apps/server/src/world/onboarding.ts). Draws the three
// training dummies, and when the server lists `you.onboarding` runs the tutorial HUD. Attacks near
// the dummies go to the server as `train` messages; it counts the hits and pays the XP and the Spark
// medal. Every other step (movement, then weapons, pick-up, map, phrase wheel, optional voice and
// the walk to a portal) is checked here from the local player and pays nothing; the HUD stays up
// after the payout until those are done or skipped. Skip: the HUD button (mouse free) or Esc → Skip
// tutorial.

import * as THREE from "three/webgpu";
import { BODIES, portalNear, portalSpots, type PortalSpot } from "@firstlight/shared";
import { ONBOARDING } from "@firstlight/shared/content/onboarding";
import { WEAPONS, type TierStats, type WeaponDef } from "@firstlight/shared/content/weapons";
import { config, flags } from "../config.ts";
import { weaponColor } from "../render/effects.ts";
import { pauseExtras, type PauseExtra } from "../ui/menu.ts";
import { OnboardingHud } from "../ui/onboarding.ts";
import { Panel } from "../ui/panels.ts";
import { voice } from "../voice/index.ts";
import { TrainingDummies } from "../world/TrainingDummies.ts";
import type { Game } from "./Game.ts";
import { OnboardingSteps } from "./onboardingSteps.ts";
import type { ClientSystem } from "./systems.ts";

const DONE_CARD_MS = 8000;
const NO_KEYS: ReadonlySet<string> = new Set();
/** Frames that move further than this are teleports or corrections, not walking. */
const MAX_STEP_M = 3;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

export class OnboardingClient implements ClientSystem {
  private readonly game: Game;
  readonly dummies: TrainingDummies;
  private hud: OnboardingHud | null = null;
  private readonly steps = new OnboardingSteps();
  private active = false;
  /** Skipped or finished in this session: never restart from a stale `you`. */
  private ended = false;
  private doneUntil = 0;
  /** The server paid the dummies (and the completion): the rest is client-side tips. */
  private paid = false;
  private xpPaid = 0;
  /** We said a phrase since the last frame (the phrase-wheel step). */
  private phrased = false;
  private readonly portals: PortalSpot[];
  private readonly lastPos = new THREE.Vector3();
  private hasLast = false;
  private lastTrainAt = 0;
  private readonly pauseRow = (): PauseExtra | null =>
    this.active
      ? { icon: "arrow-r", title: "Skip tutorial", sub: this.paid ? "Hide the rest of the tips." : "No more XP and no Spark medal. It won't come back.", onClick: () => this.skip() }
      : null;

  constructor(game: Game) {
    this.game = game;
    this.dummies = new TrainingDummies(game.ctx.scene, game.planet.terrain);
    this.portals = portalSpots(BODIES[ONBOARDING.BODY], game.planet.terrain);
    const room = game.net.room!;
    room.onMessage("train", (m: { dummy: number; hits: number; down: boolean }) => this.onTrain(m));
    room.onMessage("onboarding", (m: { state: "done" | "skipped"; xp: number }) => this.onEnd(m));
    room.onMessage("phrase", (m: { by: string }) => {
      if (m.by === room.sessionId) this.phrased = true;
    });
    game.combat.training = (def, tier, now) => this.attack(def, tier, now);
    pauseExtras.add(this.pauseRow);
  }

  private start() {
    this.active = true;
    const g = this.game;
    const layer = g.hud.root.querySelector<HTMLElement>(".fl-hud__layer") ?? g.hud.root;
    this.hud = new OnboardingHud(layer, () => this.skip(), config.publicRepo ? config.repoUrl : null);
  }

  private skip() {
    if (!this.active) return;
    if (!this.paid) this.game.net.room?.send("onboarding", { action: "skip" });
    this.finish();
  }

  private finish() {
    this.active = false;
    this.ended = true;
    this.hasLast = false;
    if (!this.doneUntil) this.closeHud();
  }

  /** Hide the HUD and stand the dummies back up for the next newcomer. */
  private closeHud() {
    this.hud?.dispose();
    this.hud = null;
    this.doneUntil = 0;
    for (let i = 0; i < this.dummies.dummies.length; i++) this.dummies.setDown(i, false);
  }

  private onTrain(m: { dummy: number; hits: number; down: boolean }) {
    const g = this.game;
    this.dummies.hit(m.dummy);
    g.hud.hit(false);
    g.audio.play("hitmark");
    if (m.down && m.hits === ONBOARDING.HITS_PER_DUMMY) {
      this.dummies.setDown(m.dummy, true);
      g.burst(this.dummies.chest(m.dummy, _a), 0x7ad8ff, 48);
    }
  }

  /** Server: rewards paid (the tutorial goes on with tips) or skipped (it ends here). */
  private onEnd(m: { state: "done" | "skipped"; xp: number }) {
    if (m.state === "done") {
      this.paid = true;
      this.xpPaid = m.xp;
      for (let i = 0; i < this.dummies.dummies.length; i++) this.dummies.setDown(i, true);
      if (!this.active) this.finish();
      return;
    }
    this.game.hud.toast("Tutorial skipped. Controls are under How to play in the Esc menu.", "info");
    this.finish();
  }

  /** CombatClient hook: an attack inside the safe zone. True when the dummies took it. */
  attack(def: WeaponDef, tier: TierStats, now: number): boolean {
    if (!this.active || this.paid) return false; // after the payout the server takes no more training hits
    if (def.delivery === "heal" || def.delivery === "bubble" || def.delivery === "none") return false;
    const g = this.game;
    const me = g.player.pos;
    if (!this.dummies.dummies.some((d) => d.pos.distanceTo(me) < ONBOARDING.NEAR_M)) return false;
    const semi = def.delivery !== "hitscan" || def.id === "stillshot";
    if (semi && !g.input.lmbPressed) return true;
    if (now - this.lastTrainAt < tier.rate * 1000) return true;
    this.lastTrainAt = now;
    const cam = g.ctx.camera;
    const o = cam.getWorldPosition(new THREE.Vector3());
    const d = cam.getWorldDirection(new THREE.Vector3());
    g.net.room?.send("train", { ox: o.x, oy: o.y, oz: o.z, dx: d.x, dy: d.y, dz: d.z });
    // The same local feedback as a real attack (the server's `train` reply adds the hit marker).
    const color = weaponColor(WEAPONS.indexOf(def));
    g.self?.trigger("attack");
    if (def.delivery === "melee") {
      g.audio.play("swing");
      g.combat.effects.arc(me, g.player.facing, g.player.up(), def.range, color);
      return true;
    }
    const muzzle = me.clone().addScaledVector(g.player.up(), 1.35).addScaledVector(g.player.facing, 0.5);
    const to = o.clone().addScaledVector(d, this.rayLength(o, d, Math.min(def.falloffTo ?? def.range, 60)));
    g.combat.effects.tracer(muzzle, to, color, def.delivery === "chain" ? 1.6 : 1);
    g.combat.effects.flash(muzzle, color, 0.3);
    g.audio.play(g.audio.weaponSound(WEAPONS.indexOf(def)));
    return true;
  }

  /** Where a training shot visibly ends: the first dummy it passes close to, else its range. */
  private rayLength(o: THREE.Vector3, d: THREE.Vector3, max: number): number {
    let best = max;
    for (let i = 0; i < this.dummies.dummies.length; i++) {
      const c = this.dummies.chest(i, _b);
      const t = c.clone().sub(o).dot(d);
      if (t <= 0 || t >= best) continue;
      if (o.clone().addScaledVector(d, t).distanceTo(c) <= ONBOARDING.DUMMY_RADIUS + 0.4) best = t;
    }
    return best;
  }

  update(dt: number, now: number) {
    this.dummies.update(dt);
    const g = this.game;
    if (this.hud && this.doneUntil && now > this.doneUntil) this.closeHud();
    const ob = g.hud.you?.onboarding;
    if (ob && !this.active && !this.ended && !flags.has("autoplay")) this.start();
    else if (!ob && this.active && !this.paid) this.finish(); // ended on the server without a payout
    if (!this.active || !this.hud) return;

    if (ob) ob.hits.forEach((h, i) => this.dummies.setDown(i, h >= ONBOARDING.HITS_PER_DUMMY));
    const down = this.paid ? this.dummies.dummies.length : (ob?.hits.filter((h) => h >= ONBOARDING.HITS_PER_DUMMY).length ?? 0);
    const p = g.player.pos;
    let moved = this.hasLast ? p.distanceTo(this.lastPos) : 0;
    if (moved > MAX_STEP_M) moved = 0;
    this.lastPos.copy(p);
    this.hasLast = true;
    const playing = g.input.locked && !g.photo?.active && !Panel.current;
    const look = playing ? (Math.abs(g.input.mouseDX) + Math.abs(g.input.mouseDY)) * g.input.sensitivity : 0;
    const completed = this.steps.observe({
      dt,
      moved: playing ? moved : 0,
      lookRad: look,
      anim: g.player.anim,
      dummiesDown: down,
      // Keys as the game saw them this frame (M and E open panels at once, so no panel check here).
      pressed: g.photo?.active ? NO_KEYS : g.input.pressed,
      phrased: this.phrased,
      voiceOn: !!voice()?.optedIn,
      atPortal: !!portalNear(this.portals, p.x, p.y, p.z),
    });
    this.phrased = false;
    if (completed.length && completed[0] !== "attack") g.audio.play("ui");
    if (this.steps.allDone) {
      this.hud.showDone(this.xpPaid || ONBOARDING.DONE_XP + down * ONBOARDING.DUMMY_XP);
      this.doneUntil = now + DONE_CARD_MS;
      this.finish();
      return;
    }
    this.hud.render(this.steps, this.paid);

    // Point at the dummies, then at the Arcadia portal, while that's the step on the card.
    const step = this.steps.current?.id;
    let at: THREE.Vector3 | null = null;
    let title = "";
    let sub = "";
    if (step === "attack") {
      at = this.dummies.chest(1, _a).addScaledVector(_b.copy(_a).normalize(), 0.9);
      title = `Training dummies · ${down} / 3 down`;
      sub = "10 XP each. Three hits knock one down.";
    } else if (step === "portal") {
      const spot = this.portals.find((x) => x.to === "arcadia");
      if (spot) at = _a.set(spot.center[0], spot.center[1], spot.center[2]);
      title = "Arcadia";
      sub = "Levels 1–7 · walk in";
    }
    if (at && at.distanceTo(p) < 80) {
      const sp = at.project(g.ctx.camera);
      if (sp.z < 1 && Math.abs(sp.x) < 0.95 && Math.abs(sp.y) < 0.95) {
        this.hud.setCallout((sp.x * 0.5 + 0.5) * innerWidth, (-sp.y * 0.5 + 0.5) * innerHeight, title, sub);
        return;
      }
    }
    this.hud.setCallout(null);
  }

  dispose() {
    pauseExtras.delete(this.pauseRow);
    if (this.game.combat.training) this.game.combat.training = null;
    this.hud?.dispose();
    this.hud = null;
    this.dummies.dispose();
  }
}

export function createOnboardingClient(game: Game): ClientSystem | null {
  return game.net.room && game.bodyId === ONBOARDING.BODY ? new OnboardingClient(game) : null;
}
