// Room state shared by server (encoder) and client (decoder). Hot per-tick fields come first
// (indexes < 32 keep the fast path). Players are not view-filtered (≤ 40 per room);
// NPCs and piles are, by distance (SPEC §5.2).

import { schema, t, type SchemaType } from "@colyseus/schema";

/** Bit flags on a player. */
export const PF = {
  SAFE: 1,
  PROTECTED: 2,
  LOGGING_OUT: 4,
  VOICE: 8,
  RADIO_TX: 16,
  DEAD: 32,
  LINGER: 64, // tab closed, body still in the world
  ADMIN: 128,
  IN_COMBAT: 256,
  SWIMMING: 512,
  BLOCKING: 1024,
  SCOPED: 2048,
  VOICE_MUTED: 4096, // admin voice-mute
  LOADTEST: 8192,
  MOUNTED: 16384, // riding a horse (server-owned; content/horse.ts)
} as const;

/** Animation states (client picks clips from these). */
export const ANIM = {
  IDLE: 0,
  WALK: 1,
  RUN: 2,
  SPRINT: 3,
  JUMP: 4,
  FALL: 5,
  SWIM: 6,
  DODGE: 7,
  ATTACK: 8,
  HEAVY: 9,
  BLOCK: 10,
  AIM: 11,
  CAST: 12,
  HIT: 13,
  DEAD: 14,
  EMOTE: 15,
} as const;

const unit = () => t.quantized({ min: -1, max: 1, bits: 16 });

export const PlayerState = schema(
  {
    x: t.float32(),
    y: t.float32(),
    z: t.float32(),
    fx: unit(),
    fy: unit(),
    fz: unit(),
    anim: t.uint8(),
    seq: t.uint32(),
    hp: t.uint16(),
    maxHp: t.uint16(),
    flags: t.uint16(),
    weapon: t.uint16(), // item def index, 0 = fists
    level: t.uint8(),
    name: t.string(),
    starter: t.uint8(),
    palette: t.uint8(),
    title: t.string(),
    party: t.string(),
    cosmetics: t.string(), // comma-separated cosmetic ids
    radioCh: t.uint8(),
    userId: t.string(),
    look: t.uint8(), // STARTER_LOOKS index (appended: older clients ignore it and draw look 0)
  },
  "Player",
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const NpcState = schema(
  {
    x: t.float32(),
    y: t.float32(),
    z: t.float32(),
    fx: unit(),
    fy: unit(),
    fz: unit(),
    anim: t.uint8(),
    hp: t.uint32(),
    maxHp: t.uint32(),
    kind: t.uint16(), // enemy/wildlife/boss def index
    level: t.uint8(),
    phase: t.uint8(),
    flags: t.uint16(),
    target: t.string(), // sessionId being attacked, for telegraph visuals
  },
  "Npc",
);
export type NpcState = SchemaType<typeof NpcState>;

export const PileState = schema(
  {
    x: t.float32(),
    y: t.float32(),
    z: t.float32(),
    owner: t.string(),
    createdAt: t.float64(),
    items: t.uint8(), // item count, for the visual size
    coins: t.uint32(),
  },
  "Pile",
);
export type PileState = SchemaType<typeof PileState>;

/** A summoned horse (content/horse.ts), keyed by its owner's session id. Not view-filtered: one per
 *  player at most. While ridden the client draws it under the rider (rider's own interpolation) and
 *  these fields only matter once the rider gets off. */
export const HorseState = schema(
  {
    x: t.float32(),
    y: t.float32(),
    z: t.float32(),
    fx: unit(),
    fy: unit(),
    fz: unit(),
    ridden: t.boolean(),
    coat: t.uint8(),
  },
  "Horse",
);
export type HorseState = SchemaType<typeof HorseState>;

export const BodyState = schema(
  {
    time: t.float64(), // server ms clock
    players: t.map(PlayerState),
    npcs: t.map(NpcState).view(),
    piles: t.map(PileState).view(),
    broken: t.map("float64"), // prop id → rebuild time (ms)
    body: t.string(),
    copy: t.uint8(),
    announce: t.string(),
    horses: t.map(HorseState),
  },
  "BodyState",
);
export type BodyState = SchemaType<typeof BodyState>;
