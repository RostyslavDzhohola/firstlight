// The HUD's moments (D-ui-2): the banners a player earns (level-up, mission complete, trial won,
// gleam won, medal earned, the vault, a new spell) and the queue that shows them one at a time.
// Pure: no DOM, no three. The view is ui/momentsView.ts; game/MomentsClient.ts feeds it from the
// room's messages. The server still sends its text toasts for these; `bannerCovers` names the ones a
// banner replaces so the toast column doesn't say the same thing twice.

import { GLEAMS, gleamsWon } from "@firstlight/shared/content/gleams";
import { MEDAL_BY_ID } from "@firstlight/shared/content/medals";
import { MISSION_BY_ID, type MissionDef } from "@firstlight/shared/content/missions";
import { SPELLS, type SpellDef } from "@firstlight/shared/content/spells";
import type { SoundName } from "../audio/sounds.ts";

export type MomentKind = "level" | "spell" | "mission" | "trial" | "gleam" | "vault" | "medal";

export interface Moment {
  kind: MomentKind;
  /** Small caps line over the name: "Level up", "Mission complete". */
  kicker: string;
  /** The name, large: "Level 7", "The Big Lake". */
  title: string;
  /** What it paid or what it means: "+180 XP · +60 ◎". */
  reward: string;
  /** Sprite (ui/sprites.ts). */
  sprite: string;
  /** A keycap after the reward line (a spell's key). */
  key?: string;
  /** How long it holds, ms (the in and out animations are on top). */
  ms: number;
  /** A queued moment with the same `merge` is replaced by a newer one (two level-ups in a row show the last). */
  merge?: string;
}

const HOLD_MS = 2600;
const HOLD_LONG_MS = 3600;
const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

/** "+180 XP · +60 ◎" (parts that are 0 are left out). */
export function rewardLine(xp: number, coins: number, extra = ""): string {
  return [xp > 0 ? `+${fmt(xp)} XP` : "", coins > 0 ? `+${fmt(coins)} ◎` : "", extra].filter(Boolean).join(" · ");
}

/** The spells a level-up from `prev` to `level` unlocks (levels 3, 6 and 9; Skipstep is there from the start). */
export function spellUnlocks(prev: number, level: number): SpellDef[] {
  return SPELLS.filter((s) => s.level > prev && s.level <= level);
}

/** The next spell still locked at `level`, or null with the whole book open. */
export function nextSpell(level: number): SpellDef | null {
  return SPELLS.filter((s) => s.level > level).sort((a, b) => a.level - b.level)[0] ?? null;
}

/**
 * A level-up from `prev` to `level`: one banner for the level, and one for each spell it unlocks
 * (with its key). The level banner says what comes next when nothing unlocked.
 */
export function levelMoments(prev: number, level: number): Moment[] {
  if (level <= prev) return [];
  const next = nextSpell(level);
  const out: Moment[] = [{
    kind: "level", kicker: "Level up", title: `Level ${level}`, sprite: "star", ms: HOLD_MS, merge: "level",
    reward: next ? `More health and damage · ${next.name} at level ${next.level}` : "More health and damage",
  }];
  for (const s of spellUnlocks(prev, level)) {
    out.push({ kind: "spell", kicker: "New spell", title: s.name, reward: s.blurb, sprite: `spell-${s.id}`, key: s.keycap, ms: HOLD_LONG_MS });
  }
  return out;
}

const isTimed = (def: MissionDef) => !!(def.race || def.defend || def.collect);

/** How a timed mission was won, for the trial banner: "All 8 rings", "Held the beacon 90 s", "8 gleam shards". */
export function trialFeat(def: MissionDef): string {
  if (def.race) return `All ${def.race.rings.length} rings`;
  if (def.defend) return `Held the beacon ${def.defend.holdS} s`;
  if (def.collect) return `${def.collect.pieces.length} ${def.collect.itemName}`;
  return "";
}

/**
 * The server's `missionDone`: a mission banner, or for a race / defend / collect a "Trial won"
 * banner; a trial of the Three Gleams adds the gleam it won (`missions`: the player's list as last
 * seen, which may not hold this one as done yet). "vault" is the Gleam Vault opening.
 */
export function missionMoments(id: string, xp: number, coins: number, missions: readonly { id: string; done: boolean }[] = []): Moment[] {
  if (id === "vault") {
    return [{ kind: "vault", kicker: GLEAMS.name, title: "The Gleam Vault opens", reward: rewardLine(0, coins, "Gleamweave Cape"), sprite: "chest", ms: HOLD_LONG_MS }];
  }
  const def = MISSION_BY_ID.get(id);
  if (!def) return [];
  const out: Moment[] = [];
  if (isTimed(def)) out.push({ kind: "trial", kicker: "Trial won", title: def.name, reward: rewardLine(xp, coins, trialFeat(def)), sprite: "trophy", ms: HOLD_MS });
  else out.push({ kind: "mission", kicker: "Mission complete", title: def.name, reward: rewardLine(xp, coins), sprite: "flag", ms: HOLD_MS });
  if (def.trial) {
    const total = GLEAMS.trials.length;
    const won = Math.min(total, gleamsWon([...missions.filter((m) => m.id !== id), { id, done: true }]));
    out.push({
      kind: "gleam", kicker: `Gleam won · ${won} of ${total}`, title: GLEAMS.name, sprite: "prism", ms: HOLD_LONG_MS,
      reward: won >= total ? `All three. ${GLEAMS.curator.name}'s vault in Portus Plaza is waiting` : `${total - won} more ${total - won === 1 ? "opens" : "open"} the vault in Portus Plaza`,
    });
  }
  return out;
}

/** The server's `medal`. */
export function medalMoment(id: string): Moment | null {
  const def = MEDAL_BY_ID.get(id);
  if (!def) return null;
  return { kind: "medal", kicker: "Medal earned", title: def.name, reward: `Title “${def.title}” · wear it from the journal (J)`, sprite: "medal", ms: HOLD_LONG_MS };
}

/**
 * Server toasts a banner already says (BodyRoom "Level N!", QuestSystem "Mission complete: …",
 * "Medal earned: …", "Gleam won: …", "All three gleams won …", "The Gleam Vault opens · …").
 */
export function bannerCovers(text: string): boolean {
  return /^(Level \d+!$|Mission complete: |Medal earned: |Gleam won: |All three gleams won|The Gleam Vault opens)/.test(text);
}

// ------------------------------------------------------------------------------------------ sounds

export interface SoundCue {
  name: SoundName;
  gain?: number;
  rate?: number;
  /** ms after the banner goes up. */
  at?: number;
}

/**
 * Each banner's sound, played when it goes up (so a queued banner sounds when it shows, not when it
 * was earned): chords built from the sounds the game already has, each kind its own shape. A trial's
 * finish already rang when its clock stopped (TrialClient), so its banner only adds a soft glass note.
 */
export const MOMENT_SOUNDS: Readonly<Record<MomentKind, readonly SoundCue[]>> = {
  level: [{ name: "levelUp" }],
  spell: [{ name: "wishfallCast", gain: 0.6 }, { name: "ward", gain: 0.45, rate: 1.3, at: 220 }],
  mission: [{ name: "coins", gain: 0.9 }, { name: "levelUp", gain: 0.45, rate: 1.25, at: 130 }],
  trial: [{ name: "ward", gain: 0.5, rate: 1.2 }],
  gleam: [{ name: "ward", gain: 0.6, rate: 1.5 }, { name: "coins", gain: 0.6, rate: 1.5, at: 160 }, { name: "coins", gain: 0.6, rate: 1.9, at: 320 }],
  vault: [{ name: "portal", gain: 0.6, rate: 1.3 }, { name: "levelUp", gain: 0.8, rate: 0.8, at: 200 }, { name: "coins", at: 480 }],
  medal: [{ name: "levelUp", gain: 0.8, rate: 1.33 }, { name: "coins", gain: 0.7, rate: 0.8, at: 170 }],
};

// ------------------------------------------------------------------------------------------- queue

/** What the view does after a `tick`: put a banner up, start taking the current one away, or nothing. */
export type QueueStep = { show: Moment } | { hide: true } | null;

export const BANNER_IN_MS = 320;
export const BANNER_OUT_MS = 260;
/** Dark time between two banners. */
export const BANNER_GAP_MS = 180;
const MAX_QUEUED = 6;

/**
 * One banner at a time: the next waits until the current one has held and left. A moment whose
 * `merge` matches a queued one replaces it; when the queue is full the oldest queued one is dropped
 * (never the one on screen). Time is whatever clock `tick` is given (performance.now in play).
 */
export class BannerQueue {
  private readonly waiting: Moment[] = [];
  private current: Moment | null = null;
  /** When the current banner starts to leave, and when the next may show. */
  private leaveAt = 0;
  private freeAt = 0;
  private leaving = false;
  /** When the clock stopped (the HUD is hidden under a menu or photo mode), or null while it runs. */
  private pausedAt: number | null = null;

  get showing(): Moment | null {
    return this.current;
  }

  get length(): number {
    return this.waiting.length;
  }

  push(...moments: Moment[]): void {
    for (const m of moments) {
      const i = m.merge ? this.waiting.findIndex((w) => w.merge === m.merge) : -1;
      if (i >= 0) this.waiting[i] = m;
      else this.waiting.push(m);
    }
    while (this.waiting.length > MAX_QUEUED) this.waiting.shift();
  }

  /** Drop everything (a death, a logout): returns whether a banner was on screen. */
  clear(): boolean {
    this.waiting.length = 0;
    const was = !!this.current;
    this.current = null;
    this.leaving = false;
    this.freeAt = 0;
    return was;
  }

  get paused(): boolean {
    return this.pausedAt !== null;
  }

  /** Stop the clock: nothing shows, holds or leaves until `resume`. */
  pause(now: number): void {
    if (this.pausedAt === null) this.pausedAt = now;
  }

  /** Start the clock again: the banner on screen and the gap after it keep the time they had left. */
  resume(now: number): void {
    if (this.pausedAt === null) return;
    const d = Math.max(0, now - this.pausedAt);
    this.pausedAt = null;
    this.leaveAt += d;
    this.freeAt += d;
  }

  tick(now: number): QueueStep {
    if (this.pausedAt !== null) return null;
    if (this.current) {
      if (!this.leaving && now >= this.leaveAt) {
        this.leaving = true;
        this.freeAt = now + BANNER_OUT_MS + BANNER_GAP_MS;
        return { hide: true };
      }
      if (this.leaving && now >= this.freeAt) {
        this.current = null;
        this.leaving = false;
      } else return null;
    }
    if (now < this.freeAt) return null;
    const next = this.waiting.shift();
    if (!next) return null;
    this.current = next;
    this.leaveAt = now + BANNER_IN_MS + next.ms;
    return { show: next };
  }
}
