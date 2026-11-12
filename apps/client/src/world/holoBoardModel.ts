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

/**
 * Characters that never reach the board: C0/C1 controls, the bidirectional marks, embeddings,
 * overrides and isolates (a name must not reorder the row it sits in), line separators, the
 * zero-width space and the byte-order mark. The joiners (U+200C/D) stay: scripts and emoji need them.
 */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;

/** Text as the board may draw it: no control or direction characters, single spaces, trimmed. */
export function cleanText(text: string): string {
  return text.replace(/[\t\n\r\u2028\u2029]+/g, " ").replace(UNSAFE, "").replace(/\s+/g, " ").trim();
}

/** What the user sees as one character each (a flag, an accented letter, a family emoji). */
export function graphemes(text: string): string[] {
  const Seg = (Intl as { Segmenter?: new (l?: string, o?: { granularity: "grapheme" }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  if (!Seg) return Array.from(text);
  const out: string[] = [];
  for (const g of new Seg(undefined, { granularity: "grapheme" }).segment(text)) out.push(g.segment);
  return out;
}

/** A display name for the board: cleaned (cleanText), at most `max` characters, never empty. */
export function clipName(name: string, max = HOLO_NAME_MAX): string {
  const n = graphemes(cleanText(name));
  if (!n.length) return "Traveller";
  return n.length > max ? `${n.slice(0, max - 1).join("").trimEnd()}…` : n.join("");
}

/**
 * `text` cut to fit `maxWidth` as `measure` sees it (a canvas' measureText at the font it will be
 * drawn in), ending in an ellipsis when cut. Cuts between whole characters, never inside one.
 */
export function fitText(text: string, maxWidth: number, measure: (s: string) => number): string {
  if (measure(text) <= maxWidth) return text;
  const parts = graphemes(text);
  const cut = (n: number) => `${parts.slice(0, n).join("").trimEnd()}…`;
  let lo = 0, hi = parts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(cut(mid)) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  if (lo > 0) return cut(lo);
  return measure("…") <= maxWidth ? "…" : "";
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
  const levels: HoloRow[] = (board?.levels ?? []).slice(0, HOLO_ROWS).map((r, i) => ({ rank: rank(i), name: clipName(r.name), value: `LV ${r.level}`, note: cleanText(r.title ?? "") }));
  const medals: HoloRow[] = (board?.medals ?? [])
    .filter((r) => r.medals > 0)
    .slice(0, HOLO_MEDAL_ROWS)
    .map((r, i) => ({ rank: rank(i), name: clipName(r.name), value: r.medals === 1 ? "1 MEDAL" : `${r.medals} MEDALS`, note: cleanText(r.title ?? "") }));
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
        {
          // The hunt's lines come from another system (and its names from players): cleaned like the rest.
          heading: cleanText(hunt?.heading ?? "") || "THE HUNT",
          rows: (hunt?.rows ?? []).slice(0, HOLO_MEDAL_ROWS).map((r) => ({ rank: cleanText(r.rank), name: clipName(r.name), value: cleanText(r.value), note: cleanText(r.note) })),
          empty: cleanText(hunt?.empty ?? "") || "Three trials. Sealed, for now.",
        },
      ],
      footer,
    },
  ];
}

export interface HoloFlip {
  page: 0 | 1;
  /** How far into a flip the board is: 0 none … 1 mid-flip. */
  flip: number;
}

/**
 * Which page shows at `t` seconds, and how far into a flip it is. Written into `out` when given: the
 * board asks every frame and keeps one (review A5).
 */
export function holoPageAt(t: number, pageSeconds = HOLO_PAGE_SECONDS, flipSeconds = 0.5, out: HoloFlip = { page: 0, flip: 0 }): HoloFlip {
  const k = Math.max(0, t) / pageSeconds;
  const into = (k - Math.floor(k)) * pageSeconds;
  const left = pageSeconds - into;
  // The flicker straddles the change: the last and the first half of `flipSeconds`.
  const d = Math.min(into, left);
  out.page = (Math.floor(k) % 2) as 0 | 1;
  out.flip = d < flipSeconds / 2 ? 1 - d / (flipSeconds / 2) : 0;
  return out;
}
