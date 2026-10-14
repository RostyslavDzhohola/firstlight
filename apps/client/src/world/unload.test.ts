// Leaving a body frees what its views built (F12 S7): portals, quest props and loot piles.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { createTerrain, type BodyId } from "@firstlight/shared";
import { PLAQUES } from "@firstlight/shared/content/secrets";
import { emptyContact, PLAYER_BODY } from "@firstlight/shared/planet/collide";
import { hallBoardPlacement, HALL_STAND_SOLIDS, StructureCollider, structureCollider, townSolids } from "@firstlight/shared/planet/town";
import { stubCanvasDocument, watchDisposals } from "../render/disposeWatch.testutil.ts";
import { lookKey } from "../render/warmupLooks.testutil.ts";
import { pileSamples, PilesView } from "./PilesView.ts";
import { Portals } from "./Portals.ts";
import { LOOKS } from "../render/looks.ts";

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

describe("portal rings", () => {
  it("glow softer in Portus' town courts than on the planets, still over Portus' bloom threshold", () => {
    const peak = (body: BodyId) => {
      const portals = new Portals(new THREE.Scene(), body, createTerrain(body));
      let best = 0;
      portals.group.traverse((o) => {
        const m = o as THREE.Mesh;
        const p = (m.geometry as THREE.TorusGeometry | undefined)?.parameters as { radius?: number; tube?: number } | undefined;
        if (!m.isMesh || p?.radius !== 2.2 || p.tube !== 0.16) return;
        const c = (m.material as THREE.MeshBasicNodeMaterial).color;
        best = Math.max(best, c.r, c.g, c.b);
      });
      portals.dispose();
      return best;
    };
    const portus = peak("portus"), arcadia = peak("arcadia");
    expect(portus).toBeLessThan(arcadia * 0.6);
    expect(portus).toBeGreaterThan(LOOKS.portus.bloomThreshold);
  });
});

describe("Hall of Firsts board in the Portus town (browser round 1, item 2)", () => {
  it("is an opaque framed board in front of the hall, its heading low enough to read, clear of the hall", async () => {
    const { QuestWorld, HALL_BOARD } = await import("./QuestWorld.ts");
    const terrain = createTerrain("portus");
    const world = new QuestWorld(new THREE.Scene(), "portus", terrain);
    const hall = world.props.find((p) => p.def.look === "hall")!;
    hall.root.updateMatrixWorld(true);
    // Nothing see-through: every material of the board is opaque and writes depth.
    hall.root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (!m) return;
      expect(m.transparent, o.name || o.type).toBe(false);
      expect(m.opacity).toBe(1);
      expect(m.depthWrite).toBe(true);
    });
    // Its size in its own frame: about a 4 m board, the heading (top tenth of the face) under 4 m.
    const box = new THREE.Box3();
    const inv = hall.root.matrixWorld.clone().invert();
    hall.root.traverse((o) => {
      const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
      if (!g) return;
      g.computeBoundingBox();
      box.union(g.boundingBox!.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld)));
    });
    expect(box.max.y).toBeLessThan(4.8);
    expect(box.max.x - box.min.x).toBeLessThan(6);
    expect(HALL_BOARD.bottom + HALL_BOARD.h * 0.9).toBeLessThan(4);
    // Free-standing in front of the hall's steps: its footprint is outside every town structure
    // (the hall and its steps; the board's own stand is solid too, checked below).
    const town = new StructureCollider(townSolids(terrain).filter((x) => x.item >= 0).map((x, i) => ({ ...x, index: i })));
    for (const x of [box.min.x, box.max.x]) {
      for (const z of [box.min.z, box.max.z]) {
        const q = new THREE.Vector3(x, 0.05, z).applyMatrix4(hall.root.matrixWorld);
        expect(town.footing(q.x, q.y, q.z, PLAYER_BODY.step).inside).toBe(false);
        const c = { x: q.x, y: q.y, z: q.z };
        town.resolve(c, emptyContact());
        expect(Math.hypot(c.x - q.x, c.y - q.y, c.z - q.z)).toBeLessThan(PLAYER_BODY.radius); // at most brushing a step
      }
    }
    world.dispose();
  });

  it("draws its stand inside the shared stand solids, which block the player there (S4)", async () => {
    const { QuestWorld } = await import("./QuestWorld.ts");
    const terrain = createTerrain("portus");
    const world = new QuestWorld(new THREE.Scene(), "portus", terrain);
    const hall = world.props.find((p) => p.def.look === "hall")!;
    hall.root.updateMatrixWorld(true);
    const board = hallBoardPlacement(terrain)!;
    // The client's frame is the shared one (QuestWorld lifts its root 2 cm off the ground).
    const e = hall.root.matrixWorld.elements;
    expect(Math.hypot(e[0]! - board.rx, e[1]! - board.ry, e[2]! - board.rz)).toBeLessThan(1e-9);
    expect(Math.hypot(e[8]! - board.fx, e[9]! - board.fy, e[10]! - board.fz)).toBeLessThan(1e-9);
    // Every drawn volume of the stand (all but the painted face) lies in one of the shared solids.
    const inv = hall.root.matrixWorld.clone().invert();
    let volumes = 0;
    hall.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || (m.geometry as THREE.PlaneGeometry).type === "PlaneGeometry") return;
      m.geometry.computeBoundingBox();
      const b = m.geometry.boundingBox!.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
      const fits = HALL_STAND_SOLIDS.some(([, cx, cz, hx, hz, y0, y1]) =>
        b.min.x >= cx - hx - 0.025 && b.max.x <= cx + hx + 0.025 && b.min.z >= cz - hz - 0.025 && b.max.z <= cz + hz + 0.025 &&
        b.min.y >= y0 - 0.025 && b.max.y <= y1 + 0.025);
      expect(fits, `${m.name || m.type} at y ${b.min.y.toFixed(2)}–${b.max.y.toFixed(2)}`).toBe(true);
      volumes++;
    });
    expect(volumes).toBeGreaterThanOrEqual(6);
    // The shared collider the local player uses holds the stand: feet at the board are pushed out.
    const town = structureCollider(terrain)!;
    const q = new THREE.Vector3(0, 0.02, 0).applyMatrix4(hall.root.matrixWorld);
    expect(town.footing(q.x, q.y, q.z, PLAYER_BODY.step).inside).toBe(true);
    world.dispose();
  });
});

describe("Hall of Firsts board lettering (browser round 2)", () => {
  it("keeps every row clear of the brass border, with a bottom margin like the heading's top one", async () => {
    const { QuestWorld, hallBoardLayout } = await import("./QuestWorld.ts");
    // A canvas that records what setHall writes, with the font and baseline in force at the time.
    const texts: { text: string; y: number; px: number; baseline: string }[] = [];
    const strokes: number[][] = [];
    const state = { font: "", textBaseline: "alphabetic" };
    const ctx = new Proxy(state as Record<string, unknown>, {
      get: (t, k) =>
        k === "fillText" ? (text: string, _x: number, y: number) => texts.push({ text, y, px: Number(/(\d+)px/.exec(String(t.font))?.[1]), baseline: String(t.textBaseline) })
        : k === "strokeRect" ? (...a: number[]) => strokes.push(a)
        : k === "createLinearGradient" ? () => ({ addColorStop() {} })
        : k === "measureText" ? () => ({ width: 10 })
        : k in t ? t[k as string] : () => {},
      set: (t, k, v) => ((t[k as string] = v), true),
    });
    const g = globalThis as { document?: unknown };
    const prev = g.document;
    g.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx, style: {} }) };
    try {
      const world = new QuestWorld(new THREE.Scene(), "portus", createTerrain("portus"));
      const L = hallBoardLayout(PLAQUES.length);
      const [bx, by, bw, bh] = strokes.at(-1)!;
      expect([bx, by, bw, bh]).toEqual([L.border, L.border, 1024 - 2 * L.border, 768 - 2 * L.border]);
      const innerBottom = by! + bh! - L.stroke / 2;
      const at = texts.findIndex((t) => t.text === "HALL OF FIRSTS");
      const heading = texts[at]!;
      const topMargin = heading.y - heading.px * 0.72 - (by! + L.stroke / 2); // cap tops below the top border
      const rows = texts.slice(at + 1, at + 1 + PLAQUES.length * 2); // the board's rows (labels elsewhere draw too)
      expect(rows).toHaveLength(PLAQUES.length * 2); // label and claim per plaque
      for (const r of rows) {
        expect(r.baseline).toBe("middle");
        expect(r.px).toBeGreaterThanOrEqual(26); // legible: the rows keep about a 30 px font
        expect(r.y - r.px / 2).toBeGreaterThan(L.ruleY + 6); // below the heading's rule
      }
      const last = Math.max(...rows.map((r) => r.y + r.px / 2));
      expect(innerBottom - last).toBeGreaterThanOrEqual(Math.min(topMargin, 18));
      expect(L.pitch).toBeGreaterThanOrEqual(L.rowFont * 1.3);
      world.dispose();
    } finally {
      g.document = prev;
    }
  });
});

describe("PilesView", () => {
  const pile = (x: number, items: number) => ({ x, y: 500, z: 0, items, coins: 0, owner: "a" });

  it("frees a pile's render state when it changes or goes, never the shared look", () => {
    const scene = new THREE.Scene();
    const piles = new PilesView(scene);
    const state = { piles: new Map<string, ReturnType<typeof pile>>([["p1", pile(0, 1)], ["p2", pile(5, 2)]]) };
    piles.update(state, 0.016);
    const groups = scene.children.filter((c) => c.type === "Group" && c !== pileSamples());
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

describe("PilesView warm-up samples (S8)", () => {
  it("covers every pile look, stays hidden, and survives travel", () => {
    const scene = new THREE.Scene();
    const piles = new PilesView(scene);
    const samples = pileSamples();
    expect(samples.parent).toBe(scene);
    expect(samples.visible).toBe(false);
    const sampled = new Set(samples.children.map(lookKey));
    piles.update({ piles: new Map([["p", { x: 0, y: 500, z: 0, items: 6, coins: 5, owner: "a" }]]) }, 0.016);
    const meshes: THREE.Object3D[] = [];
    for (const c of scene.children) if (c !== samples) c.traverse((o) => (o as THREE.Mesh).isMesh && meshes.push(o));
    expect(meshes.length).toBeGreaterThan(4);
    for (const m of meshes) expect(sampled.has(lookKey(m))).toBe(true);
    const w = watchDisposals(samples);
    piles.dispose();
    const next = new PilesView(scene); // the next body's view reuses the same, still-compiled samples
    expect(pileSamples()).toBe(samples);
    expect(samples.parent).toBe(scene);
    expect(w.disposed.size).toBe(0);
    next.dispose();
  });
});
