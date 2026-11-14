// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createTerrain } from "@firstlight/shared";
import { prefabPoint, wildSitePlacements } from "@firstlight/shared/planet/wildSites";
import { Compass } from "../social/compass.ts";
import { LANDMARK_SIGHT_M, SITE_SIGHT_M, siteCompassMarkers } from "./siteCompass.ts";

const terrain = createTerrain("arcadia");
const sites = wildSitePlacements(terrain);
const watch = sites.find((p) => p.site.id === "bellwether_watch")!;
const arch = sites.find((p) => p.site.kind === "landmark")!;
/** Feet on prefab point (x, z) of a site, `up` metres over its base. */
const near = (p: typeof watch, x: number, z: number) => prefabPoint(p.frame, x, z, 0);
const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

describe("undiscovered wild sites on the compass", () => {
  it("marks a site within sight with a '?' until this life finds it", () => {
    const at = near(watch, 0, 120);
    const marks = siteCompassMarkers(terrain, at, new Set());
    const m = marks.find((x) => x.key === "site:bellwether_watch")!;
    expect(m).toMatchObject({ label: "?", kind: "site" });
    expect(siteCompassMarkers(terrain, at, new Set(["bellwether_watch"])).some((x) => x.key === "site:bellwether_watch")).toBe(false);
  });

  it("leaves out sites beyond sight; a landmark is seen from twice as far", () => {
    for (const p of [watch, arch]) {
      const sight = p.site.kind === "landmark" ? LANDMARK_SIGHT_M : SITE_SIGHT_M;
      for (const [m, shown] of [[sight - 20, true], [sight + 40, false]] as const) {
        const at = near(p, 0, m);
        const site = p.frame;
        expect(dist(at, [site.px, site.py, site.pz])).toBeGreaterThan(m - 5);
        expect(siteCompassMarkers(terrain, at, new Set()).some((x) => x.key === `site:${p.site.id}`), `${p.site.id} at ${m} m`).toBe(shown);
      }
    }
    expect(LANDMARK_SIGHT_M).toBe(2 * SITE_SIGHT_M);
  });

  it("shows the marker with its distance ahead and hides it behind (not pinned like the mission's)", () => {
    const compass = new Compass(document.body);
    const at = near(watch, 0, 100);
    const marks = siteCompassMarkers(terrain, at, new Set()).filter((x) => x.key === "site:bellwether_watch");
    const toward = [marks[0]!.pos[0] - at[0], marks[0]!.pos[1] - at[1], marks[0]!.pos[2] - at[2]];
    const l = Math.hypot(at[0], at[1], at[2]);
    const up = at.map((v) => v / l);
    const k = toward[0]! * up[0]! + toward[1]! * up[1]! + toward[2]! * up[2]!;
    const f = toward.map((v, i) => v - k * up[i]!);
    const fl = Math.hypot(...f);
    const ahead = f.map((v) => v / fl) as [number, number, number];
    compass.update(at, ahead, "arcadia", false, marks);
    const e = document.querySelector<HTMLElement>('[data-e2e="compass-site"]')!;
    expect(e.textContent).toMatch(/^\? 100 m$/);
    expect(e.style.display).toBe("");
    compass.update(at, ahead.map((v) => -v) as [number, number, number], "arcadia", false, marks);
    expect(e.style.display).toBe("none");
    compass.dispose();
  });
});
