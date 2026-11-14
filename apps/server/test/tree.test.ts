// The build tree on the real path (#81, content/tree.ts): bots send `tree` like the client; the
// tree system decides, saves at once and answers in `you.tree`; a node's effect shows where the
// number is used (max HP here; movement and the store below). Points go with the level on death.

import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BODIES, isSafe } from "@firstlight/shared";
import { playerMaxHp, RESPEC, TREE, treePoints } from "@firstlight/shared/content/tree";
import { ensureAccount, killCharacter, loadCharacter, openGameDb, saveCharacter, type CharacterData, type Db } from "../src/db/index.ts";
import { dodgeReady, moveLimits } from "../src/world/movement.ts";
import { tempDir } from "./auth-helpers.ts";
import { safeLeave, startServer, waitFor } from "./helpers.ts";
import { bot, dieAndRejoin, harness, me, offPad, serverRoom, sleep, tpAndWait, until, type Bot } from "./quest-helpers.ts";

const denials = (b: Bot) => (b.msgs.get("denied") ?? []).filter((m) => m.action === "tree").map((m) => m.reason as string);
const tree = (b: Bot) => b.you?.tree as { nodes: string[]; points: number; respec: number } | undefined;
const actorOf = (b: Bot) => serverRoom(b).actors.get(b.id)!;

async function spend(b: Bot, node: string) {
  const before = tree(b)?.nodes.length ?? 0, refused = denials(b).length;
  b.send("tree", { action: "spend", node });
  await until(`spend ${node}`, () => (tree(b)?.nodes.length ?? 0) > before || denials(b).length > refused);
  return denials(b).length > refused ? denials(b).at(-1) : null;
}

describe("build tree on a live room (#81)", () => {
  beforeEach(async () => {
    harness.game = await startServer();
  });
  afterEach(async () => {
    for (const r of harness.rooms.splice(0)) await safeLeave(r);
    await harness.game!.close();
  });

  it("spends a point per level in any branch, top-down, and max HP follows Hardy at once", async () => {
    const b = await bot("brancher", "arcadia");
    expect(tree(b)).toEqual({ nodes: [], points: 0, respec: 0 });
    expect(await spend(b, "body_hardy")).toBe("points");
    b.send("admin", { cmd: "level", args: { level: 5 } });
    await until("level 5", () => tree(b)?.points === treePoints(5));
    const plain = me(b).maxHp;
    expect(await spend(b, "body_hardy")).toBeNull();
    await until("max hp", () => me(b).maxHp > plain);
    expect(me(b).maxHp).toBe(playerMaxHp({ starter: actorOf(b).char.starter, level: 5, tree: ["body_hardy"] }));
    // The second row needs the first; any branch is open.
    expect(await spend(b, "blade_cleave")).toBe("locked");
    expect(await spend(b, "blade_edge")).toBeNull();
    expect(await spend(b, "blade_edge")).toBe("taken");
    await sleep(1100); // `tree` is capped at 5 a second (the next one would be dropped)
    expect(await spend(b, "blade_cleave")).toBeNull();
    expect(tree(b)).toEqual({ nodes: ["body_hardy", "blade_edge", "blade_cleave"], points: 0, respec: 4 * RESPEC.coinsPerPoint });
    expect(await spend(b, "travel_stride")).toBe("points");
    await sleep(1100);
    // An unknown node is dropped by the schema (no answer, nothing taken).
    b.send("tree", { action: "spend", node: "body_godmode" });
    await sleep(200);
    expect(tree(b)?.nodes).toHaveLength(3);
  }, 20_000);

  it("respecs only in a safe zone and only for the coins; the tree comes back empty", async () => {
    const b = await bot("respecer", "portus");
    b.send("admin", { cmd: "level", args: { level: 4 } });
    await waitFor(() => tree(b)?.points === 3);
    expect(await spend(b, "magic_attuned")).toBeNull();
    expect(await spend(b, "magic_quickened")).toBeNull();
    const cost = 3 * RESPEC.coinsPerPoint;
    // No coins yet.
    const a = actorOf(b);
    expect(isSafe(BODIES.portus, me(b).x, me(b).y, me(b).z)).toBe(true);
    b.send("tree", { action: "respec" });
    await waitFor(() => denials(b).includes("coins"));
    b.send("admin", { cmd: "coins", args: { amount: cost + 5 } });
    await waitFor(() => a.char.coins === cost + 5);
    // Out of town: refused.
    await tpAndWait(b, offPad("portus", 0, 60));
    if (!serverRoom(b).safeNow(a, Date.now())) {
      b.send("tree", { action: "respec" });
      await waitFor(() => denials(b).includes("safe zone"));
    }
    await tpAndWait(b, offPad("portus", 0, 0));
    await waitFor(() => serverRoom(b).safeNow(a, Date.now()));
    b.send("tree", { action: "respec" });
    await waitFor(() => tree(b)?.nodes.length === 0);
    expect(tree(b)).toEqual({ nodes: [], points: 3, respec: 0 });
    expect(a.char.coins).toBe(5);
  }, 20_000);

  it("loses the points with the level on death; the reborn character starts with none", async () => {
    const b = await bot("mortal", "arcadia");
    b.send("admin", { cmd: "level", args: { level: 3 } });
    await waitFor(() => tree(b)?.points === 2);
    expect(await spend(b, "travel_stride")).toBeNull();
    const { bot: again } = await dieAndRejoin(b, "mortal", "arcadia");
    await waitFor(() => tree(again) !== undefined);
    expect(tree(again)).toEqual({ nodes: [], points: 0, respec: 0 });
  }, 30_000);

  it("Second Roll lets two rolls out before the cooldown; Long Stride raises the pace the server allows", async () => {
    const b = await bot("roller", "arcadia");
    const a = actorOf(b);
    const now = Date.now();
    const plain = moveLimits(a, now);
    expect(plain.dodgeCharges).toBeUndefined();
    b.send("admin", { cmd: "level", args: { level: 6 } });
    await waitFor(() => tree(b)?.points === 5);
    for (const n of ["body_hardy", "body_second_roll", "travel_stride"]) expect(await spend(b, n)).toBeNull();
    const built = moveLimits(a, Date.now());
    expect(built.dodgeCharges).toBe(2);
    expect(built.sprint!).toBeCloseTo(plain.sprint! * 1.06, 5);
    const ms = built.dodgeCooldownMs!;
    const t = Date.now();
    expect(dodgeReady({ lastDodgeAt: t - 100, dodgeTimes: [t - 100] }, t, ms, 2)).toBe(true);
    expect(dodgeReady({ lastDodgeAt: t - 50, dodgeTimes: [t - 100, t - 50] }, t, ms, 2)).toBe(false);
    expect(dodgeReady({ lastDodgeAt: t - 50, dodgeTimes: [t - ms - 1, t - 50] }, t, ms, 2)).toBe(true);
    expect(dodgeReady({ lastDodgeAt: t - 100 }, t, ms, 1)).toBe(false);
  }, 20_000);
});

describe("build tree storage (migration 12)", () => {
  let dir: string;
  let db: Db;
  beforeEach(() => {
    dir = tempDir();
    db = openGameDb(join(dir, "game.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const row = (tree?: string[]): CharacterData => ({
    starter: "unit7", palette: 0, level: 6, xp: 600, coins: 0, hp: 100, body: "arcadia", copyHint: null, x: 1, y: 2, z: 3, heading: 0,
    inventory: {}, missionState: {}, lifeStartedAt: 1, protectedUntil: 0, ...(tree ? { tree } : {}),
  });

  it("saves the nodes with the character, keeps them when a save leaves them out, and drops them with it", () => {
    ensureAccount(db, "u1");
    expect(loadCharacter(db, "u1")).toBeNull();
    saveCharacter(db, "u1", row(["body_hardy", "body_second_roll"]));
    expect(loadCharacter(db, "u1")!.tree).toEqual(["body_hardy", "body_second_roll"]);
    saveCharacter(db, "u1", row());
    expect(loadCharacter(db, "u1")!.tree).toEqual(["body_hardy", "body_second_roll"]);
    saveCharacter(db, "u1", row([]));
    expect(loadCharacter(db, "u1")!.tree).toEqual([]);
    saveCharacter(db, "u1", row(["aim_steady"]));
    killCharacter(db, "u1");
    expect((db.prepare("SELECT COUNT(*) AS n FROM character_tree").get() as { n: number }).n).toBe(0);
  });

  it("moves with the character when a link moves the row, and a save for a missing account writes nothing", () => {
    ensureAccount(db, "guest");
    ensureAccount(db, "saved");
    saveCharacter(db, "guest", row(["magic_attuned"]));
    db.prepare("UPDATE character SET user_id = ? WHERE user_id = ?").run("saved", "guest");
    expect(loadCharacter(db, "saved")!.tree).toEqual(["magic_attuned"]);
    expect(saveCharacter(db, "nobody", row(["blade_edge"]))).toBe(false);
    expect(db.prepare("SELECT 1 FROM character_tree WHERE user_id = 'nobody'").get()).toBeUndefined();
  });

  it("knows every node id once", () => {
    expect(new Set(TREE.map((n) => n.id)).size).toBe(TREE.length);
  });
});
