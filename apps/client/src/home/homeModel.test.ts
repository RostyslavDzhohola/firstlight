import { describe, expect, it } from "vitest";
import type { HomeOnline } from "@firstlight/shared/net/home";
import { fmtPlayTime, hallRows, namesLine, onlineLabel, progressView, starterIndex, visitsLine, worldCards } from "./homeModel.ts";

const online: HomeOnline = {
  total: 5,
  bodies: {
    portus: { players: 2, names: ["Ashfall", "Wren_07"] },
    arcadia: { players: 3, names: ["Mossback"] },
    hollowmere: { players: 0, names: [] },
    meridian: { players: 0, names: [] },
  },
};

describe("home model", () => {
  it("lists the four worlds with level ranges, players, bosses and pads", () => {
    const w = worldCards(online);
    expect(w.map((x) => x.name)).toEqual(["Portus", "Arcadia", "Hollowmere", "Meridian"]);
    expect(w[0]).toMatchObject({ levels: "Safe · Lv 1–2", players: 2, boss: null, pads: 0 });
    expect(w[1]).toMatchObject({ levels: "Levels 1–7", players: 3, boss: { name: "Tidewrath", level: 8 }, pads: 12 });
    expect(w[2]).toMatchObject({ levels: "Levels 6–13", boss: { name: "The Hollow King", level: 14 } });
    expect(w[3]).toMatchObject({ levels: "Levels 12–20", boss: { name: "The Receiver", level: 20 }, pads: 20 });
    expect(worldCards(null)[1]!.players).toBe(0);
  });

  it("builds the progress card from /api/account/me (starter as a stored id or an index)", () => {
    const v = progressView({
      name: "Wanderer-1234",
      displayName: "Wren_07",
      guest: false,
      titleMedal: "regicide",
      character: { level: 3, xp: 50 + 140 + 60, coins: 214, starter: "unit7", palette: 1, body: "hollowmere" },
      medals: ["spark", "regicide", "not-a-medal"],
      pads: [{ body: "arcadia", padId: "1" }, { body: "arcadia", padId: "1" }, { body: "arcadia", padId: "4" }],
      playMs: 2 * 3600_000 + 14 * 60_000,
    });
    expect(v).toMatchObject({ name: "Wren_07", starter: 3, starterName: "Unit 7", level: 3, coins: 214, medals: 2, title: "Regicide", pads: 2, padsTotal: 44, body: "Hollowmere", playTime: "2 h 14 min", playing: true });
    expect(v.xpText).toBe("60 / 260 XP");
    expect(v.xpFrac).toBeCloseTo(60 / 260);
    expect(starterIndex(2)).toBe(2);
    expect(starterIndex(9)).toBe(0);
    expect(starterIndex("ash")).toBe(1);
    const guest = { name: "Wren_07", displayName: null, guest: true, titleMedal: null, character: null, medals: [], pads: [] };
    expect(progressView(guest, 2)).toMatchObject({ name: "Wren_07", level: 1, starter: 2, playing: false, title: null, playTime: "< 1 min" });
    expect(progressView({ ...guest, character: { level: 20, xp: 999_999, coins: 0, starter: 0, palette: 0, body: "meridian" } }).xpText).toBe("Max level");
  });

  it("formats play time", () => {
    expect(fmtPlayTime(0)).toBe("< 1 min");
    expect(fmtPlayTime(38 * 60_000 + 59_000)).toBe("38 min");
    expect(fmtPlayTime(3600_000)).toBe("1 h 0 min");
  });

  it("puts claimed Hall of Firsts plaques first, the rest as mysteries", () => {
    const rows = hallRows([{ id: "boss:tidewrath", name: "Mossback", foundAt: Date.UTC(2026, 9, 14) }]);
    expect(rows).toHaveLength(15);
    expect(rows[0]).toEqual({ label: "Tidewrath falls", name: "Mossback", date: "Oct 14" });
    expect(rows[1]).toEqual({ label: "Secret 1 · Arcadia", name: null, date: null });
  });

  it("says who's online and the visit counts", () => {
    expect(visitsLine({ online: 4, total: 12345 }, 2)).toEqual({ online: "4", total: "12,345" });
    expect(visitsLine(null, 2)).toEqual({ online: "2", total: null });
    expect(visitsLine(null, null)).toBeNull();
    expect(onlineLabel(0)).toEqual({ count: "", label: "Be the first one online" });
    expect(onlineLabel(1)).toEqual({ count: "1", label: "player online" });
    expect(onlineLabel(1284)).toEqual({ count: "1,284", label: "players online" });
    expect(namesLine([], 0)).toBe("Nobody right now");
    expect(namesLine(["Mossback"], 3)).toBe("Mossback and 2 more");
    expect(namesLine(["Ashfall", "Wren_07"], 2)).toBe("Ashfall, Wren_07");
    expect(namesLine([], 4)).toBe("4 players");
    expect(namesLine(["A", "B", "C", "D", "E"], 9)).toBe("A, B, C and 6 more");
  });
});
