// The ElevenLabs sound-effect set: the prompts behind every sample the client plays
// (apps/client/src/audio/sounds.ts). `generate.ts` turns each take into a raw file under /tmp,
// `process.ts` trims, levels and encodes the kept takes into the upload-ready set with its manifest.
// Prompts describe what to hear (the model tends to add what a prompt negates).

import type { SampleName } from "../../apps/client/src/audio/sounds.ts";

/** The set's version: its folder on the asset Worker (`/v/sfx-1/…`). New takes or edits go in a new set. */
export const SET = "sfx-1";

export interface SoundSpec {
  name: SampleName;
  /** In-game trigger, for the preview page. */
  event: string;
  /** 1 = the owner's "annoying ping" … 6 = other weapons; generated in this order. */
  priority: number;
  /** One prompt per take. */
  prompts: string[];
  /** Requested length, 0.5–30 s. Billed 10 credits per second (estimateCredits). */
  seconds: number;
  /** ElevenLabs prompt influence, 0–1. */
  influence: number;
  /** Hard cap after trimming the lead-in, and the fade-out at the end. */
  maxMs: number;
  fadeMs: number;
  /**
   * Playback loudness relative to the ZzFX stand-in it replaces (dB; loudest 400 ms, K-weighted),
   * so the mix the owner knows stays put. Default 0.
   */
  level?: number;
  /** Takes (1-based) left out of the set after listening/analysis, with why. */
  drop?: Record<number, string>;
}

const times = (n: number, p: string) => Array.from({ length: n }, () => p);

export const SOUNDS: SoundSpec[] = [
  // 1: the ping, the UI blip and the coin chirp
  {
    name: "hitmark",
    event: "Your hit lands (every weapon)",
    priority: 1,
    prompts: [
      "Video game hit confirmation: a short, soft, punchy muffled thump with a subtle crisp click, dry and close",
      ...times(3, "Single soft punchy hit marker for a video game: a quick muffled thwack of a padded impact, dry, close, very short"),
    ],
    seconds: 0.5,
    influence: 0.6,
    maxMs: 160,
    fadeMs: 60,
    // A low thwack needs more energy than the 1.6 kHz ping did to read over gunfire.
    level: 6,
  },
  {
    name: "crit",
    event: "Your hit lands on a weak point (head, glowing spot)",
    priority: 1,
    prompts: times(2, "Single heavy critical hit for a video game: a crunchy punchy thwack with a bright snap, dry, close, very short"),
    seconds: 0.5,
    influence: 0.6,
    maxMs: 260,
    level: 6,
    fadeMs: 60,
  },
  {
    name: "ui",
    event: "Toasts, tutorial steps, mount/dismount",
    priority: 1,
    prompts: [
      ...times(3, "Single soft UI click for a game menu: a gentle muted wooden tap, warm and low, very short, dry"),
      ...times(2, "Soft muted click of a small plastic switch for a game menu, very short, dry, close"),
    ],
    seconds: 0.5,
    influence: 0.6,
    maxMs: 160,
    fadeMs: 40,
    drop: { 1: "a 1.4 kHz tonal knock (+44 dB tone), the closest to the old ping" },
  },
  {
    name: "coins",
    level: -3,
    event: "Coins toast",
    priority: 1,
    prompts: times(2, "A small handful of gold coins clinking together, a quick light pickup jingle, close, dry"),
    seconds: 0.7,
    influence: 0.5,
    maxMs: 600,
    fadeMs: 120,
  },
  // 2: the sword
  {
    name: "swing_sword",
    event: "Sunbrand (Brother Ash) swing; unknown melee weapons",
    priority: 2,
    prompts: [
      ...times(2, "Single fast sword swing through the air: a sharp airy swish, close, dry, one-shot"),
      ...times(2, "Single quick blade slash whoosh with a faint shimmering energy hum, a sharp airy swish, close, dry"),
    ],
    seconds: 0.5,
    influence: 0.6,
    maxMs: 420,
    fadeMs: 90,
    drop: { 3: "a flat hiss with a high whistle line, no swish shape" },
  },
  // 3: the wand
  {
    name: "hexquill",
    event: "Hexquill wand (Hexwick) cast",
    priority: 3,
    prompts: times(4, "Magic wand spell cast: a quick sparkling shimmer whoosh with soft twinkling glitter, airy and warm, fantasy game, one-shot"),
    seconds: 0.7,
    influence: 0.5,
    // Cast every 0.4 s: keep the tail short so casts don't smear into one wash.
    maxMs: 400,
    fadeMs: 160,
  },
  {
    name: "magic_hit",
    event: "A magic bolt (Hexquill, Emberglass) hits without exploding",
    priority: 3,
    prompts: times(3, "Magic bolt impact: a soft sparkling burst of fizzing glittery energy, fantasy game, one-shot, close"),
    seconds: 0.5,
    influence: 0.5,
    maxMs: 360,
    fadeMs: 120,
  },
  // 4: the other starters and the combat basics
  {
    name: "carbine",
    event: "Pocket Carbine (Unit 7) shot",
    priority: 4,
    prompts: times(4, "Single shot from a small sci-fi blaster: a short punchy energy zap with a soft low thump, video game, close, dry"),
    seconds: 0.5,
    influence: 0.6,
    maxMs: 260,
    fadeMs: 70,
  },
  {
    name: "swing_fists",
    event: "Fists (empty slot) punch",
    priority: 4,
    prompts: times(3, "Single quick punch whoosh: a fist swiping fast through the air, a short airy swipe, close, dry"),
    seconds: 0.5,
    influence: 0.6,
    maxMs: 260,
    fadeMs: 70,
  },
  {
    name: "swing_staff",
    event: "Riverstaff (Kappa) swing",
    priority: 4,
    prompts: times(3, "Single wooden bo staff swung fast through the air: a deep rounded whoosh, close, dry"),
    seconds: 0.5,
    influence: 0.6,
    maxMs: 420,
    fadeMs: 90,
  },
  {
    name: "impact",
    event: "Someone else is hit; a bullet or arrow lands",
    priority: 4,
    prompts: times(3, "Single body hit impact: a dull punchy thud, close, dry, video game"),
    seconds: 0.5,
    influence: 0.6,
    maxMs: 260,
    fadeMs: 60,
  },
  {
    name: "hurt",
    event: "You take a hit",
    priority: 4,
    prompts: times(3, "Player takes damage in a video game: a heavy muffled body blow thump with a short crunchy grit, close"),
    seconds: 0.5,
    influence: 0.6,
    maxMs: 350,
    fadeMs: 80,
  },
  {
    name: "shatter",
    event: "A crate, barrel or rock breaks",
    priority: 4,
    prompts: times(2, "A small wooden crate smashing apart: a crunchy wood and stone debris break, close"),
    seconds: 0.7,
    influence: 0.5,
    maxMs: 600,
    fadeMs: 150,
  },
  // 5: progression and travel
  {
    name: "levelUp",
    level: -2,
    event: "XP toast and level up",
    priority: 5,
    prompts: times(2, "Level up for a fantasy game: a bright rising magical shimmer with warm soft bell tones, uplifting and short"),
    seconds: 1.5,
    influence: 0.5,
    maxMs: 1500,
    fadeMs: 300,
  },
  {
    name: "death",
    event: "You are knocked out",
    priority: 5,
    prompts: times(2, "Player defeated in a video game: a deep dull falling whoosh fading into a low muted thud, somber and short"),
    seconds: 1.5,
    influence: 0.5,
    maxMs: 1500,
    fadeMs: 300,
  },
  {
    name: "portal",
    event: "Travel through a portal; a prop re-forms (pitched up)",
    priority: 5,
    prompts: times(2, "Teleport portal activation: a swirling magical whoosh rising in pitch with a soft shimmering hum, sci-fi fantasy"),
    seconds: 1.5,
    influence: 0.5,
    maxMs: 1500,
    fadeMs: 300,
  },
  {
    name: "bubble",
    event: "Prism Bubble deployed",
    priority: 5,
    prompts: ["A magical protective shield bubble forming: a soft glassy shimmering whoosh with a gentle hum"],
    seconds: 0.8,
    influence: 0.5,
    maxMs: 800,
    fadeMs: 200,
    // Its stand-in is the quiet UI tok; a shield going up should be heard.
    level: 8,
  },
  // 6: the other weapons
  {
    name: "swing_heavy",
    event: "Bearded Axe and Quarry Hammer swing",
    priority: 6,
    prompts: times(2, "Single heavy axe swing: a slow powerful deep whoosh through the air, close, dry"),
    seconds: 0.6,
    influence: 0.6,
    maxMs: 500,
    fadeMs: 110,
  },
  {
    name: "emberglass",
    event: "Emberglass Staff fire bolt",
    priority: 6,
    prompts: times(2, "Fire staff spell cast: a fireball launching with a roaring whoosh of flame, fantasy game, one-shot"),
    seconds: 0.7,
    influence: 0.5,
    maxMs: 600,
    fadeMs: 150,
  },
  {
    name: "stormcoil",
    event: "Stormcoil chain lightning",
    priority: 6,
    prompts: times(2, "Lightning spell: a sharp crackling electric zap with a snappy arc discharge, one-shot"),
    seconds: 0.6,
    influence: 0.5,
    maxMs: 450,
    fadeMs: 110,
  },
  {
    name: "kunai",
    event: "Ember Kunai throw (the ninja starter)",
    priority: 6,
    prompts: times(2, "Throwing knife throw: a short sharp whip of air with a faint metallic shing, close, dry, one-shot"),
    seconds: 0.5,
    influence: 0.5,
    maxMs: 400,
    fadeMs: 100,
  },
  {
    name: "ember_seal",
    event: "Ember Seal fireball (the ninja's hand-seal fire technique)",
    priority: 6,
    prompts: times(2, "Magic fireball released from the hands: a rising whoosh that bursts into a roaring flame, fantasy game, one-shot"),
    seconds: 0.9,
    influence: 0.5,
    maxMs: 800,
    fadeMs: 180,
  },
  {
    name: "scatterpipe",
    event: "Scatterpipe shotgun blast",
    priority: 6,
    prompts: times(2, "Single sci-fi shotgun blast: a heavy punchy boom with a short metallic rattle, video game, close"),
    seconds: 0.8,
    influence: 0.5,
    maxMs: 600,
    fadeMs: 150,
  },
  {
    name: "stillshot",
    event: "Stillshot Rifle shot",
    priority: 6,
    prompts: times(2, "Single sniper rifle shot: a loud sharp crack with a short echoing tail, video game"),
    seconds: 1,
    influence: 0.5,
    maxMs: 900,
    fadeMs: 250,
  },
  {
    name: "longbow",
    event: "Yew Longbow arrow loosed",
    priority: 6,
    prompts: times(2, "Single bow string release: a taut twang and a quick arrow whoosh, close, dry"),
    seconds: 0.6,
    influence: 0.6,
    maxMs: 450,
    fadeMs: 110,
  },
  {
    name: "comet",
    event: "Comet Launcher rocket",
    priority: 6,
    prompts: times(2, "Rocket launcher firing: a deep whooshing launch thump with a rushing hiss, video game"),
    seconds: 1,
    influence: 0.5,
    maxMs: 900,
    fadeMs: 250,
  },
  {
    name: "grenade",
    event: "Scrapburst Grenade thrown",
    priority: 6,
    prompts: times(2, "Throwing a small grenade: a quick light whoosh with a faint metallic tick, close"),
    seconds: 0.5,
    influence: 0.5,
    maxMs: 350,
    fadeMs: 90,
  },
  {
    name: "explosion",
    event: "Rocket, grenade and fire-splash explosions; heavy props breaking",
    priority: 6,
    prompts: times(2, "Explosion for a video game: a punchy deep boom with crunchy debris and a short rumbling tail"),
    seconds: 1.5,
    influence: 0.5,
    maxMs: 1500,
    fadeMs: 400,
  },
];

/** Credits for one take: 10 per second (measured: 0.5 s cost 5, 0.7 s 7, 1.5 s 15). */
export function estimateCredits(seconds: number): number {
  return Math.max(5, Math.ceil(seconds * 10));
}
