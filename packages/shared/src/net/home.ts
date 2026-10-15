// GET /api/home: the public home page data (6a, 6f). Display names only: no account ids, emails,
// positions or room copies.

import type { BodyId } from "../planet/bodies.ts";
import type { HallLine } from "../content/secrets.ts";

export interface HomeWorldOnline {
  players: number;
  /** In-world display names (the ones everyone sees above heads), capped per body. */
  names: string[];
}

export interface HomeOnline {
  total: number;
  bodies: Record<BodyId, HomeWorldOnline>;
}

export interface HomeLevelRow {
  name: string;
  level: number;
  /** Index into STARTERS. */
  starter: number;
  /** The worn title's text, if any. */
  title: string | null;
}

export interface HomeMedalRow {
  name: string;
  medals: number;
  title: string | null;
}

export interface HomeBoard {
  levels: HomeLevelRow[];
  medals: HomeMedalRow[];
  /** Claimed Hall of Firsts plaques, oldest first (ids are PLAQUES ids). */
  hall: HallLine[];
}

export interface HomeVisits {
  /** DataFast: visitors with a pageview in the last 10 minutes. */
  online: number;
  /** DataFast: all-time visits. */
  total: number;
}

export interface HomeData {
  online: HomeOnline;
  /** Null when the server has no game database (tests, broken storage). */
  board: HomeBoard | null;
  /** Null unless DataFast is configured on the server and has answered. */
  visits: HomeVisits | null;
  at: number;
}
