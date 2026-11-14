import { describe, expect, it } from "vitest";
import { trackerRows } from "./trackerRows.ts";

const m = (id: string, done = false, progress = 0, goal = 8) => ({ id, done, progress, goal });
// What the play-tester held (2026-11-12): three guide missions, Kite Season and the Swift Gleam.
const HELD = [m("A1"), m("A2", false, 0, 1), m("A3", false, 0, 1), m("A4", false, 2, 5), m("T1", false, 0, 8)];

describe("mission tracker rows (D-polish-ux-1)", () => {
  it("never drops missions silently: the rest is a +N more line", () => {
    const r = trackerRows(HELD, "arcadia");
    expect(r.lines.map((l) => l.id)).toEqual(["A1", "A2", "A3"]);
    expect(r.more).toBe(2);
  });

  it("a running trial comes first", () => {
    const r = trackerRows(HELD, "arcadia", { trial: "A4" });
    expect(r.lines[0]!.id).toBe("A4");
    expect(r.lines[0]!.progress).toBe("2/5");
    expect(r.more).toBe(2);
  });

  it("the tracked mission comes first and is the one marked tracked (#69); a finished trial id no longer counts", () => {
    const r = trackerRows(HELD, "arcadia", { tracked: "T1" });
    expect(r.lines[0]!.id).toBe("T1");
    expect(r.lines.filter((l) => l.state === "tracked").map((l) => l.id)).toEqual(["T1"]);
    const done = HELD.map((x) => (x.id === "A4" ? { ...x, done: true } : x));
    expect(trackerRows(done, "arcadia", { trial: "A4" }).lines[0]!.id).toBe("A1");
  });

  it("missions on another planet say where", () => {
    const r = trackerRows([m("H1"), m("A1")], "arcadia");
    expect(r.lines[0]!.id).toBe("A1"); // nothing chosen: the one here is tracked
    expect(r.lines[1]!.detail.startsWith("On Hollowmere · ")).toBe(true);
    expect(r.lines[0]!.detail.startsWith("On ")).toBe(false);
    expect(trackerRows([m("H1"), m("A1")], "arcadia", { tracked: "H1" }).lines.find((l) => l.state === "tracked")?.id).toBe("H1");
  });

  it("done missions fill room only when nothing open is hidden", () => {
    expect(trackerRows([m("A1"), m("A2", true)], "arcadia").lines.map((l) => [l.id, l.progress])).toEqual([["A1", "0/8"], ["A2", "Done"]]);
    expect(trackerRows([m("A1")], "arcadia").lines[0]!.colour).toMatch(/^#[0-9a-f]{6}$/);
    expect(trackerRows([...HELD, m("A2", true)], "arcadia").lines.every((l) => l.state !== "done")).toBe(true);
    expect(trackerRows([], "arcadia")).toEqual({ lines: [], more: 0, header: "" });
  });
});
