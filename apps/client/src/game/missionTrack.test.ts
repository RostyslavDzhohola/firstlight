import { describe, expect, it } from "vitest";
import { MissionTrack } from "./missionTrack.ts";

function store() {
  const data = new Map<string, string>();
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
}
const m = (id: string, done = false) => ({ id, done });

describe("the tracked mission (#69)", () => {
  it("with nothing chosen, the default rule picks one (here first) and that becomes the choice", () => {
    const t = new MissionTrack(store());
    expect(t.settle([m("H1"), m("A1")], "arcadia")?.id).toBe("A1");
    expect(t.chosen).toBe("A1");
  });

  it("a newly accepted mission is tracked only if nothing is", () => {
    const t = new MissionTrack(store());
    t.settle([m("A1")], "arcadia");
    expect(t.settle([m("A1"), m("A2")], "arcadia", ["A2"])?.id).toBe("A1");
    const fresh = new MissionTrack(store());
    expect(fresh.settle([m("A3")], "arcadia", ["A3"])?.id).toBe("A3");
    // The tracked one finished: the next accepted one takes over.
    expect(fresh.settle([m("A3", true), m("A4")], "arcadia", ["A4"])?.id).toBe("A4");
  });

  it("the player's choice wins over the default rule while it's open, survives a reload, and is dropped once done", () => {
    const s = store();
    const t = new MissionTrack(s);
    let heard: (string | null)[] = [];
    t.onChange((id) => heard.push(id));
    t.choose("H1");
    expect(new MissionTrack(s).chosen).toBe("H1");
    expect(t.settle([m("A1"), m("H1")], "arcadia")?.id).toBe("H1");
    expect(t.settle([m("A1"), m("H1", true)], "arcadia")?.id).toBe("A1");
    expect(heard).toEqual(["H1", "A1"]);
    heard = [];
    t.settle([], "arcadia");
    expect(t.chosen).toBeNull();
    expect(heard).toEqual([null]);
  });

  it("an unknown saved id is ignored; next steps through the open ones and wraps", () => {
    const s = store();
    s.setItem("fl.trackedMission.v1", "ZZ9");
    const t = new MissionTrack(s);
    expect(t.chosen).toBeNull();
    t.choose("A1");
    const list = [m("A1"), m("A2", true), m("A3")];
    expect(t.nextAfter(list)?.id).toBe("A3");
    t.choose("A3");
    expect(t.nextAfter(list)?.id).toBe("A1");
    expect(t.nextAfter([])).toBeNull();
  });
});
