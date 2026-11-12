// The HUD's moments, fed from the room (D-ui-2…5): the arrival title card when a world appears, the
// earned banners (level-up and the spell it unlocks, mission complete, trial won, gleam, vault,
// medal) with their sounds, the event feed (who arrived and left, who fell, what we felled, news of
// the hunt), the "hit from" ring, the kill mark and hit-stop, and the one-time spell hint. The views
// and their queue live on the HUD (ui/momentsView.ts) and outlast a change of world; this system is
// created per body and only listens and ticks.

import * as THREE from "three/webgpu";
import { MISSION_BY_ID } from "@firstlight/shared/content/missions";
import { NPC_DEFS } from "@firstlight/shared/content/npcs";
import { SPELLS } from "@firstlight/shared/content/spells";
import type { YouState } from "@firstlight/shared/net/protocol";
import { PF } from "@firstlight/shared/net/schema";
import { ArrivalGate, arrivalCard } from "../ui/arrivalCard.ts";
import { feedKiller, feedText, KillTally, Roster, type FeedWho } from "../ui/eventFeed.ts";
import { hitAngle } from "../ui/hitFrom.ts";
import { levelMoments, medalMoment, missionMoments, MOMENT_SOUNDS, type Moment } from "../ui/moments.ts";
import type { Game } from "./Game.ts";
import { hitWeight } from "./hitStop.ts";
import { SpellClient } from "./SpellClient.ts";
import { SpellHint } from "./spellHint.ts";
import type { ClientSystem } from "./systems.ts";

/** One gate and one hint per page: a reconnect into the same world shows no second card. */
const arrivals = new ArrivalGate();
const spellHint = new SpellHint();

const ROSTER_MS = 500;
/** More arrivals than this in one look (a party walking through a portal) become one line. */
const ROSTER_BURST = 3;

const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _up = new THREE.Vector3();

interface PlayerLike {
  x: number;
  y: number;
  z: number;
  name: string;
  flags: number;
  hp?: number;
  maxHp?: number;
  /** The agents lane's flag (may be absent on this build's schema). */
  agent?: boolean;
}
interface NpcLike {
  x: number;
  y: number;
  z: number;
  maxHp?: number;
}
interface StateLike {
  players?: { get(id: string): PlayerLike | undefined };
  npcs?: { get(id: string): NpcLike | undefined };
}

const whoOf = (p: PlayerLike | undefined, fallback = "Someone"): FeedWho => ({ name: p?.name || fallback, agent: !!p?.agent });

export class MomentsClient implements ClientSystem {
  private readonly game: Game;
  private readonly offs: (() => void)[] = [];
  private arrivalDue: boolean;
  /** The level the banners have seen (null until this room's first `you`). */
  private level: number | null;
  private readonly roster = new Roster<FeedWho>();
  private readonly tally = new KillTally();
  private rosterAt = 0;
  private spells: SpellClient | null | undefined;
  private readonly onNpcKill = (e: Event) => this.npcKill((e as CustomEvent).detail);

  constructor(game: Game) {
    this.game = game;
    const m = game.hud.moments;
    m.setBody(game.hud.root, game.bodyId);
    this.arrivalDue = arrivals.arrive(game.bodyId);
    this.level = game.hud.you?.level ?? null;
    m.onShow = (shown) => this.shown(shown);
    const room = game.net.room;
    if (!room) return; // offline: the arrival card only
    const me = room.sessionId;
    const on = (type: string, cb: (msg: never) => void) => {
      const off = room.onMessage(type, cb as (msg: unknown) => void) as unknown;
      if (typeof off === "function") this.offs.push(off as () => void);
    };
    on("you", (y: YouState & { level: number; dead?: boolean }) => {
      const prev = this.level;
      this.level = y.level;
      if (prev !== null && y.level > prev) m.push(...levelMoments(prev, y.level));
      if (y.dead) m.clearBanners(); // the death screen has the floor
    });
    on("missionDone", (d: { id: string; xp: number; coins: number; items?: { id: string; qty: number }[] }) => {
      const you = game.hud.you;
      m.push(...missionMoments(d.id, d.xp, d.coins, you?.missions ?? [], { items: d.items, extras: !!you?.cosmeticsExtras }));
    });
    on("medal", (d: { id: string }) => m.push(medalMoment(d.id)));
    on("news", (n: { kind: "gleam" | "vault"; name: string; mission?: string }) => {
      const who: FeedWho = { name: n.name, agent: this.agentNamed(n.name) };
      const gleam = n.mission ? MISSION_BY_ID.get(n.mission)?.name : undefined;
      m.feed("hunt", n.kind === "vault" ? feedText.openedVault(who) : feedText.wonGleam(who, gleam ?? "a gleam"), performance.now());
    });
    on("death", (d: { victim: string; killer: string | null; killerName: string }) => {
      if (d.victim === me) return; // our own death has its screen
      const st = this.state();
      const victim = whoOf(st?.players?.get(d.victim));
      const killer = d.killer ? st?.players?.get(d.killer) : undefined;
      const mine = d.killer === me;
      const by = mine ? { name: "You", me: true } : killer ? whoOf(killer) : feedKiller(d.killerName);
      m.feed(mine ? "kill" : "death", feedText.fell(victim, by), performance.now());
      if (mine) {
        m.kill();
        game.hitStop.hit("kill", performance.now());
      }
    });
    on("hit", (h: { attacker: string; target: string; amount: number; weak: boolean }) => {
      if (h.attacker === me && h.target !== me) {
        const st = this.state();
        const max = st?.npcs?.get(h.target)?.maxHp ?? st?.players?.get(h.target)?.maxHp ?? 0;
        game.hitStop.hit(hitWeight(h.amount, h.weak, max), performance.now());
      } else if (h.target === me && h.attacker && h.attacker !== me) this.hitFrom(h.attacker);
    });
    on("spell", (s: { by: string }) => {
      if (s.by === me) spellHint.cast(); // they found the keys: no hint needed
    });
    window.addEventListener("fl:npcKill", this.onNpcKill);
  }

  private state(): StateLike | null {
    return (this.game.net.room?.state as StateLike | undefined) ?? null;
  }

  /** Whether a player by that display name in this room is an agent (news carries names only). */
  private agentNamed(name: string): boolean {
    const st = this.state();
    for (const id of this.game.net.remotes.keys()) {
      const p = st?.players?.get(id);
      if (p?.name === name) return !!p.agent;
    }
    return false;
  }

  /** A banner went up: its sound, and a record for the test hook (the toast it replaced used to be one). */
  private shown(m: Moment) {
    const a = this.game.audio;
    for (const cue of MOMENT_SOUNDS[m.kind]) {
      if (cue.at) window.setTimeout(() => a.play(cue.name, null, cue.gain ?? 1, cue.rate ?? 1), cue.at);
      else a.play(cue.name, null, cue.gain ?? 1, cue.rate ?? 1);
    }
    window.dispatchEvent(new CustomEvent("fl:moment", { detail: { kind: m.kind, text: `${m.kicker}: ${m.title} · ${m.reward}` } }));
  }

  private npcKill(d: { id?: string; kind?: number; xp?: number; coins?: number } | null) {
    if (!d || typeof d.kind !== "number") return;
    const def = NPC_DEFS[d.kind];
    if (!def) return;
    const boss = def.family === "boss";
    const m = this.game.hud.moments;
    const now = performance.now();
    m.kill(boss);
    this.game.hitStop.hit(boss ? "bossKill" : "kill", now);
    // Kills of the same creature in a row count up on one line (a Frostbloom through a pack).
    const t = this.tally.add(def.name, d.xp ?? 0, d.coins ?? 0, now);
    const parts = feedText.felled(def.name, t.xp, t.coins, t.count);
    if (!(t.again && this.tally.line !== null && m.feedUpdate(this.tally.line, parts, now))) this.tally.line = m.feed("kill", parts, now);
  }

  /** The wedge for a hit on us: the attacker's bearing round the player, in the camera's frame. */
  private hitFrom(attacker: string) {
    const st = this.state();
    const from = st?.players?.get(attacker) ?? st?.npcs?.get(attacker);
    if (!from) return;
    const g = this.game;
    const cam = g.ctx.camera;
    const p = g.player.pos;
    _up.copy(p).normalize();
    cam.getWorldDirection(_f);
    _f.addScaledVector(_up, -_f.dot(_up)); // flat on the ground under us
    if (_f.lengthSq() < 1e-6) return; // looking straight down: no bearing
    _f.normalize();
    _r.crossVectors(_f, _up).normalize();
    const angle = hitAngle(p, _f, _r, from);
    if (angle !== null) g.hud.moments.hitFrom(angle, performance.now());
  }

  private lookAtRoster(now: number) {
    const g = this.game;
    const room = g.net.room;
    const st = this.state();
    if (!room || !st?.players) return;
    const here = new Map<string, FeedWho>();
    for (const id of g.net.remotes.keys()) {
      const p = st.players.get(id);
      if (!p || !p.name || p.flags & PF.LOADTEST) continue; // load-test bots come and go by the hundred
      here.set(id, whoOf(p));
    }
    const { joined, left } = this.roster.diff(here, room.sessionId);
    const m = g.hud.moments;
    if (joined.length > ROSTER_BURST) m.feed("join", [`${joined.length} players arrived`], now);
    else for (const w of joined) m.feed("join", feedText.joined(w), now);
    if (left.length > ROSTER_BURST) m.feed("leave", [`${left.length} players left`], now);
    else for (const w of left) m.feed("leave", feedText.left(w), now);
  }

  /** The first spell tip: once, outside a safe zone, with Skipstep ready and nothing else asking for attention. */
  private maybeHint() {
    const g = this.game;
    if (spellHint.seen) return;
    const room = g.net.room;
    const mine = room ? this.state()?.players?.get(room.sessionId) : undefined;
    if (!room || !mine) return;
    if (this.spells === undefined) this.spells = (g.systems.find((s) => s instanceof SpellClient) as SpellClient | undefined) ?? null;
    const slot = this.spells?.book.view(Date.now() + g.net.serverOffset).slots[0];
    const due = spellHint.due({
      safe: (mine.flags & PF.SAFE) !== 0,
      ready: !!slot?.ready,
      playing: g.input.inPlay && !g.combat.deadUntilRespawn && !g.photo?.active,
      tutorial: !!g.combat.tutorialBusy?.(),
    });
    if (!due) return;
    const s = SPELLS[0]!;
    const t = g.hud.toast(`Press ${s.keycap} to ${s.name}`, "info", { title: "Spells", sub: `${s.blurb} Your spells are beside the hotbar.`, sprite: `spell-${s.id}`, ms: 10_000 });
    t.dataset.e2e = "spell-hint";
    g.audio.play("ui");
  }

  update(_dt: number, now: number) {
    const g = this.game;
    const m = g.hud.moments;
    if (this.arrivalDue) {
      // The first frame after the loading screen: the world is up and the avatar is rezzing in.
      this.arrivalDue = false;
      if (!g.bench) m.arrival(arrivalCard(g.bodyId));
    }
    // A menu (body.fl-paused) or photo mode hides every HUD root: the banners wait for it to come back.
    m.tick(now, !!g.photo?.active || document.body.classList.contains("fl-paused"));
    if (now >= this.rosterAt) {
      this.rosterAt = now + ROSTER_MS;
      this.lookAtRoster(now);
      this.maybeHint();
    }
  }

  dispose() {
    for (const off of this.offs) off();
    window.removeEventListener("fl:npcKill", this.onNpcKill);
    this.roster.reset();
  }
}

/** CLIENT_SYSTEMS entry. Offline too: the arrival card and the banner clock need no server. */
export function createMomentsClient(game: Game): ClientSystem {
  return new MomentsClient(game);
}
createMomentsClient.offline = true;
