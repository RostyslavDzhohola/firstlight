// A socket-free NpcWorld for unit tests and the AI tick benchmark: real terrain, real NpcSystem,
// plain player records, a manual clock.

import { BODIES, createTerrain, type BodyId } from "@firstlight/shared";
import { structureCollider } from "@firstlight/shared/planet/sites";
import { newCharacter } from "@firstlight/shared/content/character";
import { maxHp } from "@firstlight/shared/content/progression";
import { NpcState, PlayerState } from "@firstlight/shared/net/schema";
import { pushHistory, type NpcActor, type PlayerActor } from "../src/world/actors.ts";
import type { CombatHost } from "../src/world/combat.ts";
import type { V3 } from "../src/world/geometry.ts";
import { NpcSystem } from "../src/world/npc/NpcSystem.ts";
import type { NpcWorld } from "../src/world/npc/world.ts";

export interface FakeWorld {
  world: NpcWorld;
  sys: NpcSystem;
  clock: { t: number };
  players: Map<string, PlayerActor>;
  npcs: Map<string, NpcActor>;
  sent: { to: string; type: string; msg: unknown }[];
  /** Players heal to full instead of dying (benchmarks). */
  immortal: boolean;
  addPlayer(id: string, pos: V3, level?: number): PlayerActor;
  movePlayer(p: PlayerActor, pos: V3): void;
  step(ms?: number): number;
}

export function fakeWorld(body: BodyId, opts: { immortal?: boolean; start?: number; copyKey?: string } = {}): FakeWorld {
  const terrain = createTerrain(body);
  const clock = { t: opts.start ?? 1_000_000 };
  const players = new Map<string, PlayerActor>();
  const npcs = new Map<string, NpcActor>();
  const sent: FakeWorld["sent"] = [];
  const fw = { immortal: !!opts.immortal } as FakeWorld;
  const host: CombatHost = {
    terrain,
    walls: structureCollider(terrain),
    now: () => clock.t,
    players: () => players.values(),
    npcs: () => npcs.values(),
    broadcast: () => {},
    broadcastNear: (type, msg, at, radius) => {
      const r2 = radius * radius;
      for (const p of players.values()) {
        const dx = p.state.x - at[0], dy = p.state.y - at[1], dz = p.state.z - at[2];
        if (dx * dx + dy * dy + dz * dz <= r2 && sent.length < 10_000) sent.push({ to: p.id, type, msg });
      }
    },
    onDamage: (target, _amount, attacker) => {
      if (target.kind === "npc") {
        if (target.state.hp <= 0) target.onKilled?.(attacker?.id ?? null);
      } else if (target.state.hp <= 0) {
        if (fw.immortal) target.state.hp = target.state.maxHp;
        else target.dead = true;
      }
    },
  };
  const world: NpcWorld = {
    body: BODIES[body],
    terrain,
    host,
    ...(opts.copyKey ? { copyKey: opts.copyKey } : {}),
    now: () => clock.t,
    players: () => players.values(),
    connected: () => players.values(),
    addNpc: (n) => npcs.set(n.id, n),
    removeNpc: (id) => npcs.delete(id),
    newNpcState: () => new NpcState(),
    addXp: (p, amount) => {
      p.char.xp += amount;
      return () => {};
    },
    giveItem: () => true,
    createPile: () => {},
    withTx: (_players, fn) => fn(),
    snapToGround: (p) => {
      const l = Math.hypot(p[0]!, p[1]!, p[2]!);
      const r = BODIES[body].radius + Math.max(terrain.groundHeight(p[0]! / l, p[1]! / l, p[2]! / l), BODIES[body].waterLevel - 1.05);
      return [(p[0]! / l) * r, (p[1]! / l) * r, (p[2]! / l) * r];
    },
    send: (p, type, msg) => {
      if (sent.length < 10_000) sent.push({ to: p.id, type, msg });
    },
    broadcast: () => {},
    onMessage: () => {},
    playerById: (id) => players.get(id),
    save: () => {},
    stillAdmin: (p) => !!p.identity.admin,
  };
  const sys = new NpcSystem(world);
  Object.assign(fw, {
    world,
    sys,
    clock,
    players,
    npcs,
    sent,
    addPlayer(id: string, pos: V3, level = 10): PlayerActor {
      const state = new PlayerState();
      state.x = pos[0];
      state.y = pos[1];
      state.z = pos[2];
      state.level = level;
      state.maxHp = maxHp(level);
      state.hp = state.maxHp;
      const char = newCharacter(0, 0, clock.t);
      char.level = level;
      const a = {
        kind: "player",
        id,
        client: null,
        identity: { userId: `u-${id}`, name: id, admin: false, loadtest: false },
        char,
        state,
        history: [],
        lastX: pos[0],
        lastY: pos[1],
        lastZ: pos[2],
        lastMoveAt: clock.t,
        joinedAt: clock.t,
        violations: 0,
        lastAttackAt: 0,
        reloadEndsAt: 0,
        heat: 0,
        overheatUntil: 0,
        blocking: false,
        combatUntil: 0,
        protectedUntil: 0,
        heals: [],
        burn: null,
        healCooldownUntil: 0,
        tonicCooldownUntil: 0,
        logoutEndsAt: null,
        dead: false,
        diedAt: 0,
        lastDamagedBy: null,
        youDirty: false,
      } as unknown as PlayerActor;
      players.set(id, a);
      return a;
    },
    movePlayer(p: PlayerActor, pos: V3) {
      p.state.x = pos[0];
      p.state.y = pos[1];
      p.state.z = pos[2];
    },
    /** Advance the clock one tick and run the system; returns the tick's wall time (ms). */
    step(ms = 50): number {
      clock.t += ms;
      for (const p of players.values()) pushHistory(p, clock.t);
      for (const n of npcs.values()) pushHistory(n, clock.t);
      const t0 = performance.now();
      sys.tick(ms, clock.t);
      return performance.now() - t0;
    },
  });
  return fw;
}
