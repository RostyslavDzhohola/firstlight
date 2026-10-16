import { describe, expect, it } from "vitest";
import { BODIES, createTerrain, safeGates } from "@firstlight/shared";
import { OUTPOSTS, type OutpostBody } from "@firstlight/shared/content/padOutposts";
import { outpostGateStrips, STRIP_LENGTH, STRIP_STEP, stripLift } from "./gateStrips.ts";

const PLANETS: OutpostBody[] = ["arcadia", "hollowmere", "meridian"];

describe("the walled outposts' gate border strips (D-b2-1)", () => {
  it.each(PLANETS)("%s: one strip across every gate passage, draped on the terrain over the path decals", (body) => {
    const terrain = createTerrain(body);
    const R = BODIES[body].radius;
    const pos = outpostGateStrips(body, terrain);
    const gates = OUTPOSTS[body].wall.gates;
    const rows = Math.ceil(STRIP_LENGTH / STRIP_STEP);
    expect(pos.length).toBe(gates.length * rows * 6 * 3);
    const lift = stripLift(body);
    const above = (x: number, y: number, z: number) => {
      const l = Math.hypot(x, y, z);
      return l - R - terrain.groundHeight(x / l, y / l, z / l);
    };
    const perGate = rows * 6 * 3;
    gates.forEach((_, gi) => {
      let lo = Infinity, hi = -Infinity;
      let cx = 0, cy = 0, cz = 0;
      for (let t = gi * perGate; t < (gi + 1) * perGate; t += 9) {
        const v = [0, 3, 6].map((o) => [pos[t + o]!, pos[t + o + 1]!, pos[t + o + 2]!] as const);
        // Every vertex and every triangle's centre and edge midpoints sit just over the ground.
        const samples = [...v, ...[[0, 1], [1, 2], [2, 0]].map(([a, b]) => v[a]!.map((c, k) => (c + v[b]![k]!) / 2) as unknown as readonly [number, number, number])];
        samples.push(v[0]!.map((c, k) => (c + v[1]![k]! + v[2]![k]!) / 3) as unknown as readonly [number, number, number]);
        for (const p of samples) {
          const h = above(p[0], p[1], p[2]);
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
        }
        // Facing up (counter-clockwise from above; the ground slopes up to ~30° across a gate).
        const e1 = [v[1]![0] - v[0]![0], v[1]![1] - v[0]![1], v[1]![2] - v[0]![2]];
        const e2 = [v[2]![0] - v[0]![0], v[2]![1] - v[0]![1], v[2]![2] - v[0]![2]];
        const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
        const l = Math.hypot(...v[0]!);
        expect((n[0]! * v[0]![0] + n[1]! * v[0]![1] + n[2]! * v[0]![2]) / (Math.hypot(...n) * l)).toBeGreaterThan(0.75);
        cx += v[0]![0]; cy += v[0]![1]; cz += v[0]![2];
      }
      expect(lo, `${body} gate ${gates[gi]}° lowest`).toBeGreaterThan(lift - 0.02);
      expect(hi, `${body} gate ${gates[gi]}° highest`).toBeLessThan(lift + 0.2);
      // Centred on the gate (the safe border runs through it).
      const cl = Math.hypot(cx, cy, cz);
      const g = safeGates(BODIES[body])[gi]!;
      expect(Math.hypot(cx / cl - g[0], cy / cl - g[1], cz / cl - g[2]) * R, `${body} gate ${gates[gi]}° centre`).toBeLessThan(0.5);
    });
  });
});
