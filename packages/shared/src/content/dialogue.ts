// What the named characters say (2026-11-13, voice lane): the guides, Sela Marchbank, the four
// shopkeepers and the bosses. There is no text chat (DECISIONS "No text chat"): every word a
// character says is an authored line with a stable id, shown as a subtitle and spoken from a
// recorded file made from exactly this text (tools/voice). Ids are stable: append, don't reuse.
//
// Kinds: `greet` when you open their panel, `farewell` when you close it, `idle` when you walk past
// without stopping. Mission offers are the missions' `pitch` (missions.ts), Sela's progress lines
// are GLEAMS.lines (gleams.ts) and boss lines are BOSS_DEFS[].voice (npcs.ts); SPOKEN_LINES below
// gathers all of them, with the residents' slot-free lines, into the one list the voice tool reads.

import { BOSS_DEFS } from "./npcs.ts";
import { GLEAMS } from "./gleams.ts";
import { GUIDES, MISSIONS, missionGiver } from "./missions.ts";
import { RESIDENT_LINES, type Voice } from "./residentLines.ts";

/** A named character who speaks, keyed by the world object you talk to (content/world.ts). */
export const CHARACTERS = {
  lark: { name: "Lark", object: "guide_arcadia" },
  mabry: { name: "Sexton Mabry", object: "guide_hollowmere" },
  rook: { name: "Rook Calder", object: "guide_meridian" },
  odile: { name: "Surveyor Odile", object: "guide_lumen" },
  sela: { name: "Sela Marchbank", object: "curator_sela" },
  juno: { name: "Juno Vale", object: "juno_vale" },
  pell: { name: "Pell Hayward", object: "shop_arcadia" },
  nell: { name: "Nell Ashgrove", object: "shop_hollowmere" },
  ostrow: { name: "Clerk Ostrow", object: "shop_meridian" },
  tidewrath: { name: "Tidewrath", object: "tidewrath" },
  hollowking: { name: "The Hollow King", object: "hollow_king" },
  receiver: { name: "The Receiver", object: "the_receiver" },
} as const;
export type CharacterId = keyof typeof CHARACTERS;

export const CHARACTER_BY_OBJECT: ReadonlyMap<string, CharacterId> = new Map(
  (Object.keys(CHARACTERS) as CharacterId[]).map((c) => [CHARACTERS[c].object, c]),
);

export type DialogueKind = "greet" | "farewell" | "idle";

export interface DialogueLine {
  id: string;
  who: CharacterId;
  kind: DialogueKind;
  text: string;
}

const D = (who: CharacterId, kind: DialogueKind, lines: readonly string[]): DialogueLine[] =>
  lines.map((text, i) => ({ id: `${who}.${kind}.${i + 1}`, who, kind, text }));

export const DIALOGUE: readonly DialogueLine[] = [
  // Lark, a young shepherd at Dawnpad. Eager, a bit bossy, convinced the lake is up to something.
  ...D("lark", "greet", [
    "You're new. I can tell, you're still looking at the sky like it owes you an answer.",
    "Back again? Good. The sheep were starting to think they were in charge.",
  ]),
  ...D("lark", "farewell", ["Go on, then. If you see a sheep near the water, shout at it for me.", "Stay out of the lake. I mean it. It's listening."]),
  ...D("lark", "idle", [
    "Forty-two sheep. Forty-one. Hold still, you.",
    "The lake was flat as glass this morning. It's never flat as glass for a good reason.",
    "Somebody keeps leaving the clover gate open. It's the Hopbits. Hopbits can't open gates. And yet.",
  ]),

  // Sexton Mabry, the chapel grave-keeper at Lanternfall. Slow, dry, unbothered by the dead.
  ...D("mabry", "greet", ["Still breathing? Good. That's one less entry for me.", "Mind the lanterns. They're the only thing out here that's on your side."]),
  ...D("mabry", "farewell", ["Go carefully. I've no room left in the ledger this week.", "If the bells start ringing on their own, walk faster."]),
  ...D("mabry", "idle", [
    "Eleven graves dug, nine filled, two waiting. I try not to take it personally.",
    "The fog's thick tonight. Thick fog, thin walls.",
    "Hear that? No? Good. Keep it that way.",
  ]),

  // Rook Calder, an ex-Oversight courier at Waystation Nine. Quick, low-voiced, enjoys a leak.
  ...D("rook", "greet", ["Keep your voice down. The billboards have ears. Fine, the billboards have microphones.", "You again. Good. I've got errands Oversight would hate."]),
  ...D("rook", "farewell", ["If anyone in a suit asks, you were never here. Neither was I.", "Walk like you've got a form to deliver. Nobody stops a person with a form."]),
  ...D("rook", "idle", [
    "Memo forty-one: all smiles are mandatory. Memo forty-two: memos are classified.",
    "Six years I carried their paper. Never once read it. Now I read nothing else.",
    "Salt in my boots, salt in my coffee. This rock gets into everything.",
  ]),

  // Surveyor Odile, stranded at Moonfall Pad on Lumen. Precise, a little lonely, very glad of company.
  ...D("odile", "greet", ["Oh, a visitor. Sorry, I've been talking to the instruments. They don't answer.", "Welcome to Lumen. Gravity is a suggestion here, so step lightly."]),
  ...D("odile", "farewell", ["Mind the crater rims. They're further down than they look.", "Come back. I'll have finished the survey by then. I won't, but I'll say I have."]),
  ...D("odile", "idle", [
    "Day sixty of the survey. The moon is still round. I'll note that.",
    "The Quietfall went down without a sound. That's how it got the name. I gave it the name.",
    "If you hear something ticking in the Hush, walk the other way.",
  ]),

  // Sela Marchbank, lamp-keeper of Portus Plaza, keeper of the Gleam Vault. Calm, exact, hard to impress.
  ...D("sela", "farewell", ["The vault will wait. It's good at waiting. I'm only adequate.", "Bring the light back with you. Not just the gleams. You."]),
  ...D("sela", "idle", [
    "The plaza lamps are lit by hand. Mine. Every evening. Nobody asks.",
    "Three gleams. People hear that and think it's simple. It's three very different afternoons.",
  ]),

  // Juno Vale, the Portus Exchange. Brisk and honest about prices.
  ...D("juno", "greet", ["Portus Exchange. Prices are fair, the counter's clean, and I don't haggle.", "Welcome back. Buying, selling, or just standing near the tonics?"]),
  ...D("juno", "farewell", ["Come back alive. Dead customers don't pay.", "Safe travels. The portals don't do refunds either."]),
  ...D("juno", "idle", ["If you're going through a portal, buy tonics first. Everyone says they will. Then they don't."]),

  // Pell Hayward, the Dawnpad Trading Post on Arcadia. Chatty, sells to beginners, likes them.
  ...D("pell", "greet", ["Morning! Or evening. Arcadia doesn't care much. What can I get you?", "Fresh off the pad? Good. Fresh customers are my favourite kind."]),
  ...D("pell", "farewell", ["Watch for Bomblets. They're friendly right up until they aren't.", "Off you go. Bring me back some stories. And coins."]),
  ...D("pell", "idle", ["Tonics, blades, a slightly used bow. Everything a hero needs, nothing a hero wants."]),

  // Nell Ashgrove, the Lanternfall Stall on Hollowmere. Quiet, practical, speaks just above a whisper.
  ...D("nell", "greet", ["Quietly, please. The things in the fen hear prices.", "You made it to Lanternfall. Most people buy tonics now. Most people are right."]),
  ...D("nell", "farewell", ["Keep to the lantern light where you can.", "Go on. I'll keep a lamp lit."]),
  ...D("nell", "idle", ["Lamp oil, tonics, and the good sense to leave before dark. Two of those I sell."]),

  // Clerk Ostrow, Waystation Supply on Meridian. A former Oversight clerk who still thinks in forms.
  ...D("ostrow", "greet", ["Waystation Supply. Take a number. You are the number. Go ahead.", "Purchase, return, or complaint? Complaints are closed."]),
  ...D("ostrow", "farewell", ["Transaction complete. Please exit through the dangerous part.", "Your receipt is the feeling of being better armed."]),
  ...D("ostrow", "idle", ["Form twelve-B, request for shade. Denied. Again."]),
];

export const DIALOGUE_BY_ID: ReadonlyMap<string, DialogueLine> = new Map(DIALOGUE.map((l) => [l.id, l]));

/** A character's lines of one kind (greet, farewell, idle). */
export function dialogueFor(who: CharacterId, kind: DialogueKind): DialogueLine[] {
  return DIALOGUE.filter((l) => l.who === who && l.kind === kind);
}

// ------------------------------------------------------------------------------------------- spoken

/** Who says a spoken line: a named character, or a resident's voice. */
export type SpeakerId = CharacterId | Voice;

export interface SpokenLine {
  /** The line's id: its file name too (`<id>.mp3`). */
  id: string;
  speaker: SpeakerId;
  text: string;
}

const GUIDE_CHARACTER: Record<keyof typeof GUIDES, CharacterId> = { arcadia: "lark", hollowmere: "mabry", meridian: "rook", lumen: "odile" };
/** The character who gives a mission (its pitch is spoken in their voice). */
export function missionSpeaker(missionId: string): CharacterId | null {
  const m = MISSIONS.find((x) => x.id === missionId);
  if (!m) return null;
  return CHARACTER_BY_OBJECT.get(missionGiver(m)) ?? null;
}
const BOSS_CHARACTER: Record<string, CharacterId> = { tidewrath: "tidewrath", hollow_king: "hollowking", the_receiver: "receiver" };

/** Spoken ids for the lines that live in other catalogues. */
export const spokenId = {
  guideGreeting: (body: keyof typeof GUIDES) => `${GUIDE_CHARACTER[body]}.greet.0`,
  mission: (id: string) => `mission.${id}`,
  gleams: (k: keyof typeof GLEAMS.lines | "greeting") => `sela.${k}`,
  boss: (bossId: string, trigger: "engage" | "phase2" | "defeat") => `boss.${bossId}.${trigger}`,
};

/** A line with a slot ({you}, {place}…) can't be recorded once, so only slot-free lines are spoken. */
export const hasSlots = (text: string) => /\{[a-z]+\}/.test(text);

/** Every line a character speaks aloud, in one list: the voice tool records each from its text. */
export const SPOKEN_LINES: readonly SpokenLine[] = [
  ...(Object.keys(GUIDES) as (keyof typeof GUIDES)[]).map((b) => ({ id: spokenId.guideGreeting(b), speaker: GUIDE_CHARACTER[b], text: GUIDES[b].greeting })),
  ...DIALOGUE.map((l) => ({ id: l.id, speaker: l.who, text: l.text })),
  ...MISSIONS.map((m) => ({ id: spokenId.mission(m.id), speaker: missionSpeaker(m.id)!, text: m.pitch })),
  { id: spokenId.gleams("greeting"), speaker: "sela", text: GLEAMS.greeting },
  ...(Object.keys(GLEAMS.lines) as (keyof typeof GLEAMS.lines)[]).map((k) => ({ id: spokenId.gleams(k), speaker: "sela" as const, text: GLEAMS.lines[k] })),
  ...BOSS_DEFS.flatMap((b) =>
    (["engage", "phase2", "defeat"] as const).map((t) => ({ id: spokenId.boss(b.id, t), speaker: BOSS_CHARACTER[b.id]!, text: b.voice[t] })),
  ),
  ...RESIDENT_LINES.filter((l) => !hasSlots(l.text)).map((l) => ({ id: l.id, speaker: l.voice, text: l.text })),
];

export const SPOKEN_BY_ID: ReadonlyMap<string, SpokenLine> = new Map(SPOKEN_LINES.map((l) => [l.id, l]));

/**
 * The key a recording is checked against: FNV-1a of the exact text. A file made from older text
 * no longer matches, so the game never plays words that differ from the subtitle.
 */
export function textKey(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
