// The residents runner (tools/agent/residents.ts) against the real server in-process: scripted AI
// characters join flagged as agents, walk the real way in (Portus, the portal, the outpost gate),
// one farms a creature, nobody is corrected by the server, and they leave when told to.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAST, plan, residentId, runResidents } from "@firstlight/agent-tools/residents";
import { bodyWorld } from "@firstlight/agent-kit";
import { nearArena, roundArena, stopsOn } from "@firstlight/agent-tools/resident-roles";
import { GLEAMS } from "@firstlight/shared/content/gleams";
import { GUIDES } from "@firstlight/shared/content/missions";
import { NPC_DEFS } from "@firstlight/shared/content/npcs";
import { SHOP_SPOTS } from "@firstlight/shared/content/shops";
import { STARTERS } from "@firstlight/shared/content/weapons";
import type { Game } from "../src/app.ts";
import { AGENT_RULES, agentsOnline, resetAgentSlots } from "../src/world/agents.ts";
import { NPC_TUNING } from "../src/world/npc/index.ts";
import { liveRooms } from "../src/social/index.ts";
import { startServer, waitFor } from "./helpers.ts";

let game: Game;
let url: string;
/** Name words already in the game (guides, keepers, the curator, starters, creatures), lower case, 4+ letters. */
const WORLD_NAMES = [...new Set([...Object.values(GUIDES).map((g) => g.name), ...SHOP_SPOTS.map((s) => s.keeper), GLEAMS.curator.name, ...STARTERS.map((s) => s.name), ...NPC_DEFS.map((n) => n.name)].flatMap((n) => n.toLowerCase().split(/[^a-z]+/)).filter((w) => w.length >= 4))];
const ambient = NPC_TUNING.ambient;

beforeAll(async () => {
  game = await startServer();
  NPC_TUNING.ambient = true; // the hunter farms the world's own creatures
  url = `http://127.0.0.1:${game.port}`;
});

afterAll(async () => {
  NPC_TUNING.ambient = ambient;
  resetAgentSlots();
  await game.close();
});

describe("residents", () => {
  it("the cast: original names the server accepts, every role, homes that fit", () => {
    expect(new Set(CAST.map((c) => c.name)).size).toBe(CAST.length);
    for (const c of CAST) {
      expect(c.name).toMatch(/^[A-Za-z0-9_]{3,16}$/);
      // Nobody is named after someone who already lives in the game.
      for (const taken of WORLD_NAMES) expect(c.name.toLowerCase().replace(/_/g, " ")).not.toContain(taken);
    }
    expect(residentId("Brindle_Oake")).toBe("res_brindle_oake");
    const eight = plan({ count: 8, bodies: ["portus", "arcadia"] });
    expect(eight.map((m) => m.role)).toEqual(["hunter", "wanderer", "trader", "chaser", "hunter", "wanderer", "trader", "chaser"]);
    expect(eight.filter((m) => m.role === "hunter").every((m) => m.home === "arcadia")).toBe(true); // nothing to hunt in the hub
    expect(eight.filter((m) => m.role === "trader" || m.role === "chaser").every((m) => m.home === "portus")).toBe(true);
    expect(eight.filter((m) => m.role === "wanderer").map((m) => m.home)).toEqual(["portus", "arcadia"]);
    // Past the cast's end names repeat with a number, still valid.
    const many = plan({ count: 14, bodies: ["arcadia"] });
    expect(many[12]!.name).toBe("Brindle_Oake_2");
    expect(new Set(many.map((m) => m.name)).size).toBe(14);
    expect(plan({ count: 3, bodies: ["hollowmere"], roles: ["wanderer"] }).map((m) => [m.role, m.home])).toEqual([["wanderer", "hollowmere"], ["wanderer", "hollowmere"], ["wanderer", "hollowmere"]]);
  });

  it("keeps away from the boss arenas: no stop is near one, and a walk across one goes round", () => {
    for (const body of ["arcadia", "hollowmere", "meridian"] as const) {
      const w = bodyWorld(body);
      const stops = stopsOn(w);
      expect(stops.length).toBeGreaterThan(8);
      for (const s of stops) expect(nearArena(w, s.pos, 60), `${body}: ${s.name}`).toBe(false);
      expect(stops.some((s) => /lair|Gull Point$|Hollow Nave|Foreclosure Yard$/.test(s.name))).toBe(false);
    }
    // Arcadia: from one side of Tidewrath's arena to the other, the first leg leads round its edge.
    const w = bodyWorld("arcadia");
    const stops = stopsOn(w);
    let rounded = 0;
    for (const a of stops) for (const b of stops) {
      const via = roundArena(w, a.pos, b.pos);
      if (!via) continue;
      rounded++;
      expect(nearArena(w, via, 20)).toBe(false);
    }
    expect(rounded).toBeGreaterThan(0);
    expect(stopsOn(bodyWorld("portus")).map((s) => s.name)).toEqual(expect.arrayContaining(["Portus Plaza", "Sela Marchbank", "the scoreboard", "the portal to arcadia"]));
  });

  it("two residents join as agents, walk in through the portal, one kills a creature, and the server corrects neither", async () => {
    AGENT_RULES.enabled = true;
    const lines: string[] = [];
    let violations = 0;
    const run = runResidents({
      url,
      count: 2,
      bodies: ["arcadia"],
      roles: ["hunter", "wanderer"],
      cpu: 4,
      dev: true,
      budgetMs: 240_000,
      log: (l) => lines.push(l),
      until: (rep) => {
        violations = Math.max(violations, ...[...liveRooms].flatMap((r) => [...r.actors.values()]).filter((a) => a.identity.agent).map((a) => a.violations), 0);
        return rep.residents[0]!.kills >= 1 && rep.residents[1]!.walked >= 60 && rep.residents.every((r) => r.body === "arcadia");
      },
    });
    await waitFor(() => run.report().joined === 2, 30_000);
    // Both are in the world as labelled agents, under the residents' names.
    await waitFor(() => agentsOnline() === 2, 10_000);
    const actors = [...liveRooms].flatMap((r) => [...r.actors.values()]).filter((a) => a.identity.agent);
    expect(actors.map((a) => a.identity.name).sort()).toEqual(["Brindle_Oake", "Tamsin_Hollis"]);
    expect(actors.every((a) => a.state.agent)).toBe(true);

    const rep = await run.done;
    const log = lines.join("\n");
    expect(rep.ended, log).toBe("stopped");
    expect(rep.joined).toBe(2);
    const [hunter, wanderer] = rep.residents as [(typeof rep.residents)[number], (typeof rep.residents)[number]];
    expect(hunter, log).toMatchObject({ name: "Brindle_Oake", role: "hunter", home: "arcadia", body: "arcadia", corrections: 0 });
    expect(wanderer, log).toMatchObject({ name: "Tamsin_Hollis", role: "wanderer", home: "arcadia", body: "arcadia", corrections: 0 });
    expect(hunter.kills, log).toBeGreaterThanOrEqual(1);
    expect(hunter.walked).toBeGreaterThan(30);
    expect(wanderer.walked).toBeGreaterThanOrEqual(60);
    expect(violations, log).toBe(0);
    expect(rep.cpu.seconds).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes("Brindle_Oake") && l.includes("through the portal to arcadia: ok"))).toBe(true);
    expect(lines.some((l) => l.includes("Tamsin_Hollis") && l.includes("walks to "))).toBe(true);
    // Stopped cleanly: nobody is left in the world.
    await waitFor(() => agentsOnline() === 0, 20_000);
  }, 300_000);

  it("stops at once and says why when the server has agents off", async () => {
    AGENT_RULES.enabled = false;
    try {
      const lines: string[] = [];
      const rep = await runResidents({ url, count: 2, bodies: ["portus"], cpu: 4, dev: true, budgetMs: 30_000, log: (l) => lines.push(l) }).done;
      expect(rep.ended).toBe("nobody");
      expect(rep.joined).toBe(0);
      expect(rep.residents[0]!.status).toBe("refused: agents off");
      expect(lines.some((l) => l.includes("AI agents are off on this server"))).toBe(true);
    } finally {
      AGENT_RULES.enabled = true;
    }
  }, 60_000);
});
