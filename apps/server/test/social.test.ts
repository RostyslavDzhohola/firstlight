// Seam 1: parties and in-game moderation with SDK bots against the real server (in-memory stores).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client, type Room } from "@colyseus/sdk";
import { PF } from "@firstlight/shared/net/schema";
import { CLOSE } from "@firstlight/shared/net/social";
import type { Game } from "../src/app.ts";
import { isVoiceMuted, partyOf } from "../src/social/index.ts";
import { memoryReports } from "../src/social/store.ts";
import { joinAs, playRequest, safeLeave, startServer, waitFor } from "./helpers.ts";

let game: Game;
const rooms: Room[] = [];
let n = 0;
/** Unique account ids per test: the party registry is process-wide. */
const uid = (name: string) => `${name}${++n}`;

beforeEach(async () => {
  game = await startServer({ maxClients: 8, soloFillLimit: 5 });
});
afterEach(async () => {
  for (const r of rooms.splice(0)) await safeLeave(r);
  await game.close();
});

const st = (r: Room) => r.state as any;
const me = (r: Room) => st(r).players.get(r.sessionId);

async function join(name: string, body = "portus", role = "", extra: Record<string, unknown> = {}): Promise<Room> {
  const r = await joinAs(game, name, body, extra, role);
  rooms.push(r);
  r.onMessage("*", () => {});
  return r;
}

/** Collect messages of a type. */
function inbox<T = any>(r: Room, type: string): T[] {
  const list: T[] = [];
  r.onMessage(type, (m: T) => list.push(m));
  return list;
}

async function formParty(leader: Room, ...members: Room[]) {
  for (const m of members) {
    const invites = inbox<{ from: string }>(m, "party:invite");
    leader.send("party", { action: "invite", target: m.sessionId });
    await waitFor(() => invites.length > 0);
    m.send("party", { action: "accept", target: invites[0]!.from });
    await waitFor(() => !!me(m)?.party && me(m).party === me(leader)?.party);
  }
}

/** Move a player `metres` along the surface from where they stand (admin teleport). */
function shift(r: Room, metres: number) {
  const p = me(r);
  const len = Math.hypot(p.x, p.y, p.z);
  const up = [p.x / len, p.y / len, p.z / len];
  const ref = Math.abs(up[2]!) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const d = ref[0]! * up[0]! + ref[1]! * up[1]! + ref[2]! * up[2]!;
  const t = [ref[0]! - d * up[0]!, ref[1]! - d * up[1]!, ref[2]! - d * up[2]!];
  const tl = Math.hypot(t[0]!, t[1]!, t[2]!);
  r.send("admin", { cmd: "teleport", args: { x: p.x + (t[0]! / tl) * metres, y: p.y + (t[1]! / tl) * metres, z: p.z + (t[2]! / tl) * metres } });
}

const dist = (a: any, b: any) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

describe("parties", () => {
  it("invite, accept, leave: both players share a party id and see each other in party:state", async () => {
    const [ua, ub] = [uid("lead"), uid("mate")];
    const a = await join(ua);
    const b = await join(ub);
    await waitFor(() => st(a).players.size === 2 && st(b).players.size === 2);
    const states = inbox<any>(a, "party:state");
    await formParty(a, b);
    const pid = me(a).party;
    expect(pid).toBeTruthy();
    expect(st(a).players.get(b.sessionId).party).toBe(pid);
    await waitFor(() => states.some((s) => s.members.length === 2));
    const last = states.filter((s) => s.members.length === 2).pop();
    expect(last.leader).toBe(ua);
    expect(last.members.map((m: any) => m.userId).sort()).toEqual([ua, ub].sort());
    expect(last.members.every((m: any) => m.online && m.roomId === a.roomId && m.body === "portus")).toBe(true);
    expect(partyOf(ub).sort()).toEqual([ua, ub].sort());

    b.send("party", { action: "leave" });
    await waitFor(() => me(a).party === "" && me(b).party === "");
    expect(partyOf(ua)).toEqual([ua]);
  });

  it("decline tells the inviter; the leader can kick a member; the party holds at most 4", async () => {
    const lead = await join(uid("cap"));
    const others = [await join(uid("m")), await join(uid("m")), await join(uid("m")), await join(uid("m"))];
    await waitFor(() => st(lead).players.size === 5);

    // Decline first.
    const closed = inbox<any>(lead, "party:invite-closed");
    const inv = inbox<any>(others[0]!, "party:invite");
    lead.send("party", { action: "invite", target: others[0]!.sessionId });
    await waitFor(() => inv.length === 1);
    others[0]!.send("party", { action: "decline", target: inv[0].from });
    await waitFor(() => closed.some((c) => c.reason === "declined"));

    await formParty(lead, others[0]!, others[1]!, others[2]!);
    const denied = inbox<any>(lead, "denied");
    lead.send("party", { action: "invite", target: others[3]!.sessionId });
    await waitFor(() => denied.length > 0);
    expect(denied[0]).toEqual({ action: "party", reason: "party full" });
    expect(me(others[3]!).party).toBe("");

    // Kick one, then the fifth player fits.
    lead.send("party", { action: "kick", target: st(lead).players.get(others[2]!.sessionId).userId });
    await waitFor(() => me(others[2]!).party === "");
    await formParty(lead, others[3]!);
    expect(new Set([lead, ...others.filter((_, i) => i !== 2)].map((r) => me(r).party)).size).toBe(1);
  });

  it("invites only reach players within 30 m in the same copy", async () => {
    const a = await join(uid("far"), "arcadia", "admin");
    const b = await join(uid("away"), "arcadia", "admin");
    await waitFor(() => st(a).players.size === 2);
    shift(b, 45);
    await waitFor(() => dist(me(a), st(a).players.get(b.sessionId)) > 32);
    const denied = inbox<any>(a, "denied");
    const invites = inbox<any>(b, "party:invite");
    a.send("party", { action: "invite", target: b.sessionId });
    await waitFor(() => denied.length > 0);
    expect(denied[0].reason).toMatch(/too far/);
    expect(invites).toHaveLength(0);
    // Someone in another copy (another body) can't be invited either.
    const c = await join(uid("elsewhere"), "portus");
    a.send("party", { action: "invite", target: c.sessionId });
    await waitFor(() => denied.length > 1);
    expect(denied[1].reason).toMatch(/isn't in this world copy/);
  });

  it("the party survives travel and a member lands in the leader's copy (server picks it, D12 headroom)", async () => {
    const [ul, uf] = [uid("trav"), uid("follow")];
    const leaderHub = await join(ul);
    const friendHub = await join(uf);
    await waitFor(() => st(leaderHub).players.size === 2);
    await formParty(leaderHub, friendHub);
    const pid = me(leaderHub).party;

    await safeLeave(leaderHub);
    const leader = await join(ul, "meridian");
    await waitFor(() => me(leader)?.party === pid);
    // Fill the leader's copy to the solo limit (5); solo arrivals now open a second copy.
    for (let i = 0; i < 4; i++) await join(uid("fill"), "meridian");
    const solo = await join(uid("solo"), "meridian");
    expect(solo.roomId).not.toBe(leader.roomId);

    const states = inbox<any>(friendHub, "party:state");
    await waitFor(() => states.some((s) => s.members.some((m: any) => m.userId === ul && m.body === "meridian" && m.roomId === leader.roomId)));
    await safeLeave(friendHub);
    // The client would pass partyLeaderRoomId from party:state; the server also fills it in.
    const friend = await join(uf, "meridian");
    expect(friend.roomId).toBe(leader.roomId);
    await waitFor(() => me(friend)?.party === pid);
  });
});

describe("blocks and parties (stalking, risk R1)", () => {
  const userOf = (r: Room) => me(r).userId as string;

  it("a voice-panel block withdraws a pending invite: the blocked player can't accept it", async () => {
    const ann = await join(uid("ann"));
    const ben = await join(uid("ben"));
    await waitFor(() => st(ann).players.size === 2);
    const invites = inbox<any>(ben, "party:invite");
    const closed = inbox<any>(ben, "party:invite-closed");
    const states = inbox<any>(ben, "party:state");
    ann.send("party", { action: "invite", target: ben.sessionId });
    await waitFor(() => invites.length === 1);
    ann.send("voice:block", { target: ben.sessionId });
    await waitFor(() => closed.some((c) => c.from === userOf(ann) && c.reason === "cancelled"));
    const denied = inbox<any>(ben, "denied");
    ben.send("party", { action: "accept", target: invites[0].from });
    await waitFor(() => denied.length > 0);
    expect(me(ben).party).toBe("");
    expect(partyOf(userOf(ben))).toEqual([userOf(ben)]);
    expect(states.every((s) => !s.members.some((m: any) => m.userId === userOf(ann)))).toBe(true);
  });

  it("a block inside a party splits it: the leader's block removes the other, a member's block makes them leave", async () => {
    const lead = await join(uid("lead"));
    const ben = await join(uid("ben"));
    const cat = await join(uid("cat"));
    const dan = await join(uid("dan"));
    await waitFor(() => st(lead).players.size === 4);
    await formParty(lead, ben, cat, dan);
    const pid = me(lead).party;

    // A member blocks another member (voice panel): the blocker leaves, the blocked one stays.
    ben.send("voice:block", { target: cat.sessionId });
    await waitFor(() => me(ben).party === "");
    expect(me(cat).party).toBe(pid);
    expect(partyOf(userOf(lead)).sort()).toEqual([userOf(lead), userOf(cat), userOf(dan)].sort());

    // The leader blocks a member (Tab list): that member is removed.
    lead.send("social:block", { target: dan.sessionId });
    await waitFor(() => me(dan).party === "");
    expect(partyOf(userOf(lead)).sort()).toEqual([userOf(lead), userOf(cat)].sort());

    // A member blocks the leader: the member leaves (here that disbands the party of two).
    cat.send("social:block", { target: lead.sessionId });
    await waitFor(() => me(cat).party === "" && me(lead).party === "");
  });

  it("invites and accepts are refused when anyone in the party blocked the player, either way", async () => {
    const ann = await join(uid("ann"));
    const ben = await join(uid("ben"));
    const cat = await join(uid("cat"));
    await waitFor(() => st(ann).players.size === 3);
    // Cat invites Ben first; then Ann (who blocked Ben) joins Cat's party.
    const benInvites = inbox<any>(ben, "party:invite");
    cat.send("party", { action: "invite", target: ben.sessionId });
    await waitFor(() => benInvites.length === 1);
    ann.send("social:block", { target: ben.sessionId });
    await formParty(cat, ann);
    // Accepting now would put Ben next to Ann: refused.
    const benDenied = inbox<any>(ben, "denied");
    ben.send("party", { action: "accept", target: benInvites[0].from });
    await waitFor(() => benDenied.length > 0);
    expect(benDenied[0]).toEqual({ action: "party", reason: "you can't join this party" });
    expect(me(ben).party).toBe("");
    // And Cat can't invite Ben while Ann is in the party.
    const catDenied = inbox<any>(cat, "denied");
    cat.send("party", { action: "invite", target: ben.sessionId });
    await waitFor(() => catDenied.length > 0);
    expect(catDenied[0]).toEqual({ action: "party", reason: "you can't invite this player" });
  });
});

describe("reports", () => {
  it("reach players in your copy, or who shared it with you in the last 10 minutes, not anyone online", async () => {
    const [annId, eveId, farId] = [uid("ann"), uid("eve"), uid("far")];
    const ann = await join(annId);
    const eve = await join(eveId);
    await join(farId, "arcadia"); // never met Ann
    await waitFor(() => st(ann).players.size === 2);
    // Eve leaves Ann's copy for another body: Ann can still report her.
    await safeLeave(eve);
    rooms.splice(rooms.indexOf(eve), 1);
    await join(eveId, "arcadia");
    await waitFor(() => st(ann).players.size === 1);
    const toasts = inbox<any>(ann, "toast");
    const denied = inbox<any>(ann, "denied");
    ann.send("report", { target: eveId, reason: "harassment" });
    await waitFor(() => toasts.some((t) => /Report sent/.test(t.text)));
    ann.send("report", { target: farId, reason: "harassment" });
    await waitFor(() => denied.length > 0);
    expect(denied[0]).toEqual({ action: "report", reason: "player not found" });
    expect(memoryReports().filter((r) => r.reporter === annId).map((r) => r.target)).toEqual([eveId]);
  });
});

describe("admin actions", () => {
  it("admin kick disconnects at once, refuses the old seat and keeps them out for a while", async () => {
    const boss = await join(uid("admin"), "portus", "admin");
    const victimId = uid("rowdy");
    const victim = await join(victimId);
    await waitFor(() => st(boss).players.size === 2);
    const kicked = inbox<any>(victim, "kicked");
    let code = 0;
    victim.onLeave((c: number) => (code = c));
    const token = victim.reconnectionToken;
    boss.send("mod", { action: "kick", target: victim.sessionId, reason: "testing" });
    await waitFor(() => code !== 0);
    expect(code).toBe(CLOSE.KICKED);
    expect(kicked[0]).toMatchObject({ code: CLOSE.KICKED });
    await waitFor(() => !st(boss).players.has(victim.sessionId));
    // No way back into the old seat, and /api/play refuses during the cooldown.
    await expect(new Client(`http://127.0.0.1:${game.port}`).reconnect(token)).rejects.toBeTruthy();
    const again = await playRequest(game, `dev:${victimId}:${victimId}`, { body: "portus" });
    expect(again).toMatchObject({ ok: false, error: "kicked" });
  });

  it("a seat reserved before the kick can't be used during the cooldown", async () => {
    const boss = await join(uid("admin"), "portus", "admin");
    const victimId = uid("sly");
    const victim = await join(victimId);
    await waitFor(() => st(boss).players.size === 2);
    const spare = await playRequest(game, `dev:${victimId}:${victimId}`, { body: "portus" });
    expect(spare.ok).toBe(true);
    let code = 0;
    victim.onLeave((c: number) => (code = c));
    boss.send("mod", { action: "kick", target: victim.sessionId });
    await waitFor(() => code === CLOSE.KICKED);
    let sneakyCode = 0;
    try {
      const sneaky = await new Client(`http://127.0.0.1:${game.port}`).consumeSeatReservation((spare as any).reservation);
      sneaky.onLeave((c: number) => (sneakyCode = c));
      await waitFor(() => sneakyCode !== 0);
      expect(sneakyCode).toBe(CLOSE.KICKED);
    } catch {
      // Refused outright is fine too.
    }
    await new Promise((r) => setTimeout(r, 100));
    expect([...st(boss).players.values()].some((p: any) => p.userId === victimId)).toBe(false);
  });

  it("admin ban disconnects and refuses rejoin (dev identities: account ban)", async () => {
    const boss = await join(uid("admin"), "arcadia", "admin");
    const victimId = uid("cheat");
    const victim = await join(victimId, "arcadia");
    await waitFor(() => st(boss).players.size === 2);
    let code = 0;
    victim.onLeave((c: number) => (code = c));
    boss.send("mod", { action: "ban", target: victim.sessionId });
    await waitFor(() => code !== 0);
    expect(code).toBe(CLOSE.BANNED);
    const again = await playRequest(game, `dev:${victimId}:${victimId}`, { body: "portus" });
    expect(again).toMatchObject({ ok: false, error: "banned" });
  });

  it("voice-mute, go to, bring and announce", async () => {
    const boss = await join(uid("admin"), "arcadia", "admin");
    const other = await join(uid("loud"), "arcadia", "admin");
    const elsewhere = await join(uid("hub"), "portus");
    await waitFor(() => st(boss).players.size === 2);
    boss.send("mod", { action: "voicemute", target: other.sessionId, on: true });
    await waitFor(() => (me(other).flags & PF.VOICE_MUTED) !== 0);
    expect(isVoiceMuted(me(other).userId)).toBe(true);
    // The mute follows the player into another room.
    const otherId = me(other).userId;
    await safeLeave(other);
    const back = await join(otherId, "arcadia", "admin");
    await waitFor(() => (me(back)?.flags & PF.VOICE_MUTED) !== 0);
    boss.send("mod", { action: "voicemute", target: back.sessionId, on: false });
    await waitFor(() => (me(back).flags & PF.VOICE_MUTED) === 0);

    shift(back, 40);
    await waitFor(() => dist(me(boss), st(boss).players.get(back.sessionId)) > 30);
    boss.send("mod", { action: "goto", target: back.sessionId });
    await waitFor(() => dist(st(back).players.get(boss.sessionId), me(back)) < 3);
    shift(boss, 25);
    await waitFor(() => dist(me(boss), st(boss).players.get(back.sessionId)) > 20);
    boss.send("mod", { action: "bring", target: back.sessionId });
    await waitFor(() => dist(me(boss), st(boss).players.get(back.sessionId)) < 3);

    const banners = inbox<any>(elsewhere, "announce");
    boss.send("mod", { action: "announce", text: "Boss fight at the lake in 5 minutes" });
    await waitFor(() => banners.length > 0);
    expect(banners[0].text).toBe("Boss fight at the lake in 5 minutes");
  });

  it("non-admins can't use admin actions", async () => {
    const admin = await join(uid("admin"), "portus", "admin");
    const plain = await join(uid("plain"));
    await waitFor(() => st(plain).players.size === 2);
    const denied = inbox<any>(plain, "denied");
    let adminLeft = false;
    admin.onLeave(() => (adminLeft = true));
    for (const action of ["kick", "ban", "voicemute", "bring"]) plain.send("mod", { action, target: admin.sessionId });
    plain.send("mod", { action: "announce", text: "fake banner" });
    const banners = inbox<any>(admin, "announce");
    await waitFor(() => denied.length === 5);
    expect(denied.every((d) => d.action === "mod" && d.reason === "admins only")).toBe(true);
    const before = { ...me(admin) };
    plain.send("admin", { cmd: "teleport", args: { target: admin.sessionId, x: 0, y: 200, z: 0 } });
    await new Promise((r) => setTimeout(r, 300));
    expect(adminLeft).toBe(false);
    expect(banners).toHaveLength(0);
    expect(me(admin).flags & PF.VOICE_MUTED).toBe(0);
    expect(dist(me(admin), before)).toBeLessThan(0.01);
    expect((await playRequest(game, `dev:${me(admin).userId}:x:admin`, { body: "portus" })).ok).toBe(true);
  });
});
