// What residents say (#82, D-agents-talk-1). There is no text chat in FIRSTLIGHT (DECISIONS "No
// text chat"), so residents don't type: they speak authored lines by id. The server renders a line
// with slots it checks itself (who it is said to, a place from a fixed list, a distance and a
// compass direction) and shows it as a speech bubble. A resident's brain, scripted or a model, only
// chooses which line; no free text ever reaches a player.
//
// Slots: {you} the listener's name, {me} the speaker's, {place} one of RESIDENT_PLACES, {dist}
// metres (1-5000), {dir} one of COMPASS_WORDS. Lines stay under 140 characters.
//
// Voices: each of the twelve residents of the cast speaks in its own voice while it plays its own
// role; a resident put in another role, and names past the cast, use the role's (ROLE_VOICE, the
// first four; tools/agent/residents.ts). Lines without slots are also spoken aloud (dialogue.ts
// SPOKEN_LINES, tools/voice). Ids are stable: append, don't reuse.

import { BODIES, BODY_IDS } from "../planet/bodies.ts";
import { GUIDES } from "./missions.ts";
import { SHOP_SPOTS } from "./shops.ts";
import { GLEAMS } from "./gleams.ts";

export const LINE_TOPICS = ["greet", "doing", "where", "tip", "follow", "boss", "truce", "thanks", "gg"] as const;
export type LineTopic = (typeof LINE_TOPICS)[number];

export const VOICES = ["brindle", "tamsin", "marlo", "juniper", "garnet", "hesper", "sable", "corbin", "wendell", "odessa", "ptolemy", "isla"] as const;
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
    "I'd shake your hand, but mine's busy holding a grudge against Hopbits.",
    "Mind the grass. Things in it bite, and the ones that don't are plotting.",
  ]),
  ...L("brindle", "doing", [
    "Hunting. Forty-one Hopbits this week. They hop, I don't. That's the whole strategy.",
    "I keep a tally of every Hopbit I've cut down. Lately I think the Hopbits keep one of me.",
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
  ...L("brindle", "truce", ["Truce? I've never fought you. But fine. Truce. I'll carve it on a Hopbit."]),
  ...L("brindle", "thanks", ["Don't thank me, thank the sword. It does the heavy part."]),
  ...L("brindle", "gg", ["Good game. Now drink a tonic. You look like a Hopbit sat on you."]),

  // Tamsin Hollis: a wanderer. A dreamy cartographer who maps every pad and collects views.
  ...L("tamsin", "greet", [
    "Oh, hello. Don't move. The light's doing something lovely on your left side.",
    "Perfect timing. I need someone in the corner of this sketch, for scale.",
  ]),
  ...L("tamsin", "doing", [
    "I'm mapping every pad on every planet. Slowly. The planets keep being round.",
    "Walking. Looking. Writing down where the light lands at four o'clock. Someone has to.",
  ]),
  ...L("tamsin", "where", [
    "{place} is {dist} metres {dir}. Past the pretty bit, before the bit that bites.",
    "Head {dir} for about {dist} metres. You'll know {place} when you see it. Most people do.",
  ]),
  ...L("tamsin", "tip", [
    ["Every pad you touch is a pad you can travel back to. Step on them all; future you will be smug.", 1, 3],
    ["The portal to Arcadia is the gentle one. Start there. The others have opinions.", 1, 3],
    ["Highscore Hill on Arcadia has a ring race. Run it at dusk. You'll lose, but beautifully.", 4, 7],
    ["Hollowmere is fog and bones and lanterns. Go when you can take three hits in a row and still be cheerful.", 8, 12],
    ["Meridian is flat, white and full of paperwork with teeth. Glasswing Ward first, sightseeing second.", 13, 40],
  ]),
  ...L("tamsin", "follow", ["Lead the way! I'll be three steps behind, drawing your silhouette."]),
  ...L("tamsin", "boss", ["A boss? Describe it. No, wait, I'll describe it. From up that hill. Far up that hill."]),
  ...L("tamsin", "truce", ["Truce, gladly. I'm a cartographer. My weapon is a staff and a strongly worded footnote."]),
  ...L("tamsin", "thanks", ["You're welcome! You're on page forty now, the one with the good margins."]),
  ...L("tamsin", "gg", ["GG! I'll mark it on the map: 'here, something went well'."]),

  // Marlo Thistle: a trader. An upbeat salesman of things he doesn't own; preaches tonics.
  ...L("marlo", "greet", [
    "My favourite customer! Don't check whether I say that to everyone.",
    "Step right up. Nothing for sale, but the browsing is free and the advice is cheaper.",
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
    "Can't stop. Well. Can stop. Briefly. Hi.",
    "Hey. Racing? You look like you're racing. Everyone should be racing.",
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
  ...L("juniper", "thanks", ["Any time. I mean that. I'll be running past again in about forty seconds."]),
  ...L("juniper", "gg", ["GG! Rematch? There was no match? Rematch anyway."]),

  // ------------------------------------------------------------------ 2026-11-13: the other eight get their own voices
  // Garnet Moss: a hunter. Methodical; treats culling like roof repair and reports in numbers.
  ...L("garnet", "greet", ["Hello. Hostile count in this area: low. Present company excepted, probably.", "Good to see a face. Most of what I meet out here is teeth."]),
  ...L("garnet", "doing", ["Culling. It's maintenance, really. Arcadia grows Hopbits the way a roof grows moss.", "Sharpening. Then hunting. Then sharpening. It's a good loop."]),
  ...L("garnet", "where", ["{place}: {dist} metres, bearing {dir}. Expected hazards: some.", "{dist} metres {dir} to {place}. I'd go round the long grass."]),
  ...L("garnet", "tip", [
    ["Hopbits telegraph. They crouch, then they jump. Hit the crouch.", 1, 3],
    ["A Cabinet Golem holds Blockyard Camp. Don't walk in at level five and call it bad luck.", 4, 7],
    ["Gnawers are fast and low. Watch the ground, not the horizon.", 8, 12],
    ["Enforcers carry shields. Break the shield first, or you're just polishing it.", 13, 40],
  ]),
  ...L("garnet", "follow", ["Following. I'll keep count of what we meet."]),
  ...L("garnet", "boss", ["Boss sighted. I'll log the time. Don't make me log anything else."]),
  ...L("garnet", "truce", ["Truce accepted. My blade's for things with more legs."]),
  ...L("garnet", "thanks", ["Noted. Appreciated. Filed under good days."]),
  ...L("garnet", "gg", ["Good game. Efficient, mostly. We'll work on the rest."]),

  // Hesper Dunn: a wanderer. A stargazer who travels to see the other worlds hang in the sky.
  ...L("hesper", "greet", ["Evening. Or it will be. I'm early for the stars.", "Oh, company. Look up. No, further. There. That's another world, just sitting there."]),
  ...L("hesper", "doing", ["Waiting for dark. Every world looks best from one of the others.", "Counting moons. It's a short count. I do it slowly to make it last."]),
  ...L("hesper", "where", ["{place}? {dist} metres {dir}. Look for the brightest thing in the sky, then ignore it and go {dir}.", "Go {dir}, {dist} metres. {place} will be there. Places are patient."]),
  ...L("hesper", "tip", [
    ["Step on every pad you find. Later you'll want to travel back without the walk.", 1, 3],
    ["There's a moon over Arcadia, and a portal by Dawnpad that goes there. Go when you're ready to fall slowly.", 4, 7],
    ["Hollowmere's fog hides Bone Archers until they've already loosed. Keep moving. Keep listening.", 8, 12],
    ["On Meridian's salt flats you can see for miles. So can everything else. Keep to the canyons when you can.", 13, 40],
  ]),
  ...L("hesper", "follow", ["I'll follow. Slowly. I stop for views."]),
  ...L("hesper", "boss", ["A boss. I'll be on the ridge, making a very small drawing of it."]),
  ...L("hesper", "truce", ["I've never fought anyone. I'd lose, and then I'd have to describe it."]),
  ...L("hesper", "thanks", ["You're kind. The sky thinks so too. Probably."]),
  ...L("hesper", "gg", ["Good game. That one goes in the night sky."]),

  // Sable Finch: a trader. An appraiser who prices everything, including you.
  ...L("sable", "greet", ["Nice boots. I'd give you six coins for them. Seven if you're still in them.", "Ah, a customer. Or a seller. Either way, a margin."]),
  ...L("sable", "doing", ["Appraising. That rock: two coins. That cloud: priceless, sadly unsellable.", "Waiting for a bargain to walk past. Bargains walk faster than you'd think."]),
  ...L("sable", "where", ["{place}, {dist} metres {dir}. Free advice. Worth every coin you paid.", "{dir}, {dist} metres, {place}. If they ask, I said you were good for credit."]),
  ...L("sable", "tip", [
    ["Sell what you've outgrown. A weapon you don't swing is just weight you paid for.", 1, 3],
    ["Die out there and your things stay out there in a pile. Carry less, or die less.", 4, 7],
    ["Tier two gear at level six. Buy one good weapon, not three tired ones.", 6, 12],
    ["Tier three at twelve. Save for it. Poor for an hour beats dead for one.", 12, 40],
  ]),
  ...L("sable", "follow", ["Follow you? What's the rate? Kidding. Mostly. Lead on."]),
  ...L("sable", "boss", ["Bosses drop good things. Bring me the good things. I'll pay nearly fair."]),
  ...L("sable", "truce", ["Truce. Fighting's bad for business. So is losing."]),
  ...L("sable", "thanks", ["No charge. This once. Write it down."]),
  ...L("sable", "gg", ["Good game. Want to sell the trophy? No? Keep it, then. It suits you."]),

  // Corbin Reed: a hunt-chaser. A nervous timekeeper, forever second to Juniper.
  ...L("corbin", "greet", ["Oh! Hi. Sorry. I was counting. Now I've lost count. It's fine.", "Hello. Don't mind the stopwatch. It doesn't mind you."]),
  ...L("corbin", "doing", ["Timing the ring road. Ninety-one seconds last try. Juniper calls that a nap.", "Practising the Swift Gleam. Second place, again. Second place is still a place."]),
  ...L("corbin", "where", ["{place} is {dist} metres {dir}. At a jog that's about... no, you'll be quicker. Everyone is.", "{dir}. {dist} metres. {place}. Good luck. Not that you need it."]),
  ...L("corbin", "tip", [
    ["Learn the dodge early. It's the only thing faster than a Hopbit's bad mood.", 1, 3],
    ["The Swift Gleam gives you seventy-five seconds from the first ring. I've used ninety. Don't be me.", 4, 7],
    ["The Steadfast Gleam's beacon wants ninety seconds. Step out of its ring too long and it's over.", 8, 12],
    ["On the salt flats, plan your shard route before you touch the first one. That's when the clock starts.", 13, 40],
  ]),
  ...L("corbin", "follow", ["Yes. Right behind you. Slightly behind you. That's my spot."]),
  ...L("corbin", "boss", ["A boss? I'll time it. Somebody should know how long the bad part lasted."]),
  ...L("corbin", "truce", ["Truce! Please. I'm already losing to everyone else."]),
  ...L("corbin", "thanks", ["Oh. Thanks back. Sorry. You're welcome. Both."]),
  ...L("corbin", "gg", ["GG. I'll add it to the list of things I nearly won."]),

  // Wendell Crane: a hunter. Old, slow, nostalgic, still better at it than you.
  ...L("wendell", "greet", ["Afternoon. Don't mind me. I'm remembering when all this was Hopbits.", "Another young one. Good. The fields need hunters whose knees still work."]),
  ...L("wendell", "doing", ["Hunting, slower than I used to. The Hopbits haven't noticed, which is insulting.", "Mending a bowstring. Forty years of bowstrings. They all break the same way."]),
  ...L("wendell", "where", ["{place}? {dist} metres {dir}. Used to be further. Or I used to be slower.", "{dist} metres {dir}, that's {place}. Take the path. Paths are there because somebody learned."]),
  ...L("wendell", "tip", [
    ["Don't chase a Hopbit that runs. It's running toward its friends.", 1, 3],
    ["Sparkflies keep their distance. Bring a weapon that reaches, or a great deal of patience.", 4, 7],
    ["Cantors sing the dead back up. Kill the singer first, then the choir.", 8, 12],
    ["The Bramblehorn and the Fenstalker leave you be until you're foolish. Don't be foolish.", 13, 40],
  ]),
  ...L("wendell", "follow", ["I'll come. Slowly. I'll catch up at the interesting part."]),
  ...L("wendell", "boss", ["I saw a boss once. Long time ago. Still not ready to talk about it."]),
  ...L("wendell", "truce", ["Truce. I'm too old to fight people. Creatures, I'm exactly the right age for."]),
  ...L("wendell", "thanks", ["Don't mention it. I'll mention it. Often. To everyone."]),
  ...L("wendell", "gg", ["Good game. Back in my day, that would have taken all afternoon."]),

  // Odessa Larch: a wanderer. A forager who presses leaves into a book and cooks with clover.
  ...L("odessa", "greet", ["Careful where you step. That's lunch. Not yours.", "Hello. Do you know what this flower's called? Neither do I. I'm naming it after you."]),
  ...L("odessa", "doing", ["Picking clover. Not for luck. For soup.", "Pressing leaves into a book. Every world has its own green. Hollowmere's is mostly grey."]),
  ...L("odessa", "where", ["{place}? {dist} metres {dir}. Mind the nettles on the way.", "{dist} metres {dir}, {place}. There's a nice patch of moss halfway, if you like moss."]),
  ...L("odessa", "tip", [
    ["Woolbacks won't hurt you. Leave them be. Things that won't hurt you are rare out here.", 1, 3],
    ["Pinewhistle Wood is quieter than the fields, but not safer. Quiet just means they're waiting.", 4, 7],
    ["Marsh Wisps in Whisper Fen break easily. One good hit. Just make it the first one.", 8, 12],
    ["Brinewater Lake is the only soft thing on Meridian. Even that bites.", 13, 40],
  ]),
  ...L("odessa", "follow", ["Lead on. I'll stop to look at plants, but I'll catch up."]),
  ...L("odessa", "boss", ["A boss. Everything that big was a seed once. Not helpful, I know."]),
  ...L("odessa", "truce", ["Of course, truce. I only fight weeds."]),
  ...L("odessa", "thanks", ["You're welcome. I'd give you a flower, but they're all asleep."]),
  ...L("odessa", "gg", ["Good game. That's going in the book, between the ferns."]),

  // Ptolemy Birch: a trader. A merchant prince in waiting, with one stall and a great many plans.
  ...L("ptolemy", "greet", ["Welcome, welcome, to the future site of the Birch Exchange.", "A visitor! Tell your grandchildren you met me before the empire."]),
  ...L("ptolemy", "doing", ["Planning an empire. Step one: a stall. Step two: a bigger stall.", "Doing the books. The books say I'm a visionary. I wrote the books."]),
  ...L("ptolemy", "where", ["{place} lies {dist} metres {dir}. Soon to be a Birch franchise.", "{dist} metres {dir} to {place}. Remember who told you. History will."]),
  ...L("ptolemy", "tip", [
    ["Never sell a tonic you might need. Tonics are cheap right up until they're priceless.", 1, 3],
    ["A guide gives three missions, and you can carry all three. Do them on one trip. That's called logistics.", 4, 7],
    ["Hollowmere pays better than Arcadia. Hollowmere also kills better than Arcadia. That's the market.", 8, 12],
    ["Meridian's missions pay in the hundreds. Oversight calls that a rounding error. I call it capital.", 13, 40],
  ]),
  ...L("ptolemy", "follow", ["A merchant prince leads. But I'll make an exception, as a gesture of goodwill."]),
  ...L("ptolemy", "boss", ["A boss. Excellent. Bring me whatever it drops and we'll discuss terms."]),
  ...L("ptolemy", "truce", ["Truce. War is bad for trade, and I am trade."]),
  ...L("ptolemy", "thanks", ["Gratitude accepted. I'll put it on your account."]),
  ...L("ptolemy", "gg", ["Good game. I've already sold the story twice."]),

  // Isla Thornby: a hunt-chaser. A gleam theorist who sees patterns, and Juniper's rival.
  ...L("isla", "greet", ["Hey. Have you noticed the gleams only shine for some people? I've noticed.", "You. Yes, you. Have you seen Juniper? Don't tell her you've seen me."]),
  ...L("isla", "doing", ["Mapping the gleam trials. There's a pattern. I'm nearly sure there's a pattern.", "Beating Juniper's time. On paper. In practice, still working on it."]),
  ...L("isla", "where", ["{place}. {dist} metres {dir}. Go now, before somebody else does.", "{dir}, {dist} metres, {place}. Tell nobody I told you."]),
  ...L("isla", "tip", [
    ["Get to level four before the gleams. Sela won't stop you trying. The rings will.", 1, 3],
    ["Swift Gleam: eight rings. Learn the order on a slow lap, then run it for real.", 4, 7],
    ["Steadfast Gleam: Bonewalkers, Gnawers, Bonewalkers, then three Gnawers. Save something for the last wave.", 8, 12],
    ["Patient Gleam: eight shards, four minutes, open salt. The patrols notice runners. Run anyway.", 13, 40],
  ]),
  ...L("isla", "follow", ["Following. Quietly. Juniper can't know about this alliance."]),
  ...L("isla", "boss", ["Boss fight? I'll watch its patterns. Everything has patterns."]),
  ...L("isla", "truce", ["Truce. I'm saving my energy for Juniper."]),
  ...L("isla", "thanks", ["Thanks. You didn't see me. Thanks again."]),
  ...L("isla", "gg", ["GG. Not my best. Better than Juniper's, though."]),
];

export const LINE_BY_ID: ReadonlyMap<string, ResidentLine> = new Map(RESIDENT_LINES.map((l) => [l.id, l]));

/** A role's voice, for a resident playing a role not its own and names past the cast (tools/agent/resident-roles.ts roles). */
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
