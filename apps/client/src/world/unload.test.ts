// Leaving a body frees what its views built (F12 S7): portals, quest props and loot piles.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { createTerrain, type BodyId } from "@firstlight/shared";
import { stubCanvasDocument, watchDisposals } from "../render/disposeWatch.testutil.ts";
import { PilesView } from "./PilesView.ts";
import { Portals } from "./Portals.ts";

let restore: () => void;
beforeAll(() => {
  restore = stubCanvasDocument(); // portal labels and quest plaques draw on canvases
});
afterAll(() => restore());

describe("Portals", () => {
  for (const body of ["portus", "arcadia"] as BodyId[]) {
    it(`frees every pad, ring, beam, portal and label on ${body}`, () => {
      const scene = new THREE.Scene();
      const portals = new Portals(scene, body, createTerrain(body));
      const w = watchDisposals(portals.group);
      expect(w.all.size).toBeGreaterThan(10);
      portals.dispose();
      expect(portals.group.parent).toBeNull();
      const missed = [...w.all].filter((x) => !w.disposed.has(x));
      expect(missed.map((x) => (x as { type?: string }).type)).toEqual([]);
    });
  }
});

describe("QuestWorld", () => {
  it("frees its own geometry, label textures and one-off materials, keeps the shared ones", async () => {
    const { QuestWorld } = await import("./QuestWorld.ts");
    const scene = new THREE.Scene();
    const world = new QuestWorld(scene, "portus", createTerrain("portus"));
    // NPC figures are avatars (released by AvatarView.dispose); watch only the props.
    const npcRoots = new Set(world.props.flatMap((p) => (p.npc ? [p.npc.root] : [])));
    const w = { all: new Set<object>(), disposed: new Set<object>() };
    for (const p of world.props) for (const c of p.root.children) if (!npcRoots.has(c as THREE.Group)) watchDisposals(c, w);
    world.dispose();
    expect(world.group.parent).toBeNull();
    const geometries = [...w.all].filter((x) => (x as THREE.BufferGeometry).isBufferGeometry);
    const textures = [...w.all].filter((x) => (x as THREE.Texture).isTexture);
    expect(geometries.length).toBeGreaterThan(5);
    expect(textures.length).toBeGreaterThan(1);
    for (const g of geometries) expect(w.disposed.has(g)).toBe(true);
    for (const t of textures) expect(w.disposed.has(t)).toBe(true);
    // Shared (cached) materials survive for the next body; label materials don't.
    const mats = [...w.all].filter((x) => (x as THREE.Material).isMaterial) as THREE.Material[];
    expect(mats.some((m) => !w.disposed.has(m))).toBe(true);
    expect(mats.filter((m) => (m as { map?: unknown }).map).every((m) => w.disposed.has(m))).toBe(true);
  });
});

describe("PilesView", () => {
  const pile = (x: number, items: number) => ({ x, y: 500, z: 0, items, coins: 0, owner: "a" });

  it("frees a pile's render state when it changes or goes, never the shared look", () => {
    const scene = new THREE.Scene();
    const piles = new PilesView(scene);
    const state = { piles: new Map<string, ReturnType<typeof pile>>([["p1", pile(0, 1)], ["p2", pile(5, 2)]]) };
    piles.update(state, 0.016);
    const groups = scene.children.filter((c) => c.type === "Group");
    expect(groups.length).toBeGreaterThanOrEqual(2);
    const w = { all: new Set<object>(), disposed: new Set<object>() };
    for (const g of groups) watchDisposals(g, w);
    const meshes = [...w.all].filter((x) => (x as THREE.Mesh).isMesh);
    state.piles.delete("p1");
    state.piles.set("p2", pile(5, 3)); // more items: rebuilt
    piles.update(state, 0.016);
    for (const m of meshes) expect(w.disposed.has(m)).toBe(true);
    const shared = [...w.all].filter((x) => !(x as THREE.Mesh).isMesh);
    expect(shared.length).toBeGreaterThan(0);
    for (const x of shared) expect(w.disposed.has(x)).toBe(false);
    piles.dispose();
  });
});
