// Review 2026-11-13 #3: the `track` message (#69) shares the five-a-second quest budget. A throttled
// change used to vanish silently while the client showed it; now it is refused with `denied`, and an
// accepted one is acknowledged with `tracked {id}` (the choice the hunt targets follow from then on).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Room } from "@colyseus/sdk";
import type { Game } from "../src/app.ts";
import { characterRepo } from "../src/world/characters.ts";
import { newCharacter } from "@firstlight/shared/content/character";
import { joinAs, safeLeave, startServer, waitFor } from "./helpers.ts";

let game: Game;
const rooms: Room[] = [];
beforeEach(async () => {
  game = await startServer();
});
afterEach(async () => {
  for (const r of rooms.splice(0)) await safeLeave(r);
  await game.close();
});

async function tracker(id: string): Promise<Room> {
  const c = newCharacter(0, 0);
  c.body = "arcadia";
  c.missions = [{ id: "A1", progress: 0, done: false, counts: [0] }, { id: "A3", progress: 0, done: false }];
  characterRepo.current.save(id, c);
  const r = await joinAs(game, id, "arcadia");
  rooms.push(r);
  return r;
}

describe("tracking a mission (#69, review #3)", () => {
  it("acknowledges an accepted choice with the id it now follows", async () => {
    const r = await tracker("ack-tracker");
    const acks: (string | null)[] = [];
    r.onMessage("tracked", (m: { id: string | null }) => acks.push(m.id));
    r.send("track", { id: "A3" });
    await waitFor(() => acks.includes("A3"), 5000);
    r.send("track", { id: null });
    await waitFor(() => acks.includes(null), 5000);
  }, 30_000);

  it("refuses a throttled change with denied, never silently", async () => {
    const r = await tracker("burst-tracker");
    const denied: { action: string; reason: string }[] = [];
    const acks: (string | null)[] = [];
    r.onMessage("denied", (m: { action: string; reason: string }) => denied.push(m));
    r.onMessage("tracked", (m: { id: string | null }) => acks.push(m.id));
    for (let i = 0; i < 8; i++) r.send("track", { id: i % 2 ? "A1" : "A3" });
    await waitFor(() => acks.length + denied.length >= 8, 5000);
    expect(acks).toHaveLength(5);
    expect(denied.filter((d) => d.action === "track")).toHaveLength(3);
    expect(denied[0]!.reason).toBe("slow down");
  }, 30_000);
});
