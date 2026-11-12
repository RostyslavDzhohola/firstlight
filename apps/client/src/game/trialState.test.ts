import { describe, expect, it } from "vitest";
import { MISSION_BY_ID } from "@firstlight/shared/content/missions";
import type { TrialMsg } from "@firstlight/shared/net/protocol";
import { missionTargets } from "../ui/mapMarkers.ts";
import { clockLeft, formatClock, listenTrials, objectiveObject, trialHud, trialNow, trialSeen } from "./trialState.ts";

const msg = (o: Partial<TrialMsg>): TrialMsg => ({ id: "T1", kind: "race", state: "running", progress: 3, goal: 8, leftMs: 41_000, limitMs: 75_000, next: "t1_ring_4", ...o });

describe("trial clock and HUD line", () => {
  it("formats whole seconds, rounding up", () => {
    expect([formatClock(75_000), formatClock(9_001), formatClock(400), formatClock(0), formatClock(-5)]).toEqual(["1:15", "0:10", "0:01", "0:00", "0:00"]);
  });

  it("counts down from the receipt while running, holds while paused, zero when over", () => {
    expect(clockLeft({ msg: msg({}), at: 1000 }, 3000)).toBe(39_000);
    expect(clockLeft({ msg: msg({ state: "paused", kind: "defend", leftMs: 50_000 }), at: 1000 }, 9000)).toBe(50_000);
    expect(clockLeft({ msg: msg({ state: "failed" }), at: 0 }, 1)).toBe(0);
    expect(clockLeft({ msg: msg({ leftMs: 1000 }), at: 0 }, 5000)).toBe(0);
  });

  it("race: next ring of eight and the clock; urgent under ten seconds", () => {
    expect(trialHud({ msg: msg({}), at: 0 }, 0)).toEqual({ title: "The Swift Gleam", progress: "Ring 4 of 8", clock: "0:41", tone: "normal" });
    expect(trialHud({ msg: msg({ leftMs: 9000 }), at: 0 }, 0)?.tone).toBe("urgent");
  });

  it("defend: seconds held (extrapolated), paused text, the hold's clock", () => {
    const t = { msg: msg({ id: "T2", kind: "defend", progress: 30, goal: 90, leftMs: 60_000, limitMs: 90_000, next: "t2_beacon" }), at: 0 };
    expect(trialHud(t, 7000)).toMatchObject({ title: "The Steadfast Gleam", progress: "Held 37 of 90 s", clock: "0:53", tone: "normal" });
    expect(trialHud({ ...t, msg: { ...t.msg, state: "paused" } }, 7000)).toMatchObject({ progress: "Back to the beacon! Held 30 of 90 s", tone: "paused", clock: "1:00" });
  });

  it("collect: pieces of the goal; untimed has no clock; done and failed linger, then hide", () => {
    expect(trialHud({ msg: msg({ id: "A4", kind: "collect", progress: 2, goal: 5, leftMs: 0, limitMs: 0, next: null }), at: 0 }, 0)).toEqual({ title: "Kite Season", progress: "2 of 5 kite panels", clock: "", tone: "normal" });
    const done = { msg: msg({ id: "T3", kind: "collect", state: "done", progress: 8, goal: 8, limitMs: 240_000, next: null }), at: 0 };
    expect(trialHud(done, 1000)).toMatchObject({ progress: "8 of 8 gleam shards · complete", tone: "done" });
    expect(trialHud(done, 5000)).toBeNull();
    expect(trialHud({ msg: msg({ state: "failed", reason: "time" }), at: 0 }, 100)).toMatchObject({ progress: "Out of time", tone: "failed" });
    expect(trialHud({ msg: msg({ state: "idle" }), at: 0 }, 0)).toBeNull();
    expect(trialHud(null, 0)).toBeNull();
  });

  it("holds the latest message from the room it listens on", () => {
    let cb: ((m: TrialMsg) => void) | null = null;
    listenTrials({ onMessage: (_t, f) => (cb = f) }, () => 42);
    expect(trialSeen()).toBeNull();
    cb!(msg({}));
    expect(trialSeen()).toEqual({ msg: msg({}), at: 42 });
  });

  it("an old room delivering late can't overwrite the current room's attempt; its listener is removed", () => {
    let oldCb: ((m: TrialMsg) => void) | null = null;
    let oldUnbound = 0;
    listenTrials({ onMessage: (_t, f) => ((oldCb = f), () => oldUnbound++) }, () => 1);
    oldCb!(msg({ id: "T1" }));
    let newCb: ((m: TrialMsg) => void) | null = null;
    listenTrials({ onMessage: (_t, f) => ((newCb = f), () => {}) }, () => 2);
    expect(oldUnbound).toBe(1);
    expect(trialSeen()).toBeNull(); // forgot the old room's attempt
    newCb!(msg({ id: "T3", kind: "collect" }));
    oldCb!(msg({ id: "T1", state: "failed" })); // the old socket's last frame, late
    expect(trialSeen()?.msg.id).toBe("T3");
    expect(trialSeen()?.at).toBe(2);
  });

  it("the clock runs to the server's deadline on the synced clock, not from receipt (a late delivery shows less left)", () => {
    // Sent at server time 50 s with 40 s left (ends at 90 s), delivered 2 s late.
    const t = { msg: msg({ leftMs: 40_000, endsAt: 90_000 }), at: 52_000 };
    expect(clockLeft(t, 52_000)).toBe(38_000);
    expect(clockLeft(t, 60_000)).toBe(30_000);
    expect(trialHud(t, 52_000)?.clock).toBe("0:38");
    // Paused (a beacon's clock): what was left when sent, whatever the delay.
    expect(clockLeft({ msg: msg({ kind: "defend", state: "paused", leftMs: 50_000 }), at: 52_000 }, 70_000)).toBe(50_000);
    // An older server without endsAt: from receipt, as before.
    expect(clockLeft({ msg: msg({ leftMs: 40_000 }), at: 52_000 }, 53_000)).toBe(39_000);
    // listenTrials stamps receipt on the clock it's given (the game passes the synced server clock).
    let cb: ((m: TrialMsg) => void) | null = null;
    listenTrials({ onMessage: (_t, f) => (cb = f) }, () => 52_000);
    cb!(msg({ leftMs: 40_000, endsAt: 90_000 }));
    expect(trialNow()).toBe(52_000);
    expect(clockLeft(trialSeen()!, trialNow())).toBe(38_000);
  });
});

describe("pointer and map targets for the new types", () => {
  const pos = (id: string): [number, number, number] => {
    const n = Number(id.split("_").at(-1));
    return [n * 10, 0, 0];
  };
  it("race: ring 1 until an attempt runs, then the next ring", () => {
    const T1 = MISSION_BY_ID.get("T1")!;
    expect(objectiveObject(T1, undefined, null, [0, 0, 0], pos)).toBe("t1_ring_1");
    expect(objectiveObject(T1, undefined, msg({ progress: 3 }), [0, 0, 0], pos)).toBe("t1_ring_4");
    expect(objectiveObject(T1, undefined, msg({ progress: 3, state: "failed" }), [0, 0, 0], pos)).toBe("t1_ring_1");
  });
  it("defend: the beacon; collect: the nearest piece not taken", () => {
    expect(objectiveObject(MISSION_BY_ID.get("T2")!, undefined, null, [0, 0, 0], pos)).toBe("t2_beacon");
    const T3 = MISSION_BY_ID.get("T3")!;
    expect(objectiveObject(T3, [0, 0, 0, 0, 0, 0, 0, 0], null, [52, 0, 0], pos)).toBe("t3_shard_5");
    expect(objectiveObject(T3, [0, 0, 0, 0, 1, 0, 0, 0], null, [52, 0, 0], pos)).toBe("t3_shard_6");
    expect(objectiveObject(T3, [1, 1, 1, 1, 1, 1, 1, 1], null, [0, 0, 0], pos)).toBeNull();
    expect(objectiveObject(MISSION_BY_ID.get("A1")!, undefined, null, [0, 0, 0], pos)).toBeNull();
  });
  it("the map marks a race's first ring, the beacon and what's left of a collect", () => {
    const t = missionTargets("meridian", [{ id: "T3", done: false, counts: [1, 1, 1, 0, 0, 0, 0, 0] }]);
    expect(t).toHaveLength(1);
    expect(t[0]!.label).toBe("The Patient Gleam (5 left)");
    expect(missionTargets("arcadia", [{ id: "T1", done: false }, { id: "A4", done: false }]).map((x) => x.id)).toEqual(["T1", "A4"]);
    expect(missionTargets("hollowmere", [{ id: "T2", done: false }, { id: "H4", done: true }]).map((x) => x.id)).toEqual(["T2"]);
  });
});
