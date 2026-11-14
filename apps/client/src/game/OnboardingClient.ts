// Onboarding on Portus (SPEC §6.12; server: apps/server/src/world/onboarding.ts). Draws the three
// training dummies, and when the server lists `you.onboarding` runs the tutorial HUD. The attack
// lesson is one left click (#68): the swing goes to the server as a `train` message, which knocks down
// a dummy in reach and pays the tutorial's XP and the Spark medal. Every other step (movement, then
// weapons, pick-up, map, phrase wheel, optional voice) is checked here from the local player and pays
// nothing. It ends in the plaza: the end card's arrow and the compass point at the Arcadia portal
// until the player leaves Portus. Skip: the HUD button (mouse free) or Esc → Skip tutorial.

import * as THREE from "three/webgpu";
import { BODIES, portalSpots, type PortalSpot } from "@firstlight/shared";
import { ONBOARDING } from "@firstlight/shared/content/onboarding";
import { GUIDES } from "@firstlight/shared/content/missions";
import type { YouState } from "@firstlight/shared/net/protocol";
import { WEAPONS, type TierStats, type WeaponDef } from "@firstlight/shared/content/weapons";
import { config, flags } from "../config.ts";
import { weaponColor } from "../render/effects.ts";
import { pauseExtras, type PauseExtra } from "../ui/menu.ts";
import { OnboardingHud } from "../ui/onboarding.ts";
import { Panel } from "../ui/panels.ts";
import { MapPanel } from "../ui/map.ts";
import { compassGuides, type CompassMarker } from "../social/compass.ts";
import { bearingTo, type V3 } from "../social/compassMath.ts";
import { saveReady, skipTutorialSub } from "../ui/saveOffer.ts";
import { voice } from "../voice/index.ts";
import { TrainingDummies } from "../world/TrainingDummies.ts";
import { DoneCardTimer } from "./doneCardTimer.ts";
import type { Game } from "./Game.ts";
import { OnboardingProgress } from "./onboardingProgress.ts";
import { dummyTargets, guideTargets, nextDummy, type GuideTarget } from "./onboardingTargets.ts";
import { STEPS, type StepId } from "./onboardingSteps.ts";
import { funnelStep } from "../net/beacon.ts";
import type { ClientSystem } from "./systems.ts";

/** Time the end card stays up, counted only while the game is on screen and playable (doneCardTimer.ts). */
const DONE_CARD_MS = 15000; // long enough to read where to go next (#68); the compass keeps pointing after
/** How often the card's time is checked after this system is gone (the portal travel). */
const LINGER_POLL_MS = 100;
const NO_KEYS: ReadonlySet<string> = new Set();
/** Frames that move further than this are teleports or corrections, not walking. */
const MAX_STEP_M = 3;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

export class OnboardingClient implements ClientSystem {
  private readonly game: Game;
  readonly dummies: TrainingDummies;
  private hud: OnboardingHud | null = null;
  private readonly progress: OnboardingProgress;
  /** Undefined until this room's own state arrives, so old body HUD state cannot erase saved tips. */
  private onboarding: YouState["onboarding"];
  private receivedYou = false;
  private active = false;
  /** Skipped or finished in this session: never restart from a stale `you`. */
  private ended = false;
  /** The end card's countdown: it waits behind loading screens and menus. */
  private readonly doneTimer: DoneCardTimer;
  /** The server paid the dummies (and the completion): the rest is client-side tips. */
  private paid = false;
  private xpPaid = 0;
  /** We said a phrase since the last frame (the phrase-wheel step). */
  private phrased = false;
  private readonly portals: PortalSpot[];
  private readonly lastPos = new THREE.Vector3();
  private hasLast = false;
  private lastTrainAt = -Infinity;
  /** Where the card's arrow and the compass point now (the nearest dummy, or the Arcadia portal after the end). */
  private way: { label: string; at: V3 } | null = null;
  /** The Arcadia portal's centre: where the tutorial sends you next. */
  private readonly next: V3 | null;
  /** CombatClient hook: the tutorial's tips or its last card are up (the "Progress not saved" toast waits). */
  private readonly busy = () => this.active || !!this.hud;
  /** The card's current step (updated every frame while the tutorial runs). */
  private step: StepId | undefined = undefined;
  private readonly onDummyStep = () => this.active && this.step === "attack";
  /** Map and minimap: the dummies still standing during the attack step (#31), then the Arcadia portal. */
  private readonly targets = (): GuideTarget[] => {
    if (this.active) return dummyTargets(this.step, this.dummies.dummies.map((d) => d.down));
    if (!this.ended || !this.next) return [];
    const l = Math.hypot(this.next[0], this.next[1], this.next[2]) || 1;
    return [{ id: "next:arcadia", dir: [this.next[0] / l, this.next[1] / l, this.next[2] / l], label: "Arcadia portal" }];
  };
  /** The compass carries the card's way (#68, #70). */
  private readonly compassGuide = (): CompassMarker[] => (this.way ? [{ key: "tutorial", label: this.way.label, colour: "var(--photon)", pos: this.way.at, kind: "guide" }] : []);
  /** The world is on screen and the player can act: no loading screen, pause menu, panel, photo mode or hidden tab. */
  private readonly playable = () => {
    const g = this.game;
    return g.input.inPlay && !g.photo?.active && !Panel.current && !(typeof document !== "undefined" && document.hidden);
  };
  private readonly pauseRow = (): PauseExtra | null =>
    this.active
      ? {
          icon: "arrow-r",
          title: "Skip tutorial",
          sub: skipTutorialSub({ paid: this.paid, saveReady: this.saveReady() }),
          confirm: this.paid ? undefined : "Click again to skip the tutorial.",
          onClick: () => this.skip(),
        }
      : null;

  constructor(game: Game) {
    this.game = game;
    this.doneTimer = new DoneCardTimer({ durationMs: DONE_CARD_MS, now: () => performance.now(), visible: this.playable });
    this.dummies = new TrainingDummies(game.ctx.scene, game.planet.terrain);
    this.portals = portalSpots(BODIES[ONBOARDING.BODY], game.planet.terrain);
    const arcadia = this.portals.find((x) => x.to === "arcadia");
    this.next = arcadia ? [arcadia.center[0], arcadia.center[1], arcadia.center[2]] : null;
    const room = game.net.room!;
    // Game.enterBody waits for our schema player before creating the body systems.
    const userId = (room.state as any).players?.get(room.sessionId)?.userId ?? "";
    this.progress = new OnboardingProgress(userId);
    // CombatClient.attach clears the old room state before Game waits for our schema player.
    // The first message often arrives during that wait, before this system has a listener.
    this.receivedYou = game.hud.you !== null;
    this.onboarding = game.hud.you?.onboarding;
    if (this.receivedYou && !this.onboarding) this.progress.end();
    room.onMessage("you", (m: YouState) => {
      this.receivedYou = true;
      this.onboarding = m.onboarding;
      if (!m.onboarding) this.progress.end();
    });
    room.onMessage("train", (m: { dummy: number; hits: number; down: boolean }) => this.onTrain(m));
    room.onMessage("onboarding", (m: { state: "done" | "skipped"; xp: number }) => this.onEnd(m));
    room.onMessage("phrase", (m: { by: string }) => {
      if (m.by === room.sessionId) this.phrased = true;
    });
    game.combat.training = (def, tier, now) => this.attack(def, tier, now);
    // Level 2 is paid on the dummies: the "Progress not saved" toast waits until the HUD is gone.
    game.combat.tutorialBusy = this.busy;
    game.combat.dummyStep = this.onDummyStep;
    guideTargets.current = this.targets;
    compassGuides.add(this.compassGuide);
    pauseExtras.add(this.pauseRow);
  }

  private start() {
    this.active = true;
    const g = this.game;
    const layer = g.hud.root.querySelector<HTMLElement>(".fl-hud__layer") ?? g.hud.root;
    this.hud = new OnboardingHud(layer, () => this.skip(), config.publicRepo ? config.repoUrl : null, {
      expanded: this.progress.expanded, onExpanded: (expanded) => this.progress.setExpanded(expanded),
    });
  }

  /** Saving is unlocked (D34: level 2, the best this session counts after a rebirth). */
  private saveReady(): boolean {
    return saveReady(Math.max(this.game.hud.you?.level ?? 1, this.game.combat?.saveNudge?.best ?? 0));
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
    if (!this.doneTimer.running) this.closeHud();
  }

  /** Hide the HUD and stand the dummies back up for the next newcomer. */
  private closeHud() {
    this.hud?.dispose();
    this.hud = null;
    this.doneTimer.stop();
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
    this.progress.end();
    if (m.state === "done") {
      this.paid = true;
      this.xpPaid = m.xp;
      if (!this.active) this.finish();
      return;
    }
    this.game.hud.toast("Tutorial skipped. Controls are under How to play in the Esc menu.", "info");
    this.finish();
  }

  /** Send the attack lesson's swing along the camera ray (the server judges what it reaches). */
  private sendTrain(now: number) {
    this.lastTrainAt = now;
    const cam = this.game.ctx.camera;
    const o = cam.getWorldPosition(_a);
    const d = cam.getWorldDirection(_b);
    this.game.net.room?.send("train", { ox: o.x, oy: o.y, oz: o.z, dx: d.x, dy: d.y, dz: d.z });
  }

  /** CombatClient hook: an attack inside the safe zone (anywhere in town, #68). True when training took it. */
  attack(def: WeaponDef, tier: TierStats, now: number): boolean {
    if (!this.active || this.paid) return false; // after the payout the server takes no more training hits
    if (def.delivery === "heal" || def.delivery === "bubble" || def.delivery === "none") return false;
    const g = this.game;
    const me = g.player.pos;
    const semi = def.delivery !== "hitscan" || def.id === "stillshot";
    if (semi && !g.input.lmbPressed) return true;
    if (now - this.lastTrainAt < tier.rate * 1000) return true;
    this.sendTrain(now);
    const cam = g.ctx.camera;
    const o = cam.getWorldPosition(new THREE.Vector3());
    const d = cam.getWorldDirection(new THREE.Vector3());
    // The same local feedback as a real attack (the server's `train` reply adds the hit marker).
    const color = weaponColor(WEAPONS.indexOf(def));
    g.self?.trigger("attack");
    if (def.delivery === "melee") {
      g.audio.play(g.audio.swingSound(WEAPONS.indexOf(def)));
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

  /** Where a training shot visibly ends: the first standing dummy it passes close to (like the server), else its range. */
  private rayLength(o: THREE.Vector3, d: THREE.Vector3, max: number): number {
    let best = max;
    for (let i = 0; i < this.dummies.dummies.length; i++) {
      if (this.dummies.dummies[i]!.down) continue; // knocked down: the server lets shots pass over it
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
    if (this.hud && this.doneTimer.running && this.doneTimer.tick()) this.closeHud();
    this.pointTheWay();
    if (!this.receivedYou) return;
    const steps = this.progress.steps;
    const ob = this.onboarding;
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
    const playing = g.input.inPlay && !g.photo?.active && !Panel.current;
    if (playing && g.input.pressed.has("KeyT")) this.hud.toggleChecklist();
    // The attack lesson takes any left click (#68). In town CombatClient hands swings to `attack`; out
    // of town, or with a support item in hand, the click still goes to the server as the lesson's swing.
    if (playing && !this.paid && this.step === "attack" && g.input.lmbPressed && now - this.lastTrainAt > 250) this.sendTrain(now);
    const look = playing ? (Math.abs(g.input.mouseDX) + Math.abs(g.input.mouseDY)) * g.input.sensitivity + Math.abs(g.input.lookYaw) + Math.abs(g.input.lookPitch) : 0;
    const completed = steps.observe({
      dt,
      moved: playing ? moved : 0,
      lookRad: look,
      anim: g.player.anim,
      trained: this.paid,
      // Keys as the game saw them this frame (E opens a panel at once, so no panel check here).
      pressed: g.photo?.active ? NO_KEYS : g.input.pressed,
      mapOpen: Panel.current instanceof MapPanel,
      phrased: this.phrased,
      voiceOn: !!voice()?.optedIn,
      inPortal: false, // no portal step since #68
    });
    if (completed.length) this.progress.save();
    // The funnel (#85): each step the first time this browser does it, with its place in this build's tutorial.
    for (const id of completed) funnelStep(`tutorial:${id}`, STEPS.findIndex((s) => s.id === id));
    this.phrased = false;
    if (completed.length) g.audio.play("ui");
    if (steps.allDone) {
      funnelStep("tutorial_done");
      this.hud.showDone(this.xpPaid || ONBOARDING.DONE_XP + down * ONBOARDING.DUMMY_XP);
      this.doneTimer.start();
      this.finish();
      this.pointTheWay();
      return;
    }
    this.hud.render(steps, this.paid);
    this.step = steps.current?.id;
  }

  /**
   * The way (#68): during the attack lesson, the nearest standing dummy when one is near enough to
   * walk to (a swing anywhere counts, so it's a suggestion); once the tutorial is over, the Arcadia
   * portal, until the player leaves Portus. One target, shown as the card's arrow and on the compass.
   */
  private pointTheWay() {
    const g = this.game;
    const p = g.player.pos;
    let way: { label: string; at: V3 } | null = null;
    if (this.active && this.step === "attack" && !this.paid) {
      const next = nextDummy(this.dummies.dummies.map((d) => d.down), [p.x, p.y, p.z]);
      const at = next === null ? null : this.dummies.chest(next, _a);
      if (at && at.distanceTo(p) < ONBOARDING.NEAR_M) way = { label: "Training dummy", at: [at.x, at.y, at.z] };
    } else if (this.ended && this.next) way = { label: "Arcadia portal", at: this.next };
    this.way = way;
    if (!this.hud) return;
    if (!way) return this.hud.setWay(null);
    const f = g.player.camForward;
    const me: V3 = [p.x, p.y, p.z];
    this.hud.setWay({ label: way.label, deg: bearingTo(me, [f.x, f.y, f.z], way.at), metres: Math.hypot(way.at[0] - p.x, way.at[1] - p.y, way.at[2] - p.z) });
  }

  dispose() {
    compassGuides.delete(this.compassGuide);
    this.progress.save();
    pauseExtras.delete(this.pauseRow);
    if (this.game.combat.training) this.game.combat.training = null;
    this.dummies.dispose();
    // Left through the portal (the last step): the "Tutorial complete" card stays up over the travel,
    // and the "Progress not saved" toast keeps waiting for it. Its time only runs once the new world
    // is on screen (the loading screen is gone and the player can act), so it is not used up behind it.
    const hud = this.hud;
    if (hud && this.doneTimer.running) {
      const timer = this.doneTimer;
      let told = false;
      const poll = setInterval(() => {
        const body = this.game.bodyId;
        if (!told && body !== ONBOARDING.BODY && body in GUIDES && this.playable()) {
          told = true;
          hud.arrived(BODIES[body].name, GUIDES[body as keyof typeof GUIDES].name);
        }
        if (!timer.tick()) return;
        clearInterval(poll);
        hud.dispose();
        if (this.hud === hud) this.hud = null;
      }, LINGER_POLL_MS);
      return;
    }
    if (this.game.combat.tutorialBusy === this.busy) this.game.combat.tutorialBusy = null;
    if (this.game.combat.dummyStep === this.onDummyStep) this.game.combat.dummyStep = null;
    if (guideTargets.current === this.targets) guideTargets.current = () => [];
    hud?.dispose();
    this.hud = null;
  }
}

export function createOnboardingClient(game: Game): ClientSystem | null {
  return game.net.room && game.bodyId === ONBOARDING.BODY ? new OnboardingClient(game) : null;
}
