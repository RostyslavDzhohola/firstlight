import { describe, expect, it } from "vitest";
import { isBlocked, isMuted, isMutedLocally, isPartyMember, onSocialChange, partyRoomOn, setBlockedList, setMuted, setParty, setSessionResolver } from "./store.ts";

const sessions: Record<string, string> = { s1: "u1", s2: "u2", s3: "u3", me: "u0" };

describe("social client store", () => {
  setSessionResolver((sid) => sessions[sid], "u0");

  it("mutes follow the account across session ids; blocks count as muted for voice", () => {
    let changes = 0;
    const off = onSocialChange(() => changes++);
    setMuted("s1", true);
    expect(isMuted("s1")).toBe(true);
    expect(isMutedLocally("s1")).toBe(true);
    // The same account with a new session id after travel.
    sessions.s9 = "u1";
    expect(isMuted("s9")).toBe(true);
    setMuted("s9", false);
    expect(isMuted("s1")).toBe(false);
    setBlockedList(["u2"]);
    expect(isMuted("s2")).toBe(true);
    expect(isMutedLocally("s2")).toBe(false);
    expect(isBlocked("s2") && isBlocked("u2")).toBe(true);
    expect(changes).toBe(3);
    off();
  });

  it("party membership and the room to travel into (leader first)", () => {
    const member = (userId: string, body: string | null, roomId: string | null, online = true) => ({ userId, name: userId, level: 3, online, body, roomId, sessionId: null, x: 0, y: 0, z: 0 });
    setParty({ id: "p1", leader: "u3", members: [member("u0", "portus", "rP"), member("u1", "arcadia", "rA2"), member("u3", "arcadia", "rA1"), member("u2", "meridian", "rM", false)] });
    expect(isPartyMember("s1")).toBe(true);
    expect(isPartyMember("me")).toBe(false);
    expect(isPartyMember("s2")).toBe(true);
    expect(partyRoomOn("arcadia")).toBe("rA1");
    expect(partyRoomOn("meridian")).toBeUndefined(); // offline member
    expect(partyRoomOn("portus")).toBeUndefined(); // only me there
    setParty({ id: null, leader: null, members: [] });
    expect(isPartyMember("s1")).toBe(false);
    expect(partyRoomOn("arcadia")).toBeUndefined();
  });
});
