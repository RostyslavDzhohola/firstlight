import { describe, expect, it } from "vitest";
import type { HomeData } from "@firstlight/shared/net/home";
import { clipName, gleamMarks, HOLO_HUNT_ROWS, HOLO_MEDAL_ROWS, HOLO_NAME_MAX, HOLO_PAGE_SECONDS, HOLO_ROWS, holoDate, holoHunt, holoPageAt, holoPages } from "./holoBoardModel.ts";

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

describe("the Three Gleams on the board", () => {
  const NOV12 = Date.UTC(2026, 10, 12, 21, 5);

  it("unclaimed: says so, counts no Gleamkeepers, and shows your three marks dark", () => {
    const h = holoHunt({ keepers: 0, first: [] }, { won: 0, opened: false });
    expect(h.heading).toBe("THE THREE GLEAMS");
    expect(h.rows).toEqual([
      { rank: "1ST", name: "Unclaimed", value: "", note: "Be the first to open the vault" },
      { rank: "", name: "Gleamkeepers", value: "0", note: "" },
      { rank: "YOU", name: "Your gleams", value: "◇ ◇ ◇", note: "Ask Sela Marchbank, west of the pad" },
    ]);
  });

  it("claimed: the first finisher by name and date (UTC), the count, your gleams lit one by one", () => {
    const h = holoHunt({ keepers: 3, first: [{ name: "Mossback_the_Unyielding", at: NOV12 }, { name: "Wren", at: NOV12 + 1 }] }, { won: 2, opened: false });
    expect(h.rows[0]).toEqual({ rank: "1ST", name: clipName("Mossback_the_Unyielding"), value: "NOV 12", note: "FIRST TO OPEN THE VAULT" });
    expect(h.rows[0]!.name.length).toBeLessThanOrEqual(HOLO_NAME_MAX);
    expect(h.rows[1]!.value).toBe("3");
    expect(h.rows[2]!.value).toBe("◆ ◆ ◇");
    expect(holoHunt({ keepers: 3, first: [] }, { won: 3, opened: false }).rows[2]!.note).toMatch(/vault is listening/);
    expect(holoHunt({ keepers: 3, first: [] }, { won: 3, opened: true }).rows[2]!.note).toMatch(/opened for you/);
  });

  it("without the server's tally (offline, an older server) only your own row; without a character, only the tally", () => {
    expect(holoHunt(undefined, { won: 1, opened: false }).rows.map((r) => r.name)).toEqual(["Your gleams"]);
    expect(holoHunt({ keepers: 1, first: [{ name: "Wren", at: NOV12 }] }, null).rows.map((r) => r.name)).toEqual(["Wren", "Gleamkeepers"]);
    const none = holoHunt(undefined, null);
    expect(none.rows).toEqual([]);
    expect(none.empty).toMatch(/Waiting/);
  });

  it("fits the panel: at most three rows under the medal table, short names and notes", () => {
    const h = holoHunt({ keepers: 12_345, first: [{ name: "x".repeat(40), at: NOV12 }] }, { won: 3, opened: true });
    expect(h.rows.length).toBeLessThanOrEqual(HOLO_HUNT_ROWS);
    for (const r of h.rows) {
      expect(r.name.length).toBeLessThanOrEqual(HOLO_NAME_MAX);
      expect(r.note.length).toBeLessThanOrEqual(36);
      expect(r.value.length).toBeLessThanOrEqual(6);
    }
    const [, p1] = holoPages(data(0, 4), { heading: "X", rows: Array.from({ length: 6 }, (_, i) => ({ rank: "", name: `n${i}`, value: "", note: "" })) });
    expect(p1.sections[1]!.rows).toHaveLength(HOLO_HUNT_ROWS); // a fourth would run into the footer
    const [, q1] = holoPages(data(0, 4), h);
    expect(q1.sections[1]!.heading).toBe("THE THREE GLEAMS");
  });

  it("marks and dates", () => {
    expect([gleamMarks(0), gleamMarks(1), gleamMarks(3), gleamMarks(7), gleamMarks(-1)]).toEqual(["◇ ◇ ◇", "◆ ◇ ◇", "◆ ◆ ◆", "◆ ◆ ◆", "◇ ◇ ◇"]);
    expect(holoDate(Date.UTC(2027, 0, 3))).toBe("JAN 3");
  });
});

describe("holoPageAt per frame (review A5)", () => {
  it("writes into the object it is given and returns it, with the same answers", () => {
    const out = { page: 0 as 0 | 1, flip: 0 };
    for (const t of [0, 0.6, HOLO_PAGE_SECONDS - 0.05, HOLO_PAGE_SECONDS + 0.05, HOLO_PAGE_SECONDS * 1.5, HOLO_PAGE_SECONDS * 7.3]) {
      const fresh = holoPageAt(t);
      expect(holoPageAt(t, HOLO_PAGE_SECONDS, undefined, out)).toBe(out);
      expect(out).toEqual(fresh);
    }
  });

  it("the board keeps one flip object for its frames", async () => {
    const src = await (await import("node:fs/promises")).readFile(new URL("./HoloBoard.ts", import.meta.url), "utf8");
    const calls = src.match(/holoPageAt\(([^)]*)\)/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("this.flip");
  });
});
