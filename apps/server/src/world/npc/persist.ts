// What an NPC system remembers across room instances of one copy (F12 B2, copyState.ts): the boss's
// respawn time after a kill or its engaged fight (until the 30 s vacancy reset would have run),
// spawn groups that are cleared (counting down to their respawn) or part-killed (dead members stay
// dead until the group is cleared, as in a live room), and when each popped Golden Hopbit returns. Survivors' HP is not kept: a despawned
// group respawns fresh in a live room too.

import type { BossFight } from "./boss.ts";
import type { NpcSystem } from "./NpcSystem.ts";
import type { SpawnPoint } from "./spawns.ts";
import { NPC_TUNING } from "./tuning.ts";

export const NPC_COPY_SYSTEM = "npc";

export interface NpcCopyState {
  v: 1;
  /** World time of the snapshot (ms): countdowns resume minus the time the copy was empty. */
  at: number;
  boss?: { id: string; respawnAt: number };
  /** An engaged boss fight (HP, phase, cover, credit) and when its arena emptied. */
  fight?: BossFight;
  /**
   * p = spawn point id, sig = its make-up, k = make-up and place. Ids shift when a layout change
   * adds or drops a group, so state follows k; entries without one (older saves) can't be placed
   * safely and are dropped (those groups just start fresh).
   */
  groups: { p: number; sig: string; k?: string; dead?: number[]; left?: number }[];
  /** Golden Hopbits that were popped or ran into their burrow: [spawn point id, return time (ms), k]. */
  golden?: [number, number, string?][];
}

function sig(p: SpawnPoint): string {
  return `${p.kind}:${p.members.map((m) => m.def).join(".")}`;
}

/** A spawn point's identity across layout changes: its make-up and where it stands (to ~5 mm on Arcadia). */
export function spawnKey(p: SpawnPoint): string {
  return `${sig(p)}@${p.dir.map((v) => Math.round(v * 1e5)).join(",")}`;
}

/** The copy's state worth keeping, or null when there is nothing to remember. */
export function snapshotNpcCopy(sys: NpcSystem, now: number): NpcCopyState | null {
  const groups: NpcCopyState["groups"] = [];
  for (const g of sys.groups) {
    const id = { p: g.point.id, sig: sig(g.point), k: spawnKey(g.point) };
    if (g.cleared) groups.push({ ...id, left: g.respawnLeft });
    else if (g.dead.some((d) => d)) groups.push({ ...id, dead: g.dead.flatMap((d, i) => (d ? [i] : [])) });
  }
  const b = sys.boss;
  const boss = b && b.status === "dead" && b.respawnAt > now ? { id: b.def.id, respawnAt: b.respawnAt } : undefined;
  const fight = b?.fightState(now) ?? undefined;
  // Absolute times; an expired one is kept too, so a restored dead slot still comes back (NpcSystem scan).
  const golden: [number, number, string?][] = [...sys.goldenBack].map(([p, back]) => {
    const pt = sys.groups[p]?.point;
    return pt ? [p, back, spawnKey(pt)] : [p, back];
  });
  if (!groups.length && !boss && !fight && !golden.length) return null;
  return { v: 1, at: now, groups, ...(boss ? { boss } : {}), ...(fight ? { fight } : {}), ...(golden.length ? { golden } : {}) };
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === "string";

/** A kept fight in the shape resumeFight reads (a malformed row must not break the boss later). */
function validFight(f: unknown): f is BossFight {
  if (!f || typeof f !== "object") return false;
  const x = f as Record<string, unknown>;
  return (
    str(x.id) && num(x.vacantSince) && num(x.frac) && num(x.phase) &&
    Array.isArray(x.cover) && x.cover.every((c) => Array.isArray(c) && num(c[0]) && num(c[1])) &&
    Array.isArray(x.damage) && x.damage.every((d) => Array.isArray(d) && str(d[0]) && str(d[1]) && num(d[2])) &&
    Array.isArray(x.plates) && x.plates.every(str) && Array.isArray(x.soakers) && x.soakers.every(str)
  );
}

/**
 * Apply a snapshot to a freshly built system (no NPCs spawned yet). Entries that aren't in the
 * shape snapshotNpcCopy writes are skipped (a malformed row never stops a room opening).
 */
export function restoreNpcCopy(sys: NpcSystem, s: NpcCopyState | null, now: number) {
  if (!s || typeof s !== "object" || s.v !== 1) return;
  const away = num(s.at) ? Math.max(0, (now - s.at) / 1000) : 0;
  const byKey = new Map(sys.groups.map((g) => [spawnKey(g.point), g]));
  for (const e of Array.isArray(s.groups) ? s.groups : []) {
    if (!e || typeof e !== "object" || !str(e.k)) continue;
    const g = byKey.get(e.k);
    if (!g) continue;
    if (num(e.left)) {
      // Nobody was near while the copy was empty: the countdown ran at full speed.
      const left = e.left - away;
      if (left > 0) {
        g.cleared = true;
        g.respawnLeft = left;
        g.dead.fill(true);
      }
    } else if (Array.isArray(e.dead)) for (const i of e.dead) if (num(i) && i >= 0 && i < g.dead.length) g.dead[i] = true;
  }
  // A return time without a place (older save) can't be matched to its pack: hold every Golden
  // Hopbit until the latest such time, so a popped one never comes back early.
  let unplaced = 0;
  for (const entry of Array.isArray(s.golden) ? s.golden : []) {
    if (!Array.isArray(entry)) continue;
    const [, back, k] = entry;
    if (!num(back)) continue;
    if (!str(k)) {
      unplaced = Math.max(unplaced, back);
      continue;
    }
    const pt = byKey.get(k)?.point;
    if (pt && pt.members.some((m) => m.golden)) sys.goldenBack.set(pt.id, Math.max(back, sys.goldenBack.get(pt.id) ?? 0));
  }
  if (unplaced) {
    for (const g of sys.groups) {
      if (g.point.members.some((m) => m.golden)) sys.goldenBack.set(g.point.id, Math.max(unplaced, sys.goldenBack.get(g.point.id) ?? 0));
    }
  }
  const b = sys.boss;
  if (b && s.boss && str(s.boss.id) && s.boss.id === b.def.id && num(s.boss.respawnAt) && s.boss.respawnAt > now) {
    b.status = "dead";
    b.respawnAt = s.boss.respawnAt;
  } else if (b && validFight(s.fight) && s.fight.id === b.def.id && now - s.fight.vacantSince < NPC_TUNING.bossResetMs) {
    // Empty for less than the 30 s reset: the fight resumes when the boss next spawns (boss.ts).
    b.pendingFight = s.fight;
  }
}
