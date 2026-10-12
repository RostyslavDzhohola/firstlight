// Seam 1: accounts over HTTP + SDK against the real server (Better Auth, game.db, /api/play).

import { afterEach, describe, expect, it } from "vitest";
import type { Room } from "@colyseus/sdk";
import { awardMedal, discoverPad, getAccount, loadCharacter, saveCharacter, type CharacterData } from "../src/db/index.ts";
import type { AccountLinkedEvent } from "../src/auth/links.ts";
import { api, Browser, decodeJwt, joinWithToken, play, startAuthServer, type AuthServer } from "./auth-helpers.ts";
import { waitFor } from "./helpers.ts";

let server: AuthServer | null = null;
const rooms: Room[] = [];

afterEach(async () => {
  for (const r of rooms.splice(0)) await r.leave().catch(() => {});
  await server?.close();
  server = null;
});

function charData(level: number, extra: Partial<CharacterData> = {}): CharacterData {
  return {
    starter: "ember",
    palette: 2,
    level,
    xp: level * 100,
    coins: 40,
    hp: 100,
    body: "arcadia",
    copyHint: 0,
    x: 1,
    y: 2,
    z: 3,
    heading: 0.5,
    inventory: [{ id: "hexquill" }],
    missionState: { hunt: 2 },
    lifeStartedAt: 1000,
    protectedUntil: 0,
    ...extra,
  };
}

describe("guest play", () => {
  it("a guest signs in anonymously, gets a JWT and enters the world through /api/play", async () => {
    server = await startAuthServer();
    const b = new Browser(server);
    const token = await b.playToken();
    const claims = decodeJwt(token);
    expect(typeof claims.sub).toBe("string");
    expect(claims.guest).toBe(true);
    expect(String(claims.name)).toMatch(/^Wanderer-\d{4}$/);

    const room = await joinWithToken(server, token, "portus");
    rooms.push(room);
    await waitFor(() => (room.state as any).players?.size === 1);
    const me = (room.state as any).players.get(room.sessionId);
    expect(me.userId).toBe(claims.sub);
    expect(me.name).toBe(claims.name);
  });

  it("the JWT payload carries name and guest flag only — never the email", async () => {
    server = await startAuthServer();
    const b = new Browser(server);
    await b.playToken();
    await b.saveWithEmail("keeper@example.test", "Keeper");
    const t = await b.client.token();
    const claims = decodeJwt(t.data!.token);
    expect(JSON.stringify(claims)).not.toContain("example.test");
    expect(claims.email).toBeUndefined();
    expect(Object.keys(claims).sort()).toEqual(["aud", "exp", "guest", "iat", "iss", "name", "sub"]);
    expect(claims.guest).toBe(false);
    expect(claims.name).toBe("Keeper");
  });

  it("garbage, foreign and tampered tokens are refused", async () => {
    server = await startAuthServer();
    const b = new Browser(server);
    const token = await b.playToken();
    expect((await play(server, "not-a-jwt")).status).toBe(401);
    const [h, p, s] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...decodeJwt(token), sub: "someone-else" })).toString("base64url");
    expect((await play(server, `${h}.${forged}.${s}`)).status).toBe(401);
    // a token from another server (different signing key)
    const other = await startAuthServer();
    const foreign = await new Browser(other).playToken();
    await other.close();
    expect((await play(server, foreign)).status).toBe(401);
  });
});
