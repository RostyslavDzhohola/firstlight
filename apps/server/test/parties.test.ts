// Party registry rules (pure bookkeeping, no server).

import { describe, expect, it } from "vitest";
import { SOCIAL } from "@firstlight/shared/net/social";
import { PartyRegistry } from "../src/social/parties.ts";

function form(r: PartyRegistry, leader: string, ...members: string[]) {
  for (const m of members) {
    expect(r.invite(leader, leader, m).ok).toBe(true);
    const a = r.accept(m, leader);
    if (!a.ok) throw new Error(a.reason);
  }
  return r.of(leader)!;
}

describe("party registry", () => {
  it("the inviter leads; a leaving leader hands over; a party of one disbands", () => {
    const r = new PartyRegistry();
    const p = form(r, "a", "b", "c");
    expect(p.leader).toBe("a");
    expect(p.members).toEqual(["a", "b", "c"]);
    const left = r.leave("a");
    expect(left.party?.leader).toBe("b");
    expect(left.affected.sort()).toEqual(["a", "b", "c"]);
    expect(r.of("a")).toBeNull();
    r.leave("c");
    expect(r.of("b")).toBeNull();
  });

  it("caps at 4, including at accept time", () => {
    const r = new PartyRegistry();
    form(r, "a", "b", "c");
    expect(r.invite("a", "a", "d").ok).toBe(true);
    expect(r.invite("a", "a", "e").ok).toBe(true);
    expect(r.accept("d", "a").ok).toBe(true);
    expect(r.of("a")!.members).toHaveLength(SOCIAL.PARTY_MAX);
    expect(r.accept("e", "a")).toEqual({ ok: false, reason: "party full" });
    expect(r.invite("a", "a", "f")).toEqual({ ok: false, reason: "party full" });
  });

  it("accepting another invite moves you to that party", () => {
    const r = new PartyRegistry();
    form(r, "a", "b");
    form(r, "x", "y");
    r.invite("x", "x", "b");
    const res = r.accept("b", "x");
    expect(res.ok && res.leftMembers.sort()).toEqual(["a", "b"]);
    expect(r.of("a")).toBeNull(); // the old party of two disbanded
    expect(r.of("b")!.members).toEqual(["x", "y", "b"]);
  });

  it("only the leader removes players; invites expire; self-invites are refused", () => {
    const r = new PartyRegistry();
    form(r, "a", "b", "c");
    expect(r.kick("b", "c")).toEqual({ ok: false, reason: "only the leader can remove players" });
    expect(r.kick("a", "c").ok).toBe(true);
    expect(r.of("c")).toBeNull();
    expect(r.invite("a", "a", "a").ok).toBe(false);
    r.invite("a", "a", "z", 1000);
    expect(r.pendingFor("z", 1000)).toHaveLength(1);
    expect(r.expire(1000 + SOCIAL.INVITE_TTL_MS)).toHaveLength(1);
    expect(r.accept("z", "a", 1000 + SOCIAL.INVITE_TTL_MS)).toEqual({ ok: false, reason: "that invite expired" });
  });

  it("follows a guest who saved (new account id), as leader, member and inviter", () => {
    const r = new PartyRegistry();
    form(r, "guest", "b");
    r.invite("guest", "guest", "c");
    const { reissued } = r.rekey("guest", "acct");
    expect(reissued.map((i) => [i.from, i.to])).toEqual([["acct", "c"]]);
    const p = r.of("acct")!;
    expect(p.leader).toBe("acct");
    expect(p.members).toEqual(["acct", "b"]);
    expect(r.of("guest")).toBeNull();
    expect(r.pendingFor("c")[0]!.from).toBe("acct");
    expect(r.accept("c", "acct").ok).toBe(true);
  });

  it("re-keying into an account that already has a party keeps that party and drops the guest's", () => {
    const r = new PartyRegistry();
    form(r, "guest", "b");
    form(r, "acct", "c");
    const { affected } = r.rekey("guest", "acct");
    expect(affected.sort()).toEqual(["b", "guest"]);
    expect(r.of("guest")).toBeNull();
    expect(r.of("b")).toBeNull(); // party of one disbanded
    expect(r.of("acct")!.members).toEqual(["acct", "c"]);
  });

  it("re-keying two members of one party never duplicates a member", () => {
    const r = new PartyRegistry();
    form(r, "acct", "guest", "c");
    r.rekey("guest", "acct");
    expect(r.of("acct")!.members).toEqual(["acct", "c"]);
    expect(new Set(r.of("c")!.members).size).toBe(2);
  });
});
