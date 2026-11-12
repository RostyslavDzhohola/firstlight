// The hologram board's canvas (D-gfx-hub-3): both pages drawn side by side with the 2D context, once
// per change of data. No three, so the layout is testable against a recording context.
//
// A row is: rank, name (and a small note under it), value on the right. The value's width is
// measured first and the name gets what is left: cut by measureText() and clipped to its rectangle,
// so a name of sixteen wide characters can neither run under the value nor into the next page
// (review A4). Each page is clipped to its own half of the canvas.

import { fitText, type HoloPage } from "./holoBoardModel.ts";

/** One page on the canvas (px), its side margin, where names start and the gap kept before the value. */
export const HOLO_PAGE = { w: 512, h: 672, margin: 30, nameIndent: 58, gap: 14 } as const;
/** The most of a row's width its right-hand value may take (the name keeps the rest). */
export const HOLO_VALUE_SHARE = 0.5;

const GOLD = "#ffd27a";
const INK = "#d9f8ff";
const DIM = "#6fb9cc";
/** Section headings (the column labels): read from the pad, so brighter than the rules and ranks. */
const HEAD = "#a9ecfb";
const SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";

type Ctx = CanvasRenderingContext2D;

/** Draw `text` in the current font and fill, cut to `w` and clipped to the rectangle (x, top, w, h). */
function fitted(g: Ctx, text: string, x: number, baseline: number, w: number, top: number, h: number) {
  if (w <= 0 || !text) return;
  const shown = fitText(text, w, (s) => g.measureText(s).width);
  if (!shown) return;
  g.save();
  g.beginPath();
  g.rect(x, top, w, h);
  g.clip();
  g.fillText(shown, x, baseline);
  g.restore();
}

/** Centred text that stays inside the page's margins. */
function centred(g: Ctx, text: string, x0: number, baseline: number) {
  const w = HOLO_PAGE.w - HOLO_PAGE.margin * 2;
  g.textAlign = "center";
  g.fillText(fitText(text, w, (s) => g.measureText(s).width), x0 + HOLO_PAGE.w / 2, baseline);
}

function drawPage(g: Ctx, x0: number, page: HoloPage) {
  const { w: PAGE_W, h: PAGE_H, margin, nameIndent, gap } = HOLO_PAGE;
  const L = x0 + margin, R = x0 + PAGE_W - margin;
  g.save();
  g.beginPath();
  g.rect(x0, 0, PAGE_W, PAGE_H);
  g.clip();
  g.textBaseline = "alphabetic";
  // Title, letter-spaced.
  g.font = `800 56px ${SANS}`;
  g.fillStyle = GOLD;
  centred(g, page.title.split("").join(" "), x0, 64);
  g.font = `700 31px ${SANS}`;
  g.fillStyle = INK;
  centred(g, page.subtitle, x0, 104);
  g.fillStyle = DIM;
  g.fillRect(L, 119, R - L, 3);
  let y = 120;
  // Few, bold rows (D-polish-3): five on a one-table page, three a table on the other; type scales with the row.
  const rowH = page.sections.length > 1 ? 62 : 84;
  const nameF = Math.round(rowH * 0.52), valueF = Math.round(rowH * 0.42), rankF = Math.round(rowH * 0.36), noteF = Math.round(rowH * 0.25);
  for (const s of page.sections) {
    y += 34;
    g.font = `700 25px ${MONO}`;
    g.fillStyle = HEAD;
    g.textAlign = "left";
    fitted(g, s.heading, L, y, R - L, y - 26, 34);
    y += 12;
    if (!s.rows.length) {
      y += 44;
      g.font = `600 32px ${SANS}`;
      g.fillStyle = INK;
      centred(g, s.empty, x0, y);
      y += 34;
      continue;
    }
    for (let i = 0; i < s.rows.length; i++) {
      const r = s.rows[i]!;
      y += rowH;
      const top = i === 0;
      const base = y - (r.note ? noteF * 0.75 : 0);
      g.textAlign = "left";
      g.font = `700 ${rankF}px ${MONO}`;
      g.fillStyle = top ? GOLD : DIM;
      fitted(g, r.rank, L, base, nameIndent - 6, y - rowH + 6, rowH);
      // The value first: its measured width is the column the name must stay out of.
      g.font = `700 ${valueF}px ${MONO}`;
      const value = fitText(r.value, (R - L) * HOLO_VALUE_SHARE, (t) => g.measureText(t).width);
      const valueW = g.measureText(value).width;
      g.fillStyle = top ? GOLD : INK;
      g.textAlign = "right";
      g.fillText(value, R, base);
      g.textAlign = "left";
      const nameX = L + nameIndent;
      const nameW = R - valueW - gap - nameX;
      g.font = `${top ? 800 : 700} ${nameF}px ${SANS}`;
      fitted(g, r.name, nameX, base, nameW, y - rowH + 6, rowH);
      if (r.note) {
        g.font = `600 ${noteF}px ${SANS}`;
        g.fillStyle = HEAD;
        fitted(g, r.note, nameX - 1, y + noteF * 0.55, nameW, y - noteF * 0.6, noteF * 1.5);
      }
    }
    y += 18;
  }
  g.fillStyle = DIM;
  g.fillRect(L, PAGE_H - 50, R - L, 2);
  g.font = `600 20px ${MONO}`;
  centred(g, page.footer, x0, PAGE_H - 20);
  g.restore();
}

/** Both pages on one canvas, side by side (the panel's shader picks one). */
export function drawHoloPages(canvas: HTMLCanvasElement, pages: readonly [HoloPage, HoloPage]) {
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, canvas.width, canvas.height);
  drawPage(g, 0, pages[0]);
  drawPage(g, HOLO_PAGE.w, pages[1]);
}
