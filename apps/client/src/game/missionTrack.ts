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
