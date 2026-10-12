// What an NPC system remembers across room instances of one copy (F12 B2, copyState.ts): the boss's
// respawn time after a kill, and spawn groups that are cleared (counting down to their respawn) or
// part-killed (dead members stay dead until the group is cleared, as in a live room). Survivors'
// HP is not kept: a despawned group respawns fresh in a live room too.

import type { NpcSystem } from "./NpcSystem.ts";
import type { SpawnPoint } from "./spawns.ts";

export const NPC_COPY_SYSTEM = "npc";

export interface NpcCopyState {
  v: 1;
  /** World time of the snapshot (ms): countdowns resume minus the time the copy was empty. */
  at: number;
  boss?: { id: string; respawnAt: number };
  /** p = spawn point id, sig = its make-up (content changes don't map state onto other groups). */
  groups: { p: number; sig: string; dead?: number[]; left?: number }[];
}

function sig(p: SpawnPoint): string {
  return `${p.kind}:${p.members.map((m) => m.def).join(".")}`;
}

/** The copy's state worth keeping, or null when there is nothing to remember. */
export function snapshotNpcCopy(sys: NpcSystem, now: number): NpcCopyState | null {
  const groups: NpcCopyState["groups"] = [];
  for (const g of sys.groups) {
    if (g.cleared) groups.push({ p: g.point.id, sig: sig(g.point), left: g.respawnLeft });
    else if (g.dead.some((d) => d)) groups.push({ p: g.point.id, sig: sig(g.point), dead: g.dead.flatMap((d, i) => (d ? [i] : [])) });
  }
  const b = sys.boss;
  const boss = b && b.status === "dead" && b.respawnAt > now ? { id: b.def.id, respawnAt: b.respawnAt } : undefined;
  if (!groups.length && !boss) return null;
  return { v: 1, at: now, groups, ...(boss ? { boss } : {}) };
}

/** Apply a snapshot to a freshly built system (no NPCs spawned yet). */
export function restoreNpcCopy(sys: NpcSystem, s: NpcCopyState | null, now: number) {
  if (!s || s.v !== 1) return;
  const away = Math.max(0, (now - s.at) / 1000);
  for (const e of s.groups ?? []) {
    const g = sys.groups[e.p];
    if (!g || sig(g.point) !== e.sig) continue;
    if (typeof e.left === "number") {
      // Nobody was near while the copy was empty: the countdown ran at full speed.
      const left = e.left - away;
      if (left > 0) {
        g.cleared = true;
        g.respawnLeft = left;
        g.dead.fill(true);
      }
    } else for (const i of e.dead ?? []) if (i >= 0 && i < g.dead.length) g.dead[i] = true;
  }
  const b = sys.boss;
  if (b && s.boss && s.boss.id === b.def.id && s.boss.respawnAt > now) {
    b.status = "dead";
    b.respawnAt = s.boss.respawnAt;
  }
}
