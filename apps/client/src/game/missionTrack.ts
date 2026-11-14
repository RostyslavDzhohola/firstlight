// The mission the player tracks (#69): one at a time, chosen by clicking a row in the missions panel
// or the journal, kept in localStorage. The missions panel expands only that row; the mission
// pointer, the compass marker and the server's hunt targets follow it (missions.ts trackedMission).
// `settle` keeps the choice honest once a frame of missions arrives: a choice that is no longer open
// gives way to the default rule (the first open one here, else anywhere), which a newly accepted
// mission wins only when nothing was tracked. Pure apart from the storage, so it is tested in node.

import type { BodyId } from "@firstlight/shared";
import { MISSION_BY_ID, trackedMission } from "@firstlight/shared/content/missions";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const KEY = "fl.trackedMission.v1";

function defaultStore(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export interface TrackMission {
  id: string;
  done: boolean;
}

export class MissionTrack {
  private id: string | null;
  private readonly listeners = new Set<(id: string | null) => void>();

  constructor(private readonly store: Store | null = defaultStore()) {
    let saved: string | null = null;
    try {
      saved = store?.getItem(KEY) ?? null;
    } catch {
      /* unavailable storage */
    }
    this.id = saved && MISSION_BY_ID.has(saved) ? saved : null;
  }

  /** The player's choice (may be a mission that is done or abandoned until `settle` runs). */
  get chosen(): string | null {
    return this.id;
  }

  /** Track `id` (null: none). Listeners hear about real changes only. */
  choose(id: string | null) {
    if (id === this.id) return;
    this.id = id;
    try {
      if (id) this.store?.setItem(KEY, id);
      else this.store?.removeItem(KEY);
    } catch {
      /* private mode / quota */
    }
    for (const f of this.listeners) f(id);
  }

  onChange(f: (id: string | null) => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  /**
   * With this frame's missions: the tracked one. A choice still open stays. Otherwise a mission
   * accepted just now (`fresh`) is tracked, else the default rule's pick; either becomes the choice,
   * so the next mission accepted doesn't take over (#69: "tracked only if nothing is").
   */
  settle<T extends TrackMission>(missions: readonly T[], body: BodyId, fresh: readonly string[] = []): T | null {
    const open = missions.filter((m) => !m.done && MISSION_BY_ID.has(m.id));
    const kept = this.id ? open.find((m) => m.id === this.id) : undefined;
    if (kept) return kept;
    const pick = open.find((m) => fresh.includes(m.id)) ?? trackedMission(open, body);
    this.choose(pick?.id ?? null);
    return pick ?? null;
  }

  /** The open mission after the tracked one (wrapping), for a key that steps through them. */
  nextAfter<T extends TrackMission>(missions: readonly T[]): T | null {
    const open = missions.filter((m) => !m.done && MISSION_BY_ID.has(m.id));
    if (!open.length) return null;
    const i = open.findIndex((m) => m.id === this.id);
    return open[(i + 1) % open.length] ?? null;
  }
}

/** The game's one tracker (survives travel between bodies). */
export const missionTrack = new MissionTrack();

/**
 * Gets the tracked choice to the server (review 2026-11-13 #3). `track` shares the server's five-a-second
 * quest budget, so a send can be refused (`denied {action: "track"}`) or lost; the server acknowledges an
 * accepted one with `tracked {id}`. One send is in flight at a time; changes meanwhile only update the
 * latest choice, which goes out when the answer comes. A refusal retries after the window, and a send
 * with no answer at all is repeated after `ackTimeoutMs`.
 */
export class TrackSync {
  private latest: string | null = null;
  private inFlight = false;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly send: (id: string | null) => void,
    private readonly opts: { retryMs: number; ackTimeoutMs: number } = { retryMs: 1100, ackTimeoutMs: 3000 },
  ) {}

  /** Is a choice not yet confirmed by the server? */
  get pending(): boolean {
    return this.inFlight || this.dirty;
  }

  /** The player chose `id`. */
  want(id: string | null) {
    this.latest = id;
    this.dirty = true;
    if (!this.inFlight && !this.timer) this.flush();
  }

  /** The server accepted `id`. */
  acked(id: string | null) {
    this.inFlight = false;
    this.clear();
    if (id !== this.latest) this.dirty = true;
    if (this.dirty) this.flush();
  }

  /** The server refused the last send (throttled): retry the latest choice after the window. */
  denied() {
    this.inFlight = false;
    this.dirty = true;
    this.later(this.opts.retryMs);
  }

  /** A new room: it knows nothing yet, so send `id` now. */
  reset(id: string | null) {
    this.clear();
    this.inFlight = false;
    this.want(id);
  }

  dispose() {
    this.clear();
  }

  private flush() {
    this.clear();
    this.dirty = false;
    this.inFlight = true;
    this.send(this.latest);
    this.later(this.opts.ackTimeoutMs);
  }

  private later(ms: number) {
    this.clear();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.inFlight = false;
      this.flush();
    }, ms);
  }

  private clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** Shift+L: track the next open mission, once per press (a held key's repeats are ignored). True when it stepped. */
export function stepTrackKey(track: MissionTrack, missions: readonly TrackMission[], e: { repeat: boolean }): boolean {
  if (e.repeat) return false;
  const next = track.nextAfter(missions);
  if (!next || next.id === track.chosen) return false;
  track.choose(next.id);
  return true;
}
