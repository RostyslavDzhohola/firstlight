// The player's waypoint: a client-only destination, one per body, dropped by clicking the map (M).
// It shows as a light pillar in the world (world/WaypointBeacon.ts), a compass tick with its
// distance, and a marker on the map and the minimap; it clears on arrival or with a right-click on
// the map. Kept in localStorage as `fl.waypoint.<body>` (a unit direction).

import type { BodyId } from "@firstlight/shared";
import { surfaceDistance, type V3 } from "../social/compassMath.ts";

/** Surface distance (m) that counts as arriving. */
export const WAYPOINT_REACH = 8;
/** The waypoint's colour everywhere it shows (map, minimap, compass, beacon). */
export const WAYPOINT_COLOUR = "#ff5fd2";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Listener = (body: BodyId, dir: V3 | null) => void;

const key = (body: BodyId) => `fl.waypoint.${body}`;

function defaultStore(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function unit(v: readonly number[]): V3 | null {
  if (v.length !== 3 || !v.every((x) => typeof x === "number" && Number.isFinite(x))) return null;
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return l > 1e-9 ? [v[0]! / l, v[1]! / l, v[2]! / l] : null;
}

export class WaypointStore {
  private readonly cache = new Map<BodyId, V3 | null>();
  private readonly listeners = new Set<Listener>();

  constructor(private readonly store: Store | null = defaultStore()) {}

  get(body: BodyId): V3 | null {
    if (!this.cache.has(body)) {
      let d: V3 | null = null;
      try {
        const raw = this.store?.getItem(key(body));
        const v: unknown = raw ? JSON.parse(raw) : null;
        d = Array.isArray(v) ? unit(v) : null;
      } catch {
        d = null;
      }
      this.cache.set(body, d);
    }
    return this.cache.get(body) ?? null;
  }

  set(body: BodyId, dir: readonly number[]): void {
    const d = unit(dir);
    if (!d) return;
    this.cache.set(body, d);
    try {
      this.store?.setItem(key(body), JSON.stringify(d.map((x) => Math.round(x * 1e7) / 1e7)));
    } catch {
      /* private mode: it just doesn't persist */
    }
    for (const l of this.listeners) l(body, d);
  }

  clear(body: BodyId): void {
    if (!this.get(body)) return;
    this.cache.set(body, null);
    try {
      this.store?.removeItem(key(body));
    } catch {
      /* ignore */
    }
    for (const l of this.listeners) l(body, null);
  }

  /** Call with the player's position: clears the waypoint and returns true on arrival. */
  arrive(body: BodyId, pos: V3, radius: number): boolean {
    const d = this.get(body);
    if (!d || surfaceDistance(pos, d, radius) > WAYPOINT_REACH) return false;
    this.clear(body);
    return true;
  }

  onChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

/** The game's waypoints (one store for the session). */
export const waypoints = new WaypointStore();
