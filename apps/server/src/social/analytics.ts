// Play-session analytics (SPEC §6.11): one session_log row per visit, spanning travel between
// bodies. A session starts on the first join, follows the player across rooms, and ends when they
// have been gone for a short grace period (travel and reconnects don't split it). Load-test players
// are never recorded.

import type { PlayerActor } from "../world/actors.ts";
import { sessionClient, sessionEnd, sessionStart, sessionUpdate } from "./store.ts";

export const ANALYTICS = {
  /** A player who comes back within this window continues the same session. */
  END_GRACE_MS: 60_000,
  /** Progress is written at least this often while playing. */
  FLUSH_MS: 30_000,
};

const BACKENDS = new Set(["webgpu", "webgl2", "unknown"]);
const TIERS = new Set(["low", "medium", "high", "ultra", "unknown"]);

interface Tracker {
  /** Account id this tracker is filed under (changes when a guest saves). */
  key: string;
  logId: number | null;
  bodyTime: Record<string, number>;
  deaths: number;
  maxLevel: number;
  lastFlush: number;
  /** When the player last left a room (the session ends here unless they come back). */
  lastLeftAt: number | null;
  current: { sessionId: string; body: string; since: number; actor: PlayerActor; baseDeaths: number } | null;
  endTimer: ReturnType<typeof setTimeout> | null;
}

const trackers = new Map<string, Tracker>();

export function trackJoin(actor: PlayerActor, body: string, now = Date.now()): void {
  const userId = actor.identity.userId;
  if (actor.identity.loadtest || actor.sandbox) return; // bots and admin sandboxes aren't play (D-admin-3)
  let t = trackers.get(userId);
  if (t?.endTimer) {
    clearTimeout(t.endTimer);
    t.endTimer = null;
  }
  if (t?.current) closeCurrent(t, now);
  if (!t) {
    t = { key: userId, logId: sessionStart(userId, now), bodyTime: {}, deaths: 0, maxLevel: actor.char.level, lastFlush: now, lastLeftAt: null, current: null, endTimer: null };
    trackers.set(userId, t);
  }
  t.lastLeftAt = null;
  t.current = { sessionId: actor.id, body, since: now, actor, baseDeaths: actor.char.deaths };
  t.maxLevel = Math.max(t.maxLevel, actor.char.level);
}

export function trackLeave(userId: string, sessionId: string, now = Date.now()): void {
  const t = trackers.get(userId);
  if (!t || !t.current || t.current.sessionId !== sessionId) return;
  closeCurrent(t, now);
  sessionUpdate(t.logId, progress(t, now));
  t.lastFlush = now;
  t.lastLeftAt = now;
  if (t.endTimer) clearTimeout(t.endTimer);
  const tracker = t;
  t.endTimer = setTimeout(() => endTracker(tracker), ANALYTICS.END_GRACE_MS);
  t.endTimer.unref?.();
}

/** Poll levels and deaths of a live player; writes progress every FLUSH_MS. */
export function trackTick(userId: string, now = Date.now()): void {
  const t = trackers.get(userId);
  if (!t?.current) return;
  t.maxLevel = Math.max(t.maxLevel, t.current.actor.char.level);
  if (now - t.lastFlush >= ANALYTICS.FLUSH_MS) {
    t.lastFlush = now;
    sessionUpdate(t.logId, progress(t, now));
  }
}

export function trackClientInfo(userId: string, backend: string, tier: string): void {
  const t = trackers.get(userId);
  if (!t) return;
  sessionClient(t.logId, BACKENDS.has(backend) ? backend : "unknown", TIERS.has(tier) ? tier : "unknown");
}

/** End every open session now (graceful shutdown). */
export function endAllSessions(now = Date.now()): number {
  let n = 0;
  for (const t of [...trackers.values()]) {
    if (t.current) closeCurrent(t, now);
    endTracker(t, now);
    n++;
  }
  return n;
}

/**
 * A guest saved (new account id). The guest's live session continues under the account id; if the
 * account was being tracked too (another browser, about to be displaced), that session ends now.
 */
export function rekeyAnalytics(from: string, to: string, now = Date.now()): void {
  const t = trackers.get(from);
  if (!t || from === to) return;
  const dest = trackers.get(to);
  if (dest && !t.current) {
    // The guest had already left (grace period) and the account is tracked elsewhere: the
    // account's session carries on; the guest's ends where it left off.
    endTracker(t, now);
    return;
  }
  if (dest) {
    // The guest's live session displaces the account's other browser.
    if (dest.current) closeCurrent(dest, now);
    endTracker(dest, now);
  }
  trackers.delete(from);
  t.key = to;
  trackers.set(to, t);
}

export function openTrackers(): number {
  return trackers.size;
}

function closeCurrent(t: Tracker, now: number): void {
  const c = t.current!;
  t.bodyTime[c.body] = (t.bodyTime[c.body] ?? 0) + Math.max(0, now - c.since);
  t.deaths += Math.max(0, c.actor.char.deaths - c.baseDeaths);
  t.maxLevel = Math.max(t.maxLevel, c.actor.char.level);
  t.current = null;
}

function progress(t: Tracker, now: number) {
  const bodyTime = { ...t.bodyTime };
  let deaths = t.deaths;
  if (t.current) {
    const c = t.current;
    bodyTime[c.body] = (bodyTime[c.body] ?? 0) + Math.max(0, now - c.since);
    deaths += Math.max(0, c.actor.char.deaths - c.baseDeaths);
  }
  return { bodyTime, deaths, maxLevel: t.maxLevel };
}

function endTracker(t: Tracker, now = Date.now()): void {
  if (t.endTimer) clearTimeout(t.endTimer);
  t.endTimer = null;
  if (trackers.get(t.key) === t) trackers.delete(t.key);
  sessionEnd(t.logId, { ...progress(t, now), endedAt: t.current ? now : (t.lastLeftAt ?? now) });
}
