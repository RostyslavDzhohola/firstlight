// The named characters talk (2026-11-13, voice lane): a guide, Sela or a shopkeeper greets you when
// you press E at them, says the offer when you accept one of their missions, sees you off when you
// close their panel, and now and then says something to themselves as you pass. Every line is an
// authored one (shared content/dialogue.ts), spoken from where they stand (audio/speech.ts).

import * as THREE from "three/webgpu";
import { CHARACTER_BY_OBJECT, CHARACTERS, dialogueFor, missionSpeaker, spokenId, type CharacterId } from "@firstlight/shared/content/dialogue";
import { GUIDES } from "@firstlight/shared/content/missions";
import { gleamsWon, selaLine } from "@firstlight/shared/content/gleams";
import { preload, say } from "../audio/speech.ts";
import type { Game } from "./Game.ts";

/** Idle remarks: how near you must be, and how often a character (and anyone at all) may make one. */
export const IDLE = { near: 12, minDist: 3.5, perCharacterS: 50, anyS: 18, firstS: 6 } as const;

const GUIDE_OF: Partial<Record<CharacterId, keyof typeof GUIDES>> = { lark: "arcadia", mabry: "hollowmere", rook: "meridian", odile: "lumen" };

/** The lines a character may greet you with: guides add GUIDES[].greeting; Sela says the line for your progress. */
export function greetingIds(who: CharacterId, progress: { won: number; opened: boolean }): string[] {
  if (who === "sela") return [spokenId.gleams(selaLine(progress.won, progress.opened))];
  const guide = GUIDE_OF[who];
  return [...(guide ? [spokenId.guideGreeting(guide)] : []), ...dialogueFor(who, "greet").map((l) => l.id)];
}

/** One of `ids`, never `last` again when there is a choice. */
export function pickLine(ids: readonly string[], last: string | undefined, rnd: () => number = Math.random): string | null {
  if (!ids.length) return null;
  const fresh = ids.length > 1 ? ids.filter((i) => i !== last) : ids;
  return fresh[Math.floor(rnd() * fresh.length) % fresh.length]!;
}

export interface Talker {
  /** World-object id (guide_arcadia, juno_vale, curator_sela…). */
  id: string;
  /** Feet position. */
  pos: readonly [number, number, number];
}

export class NpcTalk {
  private readonly last = new Map<string, string>();
  private readonly idleNext = new Map<CharacterId, number>();
  private anyNext: number = IDLE.firstS;
  private t = 0;
  private readonly preloaded = new Set<CharacterId>();
  private current: { who: CharacterId; at: THREE.Vector3 } | null = null;
  /** Until when (this.t) each character is still saying its last line: a farewell never cuts in. */
  private readonly busyUntil = new Map<CharacterId, number>();

  constructor(private readonly game: Game) {}

  private mouth(pos: readonly [number, number, number]): THREE.Vector3 {
    const at = new THREE.Vector3(pos[0], pos[1], pos[2]);
    return at.addScaledVector(at.clone().normalize(), 1.6);
  }

  private say(who: CharacterId, kind: string, ids: readonly string[], at: THREE.Vector3): string | null {
    const id = pickLine(ids, this.last.get(`${who}.${kind}`));
    if (!id) return null;
    this.last.set(`${who}.${kind}`, id);
    this.speak(who, id, at);
    return id;
  }

  private speak(who: CharacterId, id: string, at: THREE.Vector3) {
    const ms = say(this.game.audio, id, { name: CHARACTERS[who].name, at, key: who });
    this.busyUntil.set(who, this.t + ms / 1000 - 0.9); // the subtitle outlasts the voice by 0.9 s
  }

  /** You pressed E at a character: their greeting. Returns the line's id (null: not a speaking character). */
  greet(o: Talker): string | null {
    const who = CHARACTER_BY_OBJECT.get(o.id);
    if (!who) return null;
    const at = this.mouth(o.pos);
    this.current = { who, at };
    const you = this.game.hud.you;
    const ids = greetingIds(who, { won: gleamsWon(you?.missions ?? []), opened: !!you?.gleamVault });
    // A talk resets the idle clock: no muttering right after a conversation.
    this.idleNext.set(who, this.t + IDLE.perCharacterS);
    return this.say(who, "greet", ids, at);
  }

  /** You closed their panel: a farewell. */
  farewell() {
    const c = this.current;
    this.current = null;
    // Accepting a mission closes the panel: the offer they're saying plays out instead of a goodbye.
    if (c && this.t >= (this.busyUntil.get(c.who) ?? 0)) this.say(c.who, "farewell", dialogueFor(c.who, "farewell").map((l) => l.id), c.at);
  }

  /** You accepted a mission: its giver says the offer. */
  offer(missionId: string) {
    const who = missionSpeaker(missionId);
    const at = this.current?.at ?? null;
    if (who && at) this.speak(who, spokenId.mission(missionId), at);
  }

  /**
   * Each frame, with the speaking characters on this body: now and then the nearest one within
   * IDLE.near (not right on top of you) says an idle remark, and the greetings of anyone near load early.
   */
  update(dt: number, talkers: readonly Talker[], panelOpen: boolean) {
    this.t += dt;
    if (panelOpen || this.t < this.anyNext) return;
    const p = this.game.player.pos;
    let best: { who: CharacterId; o: Talker; d: number } | null = null;
    for (const o of talkers) {
      const who = CHARACTER_BY_OBJECT.get(o.id);
      if (!who) continue;
      const d = Math.hypot(o.pos[0] - p.x, o.pos[1] - p.y, o.pos[2] - p.z);
      if (d > IDLE.near * 2) continue;
      if (!this.preloaded.has(who)) {
        this.preloaded.add(who);
        preload(this.game.audio, [...greetingIds(who, { won: 0, opened: false }), ...dialogueFor(who, "farewell").map((l) => l.id)]);
      }
      if (d < IDLE.minDist || d > IDLE.near || this.t < (this.idleNext.get(who) ?? IDLE.firstS)) continue;
      if (!best || d < best.d) best = { who, o, d };
    }
    if (!best) return;
    this.idleNext.set(best.who, this.t + IDLE.perCharacterS);
    this.anyNext = this.t + IDLE.anyS;
    this.say(best.who, "idle", dialogueFor(best.who, "idle").map((l) => l.id), this.mouth(best.o.pos));
  }
}
