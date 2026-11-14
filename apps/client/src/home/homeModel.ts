// The home page's pure parts (6a): the worlds list, the progress card, the leaderboard rows and the
// text lines, built from shared content and the /api/home and /api/account/me answers. No DOM.

import { BODIES, BODY_IDS, type BodyId } from "@firstlight/shared/planet/bodies";
import { BOSS_BY_BODY, npcDef, PORTUS_WILDS } from "@firstlight/shared/content/npcs";
import { MEDAL_BY_ID, MEDALS } from "@firstlight/shared/content/medals";
import { LEVEL_CAP, xpAtLevel, xpToNext } from "@firstlight/shared/content/progression";
import { PLAQUES, type HallLine } from "@firstlight/shared/content/secrets";
import { STARTERS, starterLook } from "@firstlight/shared/content/weapons";
import { GLEAMS } from "@firstlight/shared/content/gleams";
import { MISSION_BY_ID } from "@firstlight/shared/content/missions";
import { SPELLS } from "@firstlight/shared/content/spells";
import { starterStats } from "@firstlight/shared/content/starters";
import type { HomeOnline, HomeVisits } from "@firstlight/shared/net/home";

// ------------------------------------------------------------------------------------------- worlds

/** What follows the world's line on its card (the line itself is LINE below). */
const BLURB: Record<BodyId, string> = {
  portus: "Shop, portals and the Hall of Firsts. Creeps roam outside its walls.",
  arcadia: "Where the Brightbits roam.",
  hollowmere: "The Hollow Court keeps the fen.",
  meridian: "Run by Meridian Oversight.",
};
/** One line per world: the world cards' headline and the in-game arrival card (ui/arrivalCard.ts). */
const LINE: Record<BodyId, string> = {
  portus: "The castle town between the worlds",
  arcadia: "Golden meadows round Glasswater Lake",
  hollowmere: "Violet dusk over Mourning Mere",
  meridian: "Red canyons and chrome spires",
};
export const worldLine = (id: BodyId): string => LINE[id];
/** "Levels 1–7"; Portus: "Safe · Lv 1–2" (the creeps outside its walls). */
export function worldLevels(id: BodyId): string {
  const b = BODIES[id];
  return b.levels[1] > 0 ? `Levels ${b.levels[0]}–${b.levels[1]}` : `Safe · Lv ${PORTUS_LEVELS[0]}–${PORTUS_LEVELS[1]}`;
}
const PADS: Record<string, number> = { icosa: 12, dodeca: 20, none: 0 };
/** Portus: the town is safe; the creeps outside its walls (D-zones-1) span these levels. */
const PORTUS_LEVELS = (() => {
  const lv = PORTUS_WILDS.flatMap((g) => g.members.map((m) => m.level));
  return [Math.min(...lv), Math.max(...lv)] as const;
})();

export interface WorldCard {
  id: BodyId;
  name: string;
  /** The short headline line ("Golden meadows round Glasswater Lake"). */
  line: string;
  blurb: string;
  /** "Levels 1–7"; for Portus "Safe · Lv 1–2" (the creeps outside its walls; short enough to fit the header beside the planet). */
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
      line: LINE[id],
      blurb: BLURB[id],
      levels: worldLevels(id),
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
  character: { level: number; xp: number; coins: number; starter: number | string; palette: number; look?: number; body: string } | null;
  medals: string[];
  pads: { body: string; padId: string }[];
  playMs?: number;
  /** A guest the server will email a code for (level 2+, D34); older servers omit it. */
  saveReady?: boolean;
}

export interface ProgressView {
  name: string;
  guest: boolean;
  starter: number;
  /** STARTER_LOOKS index (the portrait). */
  look: number;
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

export function progressView(me: MeInfo, fallbackStarter = 0, fallbackLook = 0): ProgressView {
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
    look: c ? starterLook(starter, c.look) : starterLook(starter, fallbackLook),
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

/** "2 h 14 min", "38 min", "< 1 min". */
export function fmtPlayTime(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return "< 1 min";
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

/** Names line under a world's count: "Wren_07, Mossback, Ashfall and 3 more" (short enough to fit). */
export function namesLine(names: readonly string[], players: number, max = 3): string {
  if (!players) return "Nobody right now";
  if (!names.length) return `${players} ${players === 1 ? "player" : "players"}`;
  const shown = names.slice(0, max);
  const more = players - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

// ------------------------------------------------------------------------------- the hero and its stills

/**
 * The hero's in-game stills (D-home-9), by their ids in ui/loadingStills.ts STILLS, in the order they
 * cross-fade: the hub first (it is in index.html, so it paints with the page), then one per planet.
 */
export const HERO_STILLS = ["portus-plaza-dusk", "arcadia-lake", "hollowmere-planet", "meridian-mesa", "portus-portal"] as const;
/** The still on each world's card. */
export const WORLD_STILL: Record<BodyId, string> = { portus: "portus-above", arcadia: "arcadia-pond", hollowmere: "hollowmere-fen", meridian: "meridian-waystation" };

/** How long a hero still holds before the next fades in (ms), and the fade (home.css). */
export const HERO_HOLD_MS = 7000;
export const HERO_FADE_MS = 2200;

/** The stills in hero order; ids the build doesn't have are skipped. */
export function heroStills<T extends { id: string }>(all: readonly T[], ids: readonly string[] = HERO_STILLS): T[] {
  return ids.map((id) => all.find((s) => s.id === id)).filter((s): s is T => !!s);
}

/** The line under Play: who is in the worlds right now, or an invitation when it is empty. */
export function heroLive(online: HomeOnline | null): string | null {
  if (!online) return null;
  const { count, label } = onlineLabel(online.total);
  return count ? `${count} ${label} right now` : label;
}

// ------------------------------------------------------------------------------------- what is new

export interface NewsTile {
  id: "spells" | "hunt" | "starters";
  title: string;
  text: string;
  /** Sprites shown on the tile (ui/sprites.ts), each with a short label under it. */
  icons: { sprite: string; label: string }[];
  /** A line of live state under the text (the hunt's), or null. */
  state: string | null;
  /** Whether `state` is good news already claimed (styled as done) or still open. */
  claimed?: boolean;
}

/** The hunt's public state from the Hall of Firsts: who opened the Gleam Vault first, or that nobody has. */
export function huntState(hall: readonly HallLine[] | null): { text: string; claimed: boolean } | null {
  if (!hall) return null;
  const first = hall.find((l) => l.id === GLEAMS.firsts);
  return first ? { text: `First opened by ${first.name} · ${fmtDate(first.foundAt)}`, claimed: true } : { text: "The vault has never been opened. Be the first.", claimed: false };
}

/** The three tiles of "New in the worlds", written from the shared content so they can't go stale. */
export function newsTiles(hall: readonly HallLine[] | null): NewsTile[] {
  const hunt = huntState(hall);
  const levels = SPELLS.map((s) => s.level);
  const trials = GLEAMS.trials.map((id) => MISSION_BY_ID.get(id)!);
  const traits = (i: number) => starterStats(i).traits[0] ?? "";
  return [
    {
      id: "spells", title: "A spellbook for everyone",
      text: `Four spells on ${SPELLS.map((s) => s.keycap).join(" ")}, next to whatever weapon you carry: a blink, a ring of frost, a falling star, a glass ward. They open at levels ${levels.slice(0, -1).join(", ")} and ${levels.at(-1)}.`,
      icons: SPELLS.map((s) => ({ sprite: `spell-${s.id}`, label: s.keycap })),
      state: null,
    },
    {
      id: "hunt", title: `The hunt: ${GLEAMS.name}`,
      text: `One gleam on each planet, each won by a different skill: a ring race on ${BODIES[trials[0]!.body].name}, a beacon to hold on ${BODIES[trials[1]!.body].name}, shards to gather on ${BODIES[trials[2]!.body].name}. Bring all three home and the vault in Portus opens.`,
      icons: trials.map((t) => ({ sprite: "prism", label: BODIES[t.body].name })),
      state: hunt?.text ?? null,
      claimed: hunt?.claimed,
    },
    {
      id: "starters", title: "Five starters that play differently",
      text: "Each has its own weapon, health, pace and dodge: one strength paid for by one weakness. Pick again every time you are reborn.",
      icons: STARTERS.map((st, i) => ({ sprite: HEAD_SPRITES[i] ?? "head-unit7", label: traits(i) })),
      state: null,
    },
  ];
}
const HEAD_SPRITES = ["head-hexwick", "head-ash", "head-kappa", "head-unit7", "head-ninja"];

/** The agents guide in the public repo (shown only once the repo is public). */
export function agentsGuideUrl(repoUrl: string): string {
  return `${repoUrl.replace(/\/$/, "")}/blob/main/docs/agents/playing.md`;
}

/** One way to bring an agent in, as the home page's "Bring your agent" block shows it. */
export interface AgentCommand {
  id: "claude" | "codex" | "curl";
  label: string;
  text: string;
}

/**
 * The one-URL joins for this server's API origin (D-agents-gw-1): the remote MCP endpoint for Claude
 * Code and Codex, and the plain HTTP API in three curl lines (the seat handle the join returns goes
 * in `$SEAT`).
 */
export function agentCommands(apiUrl: string): AgentCommand[] {
  const api = apiUrl.replace(/\/+$/, "");
  return [
    { id: "claude", label: "Claude Code", text: `claude mcp add --transport http firstlight ${api}/mcp` },
    { id: "codex", label: "Codex", text: `codex mcp add firstlight --url ${api}/mcp` },
    {
      id: "curl",
      label: "curl",
      text: [
        `SEAT=$(curl -s -X POST ${api}/api/agent/join -d '{"name":"Scout_7"}' | sed -E 's/.*"seat":"([^"]+)".*/\\1/')`,
        `curl -s ${api}/api/agent/observe -H "Authorization: Bearer $SEAT"`,
        `curl -s -X POST ${api}/api/agent/act -H "Authorization: Bearer $SEAT" -d '{"tool":"move","target":"portal:arcadia"}'`,
      ].join("\n"),
    },
  ];
}
