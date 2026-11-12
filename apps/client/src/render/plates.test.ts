// @vitest-environment happy-dom
// Nameplates fade and shrink with range instead of popping, and health bars hang under them (D-gfx-hub-11).
import * as THREE from "three/webgpu";
import { afterEach, describe, expect, it } from "vitest";
import { PF } from "@firstlight/shared/net/schema";
import { Nameplates } from "./Cosmetics.ts";
import { BAR_FULL_HP_M, barShows, PLATE_FADE_M, PLATE_FULL_M, PLATE_RANGE_M, PlateBars, plateLook } from "./plates.ts";
import { BAR_MAX_GROW, BAR_NEAR_M, barGrow } from "../world/npcs/bars.ts";

const R = 500;
function camera(): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 500);
  cam.position.set(0, R + 2, 12);
  cam.lookAt(0, R + 1, -40);
  cam.updateMatrixWorld(true);
  return cam;
}
/** A point on the ground `z` m ahead of the camera's feet. */
const ahead = (z: number, x = 0) => new THREE.Vector3(x, R, 12 - z);
const me = new THREE.Vector3(0, R, 12);

describe("plateLook", () => {
  it("is whole up close, thins with range and reaches nothing at the edge without a jump", () => {
    expect(plateLook(3).opacity).toBe(1);
    expect(plateLook(PLATE_FULL_M).opacity).toBe(1);
    let last = 1;
    for (let d = PLATE_FULL_M; d <= PLATE_RANGE_M + 1; d += 0.5) {
      const o = plateLook(d).opacity;
      expect(o).toBeLessThanOrEqual(last + 1e-9);
      expect(last - o).toBeLessThan(0.05); // no pop
      last = o;
    }
    expect(plateLook(PLATE_FADE_M).opacity).toBeGreaterThan(0.55); // still readable at 46 m
    expect(plateLook(PLATE_RANGE_M).opacity).toBe(0);
    expect(plateLook(PLATE_RANGE_M + 30).opacity).toBe(0);
  });

  it("is a little larger at arm's length and never smaller than four fifths", () => {
    expect(plateLook(1).scale).toBeGreaterThan(1.05);
    expect(plateLook(14).scale).toBeCloseTo(1, 5);
    for (let d = 0; d < 90; d += 3) expect(plateLook(d).scale).toBeGreaterThanOrEqual(0.8 - 1e-9);
    const out = { opacity: 0, scale: 0 };
    expect(plateLook(20, out)).toBe(out); // no allocation per frame
  });
});

describe("Nameplates with range", () => {
  let plates: Nameplates | null = null;
  afterEach(() => {
    plates?.dispose();
    plates = null;
  });

  it("draws a far player's plate fainter and smaller, and none beyond the range", () => {
    plates = new Nameplates();
    plates.update(camera(), [
      { id: "near", pos: ahead(6), name: "Wren", title: "" },
      { id: "far", pos: ahead(50), name: "Moss", title: "Bellringer" },
      { id: "gone", pos: ahead(PLATE_RANGE_M + 5), name: "Fen", title: "" },
    ], me);
    const els = [...document.querySelectorAll<HTMLElement>(".fl-plate")];
    expect(els.map((e) => e.textContent)).toEqual(["Wren", "MossBellringer"]);
    const [near, far] = els as [HTMLElement, HTMLElement];
    expect(Number(near.style.opacity)).toBe(1);
    expect(Number(far.style.opacity)).toBeLessThan(0.6);
    expect(Number(far.style.opacity)).toBeGreaterThan(0.2);
    const scale = (e: HTMLElement) => Number(/scale\(([\d.]+)\)/.exec(e.style.transform)![1]);
    expect(scale(near)).toBeGreaterThan(1);
    expect(scale(far)).toBeLessThan(0.9);
    // The plate keeps its anchor: centred on the player, sitting on the point above the head.
    expect(far.style.transform).toContain("translate(-50%, -100%)");
  });
});

describe("PlateBars", () => {
  let bars: PlateBars | null = null;
  afterEach(() => {
    bars?.dispose();
    bars = null;
  });
  const players = (list: Record<string, { hp: number; maxHp: number; flags: number }>) => ({ get: (id: string) => list[id] });
  const avatars = (list: Record<string, THREE.Vector3>) => new Map(Object.entries(list).map(([id, p]) => [id, { root: Object.assign(new THREE.Object3D(), {}) }] as const).map(([id, a]) => (a.root.position.copy(list[id]!), [id, a] as const)));

  it("barShows: a hurt player's bar as far as the plate, a full one only near", () => {
    expect(barShows(60, 100, 50)).toBe(true);
    expect(barShows(100, 100, 50)).toBe(false);
    expect(barShows(100, 100, BAR_FULL_HP_M - 1)).toBe(true);
    expect(barShows(60, 100, PLATE_RANGE_M)).toBe(false);
    expect(barShows(0, 0, 5)).toBe(false);
  });

  it("hangs a bar under each living player in range, filled to their health, red when low", () => {
    bars = new PlateBars();
    const av = avatars({ a: ahead(6, -1), b: ahead(40, 2), c: ahead(8, 3), dead: ahead(7, 0), full: ahead(40, -4) });
    const st = { a: { hp: 100, maxHp: 100, flags: 0 }, b: { hp: 20, maxHp: 100, flags: 0 }, c: { hp: 55, maxHp: 110, flags: 0 }, dead: { hp: 0, maxHp: 100, flags: PF.DEAD }, full: { hp: 100, maxHp: 100, flags: 0 } };
    bars.sync(camera(), av, players(st), me);
    const els = [...document.querySelectorAll<HTMLElement>(".fl-platebar")];
    expect(els).toHaveLength(3); // not the dead one, not the far one at full health
    const fills = els.map((e) => e.querySelector("i")!.style.transform);
    expect(fills).toEqual(["scaleX(1.000)", "scaleX(0.200)", "scaleX(0.500)"]);
    expect(els.map((e) => e.classList.contains("low"))).toEqual([false, true, false]);
    // Under the anchor (the plate sits above it), fainter at range.
    for (const e of els) expect(e.style.transform).toContain("translate(-50%, 3px)");
    expect(Number(els[1]!.style.opacity)).toBeLessThan(Number(els[0]!.style.opacity));

    // Health changes and a death follow on the next frame; the bar's element is reused.
    st.c.hp = 11;
    st.a.flags = PF.DEAD;
    bars.sync(camera(), av, players(st), me);
    const after = [...document.querySelectorAll<HTMLElement>(".fl-platebar")];
    expect(after).toHaveLength(2);
    expect(after[1]).toBe(els[2]);
    expect(after[1]!.querySelector("i")!.style.transform).toBe("scaleX(0.100)");
    expect(after[1]!.classList.contains("low")).toBe(true);
  });
});

describe("creature health bars", () => {
  it("keep their size on screen from the near range out, up to a cap", () => {
    expect(barGrow(4)).toBe(1);
    expect(barGrow(BAR_NEAR_M)).toBe(1);
    expect(barGrow(BAR_NEAR_M * 2)).toBe(2);
    expect(barGrow(500)).toBe(BAR_MAX_GROW);
  });
});
