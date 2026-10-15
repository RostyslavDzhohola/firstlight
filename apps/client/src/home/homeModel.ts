// The home page's pure parts (6a): the worlds list, the progress card, the leaderboard rows and the
// text lines, built from shared content and the /api/home and /api/account/me answers. No DOM.

import { BODIES, BODY_IDS, type BodyId } from "@firstlight/shared/planet/bodies";
import { BOSS_BY_BODY, npcDef } from "@firstlight/shared/content/npcs";
import { MEDAL_BY_ID, MEDALS } from "@firstlight/shared/content/medals";
import { LEVEL_CAP, xpAtLevel, xpToNext } from "@firstlight/shared/content/progression";
import { PLAQUES, type HallLine } from "@firstlight/shared/content/secrets";
import { STARTERS } from "@firstlight/shared/content/weapons";
import type { HomeOnline, HomeVisits } from "@firstlight/shared/net/home";

// ------------------------------------------------------------------------------------------- worlds

const BLURB: Record<BodyId, string> = {
  portus: "The castle town between the worlds: shop, portals, Hall of Firsts.",
  arcadia: "Golden meadows round Glasswater Lake, where the Brightbits roam.",
  hollowmere: "Violet dusk over Mourning Mere. The Hollow Court keeps the fen.",
  meridian: "Red canyons and chrome spires, run by Meridian Oversight.",
};
const PADS: Record<string, number> = { icosa: 12, dodeca: 20, none: 0 };

export interface WorldCard {
  id: BodyId;
  name: string;
  blurb: string;
  /** "Levels 1–7", or "Safe hub" for Portus. */
  levels: string;
  players: number;
  boss: { name: string; level: number } | null;
  pads: number;
}

export function worldCards(online: HomeOnline | null): WorldCard[] {
  return BODY_IDS.map((id) => {
    const b = BODIES[id];
    const boss = BOSS_BY_BODY[id];
    return {
      id,
      name: b.name,
      blurb: BLURB[id],
      levels: b.levels[1] > 0 ? `Levels ${b.levels[0]}–${b.levels[1]}` : "Safe hub",
      players: online?.bodies[id]?.players ?? 0,
      boss: boss ? { name: npcDef(boss.id).name, level: boss.level } : null,
      pads: PADS[b.padLayout] ?? 0,
    };
  });
}

// ------------------------------------------------------------------------------------- my progress

/** The /api/account/me fields the progress card reads (`starter` arrives as the stored id or an index). */
export interface MeInfo {
  name: string;
  displayName: string | null;
  guest: boolean;
  titleMedal: string | null;
  character: { level: number; xp: number; coins: number; starter: number | string; palette: number; body: string } | null;
  medals: string[];
  pads: { body: string; padId: string }[];
  playMs?: number;
}

export interface ProgressView {
  name: string;
  guest: boolean;
  starter: number;
  starterName: string;
  level: number;
  /** 0–1 through the current level (1 at the cap). */
  xpFrac: number;
  xpText: string;
  coins: number;
  medals: number;
  medalsTotal: number;
  title: string | null;
  pads: number;
  padsTotal: number;
  body: string;
  playTime: string;
  /** Has a character (alive); false = between lives or never played. */
  playing: boolean;
}

export function starterIndex(s: number | string | null | undefined): number {
  if (typeof s === "number" && Number.isInteger(s) && s >= 0 && s < STARTERS.length) return s;
  const i = STARTERS.findIndex((x) => x.id === s);
  return i >= 0 ? i : 0;
}

const nf = new Intl.NumberFormat("en-US");
export const fmtNum = (n: number) => nf.format(Math.round(n));

export function progressView(me: MeInfo, fallbackStarter = 0): ProgressView {
  const c = me.character;
  const level = Math.max(1, c?.level ?? 1);
  const into = Math.max(0, (c?.xp ?? 0) - xpAtLevel(level));
  const need = xpToNext(level);
  const starter = starterIndex(c?.starter ?? fallbackStarter);
  const padsTotal = BODY_IDS.reduce((s, b) => s + (PADS[BODIES[b].padLayout] ?? 0), 0);
  return {
    name: me.displayName || me.name || "You",
    guest: me.guest,
    starter,
    starterName: STARTERS[starter]!.name,
    level,
    xpFrac: need > 0 ? Math.min(1, into / need) : 1,
    xpText: need > 0 && level < LEVEL_CAP ? `${fmtNum(into)} / ${fmtNum(need)} XP` : "Max level",
    coins: c?.coins ?? 0,
    medals: me.medals.filter((m) => MEDAL_BY_ID.has(m)).length,
    medalsTotal: MEDALS.length,
    title: me.titleMedal ? (MEDAL_BY_ID.get(me.titleMedal)?.title ?? null) : null,
    pads: new Set(me.pads.map((p) => `${p.body}:${p.padId}`)).size,
    padsTotal,
    body: BODIES[c?.body as BodyId]?.name ?? "Portus",
    playTime: fmtPlayTime(me.playMs ?? 0),
    playing: !!c,
  };
}

/** "2 h 14 min", "38 min", "under a minute". */
export function fmtPlayTime(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return "under a minute";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h} h ${m} min` : `${m} min`;
}

// ------------------------------------------------------------------------------------- leaderboard

export interface HallRow {
  label: string;
  name: string | null;
  date: string | null;
}

/** Every plaque in wall order: claimed ones carry the finder and date, the rest stay a mystery. */
export function hallRows(lines: readonly HallLine[]): HallRow[] {
  const by = new Map(lines.map((l) => [l.id, l]));
  const claimed: HallRow[] = [];
  const open: HallRow[] = [];
  for (const p of PLAQUES) {
    const l = by.get(p.id);
    if (l) claimed.push({ label: p.label, name: l.name, date: fmtDate(l.foundAt) });
    else open.push({ label: p.hiddenLabel, name: null, date: null });
  }
  return [...claimed, ...open];
}

export function fmtDate(t: number): string {
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// ------------------------------------------------------------------------------------------- lines

/** "Online now: N · Total visits: M" with DataFast; our own player count without it. */
export function visitsLine(visits: HomeVisits | null, ourOnline: number | null): { online: string; total: string | null } | null {
  if (visits) return { online: fmtNum(visits.online), total: fmtNum(visits.total) };
  if (ourOnline === null) return null;
  return { online: fmtNum(ourOnline), total: null };
}

/** The online pill: a number, or an invitation when nobody's on. */
export function onlineLabel(n: number): { count: string; label: string } {
  if (n <= 0) return { count: "", label: "Be the first one online" };
  return { count: fmtNum(n), label: n === 1 ? "player online" : "players online" };
}

/** Names line under a world's count: "Wren_07, Mossback and 3 more". */
export function namesLine(names: readonly string[], players: number): string {
  if (!players) return "Nobody right now";
  if (!names.length) return `${players} ${players === 1 ? "player" : "players"}`;
  const more = players - names.length;
  return more > 0 ? `${names.join(", ")} and ${more} more` : names.join(", ");
}
