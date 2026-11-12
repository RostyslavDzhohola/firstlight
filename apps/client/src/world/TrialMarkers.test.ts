import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three/webgpu";
import { createTerrain, type BodyId } from "@firstlight/shared";
import { MISSION_BY_ID } from "@firstlight/shared/content/missions";
import type { TrialMsg } from "@firstlight/shared/net/protocol";
import { TrialMarkers } from "./TrialMarkers.ts";

const trial = (o: Partial<TrialMsg>): TrialMsg => ({ id: "T1", kind: "race", state: "running", progress: 3, goal: 8, leftMs: 41_000, limitMs: 75_000, next: "t1_ring_4", ...o });

function markers(body: BodyId) {
  const scene = new THREE.Scene();
  const m = new TrialMarkers(scene, body, createTerrain(body));
  const mesh = (name: string) => m.group.children.find((c) => c.name === `trialMarkers:${name}`) as THREE.InstancedMesh;
  const scaleAt = (mesh: THREE.InstancedMesh, i: number) => {
    const mx = new THREE.Matrix4();
    mesh.getMatrixAt(i, mx);
    return new THREE.Vector3().setFromMatrixScale(mx).x;
  };
  return { m, mesh, scaleAt };
}

afterEach(() => vi.restoreAllMocks());

describe("trial markers", () => {
  it("race rings: passed ones gone, the next one shown big, the rest pale; nothing without the mission", () => {
    const { m, mesh, scaleAt } = markers("arcadia");
    const rings = mesh("rings");
    const order = MISSION_BY_ID.get("T1")!.race!.rings;
    const index = (id: string): number => (m as any).rings.findIndex((s: any) => s.def.id === id);
    m.update(0.016, { missions: [], trial: null });
    expect(m.group.visible).toBe(false);
    m.update(0.016, { missions: [{ id: "T1", done: false }], trial: trial({ progress: 3 }) });
    expect(m.group.visible).toBe(true);
    expect(scaleAt(rings, index(order[0]!))).toBe(0);
    expect(scaleAt(rings, index(order[2]!))).toBe(0);
    expect(scaleAt(rings, index(order[3]!))).toBeGreaterThan(0.9); // the next ring, pulsing round 1
    expect(scaleAt(rings, index(order[5]!))).toBeCloseTo(0.85);
    m.update(0.016, { missions: [{ id: "T1", done: true }], trial: null });
    expect(m.group.visible).toBe(false);
  });

  it("ring posts: a tall beam over the next ring, a short dim one over later rings, none over passed ones", () => {
    const { m, mesh } = markers("arcadia");
    const posts = mesh("ringPosts");
    const order = MISSION_BY_ID.get("T1")!.race!.rings;
    const index = (id: string): number => (m as any).rings.findIndex((s: any) => s.def.id === id);
    const post = (k: number) => {
      const i = index(order[k]!);
      const mx = new THREE.Matrix4();
      posts.getMatrixAt(i, mx);
      const spot = (m as any).rings[i];
      const height = new THREE.Vector3().setFromMatrixScale(mx).y * 7;
      const centre = new THREE.Vector3().setFromMatrixPosition(mx).sub(spot.pos).dot(spot.up);
      return { height, base: centre - height / 2, top: centre + height / 2, glow: new THREE.Color().fromBufferAttribute(posts.instanceColor!, i).g };
    };
    m.update(0.016, { missions: [{ id: "T1", done: false }], trial: trial({ progress: 3 }) });
    expect(post(2).height).toBe(0); // passed
    expect(post(3).top).toBeGreaterThan(18); // clears grass and trees' lower branches, reads at 60 m
    expect(post(3).base).toBeGreaterThan(4); // starts above the ring, out of the runner's way
    expect(post(5).height).toBeCloseTo(4);
    expect(post(5).glow).toBeLessThan(post(3).glow / 2);
    expect((posts.material as THREE.Material).name).toBe("trialMarkerSoft"); // the pooled see-through material
    // Before the run starts the first ring carries the beam.
    m.update(0.016, { missions: [{ id: "T1", done: false }], trial: null });
    expect(post(0).height).toBeGreaterThan(15);
  });

  it("shards: taken pieces gone; the beacon shows while its mission is open", () => {
    const meridian = markers("meridian");
    const shards = meridian.mesh("shards");
    meridian.m.update(0.016, { missions: [{ id: "T3", done: false, counts: [1, 0, 0, 0, 0, 0, 0, 0] }], trial: null });
    const pieces = MISSION_BY_ID.get("T3")!.collect!.pieces;
    const at = (id: string) => (meridian.m as any).shards.findIndex((s: any) => s.def.id === id);
    expect(meridian.scaleAt(shards, at(pieces[0]!))).toBe(0);
    expect(meridian.scaleAt(shards, at(pieces[1]!))).toBeCloseTo(1);
    const hollow = markers("hollowmere");
    hollow.m.update(0.016, { missions: [{ id: "T2", done: false }], trial: trial({ id: "T2", kind: "defend", state: "paused" }) });
    expect(hollow.m.group.visible).toBe(true);
  });

  it("the beacon is a marker, not a floodlight: colours under the bloom threshold at night, a thin outline, see-through beam and fill", () => {
    const { m, mesh } = markers("hollowmere");
    const at = (m as any).beacons.findIndex((s: any) => s.def.mission === "T2");
    const colour = (name: string) => new THREE.Color().fromBufferAttribute(mesh(name).instanceColor!, at);
    const peak = (c: THREE.Color) => Math.max(c.r, c.g, c.b);
    for (const state of ["running", "paused"] as const) {
      m.update(0.016, { missions: [{ id: "T2", done: false }], trial: trial({ id: "T2", kind: "defend", state }) });
      // The solid outline takes the full night boost (2×); the post pass blooms from 1.25.
      expect(peak(colour("beaconRing")) * 2).toBeLessThanOrEqual(1.25);
      // Beam and fill are added light with a quarter of the boost (1.25× at night).
      expect(peak(colour("beaconColumn")) * 1.25).toBeLessThanOrEqual(1.25);
      expect(peak(colour("beaconFill"))).toBeLessThan(0.35);
    }
    const mx = new THREE.Matrix4();
    mesh("beaconRing").getMatrixAt(at, mx);
    const scale = new THREE.Vector3().setFromMatrixScale(mx);
    expect(scale.z * 0.012 * 2).toBeLessThan(0.15); // the band's height in metres (was over a metre)
    for (const name of ["beaconColumn", "beaconFill"]) {
      const mat = mesh(name).material as THREE.MeshBasicNodeMaterial;
      expect(mat.transparent).toBe(true);
      expect(mat.depthWrite).toBe(false);
      expect(mat.opacityNode).toBeTruthy();
    }
    expect(mesh("beaconColumn").material).toBe(mesh("beaconFill").material); // pooled
  });

  it("a frame allocates no lookup map and clones no quaternion (reused storage and scratch)", () => {
    const { m } = markers("hollowmere");
    const state = { missions: [{ id: "T2", done: false }, { id: "H4", done: false }], trial: trial({ id: "T2", kind: "defend" }) };
    m.update(0.016, state); // first frame fills the pool
    const clones = vi.spyOn(THREE.Quaternion.prototype, "clone");
    const RealMap = globalThis.Map;
    let maps = 0;
    globalThis.Map = class<K, V> extends RealMap<K, V> {
      constructor(entries?: readonly (readonly [K, V])[] | null) {
        super(entries);
        maps++;
      }
    } as MapConstructor;
    try {
      for (let i = 0; i < 30; i++) m.update(0.016, state);
    } finally {
      globalThis.Map = RealMap;
    }
    expect(clones).not.toHaveBeenCalled();
    expect(maps).toBe(0);
  });
});
