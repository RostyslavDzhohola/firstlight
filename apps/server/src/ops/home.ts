// GET /api/home: public data for the home page (6a, 6f). Who's online per body (counts plus the
// in-world display names), the leaderboard (top levels, medals, Hall of Firsts) and, when DataFast
// is configured, its visit counts. No sign-in; display names only; cached and rate-limited per
// address, so polling home pages cost a few SQLite reads a minute at most.

import type { Express } from "express";
import { BODY_IDS, type BodyId } from "@firstlight/shared";
import { MEDAL_BY_ID } from "@firstlight/shared/content/medals";
import { STARTERS, starterLook } from "@firstlight/shared/content/weapons";
import type { HomeBoard, HomeData, HomeOnline } from "@firstlight/shared/net/home";
import { banKey, directRequestIp } from "../auth/ip.ts";
import { listHallOfFirsts, medalLeaders, topLevels, type Db } from "../db/index.ts";
import { liveRooms } from "../social/index.ts";
import type { VisitSource } from "./datafast.ts";

export const HOME_LIMITS = {
  /** Requests per address per window (a home page polls every 20 s). */
  perAddress: 30,
  windowMs: 60_000,
  boardTtlMs: 60_000,
  onlineTtlMs: 3_000,
  namesPerBody: 12,
  boardRows: 10,
};

export interface HomeDeps {
  /** game.db; null serves the page without a leaderboard. */
  db: Db | null;
  visits?: VisitSource;
  now?: () => number;
}

interface RoomLike {
  bodyDef: { id: string };
  metadata?: { loadtest?: boolean } | null;
  actors: Map<string, { identity: { loadtest?: boolean }; superseded?: boolean; state: { name: string } }>;
}

/** Players per body, and up to `namesPerBody` names each (sorted). Load-test bots never count. */
export function onlineSnapshot(rooms: Iterable<RoomLike>, namesPerBody = HOME_LIMITS.namesPerBody): HomeOnline {
  const bodies = Object.fromEntries(BODY_IDS.map((b) => [b, { players: 0, names: [] as string[] }])) as HomeOnline["bodies"];
  let total = 0;
  for (const r of rooms) {
    if (r.metadata?.loadtest) continue;
    const slot = bodies[r.bodyDef.id as BodyId];
    if (!slot) continue;
    for (const a of r.actors.values()) {
      if (a.identity.loadtest || a.superseded) continue;
      slot.players++;
      total++;
      if (a.state.name) slot.names.push(a.state.name);
    }
  }
  for (const b of BODY_IDS) bodies[b].names = [...new Set(bodies[b].names)].sort((x, y) => x.localeCompare(y)).slice(0, namesPerBody);
  return { total, bodies };
}

const titleOf = (medal: string | null) => (medal ? (MEDAL_BY_ID.get(medal)?.title ?? null) : null);

export function readBoard(db: Db, now = Date.now(), rows = HOME_LIMITS.boardRows): HomeBoard {
  return {
    levels: topLevels(db, rows, now).map((r) => {
      const starter = Math.max(0, STARTERS.findIndex((s) => s.id === r.starter));
      return { name: r.name, level: r.level, starter, look: starterLook(starter, r.look), title: titleOf(r.titleMedal) };
    }),
    medals: medalLeaders(db, rows, now).map((r) => ({ name: r.name, medals: r.medals, title: titleOf(r.titleMedal) })),
    hall: listHallOfFirsts(db).map((e) => ({ id: e.secretId, name: e.displayName, foundAt: e.foundAt })),
  };
}

export function mountHome(app: Express, deps: HomeDeps): void {
  const now = deps.now ?? Date.now;
  const calls = new Map<string, { start: number; n: number }>();
  let board: { at: number; value: HomeBoard | null } = { at: -Infinity, value: null };
  let online: { at: number; value: HomeOnline } | null = null;

  const allowed = (key: string, t: number): boolean => {
    let c = calls.get(key);
    if (!c || t - c.start >= HOME_LIMITS.windowMs) {
      // Forget expired windows now and then, so one-off addresses don't pile up.
      if (calls.size > 10_000) for (const [k, v] of calls) if (t - v.start >= HOME_LIMITS.windowMs) calls.delete(k);
      c = { start: t, n: 0 };
      calls.set(key, c);
    }
    return ++c.n <= HOME_LIMITS.perAddress;
  };

  app.get("/api/home", async (req, res) => {
    const t = now();
    const ip = directRequestIp(req);
    if (!allowed(ip ? banKey(ip) : "unknown", t)) {
      res.setHeader("Retry-After", String(Math.ceil(HOME_LIMITS.windowMs / 1000)));
      res.status(429).json({ error: "slow down" });
      return;
    }
    if (!online || t - online.at >= HOME_LIMITS.onlineTtlMs) online = { at: t, value: onlineSnapshot(liveRooms as Iterable<RoomLike>) };
    if (deps.db && t - board.at >= HOME_LIMITS.boardTtlMs) {
      try {
        board = { at: t, value: readBoard(deps.db, t) };
      } catch (err) {
        console.error("home: leaderboard read failed", err);
        board = { at: t, value: board.value }; // keep the last one; try again next minute
      }
    }
    const visits = deps.visits ? await deps.visits.get().catch(() => null) : null;
    const body: HomeData = { online: online.value, board: board.value, visits, at: t };
    res.setHeader("Cache-Control", "public, max-age=5");
    res.json(body);
  });
}
