// Review 2026-11-13 #3: the client keeps the latest tracked choice and gets it to the server even when
// a send is throttled: one send in flight, the latest choice wins, a refusal retries after the window.

import { describe, expect, it, vi } from "vitest";
import { TrackSync, stepTrackKey } from "./missionTrack.ts";
import { MissionTrack } from "./missionTrack.ts";

function rig() {
  const sent: (string | null)[] = [];
  const s = new TrackSync((id) => sent.push(id), { retryMs: 1100, ackTimeoutMs: 3000 });
  return { s, sent };
}

describe("track sync", () => {
  it("sends a choice and settles on its acknowledgement", () => {
    const { s, sent } = rig();
    s.want("A1");
    expect(sent).toEqual(["A1"]);
    s.acked("A1");
    expect(s.pending).toBe(false);
  });

  it("coalesces changes made while a send is in flight and sends only the latest after the ack", () => {
    const { s, sent } = rig();
    s.want("A1");
    s.want("A2");
    s.want("A3");
    expect(sent).toEqual(["A1"]);
    s.acked("A1");
    expect(sent).toEqual(["A1", "A3"]);
    s.acked("A3");
    expect(s.pending).toBe(false);
  });

  it("retries the latest choice after a refusal", () => {
    vi.useFakeTimers();
    try {
      const { s, sent } = rig();
      s.want("A1");
      s.denied();
      s.want("A2");
      expect(sent).toEqual(["A1"]);
      vi.advanceTimersByTime(1100);
      expect(sent).toEqual(["A1", "A2"]);
      s.acked("A2");
      expect(s.pending).toBe(false);
      s.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resends when no answer comes (a dropped message), and on a new room", () => {
    vi.useFakeTimers();
    try {
      const { s, sent } = rig();
      s.want("A1");
      vi.advanceTimersByTime(3000);
      expect(sent).toEqual(["A1", "A1"]);
      s.reset("A1");
      expect(sent).toEqual(["A1", "A1", "A1"]);
      s.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Shift+L steps the tracked mission", () => {
  const missions = [{ id: "A1", done: false }, { id: "A2", done: false }, { id: "A3", done: false }];
  it("one step per press; held-key repeats are ignored", () => {
    const t = new MissionTrack(null);
    t.choose("A1");
    expect(stepTrackKey(t, missions, { repeat: false })).toBe(true);
    expect(t.chosen).toBe("A2");
    for (let i = 0; i < 10; i++) expect(stepTrackKey(t, missions, { repeat: true })).toBe(false);
    expect(t.chosen).toBe("A2");
  });
});
