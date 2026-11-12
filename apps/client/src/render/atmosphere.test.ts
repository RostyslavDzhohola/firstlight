import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { fogNodeFor, SunRig } from "./atmosphere.ts";
import { LOOKS } from "./looks.ts";
import { emptyStored, resolveSettings, type Feature, type ResolvedSettings } from "./quality.ts";

const settings = (mode: "map" | "blob", mapSize = 2048) =>
  ({ on: { shadows: true, cascades: false }, shadows: { mode, mapSize, extent: 40, cascadeSize: 0, far: 200 } }) as unknown as ResolvedSettings;

describe("SunRig shadow settings (Chrome play-test: black world after Settings → Low)", () => {
  it("turning shadow maps off never stops the light casting or frees its map, and a new size is left to three", () => {
    // three disposes a light's shadow pass when castShadow goes false, while materials built
    // earlier still run it every frame: ShadowNode.updateShadow then reads a null map and the
    // whole frame throws (a black world with a live HUD).
    const rig = new SunRig(new THREE.Scene(), LOOKS.portus);
    rig.applySettings(settings("map", 2048));
    expect(rig.sun.castShadow).toBe(true);
    let disposed = 0;
    const map = { dispose: () => disposed++ } as unknown as THREE.RenderTarget;
    (rig.sun.shadow as { map: unknown }).map = map;

    rig.applySettings(settings("blob")); // Low: blob shadows, no map
    expect(rig.sun.castShadow).toBe(true);
    expect(rig.sun.shadow.autoUpdate).toBe(false);

    rig.applySettings(settings("map", 1024)); // back to a map tier, another size
    expect(rig.sun.shadow.map).toBe(map);
    expect(disposed).toBe(0);
    expect(rig.sun.shadow.mapSize.x).toBe(1024);
    expect(rig.sun.shadow.autoUpdate).toBe(true);
  });

  it("a rig that starts without shadow maps casts nothing until a map tier turns them on", () => {
    const rig = new SunRig(new THREE.Scene(), LOOKS.portus);
    rig.applySettings(settings("blob"));
    expect(rig.sun.castShadow).toBe(false);
    rig.applySettings(settings("map"));
    expect(rig.sun.castShadow).toBe(true);
  });
});

describe("fog graph variants (planet graphics review, finding 3)", () => {
  const on = (kills: Feature[] = [], tier: "low" | "medium" | "high" | "ultra" = "medium") => resolveSettings(tier, false, true, emptyStored(), new Set(kills)).on;

  it("none with the fog off, the plain graph with the far haze off, the aerial one otherwise", () => {
    const aerial = fogNodeFor(on());
    const plain = fogNodeFor(on(["aerial"]));
    expect(aerial).not.toBeNull();
    expect(plain).not.toBeNull();
    expect(plain).not.toBe(aerial);
    expect(fogNodeFor(on(["fog"]))).toBeNull();
    expect(fogNodeFor(on(["fog", "aerial"]))).toBeNull();
  });

  it("is one node per variant for the session: going back to a variant finds the shaders built with it", () => {
    const aerial = fogNodeFor(on());
    const plain = fogNodeFor(on(["aerial"]));
    expect(fogNodeFor(on())).toBe(aerial);
    expect(fogNodeFor(on(["aerial"]))).toBe(plain);
    expect(fogNodeFor({ fog: true, aerial: true })).toBe(aerial);
  });

  it("no tier switches the graph (the far haze is on at every tier), so a tier change rebuilds no fogged shader for it", () => {
    const nodes = (["low", "medium", "high", "ultra"] as const).map((t) => fogNodeFor(on([], t)));
    expect(new Set(nodes).size).toBe(1);
    expect(nodes[0]).toBe(fogNodeFor({ fog: true, aerial: true }));
  });
});
