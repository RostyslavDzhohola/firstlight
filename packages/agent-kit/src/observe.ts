// The observation an agent gets: the world around its character as a compact JSON object, and the
// same thing as a few lines of text sized for a language model's context (well under 2 KB).
//
// Distances are metres along the ground; bearings are compass degrees (0 = north, 90 = east), the
// same frame `moveTo({ bearing, distance })` takes. Ids are what the actions take.

import { compass } from "./vec.ts";

export interface ObservedItem {
  slot: number;
  id: string;
  name: string;
  tier: number;
  qty: number;
  /** Rounds left in the magazine (guns). */
  mag?: number;
}

export interface ObservedSelf {
  id: string;
  name: string;
  /** Always true: this character is flagged as an AI agent for everyone. */
  agent: boolean;
  body: string;
  /** Feet position in the body's frame (metres from its centre): for `moveTo({ pos })`. */
  pos: [number, number, number];
  /** Compass bearing the character faces. */
  heading: number;
  hp: number;
  maxHp: number;
  level: number;
  xp: number;
  xpToNext: number;
  coins: number;
  /** "safe": nobody can hurt you and you can't attack. "danger": everything else. */
  zone: "safe" | "danger";
  /** Which kind of ground: town, outpost, pad (their safe zones) or wild. */
  zoneKind: string;
  dead: boolean;
  swimming: boolean;
  inCombat: boolean;
  /** Seconds of arrival protection left (no damage either way). */
  protectedFor: number;
  weapon: { id: string; name: string; slot: number; kind: "melee" | "ranged" | "none"; range: number; mag?: number; magSize?: number };
  hotbar: ObservedItem[];
  backpack: ObservedItem[];
  /** Milliseconds until each is ready again (0 = ready). */
  cooldowns: { attack: number; reload: number; overheat: number; dodge: number; tonic: number };
  /** The starter and its own pace: run and sprint speed (m/s) and seconds between rolls. */
  starter: string;
  speed: { run: number; sprint: number; dodgeCooldown: number };
  /** The spellbook: aether and the four spells (cast them with `cast`). */
  spells: ObservedSpells;
}

export interface ObservedSpell {
  id: string;
  name: string;
  /** Character level that unlocks it. */
  level: number;
  /** Aether a cast costs. */
  cost: number;
  /** Seconds between casts. */
  cooldown: number;
  unlocked: boolean;
  /** Milliseconds until its cooldown is over (0 = over). */
  readyIn: number;
  /** Unlocked, off cooldown and enough aether: a cast would be accepted outside a safe zone. */
  ready: boolean;
  what: string;
}

export interface ObservedSpells {
  /** Aether now, of `max`; it refills 6 a second, starting 1.5 s after a cast. */
  aether: number;
  max: number;
  /** A Glasswing Ward that is up: shell HP left and seconds left. */
  ward?: { hp: number; left: number };
  list: ObservedSpell[];
}

export interface ObservedCreature {
  id: string;
  kind: string;
  name: string;
  level: number;
  hp: number;
  maxHp: number;
  dist: number;
  bearing: number;
  /** Attacks on sight (or is already after someone). */
  hostile: boolean;
  boss: boolean;
  /** It is attacking you right now. */
  onMe: boolean;
  /** A kill would count for one of your hunt missions. */
  mission: boolean;
  /** Another player is fighting it (hit it in the last seconds, or it is chasing them): leave it to them. */
  claimedBy?: { name: string; agent: boolean };
}

export interface ObservedPlayer {
  id: string;
  name: string;
  level: number;
  dist: number;
  bearing: number;
  /** An AI agent (true) or a person (false). */
  agent: boolean;
  dead: boolean;
}

export interface ObservedPlace {
  id: string;
  name: string;
  dist: number;
  bearing: number;
}

export interface ObservedMission {
  id: string;
  name: string;
  /** hunt, find, reach, race (rings in order against a clock), defend (hold a beacon's ring), collect (walk over every piece). */
  type: string;
  objective: string;
  progress: number;
  goal: number;
  done: boolean;
  /** Where it sends you on this body, if it does: for a race the next ring, for a collect the nearest piece left. */
  where?: { dist: number; bearing: number; what: string; id?: string };
  /** The body it is played on, when that isn't this one. */
  on?: string;
  /** race, defend, collect: the attempt. */
  trial?: ObservedTrial;
}

export interface ObservedTrial {
  /** "idle" (not started), "running", "paused" (outside a beacon's ring), "failed" (start again). */
  state: string;
  /** Seconds left on the clock (a race, a timed collect, the hold of a defend); absent = no clock running. */
  left?: number;
  /** The whole clock in seconds (0 = untimed). */
  limit: number;
  /** collect: pieces still to gather. defend: seconds still to hold. race: rings still to pass. */
  remaining: number;
  /** How to go on from here, in a few words. */
  next: string;
  /** Why the last attempt failed ("time", "died", "left"). */
  failed?: string;
}

export interface ObservedEvent {
  /** Seconds ago. */
  ago: number;
  type: string;
  text: string;
}

export interface Observation {
  /** "playing", "dead", "reconnecting", "offline". */
  status: string;
  self: ObservedSelf;
  creatures: ObservedCreature[];
  players: ObservedPlayer[];
  /** Loot on the ground (walk within 3 m and interact()). */
  piles: (ObservedPlace & { coins: number; items: number; yours: boolean })[];
  /** Fast-travel pads, nearest first; `known` ones can be travelled to from any pad. */
  pads: (ObservedPlace & { known: boolean })[];
  portals: (ObservedPlace & { to: string })[];
  /** The mission giver of this body (planets only). */
  guide: ObservedPlace | null;
  shops: (ObservedPlace & { inReach: boolean })[];
  /** Way into the nearest safe zone. */
  safety: ObservedPlace | null;
  missions: ObservedMission[];
  /** Missions a giver on this body still has for you: the planet's guide, or Sela Marchbank in Portus (the trials). */
  offers: { id: string; name: string; type: string; objective: string; levels: string; from: string }[];
  /** The Three Gleams (the public hunt): trials won this life, and in Portus where Sela and the vault are. */
  hunt: { name: string; gleams: number; of: number; vaultOpened: boolean; curator?: ObservedPlace; vault?: ObservedPlace };
  /** What happened since your last observation (damage, kills, deaths, toasts, refusals). */
  events: ObservedEvent[];
  /** The same as a few lines of text. */
  summary: string;
}

const where = (dist: number, bearing: number) => `${Math.round(dist)} m ${compass(bearing)} (${bearing}°)`;

/**
 * The text summary of an observation: who and where you are, what is near, what to do next. Over
 * `maxBytes` the least urgent lines go first (offers, places, loot, players, old events), and the
 * ones a decision hangs on stay: you, your weapon, what is attacking, a trial with a clock running.
 */
export function summarize(o: Omit<Observation, "summary">, maxBytes = 1500): string {
  const s = o.self;
  /** [how much it matters, the line]; printed in the order added. */
  const lines: [number, string][] = [];
  const w = s.weapon;
  const mag = w.mag !== undefined && w.magSize ? ` ${w.mag}/${w.magSize}` : "";
  lines.push([
    100,
    `${s.name} [AI] L${s.level} on ${s.body}: HP ${s.hp}/${s.maxHp}, XP ${s.xp}/${s.xpToNext}, ${s.coins} coins. ${s.dead ? "DEAD: call respawn." : `${s.zone === "safe" ? `SAFE zone (${s.zoneKind}): no fighting here` : `DANGER (${s.zoneKind})`}${s.swimming ? ", swimming" : ""}${s.inCombat ? ", in combat" : ""}${s.protectedFor > 0 ? `, protected ${s.protectedFor}s` : ""}.`}`,
  ]);
  const bag = s.hotbar.filter((i) => i.slot !== w.slot).map((i) => `${i.slot}:${i.name}${i.qty > 1 ? `x${i.qty}` : ""}`);
  lines.push([90, `Weapon ${w.name} (slot ${w.slot}, ${w.kind}, ${w.range} m${mag}). Facing ${compass(s.heading)}.${bag.length ? ` Hotbar ${bag.join(", ")}.` : ""}${s.backpack.length ? ` Backpack ${s.backpack.length} item(s).` : ""}`]);
  const sp = s.spells;
  const spell = (x: ObservedSpell) => `${x.id} ${!x.unlocked ? `L${x.level}` : x.readyIn > 0 ? `${Math.ceil(x.readyIn / 1000)}s` : x.ready ? "ready" : `needs ${x.cost}`}`;
  lines.push([70, `Aether ${Math.round(sp.aether)}/${sp.max}${sp.ward ? `, ward ${sp.ward.hp}hp ${Math.ceil(sp.ward.left)}s` : ""}. Spells: ${sp.list.map(spell).join(", ")}.`]);
  if (o.creatures.length) {
    const list = o.creatures.slice(0, 5).map((c) => `${c.id} ${c.name} L${c.level} ${c.hp}/${c.maxHp}hp ${where(c.dist, c.bearing)}${c.onMe ? " ATTACKING YOU" : c.hostile ? " hostile" : ""}${c.boss ? " BOSS" : ""}${c.mission ? " *mission" : ""}${c.claimedBy ? ` (${c.claimedBy.name}'s fight)` : ""}`);
    lines.push([80, `Creatures (${o.creatures.length}): ${list.join("; ")}.`]);
  } else lines.push([80, "No creatures in sight."]);
  if (o.players.length) lines.push([45, `Players: ${o.players.slice(0, 4).map((p) => `${p.name}${p.agent ? " [AI]" : ""} L${p.level} ${where(p.dist, p.bearing)}${p.dead ? " dead" : ""}`).join("; ")}.`]);
  if (o.piles.length) lines.push([40, `Loot: ${o.piles.slice(0, 3).map((p) => `${p.id} ${p.items} item(s) ${p.coins}c ${where(p.dist, p.bearing)}${p.yours ? " yours" : ""}`).join("; ")}.`]);
  const places: string[] = [];
  if (o.guide) places.push(`guide ${o.guide.name} ${where(o.guide.dist, o.guide.bearing)}`);
  if (o.hunt.curator) places.push(`curator ${o.hunt.curator.name} ${where(o.hunt.curator.dist, o.hunt.curator.bearing)}`);
  if (o.hunt.vault) places.push(`vault ${where(o.hunt.vault.dist, o.hunt.vault.bearing)}${o.hunt.vaultOpened ? " (opened)" : ` (${o.hunt.gleams}/${o.hunt.of} gleams)`}`);
  for (const sh of o.shops.slice(0, 1)) places.push(`shop ${sh.name} ${where(sh.dist, sh.bearing)}${sh.inReach ? " (in reach)" : ""}`);
  // Places carry the id a move takes (portal:arcadia, pad:3).
  for (const p of o.portals.slice(0, 3)) places.push(`${p.id} ${where(p.dist, p.bearing)}`);
  for (const p of o.pads.slice(0, 2)) places.push(`${p.id} ${p.name} ${where(p.dist, p.bearing)}${p.known ? "" : " (new)"}`);
  if (o.safety && s.zone !== "safe") places.push(`safety: ${o.safety.name} ${where(o.safety.dist, o.safety.bearing)}`);
  if (places.length) lines.push([35, `Places: ${places.join("; ")}.`]);
  const open = o.missions.filter((m) => !m.done);
  // Trials in full: type, state, time left, where next. One with a clock running goes first.
  const mission = (m: ObservedMission) => {
    const t = m.trial;
    const head = `${m.id} ${m.name} ${m.progress}/${m.goal}`;
    const at = m.where ? ` -> ${m.where.id ? `${m.where.id} ` : ""}${where(m.where.dist, m.where.bearing)}` : m.on ? ` -> on ${m.on} (portal:${m.on})` : "";
    if (!t) return `${head}: ${m.objective}${at}`;
    return `${head} [${m.type} ${t.state}${t.left !== undefined ? ` ${Math.ceil(t.left)}s left` : ""}${t.failed ? `, last try failed: ${t.failed}` : ""}]: ${t.next}${at}`;
  };
  const live = (m: ObservedMission) => !!m.trial && m.trial.state !== "idle";
  const ordered = [...open.filter(live), ...open.filter((m) => !live(m))];
  if (ordered.length) lines.push([ordered.some(live) ? 85 : 50, `Missions: ${ordered.slice(0, 4).map(mission).join("; ")}.`]);
  if (o.offers.length) lines.push([20, `${o.offers[0]!.from} offers: ${o.offers.map((m) => `${m.id} ${m.name} (${m.type}, L${m.levels})`).join(", ")}.`]);
  const events = (n: number) => `Events: ${o.events.slice(-n).map((e) => `${e.text}${e.ago >= 2 ? ` (${Math.round(e.ago)}s ago)` : ""}`).join("; ")}.`;
  if (o.events.length) lines.push([60, events(6)]);
  const join = () => lines.map((l) => l[1]).join("\n");
  let text = join();
  // Too long: fewer events first, then whole lines from the least urgent up.
  const ev = lines.findIndex((l) => l[1].startsWith("Events: "));
  if (Buffer.byteLength(text) > maxBytes && ev >= 0 && o.events.length > 3) {
    lines[ev]![1] = events(3);
    text = join();
  }
  while (Buffer.byteLength(text) > maxBytes && lines.length > 2) {
    let least = lines.length - 1;
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i]![0] < lines[least]![0]) least = i;
    lines.splice(least, 1);
    text = join();
  }
  // Still too long (a tiny budget): cut by bytes, never through a character.
  while (Buffer.byteLength(text) > maxBytes) text = `${text.slice(0, Math.max(0, Math.min(text.length - 2, maxBytes - 4)))}…`;
  return text;
}
