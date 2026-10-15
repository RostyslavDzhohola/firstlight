import { describe, expect, it } from "vitest";
import { BODIES } from "@firstlight/shared";
import { placeDir } from "@firstlight/shared/content/places";
import type { V3 } from "../social/compassMath.ts";
import { mapView, offsetDir } from "./mapView.ts";
import { drawMissionStars, drawPartyMarkers, drawWaypointMarker } from "./minimapMarkers.ts";

/** A canvas context that records what is drawn. */
function recorder() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (t, k: string) => (k in t ? t[k] : (...args: unknown[]) => void calls.push({ fn: k, args })),
    set: (t, k: string, v) => ((t[k] = v), true),
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

const R = BODIES.arcadia.radius;
const SIZE = 176, RIM = 85, RANGE = 110;
const neg = (d: V3): V3 => [-d[0], -d[1], -d[2]];

describe("minimap markers (review: far-side targets folded into the middle)", () => {
  // Stand on the far side of Arcadia from Clover Fields: the target projects right under you,
  // 1,570.8 m away.
  const clover = placeDir("clover_fields");
  const me = neg(clover);
  const v = mapView(me, 0, (RIM / RANGE) * R, SIZE, SIZE);

  it("leaves off mission stars beyond the range or on the far side, and draws the near ones on their spot", () => {
    const { ctx, calls } = recorder();
    const near = offsetDir(me, 30, 0, R);
    const drawn = drawMissionStars(ctx, v, me, [{ dir: clover }, { dir: near }, { dir: offsetDir(me, 0, 400, R) }], R, RANGE, RIM);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]!.x).toBeGreaterThan(SIZE / 2 + 15); // 30 m east, north up: to the right
    expect(Math.abs(drawn[0]!.y - SIZE / 2)).toBeLessThan(1);
    expect(calls.filter((c) => c.fn === "fill")).toHaveLength(1);
  });

  it("pins far party members to the rim toward them instead of under you", () => {
    const { ctx, calls } = recorder();
    const at = (d: V3, h = 2) => [d[0] * (R + h), d[1] * (R + h), d[2] * (R + h)];
    const drawn = drawPartyMarkers(ctx, v, me, [
      { pos: at(clover), colour: "#fff3dc" }, // the antipode
      { pos: at(offsetDir(me, 0, 300, R)), colour: "#9cff6b" }, // 300 m north
      { pos: at(offsetDir(me, -20, 0, R)), colour: "#7ad8ff" }, // 20 m west
    ], R, RANGE, RIM);
    const r = (p: { x: number; y: number }) => Math.hypot(p.x - SIZE / 2, p.y - SIZE / 2);
    expect(drawn[0]!.pinned).toBe(true);
    expect(r(drawn[0]!)).toBeCloseTo(RIM - 4, 6);
    expect(drawn[1]!.pinned).toBe(true);
    expect(drawn[1]!.y).toBeLessThan(SIZE / 2 - RIM + 10); // at the top: north
    expect(Math.abs(drawn[1]!.x - SIZE / 2)).toBeLessThan(1);
    expect(drawn[2]!.pinned).toBe(false);
    expect(drawn[2]!.x).toBeLessThan(SIZE / 2 - 10);
    expect(calls.filter((c) => c.fn === "arc")).toHaveLength(3);
  });

  it("pins a far waypoint toward its bearing, also when the minimap turns with you", () => {
    const { ctx } = recorder();
    const east = offsetDir(me, 500, 0, R);
    const p = drawWaypointMarker(ctx, v, me, east, R, RANGE, RIM, "#ff5fd2");
    expect(p.pinned).toBe(true);
    expect(p.x).toBeGreaterThan(SIZE / 2 + RIM - 10);
    // Facing east (heading 90): east is ahead, at the top.
    const turned = mapView(me, 90, (RIM / RANGE) * R, SIZE, SIZE);
    const q = drawWaypointMarker(ctx, turned, me, east, R, RANGE, RIM, "#ff5fd2");
    expect(q.y).toBeLessThan(SIZE / 2 - RIM + 10);
    expect(Math.abs(q.x - SIZE / 2)).toBeLessThan(1);
  });
});
