// Which peers to link and who hears whom (pure, unit-tested). Runs at 4 Hz.
//
// Wanted links: the MAX_PEERS nearest eligible players within CONNECT, plus everyone on my radio
// channel. Links are closed at once when a peer becomes ineligible, and after DROP_HOLD_MS beyond DROP
// (hysteresis between CONNECT and DROP keeps links from flapping).

import { VOICE } from "@firstlight/shared/net/voice";

export interface PeerView {
  id: string;
  dist: number;
  /** Peer opted in (PF.VOICE). */
  voice: boolean;
  /** Admin voice-muted (PF.VOICE_MUTED). */
  adminMuted: boolean;
  radioCh: number;
  /** Blocked locally (either way), or the server said it's unreachable for now. */
  blocked: boolean;
}

export interface Me {
  radioCh: number;
  hasRadio: boolean;
  adminMuted: boolean;
}

export interface PlanInput {
  me: Me;
  peers: readonly PeerView[];
  linked: ReadonlySet<string>;
  /** Peer id → when it was first seen beyond DROP (mutated). */
  farSince: Map<string, number>;
  now: number;
}

export interface Plan {
  open: string[];
  close: string[];
}

export function onMyChannel(me: Me, p: { radioCh: number }): boolean {
  return me.hasRadio && me.radioCh > 0 && p.radioCh === me.radioCh;
}

function eligible(me: Me, p: PeerView): boolean {
  return p.voice && !p.adminMuted && !p.blocked && !me.adminMuted;
}

export function planLinks({ me, peers, linked, farSince, now }: PlanInput): Plan {
  // Radio mates have their own slots (a channel holds at most RADIO_CAP), so they don't take
  // proximity ones.
  const near = peers
    .filter((p) => eligible(me, p) && p.dist <= VOICE.CONNECT && !onMyChannel(me, p))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, VOICE.MAX_PEERS);
  const wanted = new Set(near.map((p) => p.id));
  for (const p of peers) if (eligible(me, p) && onMyChannel(me, p)) wanted.add(p.id);

  const byId = new Map(peers.map((p) => [p.id, p]));
  const close: string[] = [];
  for (const id of linked) {
    const p = byId.get(id);
    if (!p || !eligible(me, p)) {
      close.push(id);
      farSince.delete(id);
      continue;
    }
    if (onMyChannel(me, p) || p.dist <= VOICE.DROP) {
      farSince.delete(id);
      continue;
    }
    const since = farSince.get(id);
    if (since === undefined) farSince.set(id, now);
    else if (now - since >= VOICE.DROP_HOLD_MS) {
      close.push(id);
      farSince.delete(id);
    }
  }
  for (const id of farSince.keys()) if (!linked.has(id)) farSince.delete(id);

  // Proximity quota: keep at most MAX_PEERS non-radio links, nearest first (radio mates have their
  // own room: a channel holds at most RADIO_CAP). New near peers displace the farthest kept ones.
  const closing = new Set(close);
  const prox = [...linked]
    .map((id) => byId.get(id))
    .filter((p): p is PeerView => !!p && !closing.has(p.id) && !onMyChannel(me, p));
  for (const p of near) if (!linked.has(p.id) && !onMyChannel(me, p)) prox.push(p);
  prox.sort((a, b) => a.dist - b.dist);
  const keep = new Set(prox.slice(0, VOICE.MAX_PEERS).map((p) => p.id));
  for (const p of prox) {
    if (keep.has(p.id)) continue;
    if (linked.has(p.id)) {
      close.push(p.id);
      farSince.delete(p.id);
    } else wanted.delete(p.id);
  }
  const open = [...wanted].filter((id) => !linked.has(id));
  return { open, close };
}

/**
 * Should we accept a link a peer opened to us? Only if the planner would keep it: a radio mate, or a
 * peer within DROP that ranks among our MAX_PEERS nearest proximity links (no accept-then-evict churn).
 */
export function acceptsIncoming(me: Me, peer: { radioCh: number; dist: number }, linked: readonly { radioCh: number; dist: number }[]): boolean {
  if (me.adminMuted) return false;
  if (onMyChannel(me, peer)) return true;
  if (peer.dist > VOICE.DROP) return false;
  const prox = linked.filter((p) => !onMyChannel(me, p)).map((p) => p.dist).sort((a, b) => a - b);
  return prox.length < VOICE.MAX_PEERS || peer.dist < prox[VOICE.MAX_PEERS - 1]!;
}

/** Should my mic go to this peer right now? (V: proximity; B: radio, which is also heard nearby.) */
export function shouldSend(dist: number, ptt: boolean, radioTx: boolean, sameChannel: boolean): boolean {
  return ((ptt || radioTx) && dist <= VOICE.HEAR + 5) || (radioTx && sameChannel);
}

const REDIAL_BASE_MS = 10_000;
const REDIAL_MAX_MS = 5 * 60_000;

/**
 * How long to wait before ringing a peer again after `strikes` unreachable replies in a row from the
 * server (the reason is never disclosed: out of range, voice off, or a block). Doubles from 10 s to
 * 5 minutes, so a client next to someone who blocked it stops dialling them every 10 s; the count
 * resets as soon as that peer reaches us.
 */
export function redialBackoffMs(strikes: number): number {
  return Math.min(REDIAL_BASE_MS * 2 ** Math.max(0, strikes - 1), REDIAL_MAX_MS);
}
