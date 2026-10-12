// Saved spawn-group state must follow the group, not its index: a layout change (the play-test pass
// moved hostile spawns off the landing pads) shifts point ids, and matching by id + make-up alone
// put one pack's cleared timer on another pack and dropped the Golden Hopbit's cooldown.

import { describe, expect, it } from "vitest";
import { createTerrain } from "@firstlight/shared";
import { bossArena } from "@firstlight/shared/content/arenas";
import type { NpcSystem } from "../src/world/npc/NpcSystem.ts";
import { restoreNpcCopy, snapshotNpcCopy, spawnKey, type NpcCopyState } from "../src/world/npc/persist.ts";
import { buildSpawnPoints, type SpawnPoint } from "../src/world/npc/spawns.ts";

/** Just the parts of NpcSystem that the copy state reads and writes. */
function fakeSystem(points: SpawnPoint[]) {
  const sys = {
    groups: points.map((point) => ({ point, dead: point.members.map(() => false), cleared: false, respawnLeft: 0 })),
    boss: null,
    goldenBack: new Map<number, number>(),
  };
  return sys as typeof sys & NpcSystem;
}

const terrain = createTerrain("arcadia");
const layout = buildSpawnPoints(terrain, bossArena(terrain));
/** The same layout with one extra group in front: every later id moves up by one. */
function shifted(): SpawnPoint[] {
  const extra: SpawnPoint = { ...layout[0]!, dir: [layout[0]!.dir[1], layout[0]!.dir[2], layout[0]!.dir[0]] };
  return [extra, ...layout].map((p, id) => ({ ...p, id }));
}
const now = 1_000_000;

describe("spawn-group copy state across a layout change", () => {
  it("a cleared pack and a popped Golden Hopbit keep their timers when ids shift", () => {
    const pack = layout.find((p) => p.kind === "pack" && p.members.length >= 3 && !p.members.some((m) => m.golden))!;
    const golden = layout.find((p) => p.members.some((m) => m.golden))!;
    const before = fakeSystem(layout);
    before.groups[pack.id]!.cleared = true;
    before.groups[pack.id]!.dead.fill(true);
    before.groups[pack.id]!.respawnLeft = 100;
    before.goldenBack.set(golden.id, now + 15 * 60_000);
    const saved = snapshotNpcCopy(before, now);

    const after = fakeSystem(shifted());
    restoreNpcCopy(after, saved, now + 10_000);
    const cleared = after.groups.filter((g) => g.cleared);
    expect(cleared.map((g) => spawnKey(g.point))).toEqual([spawnKey(pack)]);
    expect(cleared[0]!.point.id).toBe(pack.id + 1);
    expect(cleared[0]!.respawnLeft).toBeCloseTo(90, 5);
    expect([...after.goldenBack]).toEqual([[golden.id + 1, now + 15 * 60_000]]);
  });

  it("an older save without places drops its group state, and holds every Golden Hopbit until its latest return", () => {
    const pack = layout.find((p) => p.kind === "pack" && !p.members.some((m) => m.golden))!;
    const sig = `${pack.kind}:${pack.members.map((m) => m.def).join(".")}`;
    const legacy: NpcCopyState = { v: 1, at: now, groups: [{ p: pack.id, sig, left: 100 }], golden: [[3, now + 60_000], [4, now + 120_000]] };
    const after = fakeSystem(shifted());
    restoreNpcCopy(after, legacy, now + 1000);
    expect(after.groups.some((g) => g.cleared || g.dead.some((d) => d))).toBe(false);
    const goldens = after.groups.filter((g) => g.point.members.some((m) => m.golden));
    expect(goldens.length).toBeGreaterThan(0);
    for (const g of goldens) expect(after.goldenBack.get(g.point.id)).toBe(now + 120_000);
    expect(after.goldenBack.size).toBe(goldens.length);
  });

  it("a server from before keys (rollback) skips new saves instead of clearing another pack", () => {
    const pack = layout.find((p) => p.kind === "pack" && p.members.length >= 3 && !p.members.some((m) => m.golden))!;
    const golden = layout.find((p) => p.members.some((m) => m.golden))!;
    const before = fakeSystem(shifted());
    before.groups[pack.id + 1]!.cleared = true;
    before.groups[pack.id + 1]!.dead.fill(true);
    before.groups[pack.id + 1]!.respawnLeft = 100;
    before.goldenBack.set(golden.id + 1, now + 15 * 60_000);
    const saved = JSON.parse(JSON.stringify(snapshotNpcCopy(before, now))) as NpcCopyState;
    // main's reader (c9ddf29 persist.ts): groups by numeric p + make-up, Goldens by numeric id.
    const old = fakeSystem(layout);
    const sigOf = (p: SpawnPoint) => `${p.kind}:${p.members.map((m) => m.def).join(".")}`;
    for (const e of saved.groups) {
      if (typeof e.p !== "number") continue;
      const g = old.groups[e.p];
      if (g && sigOf(g.point) === e.sig) g.cleared = true;
    }
    for (const [p, back] of saved.golden ?? []) {
      const pt = old.groups[p]?.point;
      if (pt && pt.members.some((m) => m.golden)) old.goldenBack.set(p, back);
    }
    expect(old.groups.some((g) => g.cleared)).toBe(false);
    expect(old.goldenBack.size).toBe(0);
  });

  it("the same layout restores exactly as before (round trip)", () => {
    const pack = layout.find((p) => p.kind === "pack" && p.members.length >= 3)!;
    const before = fakeSystem(layout);
    before.groups[pack.id]!.dead[1] = true;
    const after = fakeSystem(layout);
    restoreNpcCopy(after, snapshotNpcCopy(before, now), now);
    expect(after.groups[pack.id]!.dead).toEqual(pack.members.map((_, i) => i === 1));
    expect(after.groups.filter((g) => g.dead.some((d) => d))).toHaveLength(1);
  });
});
