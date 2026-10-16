// The mission pointer's server half (D-zones-2): `huntTargets` lists the tracked hunt's NPCs whose
// kill would count, by the same rule as the kill credit (missions.ts huntCredit: kind, spawn area,
// quota), and `you.missions` carries per-target counts. Checked against real kills and progress.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Room } from "@colyseus/sdk";
import { BODIES, padDirs, tangentFrame } from "@firstlight/shared";
import { objectPos, WORLD_OBJECT_BY_ID } from "@firstlight/shared/content/world";
import { createTerrain } from "@firstlight/shared";
import type { Game } from "../src/app.ts";
import { NPC_TUNING, resetTuning } from "../src/world/npc/index.ts";
import { characterRepo } from "../src/world/characters.ts";
import { newCharacter } from "@firstlight/shared/content/character";
import { joinAs, safeLeave, startServer, waitFor } from "./helpers.ts";

type V = [number, number, number];
let game: Game;
const rooms: Room[] = [];
let reqSeq = 0;

beforeEach(async () => {
  game = await startServer();
});
afterEach(async () => {
  for (const r of rooms.splice(0)) await safeLeave(r);
  await game.close();
  resetTuning();
});

const me = (r: Room) => (r.state as any).players.get(r.sessionId);

function ask<T = any>(r: Room, type: string, msg: Record<string, unknown>): Promise<T> {
  const req = ++reqSeq;
  return new Promise((ok, fail) => {
    const off = r.onMessage(type, (m: any) => {
      if (m.req !== req) return;
      (off as unknown as () => void)?.();
      ok(m);
    });
    r.send("npc", { ...msg, req });
    setTimeout(() => fail(new Error(`no ${type} reply`)), 3000);
  });
}
const list = (r: Room) => ask<{ npcs: any[] }>(r, "npcList", { cmd: "list" }).then((m) => m.npcs);

/** `metres` from Dawnpad toward where the arrival camera looks, at the radius. */
function ahead(metres: number): V {
  const R = BODIES.arcadia.radius;
  const d = padDirs(BODIES.arcadia)[0]!;
  const { fwd } = tangentFrame([d[0], d[1], d[2]]);
  const v = [d[0] + (fwd[0] * metres) / R, d[1] + (fwd[1] * metres) / R, d[2] + (fwd[2] * metres) / R];
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return [(v[0]! / l) * R, (v[1]! / l) * R, (v[2]! / l) * R];
}

describe("huntTargets and per-target counts (A1, Clover Fields Hopbits)", () => {
  it("lists exactly the Hopbits whose kill counts; killing one advances A1, killing a stray doesn't", async () => {
    NPC_TUNING.ambient = true;
    const r = await joinAs(game, "hunter", "arcadia", { starter: 0 }, "admin");
    rooms.push(r);
    await waitFor(() => !!me(r));
    let you: any = null;
    r.onMessage("you", (m) => (you = m));
    let hunt: { id: string; npcs: string[] } = { id: "", npcs: [] };
    r.onMessage("huntTargets", (m) => (hunt = m));
    // Take A1 from Lark.
    const lark = objectPos(WORLD_OBJECT_BY_ID.get("guide_arcadia")!, (x, y, z) => createTerrain("arcadia").groundHeight(x, y, z));
    r.send("admin", { cmd: "teleport", args: { x: lark[0], y: lark[1], z: lark[2] } });
    await waitFor(() => Math.hypot(me(r).x - lark[0], me(r).y - lark[1], me(r).z - lark[2]) < 3);
    r.send("mission", { action: "accept", id: "A1" });
    await waitFor(() => !!you?.missions?.some((m: any) => m.id === "A1"));
    expect(you.missions.find((m: any) => m.id === "A1").counts).toEqual([0]);
    // Out of the walled outpost (D-b2-1: its north gate, by the farmstead) toward the Clover Fields pack.
    const out = ahead(35);
    r.send("admin", { cmd: "teleport", args: { x: out[0], y: out[1], z: out[2] } });
    r.send("admin", { cmd: "unprotect" });
    await waitFor(() => hunt.id === "A1" && hunt.npcs.length > 0, 10_000);

    // Every listed NPC is a live Clover Fields Hopbit, and every such Hopbit in reach is listed.
    const npcs = await list(r);
    const p: V = [me(r).x, me(r).y, me(r).z];
    const counting = npcs.filter((n) => n.def === "hopbit" && n.area === "clover_fields" && n.hp > 0 && Math.hypot(n.x - p[0], n.y - p[1], n.z - p[2]) <= 100);
    for (const id of hunt.npcs) expect(npcs.find((n) => n.id === id)).toMatchObject({ def: "hopbit", area: "clover_fields" });
    for (const n of counting) expect(hunt.npcs).toContain(n.id);

    // A stray Hopbit (no spawn area: an admin spawn) right beside us is never listed.
    const stray = await ask<{ id: string }>(r, "npcInfo", { cmd: "spawn", kind: "hopbit", x: p[0], y: p[1], z: p[2], instant: true }).then((m) => m.id);
    await new Promise((ok) => setTimeout(ok, 700));
    expect(hunt.npcs).not.toContain(stray);

    // Killing a listed one advances A1 (counts and progress); it leaves the list.
    const kills: any[] = [];
    r.onMessage("npcKill", (m) => kills.push(m));
    const target = hunt.npcs[0]!;
    // (Fresh spawns materialise for a second, taking no damage: hit until it falls.)
    const hurt = (id: string) => r.send("npc", { cmd: "hurt", id, amount: 999, as: r.sessionId });
    hurt(target);
    const iv = setInterval(() => hurt(target), 400);
    await waitFor(() => kills.some((k) => k.id === target)).finally(() => clearInterval(iv));
    await waitFor(() => you.missions.find((m: any) => m.id === "A1").progress === 1);
    expect(you.missions.find((m: any) => m.id === "A1").counts).toEqual([1]);
    await waitFor(() => !hunt.npcs.includes(target));

    // Killing the stray pays the kill but not the mission.
    hurt(stray);
    await waitFor(() => kills.some((k) => k.id === stray));
    await new Promise((ok) => setTimeout(ok, 300));
    expect(you.missions.find((m: any) => m.id === "A1").progress).toBe(1);
  }, 40_000);

  it("a saved active hunt gets its list right after joining (the client holds it from the join)", async () => {
    NPC_TUNING.ambient = true;
    const c = newCharacter(0, 0);
    c.body = "arcadia";
    c.pos = ahead(25);
    c.missions = [{ id: "A1", progress: 0, done: false, counts: [0] }];
    characterRepo.current.save("returning-hunter", c);
    const r = await joinAs(game, "returning-hunter", "arcadia", {}, "admin", false);
    rooms.push(r);
    // Registered at once, like Game does right after joining (huntTargets.ts).
    const lists: { id: string; npcs: string[] }[] = [];
    r.onMessage("huntTargets", (m) => lists.push(m));
    await waitFor(() => lists.some((l) => l.id === "A1" && l.npcs.length > 0), 10_000);
  }, 30_000);
});
