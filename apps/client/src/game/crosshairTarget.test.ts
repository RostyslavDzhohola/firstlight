import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";
import { crosshairTarget, type CrosshairQuery, type Posed } from "./crosshairTarget.ts";

// A flat-enough patch on top of a big planet: up is +y, we stand at the surface looking along +x.
const R = 10000;
const list = (items: [string, Posed][]) => ({ forEach: (cb: (v: Posed, id: string) => void) => items.forEach(([id, v]) => cb(v, id)) });

function scene(opts: { npcs?: [string, Posed][]; players?: [string, Posed][]; wallAt?: number; hill?: { from: number; h: number } } = {}): CrosshairQuery {
  const me = new THREE.Vector3(0, R, 0);
  return {
    o: new THREE.Vector3(-3, R + 2, 0), // the camera behind the head
    d: new THREE.Vector3(1, 0, 0),
    me,
    radius: R,
    // A ridge from x = hill.from on (a direction's x component times R is about x here).
    terrain: { groundHeight: (nx) => (opts.hill && nx * R > opts.hill.from ? opts.hill.h : 0) },
    solids: [opts.wallAt === undefined ? null : { raycast: (o, _d, maxT) => (opts.wallAt! - o.x <= maxT && opts.wallAt! > o.x ? opts.wallAt! - o.x : Infinity) }],
    npcs: list(opts.npcs ?? []),
    players: list(opts.players ?? []),
    selfId: "me",
  };
}

const creep: Posed = { x: 20, y: R + 1.2, z: 0, hp: 10 };

describe("crosshairTarget: the nearest unobstructed thing under the crosshair (review #9)", () => {
  it("a creature in the open is the target", () => {
    expect(crosshairTarget(scene({ npcs: [["c", creep]] }), 60).kind).toBe("npc");
  });

  it("a creature behind a wall is not", () => {
    expect(crosshairTarget(scene({ npcs: [["c", creep]], wallAt: 10 }), 60).kind).toBe(null);
  });

  it("a creature behind a hill is not", () => {
    expect(crosshairTarget(scene({ npcs: [["c", creep]], hill: { from: 12, h: 5 } }), 60).kind).toBe(null);
  });

  it("a nearer player blocks the creature behind them (no aim help against a person)", () => {
    const player: Posed = { x: 10, y: R + 1, z: 0 };
    expect(crosshairTarget(scene({ npcs: [["c", creep]], players: [["p", player]] }), 60).kind).toBe("player");
  });

  it("our own body and dead creatures don't count; out of range is nothing", () => {
    const self: Posed = { x: 5, y: R + 1, z: 0 };
    expect(crosshairTarget(scene({ npcs: [["c", creep]], players: [["me", self]] }), 60).kind).toBe("npc");
    expect(crosshairTarget(scene({ npcs: [["c", { ...creep, hp: 0 }]] }), 60).kind).toBe(null);
    expect(crosshairTarget(scene({ npcs: [["c", creep]] }), 10).kind).toBe(null);
  });
});
