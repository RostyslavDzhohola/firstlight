// Residents you can talk to (#82). A person who walks up to a resident gets greeted and told who it
// is and what it is doing; one who uses the phrase wheel near it gets an answer in character: where
// something is ("Help!" also brings a tip that fits their level), and a word back for "Thanks",
// "GG", "Truce?", "Follow me" and "Boss here". Lines are the authored ones in
// packages/shared/src/content/residentLines.ts, said by id: there is no free text (DECISIONS "No text
// chat"), so even the model brain only chooses among them.
//
// The brain is an interface with two implementations:
//   - scripted (the default): picks lines from the world state; no model, no cost;
//   - model: any OpenAI-compatible (`/chat/completions`) or Anthropic (`/v1/messages`) endpoint named
//     by env, called only when someone talks, at most once every few seconds, with a short
//     observation and the candidate lines; a hard budget of calls and tokens per hour; on a spent
//     budget, a failed call or an answer that doesn't fit, it falls back to the scripted brain.

import { BODIES, type BodyId } from "@firstlight/shared";
import { compassWord, linesFor, LINE_BY_ID, type LineTopic, type Voice } from "@firstlight/shared/content/residentLines";
import { GUIDES } from "@firstlight/shared/content/missions";
import type { FirstlightAgent, Heard } from "@firstlight/agent-kit";

type Observation = ReturnType<FirstlightAgent["observe"]>;
type Person = Observation["players"][number];

export interface Say {
  line: string;
  place?: string;
  dist?: number;
  dir?: string;
}

export interface TalkContext {
  voice: Voice;
  /** The resident's display name. */
  me: string;
  /** What happened: a person came near, or said a phrase-wheel line. */
  trigger: { kind: "near" } | { kind: "phrase"; phrase: string };
  to: Person;
  obs: Observation;
}

export interface Brain {
  readonly kind: "scripted" | "model";
  answer(ctx: TalkContext): Promise<Say[]>;
}

/** What a phrase-wheel line asks for. */
export const PHRASE_TOPIC: Readonly<Record<string, LineTopic>> = { "Help!": "tip", "Truce?": "truce", "Follow me": "follow", "Boss here": "boss", Thanks: "thanks", GG: "gg" };

/** Places worth pointing a person to from here, nearest-relevant first, with metres and a compass word. */
export function placesFor(obs: Observation, level: number): { place: string; dist: number; dir: string }[] {
  const out: { place: string; dist: number; dir: string }[] = [];
  const add = (place: string, d: { dist: number; bearing: number } | null | undefined) => {
    if (d && d.dist >= 1) out.push({ place, dist: Math.max(1, Math.round(d.dist)), dir: compassWord(d.bearing) });
  };
  const body = obs.self.body as BodyId;
  const portal = (to: string) => obs.portals.find((p) => p.id === `portal:${to}`);
  if (body === "portus") {
    // The world that fits their level first.
    const fit = level >= 12 ? "meridian" : level >= 6 ? "hollowmere" : "arcadia";
    add(`the portal to ${BODIES[fit].name}`, portal(fit));
    if (obs.hunt?.curator) add("Sela Marchbank", obs.hunt.curator);
  } else {
    const guide = GUIDES[body as Exclude<BodyId, "portus">];
    // Outgrown this planet: the way home first; else the guide (missions) first.
    const outgrown = (body === "arcadia" && level >= 8) || (body === "hollowmere" && level >= 14);
    if (outgrown) add("the portal home to Portus", portal("portus"));
    if (obs.guide && guide) add(guide.name, obs.guide);
    if (!outgrown) add("the portal home to Portus", portal("portus"));
  }
  const shop = obs.shops[0];
  if (shop) add(shop.name, shop);
  return out;
}

/** The scripted brain: authored lines chosen from the world state. `rng` picks among a topic's lines. */
export function scriptedBrain(rng: () => number = Math.random): Brain {
  const last = new Map<string, string>();
  const pick = (voice: Voice, topic: LineTopic, level: number): string | null => {
    const all = linesFor(voice, topic, level);
    if (!all.length) return null;
    const key = `${voice}.${topic}`;
    const fresh = all.length > 1 ? all.filter((l) => l.id !== last.get(key)) : all;
    const l = fresh[Math.floor(rng() * fresh.length) % fresh.length]!;
    last.set(key, l.id);
    return l.id;
  };
  return {
    kind: "scripted",
    async answer({ voice, trigger, to, obs }) {
      const out: Say[] = [];
      const push = (id: string | null, extra: Omit<Say, "line"> = {}) => id && out.push({ line: id, ...extra });
      if (trigger.kind === "near") {
        push(pick(voice, "greet", to.level));
        push(pick(voice, "doing", to.level));
        return out;
      }
      const topic = PHRASE_TOPIC[trigger.phrase];
      if (!topic) return out;
      if (topic === "tip") {
        // "Help!": where to go, then what to do there.
        const where = placesFor(obs, to.level)[0];
        if (where) push(pick(voice, "where", to.level), where);
        push(pick(voice, "tip", to.level));
        return out;
      }
      push(pick(voice, topic, to.level));
      return out;
    },
  };
}

// ------------------------------------------------------------------------------------ model brain

export interface ModelBrainOptions {
  /** `openai`: any OpenAI-compatible endpoint (`<url>/chat/completions`); `anthropic`: `<url>/v1/messages`. */
  api: "openai" | "anthropic";
  url: string;
  model: string;
  /** The API key (from the environment; never logged). */
  key?: string;
  /** The hard budget, per rolling hour. */
  callsPerHour: number;
  tokensPerHour: number;
  /** At most one call this often (the slow cadence), per brain. */
  minGapMs: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface ModelStats {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  fallbacks: number;
  /** Why the last fallback happened ("budget", "cadence", "http 500", "bad answer", …). */
  lastFallback?: string;
}

/** The short prompt: who the resident is, what just happened, and the lines it may choose from. */
export function modelPrompt(ctx: TalkContext): { system: string; user: string; candidates: Map<string, Omit<Say, "line"> | null> } {
  const level = ctx.to.level;
  const topics: LineTopic[] = ctx.trigger.kind === "near" ? ["greet", "doing"] : PHRASE_TOPIC[ctx.trigger.phrase] === "tip" ? ["where", "tip"] : [PHRASE_TOPIC[ctx.trigger.phrase] ?? "greet"];
  const places = placesFor(ctx.obs, level).slice(0, 3);
  const candidates = new Map<string, Omit<Say, "line"> | null>();
  const rows: string[] = [];
  for (const t of topics)
    for (const l of linesFor(ctx.voice, t, level)) {
      candidates.set(l.id, null);
      rows.push(`${l.id} [${t}]: ${l.text}`);
    }
  const system = [
    `You voice ${ctx.me.replace(/_/g, " ")}, a resident of FIRSTLIGHT, a multiplayer open-world game. People talk to you through a fixed phrase wheel.`,
    "You never write your own words: answer only with JSON choosing one or two line ids from the list, in the order to say them.",
    'Format: {"say": [{"id": "<line id>", "place": "<a place from the list, only for lines with {place}>"}]}',
  ].join(" ");
  const self = ctx.obs.self;
  const user = [
    `You are on ${BODIES[self.body as BodyId]?.name ?? self.body}, level ${self.level}, ${self.zone === "safe" ? "in a safe zone" : "out in the wild"}.`,
    ctx.trigger.kind === "near" ? `${ctx.to.name} (a person, level ${level}) just walked up to you, ${Math.round(ctx.to.dist)} m away.` : `${ctx.to.name} (a person, level ${level}, ${Math.round(ctx.to.dist)} m away) said "${ctx.trigger.phrase}".`,
    places.length ? `Places you could point to: ${places.map((p) => `${p.place} (${p.dist} m ${p.dir})`).join("; ")}.` : "No places to point to.",
    "Lines:",
    ...rows,
  ].join("\n");
  return { system, user, candidates };
}

/** The answer's length cap (`max_tokens`): a line id or two in JSON. */
const MAX_ANSWER_TOKENS = 80;

/** A prompt's tokens by its characters: about four to a token in English; three, to be safe. */
const promptTokens = (p: { system: string; user: string }, perToken = 4) => Math.ceil((p.system.length + p.user.length) / perToken);

/**
 * What a call may cost at most, reserved against the hourly budget before it is made: the prompt
 * counted generously plus the whole answer cap. Reconciled to what it really used afterwards.
 */
export function tokenReserve(p: { system: string; user: string }): number {
  return promptTokens(p, 3) + MAX_ANSWER_TOKENS;
}

/** The model brain: chooses among the authored lines; the scripted brain answers whenever it can't. */
export function modelBrain(o: ModelBrainOptions, fallback: Brain = scriptedBrain()): Brain & { stats: ModelStats } {
  const stats: ModelStats = { calls: 0, tokensIn: 0, tokensOut: 0, fallbacks: 0 };
  /**
   * The rolling hour's calls, each holding its tokens: a reservation (taken synchronously, before the
   * fetch, so concurrent conversations see each other's) until the call reports what it used.
   */
  const spent: { at: number; tokens: number }[] = [];
  let lastCall = 0;
  const doFetch = o.fetch ?? fetch;
  const fall = async (ctx: TalkContext, why: string) => {
    stats.fallbacks++;
    stats.lastFallback = why;
    return fallback.answer(ctx);
  };
  return {
    kind: "model",
    stats,
    async answer(ctx) {
      const now = Date.now();
      while (spent.length && now - spent[0]!.at > 3_600_000) spent.shift();
      const p = modelPrompt(ctx);
      const tokens = spent.reduce((n, s) => n + s.tokens, 0);
      // Check and reserve with no await between them: the budget holds for calls in flight too.
      const held = { at: now, tokens: tokenReserve(p) };
      if (spent.length + 1 > o.callsPerHour || tokens + held.tokens > o.tokensPerHour) return fall(ctx, "budget");
      if (now - lastCall < o.minGapMs) return fall(ctx, "cadence");
      lastCall = now;
      spent.push(held);
      const base = o.url.replace(/\/+$/, "");
      let text = "";
      let used = { in: 0, out: 0 };
      try {
        const res =
          o.api === "anthropic"
            ? await doFetch(`${base}/v1/messages`, {
                method: "POST",
                headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", ...(o.key ? { "x-api-key": o.key } : {}) },
                body: JSON.stringify({ model: o.model, max_tokens: MAX_ANSWER_TOKENS, system: p.system, messages: [{ role: "user", content: p.user }] }),
                signal: AbortSignal.timeout(o.timeoutMs ?? 8000),
              })
            : await doFetch(`${base}/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json", ...(o.key ? { authorization: `Bearer ${o.key}` } : {}) },
                body: JSON.stringify({ model: o.model, max_tokens: MAX_ANSWER_TOKENS, temperature: 0.8, messages: [{ role: "system", content: p.system }, { role: "user", content: p.user }] }),
                signal: AbortSignal.timeout(o.timeoutMs ?? 8000),
              });
        stats.calls++;
        if (!res.ok) {
          held.tokens = promptTokens(p);
          return fall(ctx, `http ${res.status}`);
        }
        const body = (await res.json()) as any;
        if (o.api === "anthropic") {
          text = String(body?.content?.find?.((c: any) => c?.type === "text")?.text ?? "");
          used = { in: Number(body?.usage?.input_tokens) || 0, out: Number(body?.usage?.output_tokens) || 0 };
        } else {
          text = String(body?.choices?.[0]?.message?.content ?? "");
          used = { in: Number(body?.usage?.prompt_tokens) || 0, out: Number(body?.usage?.completion_tokens) || 0 };
        }
      } catch (e) {
        stats.calls++;
        held.tokens = promptTokens(p);
        return fall(ctx, (e as Error).name === "TimeoutError" ? "timeout" : "network");
      }
      // Without a usage report, count the characters (about four to a token).
      if (!used.in) used.in = promptTokens(p);
      if (!used.out) used.out = Math.ceil(text.length / 4);
      stats.tokensIn += used.in;
      stats.tokensOut += used.out;
      // Reconcile: the call holds what it really used (an endpoint that ignored max_tokens is
      // counted in full, so the next calls see it).
      held.tokens = used.in + used.out;
      const says = parseAnswer(text, p.candidates, placesFor(ctx.obs, ctx.to.level));
      return says.length ? says : fall(ctx, "bad answer");
    },
  };
}

/** The model's JSON (possibly wrapped in prose or a code fence) as checked lines; [] when nothing fits. */
export function parseAnswer(text: string, candidates: ReadonlyMap<string, unknown>, places: readonly { place: string; dist: number; dir: string }[]): Say[] {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return [];
  let j: any;
  try {
    j = JSON.parse(m[0]);
  } catch {
    return [];
  }
  const list = Array.isArray(j?.say) ? j.say : [];
  const out: Say[] = [];
  for (const x of list.slice(0, 2)) {
    const id = typeof x === "string" ? x : x?.id;
    if (typeof id !== "string" || !candidates.has(id)) continue;
    const line = LINE_BY_ID.get(id)!;
    if (line.text.includes("{place}")) {
      const p = places.find((q) => q.place === x?.place) ?? places[0];
      if (!p) continue;
      out.push({ line: id, ...p });
    } else out.push({ line: id });
  }
  return out;
}

/** The brain the environment asks for: FL_RESIDENT_BRAIN=model with FL_RESIDENT_API/_URL/_MODEL/_KEY; else scripted. */
export function brainFromEnv(env: Record<string, string | undefined> = process.env, rng?: () => number): Brain {
  const scripted = scriptedBrain(rng);
  if (env.FL_RESIDENT_BRAIN !== "model" || !env.FL_RESIDENT_URL || !env.FL_RESIDENT_MODEL) return scripted;
  return modelBrain(
    {
      api: env.FL_RESIDENT_API === "anthropic" ? "anthropic" : "openai",
      url: env.FL_RESIDENT_URL,
      model: env.FL_RESIDENT_MODEL,
      key: env.FL_RESIDENT_KEY,
      callsPerHour: Number(env.FL_RESIDENT_CALLS_PER_HOUR ?? 120) || 120,
      tokensPerHour: Number(env.FL_RESIDENT_TOKENS_PER_HOUR ?? 100_000) || 100_000,
      minGapMs: Number(env.FL_RESIDENT_GAP_S ?? 6) * 1000 || 6000,
    },
    scripted,
  );
}

// -------------------------------------------------------------------------------- the talk loop

/** Who has the floor with a person: the nearest resident answers, the rest stay quiet. Shared by a run. */
export class Floor {
  private held = new Map<string, { by: string; until: number }>();
  /** May `resident` speak to `person` now? Takes the floor for `ms` when it may. */
  take(person: string, resident: string, ms: number, now = Date.now()): boolean {
    // Holds that ran out are dropped: a long run meets many people, and each one only matters for seconds.
    if (this.held.size > 64) for (const [k, v] of this.held) if (v.until <= now) this.held.delete(k);
    const h = this.held.get(person);
    if (h && h.until > now && h.by !== resident) return false;
    this.held.set(person, { by: resident, until: now + ms });
    return true;
  }

  /** People the floor is held for (tests). */
  get size(): number {
    return this.held.size;
  }
}

export interface TalkOptions {
  agent: FirstlightAgent;
  voice: Voice;
  name: string;
  brain: Brain;
  floor: Floor;
  /** Count a line said (the resident's stats). */
  onLine?: (say: Say) => void;
  log?: (line: string) => void;
  /** Greet a person who comes this close (m), at most once every `greetAgainMs` each. */
  greetWithin?: number;
  greetAgainMs?: number;
  /** Answer phrases said this close (m). */
  hearWithin?: number;
  /** Between two lines of one answer. */
  gapMs?: number;
}

/** Start listening; returns the stop. People only: residents don't chat with other agents. */
export function startTalk(o: TalkOptions): () => void {
  const greetWithin = o.greetWithin ?? 6;
  const greetAgain = o.greetAgainMs ?? 5 * 60_000;
  const hearWithin = o.hearWithin ?? 15;
  const gap = o.gapMs ?? 2600;
  const greeted = new Map<string, number>();
  /** The server takes one line every 2 s from a speaker (residentSpeech.ts SPEECH_RULES). */
  let lastLine = 0;
  const LINE_GAP = 2200;
  let busy = false;
  let stopped = false;

  const person = (id: string): Person | undefined => {
    const p = o.agent.observe({ peek: true }).players.find((x) => x.id === id);
    return p && !p.agent && !p.dead ? p : undefined;
  };

  async function answer(to: Person, trigger: TalkContext["trigger"]): Promise<void> {
    if (busy || stopped || o.agent.status !== "playing") return;
    // The nearest resident speaks first: the others wait a little longer, then find the floor taken.
    busy = true;
    try {
      await new Promise((ok) => setTimeout(ok, 120 + to.dist * 25));
      if (stopped || !o.floor.take(to.id, o.name, gap * 2 + 1500)) return;
      const obs = o.agent.observe({ peek: true });
      const says = await o.brain.answer({ voice: o.voice, me: o.name, trigger, to, obs });
      for (let i = 0; i < says.length && !stopped; i++) {
        if (i) await new Promise((ok) => setTimeout(ok, gap));
        const wait = lastLine + LINE_GAP - Date.now();
        if (wait > 0) await new Promise((ok) => setTimeout(ok, wait));
        if (!person(to.id)) break; // walked off, or gone
        const s = says[i]!;
        lastLine = Date.now();
        const r = await o.agent.speak(s.line, { to: to.id, ...(s.place ? { place: s.place, dist: s.dist, dir: s.dir } : {}) });
        if (r.ok) {
          o.onLine?.(s);
          o.log?.(`to ${to.name}: ${s.line}`);
        }
        o.floor.take(to.id, o.name, gap + 1500);
      }
    } finally {
      busy = false;
    }
  }

  const unhear = o.agent.onHeard((h: Heard) => {
    if (!h.phrase || !PHRASE_TOPIC[h.phrase]) return;
    const p = person(h.by);
    if (p && p.dist <= hearWithin) void answer(p, { kind: "phrase", phrase: h.phrase });
  });
  const watch = setInterval(() => {
    if (busy || o.agent.status !== "playing") return;
    const now = Date.now();
    // Who was greeted only matters for `greetAgain`: forget older ones, or a long run keeps everyone it met.
    if (greeted.size > 64) for (const [id, at] of greeted) if (now - at >= greetAgain) greeted.delete(id);
    for (const p of o.agent.observe({ peek: true }).players) {
      if (p.agent || p.dead || p.dist > greetWithin) continue;
      if (now - (greeted.get(p.id) ?? -Infinity) < greetAgain) continue;
      greeted.set(p.id, now);
      void answer(p, { kind: "near" });
      break;
    }
  }, 1000);
  watch.unref?.();
  return () => {
    stopped = true;
    unhear();
    clearInterval(watch);
  };
}
