// Lumen, Arcadia's moon (#6): low gravity the server validates, soft landings, the portals up and
// down, and its own creatures in the room.

import { afterEach, describe, expect, it } from "vitest";
import type { Room } from "@colyseus/sdk";
import { matchMaker } from "@colyseus/core";
import { BASE_GRAVITY, BODIES, bodyGravity, createTerrain, padDirs, portalSpots } from "@firstlight/shared";
import { fallDamageFraction } from "@firstlight/shared/content/progression";
import { NPC_DEFS } from "@firstlight/shared/content/npcs";
import type { Game } from "../src/app.ts";
import type { BodyRoom } from "../src/world/BodyRoom.ts";
import type { PlayerActor } from "../src/world/actors.ts";
import { motionFields, validateMove, type MoveWorld } from "../src/world/movement.ts";
import { NPC_TUNING } from "../src/world/npc/tuning.ts";
import { joinAs, safeLeave, startServer, waitFor } from "./helpers.ts";
import { ask } from "./npc-bots.ts";

describe("Lumen's low gravity (#6)", () => {
  /** A standing jump straight up: one step to `rise` m above the ground `ms` after leaving it. */
  function jump(body: "lumen" | "arcadia", rise: number, ms: number) {
    const def = BODIES[body], t = createTerrain(def);
    const d = padDirs(def)[3]!;
    const len = def.radius + t.groundHeight(d[0], d[1], d[2]);
    const a = { lastX: d[0] * len, lastY: d[1] * len, lastZ: d[2] * len, ...motionFields(len, 0, bodyGravity(def)) } as unknown as PlayerActor;
    const w: MoveWorld = { radius: def.radius, waterLevel: def.waterLevel, groundAt: (x, y, z) => t.groundHeightAt(x, y, z) };
    const up = len + rise;
    return validateMove(a, { x: d[0] * up, y: d[1] * up, z: d[2] * up, anim: 4 }, w, { speed: 1, dodge: 1 }, ms).ok;
  }

  it("pulls a quarter as hard as everywhere else", () => {
    expect(bodyGravity(BODIES.lumen)).toBe(BASE_GRAVITY / 4);
    for (const b of ["portus", "arcadia", "hollowmere", "meridian"] as const) expect(bodyGravity(BODIES[b])).toBe(BASE_GRAVITY);
  });

  it("lets a jump rise about 5 m and hang there on Lumen, and refuses the same on Arcadia", () => {
    expect(jump("lumen", 4.5, 1300)).toBe(true);
    expect(jump("arcadia", 4.5, 1300)).toBe(false);
    // Still a ballistic envelope: no higher than a Lumen jump allows.
    expect(jump("lumen", 7, 1300)).toBe(false);
  });

  it("lands softly: a 20 m drop hurts on Arcadia, not on Lumen", () => {
    expect(fallDamageFraction(20)).toBeGreaterThan(0.5);
    expect(fallDamageFraction(20, bodyGravity(BODIES.lumen))).toBe(0);
    expect(fallDamageFraction(60, bodyGravity(BODIES.lumen))).toBeGreaterThan(0);
  });
});

describe("the way up and back (#6)", () => {
  it("Arcadia has a portal up to Lumen across Dawnpad, and Lumen's portal goes back down to Arcadia", () => {
    const up = portalSpots(BODIES.arcadia, createTerrain("arcadia"));
    expect(up.map((p) => p.to)).toEqual(["portus", "lumen"]);
    const [home, moon] = up;
    expect(Math.hypot(home!.center[0] - moon!.center[0], home!.center[1] - moon!.center[1], home!.center[2] - moon!.center[2])).toBeGreaterThan(15);
    expect(portalSpots(BODIES.lumen, createTerrain("lumen")).map((p) => p.to)).toEqual(["arcadia"]);
    for (const b of ["hollowmere", "meridian"] as const) expect(portalSpots(BODIES[b], createTerrain(b)).map((p) => p.to)).toEqual(["portus"]);
  });
});

describe("a Lumen room", () => {
  let game: Game | null = null;
  const rooms: Room[] = [];
  afterEach(async () => {
    for (const r of rooms.splice(0)) await safeLeave(r);
    await game?.close();
    NPC_TUNING.ambient = false;
  });

  it("takes travel up from Arcadia's moon portal and fills Lumen with its own creatures", async () => {
    game = await startServer();
    const r = await joinAs(game, "moonward", "arcadia", { starter: 0 });
    rooms.push(r);
    const room = matchMaker.getLocalRoomById(r.roomId) as unknown as BodyRoom;
    await waitFor(() => room.actors.has(r.sessionId));
    const a = room.actors.get(r.sessionId)!;
    const spot = room.portals.find((p) => p.to === "lumen")!;
    a.state.x = a.lastX = spot.center[0];
    a.state.y = a.lastY = spot.center[1];
    a.state.z = a.lastZ = spot.center[2];
    r.send("travel", { to: "lumen" });
    await waitFor(() => a.char.travelTo === "lumen");

    NPC_TUNING.ambient = true;
    const m = await joinAs(game, "moonwalker", "lumen", { starter: 0 }, "admin");
    rooms.push(m);
    // The list reports kinds by index into NPC_DEFS.
    const lunar = new Set(NPC_DEFS.flatMap((d, i) => (d.planet === "lumen" ? [i] : [])));
    let kinds: number[] = [];
    await waitFor(() => {
      void ask<{ npcs: { kind: number }[] }>(m, "npcList", { cmd: "list" }).then((l) => (kinds = l.npcs.map((n) => n.kind)), () => {});
      return kinds.some((k) => lunar.has(k));
    }, 20_000);
    expect(lunar.size).toBe(3);
    expect(kinds.filter((k) => !lunar.has(k)).map((k) => NPC_DEFS[k]!.id)).toEqual([]);
  }, 60_000);
});
