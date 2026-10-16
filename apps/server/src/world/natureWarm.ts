// Natural solids (D-solid-1) are built per terrain chunk on first use, 0.2–1.2 ms each: a tick in
// which players or NPCs walk into new land would otherwise pay for several at once (the NPC bench
// on Hollowmere: p95 12.8 ms instead of 0.6). Each tick this builds the chunks round the players
// ahead of time, within a small time budget: out to where creeps are awake round them (the spawn
// points' despawn radius), nearest first, each player in turn, and skips a player whose
// surroundings were complete until they have moved on.

import type { NatureSolids } from "@firstlight/shared";
import { NPC_TUNING } from "./npc/index.ts";

/** Time per tick (ms) spent building chunks ahead (a build that has started finishes). */
export const NATURE_WARM_MS = 2;
/** Re-check a player's surroundings once they are this far (m) from where they were complete. */
const REWARM_AFTER = 40;

interface At {
  state: { x: number; y: number; z: number };
}

export class NatureWarmer<A extends At> {
  private readonly done = new WeakMap<A, { x: number; y: number; z: number }>();
  private readonly list: A[] = [];
  private turn = 0;
  private readonly nature: NatureSolids;

  constructor(nature: NatureSolids) {
    this.nature = nature;
  }

  /** Spend up to NATURE_WARM_MS building the chunks round `players`. */
  tick(players: Iterable<A>): void {
    const list = this.list;
    list.length = 0;
    for (const a of players) list.push(a);
    const n = list.length;
    if (n === 0) return;
    // Out to where the creeps round a player are awake, plus their roam.
    const radius = NPC_TUNING.despawnRadius + 40;
    const end = performance.now() + NATURE_WARM_MS;
    const start = this.turn % n;
    for (let j = 0; j < n; j++) {
      const i = (start + j) % n;
      const a = list[i]!, s = a.state;
      const d = this.done.get(a);
      if (d && (s.x - d.x) ** 2 + (s.y - d.y) ** 2 + (s.z - d.z) ** 2 < REWARM_AFTER * REWARM_AFTER) continue;
      const left = end - performance.now();
      if (left <= 0) {
        this.turn = i;
        break;
      }
      this.nature.warm(s.x, s.y, s.z, radius, Infinity, left);
      if (this.nature.pending > 0) {
        this.turn = i;
        break;
      }
      if (d) {
        d.x = s.x;
        d.y = s.y;
        d.z = s.z;
      } else this.done.set(a, { x: s.x, y: s.y, z: s.z });
    }
    list.length = 0;
  }
}
