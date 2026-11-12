// FirstlightAgent: a headless player. It joins the same rooms as the browser client through the
// same /api/play flow, flagged as an AI agent (shared net/agents.ts), keeps a model of the world
// from the room state and messages, and plays through high-level awaitable actions. The server's
// rules are the only rules: movement is validated, damage and loot are the server's.
//
//   const agent = new FirstlightAgent();
//   await agent.connect({ url: "http://localhost:2567", name: "Scout_7", starter: "unit7" });
//   console.log(agent.observe().summary);
//   await agent.moveTo("guide");
//   await agent.takeMissions();
//   await agent.close();
//
// No model calls happen in here: a model (or a script) sits on the other side of these methods.

import { Client, type Room } from "@colyseus/sdk";
import { BODY_IDS, type BodyId } from "@firstlight/shared";
import { SHOP, itemName } from "@firstlight/shared/content/items";
import { GLEAMS, gleamsWon } from "@firstlight/shared/content/gleams";
import { isTrialType as isTrial, MISSION_BY_ID, missionGoal, missionsFrom, type MissionDef } from "@firstlight/shared/content/missions";
import { AETHER, aetherAt, castBlock, FROSTBLOOM, SPELL_BY_ID, SPELL_INDEX, SPELLS, WISHFALL } from "@firstlight/shared/content/spells";
import { STARTER_STATS, starterMove } from "@firstlight/shared/content/starters";
import { NF, NPC_DEFS } from "@firstlight/shared/content/npcs";
import { towardDir } from "@firstlight/shared/content/places";
import { STARTERS, WEAPON_BY_ID, WEAPONS, type TierStats, type WeaponDef } from "@firstlight/shared/content/weapons";
import { AGENT_HEADER } from "@firstlight/shared/net/agents";
import { NET, PHRASES, PROTOCOL_VERSION, type CastMsg, type InvItem, type PlayResponse, type SpellEvent, type TrialMsg, type YouState } from "@firstlight/shared/net/protocol";
import { PF } from "@firstlight/shared/net/schema";
import { CLOSE } from "@firstlight/shared/net/social";
import { PORTAL_REACH } from "@firstlight/shared/planet/portals";
import { inReach } from "@firstlight/shared/content/world";
import { shopSpotAt } from "@firstlight/shared/content/shops";
import { AgentError, claimName, fixedToken, guestSession, type TokenSource } from "./auth.ts";
import { summarize, type Observation, type ObservedCreature, type ObservedItem, type ObservedMission, type ObservedPlace, type ObservedSpells, type ObservedTrial } from "./observe.ts";
import { addScaled, bearingOfDir, bearingTo, dirOfBearing, dist, groundDistance, len, norm, scale, sub, tangent, turn, type V3 } from "./vec.ts";
import { createNavigator, type Navigator } from "./nav.ts";
import { WALK, Walker } from "./walker.ts";
import { bodyWorld, giverOf, type BodyWorld, type WorldObject } from "./world.ts";

export interface ConnectOptions {
  /** The game server (API) origin, e.g. `http://localhost:2567`. */
  url: string;
  /** Where Better Auth answers (`/api/auth/*`): the site origin in production. Default: `url`. */
  authUrl?: string;
  /** The Origin header for sign-in requests, when the server trusts another origin than `authUrl` (a dev server reached directly trusts the Vite origin). */
  authOrigin?: string;
  /** Display name to ask for (3-16 letters, digits or _). The server may refuse it; you keep a generated one. */
  name?: string;
  /** A new character's starter: index or id (hexwick, ash, kappa, unit7, ninja). */
  starter?: number | string;
  look?: number;
  palette?: number;
  /** The body to join. Default: wherever the character is (a new one starts on Portus). */
  body?: BodyId;
  /** A ready play token instead of the guest flow (a dev token `dev:<id>:<name>` on a dev server). */
  token?: string;
  /** Use a dev guest token (servers started with ALLOW_DEV_GUESTS=1, and the test server). */
  dev?: boolean;
  /** Keep the guest session here, so the same character comes back next run. */
  sessionFile?: string;
  /** One line per notable thing (joins, reconnects), for the caller's log. */
  log?: (line: string) => void;
}

export interface ActionResult {
  ok: boolean;
  /** Why not (when `ok` is false), short and stable: "too far", "safe zone", "dead", "timeout"… */
  reason?: string;
  /** What to do about it. */
  hint?: string;
  [k: string]: unknown;
}

export interface AgentEvent {
  at: number;
  type: "hit" | "hurt" | "kill" | "death" | "toast" | "denied" | "mission" | "shop" | "info" | "phrase" | "level" | "spell" | "trial";
  text: string;
  /** Merged repeats (hits on one target). */
  n?: number;
  key?: string;
  amount?: number;
}

/** A move target: an id from the observation, a named place, a compass step, or a raw position. */
export type MoveTarget = string | { id: string } | { bearing: number; distance: number } | { pos: readonly number[] };

export interface MoveOptions {
  /** Run at sprint speed (9 m/s instead of 6). */
  sprint?: boolean;
  /** Stop this close to the target (metres). */
  within?: number;
  /** Give up after this long (default: what the distance needs, at most 60 s). */
  seconds?: number;
  /** Stop as soon as something hurts you. */
  stopWhenHit?: boolean;
}

export interface CastAim {
  /** Aim at a creature or player from the observation (Skipstep blinks toward it, Wishfall lands on it). */
  targetId?: string;
  /** Aim along a compass bearing (Skipstep: the way to blink; Wishfall: `distance` metres that way). */
  bearing?: number;
  /** Wishfall with `bearing`: how far away the star lands (default 12 m, at most 30). */
  distance?: number;
  /** Wishfall: a ground point `[x, y, z]` in the body's frame. */
  pos?: readonly number[];
  /**
   * Frostbloom and Wishfall hurt everyone in their blast, players too. Off by default: the cast is
   * refused ("players in range") while a player stands in it. Pass true only to defend yourself.
   */
  pvp?: boolean;
}

export interface TrialOptions {
  /** Give up after this long (default: what the objective needs, at most 600 s). */
  seconds?: number;
  /** defend: leave the fight when HP falls under this fraction (default 0.25); the hold goes on while you stay in the ring. */
  retreatBelow?: number;
  /** race, collect: stop as soon as something hurts you (the attempt itself goes on: its clock too). */
  stopWhenHit?: boolean;
}

export interface AttackOptions {
  /** Fight for at most this long (default 20 s, at most 120). */
  seconds?: number;
  /** Keep going until the target is dead (default true); false = one burst of `seconds`. */
  untilDead?: boolean;
  /** Stop when your HP falls under this fraction (0-1), so you can retreat. */
  retreatBelow?: number;
  /** Allow attacking another player. Off by default: agents don't start fights with people. */
  pvp?: boolean;
  /** Don't follow the target further than `radius` metres from `pos` (holding a beacon's ring). */
  leash?: { pos: readonly number[]; radius: number };
  /**
   * Break off (reason "yielded") as soon as another player hits the same creature: "people" for a
   * person only, "anyone" for other agents too. No kill stealing: the fight is theirs.
   */
  yieldTo?: "people" | "anyone";
}

type You = YouState & { selected?: number; level?: number; dead?: boolean };

interface Control {
  wish: V3 | null;
  speed: number;
  face?: V3 | null;
  /** Runs after this tick's input went out (attacks use the facing just sent). */
  after?: () => void;
}
type Tick = (now: number, dt: number) => Control | { done: ActionResult };

const IDLE: Control = { wish: null, speed: 0 };
const TICK_MS = 1000 / NET.INPUT_HZ;
/** No state patch for this long (the server sends one every 50 ms): the server or the line has stalled. */
const STALL_MS = 170;
const NO_REJOIN: ReadonlySet<number> = new Set([CLOSE.ELSEWHERE, CLOSE.MERGED, CLOSE.BANNED, CLOSE.LOGGED_OUT, CLOSE.KICKED]);
const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));
const round1 = (n: number) => Math.round(n * 10) / 10;

export class FirstlightAgent {
  /** "offline" → "joining" → "playing" (⇄ "reconnecting") → "closed". */
  status: "offline" | "joining" | "playing" | "reconnecting" | "closed" = "offline";
  room: Room | null = null;
  bodyId: BodyId = "portus";
  /** Everything notable that happened, oldest first (the last 60). */
  readonly events: AgentEvent[] = [];
  /** Movement the server refused and snapped back (should stay 0 in normal play). */
  corrections = 0;
  /** Inputs sent since joining. */
  inputs = 0;
  private opts: ConnectOptions | null = null;
  private url = "";
  private tokens: TokenSource | null = null;
  private starter = 0;
  private world: BodyWorld = bodyWorld("portus");
  private readonly walker = new Walker(this.world);
  private you: You | null = null;
  private displayName = "";
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private driver: { tick: Tick; resolve: (r: ActionResult) => void } | null = null;
  private seenEventAt = 0;
  private readonly kills = new Map<string, { xp: number; coins: number; at: number; name: string }>();
  private huntIds = new Set<string>();
  private lastDenial: { action: string; reason: string; at: number } | null = null;
  private lastHurtAt = 0;
  private expectTeleport = 0;
  /** Local mirrors of the server's weapon timers (it tells us only by refusing). */
  private nextAttackAt = 0;
  private reloadUntil = 0;
  private overheatUntil = 0;
  private heat = 0;
  private lastShotAt = 0;
  private tonicUntil = 0;
  private waiters: { type: string; test: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  private joinGen = 0;
  private lastPatchAt = 0;
  /** Ticks spent standing because the server had gone quiet (see onTick). */
  stalls = 0;
  /** The last `trial` message per mission (race, defend, collect attempts), with when it came. */
  private readonly trials = new Map<string, TrialMsg & { at: number }>();
  /** Creatures another player hit lately: who, and when (the `claimedBy` of an observed creature). */
  private readonly claims = new Map<string, { by: string; at: number }>();
  /** stop() and close() end a multi-step action (playTrial) by moving this on. */
  private planGen = 0;
  /** The guest session this character belongs to ended and a new guest was made (see connect's result). */
  private newGuest = false;

  // ------------------------------------------------------------------------------------ joining

  /** Join the world as a guest flagged as an AI agent. Resolves once the character is in a room. */
  async connect(opts: ConnectOptions): Promise<ActionResult> {
    if (this.status === "playing" || this.status === "joining") return { ok: false, reason: "already connected" };
    this.opts = opts;
    this.url = opts.url.replace(/\/+$/, "");
    const s = opts.starter;
    this.starter = typeof s === "string" ? Math.max(0, STARTERS.findIndex((x) => x.id === s || x.name.toLowerCase() === s.toLowerCase())) : Math.max(0, Math.min(STARTERS.length - 1, s ?? 0));
    let nameNote: string | undefined;
    if (opts.token) this.tokens = fixedToken(opts.token);
    else if (opts.dev) this.tokens = fixedToken(`dev:agent${Math.random().toString(36).slice(2, 10)}:${opts.name ?? "Agent"}`);
    else {
      this.tokens = guestSession(opts.authUrl ?? this.url, opts.sessionFile, opts.authOrigin, (why) => {
        this.newGuest = true;
        this.log(why);
      });
      if (opts.name) {
        const r = await claimName(this.url, await this.tokens.get(), opts.name);
        if (!r.ok) nameNote = `name not set: ${r.message}`;
      }
    }
    try {
      await this.join(opts.body ?? "portus");
    } catch (e) {
      this.status = "offline";
      throw e;
    }
    const starter = STARTERS[this.me()?.starter ?? this.starter]?.id ?? STARTERS[this.starter]!.id;
    return { ok: true, name: this.displayName, body: this.bodyId, starter, ...(nameNote ? { note: nameNote } : {}), ...(this.newGuest ? { newGuest: true, hint: "the saved guest session had ended (signed out or expired): this is a new guest character" } : {}) };
  }

  private log(line: string) {
    this.opts?.log?.(line);
  }

  /** /api/play → seat → room, following travel redirects and queues. Throws AgentError on refusal. */
  private async join(body: BodyId, sameSession = false): Promise<void> {
    const gen = ++this.joinGen;
    this.status = this.status === "reconnecting" ? "reconnecting" : "joining";
    const tokens = this.tokens!;
    let fresh = false;
    let waited = 0;
    for (;;) {
      // A play token is bound to its session (D-security-5). Coming back for a character already in
      // play (`sameSession`: a reconnect, a portal, a rebirth) never swaps in a new guest.
      const token = await tokens.get(fresh, sameSession);
      const res = await fetch(`${this.url}/api/play`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", [AGENT_HEADER]: "1" },
        body: JSON.stringify({ body, v: PROTOCOL_VERSION, starter: this.starter, palette: this.opts?.palette ?? 0, look: this.opts?.look ?? 0, agent: true }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 401 && !fresh) {
        fresh = true;
        continue;
      }
      if (res.status === 429) {
        if ((waited += 2500) > 60_000) throw new AgentError("slow down", "the server keeps answering 429 (too many joins): wait a minute");
        await sleep(2500);
        continue;
      }
      const r = (await res.json().catch(() => ({ ok: false, error: `http ${res.status}` }))) as PlayResponse & { message?: string };
      if (gen !== this.joinGen) throw new AgentError("superseded");
      if (r.ok) {
        const client = new Client(this.url);
        const room = await client.consumeSeatReservation(r.reservation as never);
        if (gen !== this.joinGen) {
          void room.leave().catch(() => {});
          throw new AgentError("superseded");
        }
        await this.attach(room, body);
        return;
      }
      if ("queue" in r) {
        if ((waited += 5000) > 180_000) throw new AgentError("queue", `the world is full (queue position ${r.queue.position})`);
        this.note("info", `world full: queue position ${r.queue.position}`);
        await sleep(5000);
        continue;
      }
      if (r.error === "travel" && r.body && r.body !== body) {
        body = r.body; // the character is on another body: join it there
        continue;
      }
      if (r.error === "version") throw new AgentError("version", `the server speaks protocol ${r.version}, this kit ${PROTOCOL_VERSION}: update the kit`);
      if (r.error === "unauthorized") throw new AgentError("unauthorized", "the server refused the play token (its session ended or was signed out; a dev token needs a server started with ALLOW_DEV_GUESTS=1)");
      throw new AgentError(r.error, r.message ?? r.error);
    }
  }

  private async attach(room: Room, body: BodyId): Promise<void> {
    this.room = room;
    this.bodyId = body;
    this.world = bodyWorld(body);
    this.walker.setWorld(this.world, (id) => !!(room.state as any)?.broken?.has?.(id));
    this.seq = 0;
    this.you = null;
    this.huntIds = new Set();
    this.trials.clear(); // an attempt doesn't outlive its room session (quests/trials.ts)
    this.claims.clear();
    room.onMessage("*", (type: string | number, m: any) => this.onMessage(String(type), m));
    this.lastPatchAt = Date.now();
    room.onStateChange(() => (this.lastPatchAt = Date.now())); // the server's clock is in the state: a patch every tick
    room.onLeave((code: number) => this.onRoomClosed(room, code));
    // The character appears in the synced state a patch after the join.
    const t0 = Date.now();
    while (!this.me() && Date.now() - t0 < 10_000 && this.room === room) await sleep(25);
    const me = this.me();
    if (!me) throw new AgentError("join", "joined, but the character never appeared in the room state");
    // The private half (XP, coins, inventory) comes as a `you` message right after the join: the
    // first look should have it. If it was sent before this handler existed, ask again: cancelling a
    // logout that isn't running changes nothing and makes the server send `you`.
    const t1 = Date.now();
    let asked = false;
    while (!this.you && Date.now() - t1 < 6000 && this.room === room) {
      if (!asked && Date.now() - t1 > 500) {
        asked = true;
        room.send("logout", { start: false });
      }
      await sleep(25);
    }
    this.walker.setStarter(me.starter); // the character's own pace and roll (content/starters.ts)
    this.walker.place(me.x, me.y, me.z);
    this.displayName = me.name;
    this.status = "playing";
    this.lastTick = Date.now();
    this.stopTimers();
    this.timer = setInterval(() => this.onTick(), TICK_MS);
    this.pingTimer = setInterval(() => room.send("ping", { t: Date.now() }), 5000);
    room.send("questSync", {});
    this.log(`joined ${body} as ${me.name}${me.agent ? " [AI]" : ""}`);
  }

  private stopTimers() {
    if (this.timer) clearInterval(this.timer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.timer = this.pingTimer = null;
  }

  private onRoomClosed(room: Room, code: number) {
    if (this.room !== room) return; // we left it ourselves (travel, respawn, close)
    this.room = null;
    this.stopTimers();
    this.finish({ ok: false, reason: "disconnected" });
    if (this.status === "closed") return;
    if (NO_REJOIN.has(code)) {
      this.status = "offline";
      const why = code === CLOSE.ELSEWHERE ? "the character joined from somewhere else" : code === CLOSE.BANNED ? "banned" : code === CLOSE.KICKED ? "kicked" : code === CLOSE.LOGGED_OUT ? "logged out" : "account changed";
      this.note("info", `connection closed: ${why}`);
      return;
    }
    void this.reconnect();
  }

  /** The connection dropped: come back for the same body (the server keeps it for 30 s) with backoff. */
  private async reconnect() {
    this.status = "reconnecting";
    this.note("info", "connection lost: reconnecting");
    for (let attempt = 0; attempt < 6 && this.status === "reconnecting"; attempt++) {
      await sleep(Math.min(15_000, 1000 * 2 ** attempt));
      if (this.status !== "reconnecting") return;
      try {
        await this.join(this.bodyId, true);
        this.note("info", "reconnected");
        return;
      } catch (e) {
        const code = e instanceof AgentError ? e.code : "";
        this.log(`reconnect failed: ${(e as Error).message}`);
        if (code === "superseded") return;
        if (code === "session ended") this.note("info", "the guest session ended (signed out or expired): this character can't be reached any more; connect again for a new guest");
        if (code === "banned" || code === "kicked" || code === "agents off" || code === "version" || code === "session ended") break;
      }
    }
    if (this.status === "reconnecting") {
      this.status = "offline";
      this.note("info", "gave up reconnecting");
    }
  }

  /** Leave the room and join another body (after a travel ticket or a rebirth). */
  private async hop(body: BodyId): Promise<void> {
    const room = this.room;
    this.room = null;
    this.stopTimers();
    this.finish({ ok: false, reason: "left the body" });
    await Promise.race([room?.leave().catch(() => {}), sleep(1500)]);
    // The old room is gone: a slow server (a timeout, a dropped socket) gets a few more tries before
    // this gives up; a refusal (a cap, a ban) is final at once.
    for (let attempt = 0; ; attempt++) {
      try {
        await this.join(body, true);
        return;
      } catch (e) {
        if (e instanceof AgentError || attempt >= 3 || this.status === "closed") {
          if (this.status !== "closed") this.status = "offline";
          throw e;
        }
        this.log(`joining ${body} failed (${(e as Error).message}): trying again`);
        await sleep(2000 * (attempt + 1));
      }
    }
  }

  /**
   * Leave the world. In a safe zone the character goes at once; elsewhere the body stays for 30 s
   * and can be hurt, like a person who closes the tab. `logout: true` runs the game's logout
   * countdown first (stand still about 10 s), which removes the body cleanly anywhere.
   */
  async close(o: { logout?: boolean } = {}): Promise<void> {
    const room = this.room;
    if (room && o.logout && this.status === "playing" && !this.dead) {
      this.cancel("closing");
      room.send("logout", { start: true });
      await this.waitFor("loggedOut", () => true, 15_000);
    }
    this.status = "closed";
    this.planGen++;
    this.joinGen++;
    this.room = null;
    this.stopTimers();
    this.finish({ ok: false, reason: "closed" });
    await Promise.race([room?.leave().catch(() => {}), sleep(1000)]);
  }

  // ------------------------------------------------------------------------------------ state

  private me(): any {
    const room = this.room;
    return room ? ((room.state as any)?.players?.get(room.sessionId) ?? null) : null;
  }

  get sessionId(): string {
    return this.room?.sessionId ?? "";
  }

  get name(): string {
    return this.displayName;
  }

  get dead(): boolean {
    const me = this.me();
    return !!this.you?.dead || (!!me && (me.flags & PF.DEAD) !== 0);
  }

  /** Feet position (metres, the body's frame). */
  get position(): V3 {
    return this.walker.p;
  }

  private selectedSlot(): number {
    return this.you?.selected ?? 0;
  }

  private weapon(): { def: WeaponDef; tier: TierStats; item: InvItem | null; slot: number } {
    const slot = this.selectedSlot();
    const item = this.you?.hotbar?.[slot] ?? null;
    const def = (item && WEAPON_BY_ID.get(item.id)) || WEAPONS[0]!;
    const tier = def.tiers[Math.max(0, Math.min(2, (item?.tier ?? 1) - 1))]!;
    return { def, tier, item, slot };
  }

  private note(type: AgentEvent["type"], text: string, merge?: { key: string; amount: number }) {
    const now = Date.now();
    const last = this.events[this.events.length - 1];
    if (merge && last && last.key === merge.key && last.type === type && now - last.at < 4000) {
      last.amount = (last.amount ?? 0) + merge.amount;
      last.n = (last.n ?? 1) + 1;
      last.at = now;
      last.text = text.replace("{n}", String(Math.round(last.amount))).replace("{hits}", ` (${last.n} hits)`);
      return;
    }
    this.events.push({ at: now, type, text: merge ? text.replace("{n}", String(Math.round(merge.amount))).replace("{hits}", "") : text, ...(merge ? { key: merge.key, amount: merge.amount, n: 1 } : {}) });
    if (this.events.length > 60) this.events.shift();
  }

  private nameOf(id: string): string {
    const st = this.room?.state as any;
    const p = st?.players?.get(id);
    if (p) return p.name;
    const n = st?.npcs?.get(id);
    if (n) return NPC_DEFS[n.kind]?.name ?? "a creature";
    return this.kills.get(id)?.name ?? "something";
  }

  private onMessage(type: string, m: any) {
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i]!;
      if (w.type === type && w.test(m)) {
        this.waiters.splice(i, 1);
        w.resolve(m);
      }
    }
    const id = this.sessionId;
    switch (type) {
      case "you": {
        const before = this.you;
        this.you = m as You;
        if (before && (m.level ?? 0) > (before.level ?? 0)) this.note("level", `level up: now level ${m.level}`);
        break;
      }
      case "correct":
        // The server put the body somewhere: adopt it. A move we asked for (fast travel, Skipstep)
        // isn't a refusal; anything else is movement the server didn't accept.
        this.walker.place(m.x, m.y, m.z);
        if (Date.now() < this.expectTeleport) this.expectTeleport = 0;
        else this.corrections++;
        break;
      case "npcFx":
        // A slow, chill or no-sprint the server now enforces on the movement budget: walk by it.
        this.walker.addEffect(String(m.kind), Number(m.amount) || 0, Number(m.ms) || 0);
        break;
      case "trial":
        this.onTrial(m as TrialMsg);
        break;
      case "spell":
        this.onSpell(m as SpellEvent);
        break;
      case "hit":
        if (m.target === id && m.attacker !== id) {
          this.lastHurtAt = Date.now();
          this.note("hurt", `took {n} damage from ${this.nameOf(m.attacker)}{hits}`, { key: `in:${m.attacker}`, amount: m.amount });
        } else if (m.attacker === id) this.note("hit", `dealt {n} damage to ${this.nameOf(m.target)}{hits}`, { key: `out:${m.target}`, amount: m.amount });
        else if ((this.room?.state as any)?.npcs?.has(m.target) && (this.room?.state as any)?.players?.has(m.attacker)) {
          // Someone else is fighting that creature (etiquette: it is theirs).
          this.claims.set(m.target, { by: m.attacker, at: Date.now() });
          if (this.claims.size > 60) this.claims.delete(this.claims.keys().next().value!);
        }
        break;
      case "npcKill": {
        const name = NPC_DEFS[m.kind]?.name ?? "a creature";
        this.kills.set(m.id, { xp: m.xp, coins: m.coins, at: Date.now(), name });
        if (this.kills.size > 40) this.kills.delete(this.kills.keys().next().value!);
        this.note("kill", `killed ${name}: +${m.xp} XP, +${m.coins} coins`);
        break;
      }
      case "death":
        if (m.victim === id) this.note("death", `you died${m.killerName ? ` (killed by ${String(m.killerName).replace(/^npc:/, "")})` : ""}: call respawn`);
        else if (m.killer === id) this.note("kill", `killed player ${this.nameOf(m.victim)}`);
        break;
      case "toast":
        this.note("toast", String(m.text));
        break;
      case "denied":
        this.lastDenial = { action: m.action, reason: m.reason, at: Date.now() };
        if (m.reason === "reloading" || m.reason === "empty") this.reloadUntil = Math.max(this.reloadUntil, Date.now() + (this.weapon().tier.reload ?? 1.5) * 1000);
        else if (m.reason === "overheated") this.overheatUntil = Math.max(this.overheatUntil, Date.now() + 1500);
        else this.note("denied", `refused: ${m.action} (${m.reason})`, { key: `denied:${m.action}:${m.reason}`, amount: 0 });
        break;
      case "missionDone":
        this.note("mission", m.id === "vault" ? `the Gleam Vault opened: +${m.coins} coins and the Gleamweave Cape` : `mission ${m.id} complete: +${m.xp} XP, +${m.coins} coins`);
        break;
      case "huntTargets":
        this.huntIds = new Set(m.npcs as string[]);
        break;
      case "phrase":
        if (m.by !== id) this.note("phrase", `${this.nameOf(m.by)} says "${PHRASES[m.id] ?? "…"}"`);
        break;
      case "announce":
        this.note("info", `announcement: ${m.text}`);
        break;
      case "updating":
        this.note("info", `the server restarts in ${m.seconds} s`);
        break;
      case "kicked":
        this.note("info", `removed by an admin: ${m.reason}`);
        break;
      default:
        break;
    }
  }

  private onTrial(m: TrialMsg) {
    const before = this.trials.get(m.id);
    this.trials.set(m.id, { ...m, at: Date.now() });
    const name = MISSION_BY_ID.get(m.id)?.name ?? m.id;
    if (m.state === "failed") this.note("trial", `${m.id} ${name}: attempt failed (${m.reason ?? "?"})`);
    else if (m.state === "done") this.note("trial", `${m.id} ${name}: done`);
    else if (m.state === "paused") this.note("trial", `${m.id} ${name}: outside the beacon's ring, the clock waits (go back within seconds or it fails)`);
    else if (m.state === "running" && before?.state !== "running") this.note("trial", `${m.id} ${name}: ${m.kind === "defend" ? `the beacon is lit, hold its ring for ${Math.ceil(m.leftMs / 1000)} s` : m.limitMs ? `the clock is running, ${Math.ceil(m.leftMs / 1000)} s` : "started"}`);
  }

  private onSpell(e: SpellEvent) {
    const id = this.sessionId;
    const name = SPELL_BY_ID.get(e.spell)?.name ?? e.spell;
    if (e.by === id) {
      if (e.phase === "cast") {
        const text =
          e.spell === "skipstep" ? `cast Skipstep: blinked ${round1(dist([e.x, e.y, e.z], [e.tx ?? e.x, e.ty ?? e.y, e.tz ?? e.z]))} m`
          : e.spell === "frostbloom" ? `cast Frostbloom: ${e.hit?.length ?? 0} slowed`
          : e.spell === "wishfall" ? `cast Wishfall: a star lands ${round1(dist(this.walker.p, [e.x, e.y, e.z]))} m away in ${round1((e.ms ?? 0) / 1000)} s`
          : `cast ${name}: a shell of ${e.hp ?? 0} HP for ${round1((e.ms ?? 0) / 1000)} s`;
        this.note("spell", text);
      } else if (e.phase === "absorb") this.note("spell", `the ward absorbed {n} damage{hits}`, { key: "ward", amount: e.amount ?? 0 });
      else if (e.phase === "end" && e.spell === "glasswing") this.note("spell", e.broke ? "the ward broke" : "the ward ended");
      return;
    }
    // Someone else's star about to land close by: worth knowing before it does.
    if (e.spell === "wishfall" && e.phase === "cast" && dist(this.walker.p, [e.x, e.y, e.z]) <= (e.r ?? WISHFALL.radiusM) + 3) {
      this.note("spell", `a star called by ${this.nameOf(e.by)} lands ${round1(dist(this.walker.p, [e.x, e.y, e.z]))} m from you in ${round1((e.ms ?? 0) / 1000)} s: move away`);
    }
  }

  /** The server's clock now (ms): the synced room time, carried forward since the last patch. */
  private serverNow(): number {
    const t: number = (this.room?.state as any)?.time || 0;
    return t ? t + Math.max(0, Date.now() - this.lastPatchAt) : Date.now();
  }

  /** The other player fighting creature `id`: they hit it in the last `ms`, or (with `chased`) it is after them. */
  private claimOf(id: string, ms = 6000, chased = false): { id: string; name: string; agent: boolean } | null {
    const st = this.room?.state as any;
    const c = this.claims.get(id);
    let by: string | null = c && Date.now() - c.at <= ms ? c.by : null;
    if (!by && chased) {
      const t: string | undefined = st?.npcs?.get(id)?.target;
      if (t && t !== this.sessionId && st?.players?.has(t)) by = t;
    }
    const p = by ? st?.players?.get(by) : null;
    return p && by !== this.sessionId ? { id: by!, name: p.name, agent: !!p.agent } : null;
  }

  private waitFor<T = any>(type: string, test: (m: T) => boolean, ms: number): Promise<T | null> {
    return new Promise((resolve) => {
      const w = { type, test, resolve: (m: T | null) => (clearTimeout(timer), resolve(m)) };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(null);
      }, ms);
      this.waiters.push(w);
    });
  }

  /** Poll a condition on the agent's own state (the next `you`, a state patch). */
  private async until(cond: () => boolean, ms: number): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (cond()) return true;
      await sleep(25);
    }
    return cond();
  }

  // ------------------------------------------------------------------------------------ the loop

  private onTick() {
    const room = this.room;
    if (!room || this.status !== "playing") return;
    const me = this.me();
    if (!me) return;
    if (this.dead) {
      this.finish({ ok: false, reason: "dead", hint: "call respawn" });
      return; // the server ignores a dead body's inputs
    }
    let control = IDLE;
    const d = this.driver;
    if (d) {
      let r: Control | { done: ActionResult };
      try {
        r = d.tick(Date.now(), TICK_MS / 1000);
      } catch (e) {
        r = { done: { ok: false, reason: "error", hint: (e as Error).message } };
      }
      if ("done" in r) {
        if (this.driver === d) this.driver = null;
        d.resolve(r.done);
      } else control = r;
    }
    // The step covers the time since the last input went out, measured now (after the thinking
    // above): the server pays for distance by the gaps between the inputs it receives, so a tick
    // that thought for long must not be followed by one that moves as if it hadn't.
    const now = Date.now();
    const dt = Math.min(0.1, Math.max(0, (now - this.lastTick) / 1000));
    this.lastTick = now;
    const w = this.walker;
    // The server pays for at most 0.25 s of movement between two inputs it handles. When it stalls
    // (no state patch for a few ticks) inputs queue up and are handled in one go, so a body that
    // kept running would be snapped back: stand until patches flow again, as a careful player would.
    const stalled = now - this.lastPatchAt > STALL_MS;
    if (stalled) this.stalls++;
    w.step(dt, stalled ? null : control.wish, stalled ? 0 : control.speed, control.face ?? null, stalled);
    room.send("input", { seq: ++this.seq, x: w.pos.x, y: w.pos.y, z: w.pos.z, fx: w.facing[0], fy: w.facing[1], fz: w.facing[2], anim: w.anim, t: now });
    this.inputs++;
    control.after?.();
  }

  private finish(r: ActionResult) {
    const d = this.driver;
    this.driver = null;
    d?.resolve(r);
  }

  private cancel(why: string) {
    this.finish({ ok: false, reason: "cancelled", hint: why });
  }

  /** Run a per-tick driver until it reports a result. One at a time: a new action ends the old one. */
  private run(tick: Tick): Promise<ActionResult> {
    const no = this.notPlaying();
    if (no) return Promise.resolve(no);
    this.cancel("a newer action took over");
    return new Promise((resolve) => (this.driver = { tick, resolve }));
  }

  private notPlaying(): ActionResult | null {
    if (this.status === "reconnecting") return { ok: false, reason: "reconnecting", hint: "the connection dropped; try again in a few seconds" };
    if (this.status !== "playing" || !this.room) return { ok: false, reason: "not connected", hint: "call connect first" };
    if (this.dead) return { ok: false, reason: "dead", hint: "call respawn" };
    return null;
  }

  // ------------------------------------------------------------------------------------ observing

  /**
   * The world around the character right now. `events` are the ones since the previous call
   * (`peek: true` leaves them unread).
   */
  observe(o: { peek?: boolean; maxSummaryBytes?: number } = {}): Observation {
    const now = Date.now();
    const st = this.room?.state as any;
    const me = this.me();
    const w = this.world;
    const pos = this.walker.p;
    const you = this.you;
    const wp = this.weapon();
    const place = (id: string, name: string, at: readonly number[]): ObservedPlace => ({ id, name, dist: round1(groundDistance(pos, at)), bearing: bearingTo(pos, at) });
    const item = (it: InvItem | null, slot: number): ObservedItem | null => (it ? { slot, id: it.id, name: itemName(it), tier: it.tier, qty: it.qty, ...(it.mag !== undefined ? { mag: it.mag } : {}) } : null);
    const flags: number = me?.flags ?? 0;
    const zone = w.zone(pos);
    const serverNow: number = st?.time || now;

    const creatures: ObservedCreature[] = [];
    st?.npcs?.forEach((n: any, id: string) => {
      if (n.flags & NF.DEAD || n.hp <= 0) return;
      const def = NPC_DEFS[n.kind];
      const at = [n.x, n.y, n.z];
      const claim = this.claimOf(id, 6000, true);
      creatures.push({
        id,
        kind: def?.id ?? String(n.kind),
        name: def?.name ?? "creature",
        level: n.level,
        hp: n.hp,
        maxHp: n.maxHp,
        dist: round1(dist(pos, at)),
        bearing: bearingTo(pos, at),
        hostile: def?.temper === "hostile" || (n.flags & NF.AGGRO) !== 0,
        boss: def?.family === "boss",
        onMe: n.target === this.sessionId,
        mission: this.huntIds.has(id),
        ...(claim ? { claimedBy: { name: claim.name, agent: claim.agent } } : {}),
      });
    });
    creatures.sort((a, b) => a.dist - b.dist);

    const players: Observation["players"] = [];
    st?.players?.forEach((p: any, id: string) => {
      if (id === this.sessionId) return;
      const at = [p.x, p.y, p.z];
      players.push({ id, name: p.name, level: p.level, dist: round1(dist(pos, at)), bearing: bearingTo(pos, at), agent: !!p.agent, dead: (p.flags & PF.DEAD) !== 0 });
    });
    players.sort((a, b) => a.dist - b.dist);

    const piles: Observation["piles"] = [];
    st?.piles?.forEach((p: any, id: string) => {
      piles.push({ ...place(id, "loot pile", [p.x, p.y, p.z]), coins: p.coins, items: p.items, yours: p.owner === this.displayName });
    });
    piles.sort((a, b) => a.dist - b.dist);

    const known = new Set(you?.pads ?? []);
    const pads = w.pads.map((p) => ({ ...place(`pad:${p.id}`, p.name, p.pos), known: known.has(p.id) })).sort((a, b) => a.dist - b.dist);
    const portals = w.portals.map((p) => ({ ...place(`portal:${p.to}`, `portal to ${p.to}`, scale(p.dir, w.R + p.h)), to: p.to as string }));
    const guide = w.guide ? place("guide", w.guide.def.name, w.guide.pos) : null;
    const shops = w.shops.map((s) => ({ ...place("shop", `${s.name} (${s.keeper})`, s.at), inReach: shopSpotAt(this.bodyId, pos)?.id === s.id }));
    const safe = this.safeSpot(pos);

    const missions: ObservedMission[] = (you?.missions ?? []).map((m) => {
      const def = MISSION_BY_ID.get(m.id);
      const timed = !!def && !m.done && isTrial(def);
      const tt = timed ? this.trialTarget(m, def) : null;
      const spot = m.done ? null : tt ? { pos: tt.obj.pos, what: tt.what, id: tt.obj.def.id } : w.missionSpot(m.id);
      return {
        id: m.id,
        name: def?.name ?? m.id,
        type: def?.type ?? "",
        objective: def?.objective ?? "",
        progress: m.progress,
        goal: m.goal || (def ? missionGoal(def) : 1),
        done: m.done,
        ...(spot ? { where: { dist: round1(groundDistance(pos, spot.pos)), bearing: bearingTo(pos, spot.pos), what: spot.what, ...("id" in spot ? { id: spot.id } : {}) } } : {}),
        ...(def && !m.done && def.body !== this.bodyId ? { on: def.body } : {}),
        ...(timed ? { trial: this.observedTrial(m, def, now) } : {}),
      };
    });
    const have = new Set((you?.missions ?? []).map((m) => m.id));
    const offers = w.givers.flatMap((g) =>
      missionsFrom(g.def.id).filter((m) => !have.has(m.id)).map((m) => ({ id: m.id as string, name: m.name, type: m.type as string, objective: m.objective, levels: `${m.recLevel[0]}-${m.recLevel[1]}`, from: g.def.name })),
    );
    const hunt: Observation["hunt"] = {
      name: GLEAMS.name,
      gleams: gleamsWon(you?.missions ?? []),
      of: GLEAMS.trials.length,
      vaultOpened: !!you?.gleamVault,
      ...(w.curator ? { curator: place("curator", w.curator.def.name, w.curator.pos) } : {}),
      ...(w.vault ? { vault: place("vault", "the Gleam Vault", w.vault.pos) } : {}),
    };
    const level: number = you?.level ?? me?.level ?? 1;
    const starterIdx: number = me?.starter ?? this.starter;
    const pace = starterMove(starterIdx);

    const fresh = this.events.filter((e) => e.at > this.seenEventAt).slice(-12);
    if (!o.peek && fresh.length) this.seenEventAt = fresh[fresh.length - 1]!.at;

    const hotbar = (you?.hotbar ?? []).map(item).filter((x): x is ObservedItem => !!x);
    const backpack = (you?.backpack ?? []).map((it, i) => item(it, i + 4)).filter((x): x is ObservedItem => !!x);
    const kind = wp.def.delivery === "melee" ? "melee" : wp.def.delivery === "none" || wp.def.delivery === "heal" || wp.def.delivery === "bubble" ? "none" : "ranged";
    const obs: Omit<Observation, "summary"> = {
      status: this.status === "playing" && this.dead ? "dead" : this.status,
      self: {
        id: this.sessionId,
        name: this.displayName,
        agent: true,
        body: this.bodyId,
        pos: [round1(pos[0]), round1(pos[1]), round1(pos[2])],
        heading: bearingOfDir(norm(pos), this.walker.facing),
        hp: me?.hp ?? 0,
        maxHp: me?.maxHp ?? 0,
        level,
        xp: you?.xp ?? 0,
        xpToNext: you?.xpToNext ?? 0,
        coins: you?.coins ?? 0,
        zone: flags & PF.SAFE || zone.safe ? "safe" : "danger",
        zoneKind: zone.kind,
        dead: this.dead,
        swimming: (flags & PF.SWIMMING) !== 0 || this.walker.swimming,
        inCombat: (flags & PF.IN_COMBAT) !== 0,
        protectedFor: Math.max(0, Math.ceil(((you?.protectedUntil ?? 0) - serverNow) / 1000)),
        weapon: {
          id: wp.def.id,
          name: wp.item ? itemName(wp.item) : wp.def.name,
          slot: wp.slot,
          kind,
          range: wp.def.range,
          ...(wp.tier.mag !== undefined ? { mag: wp.item?.mag ?? wp.tier.mag, magSize: wp.tier.mag } : {}),
        },
        hotbar,
        backpack,
        cooldowns: {
          attack: Math.max(0, this.nextAttackAt - now),
          reload: Math.max(0, this.reloadUntil - now),
          overheat: Math.max(0, this.overheatUntil - now),
          dodge: Math.max(0, this.walker.dodgeReadyAt - now),
          tonic: Math.max(0, this.tonicUntil - now),
        },
        starter: STARTER_STATS[starterIdx]?.id ?? STARTERS[starterIdx]?.id ?? "unit7",
        speed: { run: round1(pace.run), sprint: round1(pace.sprint), dodgeCooldown: pace.dodgeCooldown },
        spells: this.observedSpells(level),
      },
      creatures: creatures.slice(0, 8),
      players: players.slice(0, 8),
      piles: piles.slice(0, 4),
      pads: pads.slice(0, 3),
      portals,
      guide,
      shops,
      safety: safe ? place("safe", safe.name, safe.pos) : null,
      missions,
      offers,
      hunt,
      events: fresh.map((e) => ({ ago: round1((now - e.at) / 1000), type: e.type, text: e.text })),
    };
    return { ...obs, summary: summarize(obs, o.maxSummaryBytes) };
  }

  private safeSpot(pos: V3): { pos: V3; name: string } | null {
    return this.world.safeSpot(pos);
  }

  private observedSpells(level: number): ObservedSpells {
    const book = this.you?.spells ?? null;
    const sn = this.serverNow();
    const aether = book ? aetherAt(book, sn) : AETHER.max;
    return {
      aether: round1(aether),
      max: AETHER.max,
      ...(book?.ward && book.ward.until > sn ? { ward: { hp: book.ward.hp, left: round1((book.ward.until - sn) / 1000) } } : {}),
      list: SPELLS.map((sp, i) => {
        const unlocked = level >= sp.level;
        const readyIn = Math.max(0, Math.round((book?.ready[i] ?? 0) - sn));
        return { id: sp.id, name: sp.name, level: sp.level, cost: sp.cost, cooldown: sp.cooldownS, unlocked, readyIn, ready: unlocked && readyIn === 0 && aether >= sp.cost, what: sp.blurb };
      }),
    };
  }

  /**
   * Where an open race, defend or collect mission leads right now on this body: the next ring (the
   * first one while no attempt runs), the beacon, or the nearest piece not gathered yet.
   */
  private trialTarget(m: { id: string; counts?: number[] }, def: MissionDef): { obj: WorldObject; what: string; radius: number } | null {
    if (def.body !== this.bodyId) return null;
    const w = this.world;
    const t = this.trials.get(def.id);
    const live = t?.state === "running" || t?.state === "paused";
    if (def.race) {
      const id = (live && t?.next) || def.race.rings[0]!;
      const o = w.things.get(id);
      const n = def.race.rings.indexOf(id) + 1;
      return o ? { obj: o, what: live ? `ring ${n} of ${def.race.rings.length}: run through it` : "ring 1: running through it starts the clock", radius: def.race.radius } : null;
    }
    if (def.defend) {
      const o = w.things.get(def.defend.beacon);
      return o ? { obj: o, what: live ? `the lit beacon: stay within ${def.defend.radius} m of it` : `${o.def.name}: interact with it, then stay within ${def.defend.radius} m`, radius: def.defend.radius } : null;
    }
    if (def.collect) {
      const pos = this.walker.p;
      let best: WorldObject | null = null, bestD = Infinity, left = 0;
      def.collect.pieces.forEach((id, i) => {
        if (m.counts?.[i]) return;
        const o = w.things.get(id);
        if (!o) return;
        left++;
        const d = groundDistance(pos, o.pos);
        if (d < bestD) (bestD = d), (best = o);
      });
      return best ? { obj: best, what: `the nearest of ${left} ${def.collect.itemName} left: walk over it`, radius: def.collect.radius } : null;
    }
    return null;
  }

  private observedTrial(m: { id: string; progress: number; goal: number }, def: MissionDef, now: number): ObservedTrial {
    const t = this.trials.get(def.id);
    const live = t?.state === "running" || t?.state === "paused";
    // An untimed collect has no attempt to start or lose: it runs from the first piece on.
    const state = live ? t!.state : !def.collect?.limitS && def.collect && m.progress > 0 ? "running" : "idle";
    const limit = t?.limitMs !== undefined && live ? round1(t.limitMs / 1000) : (def.race?.limitS ?? def.defend?.holdS ?? def.collect?.limitS ?? 0);
    const left = live && t!.limitMs > 0 ? round1(Math.max(0, t!.leftMs - (t!.state === "running" ? now - t!.at : 0)) / 1000) : undefined;
    const goal = m.goal || missionGoal(def);
    const remaining = Math.max(0, goal - m.progress);
    const here = def.body === this.bodyId;
    const next = !here ? `played on ${def.body}`
      : def.race ? (live ? `run through the rings in order, ${remaining} to go` : "run through ring 1 to start the clock, then the rings in order")
      : def.defend ? (t?.state === "paused" ? "get back inside the beacon's ring now" : live ? `stay in the ring and fight what comes, ${remaining} s to hold` : "walk to the beacon and interact with it to start")
      : `walk over each piece, ${remaining} left${def.collect?.limitS && !live ? ` (the first one starts a ${def.collect.limitS} s clock)` : ""}`;
    return { state, ...(left !== undefined ? { left } : {}), limit, remaining, next, ...(t?.state === "failed" ? { failed: t.reason ?? "failed" } : {}) };
  }

  // ------------------------------------------------------------------------------------ targets

  /** A target as a moving point (creatures and players move), a label, and how close "there" is. */
  private resolve(target: MoveTarget): { at: () => V3 | null; label: string; within: number } | { error: ActionResult } {
    const w = this.world;
    const st = this.room?.state as any;
    const fixed = (p: readonly number[], label: string, within: number) => {
      const q: V3 = [p[0]!, p[1]!, p[2]!];
      return { at: () => q, label, within };
    };
    if (typeof target === "object" && "bearing" in target) {
      if (!(target.distance > 0) || !Number.isFinite(target.bearing)) return { error: { ok: false, reason: "bad target", hint: "bearing in degrees, distance in metres (> 0)" } };
      const up = norm(this.walker.p);
      const d = dirOfBearing(up, target.bearing);
      return fixed(w.onGround(towardDir(up, norm(addScaled(up, d, 1)), Math.min(target.distance, 400), w.R)), `${Math.round(target.distance)} m at ${Math.round(target.bearing)}°`, 0.7);
    }
    if (typeof target === "object" && "pos" in target) {
      const p = target.pos;
      if (!Array.isArray(p) || p.length !== 3 || !p.every((v) => Number.isFinite(v)) || len(p) < w.R * 0.5) return { error: { ok: false, reason: "bad target", hint: "pos is [x, y, z] in the body's frame (see self.pos)" } };
      return fixed(w.onGround(p), "the position", 0.7);
    }
    const id = (typeof target === "string" ? target : target.id).trim();
    const [head, tail] = id.includes(":") ? [id.slice(0, id.indexOf(":")), id.slice(id.indexOf(":") + 1)] : [id, ""];
    const pos = this.walker.p;
    const nearest = <T>(list: readonly T[], at: (x: T) => readonly number[]): T | null => {
      let best: T | null = null, bestD = Infinity;
      for (const x of list) {
        const d = groundDistance(pos, at(x));
        if (d < bestD) (bestD = d), (best = x);
      }
      return best;
    };
    switch (head) {
      case "guide":
        return w.guide ? fixed(w.guide.pos, `the guide ${w.guide.def.name}`, 2) : { error: { ok: false, reason: "no guide here", hint: "guides stand at the main pad of a planet, not on Portus" } };
      case "shop": {
        const s = nearest(w.shops, (x) => x.at);
        return s ? fixed(s.at, s.name, 3) : { error: { ok: false, reason: "no shop here" } };
      }
      case "portal": {
        const p = tail ? w.portals.find((x) => x.to === tail) : nearest(w.portals, (x) => scale(x.dir, w.R + x.h));
        return p ? fixed(scale(p.dir, w.R + p.h), `the portal to ${p.to}`, 1.5) : { error: { ok: false, reason: "no such portal", hint: `portals here: ${w.portals.map((x) => x.to).join(", ")}` } };
      }
      case "pad": {
        const p = tail ? w.pads.find((x) => x.id === Number(tail)) : nearest(w.pads, (x) => x.pos);
        return p ? fixed(p.pos, `pad ${p.id} ${p.name}`, 4) : { error: { ok: false, reason: "no such pad" } };
      }
      case "gate": {
        const g = nearest(w.gates, (x) => x);
        return g ? fixed(g, "the gate", 2) : { error: { ok: false, reason: "no gate here" } };
      }
      case "safe": {
        const s = this.safeSpot(pos);
        return s ? fixed(s.pos, s.name, 2) : { error: { ok: false, reason: "no safe zone known" } };
      }
      case "curator":
      case "sela":
        return w.curator ? fixed(w.curator.pos, w.curator.def.name, 2) : { error: { ok: false, reason: "not here", hint: "Sela Marchbank stands in Portus Plaza" } };
      case "vault":
        return w.vault ? fixed(w.vault.pos, "the Gleam Vault", 1.8) : { error: { ok: false, reason: "not here", hint: "the Gleam Vault stands in Portus Plaza" } };
      case "mission": {
        const open = (this.you?.missions ?? []).filter((m) => !m.done);
        const m = tail ? open.find((x) => x.id === tail) : open.find((x) => w.missionSpot(x.id));
        const mdef = m ? MISSION_BY_ID.get(m.id) : undefined;
        if (m && mdef && isTrial(mdef)) {
          // The next ring, the beacon or the nearest piece left: a point that moves on as the attempt does.
          const first = this.trialTarget(m, mdef);
          if (!first) return { error: { ok: false, reason: "no mission spot", hint: mdef.body !== this.bodyId ? `mission ${m.id} is played on ${mdef.body}` : "nothing left to reach" } };
          const mid = m.id;
          const at = (): V3 | null => {
            const cur = (this.you?.missions ?? []).find((x) => x.id === mid && !x.done);
            return cur ? (this.trialTarget(cur, mdef)?.obj.pos ?? null) : null;
          };
          return { at, label: `mission ${m.id}: ${first.what}`, within: mdef.defend ? 2 : 1.2 };
        }
        const spot = m ? w.missionSpot(m.id) : null;
        return spot ? fixed(spot.pos, `mission ${m!.id}: ${spot.what}`, Math.max(2, Math.min(8, (spot.radius ?? 4) / 2))) : { error: { ok: false, reason: "no mission spot", hint: "take a mission from the guide first; some missions have no fixed place" } };
      }
      default:
        break;
    }
    if (st?.npcs?.has(id)) return { at: () => (st.npcs.get(id) ? [st.npcs.get(id).x, st.npcs.get(id).y, st.npcs.get(id).z] : null), label: this.nameOf(id), within: 2 };
    if (st?.piles?.has(id)) return { at: () => (st.piles.get(id) ? [st.piles.get(id).x, st.piles.get(id).y, st.piles.get(id).z] : null), label: "the loot pile", within: 1.5 };
    let pid: string | null = st?.players?.has(id) ? id : null;
    if (!pid) st?.players?.forEach((p: any, k: string) => void (p.name === id && k !== this.sessionId && (pid = k)));
    if (pid) {
      const k: string = pid;
      return { at: () => (st.players.get(k) ? [st.players.get(k).x, st.players.get(k).y, st.players.get(k).z] : null), label: st.players.get(k).name, within: 2.5 };
    }
    const obj = w.things.get(id);
    if (obj) return fixed(obj.pos, obj.def.name, Math.max(0.6, obj.def.range * 0.6));
    if ((BODY_IDS as readonly string[]).includes(id)) return this.resolve(`portal:${id}`);
    return { error: { ok: false, reason: "unknown target", hint: "use an id from observe(), or guide, curator, vault, shop, portal:<body>, pad:<n>, gate, safe, mission:<id>, {bearing, distance}" } };
  }

  // ------------------------------------------------------------------------------------ walking

  private navigator(dest: () => V3 | null): Navigator {
    return createNavigator(this.walker, this.world, dest);
  }

  /**
   * Walk to a target, steering round walls, trees and rocks (through the gate when the walls are in
   * the way). Resolves when there, or with why not: "timeout", "blocked", "target gone", "hurt".
   */
  async moveTo(target: MoveTarget, o: MoveOptions = {}): Promise<ActionResult> {
    const no = this.notPlaying();
    if (no) return no;
    const t = this.resolve(target);
    if ("error" in t) return t.error;
    const start = this.walker.p;
    const first = t.at();
    if (!first) return { ok: false, reason: "target gone" };
    const within = o.within ?? t.within;
    const far = groundDistance(start, first);
    const pace = () => (o.sprint ? this.walker.sprint : this.walker.run); // the starter's own, less any slow, read every tick
    const limit = Math.min(o.seconds ?? Math.min(60, far / pace() * 1.8 + 8), 300) * 1000;
    const nav = this.navigator(t.at);
    const t0 = Date.now();
    const hurt0 = this.lastHurtAt;
    const corrections0 = this.corrections;
    let walked = 0;
    const report = (ok: boolean, reason?: string, hint?: string): { done: ActionResult } => {
      const at = t.at();
      return {
        done: {
          ok,
          ...(reason ? { reason } : {}),
          ...(hint ? { hint } : {}),
          target: t.label,
          walked: round1(walked),
          remaining: at ? round1(groundDistance(this.walker.p, at)) : 0,
          seconds: round1((Date.now() - t0) / 1000),
          corrections: this.corrections - corrections0,
        },
      };
    };
    let ticks = 0;
    return this.run((now) => {
      walked += this.walker.lastMoved;
      ticks++;
      const n = nav(now);
      if (n.gone) return report(false, "target gone");
      const at = t.at()!;
      if (groundDistance(this.walker.p, at) <= within) return report(true);
      if (o.stopWhenHit && this.lastHurtAt > hurt0) return report(false, "hurt", "something is attacking you: observe, then fight or move to safety");
      // `seconds` from the caller is wall-clock time. The default (what the distance needs) counts
      // movement ticks, so a starved machine or a stalling server doesn't cut a walk short; the
      // clock still bounds it at three times that.
      const over = o.seconds !== undefined ? now - t0 > limit : ticks * TICK_MS > limit || now - t0 > limit * 3;
      if (over) return report(false, "timeout", "still on the way: call moveTo again to keep going");
      if (n.blocked) return report(false, "blocked", "no way round found from here: try another bearing or a nearer target");
      return { wish: n.wish, speed: pace() };
    });
  }

  /** Stop whatever the character is doing (the pending action resolves as cancelled). */
  async stop(): Promise<ActionResult> {
    this.planGen++;
    this.cancel("stopped");
    return { ok: true };
  }

  /** Turn to face a target or a compass bearing. */
  async lookAt(target: MoveTarget | number): Promise<ActionResult> {
    const no = this.notPlaying();
    if (no) return no;
    const up = norm(this.walker.p);
    let dir: V3 | null;
    if (typeof target === "number") dir = dirOfBearing(up, target);
    else {
      const t = this.resolve(target);
      if ("error" in t) return t.error;
      const at = t.at();
      dir = at ? tangent(up, sub(at, this.walker.p)) : null;
    }
    if (!dir) return { ok: false, reason: "target gone" };
    this.walker.facing = dir;
    await sleep(TICK_MS * 2);
    return { ok: true, heading: bearingOfDir(up, dir) };
  }

  /** Roll 4.5 m (a short burst past sprint speed) along a bearing, or the way you face. The cooldown is the starter's (1.0 to 1.35 s). */
  async dodge(bearing?: number): Promise<ActionResult> {
    const no = this.notPlaying();
    if (no) return no;
    const up = norm(this.walker.p);
    const dir = bearing === undefined ? this.walker.facing : dirOfBearing(up, bearing);
    const now = Date.now();
    if (!this.walker.dodge(dir, now)) return { ok: false, reason: this.walker.swimming ? "swimming" : now < this.walker.dodgeReadyAt ? "cooldown" : "slowed", readyIn: Math.max(0, this.walker.dodgeReadyAt - now) };
    const from = this.walker.p;
    await sleep(WALK.dodgeTime * 1000 + TICK_MS * 2);
    // The roll's cooldown is the starter's (Kappa 1.0 s … Brother Ash 1.35 s).
    return { ok: true, moved: round1(dist(from, this.walker.p)) };
  }

  // ------------------------------------------------------------------------------------ fighting

  private lineOfSight(from: V3, to: V3): boolean {
    const d = sub(to, from);
    const l = len(d);
    if (!(l > 0.01)) return true;
    const u = scale(d, 1 / l);
    const w = this.world;
    return w.structures.raycast(from[0], from[1], from[2], u[0], u[1], u[2], l) > l && w.nature.raycast(from[0], from[1], from[2], u[0], u[1], u[2], l) > l;
  }

  /**
   * Fight a creature (or, with `pvp`, a player) with the weapon in hand: closes to the weapon's
   * range, keeps facing it, attacks at the weapon's rate, waits out reloads and overheats.
   * Resolves when it is dead, the time is up, you are, or the server refuses (a safe zone).
   */
  async attack(targetId: string, o: AttackOptions = {}): Promise<ActionResult> {
    const no = this.notPlaying();
    if (no) return no;
    const room = this.room!;
    const st = room.state as any;
    let id = targetId;
    let isPlayer = false;
    if (!st.npcs?.has(id)) {
      let pid: string | null = st.players?.has(id) ? id : null;
      if (!pid) st.players?.forEach((p: any, k: string) => void (p.name === id && (pid = k)));
      if (!pid || pid === this.sessionId) return { ok: false, reason: "unknown target", hint: "use a creature id from observe()" };
      if (!o.pvp) return { ok: false, reason: "pvp not asked for", hint: "that is a player; pass pvp: true only to defend yourself" };
      id = pid;
      isPlayer = true;
    }
    const wpn = this.weapon();
    if (wpn.def.delivery === "none" || wpn.def.delivery === "heal" || wpn.def.delivery === "bubble") return { ok: false, reason: "no weapon in hand", hint: "selectSlot a weapon first" };
    const get = (): any => (isPlayer ? st.players?.get(id) : st.npcs?.get(id)) ?? null;
    const name = this.nameOf(id);
    const t0 = Date.now();
    const limit = Math.max(1, Math.min(120, o.seconds ?? 20)) * 1000;
    const untilDead = o.untilDead !== false;
    const nav = this.navigator(() => {
      const t = get();
      return t ? [t.x, t.y, t.z] : null;
    });
    let goneAt = 0;
    let attacks = 0;
    let drawUntil = 0;
    let prev: { p: V3; at: number } | null = null;
    let vel: V3 = [0, 0, 0];
    const hp0: number = get()?.hp ?? 0;
    const result = (r: ActionResult): { done: ActionResult } => ({ done: { ...r, target: name, attacks, seconds: round1((Date.now() - t0) / 1000), hp: this.me()?.hp ?? 0 } });

    return this.run((now) => {
      const me = this.me();
      const t = get();
      const dead = !t || (isPlayer ? (t.flags & PF.DEAD) !== 0 : (t.flags & NF.DEAD) !== 0 || t.hp <= 0);
      if (dead) {
        const k = this.kills.get(id);
        if (k && k.at >= t0) return result({ ok: true, killed: true, xp: k.xp, coins: k.coins });
        if (isPlayer && t) return result({ ok: true, killed: true });
        goneAt ||= now;
        // The reward message follows the death by a tick or two.
        if (now - goneAt < 700) return IDLE;
        return result({ ok: true, killed: !!t, ...(t ? {} : { reason: "target gone", hint: "it left your sight (fled, or someone else's kill)" }) });
      }
      if (now - t0 > limit) return result({ ok: !untilDead, killed: false, reason: "time", targetHp: t.hp, dealt: Math.max(0, hp0 - t.hp), hint: "still alive: attack again, or retreat" });
      if (o.yieldTo && !isPlayer) {
        const c = this.claimOf(id, 5000);
        if (c && (o.yieldTo === "anyone" || !c.agent)) return result({ ok: false, killed: false, reason: "yielded", to: c.name, targetHp: t.hp, hint: `${c.name} is fighting it: the kill is theirs` });
      }
      if (o.retreatBelow && me.hp < me.maxHp * o.retreatBelow) return result({ ok: false, killed: false, reason: "low hp", targetHp: t.hp, hint: "retreat: moveTo('safe'), or useItem a tonic" });
      const den = this.lastDenial;
      if (den && den.at >= t0 && (den.action === "fire" || den.action === "melee")) {
        if (den.reason === "safe zone") return result({ ok: false, killed: false, reason: "safe zone", hint: "nobody fights in a safe zone: walk out of it first (moveTo a creature outside, or a bearing away from the pad)" });
        if (den.reason === "swimming") return result({ ok: false, killed: false, reason: "swimming", hint: "get out of the water to fight" });
        if (den.reason === "level gate") return result({ ok: false, killed: false, reason: "level gate", hint: "this weapon tier needs a higher level: selectSlot another weapon" });
        if (den.reason === "mounted" || den.reason === "not a ranged weapon" || den.reason === "not a weapon" || den.reason === "dir" || den.reason === "origin") return result({ ok: false, killed: false, reason: den.reason });
      }
      const w = this.weapon();
      const melee = w.def.delivery === "melee";
      const pos = this.walker.p;
      const up = norm(pos);
      const tp: V3 = [t.x, t.y, t.z];
      if (prev && now > prev.at) {
        const k = 1000 / (now - prev.at);
        vel = [(tp[0] - prev.p[0]) * k, (tp[1] - prev.p[1]) * k, (tp[2] - prev.p[2]) * k];
        if (len(vel) > 20) vel = [0, 0, 0]; // a teleport, not a speed
      }
      prev = { p: tp, at: now };
      const def = isPlayer ? null : NPC_DEFS[t.kind];
      const chest = addScaled(tp, norm(tp), isPlayer ? 1.0 : Math.min((def?.height ?? 1) * 0.5, 3));
      const head = addScaled(pos, up, 1.6);
      const d = dist(pos, tp);
      const sight = melee ? true : this.lineOfSight(head, chest);
      const want = melee ? Math.max(0.9, w.def.range * 0.7) : Math.min(w.def.range * 0.6, 14);
      const reach = melee ? w.def.range + 0.2 : w.def.range * 0.95;
      const face = tangent(up, sub(tp, pos)) ?? this.walker.facing;
      let wish: V3 | null = null;
      if (d > want || !sight) wish = nav(now).wish;
      const speed = d > want + 8 ? this.walker.sprint : this.walker.run;
      if (o.leash && wish) {
        // Holding a place (a beacon's ring): never walk further out than the leash, whatever the target does.
        const out = sub(pos, [o.leash.pos[0]!, o.leash.pos[1]!, o.leash.pos[2]!]);
        if (len(out) >= o.leash.radius && wish[0] * out[0] + wish[1] * out[1] + wish[2] * out[2] > 0) wish = null;
      }
      const safe = ((me.flags as number) & PF.SAFE) !== 0;
      const protectedNow = (this.you?.protectedUntil ?? 0) > (st.time || now);
      const ready = !safe && !protectedNow && d <= reach && sight && now >= this.nextAttackAt && now >= this.reloadUntil && now >= this.overheatUntil;
      // In a safe zone and already within reach: one try tells the caller why it doesn't work.
      const probeSafe = safe && d <= reach && sight && attacks === 0 && now >= this.nextAttackAt;
      if (!ready && !probeSafe) return { wish, speed, face };
      if (w.def.delivery === "arrow" && !drawUntil) {
        drawUntil = now + (w.tier.draw ?? 1) * 1000 + 80;
        return { wish: null, speed, face, after: () => room.send("charge", { on: true }) };
      }
      if (w.def.delivery === "arrow" && now < drawUntil) return { wish: null, speed, face };
      drawUntil = 0;
      return {
        wish,
        speed,
        face,
        after: () => {
          attacks++;
          this.nextAttackAt = now + w.tier.rate * 1000 + 20;
          if (melee) room.send("melee", { slot: w.slot, t: now });
          else {
            // Aim where it will be: lead by the flight time, lift for the drop.
            const sp = w.def.delivery === "arrow" ? 55 : (w.def.speed ?? 0);
            const flight = sp > 0 ? d / sp : 0;
            let aim = addScaled(chest, vel, flight);
            if (w.def.gravity && flight > 0) aim = addScaled(aim, up, 0.5 * w.def.gravity * flight * flight);
            const dir = norm(sub(aim, head));
            room.send("fire", { slot: w.slot, ox: head[0], oy: head[1], oz: head[2], dx: dir[0], dy: dir[1], dz: dir[2], t: now });
            this.spendShot(w.tier, w.item, now);
          }
        },
      };
    });
  }

  /** Mirror the server's magazine and heat rules for a shot just sent (combat.ts consumeAttack). */
  private spendShot(tier: TierStats, item: InvItem | null, now: number) {
    if (tier.mag !== undefined && item) {
      const mag = (item.mag ?? tier.mag) - 1;
      item.mag = mag <= 0 ? tier.mag : mag;
      if (mag <= 0) this.reloadUntil = now + (tier.reload ?? 1.5) * 1000 + 120;
    }
    if (tier.heat !== undefined) {
      this.heat = Math.max(0, this.heat - (now - this.lastShotAt) / 1000) + 1;
      if (this.heat >= tier.heat) {
        this.overheatUntil = now + 1500 + 120;
        this.heat = 0;
      }
    }
    this.lastShotAt = now;
  }

  /**
   * Cast a spell from the spellbook (content/spells.ts): `skipstep` (blink up to 10 m along the
   * ground; level 1), `frostbloom` (a ring of frost around you: damage and a slow; level 3),
   * `wishfall` (a star on a ground point up to 30 m away, landing 1.2 s later; level 6), `glasswing`
   * (a shell that soaks up damage for 4 s; level 9). Each costs aether and has a cooldown (see
   * `self.spells`). The server decides: a refusal comes back as its reason ("locked", "cooldown",
   * "aether", "safe zone", "protected", "swimming", "blocked").
   *
   * Skipstep moves the body on the server: the agent takes the position the server sends back.
   */
  async cast(spell: string, aim: CastAim = {}): Promise<ActionResult> {
    const no = this.notPlaying();
    if (no) return no;
    const key = spell.trim().toLowerCase();
    const def = SPELL_BY_ID.get(key) ?? SPELLS.find((x) => x.name.toLowerCase() === key || (key === "ward" && x.id === "glasswing"));
    if (!def) return { ok: false, reason: "no such spell", hint: `spells: ${SPELLS.map((x) => x.id).join(", ")}` };
    const room = this.room!;
    const st = room.state as any;
    const id0 = this.sessionId;
    const idx = SPELL_INDEX.get(def.id)!;
    const level: number = this.you?.level ?? this.me()?.level ?? 1;
    // What can be told from here saves a round trip; the server checks the same things again.
    const block = castBlock(def, level, this.you?.spells, this.serverNow());
    if (block === "level") return { ok: false, reason: "locked", hint: `${def.name} unlocks at level ${def.level} (you are level ${level})` };
    if (block === "cooldown") return { ok: false, reason: "cooldown", readyIn: Math.max(0, Math.round((this.you?.spells?.ready[idx] ?? 0) - this.serverNow())) };
    if (block === "aether") return { ok: false, reason: "aether", hint: `${def.name} costs ${def.cost} aether; it refills ${AETHER.regenPerS} a second` };
    const pos = this.walker.p;
    const up = norm(pos);
    let dir: V3 = this.walker.facing;
    let point: V3 | null = null;
    if (aim.targetId) {
      const t = st.npcs?.get(aim.targetId) ?? st.players?.get(aim.targetId);
      if (!t) return { ok: false, reason: "unknown target", hint: "use a creature or player id from observe()" };
      point = [t.x, t.y, t.z];
      dir = tangent(up, sub(point, pos)) ?? dir;
    } else if (aim.pos) {
      const q = aim.pos;
      if (!Array.isArray(q) || q.length !== 3 || !q.every((v) => Number.isFinite(v)) || len(q) < this.world.R * 0.5) return { ok: false, reason: "bad target", hint: "pos is [x, y, z] in the body's frame (see self.pos)" };
      point = this.world.onGround(q);
      dir = tangent(up, sub(point, pos)) ?? dir;
    } else if (aim.bearing !== undefined) {
      if (!Number.isFinite(aim.bearing)) return { ok: false, reason: "bad target", hint: "bearing in compass degrees" };
      dir = dirOfBearing(up, aim.bearing);
      if (def.id === "wishfall") point = this.world.onGround(towardDir(up, norm(addScaled(up, dir, 1)), Math.max(1, Math.min(WISHFALL.rangeM, aim.distance ?? 12)), this.world.R));
    }
    // Agents don't start fights with people (D-agents-6): a blast that would catch a player is not
    // cast unless asked for. Frostbloom: around you. Wishfall: around where it is aimed (without a
    // point the server picks one along the facing, up to its range: anyone that near counts).
    if (def.harmful && !aim.pvp) {
      const centre = def.id === "wishfall" ? point : pos;
      const reach = def.id === "frostbloom" ? FROSTBLOOM.radiusM + 1.5 : point ? WISHFALL.radiusM + 2 : WISHFALL.rangeM + WISHFALL.radiusM;
      let caught: string | null = null;
      st.players?.forEach((p: any, k: string) => {
        if (k === id0 || caught || (p.flags & (PF.DEAD | PF.SAFE)) !== 0) return;
        if (dist(centre ?? pos, [p.x, p.y, p.z]) <= reach) caught = p.name;
      });
      if (caught) return { ok: false, reason: "players in range", who: caught, hint: `${def.name} would hurt ${caught}: move away or aim elsewhere (pvp: true only to defend yourself)` };
    }
    const msg: CastMsg = { spell: def.id, dx: dir[0], dy: dir[1], dz: dir[2], ...(def.id === "wishfall" && point ? { tx: point[0], ty: point[1], tz: point[2] } : {}) };
    const id = this.sessionId;
    const from = this.walker.p;
    const t0 = Date.now();
    if (def.id === "skipstep") {
      this.walker.facing = dir;
      this.expectTeleport = t0 + 2500; // the server's `correct` after a blink is the spell working, not a refusal
    }
    const cast = this.waitFor<SpellEvent>("spell", (e) => e.by === id && e.spell === def.id && e.phase === "cast", 2500).then((e) => (e ? { e } : null));
    const denied = this.waitFor<{ action: string; reason: string }>("denied", (m) => m.action === "cast", 2500).then((m) => (m ? { reason: m.reason } : null));
    room.send("cast", msg);
    const r = await Promise.race([cast, denied]);
    if (def.id === "skipstep" && !(r && "e" in r)) this.expectTeleport = 0;
    if (!r) return { ok: false, reason: "no answer", hint: "casts are limited to 5 a second" };
    if ("reason" in r) {
      const hint: Record<string, string> = {
        locked: `${def.name} unlocks at level ${def.level}`,
        "safe zone": "no spells in a safe zone: walk out of it first",
        protected: "arrival protection is still on: wait for self.protectedFor to reach 0",
        swimming: "get out of the water first",
        blocked: "a wall, deep water or a ledge right ahead: aim another way",
        dead: "call respawn",
      };
      return { ok: false, reason: r.reason, ...(hint[r.reason] ? { hint: hint[r.reason] } : {}) };
    }
    const e = r.e;
    if (def.id === "skipstep") await this.until(() => dist(from, this.walker.p) > 0.5, 600); // the `correct` that carries the new position
    await this.until(() => (this.you?.spells?.t ?? 0) >= (st.time || 0) - 2000 && (this.you?.spells?.ready[idx] ?? 0) > 0, 500);
    const book = this.you?.spells;
    return {
      ok: true,
      spell: def.id,
      aether: book ? Math.round(aetherAt(book, this.serverNow())) : undefined,
      cooldown: def.cooldownS,
      ...(def.id === "skipstep" ? { moved: round1(dist(from, this.walker.p)) } : {}),
      ...(def.id === "frostbloom" ? { slowed: e.hit?.length ?? 0, radius: e.r } : {}),
      ...(def.id === "wishfall" ? { landsIn: round1((e.ms ?? 0) / 1000), distance: round1(dist(from, [e.x, e.y, e.z])), radius: e.r } : {}),
      ...(def.id === "glasswing" ? { shell: e.hp ?? 0, seconds: round1((e.ms ?? 0) / 1000) } : {}),
    };
  }

  // ------------------------------------------------------------------------------------ trials

  /**
   * Play a race, defend or collect mission you hold on this body, from wherever you stand:
   * - race: sprints to the first ring (passing it starts the clock) and on through every ring in order;
   * - collect: walks over each piece, nearest first (a timed one starts its clock at the first);
   * - defend: walks to the beacon, lights it, stays inside its ring and fights what comes until the hold is over.
   * Resolves when the mission is done, the attempt fails ("failed: time", "failed: left", "dead"),
   * the way is blocked, or `seconds` are up. Call it again for another attempt.
   */
  async playTrial(missionId: string, o: TrialOptions = {}): Promise<ActionResult> {
    const no = this.notPlaying();
    if (no) return no;
    const def = MISSION_BY_ID.get(missionId.trim().toUpperCase());
    if (!def || !isTrial(def)) return { ok: false, reason: "not a trial", hint: "race, defend and collect missions only (missions[].type in observe())" };
    const mine = () => (this.you?.missions ?? []).find((m) => m.id === def.id);
    const m0 = mine();
    if (!m0) return { ok: false, reason: "not accepted", hint: def.giver ? "take it from Sela Marchbank in Portus Plaza: moveTo('curator'), then missions take" : `take it from the guide on ${def.body}: moveTo('guide'), then missions take` };
    if (m0.done) return { ok: true, done: true, note: "already done in this life" };
    if (def.body !== this.bodyId) return { ok: false, reason: "wrong body", hint: `it is played on ${def.body}: go there first (the portal in Portus, or the portal back to Portus from here)` };
    if (!this.trialTarget(m0, def)) return { ok: false, reason: "no mission spot" };
    const t0 = Date.now();
    const corrections0 = this.corrections;
    const report = (r: ActionResult): ActionResult => {
      const m = mine();
      return { ...r, mission: def.id, type: def.type, progress: m?.progress ?? 0, goal: m?.goal || missionGoal(def), seconds: round1((Date.now() - t0) / 1000), hp: this.me()?.hp ?? 0, corrections: this.corrections - corrections0 };
    };
    const failed = (): string | null => {
      const t = this.trials.get(def.id);
      return t && t.state === "failed" && t.at >= t0 ? (t.reason ?? "failed") : null;
    };
    if (def.defend) return report(await this.holdBeacon(def, o, mine, failed, t0));

    // race and collect: one walk whose target moves on as the server counts rings and pieces.
    const limit = Math.max(5, Math.min(600, o.seconds ?? (def.race?.limitS ?? def.collect?.limitS ?? 120) + 240)) * 1000;
    const nav = this.navigator(() => {
      const m = mine();
      return m && !m.done ? (this.trialTarget(m, def)?.obj.pos ?? null) : null;
    });
    let goneAt = 0;
    const hurt0 = this.lastHurtAt;
    return report(
      await this.run((now) => {
        const m = mine();
        if (!m) return { done: { ok: false, reason: "not accepted" } };
        if (m.done) return { done: { ok: true, done: true } };
        if (o.stopWhenHit && this.lastHurtAt > hurt0) return { done: { ok: false, done: false, reason: "hurt", hint: "something is attacking you: fight or move to safety, then call it again" } };
        const why = failed();
        if (why) return { done: { ok: false, done: false, reason: `failed: ${why}`, hint: why === "time" ? "out of time: call it again for another attempt (passing ring 1, or the first piece, restarts the clock)" : "call it again for another attempt" } };
        if (now - t0 > limit) return { done: { ok: false, done: false, reason: "timeout", hint: "still going: call it again to continue" } };
        const n = nav(now);
        if (n.gone) {
          // Every piece counted and the reward a tick behind: wait for it, briefly.
          goneAt ||= now;
          return now - goneAt > 1500 ? { done: { ok: false, done: false, reason: "no mission spot" } } : IDLE;
        }
        goneAt = 0;
        if (n.blocked) return { done: { ok: false, done: false, reason: "blocked", hint: "no way round found from here: move somewhere else and call it again" } };
        return { wish: n.wish, speed: this.walker.sprint };
      }),
    );
  }

  /** The nearest live creature that is after you or hostile, within `radius` of `centre` (not a boss). */
  private threatNear(centre: readonly number[], radius: number): { id: string; dist: number; near: number } | null {
    const st = this.room?.state as any;
    const pos = this.walker.p;
    let best: { id: string; dist: number; near: number } | null = null;
    let near = 0;
    st?.npcs?.forEach((n: any, id: string) => {
      if (n.flags & NF.DEAD || n.hp <= 0) return;
      const def = NPC_DEFS[n.kind];
      if (def?.family === "boss") return;
      const at = [n.x, n.y, n.z];
      const mine = n.target === this.sessionId;
      if (!mine && !(def?.temper === "hostile" || (n.flags & NF.AGGRO) !== 0)) return;
      if (dist(centre, at) > radius) return;
      const d = dist(pos, at);
      if (d <= 5) near++;
      if (!best || d < best.dist) best = { id, dist: d, near: 0 };
    });
    if (best) (best as { near: number }).near = near;
    return best;
  }

  private async holdBeacon(def: MissionDef, o: TrialOptions, mine: () => { done: boolean } | undefined, failed: () => string | null, t0: number): Promise<ActionResult> {
    const d = def.defend!;
    const beacon = this.world.things.get(d.beacon);
    if (!beacon) return { ok: false, reason: "no mission spot" };
    const gen = ++this.planGen;
    const alive = () => this.planGen === gen && this.status === "playing" && !!this.room && !this.dead;
    const limit = Math.max(5, Math.min(600, o.seconds ?? d.holdS + 240)) * 1000;
    const alreadyLit = () => {
      const t = this.trials.get(def.id);
      return !!t && (t.state === "running" || t.state === "paused");
    };
    if (groundDistance(this.walker.p, beacon.pos) > 2.2) {
      const r = await this.moveTo({ pos: beacon.pos }, { sprint: true, within: 2 });
      if (!r.ok) return { ...r, done: false, phase: "walking to the beacon" };
    }
    for (let i = 0; i < 3 && alive() && !alreadyLit(); i++) {
      this.room?.send("interact", { target: d.beacon });
      await this.until(() => alreadyLit() || !alive(), 1200);
    }
    if (!alreadyLit()) return { ok: false, done: false, reason: alive() ? "beacon not lit" : this.dead ? "dead" : "cancelled", hint: "stand within 3 m of the beacon, out of any other attempt" };
    // Hold: stay well inside the ring, fight what comes close, drink when hurt.
    const inner = Math.max(4, d.radius - 4);
    const retreat = o.retreatBelow ?? 0.25;
    while (alive()) {
      const m = mine();
      if (!m) return { ok: false, done: false, reason: "not accepted" };
      if (m.done) return { ok: true, done: true };
      const why = failed();
      if (why) return { ok: false, done: false, reason: `failed: ${why}`, hint: "light the beacon again for another attempt" };
      if (Date.now() - t0 > limit) return { ok: false, done: false, reason: "timeout" };
      const me = this.me();
      if (groundDistance(this.walker.p, beacon.pos) > inner) {
        const r = await this.moveTo({ pos: beacon.pos }, { within: 3, sprint: true, seconds: 8 });
        if (r.reason === "cancelled") return { ...r, done: false };
        continue;
      }
      const hurt = !!me && me.hp < me.maxHp * 0.55;
      const foe = this.threatNear(beacon.pos, d.radius - 1);
      if (hurt && Date.now() >= this.tonicUntil) {
        const tonic = this.findItem("tonic_large") ?? this.findItem("tonic_small");
        if (tonic) await this.useItem(tonic.slot);
      }
      // Spells where they pay: the ward when hurt and under attack, frost when two or more are on top of you.
      const sp = this.observedSpells(this.you?.level ?? 1).list;
      if (foe && hurt && sp[3]?.ready) await this.cast("glasswing");
      else if (foe && foe.near >= 2 && sp[1]?.ready) await this.cast("frostbloom");
      if (foe && me && me.hp >= me.maxHp * retreat) {
        const r = await this.attack(foe.id, { seconds: 6, untilDead: false, leash: { pos: beacon.pos, radius: inner } });
        if (r.reason === "cancelled") return { ...r, done: false };
        continue;
      }
      await sleep(150);
    }
    return { ok: false, done: false, reason: this.dead ? "dead" : "cancelled", ...(this.dead ? { hint: "call respawn" } : {}) };
  }

  // ------------------------------------------------------------------------------------ items

  /** Put a hotbar slot (0-3) in hand. */
  async selectSlot(slot: number): Promise<ActionResult> {
    const no = this.notPlaying();
    if (no) return no;
    if (!Number.isInteger(slot) || slot < 0 || slot > 3) return { ok: false, reason: "bad slot", hint: "hotbar slots are 0-3" };
    this.room!.send("equip", { slot });
    await this.until(() => this.selectedSlot() === slot, 1500);
    const w = this.weapon();
    return { ok: this.selectedSlot() === slot, slot, weapon: w.item ? itemName(w.item) : "Fists" };
  }

  private findItem(what: number | string): { slot: number; item: InvItem } | null {
    const you = this.you;
    if (!you) return null;
    const all = [...you.hotbar, ...you.backpack];
    if (typeof what === "number") return all[what] ? { slot: what, item: all[what]! } : null;
    const i = all.findIndex((it) => it && (it.id === what || itemName(it).toLowerCase() === what.toLowerCase()));
    return i >= 0 ? { slot: i, item: all[i]! } : null;
  }

  /** Put an item (by slot 0-19 or item id) into the hand: moves it from the backpack if needed. */
  async equip(what: number | string): Promise<ActionResult> {
    const no = this.notPlaying();
    if (no) return no;
    const f = this.findItem(what);
    if (!f) return { ok: false, reason: "no such item", hint: "see self.hotbar and self.backpack in observe()" };
    let slot = f.slot;
    if (slot > 3) {
      const you = this.you!;
      const free = you.hotbar.findIndex((x) => !x);
      const to = free >= 0 ? free : this.selectedSlot();
      this.room!.send("move", { from: slot, to });
      await this.until(() => this.you?.hotbar?.[to]?.id === f.item.id, 1500);
      if (this.you?.hotbar?.[to]?.id !== f.item.id) return { ok: false, reason: "couldn't move it to the hotbar" };
      slot = to;
    }
    return this.selectSlot(slot);
  }

  /** Use a consumable (a tonic heals over a few seconds; 8 s between tonics) by slot or item id. */
  async useItem(what: number | string): Promise<ActionResult> {
    const no = this.notPlaying();
    if (no) return no;
    const f = this.findItem(what);
    if (!f) return { ok: false, reason: "no such item", hint: "see self.hotbar and self.backpack in observe()" };
    const tonic = f.item.id.startsWith("tonic");
    const now = Date.now();
    if (tonic && now < this.tonicUntil) return { ok: false, reason: "cooldown", readyIn: this.tonicUntil - now };
    const qty = f.item.qty;
    this.room!.send("use", { slot: f.slot });
    const used = await this.until(() => (this.findItem(f.slot)?.item.qty ?? 0) < qty || this.findItem(f.slot)?.item.id !== f.item.id, 1500);
    if (used && tonic) this.tonicUntil = Date.now() + 8000;
    return used ? { ok: true, used: itemName(f.item), left: qty - 1 } : { ok: false, reason: "not used", hint: "the server didn't take it (cooldown, level, or not a consumable)" };
  }

  /** Reload the weapon in hand now instead of when it runs dry. */
  async reload(): Promise<ActionResult> {
    const no = this.notPlaying();
    if (no) return no;
    const w = this.weapon();
    if (w.tier.mag === undefined) return { ok: false, reason: "nothing to reload" };
    this.room!.send("reload", { slot: w.slot });
    this.reloadUntil = Date.now() + (w.tier.reload ?? 1.5) * 1000 + 120;
    return { ok: true, seconds: w.tier.reload ?? 1.5 };
  }

  // ------------------------------------------------------------------------------------ the world's E key

  /**
   * What a person's E key does here: pick up the loot pile in reach, or use the nearest thing
   * (talk to the guide, open the shop, take a mission item, press a button). `target` names one.
   */
  async interact(target?: string): Promise<ActionResult> {
    const no = this.notPlaying();
    if (no) return no;
    const room = this.room!;
    const st = room.state as any;
    const pos = this.walker.p;
    // Piles first, like the client.
    let pile: string | null = null, pileD = 3.2;
    st.piles?.forEach((p: any, id: string) => {
      const d = dist(pos, [p.x, p.y, p.z]);
      if ((!target || target === id) && d <= pileD) (pileD = d), (pile = id);
    });
    if (pile) {
      const before = JSON.stringify([this.you?.hotbar, this.you?.backpack, this.you?.coins]);
      room.send("pickup", { pileId: pile });
      const got = await this.until(() => JSON.stringify([this.you?.hotbar, this.you?.backpack, this.you?.coins]) !== before || !st.piles?.has(pile), 2000);
      return got ? { ok: true, pickedUp: true, coins: this.you?.coins ?? 0, left: st.piles?.has(pile) ? "some items didn't fit" : "nothing" } : { ok: false, reason: "nothing picked up", hint: "bags full, or the pile isn't yours to take yet" };
    }
    if (target && st.piles?.has(target)) return { ok: false, reason: "too far", hint: "walk within 3 m of the pile: moveTo(id) first" };
    const active = new Set((this.you?.missions ?? []).filter((m) => !m.done).map((m) => m.id));
    let best: (typeof this.world.objects)[number] | null = null, bestD = Infinity;
    for (const o of this.world.objects) {
      if (target && o.def.id !== target && !(target === "guide" && o.def.look === "guide") && !(target === "shop" && o.def.look === "keeper") && !((target === "curator" || target === "sela") && o.def.look === "curator") && !(target === "vault" && o.def.look === "vault")) continue;
      if (o.def.mission && !active.has(o.def.mission)) continue;
      if (!inReach(o.pos, pos, o.def.range, 0.3)) continue;
      const d = groundDistance(o.pos, pos);
      if (d < bestD) (bestD = d), (best = o);
    }
    if (!best) return { ok: false, reason: "nothing in reach", hint: "walk up to it first: moveTo('guide'), moveTo('shop'), moveTo(<pile id>)" };
    if (best.def.look === "guide") return { ok: true, talkedTo: best.def.name, ...this.guideTalk() };
    if (best.def.look === "keeper") return this.shop();
    if (best.def.look === "curator") {
      const won = gleamsWon(this.you?.missions ?? []);
      const says = this.you?.gleamVault ? GLEAMS.lines.opened : won >= GLEAMS.trials.length ? GLEAMS.lines.all : won > 0 ? GLEAMS.lines.some : GLEAMS.lines.none;
      return { ok: true, talkedTo: best.def.name, says, gleams: won, of: GLEAMS.trials.length, ...this.guideTalk() };
    }
    if (best.def.look === "vault") {
      const t0 = Date.now();
      const opened = this.waitFor("missionDone", (m: { id: string }) => m.id === "vault", 2000).then((m) => (m ? "opened" : null));
      const refused = this.waitFor<{ action: string; reason: string }>("denied", (m) => m.action === "interact", 2000).then((m) => m?.reason ?? null);
      room.send("interact", { target: best.def.id });
      const r = await Promise.race([opened, refused]);
      if (r === "opened") return { ok: true, opened: true, coins: this.you?.coins ?? 0, reward: `${GLEAMS.reward.coins} coins and the Gleamweave Cape` };
      const won = gleamsWon(this.you?.missions ?? []);
      return { ok: false, reason: r ?? (Date.now() - t0 >= 2000 ? "no answer" : "refused"), gleams: won, of: GLEAMS.trials.length, hint: r === "vault opened" ? "once per life" : `the vault needs all three gleams (trials T1, T2, T3 from ${GLEAMS.curator.name})` };
    }
    const done0 = this.events.length;
    room.send("interact", { target: best.def.id });
    await sleep(400);
    return { ok: true, used: best.def.name, events: this.events.slice(done0).map((e) => e.text) };
  }

  private guideTalk(): { offers: unknown[]; active: unknown[] } {
    const obs = this.observe({ peek: true });
    return { offers: obs.offers, active: obs.missions.filter((m) => !m.done) };
  }

  /**
   * Take every mission the giver you stand at still has for you (within 3 m): the planet's guide, or
   * Sela Marchbank in Portus, who gives the three trials of the Three Gleams (played on the planets).
   */
  async takeMissions(ids?: string[]): Promise<ActionResult> {
    const no = this.notPlaying();
    if (no) return no;
    const w = this.world;
    if (!w.givers.length) return { ok: false, reason: "no guide here" };
    const near = w.givers.map((g) => ({ g, d: groundDistance(this.walker.p, g.pos) })).sort((a, b) => a.d - b.d)[0]!;
    if (near.d > 2.8) return { ok: false, reason: "too far", distance: round1(near.d), hint: near.g.def.look === "guide" ? "moveTo('guide') first" : "moveTo('curator') first" };
    const have = new Set((this.you?.missions ?? []).map((m) => m.id));
    const want = missionsFrom(near.g.def.id).filter((m) => !have.has(m.id) && (!ids || ids.includes(m.id)));
    if (!want.length) return { ok: true, taken: [], note: "nothing new to take", active: this.guideTalk().active };
    const t0 = Date.now();
    for (const m of want) {
      this.room!.send("mission", { action: "accept", id: m.id });
      await sleep(260); // quest messages are limited to 5 a second
    }
    await this.until(() => want.every((m) => (this.you?.missions ?? []).some((x) => x.id === m.id)), 2500);
    const got = want.filter((m) => (this.you?.missions ?? []).some((x) => x.id === m.id));
    const den = this.lastDenial;
    if (!got.length) return { ok: false, reason: den && den.at >= t0 && den.action === "mission" ? den.reason : "not accepted" };
    return { ok: true, from: near.g.def.name, taken: got.map((m) => ({ id: m.id, name: m.name, type: m.type, on: m.body, objective: m.objective, reward: `${m.reward.xp} XP, ${m.reward.coins} coins` })) };
  }

  // ------------------------------------------------------------------------------------ shops

  /** What the shop here sells that you could use, and what your bags would fetch. You must stand at a till. */
  async shop(): Promise<ActionResult> {
    const no = this.notPlaying();
    if (no) return no;
    const spot = shopSpotAt(this.bodyId, this.walker.p);
    if (!spot) return { ok: false, reason: "too far", hint: "moveTo('shop') first (every safe zone has one)" };
    const you = this.you;
    const level = you?.level ?? 1;
    const coins = you?.coins ?? 0;
    const sells = SHOP.filter((e) => e.category !== "cosmetics" && e.level <= level + 2).map((e) => ({ id: e.itemId, tier: e.tier, name: e.name, price: e.price, level: e.level, ok: e.level <= level && e.price <= coins }));
    return { ok: true, shop: spot.name, keeper: spot.keeper, coins, level, sells };
  }

  private async trade(action: "buy" | "sell", send: () => void): Promise<ActionResult> {
    const no = this.notPlaying();
    if (no) return no;
    if (!shopSpotAt(this.bodyId, this.walker.p)) return { ok: false, reason: "too far", hint: "moveTo('shop') first" };
    const n0 = this.events.length;
    const wait = this.waitFor<{ ok: boolean; action: string; reason?: string }>("shop", (m) => m.action === action, 2500);
    send();
    const r = await wait;
    await sleep(60);
    const said = this.events.slice(n0).filter((e) => e.type === "toast").map((e) => e.text).pop();
    if (!r) return { ok: false, reason: "no answer", hint: "trading is limited to 5 a second" };
    return r.ok ? { ok: true, coins: this.you?.coins ?? 0, ...(said ? { said } : {}) } : { ok: false, reason: r.reason ?? "refused", ...(said ? { hint: said } : {}) };
  }

  /** Buy from the shop you stand at: `buy("tonic_small", { qty: 3 })`, `buy("carbine", { tier: 2 })`. */
  buy(itemId: string, o: { tier?: 1 | 2 | 3; qty?: number } = {}): Promise<ActionResult> {
    return this.trade("buy", () => this.room!.send("buy", { itemId, tier: o.tier ?? 1, qty: o.qty ?? 1 }));
  }

  /** Sell what is in an inventory slot (0-3 hotbar, 4-19 backpack), or an item by id. */
  sell(what: number | string, qty?: number): Promise<ActionResult> {
    const f = this.findItem(what);
    if (!f) return Promise.resolve({ ok: false, reason: "no such item" });
    return this.trade("sell", () => this.room!.send("sell", { slot: f.slot, ...(qty ? { qty } : {}) }));
  }

  // ------------------------------------------------------------------------------------ travel

  /** Fast travel to a pad you have discovered. You must stand on a pad (inside its safe ring), out of combat. */
  async travel(pad: number): Promise<ActionResult> {
    const no = this.notPlaying();
    if (no) return no;
    const w = this.world;
    const p = w.pads.find((x) => x.id === pad);
    if (!p) return { ok: false, reason: "no such pad", hint: w.pads.length ? `pads here are 0-${w.pads.length - 1}` : "Portus has no pads: take a portal" };
    if (!(this.you?.pads ?? []).includes(pad)) return { ok: false, reason: "undiscovered", hint: "walk onto that pad once to discover it" };
    const t0 = Date.now();
    this.cancel("travelling");
    this.expectTeleport = t0 + 3000;
    const from = this.walker.p;
    this.room!.send("fastTravel", { pad });
    const ok = await this.until(() => dist(from, this.walker.p) > 8 || (!!this.lastDenial && this.lastDenial.at >= t0 && this.lastDenial.action === "fastTravel"), 3000);
    this.expectTeleport = 0;
    const den = this.lastDenial;
    if (den && den.at >= t0 && den.action === "fastTravel") return { ok: false, reason: den.reason, hint: den.reason === "stand on a pad" ? "moveTo('pad') first: fast travel starts from any pad's ring" : undefined };
    return ok ? { ok: true, pad, name: p.name } : { ok: false, reason: "no answer" };
  }

  /** Step through the portal to another body. You must stand at it (moveTo("portal:<body>")), out of combat. */
  async enterPortal(to: BodyId): Promise<ActionResult> {
    const no = this.notPlaying();
    if (no) return no;
    const w = this.world;
    const spot = w.portals.find((p) => p.to === to);
    if (!spot) return { ok: false, reason: "no such portal", hint: `portals here lead to: ${w.portals.map((p) => p.to).join(", ") || "nowhere"}` };
    const d = dist(this.walker.p, spot.center);
    if (d > PORTAL_REACH) return { ok: false, reason: "too far", distance: round1(d), hint: `moveTo('portal:${to}') first` };
    const t0 = Date.now();
    this.cancel("travelling");
    const okP = this.waitFor("travelOk", (m: { to: string }) => m.to === to, 3000);
    this.room!.send("travel", { to });
    const ok = await okP;
    if (!ok) {
      const den = this.lastDenial;
      return { ok: false, reason: den && den.at >= t0 && den.action === "travel" ? den.reason : "no answer" };
    }
    try {
      await this.hop(to);
    } catch (e) {
      return { ok: false, reason: e instanceof AgentError ? e.code : "join failed", hint: (e as Error).message };
    }
    return { ok: true, body: this.bodyId };
  }

  /** After dying: start a new life (level 1, a starter of your choice) in Portus. */
  async respawn(o: { starter?: number | string; palette?: number; look?: number } = {}): Promise<ActionResult> {
    if (this.status !== "playing" || !this.room) return { ok: false, reason: "not connected" };
    if (!this.dead) return { ok: false, reason: "not dead" };
    const s = o.starter;
    const starter = s === undefined ? this.starter : typeof s === "string" ? Math.max(0, STARTERS.findIndex((x) => x.id === s)) : Math.max(0, Math.min(STARTERS.length - 1, s));
    this.starter = starter;
    const reborn = this.waitFor<{ body: BodyId }>("reborn", () => true, 4000);
    this.room.send("respawn", { starter, palette: o.palette ?? this.opts?.palette ?? 0, look: o.look ?? this.opts?.look ?? 0 });
    const r = await reborn;
    if (!r) return { ok: false, reason: "no answer" };
    try {
      await this.hop(r.body);
    } catch (e) {
      return { ok: false, reason: e instanceof AgentError ? e.code : "join failed", hint: (e as Error).message };
    }
    return { ok: true, body: this.bodyId, starter: STARTERS[starter]!.id };
  }

  // ------------------------------------------------------------------------------------ small talk

  /** Say one of the game's fixed phrases to players nearby (there is no free chat). */
  async phrase(n: number | string): Promise<ActionResult> {
    const no = this.notPlaying();
    if (no) return no;
    const id = typeof n === "number" ? n : PHRASES.findIndex((p) => p.toLowerCase() === n.toLowerCase());
    if (!Number.isInteger(id) || id < 0 || id >= PHRASES.length) return { ok: false, reason: "no such phrase", hint: PHRASES.map((p, i) => `${i}: ${p}`).join(", ") };
    this.room!.send("phrase", { id });
    return { ok: true, said: PHRASES[id] };
  }

  /** Skip the Portus tutorial (three training dummies): it pays 50 XP when done, nothing when skipped. */
  async skipTutorial(): Promise<ActionResult> {
    const no = this.notPlaying();
    if (no) return no;
    if (!this.you?.onboarding) return { ok: true, note: "no tutorial in progress" };
    this.room!.send("onboarding", { action: "skip" });
    await this.until(() => !this.you?.onboarding, 1500);
    return { ok: !this.you?.onboarding };
  }
}
