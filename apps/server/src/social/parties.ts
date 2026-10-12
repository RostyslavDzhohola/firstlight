// Party registry (SPEC §6.10, D12): up to 4 players, keyed by account id so membership survives
// travel between bodies and copies. Pure bookkeeping; the room system turns results into messages.

import { SOCIAL } from "@firstlight/shared/net/social";

export interface Party {
  id: string;
  leader: string;
  /** userIds in join order (the leader is promoted from here when they leave). */
  members: string[];
  createdAt: number;
}

export interface Invite {
  from: string;
  fromName: string;
  to: string;
  /** The inviter's party at invite time (null: a new party forms on accept). */
  partyId: string | null;
  expiresAt: number;
}

export type Refusal = { ok: false; reason: string };

export class PartyRegistry {
  private readonly parties = new Map<string, Party>();
  private readonly memberOf = new Map<string, string>();
  /** invitee → inviter → invite */
  private readonly invites = new Map<string, Map<string, Invite>>();
  private seq = 0;

  get(id: string): Party | null {
    return this.parties.get(id) ?? null;
  }

  of(userId: string): Party | null {
    const id = this.memberOf.get(userId);
    return id ? (this.parties.get(id) ?? null) : null;
  }

  invite(from: string, fromName: string, to: string, now = Date.now()): { ok: true; invite: Invite } | Refusal {
    if (from === to) return { ok: false, reason: "you can't invite yourself" };
    const p = this.of(from);
    if (p && p.members.includes(to)) return { ok: false, reason: "already in your party" };
    if (p && p.members.length >= SOCIAL.PARTY_MAX) return { ok: false, reason: "party full" };
    const invite: Invite = { from, fromName, to, partyId: p?.id ?? null, expiresAt: now + SOCIAL.INVITE_TTL_MS };
    let m = this.invites.get(to);
    if (!m) this.invites.set(to, (m = new Map()));
    m.set(from, invite);
    return { ok: true, invite };
  }

  pendingFor(to: string, now = Date.now()): Invite[] {
    return [...(this.invites.get(to)?.values() ?? [])].filter((i) => i.expiresAt > now);
  }

  /** Accept an invite. Leaves the invitee's old party first. */
  accept(to: string, from: string, now = Date.now()): { ok: true; party: Party; left: Party | null; leftMembers: string[] } | Refusal {
    const inv = this.invites.get(to)?.get(from);
    if (!inv || inv.expiresAt <= now) {
      this.dropInvite(to, from);
      return { ok: false, reason: "that invite expired" };
    }
    let party = this.of(from);
    if (party && party.members.includes(to)) {
      this.dropInvite(to, from);
      return { ok: false, reason: "already in that party" };
    }
    if (party && party.members.length >= SOCIAL.PARTY_MAX) return { ok: false, reason: "party full" };
    this.dropInvite(to, from);
    let left: Party | null = null;
    let leftMembers: string[] = [];
    if (this.memberOf.has(to)) {
      const r = this.leave(to);
      left = r.party;
      leftMembers = r.affected;
    }
    if (!party) {
      party = { id: `p${(++this.seq).toString(36)}${now.toString(36).slice(-4)}`, leader: from, members: [from], createdAt: now };
      this.parties.set(party.id, party);
      this.memberOf.set(from, party.id);
    }
    party.members.push(to);
    this.memberOf.set(to, party.id);
    return { ok: true, party, left, leftMembers };
  }

  decline(to: string, from: string): Invite | null {
    const inv = this.invites.get(to)?.get(from) ?? null;
    this.dropInvite(to, from);
    return inv;
  }

  /**
   * Leave the party. The next member becomes leader; a party of one disbands.
   * Returns the party as it is now (null if disbanded) and every user whose party view changed.
   */
  leave(userId: string): { party: Party | null; affected: string[] } {
    const p = this.of(userId);
    if (!p) return { party: null, affected: [] };
    const affected = [...p.members];
    p.members = p.members.filter((m) => m !== userId);
    this.memberOf.delete(userId);
    if (p.leader === userId) p.leader = p.members[0] ?? "";
    if (p.members.length <= 1) {
      for (const m of p.members) this.memberOf.delete(m);
      this.parties.delete(p.id);
      return { party: null, affected };
    }
    return { party: p, affected };
  }

  kick(leader: string, target: string): { ok: true; party: Party | null; affected: string[] } | Refusal {
    const p = this.of(leader);
    if (!p) return { ok: false, reason: "you're not in a party" };
    if (p.leader !== leader) return { ok: false, reason: "only the leader can remove players" };
    if (target === leader || !p.members.includes(target)) return { ok: false, reason: "not in your party" };
    return { ok: true, ...this.leave(target) };
  }

  /** Withdraw every invite between the two users (after a block). Returns the withdrawn invites. */
  cancelBetween(a: string, b: string): Invite[] {
    const out = [this.invites.get(a)?.get(b), this.invites.get(b)?.get(a)].filter((i): i is Invite => !!i);
    this.dropInvite(a, b);
    this.dropInvite(b, a);
    return out;
  }

  expire(now = Date.now()): Invite[] {
    const out: Invite[] = [];
    for (const [to, m] of this.invites) {
      for (const [from, inv] of m) {
        if (inv.expiresAt <= now) {
          m.delete(from);
          out.push(inv);
        }
      }
      if (m.size === 0) this.invites.delete(to);
    }
    return out;
  }

  /**
   * A guest saved and got a new account id. If the account already has a party (playing in another
   * browser), it keeps that one and the guest's membership ends. Returns users whose party view
   * changed, and the invites the guest had sent (now from the account) so recipients can be told.
   */
  rekey(from: string, to: string): { affected: string[]; reissued: Invite[] } {
    if (from === to) return { affected: [], reissued: [] };
    const affected: string[] = [];
    const reissued: Invite[] = [];
    const fromParty = this.of(from);
    if (fromParty) {
      if (this.of(to)) affected.push(...this.leave(from).affected);
      else {
        fromParty.members = fromParty.members.map((m) => (m === from ? to : m));
        if (fromParty.leader === from) fromParty.leader = to;
        this.memberOf.delete(from);
        this.memberOf.set(to, fromParty.id);
        affected.push(...fromParty.members);
      }
    }
    // Invites to the guest become invites to the account (one per inviter).
    const mine = this.invites.get(from);
    if (mine) {
      this.invites.delete(from);
      let dest = this.invites.get(to);
      if (!dest) this.invites.set(to, (dest = new Map()));
      for (const [inviter, inv] of mine) {
        if (inviter === to || dest.has(inviter)) continue;
        inv.to = to;
        dest.set(inviter, inv);
      }
      if (dest.size === 0) this.invites.delete(to);
    }
    // Invites the guest sent now come from the account.
    for (const [invitee, m] of this.invites) {
      const inv = m.get(from);
      if (!inv) continue;
      m.delete(from);
      if (invitee !== to && !m.has(to)) {
        inv.from = to;
        m.set(to, inv);
        reissued.push(inv);
      }
      if (m.size === 0) this.invites.delete(invitee);
    }
    return { affected, reissued };
  }

  clear(): void {
    this.parties.clear();
    this.memberOf.clear();
    this.invites.clear();
  }

  private dropInvite(to: string, from: string): void {
    const m = this.invites.get(to);
    if (!m) return;
    m.delete(from);
    if (m.size === 0) this.invites.delete(to);
  }
}

/** The process-wide registry. */
export const parties = new PartyRegistry();

/**
 * Members of the user's party (account ids, the user included), or just the user when solo.
 * For shared boss credit: credit every id here that is present in the fight's room.
 */
export function partyOf(userId: string): string[] {
  const p = parties.of(userId);
  return p ? [...p.members] : [userId];
}
