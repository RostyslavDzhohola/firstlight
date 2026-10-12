import { VOICE } from "@firstlight/shared/net/voice";
import { describe, expect, it } from "vitest";
import { acceptsIncoming, planLinks, redialBackoffMs, shouldSend, type Me, type PeerView } from "./planner.ts";

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

  it("keeps at most 12 proximity links: nearer newcomers displace the farthest, radio mates don't count", () => {
    const tuned: Me = { radioCh: 5, hasRadio: true, adminMuted: false };
    // 14 linked within DROP (some in the 45–60 m hysteresis band) + 2 radio mates far away.
    const linkedPeers = Array.from({ length: 14 }, (_, i) => peer(`l${i}`, 10 + i * 3.5)); // 10..55.5 m
    const mates = [peer("m1", 300, { radioCh: 5 }), peer("m2", 800, { radioCh: 5 })];
    const newcomer = peer("new", 4);
    const out = plan([...linkedPeers, ...mates, newcomer], [...linkedPeers.map((p) => p.id), "m1", "m2"], { me: tuned });
    expect(out.open).toEqual(["new"]);
    // 14 linked + 1 new = 15 proximity candidates → the 3 farthest linked go.
    expect(out.close.sort()).toEqual(["l11", "l12", "l13"]);
    expect(out.close).not.toContain("m1");
  });

  it("radio mates nearby don't take proximity slots", () => {
    const tuned: Me = { radioCh: 5, hasRadio: true, adminMuted: false };
    const mates = Array.from({ length: 7 }, (_, i) => peer(`m${i}`, 2 + i, { radioCh: 5 }));
    const others = Array.from({ length: 14 }, (_, i) => peer(`p${i}`, 10 + i));
    const { open } = plan([...mates, ...others], [], { me: tuned });
    expect(open).toHaveLength(7 + VOICE.MAX_PEERS);
  });

  it("accepts incoming links only when the planner would keep them", () => {
    const tuned: Me = { radioCh: 5, hasRadio: true, adminMuted: false };
    const twelve = Array.from({ length: 12 }, (_, i) => ({ radioCh: 0, dist: 5 + i * 3 })); // farthest at 38 m
    expect(acceptsIncoming(me, { radioCh: 0, dist: 20 }, [])).toBe(true);
    expect(acceptsIncoming(me, { radioCh: 0, dist: VOICE.DROP + 1 }, [])).toBe(false);
    expect(acceptsIncoming(me, { radioCh: 0, dist: 30 }, twelve)).toBe(true); // nearer than our 12th
    expect(acceptsIncoming(me, { radioCh: 0, dist: 40 }, twelve)).toBe(false); // would be 13th
    expect(acceptsIncoming(tuned, { radioCh: 5, dist: 900 }, twelve)).toBe(true); // radio mate
    expect(acceptsIncoming({ ...me, adminMuted: true }, { radioCh: 0, dist: 3 }, [])).toBe(false);
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

describe("re-dial backoff", () => {
  it("doubles after each unreachable reply from the same peer, from 10 s up to 5 minutes", () => {
    expect([1, 2, 3, 4, 5, 6].map(redialBackoffMs)).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, 300_000]);
    expect(redialBackoffMs(50)).toBe(300_000);
    // An hour next to someone who blocked you: about 16 rings instead of 360.
    let t = 0;
    let rings = 0;
    for (let n = 1; t < 3_600_000; n++, rings++) t += redialBackoffMs(n);
    expect(rings).toBeLessThan(20);
  });
});
