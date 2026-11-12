// The board's rows on the canvas (review A4): the value column is reserved, names are cut by their
// measured width and clipped to their rectangle, and each page stays in its own half.
import { describe, expect, it } from "vitest";
import { drawHoloPages, HOLO_PAGE } from "./holoBoardDraw.ts";
import { cleanText, clipName, fitText, graphemes, HOLO_NAME_MAX, holoPages, type HoloPage } from "./holoBoardModel.ts";

interface Rect { x: number; y: number; w: number; h: number }
interface Drawn { text: string; x: number; y: number; align: string; font: string; width: number; clips: Rect[] }

/** Width of `text` at `font`: capitals, W/M and CJK are wide, the rest narrow (a stand-in for real metrics). */
function widthOf(text: string, font: string): number {
  const px = Number(/(\d+)px/.exec(font)?.[1] ?? 10);
  let w = 0;
  for (const ch of text) w += /[WM@　-鿿\u{1f300}-\u{1faff}]/u.test(ch) ? px * 1.05 : /[A-Z0-9]/.test(ch) ? px * 0.7 : px * 0.5;
  return w;
}

/** A 2D context that records every fillText with the clip rectangles in force. */
function recorder() {
  const drawn: Drawn[] = [];
  let clips: Rect[] = [];
  let pending: Rect | null = null;
  const stack: Rect[][] = [];
  const g = {
    font: "10px sans",
    fillStyle: "",
    textAlign: "left",
    textBaseline: "alphabetic",
    save: () => void stack.push([...clips]),
    restore: () => void (clips = stack.pop() ?? []),
    beginPath: () => void (pending = null),
    rect: (x: number, y: number, w: number, h: number) => void (pending = { x, y, w, h }),
    clip: () => void (pending && clips.push(pending)),
    fillRect() {},
    measureText: (t: string) => ({ width: widthOf(t, g.font) }),
    fillText: (text: string, x: number, y: number) => void drawn.push({ text, x, y, align: g.textAlign, font: g.font, width: widthOf(text, g.font), clips: [...clips] }),
  };
  const canvas = { width: HOLO_PAGE.w * 2, height: HOLO_PAGE.h, getContext: () => g } as unknown as HTMLCanvasElement;
  return { canvas, drawn };
}

/** The horizontal span a drawn text covers. */
function span(d: Drawn): [number, number] {
  if (d.align === "right") return [d.x - d.width, d.x];
  if (d.align === "center") return [d.x - d.width / 2, d.x + d.width / 2];
  return [d.x, d.x + d.width];
}

const WIDE = "W".repeat(HOLO_NAME_MAX);
const page = (rows: HoloPage["sections"][number]["rows"]): HoloPage => ({ title: "FIRSTLIGHT", subtitle: "TOP TRAVELLERS", sections: [{ heading: "HIGHEST LEVEL", rows, empty: "" }], footer: "3 TRAVELLERS IN THE WORLDS" });

describe("holo board rows", () => {
  it("a name of sixteen wide characters is cut to what the row has left of the value column", () => {
    const { canvas, drawn } = recorder();
    const rows = [
      { rank: "01", name: WIDE, value: "LV 100", note: "Keeper of the Long Night Watch and Other Wide Titles" },
      { rank: "02", name: "Lark", value: "LV 7", note: "" },
    ];
    drawHoloPages(canvas, [page(rows), page([])]);
    const value = drawn.find((d) => d.text === "LV 100")!;
    const name = drawn.find((d) => d.text.startsWith("W"))!;
    expect(name.text.endsWith("…")).toBe(true);
    expect(name.text.length).toBeLessThan(WIDE.length);
    // Its measured width fits, with the gap kept before the value.
    expect(span(name)[1]).toBeLessThanOrEqual(span(value)[0] - HOLO_PAGE.gap + 1e-6);
    // And it is clipped to a rectangle that ends before the value column and inside page 1.
    const clip = name.clips[name.clips.length - 1]!;
    expect(clip.x).toBe(name.x);
    expect(clip.x + clip.w).toBeLessThanOrEqual(span(value)[0] - HOLO_PAGE.gap + 1e-6);
    expect(clip.x + clip.w).toBeLessThan(HOLO_PAGE.w);
    // The note under the name gets the same width.
    const note = drawn.find((d) => d.text.startsWith("Keeper"))!;
    expect(note.text.endsWith("…")).toBe(true);
    expect(span(note)[1]).toBeLessThanOrEqual(span(value)[0] - HOLO_PAGE.gap + 1e-6);
    // A short name is drawn whole.
    expect(drawn.some((d) => d.text === "Lark")).toBe(true);
  });

  it("the name's room follows the value's measured width, and a long value can't take the whole row", () => {
    const narrow = recorder();
    drawHoloPages(narrow.canvas, [page([{ rank: "01", name: WIDE, value: "LV 1", note: "" }]), page([])]);
    const wide = recorder();
    drawHoloPages(wide.canvas, [page([{ rank: "01", name: WIDE, value: "12 MEDALS", note: "" }]), page([])]);
    const n1 = narrow.drawn.find((d) => d.text.startsWith("W"))!, n2 = wide.drawn.find((d) => d.text.startsWith("W"))!;
    expect(n1.text.length).toBeGreaterThan(n2.text.length);
    const greedy = recorder();
    drawHoloPages(greedy.canvas, [page([{ rank: "01", name: "Lark", value: "M".repeat(60), note: "" }]), page([])]);
    const v = greedy.drawn.find((d) => d.text.startsWith("M"))!;
    expect(v.width).toBeLessThanOrEqual((HOLO_PAGE.w - HOLO_PAGE.margin * 2) / 2 + 1e-6);
    expect(greedy.drawn.some((d) => d.text === "Lark")).toBe(true);
  });

  it("every text of a page is clipped to that page's half and stays inside it", () => {
    const { canvas, drawn } = recorder();
    const rows = Array.from({ length: 8 }, (_, i) => ({ rank: String(i + 1).padStart(2, "0"), name: `${WIDE}${i}`, value: `LV ${99 - i}`, note: "" }));
    const long = "W".repeat(80);
    drawHoloPages(canvas, [
      { ...page(rows), footer: long },
      { title: "FIRSTLIGHT", subtitle: "HALL OF FIRSTS", sections: [{ heading: long, rows: [], empty: long }, { heading: "THE HUNT", rows: rows.slice(0, 4), empty: "" }], footer: long },
    ]);
    expect(drawn.length).toBeGreaterThan(30);
    for (const d of drawn) {
      const pageX = d.clips[0]!.x;
      expect([0, HOLO_PAGE.w]).toContain(pageX);
      expect(d.clips[0]).toMatchObject({ w: HOLO_PAGE.w, h: HOLO_PAGE.h });
      const [a, b] = span(d);
      expect(a).toBeGreaterThanOrEqual(pageX - 1e-6);
      expect(b).toBeLessThanOrEqual(pageX + HOLO_PAGE.w + 1e-6);
    }
    // Both pages drew something.
    expect(new Set(drawn.map((d) => d.clips[0]!.x)).size).toBe(2);
  });
});

describe("board text", () => {
  it("cleanText strips control characters and direction overrides", () => {
    expect(cleanText("‮live‬\u0007 Ro\u0000se⁦!⁩‏")).toBe("live Rose!");
    expect(cleanText("  two\t\nlines here  ")).toBe("two lines here");
    expect(cleanText("؜﻿​")).toBe("");
    // Joiners inside a script or an emoji sequence stay.
    expect(cleanText("👨‍👩‍👧")).toBe("👨‍👩‍👧");
  });

  it("clipName cleans, never returns an empty name, and counts whole characters", () => {
    expect(clipName("‮‮")).toBe("Traveller");
    expect(clipName("‮abc")).toBe("abc");
    const flags = "🇺🇦".repeat(HOLO_NAME_MAX + 4);
    const cut = clipName(flags);
    expect(graphemes(cut)).toHaveLength(HOLO_NAME_MAX);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.slice(0, -1)).toBe("🇺🇦".repeat(HOLO_NAME_MAX - 1));
  });

  it("holoPages cleans names, titles and the hunt's lines", () => {
    const data = { online: { total: 1 }, board: { levels: [{ name: "‮evil\u0001", level: 3, starter: 0, title: "The⁧ First" }], medals: [], hall: [] } } as never;
    const [p0, p1] = holoPages(data, { heading: "THE‮ HUNT", rows: [{ rank: "01", name: "A\u0000b", value: "2‏/3", note: "⁦x" }] });
    expect(p0.sections[0]!.rows[0]).toMatchObject({ name: "evil", note: "The First" });
    expect(p1.sections[1]).toMatchObject({ heading: "THE HUNT", rows: [{ rank: "01", name: "Ab", value: "2/3", note: "x" }] });
  });

  it("fitText cuts by measured width between whole characters", () => {
    const measure = (s: string) => widthOf(s, "10px sans");
    expect(fitText("Lark", 100, measure)).toBe("Lark");
    const cut = fitText("W".repeat(20), 60, measure);
    expect(measure(cut)).toBeLessThanOrEqual(60);
    expect(cut.endsWith("…")).toBe(true);
    expect(measure(`${cut.slice(0, -1)}W…`)).toBeGreaterThan(60); // the longest that fits
    const emoji = fitText("🌍🌍🌍🌍🌍🌍", 30, measure);
    expect(emoji).toBe("🌍🌍…");
    expect(fitText("WWWW", 2, measure)).toBe("");
  });
});
