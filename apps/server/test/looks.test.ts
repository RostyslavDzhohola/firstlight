// Starter looks (content.md §2.4: Kappa and Unit 7 each have a second look): the look a new character
// picks on /api/play, the look a living character switches to, the look a rebirth picks, and what every
// client sees (PlayerState.look). Unknown looks fall back to the starter's original.

import type { Room } from "@colyseus/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newCharacter } from "@firstlight/shared/content/character";
import { lookId, STARTER_LOOKS, STARTERS, starterLook } from "@firstlight/shared/content/weapons";
import type { Game } from "../src/app.ts";
import { characterRepo } from "../src/world/characters.ts";
import { joinAs, safeLeave, startServer, waitFor } from "./helpers.ts";
import { adminBot, me, nearPad, serverRoom, sleep, st } from "./npc-bots.ts";

let game: Game;
const rooms: Room[] = [];

beforeEach(async () => {
  game = await startServer();
});
afterEach(async () => {
  for (const r of rooms.splice(0)) await safeLeave(r);
  await game.close();
});

const KAPPA = STARTERS.findIndex((s) => s.id === "kappa");
const UNIT7 = STARTERS.findIndex((s) => s.id === "unit7");

async function join(name: string, extra: Record<string, unknown>): Promise<Room> {
  const r = await joinAs(game, name, "portus", extra, "", false);
  rooms.push(r);
  await waitFor(() => !!me(r));
  return r;
}

const actorOf = (r: Room) => serverRoom(r).actors.get(r.sessionId)!;

describe("starter looks: content", () => {
  it("lists every starter, with its original first and unique ids", () => {
    expect(STARTER_LOOKS).toHaveLength(STARTERS.length);
    STARTERS.forEach((s, i) => expect(STARTER_LOOKS[i]![0]!.id).toBe(s.id));
    const ids = STARTER_LOOKS.flat().map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(STARTER_LOOKS[KAPPA]!.map((l) => l.id)).toEqual(["kappa", "kappa_b"]);
    expect(STARTER_LOOKS[UNIT7]!.map((l) => l.id)).toEqual(["unit7", "unit7_b"]);
  });

  it("falls back to the original for a look the starter doesn't have", () => {
    expect(starterLook(KAPPA, 1)).toBe(1);
    expect(starterLook(0, 1)).toBe(0);
    expect(starterLook(KAPPA, 2)).toBe(0);
    expect(starterLook(KAPPA, -1)).toBe(0);
    expect(starterLook(KAPPA, 0.5)).toBe(0);
    expect(starterLook(KAPPA, "1")).toBe(0);
    expect(lookId(UNIT7, 1)).toBe("unit7_b");
    expect(lookId(UNIT7, 9)).toBe("unit7");
    expect(newCharacter(KAPPA, 3, 0, 1).look).toBe(1);
    expect(newCharacter(0, 3, 0, 1).look).toBe(0);
  });
});

describe("starter looks: in the world", () => {
  it("a new character takes the look it picked, and everyone sees it", async () => {
    const a = await join("look-new", { starter: KAPPA, palette: 1, look: 1 });
    expect(me(a)).toMatchObject({ starter: KAPPA, palette: 1, look: 1 });
    expect(actorOf(a).char.look).toBe(1);
    const b = await join("look-watch", { starter: 0 });
    await waitFor(() => st(b).players.get(a.sessionId)?.look === 1);
    expect(me(b).look).toBe(0);
  });

  it("a look the starter doesn't have is the original", async () => {
    const a = await join("look-bad", { starter: 0, look: 1 });
    expect(me(a).look).toBe(0);
    const b = await join("look-big", { starter: UNIT7, look: 99 });
    expect(me(b).look).toBe(0);
  });

  it("a living character switches looks; an unknown look is refused", async () => {
    const a = await join("look-switch", { starter: UNIT7, look: 0 });
    const denied: { action: string; reason: string }[] = [];
    a.onMessage("denied", (m) => denied.push(m));
    a.send("look", { look: 1 });
    await waitFor(() => me(a).look === 1);
    expect(actorOf(a).char.look).toBe(1);
    a.send("look", { look: 2 });
    await waitFor(() => denied.some((d) => d.action === "look"));
    expect(me(a).look).toBe(1);
    await sleep(1100); // look changes are capped at 2 a second (MESSAGE_RATES)
    a.send("look", { look: 0 });
    await waitFor(() => me(a).look === 0);
  });

  it("keeps the look across a rejoin", async () => {
    await join("look-keep", { starter: KAPPA, look: 1 });
    await safeLeave(rooms.pop()!);
    const b = await join("look-keep", { starter: 0, look: 0 }); // an existing character ignores the pick
    expect(me(b)).toMatchObject({ starter: KAPPA, look: 1 });
  });

  it("rebirth takes the look picked on the death screen", async () => {
    const r = await adminBot(game, rooms, "look-reborn", "arcadia", nearPad("arcadia", 0, 70));
    const reborn: unknown[] = [];
    r.onMessage("reborn", (m) => reborn.push(m));
    r.send("admin", { cmd: "damage", args: { amount: 100_000 } });
    await waitFor(() => actorOf(r).dead === true);
    r.send("respawn", { starter: KAPPA, palette: 2, look: 1 });
    await waitFor(() => reborn.length > 0);
    const c = characterRepo.current.load("look-reborn")!;
    expect(c).toMatchObject({ starter: KAPPA, palette: 2, look: 1 });
  });
});
