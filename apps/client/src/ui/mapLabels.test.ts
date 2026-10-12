import { expect, it } from "vitest";
import { layoutMapLabels } from "./mapLabels.ts";

it("separates the Portus cluster, placing portals before shops and landmarks", () => {
  const labels = [
    { id: "plaza", x: 240, y: 240, width: 80, priority: 1 },
    { id: "exchange", x: 242, y: 243, width: 100, priority: 2 },
    { id: "arcadia", x: 238, y: 241, width: 90, priority: 3 },
    { id: "hollowmere", x: 243, y: 242, width: 110, priority: 3 },
    { id: "meridian", x: 241, y: 238, width: 95, priority: 3 },
  ];
  const placed = layoutMapLabels(labels, 480, 480);
  expect(placed.map((p) => p.id)).toEqual(["arcadia", "hollowmere", "meridian", "exchange", "plaza"]);
  for (const [i, a] of placed.entries()) for (const b of placed.slice(i + 1)) {
    expect(a.left + a.width <= b.left || b.left + b.width <= a.left || a.top + a.height <= b.top || b.top + b.height <= a.top).toBe(true);
  }
});

it("keeps rim labels inside the rectangular panel and away from their markers", () => {
  const placed = layoutMapLabels([
    { id: "flats", x: 24, y: 235, width: 125, priority: 1 },
    { id: "billboard", x: 30, y: 238, width: 130, priority: 1 },
    { id: "right", x: 459, y: 4, width: 120, priority: 2 },
    { id: "bottom", x: 456, y: 479, width: 120, priority: 2 },
  ], 480, 480);
  expect(placed).toHaveLength(4);
  for (const p of placed) {
    expect(p.left).toBeGreaterThanOrEqual(6);
    expect(p.top).toBeGreaterThanOrEqual(6);
    expect(p.left + p.width).toBeLessThanOrEqual(474);
    expect(p.top + p.height).toBeLessThanOrEqual(474);
    expect(p.x < p.left - 6 || p.x > p.left + p.width + 6 || p.y < p.top - 6 || p.y > p.top + p.height + 6).toBe(true);
  }
});

it("hides low-priority names when there is no room, independent of input order", () => {
  const labels = [
    { id: "landmark", x: 40, y: 40, width: 64, priority: 1 },
    { id: "portal", x: 40, y: 40, width: 64, priority: 3 },
  ];
  expect(layoutMapLabels(labels, 80, 60).map((p) => p.id)).toEqual(["portal"]);
  expect(layoutMapLabels([...labels].reverse(), 80, 60)).toEqual(layoutMapLabels(labels, 80, 60));
  expect(layoutMapLabels([{ ...labels[0]!, width: 100 }], 80, 40)).toEqual([]);
});
