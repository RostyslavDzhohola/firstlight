import { VOICE } from "@firstlight/shared/net/voice";
import { describe, expect, it } from "vitest";
import { planLinks, shouldSend, type Me, type PeerView } from "./planner.ts";

const me: Me = { radioCh: 0, hasRadio: false, adminMuted: false };
const peer = (id: string, dist: number, extra: Partial<PeerView> = {}): PeerView => ({ id, dist, voice: true, adminMuted: false, radioCh: 0, blocked: false, ...extra });
const plan = (peers: PeerView[], linked: string[] = [], opts: { me?: Me; farSince?: Map<string, number>; now?: number } = {}) =>
  planLinks({ me: opts.me ?? me, peers, linked: new Set(linked), farSince: opts.farSince ?? new Map(), now: opts.now ?? 0 });

describe("voice link planner", () => {
  it("links the 12 nearest eligible players within CONNECT", () => {
    const peers = Array.from({ length: 20 }, (_, i) => peer(`p${i}`, 2 + i * 2)); // 2..40 m
    const { open } = plan(peers);
    expect(open).toHaveLength(VOICE.MAX_PEERS);
    expect(open).toEqual(peers.slice(0, 12).map((p) => p.id));
  });

  it("skips players with voice off, admin-muted, blocked or beyond CONNECT", () => {
    const { open } = plan([
      peer("off", 5, { voice: false }),
      peer("muted", 5, { adminMuted: true }),
      peer("blocked", 5, { blocked: true }),
      peer("far", VOICE.CONNECT + 1),
      peer("ok", 10),
    ]);
    expect(open).toEqual(["ok"]);
  });

  it("adds same-channel radio holders at any distance, only with my own radio tuned", () => {
    const peers = [peer("r", 400, { radioCh: 3 }), peer("other", 400, { radioCh: 4 })];
    expect(plan(peers).open).toEqual([]);
    expect(plan(peers, [], { me: { radioCh: 3, hasRadio: false, adminMuted: false } }).open).toEqual([]);
    expect(plan(peers, [], { me: { radioCh: 3, hasRadio: true, adminMuted: false } }).open).toEqual(["r"]);
  });

  it("closes ineligible links at once and far links after the hold", () => {
    const farSince = new Map<string, number>();
    const peers = [peer("gone-quiet", 5, { voice: false }), peer("drifting", VOICE.DROP + 5), peer("between", (VOICE.CONNECT + VOICE.DROP) / 2)];
    const linked = ["gone-quiet", "drifting", "between", "left-room"];
    expect(plan(peers, linked, { farSince, now: 1000 }).close.sort()).toEqual(["gone-quiet", "left-room"]);
    expect(plan(peers, linked, { farSince, now: 1000 + VOICE.DROP_HOLD_MS - 1 }).close).not.toContain("drifting");
    expect(plan(peers, linked, { farSince, now: 1000 + VOICE.DROP_HOLD_MS }).close).toContain("drifting");
    // Between CONNECT and DROP an existing link is kept (hysteresis).
    expect(plan(peers, linked, { farSince, now: 99_999 }).close).not.toContain("between");
  });

  it("keeps radio mates linked however far", () => {
    const farSince = new Map<string, number>();
    const tuned: Me = { radioCh: 2, hasRadio: true, adminMuted: false };
    const peers = [peer("mate", 900, { radioCh: 2 })];
    expect(plan(peers, ["mate"], { me: tuned, farSince, now: 0 }).close).toEqual([]);
    expect(plan(peers, ["mate"], { me: tuned, farSince, now: 60_000 }).close).toEqual([]);
  });

  it("drops everything while I'm admin-muted", () => {
    const { open, close } = plan([peer("a", 3)], ["a"], { me: { ...me, adminMuted: true } });
    expect(open).toEqual([]);
    expect(close).toEqual(["a"]);
  });
});

describe("sender gating", () => {
  it("V sends to people in earshot; B also reaches my channel at any distance", () => {
    expect(shouldSend(10, false, false, false)).toBe(false);
    expect(shouldSend(10, true, false, false)).toBe(true);
    expect(shouldSend(VOICE.HEAR + 6, true, false, true)).toBe(false);
    expect(shouldSend(500, false, true, true)).toBe(true);
    expect(shouldSend(500, false, true, false)).toBe(false);
    expect(shouldSend(10, false, true, false)).toBe(true);
  });
});
