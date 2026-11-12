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
  objective: string;
  progress: number;
  goal: number;
  done: boolean;
  /** Where it sends you on this body, if it does. */
  where?: { dist: number; bearing: number; what: string };
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
  /** Missions the guide here still has for you. */
  offers: { id: string; name: string; objective: string; levels: string }[];
  /** What happened since your last observation (damage, kills, deaths, toasts, refusals). */
  events: ObservedEvent[];
  /** The same as a few lines of text. */
  summary: string;
}

const where = (dist: number, bearing: number) => `${Math.round(dist)} m ${compass(bearing)} (${bearing}°)`;

/** The text summary of an observation: who and where you are, what is near, what to do next. */
export function summarize(o: Omit<Observation, "summary">, maxBytes = 1500): string {
  const s = o.self;
  const lines: string[] = [];
  const w = s.weapon;
  const mag = w.mag !== undefined && w.magSize ? ` ${w.mag}/${w.magSize}` : "";
  lines.push(
    `${s.name} [AI] L${s.level} on ${s.body}: HP ${s.hp}/${s.maxHp}, XP ${s.xp}/${s.xpToNext}, ${s.coins} coins. ${s.dead ? "DEAD: call respawn." : `${s.zone === "safe" ? `SAFE zone (${s.zoneKind}): no fighting here` : `DANGER (${s.zoneKind})`}${s.swimming ? ", swimming" : ""}${s.inCombat ? ", in combat" : ""}${s.protectedFor > 0 ? `, protected ${s.protectedFor}s` : ""}.`}`,
  );
  const bag = s.hotbar.filter((i) => i.slot !== w.slot).map((i) => `${i.slot}:${i.name}${i.qty > 1 ? `x${i.qty}` : ""}`);
  lines.push(`Weapon ${w.name} (slot ${w.slot}, ${w.kind}, ${w.range} m${mag}). Facing ${compass(s.heading)}.${bag.length ? ` Hotbar ${bag.join(", ")}.` : ""}${s.backpack.length ? ` Backpack ${s.backpack.length} item(s).` : ""}`);
  if (o.creatures.length) {
    const list = o.creatures.slice(0, 5).map((c) => `${c.id} ${c.name} L${c.level} ${c.hp}/${c.maxHp}hp ${where(c.dist, c.bearing)}${c.onMe ? " ATTACKING YOU" : c.hostile ? " hostile" : ""}${c.boss ? " BOSS" : ""}${c.mission ? " *mission" : ""}`);
    lines.push(`Creatures (${o.creatures.length}): ${list.join("; ")}.`);
  } else lines.push("No creatures in sight.");
  if (o.players.length) lines.push(`Players: ${o.players.slice(0, 4).map((p) => `${p.name}${p.agent ? " [AI]" : ""} L${p.level} ${where(p.dist, p.bearing)}${p.dead ? " dead" : ""}`).join("; ")}.`);
  if (o.piles.length) lines.push(`Loot: ${o.piles.slice(0, 3).map((p) => `${p.id} ${p.items} item(s) ${p.coins}c ${where(p.dist, p.bearing)}${p.yours ? " yours" : ""}`).join("; ")}.`);
  const places: string[] = [];
  if (o.guide) places.push(`guide ${o.guide.name} ${where(o.guide.dist, o.guide.bearing)}`);
  for (const sh of o.shops.slice(0, 1)) places.push(`shop ${sh.name} ${where(sh.dist, sh.bearing)}${sh.inReach ? " (in reach)" : ""}`);
  for (const p of o.portals.slice(0, 3)) places.push(`portal to ${p.to} ${where(p.dist, p.bearing)}`);
  for (const p of o.pads.slice(0, 2)) places.push(`pad ${p.id} ${p.name} ${where(p.dist, p.bearing)}${p.known ? "" : " (new)"}`);
  if (o.safety && s.zone !== "safe") places.push(`safety: ${o.safety.name} ${where(o.safety.dist, o.safety.bearing)}`);
  if (places.length) lines.push(`Places: ${places.join("; ")}.`);
  const open = o.missions.filter((m) => !m.done);
  if (open.length) lines.push(`Missions: ${open.slice(0, 3).map((m) => `${m.id} ${m.name} ${m.progress}/${m.goal}: ${m.objective}${m.where ? ` -> ${where(m.where.dist, m.where.bearing)}` : ""}`).join("; ")}.`);
  if (o.offers.length) lines.push(`The guide offers: ${o.offers.map((m) => `${m.id} ${m.name} (L${m.levels})`).join(", ")}.`);
  if (o.events.length) lines.push(`Events: ${o.events.slice(-6).map((e) => `${e.text}${e.ago >= 2 ? ` (${Math.round(e.ago)}s ago)` : ""}`).join("; ")}.`);
  // Hold the size: drop lines from the least urgent end (events first stay; places and offers go).
  let text = lines.join("\n");
  while (Buffer.byteLength(text) > maxBytes && lines.length > 3) {
    lines.splice(lines.length - 2, 1);
    text = lines.join("\n");
  }
  return Buffer.byteLength(text) > maxBytes ? `${text.slice(0, maxBytes - 1)}…` : text;
}
