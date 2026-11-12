// The agent's tools, once: name, description, JSON schema and handler. The MCP server (mcp.ts) and
// the HTTP bridge (serve.ts) both serve this table, so a model sees the same tools either way.
//
// One process plays one character. Every action answers with its own result plus a one-line status
// and what happened meanwhile, so a model rarely needs a separate observe call.

import { homedir } from "node:os";
import { join } from "node:path";
import { AgentError, FirstlightAgent, type ActionResult, type MoveTarget } from "@firstlight/agent-kit";
import { BODY_IDS, type BodyId } from "@firstlight/shared";
import { MISSIONS, isTrialType } from "@firstlight/shared/content/missions";
import { SPELL_IDS, SPELLS } from "@firstlight/shared/content/spells";
import { STARTERS } from "@firstlight/shared/content/weapons";
import { PHRASES } from "@firstlight/shared/net/protocol";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface Schema {
  type: "object";
  properties: Record<string, { type: "string" | "number" | "integer" | "boolean" | "array"; description: string; enum?: readonly (string | number)[]; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; items?: { type: "string" | "number"; enum?: readonly string[] }; minItems?: number; maxItems?: number }>;
  required?: readonly string[];
  additionalProperties: false;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Schema;
  /** Needs a character in the world (everything but join). */
  needsAgent: boolean;
  run(s: Session, args: Record<string, any>): Promise<Record<string, unknown>>;
}

/** Why arguments don't fit a tool's schema, or null. */
export function checkArgs(schema: Schema, args: unknown): string | null {
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
  const a = args as Record<string, unknown>;
  for (const k of schema.required ?? []) if (a[k] === undefined) return `missing "${k}"`;
  for (const [k, v] of Object.entries(a)) {
    const p = schema.properties[k];
    if (!p) return `unknown argument "${k}" (allowed: ${Object.keys(schema.properties).join(", ") || "none"})`;
    if (v === undefined) continue;
    if (p.type === "array") {
      if (!Array.isArray(v)) return `"${k}" must be an array`;
      if (p.minItems !== undefined && v.length < p.minItems) return `"${k}" needs at least ${p.minItems} item(s)`;
      if (p.maxItems !== undefined && v.length > p.maxItems) return `"${k}" takes at most ${p.maxItems} item(s)`;
      for (const x of v) {
        if (typeof x !== p.items?.type || (typeof x === "number" && !Number.isFinite(x))) return `"${k}" items must be ${p.items?.type}s`;
        if (p.items?.enum && !p.items.enum.includes(x as string)) return `"${k}" items must be one of ${p.items.enum.join(", ")}`;
      }
      continue;
    }
    const t = p.type === "integer" ? "number" : p.type;
    if (typeof v !== t || (t === "number" && !Number.isFinite(v))) return `"${k}" must be a ${p.type}`;
    if (p.type === "integer" && !Number.isInteger(v)) return `"${k}" must be a whole number`;
    if (p.enum && !p.enum.includes(v as string | number)) return `"${k}" must be one of ${p.enum.join(", ")}`;
    if (typeof v === "number") {
      if (p.minimum !== undefined && v < p.minimum) return `"${k}" must be at least ${p.minimum}`;
      if (p.maximum !== undefined && v > p.maximum) return `"${k}" must be at most ${p.maximum}`;
    }
    if (typeof v === "string") {
      if (p.minLength !== undefined && v.length < p.minLength) return `"${k}" is too short`;
      if (p.maxLength !== undefined && v.length > p.maxLength) return `"${k}" is too long`;
    }
  }
  return null;
}

/** One character per process. */
export class Session {
  agent: FirstlightAgent | null = null;
  readonly log: (line: string) => void;

  constructor(log: (line: string) => void = () => {}) {
    this.log = log;
  }

  /** The status line and fresh events every action result carries. */
  status(): Record<string, unknown> {
    const a = this.agent;
    if (!a) return {};
    const o = a.observe();
    return { now: o.summary.split("\n")[0], ...(o.events.length ? { events: o.events.map((e) => e.text) } : {}) };
  }
}

const STARTER_IDS = STARTERS.map((s) => s.id);
/** One short line per spell for the tool description (the catalogue's blurbs are written for people at a keyboard). */
const SPELL_HELP: Record<string, string> = {
  skipstep: "blink up to 10 m along the ground, the way out of a bad fight.",
  frostbloom: "frost within 5 m of you, damage and a slow.",
  wishfall: "a star on a point up to 30 m away, landing after 1.2 s.",
  glasswing: "a shell that soaks up damage for 4 s.",
};
const TRIAL_IDS = MISSIONS.filter(isTrialType).map((m) => m.id as string);
const TARGET_HELP = "an id from firstlight_observe (creature, player or loot pile), or: guide, curator, vault, shop, portal:<body>, pad:<n>, pad (nearest), gate, safe (nearest safe zone), mission:<id> (where that mission leads now)";

function sessionFile(url: string, name: string): string | undefined {
  if (process.env.FL_AGENT_SESSION === "none") return undefined;
  if (process.env.FL_AGENT_SESSION) return process.env.FL_AGENT_SESSION;
  const host = url.replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9.-]+/g, "_");
  return join(process.env.FL_AGENT_HOME ?? join(homedir(), ".firstlight", "agents"), `${host}-${name.replace(/[^A-Za-z0-9_]+/g, "_") || "agent"}.json`);
}

const act = async (s: Session, r: Promise<ActionResult>): Promise<Record<string, unknown>> => ({ ...(await r), ...s.status() });

export const TOOLS: readonly ToolDef[] = [
  {
    name: "firstlight_join",
    description:
      "Enter FIRSTLIGHT, a multiplayer open-world game, as a guest character flagged as an AI agent (people see an AI chip on your name). Call this first, once. A new character starts in the town on Portus (a safe hub with a shop and portals to three planets). Returns your name and a first look around.",
    needsAgent: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string", description: "Game server origin. Default: $FL_URL, else http://localhost:2567.", maxLength: 200 },
        authUrl: { type: "string", description: "Sign-in origin, when it differs from url (the site origin on a hosted game). Default: $FL_AUTH_URL, else url.", maxLength: 200 },
        name: { type: "string", description: "Display name to ask for: 3-16 letters, digits or _. The server may refuse it (taken, not allowed); you then get a generated one.", minLength: 3, maxLength: 16 },
        starter: { type: "string", description: "A new character's class: hexwick (magic bolts), ash (sword), kappa (staff), unit7 (carbine, default), ninja (thrown kunai). Ignored when the character already exists.", enum: STARTER_IDS },
        body: { type: "string", description: "World to join. Leave out to arrive wherever the character is.", enum: BODY_IDS },
        dev: { type: "boolean", description: "Use a dev guest token instead of the sign-in flow (local servers started with ALLOW_DEV_GUESTS=1). Default: $FL_DEV=1." },
      },
    },
    async run(s, a) {
      if (s.agent && (s.agent.status === "playing" || s.agent.status === "reconnecting")) return { ok: false, reason: "already playing", hint: "firstlight_leave first to join again", ...s.status() };
      const url = (a.url ?? process.env.FL_URL ?? "http://localhost:2567") as string;
      const name = (a.name ?? process.env.FL_AGENT_NAME) as string | undefined;
      const dev = a.dev ?? process.env.FL_DEV === "1";
      const agent = new FirstlightAgent();
      try {
        const r = await agent.connect({
          url,
          authUrl: (a.authUrl ?? process.env.FL_AUTH_URL) as string | undefined,
          authOrigin: process.env.FL_AUTH_ORIGIN,
          name,
          starter: (a.starter ?? "unit7") as string,
          body: a.body as BodyId | undefined,
          // A dev identity is its id: the name's (so the same name is the same character), or a new one each run.
          ...(dev ? { token: `dev:${name ? name.toLowerCase() : `agent${Math.random().toString(36).slice(2, 8)}`}:${name ?? "Agent"}` } : { sessionFile: sessionFile(url, name ?? "agent") }),
          log: s.log,
        });
        s.agent = agent;
        // The first private state arrives a moment after the join.
        for (let i = 0; i < 40 && agent.observe({ peek: true }).self.maxHp === 0; i++) await new Promise((ok) => setTimeout(ok, 50));
        return { ...r, look: agent.observe().summary };
      } catch (e) {
        await agent.close().catch(() => {});
        return { ok: false, reason: e instanceof AgentError ? e.code : "join failed", hint: (e as Error).message };
      }
    },
  },
  {
    name: "firstlight_observe",
    description:
      "Look around: your character (HP, level, coins, zone, weapon), creatures and players near you with ids, distances in metres and compass bearings (0 = north, 90 = east), loot, places, missions, and what happened since your last look. detail=full adds the whole observation as JSON (inventory, cooldowns, exact position).",
    needsAgent: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { detail: { type: "string", description: "summary (default): a few lines of text. full: text plus the JSON observation.", enum: ["summary", "full"] } },
    },
    async run(s, a) {
      const o = s.agent!.observe();
      const { summary, ...rest } = o;
      return a.detail === "full" ? { ok: true, summary, observation: rest } : { ok: true, summary };
    },
  },
  {
    name: "firstlight_move",
    description: `Walk somewhere and wait until you arrive (or until seconds run out: then call it again). Give either target, or bearing with distance. target is ${TARGET_HELP}. You steer round walls, trees and rocks on your own and use the gate to leave or enter a walled safe zone.`,
    needsAgent: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        target: { type: "string", description: "Where to go (see above).", maxLength: 64 },
        bearing: { type: "number", description: "Compass bearing in degrees to walk along (0 north, 90 east, 180 south, 270 west). Needs distance.", minimum: 0, maximum: 360 },
        distance: { type: "number", description: "Metres to walk along bearing (1-400).", minimum: 1, maximum: 400 },
        sprint: { type: "boolean", description: "Sprint instead of running (9 against 6 m/s; each starter's own pace differs a little, see self.speed)." },
        within: { type: "number", description: "Stop this many metres from the target (default depends on the target).", minimum: 0.3, maximum: 60 },
        seconds: { type: "number", description: "Stop walking after this long (default: enough for the distance, at most 60).", minimum: 1, maximum: 120 },
        untilHit: { type: "boolean", description: "Stop as soon as something hurts you (default true)." },
      },
    },
    async run(s, a) {
      let target: MoveTarget;
      if (typeof a.target === "string") target = a.target;
      else if (a.bearing !== undefined && a.distance !== undefined) target = { bearing: a.bearing, distance: a.distance };
      else return { ok: false, reason: "bad target", hint: "give target, or bearing and distance" };
      return act(s, s.agent!.moveTo(target, { sprint: !!a.sprint, within: a.within, seconds: a.seconds, stopWhenHit: a.untilHit !== false }));
    },
  },
  {
    name: "firstlight_stop",
    description: "Stand still: ends the walk or fight in progress at once (that call then returns as cancelled). Use it to change your mind mid-action.",
    needsAgent: true,
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    run: (s) => act(s, s.agent!.stop()),
  },
  {
    name: "firstlight_attack",
    description:
      "Fight a creature with the weapon in hand until it dies, seconds run out, or your HP drops under retreatBelow. You close to weapon range, aim, reload and wait out cooldowns on your own. Refused in a safe zone (walk out first). Kills pay XP and coins; loot drops as a pile to pick up with firstlight_interact.",
    needsAgent: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["target"],
      properties: {
        target: { type: "string", description: "Creature id from firstlight_observe (like n12).", minLength: 1, maxLength: 64 },
        seconds: { type: "number", description: "Fight for at most this long (default 20).", minimum: 1, maximum: 120 },
        retreatBelow: { type: "number", description: "Stop when your HP falls under this fraction of max (0.05-0.95), so you can heal or run. Default 0.3.", minimum: 0.05, maximum: 0.95 },
        pvp: { type: "boolean", description: "Allow a player as the target. Only to defend yourself against a player who attacked you first." },
      },
    },
    run: (s, a) => act(s, s.agent!.attack(a.target, { seconds: a.seconds, retreatBelow: a.retreatBelow ?? 0.3, pvp: !!a.pvp })),
  },
  {
    name: "firstlight_dodge",
    description: "Roll 4.5 m in a blink (out of a telegraphed attack), along a compass bearing or the way you face. Ready every 1.0 to 1.35 s depending on the starter; not while swimming or slowed.",
    needsAgent: true,
    inputSchema: { type: "object", additionalProperties: false, properties: { bearing: { type: "number", description: "Compass bearing to roll along. Default: the way you face.", minimum: 0, maximum: 360 } } },
    run: (s, a) => act(s, s.agent!.dodge(a.bearing)),
  },
  {
    name: "firstlight_interact",
    description:
      "Use what is in reach, like a person's E key: pick up the loot pile you stand at, talk to the guide or to Sela Marchbank (lists missions), open the shop (lists goods), take a mission item, light a beacon, open the Gleam Vault (needs all three gleams). Walk up first with firstlight_move.",
    needsAgent: true,
    inputSchema: { type: "object", additionalProperties: false, properties: { target: { type: "string", description: "Which thing, when several are in reach: a pile id, guide, curator, vault, shop, or an object id. Default: the nearest.", maxLength: 64 } } },
    run: (s, a) => act(s, s.agent!.interact(a.target)),
  },
  {
    name: "firstlight_missions",
    description:
      "Missions: list yours and what the giver here offers, or take them (within 3 m of the giver). Guides stand at the main pad of each planet; in Portus, Sela Marchbank (target=curator) gives the trials of the Three Gleams, played on the planets. Hunt missions count kills, find missions need an item picked up with firstlight_interact, reach missions complete on arrival (firstlight_move target=mission:<id>); race, defend and collect missions: firstlight_trial.",
    needsAgent: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", description: "list: your missions and the offers here. take: accept the offers of the giver you stand at.", enum: ["list", "take"] },
        ids: { type: "array", description: "With take: only these mission ids (default: all on offer).", items: { type: "string", enum: MISSIONS.map((m) => m.id as string) }, maxItems: MISSIONS.length },
      },
    },
    async run(s, a) {
      if (a.action === "take") return act(s, s.agent!.takeMissions(a.ids));
      const o = s.agent!.observe({ peek: true });
      return { ok: true, missions: o.missions, offers: o.offers, guide: o.guide, hunt: o.hunt };
    },
  },
  {
    name: "firstlight_shop",
    description:
      "Trade at the shop you stand at (every safe zone has one; firstlight_move target=shop). list: goods you could use and your coins. buy: an item by id. sell: what is in an inventory slot. Tonics (tonic_small 10 coins, heals 40 HP) are the usual first buy.",
    needsAgent: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", description: "list, buy or sell.", enum: ["list", "buy", "sell"] },
        item: { type: "string", description: "buy: the item id (tonic_small, carbine, sunbrand…). sell: an item id from your bags, instead of slot.", maxLength: 40 },
        tier: { type: "integer", description: "buy: weapon tier 1-3 (default 1). Higher tiers need levels 6 and 12.", minimum: 1, maximum: 3 },
        qty: { type: "integer", description: "How many (stackable items only, default 1 to buy, the whole stack to sell).", minimum: 1, maximum: 20 },
        slot: { type: "integer", description: "sell: inventory slot (0-3 hotbar, 4-19 backpack).", minimum: 0, maximum: 19 },
      },
    },
    async run(s, a) {
      const agent = s.agent!;
      if (a.action === "list") return act(s, agent.shop());
      if (a.action === "buy") return a.item ? act(s, agent.buy(a.item, { tier: a.tier, qty: a.qty })) : { ok: false, reason: "missing item" };
      const what = a.slot ?? a.item;
      return what === undefined ? { ok: false, reason: "missing slot or item" } : act(s, agent.sell(what, a.qty));
    },
  },
  {
    name: "firstlight_item",
    description:
      "Your inventory: select a hotbar slot as the weapon in hand, equip an item from the backpack, use a consumable (a tonic heals over 3 s, one every 8 s), or reload. See slots with firstlight_observe detail=full.",
    needsAgent: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", description: "select: hold hotbar slot. equip: move an item to the hotbar and hold it. use: consume an item. reload: reload the weapon in hand.", enum: ["select", "equip", "use", "reload"] },
        slot: { type: "integer", description: "Inventory slot: 0-3 hotbar (select needs one of these), 4-19 backpack.", minimum: 0, maximum: 19 },
        item: { type: "string", description: "Item id instead of slot (equip, use): tonic_small, carbine…", maxLength: 40 },
      },
    },
    async run(s, a) {
      const agent = s.agent!;
      if (a.action === "reload") return act(s, agent.reload());
      const what = a.slot ?? a.item;
      if (what === undefined) return { ok: false, reason: "missing slot or item" };
      if (a.action === "select") return typeof what === "number" ? act(s, agent.selectSlot(what)) : act(s, agent.equip(what));
      return act(s, a.action === "equip" ? agent.equip(what) : agent.useItem(what));
    },
  },
  {
    name: "firstlight_travel",
    description:
      "Travel far. portal: step through the portal to another world; stand at it first (firstlight_move target=portal:<body>). Portus has portals to arcadia (enemy levels 1-7), hollowmere (6-13) and meridian (12-20); each planet has one back to portus. pad: fast travel to a pad you have discovered on this planet; stand on any pad first. Not while in combat.",
    needsAgent: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        portal: { type: "string", description: "World to travel to through the portal you stand at.", enum: BODY_IDS },
        pad: { type: "integer", description: "Pad number to fast travel to (discovered pads only).", minimum: 0, maximum: 63 },
      },
    },
    async run(s, a) {
      if (a.portal !== undefined) return act(s, s.agent!.enterPortal(a.portal));
      if (a.pad !== undefined) return act(s, s.agent!.travel(a.pad));
      return { ok: false, reason: "bad target", hint: "give portal or pad" };
    },
  },
  {
    name: "firstlight_say",
    description: `Say one of the game's fixed phrases to players near you (there is no free chat): ${PHRASES.join(", ")}.`,
    needsAgent: true,
    inputSchema: { type: "object", additionalProperties: false, required: ["phrase"], properties: { phrase: { type: "string", description: "The phrase.", enum: PHRASES } } },
    run: (s, a) => act(s, s.agent!.phrase(a.phrase)),
  },
  {
    name: "firstlight_respawn",
    description: "After you die: start a new life in Portus at level 1 (your loot stays in a pile where you fell; medals stay). Only works while dead.",
    needsAgent: true,
    inputSchema: { type: "object", additionalProperties: false, properties: { starter: { type: "string", description: "Class for the new life (default: the same as before).", enum: STARTER_IDS } } },
    run: (s, a) => act(s, s.agent!.respawn({ starter: a.starter })),
  },
  {
    name: "firstlight_cast",
    description: `Cast a spell. Spells cost aether (100 at most, refills 6 a second) and have cooldowns; firstlight_observe shows what is ready. ${SPELLS.map((x) => `${x.id} (level ${x.level}, ${x.cost} aether, ${x.cooldownS} s): ${SPELL_HELP[x.id]}`).join(" ")} Not in a safe zone, while protected, or swimming. Aim with one of target, bearing or pos (default: the way you face).`,
    needsAgent: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["spell"],
      properties: {
        spell: { type: "string", description: "The spell.", enum: SPELL_IDS },
        target: { type: "string", description: "Creature or player id: skipstep blinks toward it, wishfall lands on it.", minLength: 1, maxLength: 64 },
        bearing: { type: "number", description: "Compass bearing: the way skipstep blinks; with distance, where wishfall lands.", minimum: 0, maximum: 360 },
        distance: { type: "number", description: "wishfall with bearing: metres away (default 12).", minimum: 1, maximum: 30 },
        pos: { type: "array", description: "wishfall: a ground point [x, y, z] (as self.pos).", items: { type: "number" }, minItems: 3, maxItems: 3 },
        pvp: { type: "boolean", description: "Cast frostbloom or wishfall although a player stands in the blast. Only to defend yourself." },
      },
    },
    async run(s, a) {
      const aims = [a.target, a.bearing, a.pos].filter((v) => v !== undefined).length;
      if (aims > 1) return { ok: false, reason: "bad arguments", hint: "aim with one of target, bearing or pos" };
      if (a.distance !== undefined && (a.bearing === undefined || a.spell !== "wishfall")) return { ok: false, reason: "bad arguments", hint: "distance goes with bearing, for wishfall" };
      if (a.pos !== undefined && a.spell !== "wishfall") return { ok: false, reason: "bad arguments", hint: "pos is for wishfall; aim the others with target or bearing" };
      return act(s, s.agent!.cast(a.spell, { targetId: a.target, bearing: a.bearing, distance: a.distance, pos: a.pos, pvp: !!a.pvp }));
    },
  },
  {
    name: "firstlight_trial",
    description:
      "Play a race, defend or collect mission you hold, start to finish, on the body you stand on. race: sprints through the rings in order (ring 1 starts the clock). collect: walks over every piece. defend: lights the beacon, stays in its ring and fights what comes. Returns when done, failed (\"failed: time\", \"failed: left\", \"dead\"), blocked, or out of seconds; call again to retry.",
    needsAgent: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["mission"],
      properties: {
        mission: { type: "string", description: "A4 (collect, Arcadia), H4 (defend, Hollowmere), T1 (race, Arcadia), T2 (defend, Hollowmere), T3 (timed collect, Meridian).", enum: TRIAL_IDS },
        seconds: { type: "number", description: "Give up after this long (default: the objective's time plus the walk there).", minimum: 5, maximum: 600 },
        retreatBelow: { type: "number", description: "defend: stop fighting under this fraction of max HP (default 0.25).", minimum: 0.05, maximum: 0.95 },
      },
    },
    run: (s, a) => act(s, s.agent!.playTrial(a.mission, { seconds: a.seconds, retreatBelow: a.retreatBelow })),
  },
  {
    name: "firstlight_leave",
    description: "Leave the game. In a safe zone your character goes at once. Elsewhere pass logout=true (stand still about 10 s) or the body stays in the world for 30 s and can be killed.",
    needsAgent: true,
    inputSchema: { type: "object", additionalProperties: false, properties: { logout: { type: "boolean", description: "Run the logout countdown first (about 10 s standing still)." } } },
    async run(s, a) {
      const agent = s.agent!;
      s.agent = null;
      await agent.close({ logout: !!a.logout });
      return { ok: true, left: true };
    },
  },
];

export const TOOL_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(TOOLS.map((t) => [t.name, t]));

/** Run a tool by name with unchecked arguments: validates, guards, never throws. */
export async function callTool(s: Session, name: string, args: unknown): Promise<Record<string, unknown>> {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return { ok: false, reason: "unknown tool", hint: `tools: ${TOOLS.map((t) => t.name).join(", ")}` };
  const bad = checkArgs(tool.inputSchema, args);
  if (bad) return { ok: false, reason: "bad arguments", hint: bad };
  if (tool.needsAgent && !s.agent) return { ok: false, reason: "not in the game", hint: "call firstlight_join first" };
  try {
    return await tool.run(s, (args ?? {}) as Record<string, any>);
  } catch (e) {
    return { ok: false, reason: e instanceof AgentError ? e.code : "error", hint: (e as Error).message };
  }
}

/** How the game works, for a model that has never seen it (the MCP server's `instructions`). */
export const PLAYBOOK = [
  "FIRSTLIGHT is a multiplayer open-world game. You play one character next to people; your name carries an AI chip.",
  "Loop: firstlight_join once, then firstlight_observe, act, repeat. Every action returns a status line and recent events.",
  "Positions are distances in metres and compass bearings (0 north, 90 east). Ids come from firstlight_observe.",
  "Safe zones (the Portus town, the outpost round each planet's main pad, 12 m round every pad): nobody can fight there; shops and guides are inside.",
  "To level up: on Portus walk to a portal (firstlight_move target=portal:arcadia) and firstlight_travel portal=arcadia. On the planet: firstlight_move target=guide, firstlight_missions action=take, leave the outpost, fight creatures of about your level, pick up loot piles, heal with tonics, return to safety (firstlight_move target=safe) when hurt.",
  "Spells (firstlight_cast) cost aether and unlock by level: skipstep 1 (a blink out of a bad fight), frostbloom 3 (when surrounded), wishfall 6, glasswing 9 (a shell when hurt).",
  "Race, defend and collect missions are played with firstlight_trial. The public hunt: Sela Marchbank in Portus (target=curator) gives trials T1 (Arcadia, levels 4-7), T2 (Hollowmere, 9-12), T3 (Meridian, 14-17); all three open the Gleam Vault beside her.",
  "Dying costs the character: a new life starts at level 1 (firstlight_respawn). Retreat early.",
  "Be a good neighbour: don't attack players unless one attacked you first, don't take loot piles that aren't yours while their owner is near, don't crowd people at the guide or the shop.",
].join("\n");
