import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { WEAPONS } from "@firstlight/shared/content/weapons";
import { Effects } from "./effects.ts";
import { watchDisposals, type DisposalWatch } from "./disposeWatch.testutil.ts";

const v = (x: number, y = 500, z = 0) => new THREE.Vector3(x, y, z);

/** One of every effect the combat client spawns. */
function spawnAll(fx: Effects) {
  fx.tracer(v(0), v(5), 0x7af8ff);
  fx.flash(v(1), 0xffc46b);
  fx.explosion(v(2), 3, 0xffd166);
  fx.impact(v(3), 0xff6b9a);
  fx.arc(v(4), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), 2, 0xff8866);
  fx.spawnProjectile(1, Math.max(0, WEAPONS.findIndex((w) => w.id === "comet")), v(5), new THREE.Vector3(0, 0, 10), 9.8);
  fx.spawnProjectile(2, Math.max(0, WEAPONS.findIndex((w) => w.id === "longbow")), v(6), new THREE.Vector3(0, 0, 10), 9.8);
}

describe("Effects", () => {
  it("frees each effect mesh's render state when it ends, and an arc's own geometry; shared looks stay", () => {
    const fx = new Effects(new THREE.Scene());
    const before = new Set(fx.group.children);
    spawnAll(fx);
    const spawned = fx.group.children.filter((c) => !before.has(c));
    expect(spawned.length).toBe(8);
    const w: DisposalWatch = { all: new Set(), disposed: new Set() };
    for (const m of spawned) watchDisposals(m, w);
    const arc = spawned.find((m) => ((m as THREE.Mesh).geometry as THREE.TorusGeometry).parameters?.arc !== undefined && ((m as THREE.Mesh).geometry as THREE.TorusGeometry).parameters.arc < Math.PI * 2) as THREE.Mesh;
    expect(arc).toBeDefined();
    const now = performance.now();
    fx.update(0.016, now + 1000); // timed effects are over; projectiles still flying
    expect(fx.live).toBe(2);
    fx.endProjectile(1);
    fx.update(0.016, now + 7000); // the arrow times out
    expect(fx.live).toBe(0);
    for (const m of spawned) {
      expect(w.disposed.has(m)).toBe(true);
      expect(m.parent).toBeNull();
    }
    expect(w.disposed.has(arc.geometry)).toBe(true);
    const shared = [...w.all].filter((x) => !(x as THREE.Mesh).isMesh && x !== arc.geometry);
    expect(shared.length).toBeGreaterThan(3);
    for (const x of shared) expect(w.disposed.has(x)).toBe(false);
  });
});
