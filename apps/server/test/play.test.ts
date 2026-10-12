import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@colyseus/sdk";
import type { Room } from "@colyseus/sdk";
import type { Game } from "../src/app.ts";
import { joinAs, playRequest, safeLeave, startServer, waitFor } from "./helpers.ts";

let game: Game;
const rooms: Room[] = [];

beforeEach(async () => {
  game = await startServer({ maxClients: 6, soloFillLimit: 4, maxCopiesPerBody: 2, globalCap: 10 });
});

afterEach(async () => {
  for (const r of rooms.splice(0)) await safeLeave(r);
  await game.close();
});

describe("entering the world", () => {
  it("rejects requests without a valid token", async () => {
    const res = await fetch(`http://127.0.0.1:${game.port}/api/play`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    expect(res.status).toBe(401);
  });

  it("rejects an unknown body", async () => {
    const r = await playRequest(game, "dev:u1:Ann", { body: "narnia" });
    expect(r.ok).toBe(false);
  });

  it("a player who joins Arcadia sees themselves on the main pad", async () => {
    const room = await joinAs(game, "u1", "arcadia");
    rooms.push(room);
    await waitFor(() => (room.state as any).players?.size === 1);
    const me = (room.state as any).players.get(room.sessionId);
    expect(me.name).toBe("u1");
    const r = Math.hypot(me.x, me.y, me.z);
    expect(r).toBeGreaterThan(500);
    expect((room.state as any).body).toBe("arcadia");
  });

  it("two players in the same copy see each other move", async () => {
    const a = await joinAs(game, "a", "portus");
    const b = await joinAs(game, "b", "portus");
    rooms.push(a, b);
    expect(a.roomId).toBe(b.roomId);
    await waitFor(() => (b.state as any).players?.size === 2);
    const pa = (a.state as any).players.get(a.sessionId);
    const nx = pa.x + 1, ny = pa.y, nz = pa.z;
    a.send("input", { seq: 1, x: nx, y: ny, z: nz, fx: 0, fy: 0, fz: 1, anim: 2, t: Date.now() });
    await waitFor(() => Math.abs((b.state as any).players.get(a.sessionId).x - nx) < 1e-3);
  });

  it("refuses teleport-sized moves and corrects the client", async () => {
    const a = await joinAs(game, "cheat", "portus");
    rooms.push(a);
    await waitFor(() => (a.state as any).players?.size === 1);
    const pa = (a.state as any).players.get(a.sessionId);
    let corrected = false;
    a.onMessage("correct", () => (corrected = true));
    a.send("input", { seq: 1, x: pa.x + 80, y: pa.y, z: pa.z, fx: 0, fy: 0, fz: 1, anim: 2, t: Date.now() });
    await waitFor(() => corrected);
    expect((a.state as any).players.get(a.sessionId).x).toBeCloseTo(pa.x, 3);
  });

  it("solo players fill a copy to the solo limit, then a second copy opens; then the queue", async () => {
    const joined: Room[] = [];
    for (let i = 0; i < 8; i++) joined.push(await joinAs(game, `s${i}`, "meridian"));
    rooms.push(...joined);
    const copies = new Set(joined.map((r) => r.roomId));
    expect(copies.size).toBe(2);
    const first = joined.slice(0, 4).every((r) => r.roomId === joined[0]!.roomId);
    expect(first).toBe(true);
    const queued = await playRequest(game, "dev:late:late", { body: "meridian" });
    expect(queued.ok).toBe(false);
    expect("queue" in queued && queued.queue.position).toBeGreaterThan(0);
  });

  it("a party member can still enter the leader's copy using the headroom seats", async () => {
    // Headroom is for real parties only: form one in Portus first (invites need the same copy).
    const leaderHub = await joinAs(game, "p0", "portus");
    const friendHub = await joinAs(game, "friend", "portus");
    rooms.push(leaderHub, friendHub);
    let invite: { from: string } | null = null;
    friendHub.onMessage("party:invite", (m) => (invite = m));
    await waitFor(() => (friendHub.state as any).players?.size === 2);
    leaderHub.send("party", { action: "invite", target: friendHub.sessionId });
    await waitFor(() => invite !== null);
    friendHub.send("party", { action: "accept", target: invite!.from });
    await waitFor(() => !!(friendHub.state as any).players.get(friendHub.sessionId)?.party);
    await safeLeave(leaderHub);

    const joined: Room[] = [];
    for (let i = 0; i < 4; i++) joined.push(await joinAs(game, `p${i}`, "hollowmere"));
    rooms.push(...joined);
    const leaderRoom = joined[0]!.roomId;
    // A stranger naming the leader's room gets no headroom seat.
    const stranger = await joinAs(game, "stranger", "hollowmere", { partyLeaderRoomId: leaderRoom });
    rooms.push(stranger);
    expect(stranger.roomId).not.toBe(leaderRoom);
    await safeLeave(friendHub);
    const friend = await joinAs(game, "friend", "hollowmere", { partyLeaderRoomId: leaderRoom });
    rooms.push(friend);
    expect(friend.roomId).toBe(leaderRoom);
  });

  it("direct joins that bypass /api/play are refused", async () => {
    const client = new Client(`http://127.0.0.1:${game.port}`);
    await expect(client.joinOrCreate("body", { body: "portus" })).rejects.toBeTruthy();
  });
});
