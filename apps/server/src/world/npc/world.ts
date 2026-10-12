// The slice of a body room the NPC system needs. BodyRoom provides it through roomWorld(); the tick
// benchmark provides a fake one, so AI cost can be measured without sockets.

import type { BodyDef, Terrain } from "@firstlight/shared";
import type { InvItem } from "@firstlight/shared/net/protocol";
import type { NpcState } from "@firstlight/shared/net/schema";
import type { BodyRoom } from "../BodyRoom.ts";
import type { NpcActor, PlayerActor } from "../actors.ts";
import type { CombatHost } from "../combat.ts";
import type { V3 } from "../geometry.ts";

export interface NpcWorld {
  body: BodyDef;
  terrain: Terrain;
  host: CombatHost;
  now(): number;
  /** Everyone NPCs can see and hurt: connected players and lingering bodies. */
  players(): Iterable<PlayerActor>;
  /** Connected players (message recipients). */
  connected(): Iterable<PlayerActor>;
  addNpc(n: NpcActor): void;
  removeNpc(id: string): void;
  newNpcState(): NpcState;
  grantXp(p: PlayerActor, amount: number): void;
  giveItem(p: PlayerActor, item: InvItem): boolean;
  /** Create a loot pile; with `deferred`, pile events are queued until after the transaction. */
  createPile(owner: PlayerActor, items: InvItem[], coins: number, at: V3, deferred?: (() => void)[]): void;
  /** Character + pile writes atomically (D26). */
  withTx<T>(fn: () => T): T;
  /** Ground point under a position (water surface for swimmers). */
  snapToGround(p: readonly number[]): V3;
  send(p: PlayerActor, type: string, msg: unknown): void;
  broadcast(type: string, msg: unknown): void;
  onMessage(type: string, handler: (sessionId: string, msg: unknown) => void): void;
  playerById(sessionId: string): PlayerActor | undefined;
  save(p: PlayerActor): void;
}

export function roomWorld(room: BodyRoom): NpcWorld {
  return {
    body: room.bodyDef,
    terrain: room.terrain,
    host: room.host,
    now: () => room.host.now(),
    players: () => room.host.players(),
    connected: () => room.actors.values(),
    addNpc: (n) => room.addNpc(n),
    removeNpc: (id) => room.removeNpc(id),
    newNpcState: () => room.newNpcState(),
    grantXp: (p, amount) => room.grantXp(p, amount),
    giveItem: (p, it) => room.giveItem(p, it),
    createPile: (owner, items, coins, at, deferred) => {
      room.createPile(owner, items, coins, at, deferred);
    },
    // Rewards touch any player here: a failed save puts their characters back (F12 B6).
    withTx: (fn) => room.persist([...room.host.players()], fn),
    snapToGround: (p) => room.snapToGround(p),
    send: (p, type, msg) => {
      if (room.actors.get(p.id) === p) p.client.send(type, msg);
    },
    broadcast: (type, msg) => room.broadcast(type as never, msg as never),
    onMessage: (type, handler) => {
      room.onMessage(type, (client, msg) => handler(client.sessionId, msg));
    },
    playerById: (id) => room.playerById(id),
    save: (p) => room.saveActor(p),
  };
}
