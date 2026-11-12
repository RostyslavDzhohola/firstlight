import { describe, expect, it } from "vitest";
import type { HomeData } from "@firstlight/shared/net/home";
import { clipName, HOLO_MEDAL_ROWS, HOLO_PAGE_SECONDS, HOLO_ROWS, holoPageAt, holoPages } from "./holoBoardModel.ts";

const online = (total: number): HomeData["online"] => ({
  total,
  bodies: { portus: { players: total, names: [] }, arcadia: { players: 0, names: [] }, hollowmere: { players: 0, names: [] }, meridian: { players: 0, names: [] } },
});

function data(levels: number, medals: number, total = 3): HomeData {
  return {
    online: online(total),
    board: {
      levels: Array.from({ length: levels }, (_, i) => ({ name: `Wren_${i}`, level: 20 - i, starter: 0, title: i === 0 ? "Bellringer" : null })),
      medals: Array.from({ length: medals }, (_, i) => ({ name: `Moss_${i}`, medals: medals - i, title: null })),
      hall: [],
    },
    visits: null,
    at: 0,
  };
}

describe("the hologram scoreboard's pages", () => {
  it("lists the top travellers by level, ranked, with their titles, capped at the table's rows", () => {
    const [p0] = holoPages(data(12, 0));
    expect(p0.subtitle).toBe("TOP TRAVELLERS");
    const rows = p0.sections[0]!.rows;
    expect(rows).toHaveLength(HOLO_ROWS);
    expect(rows[0]).toEqual({ rank: "01", name: "Wren_0", value: "LV 20", note: "Bellringer" });
    expect(rows[7]!.rank).toBe("08");
    expect(p0.footer).toBe("3 TRAVELLERS IN THE WORLDS");
  });

  it("shows a friendly empty state when nobody is on the board, and says so when the server is silent", () => {
    const [p0, p1] = holoPages(data(0, 0, 0));
    expect(p0.sections[0]!.rows).toEqual([]);
    expect(p0.sections[0]!.empty).toMatch(/first/);
    expect(p0.footer).toBe("THE WORLDS ARE QUIET");
    expect(p1.sections[0]!.empty).toMatch(/No medals/);
    const [q0] = holoPages(null);
    expect(q0.sections[0]!.empty).toMatch(/Waiting/);
    expect(q0.footer).toMatch(/SIGNAL LOST/);
    expect(holoPages({ ...data(0, 0, 1), board: null })[0].footer).toBe("1 TRAVELLER IN THE WORLDS");
  });

  it("page 1 has the medal table (no zero-medal rows) and the hunt's block: sealed until someone fills it", () => {
    const d = data(2, 6);
    d.board!.medals[5]!.medals = 0;
    const [, p1] = holoPages(d);
    expect(p1.subtitle).toBe("HALL OF FIRSTS");
    expect(p1.sections[0]!.rows).toHaveLength(HOLO_MEDAL_ROWS);
    expect(p1.sections[0]!.rows[0]!.value).toBe("6 MEDALS");
    expect(p1.sections[1]).toMatchObject({ heading: "THE HUNT", rows: [] });
    expect(p1.sections[1]!.empty).toMatch(/Sealed/);
    const [, h1] = holoPages(d, { heading: "THE HUNT · TRIAL 2 OF 3", rows: [{ rank: "01", name: "Ashfall", value: "2 / 3", note: "" }] });
    expect(h1.sections[1]!.heading).toBe("THE HUNT · TRIAL 2 OF 3");
    expect(h1.sections[1]!.rows[0]!.name).toBe("Ashfall");
  });

  it("clips long names and names an empty one", () => {
    expect(clipName("A".repeat(30))).toHaveLength(16);
    expect(clipName("A".repeat(30)).endsWith("…")).toBe(true);
    expect(clipName("  ")).toBe("Traveller");
  });

  it("flips between the two pages on a clock, flickering only round the change", () => {
    expect(holoPageAt(0.6)).toEqual({ page: 0, flip: 0 });
    expect(holoPageAt(HOLO_PAGE_SECONDS / 2)).toEqual({ page: 0, flip: 0 });
    expect(holoPageAt(HOLO_PAGE_SECONDS + 1)).toEqual({ page: 1, flip: 0 });
    expect(holoPageAt(HOLO_PAGE_SECONDS * 2 + 1).page).toBe(0);
    expect(holoPageAt(HOLO_PAGE_SECONDS - 0.05).flip).toBeGreaterThan(0.5);
    expect(holoPageAt(HOLO_PAGE_SECONDS + 0.05).flip).toBeGreaterThan(0.5);
  });
});
