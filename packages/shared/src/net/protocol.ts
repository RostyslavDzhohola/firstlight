// Message contract between client and server. Server validates every client message with zod;
// these types are the shape both sides agree on.

import type { BodyId } from "../planet/bodies.ts";
import type { CosmeticSlot } from "../content/items.ts";
import type { HallLine } from "../content/secrets.ts";

export const NET = {
  TICK_MS: 50, // 20 Hz simulation and patches
  INPUT_HZ: 20,
  INTERP_DELAY_MS: 100,
  MAX_CLIENTS: 40,
  SOLO_FILL_LIMIT: 36,
  MAX_COPIES_PER_BODY: 2,
  GLOBAL_CAP: 320,
  RECONNECT_WINDOW_S: 30,
  REWIND_MS: 200,
} as const;

/**
 * Wire protocol version. Bump it whenever client and server messages stop being compatible: the
 * server refuses /api/play from other versions with `{error: "version"}` and the client reloads.
 */
// 2: F12 core message changes + the sky lane's lightning schedule. 3: the Portus town (D40): the
// server validates movement against the new town floor and the town's walls and houses, which an
// older client neither has nor draws, so stale tabs must reload instead of being corrected forever.
// 4: the planets' pad-0 outposts (D42-D46): the server blocks movement, shots, NPC sight and NPC
// steering at their buildings, which an older client neither has nor draws.
// 5: natural solids (D-solid-1): tree trunks, boulders, spires and big rocks block movement on the
// server; an older client walks through them and would be corrected at every tree.
export const PROTOCOL_VERSION = 5;

// ---- HTTP: entering the world -------------------------------------------------------------

export interface PlayRequest {
  body: BodyId;
  /** The client's PROTOCOL_VERSION. */
  v: number;
  /** Room id of the party leader (or a member) on this body, to land in the same copy. The server only honours it for party members. */
  partyLeaderRoomId?: string;
  /** Load-test rooms only (requires the load-test secret server-side). */
  loadtest?: boolean;
}

export type PlayResponse =
  | { ok: true; reservation: SeatReservation }
  | { ok: false; queue: { position: number; etaSeconds: number } }
  | { ok: false; error: string; body?: BodyId; version?: number };

/** Mirrors Colyseus' ISeatReservation. */
export interface SeatReservation {
  name: string;
  roomId: string;
  sessionId: string;
  processId: string;
  publicAddress?: string;
  reconnectionToken?: string;
}

// ---- Client → server messages --------------------------------------------------------------

export interface InputMsg {
  seq: number;
  /** Predicted position and facing after applying this input. */
  x: number;
  y: number;
  z: number;
  fx: number;
  fy: number;
  fz: number;
  anim: number;
  /** Client clock (ms) when the input was sampled. */
  t: number;
}

export interface FireMsg {
  slot: number;
  ox: number;
  oy: number;
  oz: number;
  dx: number;
  dy: number;
  dz: number;
  /**
   * Client clock (ms) of the shot. Unused by the server (reserved): hits are rewound by the fixed
   * NET.REWIND_MS window, not by this time, which a client could forge.
   */
  t: number;
  /** 0..1 draw/charge for bows and charged melee. */
  charge?: number;
}

export type ClientMessages = {
  input: InputMsg;
  fire: FireMsg;
  /** `t`: client clock (ms) of the swing; unused by the server (reserved, like FireMsg.t). */
  melee: { slot: number; t: number; heavy?: boolean };
  block: { on: boolean };
  /** Start/stop drawing a bow or charging a heavy swing (the server times the draw). */
  charge: { on: boolean };
  /** Scope/aim down sights on or off (spread and the scoped flag). */
  scope: { on: boolean };
  /** Swap two inventory slots (0–3 hotbar, 4–19 backpack). */
  move: { from: number; to: number };
  reload: { slot: number };
  equip: { slot: number };
  use: { slot: number; targetId?: string };
  pickup: { pileId: string; itemIndex?: number };
  drop: { slot: number };
  /** Use a world object (quests lane): shop keeper, guide, mission pickup, egg part. `code` for keypads. */
  interact: { target: string; code?: string };
  /** Portus Exchange: buy `qty` (stackables only) of an item tier. Level gates are shown, not enforced. */
  buy: { itemId: string; tier?: 1 | 2 | 3; qty?: number };
  /** Sell the item in an inventory slot (0–3 hotbar, 4–19 backpack); `qty` defaults to the whole stack. */
  sell: { slot: number; qty?: number };
  /** Wear the cosmetic in an inventory slot, or take off a cosmetic slot. */
  wear: { slot?: number; remove?: CosmeticSlot };
  /** Ask for the Hall of Firsts and other quest state after joining (replies with `hall`). */
  questSync: Record<string, never>;
  logout: { start: boolean };
  phrase: { id: number };
  /** Ask for a travel ticket while standing in a portal. `viaPad` is unused (reserved): the server finds the portal from the position. */
  travel: { to: BodyId; viaPad?: number };
  fastTravel: { pad: number };
  respawn: { starter: number; palette: number };
  party: { action: "invite" | "accept" | "decline" | "leave" | "kick"; target?: string };
  mission: { action: "accept" | "abandon"; id: string };
  title: { medalId: string | null };
  ping: { t: number };
  /** Horses (content/horse.ts): H sends "whistle" (dismount / mount if close / call the horse), E near it sends "ride". */
  horse: { action: "whistle" | "ride" | "dismount" };
  /** Onboarding: an attack aimed at the training dummies in Portus (camera ray; the server tests the hit). */
  train: { ox: number; oy: number; oz: number; dx: number; dy: number; dz: number };
  /** Onboarding: skip it (no more XP, no Spark medal; it never comes back). */
  onboarding: { action: "skip" };
};

// ---- Server → client events (broadcast or direct) -------------------------------------------

export type ServerMessages = {
  /** `kb`: knockback strength (m/s) along the unit shove direction kx/ky/kz (the victim's client applies it). */
  hit: { attacker: string; target: string; amount: number; weak: boolean; kind: "player" | "npc"; x: number; y: number; z: number; kb: number; kx: number; ky: number; kz: number };
  /** A melee swing (animation and sound for everyone nearby). */
  swing: { by: string; weapon: number; heavy: boolean; hits: number };
  /** The server refused an action (`reason` is short and human-readable). */
  denied: { action: string; reason: string };
  /** To the attacker only: a hit landed on an NPC that took no damage (spawning, evading, a shield). */
  immune: { target: string; reason: "spawning" | "evading" | "invulnerable" | "shield" | "arena" };
  /** Movement snap-back: the authoritative position for input `seq`. */
  correct: { x: number; y: number; z: number; seq: number };
  /** A portal travel ticket was issued: leave and join `to` through /api/play. */
  travelOk: { to: BodyId };
  /** Reborn: leave and join `body` (Portus) as the new character. */
  reborn: { body: BodyId };
  /** Logout finished; the server closes the connection with CLOSE.LOGGED_OUT. */
  loggedOut: Record<string, never>;
  /** Rewards for an NPC kill (or a boss's personal loot). */
  npcKill: { id: string; kind: number; xp: number; coins: number };
  shot: { by: string; weapon: number; ox: number; oy: number; oz: number; dx: number; dy: number; dz: number; hit?: [number, number, number] };
  projectile: { id: number; by: string; weapon: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; g: number };
  explode: { id: number; x: number; y: number; z: number; radius: number; weapon: number };
  death: { victim: string; killer: string | null; killerName: string; aliveMs: number; level: number; pileId: string };
  /** A breakable prop shattered: pre-fractured `variant`, impact direction (unit), push strength `f`. */
  broke: { id: string; archetype: number; variant: number; ix: number; iy: number; iz: number; f?: number };
  rebuilt: { id: string };
  toast: { text: string; kind: "info" | "xp" | "coins" | "medal" | "warn" };
  phrase: { by: string; id: number };
  announce: { text: string };
  pong: { t: number; serverTime: number };
  you: YouState;
  kicked: { reason: string };
  updating: { seconds: number };
  /** Hall of Firsts lines (all engraved plaques), on questSync and whenever a new first is claimed. */
  hall: { lines: HallLine[] };
  medal: { id: string };
  missionDone: { id: string; xp: number; coins: number };
  /** The tracked hunt mission's NPCs within reach whose kill would count (missions.ts huntCredit): what the mission pointer follows. Sent when the list changes. */
  huntTargets: { id: string; npcs: string[] };
  /** Result of buy/sell/wear (a toast carries the human text). */
  shop: { ok: boolean; action: "buy" | "sell" | "wear"; reason?: string };
  /** A personal puzzle light changed state, for its solver only. */
  lamp: { id: string; on: boolean };
  /** Admin staged scene: travel to `body`, then send `admin {cmd:"stage", args:{n}}` again. */
  stage: { n: number; body: BodyId };
  /** Open a client panel (keypad for the E7 safe). */
  prompt: { kind: "keypad"; target: string };
  /** Horse events for effects and sounds (state carries the horse itself). */
  horse: { owner: string; event: "summon" | "mount" | "dismount" | "thrown" | "leave"; x: number; y: number; z: number };
  /** Onboarding: a training dummy took a hit (`down` once it has ONBOARDING.HITS_PER_DUMMY). */
  train: { dummy: number; hits: number; down: boolean };
  /** Onboarding finished: `xp` paid in total (50 when done, less when skipped). */
  onboarding: { state: "done" | "skipped"; xp: number };
};

/** Private per-player state sent only to its owner. */
export interface YouState {
  xp: number;
  xpToNext: number;
  coins: number;
  hotbar: (InvItem | null)[];
  backpack: (InvItem | null)[];
  /** `counts`: kills per hunt target (hunts only), so a full quota stops being pointed at. Optional: older servers don't send it. */
  missions: { id: string; progress: number; goal: number; done: boolean; counts?: number[] }[];
  medals: string[];
  pads: number[]; // discovered pad indices on this body
  /** Medal worn as a title (null = none). */
  title?: string | null;
  /** Worn cosmetic ids by slot. */
  worn?: Partial<Record<CosmeticSlot, string>>;
  logoutEndsAt: number | null;
  protectedUntil: number;
  /** Horses are on in this room (server flag FEATURE_HORSES; set by the horse system). */
  horses?: boolean;
  /** M11 extra #5 sources and world triggers are enabled. */
  cosmeticsExtras?: boolean;
  /** Onboarding in progress (Portus only): hits on each training dummy. Absent once done or skipped. */
  onboarding?: { hits: number[] };
}

export interface InvItem {
  id: string; // item def id, e.g. "carbine"
  tier: 1 | 2 | 3;
  qty: number;
  /** Rounds left in the magazine, or heat. */
  mag?: number;
  /** Unique look for a standard item (items.ts SKINS), e.g. the Ferryman's Oar is a Riverstaff II. */
  skin?: string;
}

export const PHRASES = ["Truce?", "Help!", "Follow me", "Boss here", "Thanks", "GG"] as const;
