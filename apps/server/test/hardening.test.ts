// F12 review should-fix items on the server: S9 no secrets in logs, S10 limiter maps are pruned,
// S12 admin voice mutes survive a restart, S14 admin commands validate their numbers.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matchMaker } from "@colyseus/core";
import type { Room } from "@colyseus/sdk";
import { BODIES, padDirs } from "@firstlight/shared";
import type { Game } from "../src/app.ts";
import { openGameDb, setGameDb } from "../src/db/index.ts";
import { redact } from "../src/ops/errors.ts";
import { isVoiceMuted, resetModeration, setVoiceMuted } from "../src/social/moderation.ts";
import { BodyRoom, pvpPairCount, repeatPvpKill } from "../src/world/BodyRoom.ts";
import { mintHistorySize, turnCredentials } from "../src/world/voice/turn.ts";
import { joinAs, safeLeave, startServer, waitFor } from "./helpers.ts";

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

describe("no secrets in logs (F12 S9)", () => {
  it("a room exception logs what failed and where, never the client, auth or payload", () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a, Object.getOwnPropertyNames(a ?? {})))).join(" "));
    });
    try {
      const err = Object.assign(new Error("handler blew up"), {
        cause: new Error("inner failure"),
        client: { sessionId: "s1", reconnectionToken: "rtok-SECRET-123" },
        auth: { userId: "user-secret-id", name: "Ann" },
        payload: { token: "payload-secret-xyz" },
        options: { body: "portus" },
      });
      BodyRoom.prototype.onUncaughtException.call({ roomId: "room1" } as unknown as BodyRoom, err, "onMessage");
    } finally {
      spy.mockRestore();
    }
    const out = lines.join("\n");
    expect(out).toContain("inner failure");
    expect(out).toContain("onMessage");
    for (const secret of ["rtok-SECRET-123", "user-secret-id", "payload-secret-xyz"]) expect(out).not.toContain(secret);
  });

  it("the admin error log redacts reconnection tokens", () => {
    const text = redact(`client: { sessionId: 'a', reconnectionToken: 'Zx9_secretToken' } "reconnectionToken":"Qq7secret"`);
    expect(text).not.toContain("Zx9_secretToken");
    expect(text).not.toContain("Qq7secret");
  });
});

describe("limiter maps are pruned (F12 S10)", () => {
  it("repeat-PvP-kill pairs are forgotten after 10 minutes", () => {
    const t0 = 1_000_000_000;
    for (let i = 0; i < 50; i++) repeatPvpKill(`k${i}`, `v${i}`, t0);
    expect(repeatPvpKill("k1", "v1", t0 + 60_000)).toBe(true);
    expect(pvpPairCount()).toBeGreaterThanOrEqual(50);
    repeatPvpKill("late", "kill", t0 + 11 * 60_000);
    expect(pvpPairCount()).toBe(1);
  });

  it("TURN mint history drops accounts with no recent mints", () => {
    const t0 = 2_000_000_000;
    for (let i = 0; i < 30; i++) turnCredentials.allowMint(`minter${i}`, t0);
    expect(mintHistorySize()).toBeGreaterThanOrEqual(30);
    turnCredentials.allowMint("someone-later", t0 + 11 * 60_000);
    expect(mintHistorySize()).toBe(1);
  });

  it("a player's inventory rate entry goes when they leave", async () => {
    const game = await startServer();
    try {
      const r = await joinAs(game, "invuser", "portus");
      await waitFor(() => !!(r.state as any).players?.get(r.sessionId));
      const room = matchMaker.getLocalRoomById(r.roomId) as unknown as BodyRoom;
      r.send("move", { from: 0, to: 4 });
      await waitFor(() => (room as any).invOps.has(r.sessionId));
      const sid = r.sessionId;
      await safeLeave(r);
      await waitFor(() => !(room as any).invOps?.has(sid));
    } finally {
      await game.close();
    }
  });
});

describe("admin voice mutes are persisted (F12 S12)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fl-mute-"));
    resetModeration();
  });
  afterEach(() => {
    setGameDb(null);
    resetModeration();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a mute survives a restart (fresh process state, same game.db); unmuting sticks too", () => {
    const file = join(dir, "game.db");
    let db = openGameDb(file);
    setGameDb(db);
    setVoiceMuted("loud", true);
    expect(isVoiceMuted("loud")).toBe(true);
    // Restart: memory gone, database reopened.
    setGameDb(null);
    db.close();
    resetModeration();
    db = openGameDb(file);
    setGameDb(db);
    expect(isVoiceMuted("loud")).toBe(true);
    setVoiceMuted("loud", false);
    setGameDb(null);
    db.close();
    resetModeration();
    db = openGameDb(file);
    setGameDb(db);
    expect(isVoiceMuted("loud")).toBe(false);
    db.close();
  });
});

describe("admin commands validate numbers (F12 S14)", () => {
  let game: Game;
  const rooms: Room[] = [];
  beforeEach(async () => {
    game = await startServer();
  });
  afterEach(async () => {
    for (const r of rooms.splice(0)) await safeLeave(r);
    await game.close();
  });

  it("NaN, infinite, fractional and out-of-range arguments are refused", async () => {
    const r = await joinAs(game, "sloppyadmin", "arcadia", {}, "admin");
    rooms.push(r);
    const me = () => (r.state as any).players.get(r.sessionId);
    await waitFor(() => !!me());
    const actor = () => (matchMaker.getLocalRoomById(r.roomId) as unknown as BodyRoom).actors.get(r.sessionId)!;
    const denied: string[] = [];
    r.onMessage("denied", (m: { action: string; reason: string }) => m.action === "admin" && denied.push(m.reason));
    const before = [me().x, me().y, me().z];
    const inventory = () => [...actor().char.hotbar, ...actor().char.backpack].filter(Boolean).map((s) => `${s!.id}:${s!.tier}:${s!.qty}`);
    const items0 = inventory();
    r.send("admin", { cmd: "teleport", args: { x: Number.NaN, y: 1, z: 2 } });
    r.send("admin", { cmd: "teleport", args: { x: Number.POSITIVE_INFINITY, y: 1, z: 2 } });
    r.send("admin", { cmd: "give", args: { id: "carbine", tier: 2.5 } });
    r.send("admin", { cmd: "give", args: { id: "tonic_small", qty: -3 } });
    r.send("admin", { cmd: "level", args: { level: 7.5 } });
    r.send("admin", { cmd: "level", args: { level: 99 } });
    r.send("admin", { cmd: "coins", args: { amount: Number.NaN } });
    r.send("admin", { cmd: "coins", args: { amount: 1e12 } });
    r.send("admin", { cmd: "damage", args: { amount: Number.NEGATIVE_INFINITY } });
    await waitFor(() => denied.length >= 9);
    await sleep(100);
    expect([me().x, me().y, me().z]).toEqual(before);
    const a = actor();
    expect(inventory()).toEqual(items0);
    expect(a.char.level).toBe(1);
    expect(Number.isFinite(a.char.coins)).toBe(true);
    expect(a.char.coins).toBe(0);
    expect(me().hp).toBe(me().maxHp);
    // Valid arguments still work.
    const R = BODIES.arcadia.radius;
    const d = padDirs(BODIES.arcadia)[0]!;
    r.send("admin", { cmd: "level", args: { level: 7 } });
    r.send("admin", { cmd: "teleport", args: { x: d[0] * R, y: d[1] * R, z: d[2] * R } });
    await waitFor(() => actor().char.level === 7);
  });
});
