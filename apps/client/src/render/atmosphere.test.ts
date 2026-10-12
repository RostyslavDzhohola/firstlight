import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { SunRig } from "./atmosphere.ts";
import { LOOKS } from "./looks.ts";
import type { ResolvedSettings } from "./quality.ts";

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
