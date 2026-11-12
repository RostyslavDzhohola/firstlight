// AI agents as players (D-agents-1..3, packages/agent-kit): the kit's FirstlightAgent against the
// real server in-process. An agent joins flagged, observes, walks without a movement rejection,
// fights with its starter weapon, takes missions, is refused in a safe zone and by the caps.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FirstlightAgent, type Observation } from "@firstlight/agent-kit";
import { AGENT_HEADER, AGENT_REFUSAL } from "@firstlight/shared/net/agents";
import { PROTOCOL_VERSION } from "@firstlight/shared/net/protocol";
import type { Game } from "../src/app.ts";
import { AGENT_RULES, agentsOnline, resetAgentSlots } from "../src/world/agents.ts";
import { onlineSnapshot } from "../src/ops/home.ts";
import { liveRooms } from "../src/social/index.ts";
import type { Room } from "@colyseus/sdk";
import { grantTravel, joinAs, safeLeave, startServer, waitFor } from "./helpers.ts";
import { ask, me, offset, openSpotOutside } from "./npc-bots.ts";

let game: Game;
let url: string;
const agents: FirstlightAgent[] = [];
const saved = { ...AGENT_RULES, enabled: AGENT_RULES.enabled };

beforeAll(async () => {
  game = await startServer();
  url = `http://127.0.0.1:${game.port}`;
});

afterEach(async () => {
  for (const a of agents.splice(0)) await a.close();
  AGENT_RULES.enabled = saved.enabled;
  AGENT_RULES.perIp = saved.perIp;
  AGENT_RULES.perRoom = saved.perRoom;
  resetAgentSlots();
});

afterAll(async () => {
  await game.close();
});

/** An agent with a dev identity (`id` is its account), placed on `body` like the other tests' bots. */
async function agent(id: string, body = "arcadia", starter: number | string = "unit7"): Promise<FirstlightAgent> {
  grantTravel(id, body, { starter: typeof starter === "number" ? starter : ["hexwick", "ash", "kappa", "unit7", "ninja"].indexOf(starter) });
  const a = new FirstlightAgent();
  agents.push(a);
  const r = await a.connect({ url, token: `dev:${id}:${id}`, body: body as never, starter });
  expect(r.ok).toBe(true);
  return a;
}

describe("agents: joining", () => {
  it("joins flagged as an agent, and other clients see the flag", async () => {
    const a = await agent("agentA");
    const human = await joinAs(game, "humanA");
    try {
      await waitFor(() => (human.state as any).players?.size >= 2);
      const seen = (human.state as any).players.get(a.sessionId);
      expect(seen.agent).toBe(true);
      expect(seen.name).toBe("agentA");
      // The human isn't flagged, in its own state or the agent's.
      expect((human.state as any).players.get(human.sessionId).agent).toBe(false);
      await waitFor(() => a.observe({ peek: true }).players.length === 1);
      const obs = a.observe();
      const other = obs.players.find((p) => p.id === human.sessionId);
      expect(other).toMatchObject({ name: "humanA", agent: false });
      // Public counts are people: the agent is counted apart.
      const online = onlineSnapshot(liveRooms as never);
      expect(online.total).toBe(1);
      expect(online.bodies.arcadia.names).toEqual(["humanA"]);
      expect(agentsOnline()).toBe(1);
    } finally {
      await safeLeave(human);
    }
  });

  it("observe() has the documented shape and a short summary", async () => {
    const a = await agent("agentB");
    await waitFor(() => a.observe({ peek: true }).self.maxHp > 0 && a.observe({ peek: true }).self.hotbar.length > 0);
    const o: Observation = a.observe();
    expect(o.status).toBe("playing");
    expect(o.self).toMatchObject({ name: "agentB", agent: true, body: "arcadia", level: 1, zone: "safe", zoneKind: "outpost", dead: false });
    expect(o.self.hp).toBe(o.self.maxHp);
    expect(o.self.pos).toHaveLength(3);
    expect(o.self.heading).toBeGreaterThanOrEqual(0);
    expect(o.self.weapon).toMatchObject({ id: "carbine", kind: "ranged", slot: 0 });
    expect(o.self.cooldowns).toEqual({ attack: 0, reload: 0, overheat: 0, dodge: 0, tonic: 0 });
    for (const k of ["creatures", "players", "piles", "pads", "portals", "shops", "missions", "offers", "events"] as const) expect(Array.isArray(o[k])).toBe(true);
    expect(o.guide).toMatchObject({ id: "guide", name: "Lark" });
    expect(o.portals[0]).toMatchObject({ id: "portal:portus", to: "portus" });
    expect(o.pads[0]).toMatchObject({ id: "pad:0" });
    expect(o.offers.map((m) => m.id)).toEqual(["A1", "A2", "A3"]);
    expect(o.summary).toContain("agentB [AI] L1 on arcadia");
    expect(Buffer.byteLength(o.summary)).toBeLessThan(1500);
    expect(Buffer.byteLength(JSON.stringify(o))).toBeLessThan(6000);
  });
});

describe("agents: limits", () => {
  it("the per-address cap refuses the extra agent with a clear message, and frees up when one leaves", async () => {
    AGENT_RULES.perIp = 2;
    const a1 = await agent("capA");
    await agent("capB");
    grantTravel("capC", "arcadia");
    const third = new FirstlightAgent();
    agents.push(third);
    await expect(third.connect({ url, token: "dev:capC:capC", body: "arcadia" })).rejects.toMatchObject({ code: AGENT_REFUSAL.LIMIT, message: expect.stringContaining("Too many AI agents are playing from this address (2 of 2)") });
    // People from the same address aren't counted.
    const human = await joinAs(game, "capHuman");
    await safeLeave(human);
    // One agent leaves (in the safe zone: its body goes at once), the third gets in.
    await a1.close();
    await waitFor(() => agentsOnline() === 1);
    expect((await third.connect({ url, token: "dev:capC:capC", body: "arcadia" })).ok).toBe(true);
  });

  it("the switch turns agents away, the header alone flags a player, and people are unaffected", async () => {
    AGENT_RULES.enabled = false;
    grantTravel("offA", "arcadia");
    const a = new FirstlightAgent();
    agents.push(a);
    await expect(a.connect({ url, token: "dev:offA:offA", body: "arcadia" })).rejects.toMatchObject({ code: AGENT_REFUSAL.OFF });
    const human = await joinAs(game, "offHuman");
    await waitFor(() => !!(human.state as any).players?.get(human.sessionId));
    expect((human.state as any).players.get(human.sessionId).agent).toBe(false);
    await safeLeave(human);
    AGENT_RULES.enabled = true;
    // Any client that sends the header is an agent (the kit also sends the body field).
    grantTravel("hdrA", "arcadia");
    const res = await fetch(`${url}/api/play`, { method: "POST", headers: { Authorization: "Bearer dev:hdrA:hdrA", "Content-Type": "application/json", [AGENT_HEADER]: "1" }, body: JSON.stringify({ body: "arcadia", v: PROTOCOL_VERSION }) });
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("the per-room cap sends agents to another copy, then refuses", async () => {
    AGENT_RULES.perRoom = 1;
    const a1 = await agent("roomA");
    const a2 = await agent("roomB");
    expect(a2.room!.roomId).not.toBe(a1.room!.roomId); // a second copy opened for it
    grantTravel("roomC", "arcadia");
    const third = new FirstlightAgent();
    agents.push(third);
    await expect(third.connect({ url, token: "dev:roomC:roomC", body: "arcadia" })).rejects.toMatchObject({ code: AGENT_REFUSAL.LIMIT, message: expect.stringContaining("Every copy of this world") });
  });
});

// From here on agents leave the safe zone: a body left out there lingers for 30 s (and counts
// towards the caps), which is why the limits are tested above.
describe("agents: moving", () => {
  it("walks 40 m and out through the outpost gate without one movement rejection", async () => {
    const a = await agent("agentC");
    const from = a.position;
    const r = await a.moveTo({ bearing: 90, distance: 40 }, { seconds: 40 });
    expect(r).toMatchObject({ ok: true, corrections: 0 });
    expect(a.corrections).toBe(0);
    expect(Math.hypot(a.position[0] - from[0], a.position[1] - from[1], a.position[2] - from[2])).toBeGreaterThan(35);
    expect(r.walked as number).toBeGreaterThanOrEqual(39);
    // The server agrees on where the body is.
    const room = [...liveRooms].find((x) => x.actors.has(a.sessionId))!;
    const actor = room.actors.get(a.sessionId)!;
    expect(actor.violations).toBe(0);
    await waitFor(() => Math.hypot(actor.state.x - a.position[0], actor.state.y - a.position[1], actor.state.z - a.position[2]) < 0.5);
  }, 60_000);
});


describe("agents: missions and fighting", () => {
  const rooms: Room[] = [];
  afterEach(async () => {
    for (const r of rooms.splice(0)) await safeLeave(r);
  });

  it("walks to the guide and takes the missions", async () => {
    const a = await agent("agentD");
    expect(await a.takeMissions()).toMatchObject({ ok: false, reason: "too far" });
    expect(await a.moveTo("guide")).toMatchObject({ ok: true, corrections: 0 });
    const talk = await a.interact();
    expect(talk).toMatchObject({ ok: true, talkedTo: "Lark" });
    const r = await a.takeMissions();
    expect(r.ok).toBe(true);
    expect((r.taken as { id: string }[]).map((m) => m.id)).toEqual(["A1", "A2", "A3"]);
    const o = a.observe();
    expect(o.offers).toEqual([]);
    expect(o.missions.map((m) => [m.id, m.progress, m.goal, m.done])).toEqual([["A1", 0, 8, false], ["A2", 0, 1, false], ["A3", 0, 1, false]]);
    expect(o.missions[0]!.where!.dist).toBeGreaterThan(20);
    expect(o.events.some((e) => e.text.startsWith("Mission accepted: Pest Control"))).toBe(true);
    expect(o.summary).toContain("A1 Pest Control 0/8");
  }, 40_000);

  it("is refused cleanly in a safe zone", async () => {
    const a = await agent("agentE");
    const admin = await joinAs(game, "adminE", "arcadia", { starter: 3 }, "admin");
    rooms.push(admin);
    await waitFor(() => !!me(admin));
    const p = a.position;
    const at = offset(p, 3, 0, 500);
    const npc = await ask<{ id: string }>(admin, "npcInfo", { cmd: "spawn", kind: "woolback", x: at[0], y: at[1], z: at[2], instant: true, roam: 0 });
    await waitFor(() => a.observe({ peek: true }).creatures.some((c) => c.id === npc.id));
    await waitFor(() => a.observe({ peek: true }).self.protectedFor === 0, 8000);
    const r = await a.attack(npc.id, { seconds: 8 });
    expect(r).toMatchObject({ ok: false, killed: false, reason: "safe zone" });
    expect(String(r.hint)).toContain("safe zone");
    expect(a.observe().creatures.find((c) => c.id === npc.id)!.hp).toBeGreaterThan(0);
    // Things that need a place say where to go instead of failing silently.
    expect(await a.buy("tonic_small")).toMatchObject({ ok: false, reason: "too far" });
    expect(await a.enterPortal("meridian")).toMatchObject({ ok: false, reason: "no such portal" });
    expect(await a.travel(3)).toMatchObject({ ok: false, reason: "undiscovered" });
    expect(await a.respawn()).toMatchObject({ ok: false, reason: "not dead" });
    expect(await a.moveTo("nowhere")).toMatchObject({ ok: false, reason: "unknown target" });
  }, 40_000);

  it("walks out, kills a creature with its starter weapon and gets XP", async () => {
    const a = await agent("agentF");
    const admin = await joinAs(game, "adminF", "arcadia", { starter: 3 }, "admin");
    rooms.push(admin);
    await waitFor(() => !!me(admin));
    const spot = openSpotOutside("arcadia");
    expect(await a.moveTo({ pos: spot }, { sprint: true, seconds: 40 })).toMatchObject({ ok: true, corrections: 0 });
    expect(a.observe().self.zone).toBe("danger");
    const at = offset(spot, 7, 0, 500);
    const npc = await ask<{ id: string }>(admin, "npcInfo", { cmd: "spawn", kind: "hopbit", x: at[0], y: at[1], z: at[2], instant: true });
    await waitFor(() => a.observe({ peek: true }).creatures.some((c) => c.id === npc.id));
    const before = a.observe();
    expect(before.creatures.find((c) => c.id === npc.id)).toMatchObject({ kind: "hopbit", name: "Hopbit", hostile: true, boss: false });
    const r = await a.attack(npc.id, { seconds: 30 });
    expect(r).toMatchObject({ ok: true, killed: true, target: "Hopbit" });
    expect(r.xp as number).toBeGreaterThan(0);
    await waitFor(() => a.observe({ peek: true }).self.xp > before.self.xp || a.observe({ peek: true }).self.level > before.self.level);
    const after = a.observe();
    expect(after.events.some((e) => e.type === "kill" && e.text.startsWith("killed Hopbit"))).toBe(true);
    expect(after.events.some((e) => e.type === "hit" && e.text.includes("damage to Hopbit"))).toBe(true);
    expect(a.corrections).toBe(0);
  }, 90_000);
});
