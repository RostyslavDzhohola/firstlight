// Message contract between client and server. Server validates every client message with zod;
// these types are the shape both sides agree on.

import type { BodyId } from "../planet/bodies.ts";

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

// ---- HTTP: entering the world -------------------------------------------------------------

export interface PlayRequest {
  body: BodyId;
  /** Room id of the party leader, to land in the same copy. */
  partyLeaderRoomId?: string;
  /** Load-test rooms only (requires the load-test secret server-side). */
  loadtest?: boolean;
}

export type PlayResponse =
  | { ok: true; reservation: SeatReservation }
  | { ok: false; queue: { position: number; etaSeconds: number } }
  | { ok: false; error: string; body?: BodyId };

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
  /** Client clock (ms) of the shot, for lag compensation. */
  t: number;
  /** 0..1 draw/charge for bows and charged melee. */
  charge?: number;
}

export type ClientMessages = {
  input: InputMsg;
  fire: FireMsg;
  melee: { slot: number; t: number; heavy?: boolean };
  block: { on: boolean };
  reload: { slot: number };
  equip: { slot: number };
  use: { slot: number; targetId?: string };
  pickup: { pileId: string; itemIndex?: number };
  drop: { slot: number };
  interact: { target: string };
  buy: { itemId: string };
  sell: { slot: number };
  logout: { start: boolean };
  phrase: { id: number };
  travel: { to: BodyId; viaPad?: number };
  fastTravel: { pad: number };
  respawn: { starter: number; palette: number };
  party: { action: "invite" | "accept" | "leave" | "kick"; target?: string };
  mission: { action: "accept" | "abandon"; id: string };
  title: { medalId: string | null };
  ping: { t: number };
};

// ---- Server → client events (broadcast or direct) -------------------------------------------

export type ServerMessages = {
  hit: { attacker: string; target: string; amount: number; weak: boolean; kind: "player" | "npc"; x: number; y: number; z: number };
  shot: { by: string; weapon: number; ox: number; oy: number; oz: number; dx: number; dy: number; dz: number; hit?: [number, number, number] };
  projectile: { id: number; by: string; weapon: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; g: number };
  explode: { id: number; x: number; y: number; z: number; radius: number; weapon: number };
  death: { victim: string; killer: string | null; killerName: string; aliveMs: number; level: number; pileId: string };
  broke: { id: string; archetype: number; variant: number; ix: number; iy: number; iz: number };
  rebuilt: { id: string };
  toast: { text: string; kind: "info" | "xp" | "coins" | "medal" | "warn" };
  phrase: { by: string; id: number };
  announce: { text: string };
  pong: { t: number; serverTime: number };
  you: YouState;
  kicked: { reason: string };
  updating: { seconds: number };
};

/** Private per-player state sent only to its owner. */
export interface YouState {
  xp: number;
  xpToNext: number;
  coins: number;
  hotbar: (InvItem | null)[];
  backpack: (InvItem | null)[];
  missions: { id: string; progress: number; goal: number; done: boolean }[];
  medals: string[];
  pads: number[]; // discovered pad indices on this body
  logoutEndsAt: number | null;
  protectedUntil: number;
}

export interface InvItem {
  id: string; // item def id, e.g. "carbine"
  tier: 1 | 2 | 3;
  qty: number;
  /** Rounds left in the magazine, or heat. */
  mag?: number;
}

export const PHRASES = ["Truce?", "Help!", "Follow me", "Boss here", "Thanks", "GG"] as const;
