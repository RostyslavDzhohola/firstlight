// The hologram board's canvas (D-gfx-hub-3): both pages drawn side by side with the 2D context, once
// per change of data. No three, so the layout is testable against a recording context.
//
// A row is: rank, name (and a small note under it), value on the right. The value's width is
// measured first and the name gets what is left: cut by measureText() and clipped to its rectangle,
// so a name of sixteen wide characters can neither run under the value nor into the next page
// (review A4). Each page is clipped to its own half of the canvas.

import { fitText, type HoloPage } from "./holoBoardModel.ts";

/** One page on the canvas (px), its side margin, where names start and the gap kept before the value. */
export const HOLO_PAGE = { w: 512, h: 672, margin: 34, nameIndent: 46, gap: 16 } as const;
/** The most of a row's width its right-hand value may take (the name keeps the rest). */
export const HOLO_VALUE_SHARE = 0.5;

const GOLD = "#ffd27a";
const INK = "#d9f8ff";
const DIM = "#6fb9cc";
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
  g.font = `800 46px ${SANS}`;
  g.fillStyle = GOLD;
  centred(g, page.title.split("").join("  "), x0, 66);
  g.font = `600 25px ${SANS}`;
  g.fillStyle = INK;
  centred(g, page.subtitle.split("").join(" "), x0, 104);
  g.fillStyle = DIM;
  g.fillRect(L, 122, R - L, 2);
  let y = 122;
  const rowH = page.sections.length > 1 ? 50 : 56;
  for (const s of page.sections) {
    y += 34;
    g.font = `600 18px ${MONO}`;
    g.fillStyle = DIM;
    g.textAlign = "left";
    fitted(g, s.heading, L, y, R - L, y - 22, 30);
    y += 12;
    if (!s.rows.length) {
      y += 44;
      g.font = `500 23px ${SANS}`;
      g.fillStyle = INK;
      centred(g, s.empty, x0, y);
      y += 34;
      continue;
    }
    for (let i = 0; i < s.rows.length; i++) {
      const r = s.rows[i]!;
      y += rowH;
      const top = i === 0;
      const base = y - (r.note ? 8 : 0);
      g.textAlign = "left";
      g.font = `600 22px ${MONO}`;
      g.fillStyle = top ? GOLD : DIM;
      fitted(g, r.rank, L, base, nameIndent - 6, y - rowH + 6, rowH);
      // The value first: its measured width is the column the name must stay out of.
      g.font = `700 24px ${MONO}`;
      const value = fitText(r.value, (R - L) * HOLO_VALUE_SHARE, (t) => g.measureText(t).width);
      const valueW = g.measureText(value).width;
      g.fillStyle = top ? GOLD : INK;
      g.textAlign = "right";
      g.fillText(value, R, base);
      g.textAlign = "left";
      const nameX = L + nameIndent;
      const nameW = R - valueW - gap - nameX;
      g.font = `${top ? 700 : 600} 30px ${SANS}`;
      fitted(g, r.name, nameX, base, nameW, y - rowH + 6, rowH);
      if (r.note) {
        g.font = `500 15px ${SANS}`;
        g.fillStyle = DIM;
        fitted(g, r.note, nameX - 1, y + 10, nameW, y - 6, 22);
      }
    }
    y += 18;
  }
  g.fillStyle = DIM;
  g.fillRect(L, PAGE_H - 58, R - L, 2);
  g.font = `600 18px ${MONO}`;
  centred(g, page.footer, x0, PAGE_H - 28);
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
