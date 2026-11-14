// What residents say (#82, D-agents-talk-1). There is no text chat in FIRSTLIGHT (DECISIONS "No
// text chat"), so residents don't type: they speak authored lines by id. The server renders a line
// with slots it checks itself (who it is said to, a place from a fixed list, a distance and a
// compass direction) and shows it as a speech bubble. A resident's brain, scripted or a model, only
// chooses which line; no free text ever reaches a player.
//
// Slots: {you} the listener's name, {me} the speaker's, {place} one of RESIDENT_PLACES, {dist}
// metres (1-5000), {dir} one of COMPASS_WORDS. Lines stay under 140 characters.
//
// Voices: the first four of the resident cast speak in their own voice; the rest of the cast use
// their role's (tools/agent/residents.ts maps names to voices). Ids are stable: append, don't reuse.

import { BODIES, BODY_IDS } from "../planet/bodies.ts";
import { GUIDES } from "./missions.ts";
import { SHOP_SPOTS } from "./shops.ts";
import { GLEAMS } from "./gleams.ts";

export const LINE_TOPICS = ["greet", "doing", "where", "tip", "follow", "boss", "truce", "thanks", "gg"] as const;
export type LineTopic = (typeof LINE_TOPICS)[number];

export const VOICES = ["brindle", "tamsin", "marlo", "juniper"] as const;
export type Voice = (typeof VOICES)[number];

export interface ResidentLine {
  id: string;
  voice: Voice;
  topic: LineTopic;
  text: string;
  /** Tips: the listener levels it fits. */
  levels?: readonly [number, number];
}

export const COMPASS_WORDS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"] as const;

/** Places a line may name: worlds, portals, guides, the curator and her vault, shops, and plain words. */
export const RESIDENT_PLACES: readonly string[] = [
  ...BODY_IDS.map((b) => BODIES[b].name),
  ...BODY_IDS.filter((b) => b !== "portus").map((b) => `the portal to ${BODIES[b].name}`),
  "the portal home to Portus",
  ...BODY_IDS.filter((b) => b !== "portus").map((b) => GUIDES[b as Exclude<typeof b, "portus">].name),
  GLEAMS.curator.name,
  "the Gleam Vault",
  ...SHOP_SPOTS.map((s) => s.name),
  "the shop",
  "the guide",
  "the gate",
  "the nearest pad",
  "safety",
];
const PLACES: ReadonlySet<string> = new Set(RESIDENT_PLACES);

const L = (voice: Voice, topic: LineTopic, lines: readonly (string | readonly [string, number, number])[]): ResidentLine[] =>
  lines.map((x, i) => (typeof x === "string" ? { id: `${voice}.${topic}.${i + 1}`, voice, topic, text: x } : { id: `${voice}.${topic}.${i + 1}`, voice, topic, text: x[0], levels: [x[1], x[2]] as const }));

export const RESIDENT_LINES: readonly ResidentLine[] = [
  // Brindle Oake: a hunter on Arcadia. Gruff, practical, keeps a tally, holds a grudge against Hopbits.
  ...L("brindle", "greet", [
    "{you}. {me}. I'd shake your hand, but mine's busy holding a grudge against Hopbits.",
    "Mind the grass, {you}. Things in it bite, and the ones that don't are worse.",
  ]),
  ...L("brindle", "doing", [
    "Hunting. Forty-one Hopbits this week. They hop, I don't. That's the whole strategy.",
    "I keep a tally of every Hopbit I've cut down. I think the tally keeps one of me.",
  ]),
  ...L("brindle", "where", [
    "{place}? {dist} metres {dir}. Walk, don't wander. Wandering is how you meet a Pixel Lancer.",
    "{place} is {dist} metres {dir}. Straight there. The scenic route has teeth.",
  ]),
  ...L("brindle", "tip", [
    ["Fresh off the pad? Clover Fields. Hopbits only. Swing when they land, not when they jump.", 1, 3],
    ["Take Lark's hunts before you leave the outpost. Kills you'd make anyway, but paid.", 1, 3],
    ["Sparkflies shoot from range. Close the gap or break line of sight. Standing still is a donation.", 4, 7],
    ["A Linewyrm charges in a straight line. So don't be on the line. That's it. That's the advice.", 4, 7],
    ["You've outgrown Arcadia, friend. Hollowmere's where your level lives. Bring tonics. Then two more.", 8, 12],
    ["Bone Archers lob their arrows. Keep moving sideways and they mostly hit the scenery.", 8, 12],
    ["Meridian's salt flats: no cover, sharp folk in suits. I don't go. I've a Hopbit grudge to keep.", 13, 40],
  ]),
  ...L("brindle", "follow", ["Lead on. But if you're walking me into a Cabinet Golem, I'm walking straight back out."]),
  ...L("brindle", "boss", ["A boss? I'll watch from a respectful distance. Respect is measured in metres."]),
  ...L("brindle", "truce", ["Truce? I've never fought you. But fine. Truce. Signed in Hopbit blood. Not mine."]),
  ...L("brindle", "thanks", ["Don't thank me, thank the sword. It does the heavy part."]),
  ...L("brindle", "gg", ["Good game. Now drink a tonic, {you}. You look like a Hopbit sat on you."]),

  // Tamsin Hollis: a wanderer. A dreamy cartographer who maps every pad and collects views.
  ...L("tamsin", "greet", [
    "Oh, hello {you}! Stand still a moment, you're improving the view.",
    "{you}! Perfect timing. I need someone in the corner of this sketch for scale.",
  ]),
  ...L("tamsin", "doing", [
    "I'm mapping every pad on every planet. Slowly. The planets keep being round.",
    "Walking. Looking. Writing down where the light lands. Someone has to.",
  ]),
  ...L("tamsin", "where", [
    "{place} is {dist} metres {dir}. Past the pretty bit, before the bit that bites.",
    "Head {dir} for about {dist} metres. You'll know {place} when you see it. Most people do.",
  ]),
  ...L("tamsin", "tip", [
    ["Every pad you touch is a pad you can travel back to. Step on them all; future you will be smug.", 1, 3],
    ["The portal to Arcadia is the gentle one. Start there. The others have opinions.", 1, 3],
    ["Highscore Hill on Arcadia has a ring race. Run it at dusk. You'll lose, but beautifully.", 4, 7],
    ["Hollowmere is fog and bones and lanterns. Go when you can take a hit, and bring a light heart.", 8, 12],
    ["Meridian is flat, white and full of paperwork with teeth. Glasswing Ward first, sightseeing second.", 13, 40],
  ]),
  ...L("tamsin", "follow", ["Lead the way! I'll be three steps behind, drawing your silhouette."]),
  ...L("tamsin", "boss", ["A boss? Describe it. No, wait, I'll describe it. From up that hill. Far up that hill."]),
  ...L("tamsin", "truce", ["I'm a cartographer, {you}. My weapon is a staff and a strongly worded footnote."]),
  ...L("tamsin", "thanks", ["You're welcome! You're on page forty now, the one with the good margins."]),
  ...L("tamsin", "gg", ["GG! I'll mark it on the map: 'here, something went well'."]),

  // Marlo Thistle: a trader. An upbeat salesman of things he doesn't own; preaches tonics.
  ...L("marlo", "greet", [
    "{you}! My favourite customer. Don't check whether I say that to everyone.",
    "Step right up, {you}. Nothing for sale, but the browsing is free and the advice is cheaper.",
  ]),
  ...L("marlo", "doing", [
    "Minding the shop. Not my shop. Nobody's said I can't, which is basically a lease.",
    "Market research. I stand by the till and nod at people. Business is mostly nodding.",
  ]),
  ...L("marlo", "where", [
    "{place}? {dist} metres {dir}. Tell them Marlo sent you. They won't know who that is. Say it anyway.",
    "{dist} metres {dir}, that's {place}. Directions are free. Gratitude is ten coins.",
  ]),
  ...L("marlo", "tip", [
    ["Tonics. Ten coins, forty health. Best deal on four worlds, and I'm not even on commission.", 1, 3],
    ["Sell what you don't use. A spare weapon in the backpack is just a heavy opinion.", 1, 3],
    ["Keep three tonics on the hotbar. Two is optimism. One is a eulogy.", 4, 7],
    ["Tier two weapons unlock at level six. Still swinging tier one past that? I'm judging you.", 6, 12],
    ["Tier three at level twelve. Expensive, yes. So is starting over at level one.", 12, 40],
  ]),
  ...L("marlo", "follow", ["I'd love to, but if I leave the till someone might buy something without my help."]),
  ...L("marlo", "boss", ["Bosses drop the good stuff, I'm told. By people who were braver and are now richer."]),
  ...L("marlo", "truce", ["Truce! I never fight customers. Or anyone. I'm a carbine-shaped pacifist."]),
  ...L("marlo", "thanks", ["Pleasure doing business. There was no business. Still a pleasure."]),
  ...L("marlo", "gg", ["GG. Spend the winnings here. 'Here' meaning near me, so I can watch."]),

  // Juniper Fenn: a hunt-chaser. Fast, competitive, talks in short bursts about the Three Gleams.
  ...L("juniper", "greet", [
    "{you}! Can't stop. Well. Can stop. Briefly. Hi.",
    "Hey {you}. Racing? You look like you're racing. Everyone should be racing.",
  ]),
  ...L("juniper", "doing", [
    "Three Gleams. Three planets. One of me. I'm ahead of schedule. I don't have a schedule.",
    "Training for the Swift Gleam. Eight rings. My record's good. My other record's better.",
  ]),
  ...L("juniper", "where", [
    "{place}: {dist} metres {dir}. Sprint it. Walking is just slow running.",
    "{dir}, {dist} metres, {place}. Go go go.",
  ]),
  ...L("juniper", "tip", [
    ["Too early for the Gleams. Get to level four on Arcadia, then find Sela Marchbank. Bring legs.", 1, 3],
    ["The Swift Gleam: ring one starts the clock. Don't touch it until you've caught your breath.", 4, 7],
    ["Sela Marchbank gives the trials. She stands by the Vault in Portus, looking unimpressed. Impress her.", 4, 7],
    ["The Steadfast Gleam is a beacon on Hollowmere. Light it, stay in the ring, don't panic. Mostly don't panic.", 8, 12],
    ["The Patient Gleam: shards on Meridian's salt flats, four minutes. Patient my foot. Run.", 13, 40],
  ]),
  ...L("juniper", "follow", ["Follow you? You'll have to keep up with me first. Kidding. Go on."]),
  ...L("juniper", "boss", ["Boss? Need a hand or a witness? I'm a great witness. Very fast exits."]),
  ...L("juniper", "truce", ["Truce. I don't fight players. Bad for my split times."]),
  ...L("juniper", "thanks", ["Anytime. Literally any time, I'm always running past."]),
  ...L("juniper", "gg", ["GG! Rematch? There was no match? Rematch anyway."]),
];

export const LINE_BY_ID: ReadonlyMap<string, ResidentLine> = new Map(RESIDENT_LINES.map((l) => [l.id, l]));

/** A resident role's voice, for the cast past the first four (tools/agent/resident-roles.ts roles). */
export const ROLE_VOICE: Readonly<Record<string, Voice>> = { hunter: "brindle", wanderer: "tamsin", trader: "marlo", chaser: "juniper" };

export interface LineSlots {
  you?: string;
  me?: string;
  place?: string;
  dist?: number;
  dir?: string;
}

/** Display names in a line read better without the underscores ("Tamsin_Hollis" → "Tamsin Hollis"). */
const spoken = (name: string) => name.replace(/_/g, " ");

/**
 * The line with its slots filled, or null when a slot it uses is missing or not allowed (a place
 * not in RESIDENT_PLACES, a distance out of range, an unknown direction). Names come from the server.
 */
export function renderLine(line: ResidentLine, slots: LineSlots): string | null {
  let bad = false;
  const text = line.text.replace(/\{(you|me|place|dist|dir)\}/g, (_m, k: keyof LineSlots) => {
    const v = slots[k];
    if (k === "dist") {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 5000) bad = true;
      return String(v);
    }
    if (typeof v !== "string" || !v) {
      bad = true;
      return "";
    }
    if (k === "place" && !PLACES.has(v)) bad = true;
    if (k === "dir" && !(COMPASS_WORDS as readonly string[]).includes(v)) bad = true;
    return k === "you" || k === "me" ? spoken(v) : v;
  });
  return bad ? null : text.charAt(0).toUpperCase() + text.slice(1);
}

/** The compass word for a bearing in degrees (0 north, 90 east). */
export function compassWord(bearing: number): (typeof COMPASS_WORDS)[number] {
  return COMPASS_WORDS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8]!;
}

/** The lines a voice has on a topic; tips only those that fit the listener's level (any tip when none does). */
export function linesFor(voice: Voice, topic: LineTopic, level = 1): ResidentLine[] {
  const all = RESIDENT_LINES.filter((l) => l.voice === voice && l.topic === topic);
  if (topic !== "tip") return all;
  const fit = all.filter((l) => !l.levels || (level >= l.levels[0] && level <= l.levels[1]));
  return fit.length ? fit : all;
}
