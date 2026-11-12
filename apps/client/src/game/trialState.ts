// The server's `trial` messages (quests/trials.ts: a race, defend or collect attempt changed state),
// held from the moment we join a room like huntTargets.ts (the SDK drops a message nobody listens
// to). Pure helpers turn the latest one into the HUD's clock line and the point the mission pointer
// leads to, so both are tested without a scene.

import { MISSION_BY_ID, type MissionDef } from "@firstlight/shared/content/missions";
import type { TrialMsg } from "@firstlight/shared/net/protocol";

export interface TrialSeen {
  msg: TrialMsg;
  /** When it arrived, on the clock listenTrials was given (the game's synced server clock, trialNow()). */
  at: number;
  /** When this attempt started (the first message of a run of running/paused ones for one mission): an untimed collect's clock counts up from it. Defaults to `at`. */
  since?: number;
}

interface MessageSource {
  /** Colyseus returns a function that removes the handler. */
  onMessage(type: "trial", cb: (m: TrialMsg) => void): unknown;
}

let latest: TrialSeen | null = null;
const listeners = new Set<(t: TrialSeen) => void>();
/** Bumped by each listenTrials: a handler from an earlier room sees a stale number and does nothing. */
let generation = 0;
let unbind: (() => void) | null = null;
let clock: () => number = () => Date.now();

/**
 * Start listening on a freshly joined room: forgets the previous room's attempt and removes its
 * handler (a room we travelled away from, or a socket replaced on reconnect, can still deliver a
 * late frame; it is ignored).
 */
export function listenTrials(room: MessageSource, now: () => number = () => Date.now()): void {
  clock = now;
  unbind?.();
  unbind = null;
  const mine = ++generation;
  latest = null;
  const off = room.onMessage("trial", (m) => {
    if (mine !== generation || !m) return;
    const at = now();
    const prev = latest;
    const cont = prev && prev.msg.id === m.id && (prev.msg.state === "running" || prev.msg.state === "paused") && m.state !== "idle";
    latest = { msg: m, at, since: cont ? (prev.since ?? prev.at) : at };
    for (const fn of listeners) fn(latest);
  });
  if (typeof off === "function") unbind = off as () => void;
}

/** Now on the clock the attempt messages are stamped with (the server clock in the game): pass it to trialHud / clockLeft. */
export function trialNow(): number {
  return clock();
}

/** The latest attempt message in this room, or null. */
export function trialSeen(): TrialSeen | null {
  return latest;
}

/** Hear each new message (the trial client's sounds and toasts). */
export function onTrial(fn: (t: TrialSeen) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** "1:05", "0:09", "0:00" (whole seconds, rounded up so 0:00 means it's over). */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Clock left at `now` (trialNow()'s clock): runs to the server's `endsAt` while running (from the
 * receipt for servers that don't send it), stands still while paused, 0 when over.
 */
export function clockLeft(t: TrialSeen, now: number): number {
  const { msg } = t;
  if (msg.state === "paused") return msg.leftMs;
  if (msg.state !== "running") return 0;
  if (msg.endsAt) return Math.max(0, Math.min(msg.limitMs || Infinity, msg.endsAt - now));
  return Math.max(0, msg.leftMs - (now - t.at));
}

export interface TrialHud {
  /** "The Swift Gleam" */
  title: string;
  /** "Ring 4 of 8", "Held 37 of 90 s", "3 of 8 gleam shards" */
  progress: string;
  /** "0:41", "" for untimed collects. */
  clock: string;
  /** Colour cue: urgent under 10 s; paused while out of a beacon's ring. */
  tone: "normal" | "urgent" | "paused" | "done" | "failed";
}

/**
 * The HUD line for the current attempt, or null when there is none to show (idle, another body's
 * mission, or a finished/failed attempt older than `linger` ms).
 */
export function trialHud(t: TrialSeen | null, now: number, linger = 4000): TrialHud | null {
  if (!t) return null;
  const { msg } = t;
  const def = MISSION_BY_ID.get(msg.id);
  if (!def || msg.state === "idle") return null;
  if ((msg.state === "done" || msg.state === "failed") && now - t.at > linger) return null;
  const left = clockLeft(t, now);
  let progress: string;
  let shown = msg.progress;
  if (msg.kind === "race") progress = msg.state === "done" ? `All ${msg.goal} rings` : `Ring ${Math.min(msg.goal, msg.progress + 1)} of ${msg.goal}`;
  else if (msg.kind === "defend") {
    // Held seconds = the whole hold minus what's left (extrapolated while running).
    shown = msg.state === "done" ? msg.goal : Math.min(msg.goal, Math.floor((msg.limitMs - left) / Math.max(1, msg.limitMs / msg.goal)));
    progress = msg.state === "paused" ? `Back to the beacon! Held ${shown} of ${msg.goal} s` : `Held ${shown} of ${msg.goal} s`;
  } else progress = `${msg.progress} of ${msg.goal} ${def.collect?.itemName ?? "pieces"}`;
  if (msg.state === "failed") progress = msg.reason === "time" ? "Out of time" : msg.reason === "died" ? "You fell" : msg.reason === "left" ? "You left the ring" : "Failed";
  if (msg.state === "done") progress = `${progress} · complete`;
  const timed = msg.limitMs > 0 && msg.kind !== "defend";
  // An untimed collect counts up from its start (D-polish-ux-2), so every attempt shows a clock.
  const elapsed = formatClock(Math.floor(Math.max(0, (msg.state === "running" ? now : t.at) - (t.since ?? t.at)) / 1000) * 1000);
  const clock = msg.kind === "defend" ? formatClock(left) : timed ? formatClock(left) : msg.state === "failed" ? "" : elapsed;
  const tone: TrialHud["tone"] = msg.state === "done" ? "done" : msg.state === "failed" ? "failed" : msg.state === "paused" ? "paused" : msg.limitMs > 0 && left < 10_000 && msg.kind !== "defend" ? "urgent" : "normal";
  return { title: def.name, progress, clock, tone };
}

type V3 = readonly [number, number, number];

/**
 * The world object a race / defend / collect mission leads to now: the next ring (ring 1 until an
 * attempt runs), the beacon, or the nearest piece not yet taken (by `counts`). Null for other types.
 */
export function objectiveObject(def: MissionDef, counts: readonly number[] | undefined, trial: TrialMsg | null, me: V3, posOf: (id: string) => V3 | null): string | null {
  if (def.race) {
    const live = trial && trial.id === def.id && trial.state === "running";
    return def.race.rings[live ? Math.min(trial!.progress, def.race.rings.length - 1) : 0] ?? null;
  }
  if (def.defend) return def.defend.beacon;
  if (def.collect) {
    let best: string | null = null;
    let bestD = Infinity;
    def.collect.pieces.forEach((id, i) => {
      if (counts?.[i]) return;
      const p = posOf(id);
      if (!p) return;
      const d = Math.hypot(p[0] - me[0], p[1] - me[1], p[2] - me[2]);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    });
    return best;
  }
  return null;
}
