// The Portus hologram scoreboard's pure part (D-gfx-hub-3): what each page says, from the home
// page's public data (GET /api/home: display names only). No DOM, no three.
//
// Two pages share one texture, side by side. Page 0 is the level table; page 1 is the medal table
// and, under it, the hunt: `holoPages(data, hunt)` takes the hunt's lines from whoever has them (the
// missions lane's three-trial hunt), and shows a "sealed" placeholder until then.

import type { HomeData } from "@firstlight/shared/net/home";

export const HOLO_TITLE = "FIRSTLIGHT";
/** Rows a page's table shows. */
export const HOLO_ROWS = 8;
export const HOLO_MEDAL_ROWS = 4;
/** Seconds a page stays up before the board flips. */
export const HOLO_PAGE_SECONDS = 11;
/** How often the board asks the server again (ms). */
export const HOLO_REFRESH_MS = 4 * 60_000;
/** Longest name drawn; longer ones end in an ellipsis. */
export const HOLO_NAME_MAX = 16;

export interface HoloRow {
  rank: string;
  name: string;
  /** Right-hand value: "Lv 12", "3 medals". */
  value: string;
  /** Small line under the name (a worn title), or "". */
  note: string;
}

export interface HoloSection {
  heading: string;
  rows: HoloRow[];
  /** Shown instead of rows when there are none. */
  empty: string;
}

export interface HoloPage {
  title: string;
  subtitle: string;
  sections: HoloSection[];
  footer: string;
}

/** The hunt's block on page 1: the missions lane (or the lead) fills it; null shows the placeholder. */
export interface HoloHunt {
  heading: string;
  rows: HoloRow[];
  empty?: string;
}

export function clipName(name: string, max = HOLO_NAME_MAX): string {
  const n = name.trim() || "Traveller";
  return n.length > max ? `${n.slice(0, max - 1)}…` : n;
}

const rank = (i: number) => String(i + 1).padStart(2, "0");

function onlineLine(data: HomeData | null): string {
  const n = data?.online.total ?? 0;
  if (!data) return "SIGNAL LOST · RETRYING";
  if (n <= 0) return "THE WORLDS ARE QUIET";
  return n === 1 ? "1 TRAVELLER IN THE WORLDS" : `${n} TRAVELLERS IN THE WORLDS`;
}

/** The board's two pages. `data` null: the server didn't answer (or offline). */
export function holoPages(data: HomeData | null, hunt: HoloHunt | null = null): [HoloPage, HoloPage] {
  const board = data?.board ?? null;
  const levels: HoloRow[] = (board?.levels ?? []).slice(0, HOLO_ROWS).map((r, i) => ({ rank: rank(i), name: clipName(r.name), value: `LV ${r.level}`, note: r.title ?? "" }));
  const medals: HoloRow[] = (board?.medals ?? [])
    .filter((r) => r.medals > 0)
    .slice(0, HOLO_MEDAL_ROWS)
    .map((r, i) => ({ rank: rank(i), name: clipName(r.name), value: r.medals === 1 ? "1 MEDAL" : `${r.medals} MEDALS`, note: r.title ?? "" }));
  const footer = onlineLine(data);
  return [
    {
      title: HOLO_TITLE,
      subtitle: "TOP TRAVELLERS",
      sections: [{ heading: "HIGHEST LEVEL · THIS LIFE", rows: levels, empty: data ? "No names yet. Yours could be the first." : "Waiting for the tally…" }],
      footer,
    },
    {
      title: HOLO_TITLE,
      subtitle: "HALL OF FIRSTS",
      sections: [
        { heading: "MOST MEDALS", rows: medals, empty: data ? "No medals won yet." : "Waiting for the tally…" },
        { heading: hunt?.heading ?? "THE HUNT", rows: hunt?.rows.slice(0, HOLO_MEDAL_ROWS) ?? [], empty: hunt?.empty ?? "Three trials. Sealed, for now." },
      ],
      footer,
    },
  ];
}

/** Which page shows at `t` seconds, and how far into a flip it is (0 none … 1 mid-flip). */
export function holoPageAt(t: number, pageSeconds = HOLO_PAGE_SECONDS, flipSeconds = 0.5): { page: 0 | 1; flip: number } {
  const k = Math.max(0, t) / pageSeconds;
  const page = (Math.floor(k) % 2) as 0 | 1;
  const into = (k - Math.floor(k)) * pageSeconds;
  const left = pageSeconds - into;
  // The flicker straddles the change: the last and the first half of `flipSeconds`.
  const d = Math.min(into, left);
  return { page, flip: d < flipSeconds / 2 ? 1 - d / (flipSeconds / 2) : 0 };
}
