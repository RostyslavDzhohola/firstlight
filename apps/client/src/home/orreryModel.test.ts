import { describe, expect, it } from "vitest";
import type { HomeOnline } from "@firstlight/shared/net/home";
import type { MeInfo } from "./homeModel.ts";
import { almanacLines, bodyAngle, bodyPos, enterBody, FRONT, frontBody, neighbour, ORRERY_BODIES, orreryCamera, orreryPlate, pickBody, project, wrapAngle, yawFor } from "./orreryModel.ts";
import { wantsOrrery } from "./orrery.ts";

const W = 1440, H = 900;
const online = (n: Partial<Record<string, [number, string[]]>> = {}): HomeOnline => {
  const b = (id: string) => ({ players: n[id]?.[0] ?? 0, names: n[id]?.[1] ?? [] });
  return { total: Object.values(n).reduce((s, v) => s + (v?.[0] ?? 0), 0), bodies: { portus: b("portus"), arcadia: b("arcadia"), hollowmere: b("hollowmere"), meridian: b("meridian") } };
};
const me = (body: string | null, guest = true): MeInfo => ({ name: "Wanderer-4410", displayName: null, guest, titleMedal: null, character: body ? { level: 3, xp: 0, coins: 0, starter: 0, palette: 0, body } : null, medals: [], pads: [] });

describe("the orrery's sky", () => {
  it("turning the sky to a world puts that world at the front, at any time", () => {
    for (const t of [0, 37, 4000]) {
      ORRERY_BODIES.forEach((b, i) => {
        const yaw = yawFor(i, t, 1.3);
        expect(Math.abs(wrapAngle(bodyAngle(b, t, yaw) - FRONT))).toBeLessThan(1e-9);
        expect(frontBody(t, yaw)).toBe(i);
        expect(Math.abs(yaw - 1.3)).toBeLessThanOrEqual(Math.PI + 1e-9); // the short way round
      });
    }
  });

  it("the arrow keys walk round every world and back", () => {
    for (const dir of [1, -1] as const) {
      const seen = new Set<number>();
      let i = 0;
      for (let k = 0; k < ORRERY_BODIES.length; k++) {
        seen.add(i);
        i = neighbour(i, dir, 12, 0.4);
      }
      expect(seen.size).toBe(ORRERY_BODIES.length);
      expect(i).toBe(0);
    }
    expect(neighbour(neighbour(2, 1, 5, 0), -1, 5, 0)).toBe(2);
  });

  it("the front world stands left of centre, whole and in front of the camera, with the star to its right", () => {
    ORRERY_BODIES.forEach((b, i) => {
      const yaw = yawFor(i, 0, 0);
      const p = bodyPos(b, 0, yaw);
      const cam = orreryCamera(p, b.radius);
      const s = project(p, cam, W, H);
      const r = b.radius * s.scale;
      expect(s.depth).toBeGreaterThan(b.radius * 2);
      expect(s.x).toBeLessThan(W * 0.42);
      expect(s.x - r).toBeGreaterThan(-W * 0.05);
      expect(s.y - r).toBeGreaterThan(H * 0.12);
      expect(s.y + r).toBeLessThan(H * 0.92);
      const star = project([0, 0, 0], cam, W, H);
      expect(star.depth).toBeGreaterThan(0);
      expect(star.x).toBeGreaterThan(s.x);
    });
  });

  it("a click on a world picks it, a click on empty sky picks nothing, the nearer world wins", () => {
    const yaw = yawFor(1, 0, 0);
    const b = ORRERY_BODIES[1]!;
    const cam = orreryCamera(bodyPos(b, 0, yaw), b.radius);
    const s = project(bodyPos(b, 0, yaw), cam, W, H);
    expect(pickBody(s.x, s.y, 0, yaw, cam, W, H)).toBe(1);
    expect(pickBody(s.x + b.radius * s.scale * 0.9, s.y, 0, yaw, cam, W, H)).toBe(1);
    expect(pickBody(W - 5, H - 5, 0, yaw, cam, W, H)).toBe(-1);
  });

  it("a dive ends at the world's surface, looking at it", () => {
    const b = ORRERY_BODIES[0]!;
    const p = bodyPos(b, 0, yawFor(0, 0, 0));
    const cam = orreryCamera(p, b.radius, 1);
    const d = Math.hypot(cam.pos[0] - p[0], cam.pos[1] - p[1], cam.pos[2] - p[2]);
    expect(d).toBeCloseTo(b.radius * 1.04, 5);
    const s = project(p, cam, W, H);
    expect(Math.abs(s.x - W / 2)).toBeLessThan(1);
    expect(Math.abs(s.y - H / 2)).toBeLessThan(1);
  });
});

describe("the plate beside the front world", () => {
  it("a new traveller begins in Portus and is told which portal leads to each planet", () => {
    expect(enterBody(null)).toBe("portus");
    expect(orreryPlate("portus", null, null).action).toEqual({ kind: "dive", label: "Begin here" });
    const a = orreryPlate("hollowmere", null, null).action;
    expect(a).toMatchObject({ kind: "route", go: "portus" });
    expect(a.kind === "route" && a.note).toMatch(/violet portal/);
  });

  it("a traveller with a character continues on their world, and the others point back to it", () => {
    const m = me("hollowmere");
    expect(enterBody(m)).toBe("hollowmere");
    expect(orreryPlate("hollowmere", null, m).action).toEqual({ kind: "dive", label: "Continue as Wanderer-4410 · level 3" });
    expect(orreryPlate("arcadia", null, m).action).toMatchObject({ kind: "route", go: "hollowmere", goLabel: "Turn to Hollowmere" });
    expect(enterBody(me("somewhere-new"))).toBe("portus");
  });

  it("says who is there now, three names and the rest counted", () => {
    const o = online({ arcadia: [17, ["Bramble", "Cinder_7", "Mossback", "Wren"]], meridian: [2, []] });
    expect(orreryPlate("arcadia", o, null).facts[0]).toBe("17 here now: Bramble, Cinder_7, Mossback and 14 more");
    expect(orreryPlate("meridian", o, null).facts[0]).toBe("2 here now");
    expect(orreryPlate("portus", o, null).facts[0]).toBe("Nobody here right now");
    expect(orreryPlate("arcadia", o, null).facts[1]).toMatch(/waits here · level \d+/);
  });
});

describe("the almanac", () => {
  it("speaks of the quiet worlds, the leader and the vault", () => {
    expect(almanacLines(null, null)[0]).toMatch(/quiet/);
    const lines = almanacLines(online({ arcadia: [1, ["Wren"]] }), { levels: [{ name: "Vexa_77", level: 19, starter: 0, title: null }], medals: [], hall: [], gleams: { keepers: 0, first: [] } });
    expect(lines[0]).toBe("1 traveller is awake right now");
    expect(lines).toContain("Vexa_77 leads the travellers at level 19");
    expect(lines).toContain("The Gleam Vault has never been opened");
  });
});

describe("who gets the orrery", () => {
  const desk = () => true;
  const phone = () => false;
  it("desktop visits by default; the classic page on request, in the journeys and on small or touch screens", () => {
    expect(wantsOrrery("", desk)).toBe(true);
    expect(wantsOrrery("?menu=classic", desk)).toBe(false);
    expect(wantsOrrery("?e2e", desk)).toBe(false);
    expect(wantsOrrery("?autoplay", desk)).toBe(false);
    expect(wantsOrrery("", phone)).toBe(false);
    expect(wantsOrrery("?menu=orrery", phone)).toBe(true);
  });
});
