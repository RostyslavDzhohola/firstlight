import { describe, expect, it } from "vitest";
import { NPC_INDEX, NPC_DEFS, NPC_AREAS, defLevels, npcDef } from "../content/npcs.ts";
import { resolveAreaDir, bossArena } from "../content/arenas.ts";
import { WILD_SITE_PREFABS } from "../content/wildSitePrefabs.ts";
import { siteDiscoveryXp, WILD_SITE_BY_ID, WILD_SITES, wildSitesOn, type WildSiteBody } from "../content/wildSites.ts";
import { BODIES } from "./bodies.ts";
import { bodyBreakables } from "./breakables.ts";
import { PLAYER_BODY } from "./collide.ts";
import { chordMetres, padDirs } from "./pads.ts";
import { naturalChunkProps } from "./props.ts";
import { siteSolids, structureCollider } from "./sites.ts";
import { createTerrain, type Terrain } from "./terrain.ts";
import { prefabPoint, WILD_SITE_ITEM_BASE, WILD_SITE_RULES, wildSiteAt, wildSitePlacements } from "./wildSites.ts";
import { faceOf, type Face } from "./cubesphere.ts";

const PLANETS: WildSiteBody[] = ["arcadia", "hollowmere", "meridian"];
const terrains = new Map<WildSiteBody, Terrain>(PLANETS.map((b) => [b, createTerrain(b)]));
const T = (b: WildSiteBody) => terrains.get(b)!;

describe("wild site content", () => {
  it("has unique ids, at least three sites per planet and a known prefab each", () => {
    expect(new Set(WILD_SITES.map((s) => s.id)).size).toBe(WILD_SITES.length);
    for (const b of PLANETS) expect(wildSitesOn(b).length).toBeGreaterThanOrEqual(3);
    for (const s of WILD_SITES) expect(WILD_SITE_PREFABS.some((p) => p.name === s.prefab)).toBe(true);
  });

  it("fields a guardian and pack of known kinds whose levels sit in the band and in each kind's range", () => {
    for (const s of WILD_SITES) {
      for (const m of [s.guardian, ...s.pack]) {
        expect(NPC_INDEX.has(m.kind), `${s.id}: ${m.kind}`).toBe(true);
        const [lo, hi] = defLevels(npcDef(m.kind), s.body);
        expect(m.level, `${s.id}: ${m.kind} level`).toBeGreaterThanOrEqual(Math.max(lo, s.levels[0]));
        expect(m.level, `${s.id}: ${m.kind} level`).toBeLessThanOrEqual(Math.min(hi, s.levels[1]));
        expect(npcDef(m.kind).temper).toBe("hostile");
      }
      expect(s.guardian.level).toBe(s.levels[1]);
    }
  });

  it("puts an easy and a hard band on every planet, with chests and discovery XP rising with the band", () => {
    for (const b of PLANETS) {
      const list = [...wildSitesOn(b)].sort((x, y) => x.levels[0] - y.levels[0]);
      expect(list.at(-1)!.levels[0] - list[0]!.levels[1]).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < list.length; i++) {
        expect(list[i]!.chest.coins).toBeGreaterThan(list[i - 1]!.chest.coins);
        expect(siteDiscoveryXp(list[i]!)).toBeGreaterThan(siteDiscoveryXp(list[i - 1]!));
      }
    }
    expect(WILD_SITE_BY_ID.get("bellwether_watch")!.body).toBe("arcadia");
  });
});

describe("wild site placement", () => {
  it.each(PLANETS)("%s: every site is clear of pads, arena, camps, breakables and the other sites, on dry gentle ground", (b) => {
    const t = T(b);
    const R = BODIES[b].radius;
    const list = wildSitePlacements(t);
    expect(list.length).toBe(wildSitesOn(b).length);
    const arena = bossArena(t);
    for (const p of list) {
      const foot = p.prefab.foot;
      for (const pad of padDirs(BODIES[b])) expect(chordMetres(pad, p.dir[0], p.dir[1], p.dir[2], R)).toBeGreaterThanOrEqual(WILD_SITE_RULES.padClear + foot);
      if (arena) expect(chordMetres(arena.up, p.dir[0], p.dir[1], p.dir[2], R)).toBeGreaterThan(arena.radius + foot);
      for (const a of NPC_AREAS.filter((x) => x.planet === b && x.camp)) {
        expect(chordMetres(resolveAreaDir(BODIES[b], a.at), p.dir[0], p.dir[1], p.dir[2], R)).toBeGreaterThan(a.radius + foot);
      }
      for (const q of list) if (q !== p) expect(chordMetres(q.dir, p.dir[0], p.dir[1], p.dir[2], R)).toBeGreaterThan(foot + q.prefab.foot + WILD_SITE_RULES.siteClear - 1e-6);
      for (const k of bodyBreakables(t)) expect(chordMetres([k.ux, k.uy, k.uz], p.dir[0], p.dir[1], p.dir[2], R)).toBeGreaterThan(foot + k.foot + WILD_SITE_RULES.breakableClear);
      expect(t.groundHeight(p.dir[0], p.dir[1], p.dir[2])).toBeGreaterThan(BODIES[b].waterLevel + WILD_SITE_RULES.dry);
      expect(p.moved).toBeLessThanOrEqual(WILD_SITE_RULES.ring * WILD_SITE_RULES.rings);
    }
  });

  it("is deterministic: a fresh terrain gives the same spots", () => {
    for (const b of PLANETS) {
      const again = wildSitePlacements(createTerrain(b));
      wildSitePlacements(T(b)).forEach((p, i) => {
        expect(again[i]!.dir).toEqual(p.dir);
        expect(again[i]!.base).toBe(p.base);
      });
    }
  });

  it("places the easy site of each planet within sight of its landmark (under 300 m)", () => {
    for (const b of PLANETS) {
      const list = wildSitePlacements(T(b));
      const landmark = list.find((p) => p.site.kind === "landmark")!;
      const easy = [...list].sort((x, y) => x.site.levels[0] - y.site.levels[0])[0]!;
      expect(chordMetres(landmark.dir, easy.dir[0], easy.dir[1], easy.dir[2], BODIES[b].radius)).toBeLessThan(300);
    }
  });
});

describe("wild site colliders", () => {
  it.each(PLANETS)("%s: the structure collider holds the outpost's solids, then every site's", (b) => {
    const t = T(b);
    const all = structureCollider(t).solids;
    const own = siteSolids(t).length;
    const wild = wildSitePlacements(t).reduce((n, p) => n + p.prefab.solids.length, 0);
    expect(all.length).toBe(own + wild);
    all.forEach((s, i) => expect(s.index).toBe(i));
    expect(all.slice(own).every((s) => s.item >= WILD_SITE_ITEM_BASE)).toBe(true);
  });

  it.each(PLANETS)("%s: guard spots and the chest stand clear for the site's creatures", (b) => {
    const t = T(b);
    const c = structureCollider(t);
    for (const p of wildSitePlacements(t)) {
      const radius = Math.max(...[p.site.guardian, ...p.site.pack].map((m) => npcDef(m.kind).radius));
      for (const [i, d] of [...p.guardDirs, p.chestDir].entries()) {
        const r = BODIES[b].radius + t.groundHeight(d[0], d[1], d[2]) + 0.02;
        const at = { x: d[0] * r, y: d[1] * r, z: d[2] * r };
        const body = i === p.guardDirs.length ? PLAYER_BODY : { radius: Math.min(radius, 1.1), height: 1.8, step: 0.35 };
        expect(c.isClear(at, body), `${p.site.id} spot ${i}`).toBe(true);
      }
    }
  });

  it("blocks a walk through a wall and lets a player walk into the cave", () => {
    const t = T("hollowmere");
    const c = structureCollider(t);
    const cave = wildSitePlacements(t).find((p) => p.site.kind === "cave")!;
    const f = cave.frame;
    // From 12 m in front of the mouth to the chamber's middle: open. Through the back wall: blocked.
    const front = prefabPoint(f, 0, 12, 0.05), mid = prefabPoint(f, 0, 0, 0.05), behind = prefabPoint(f, 0, -12, 0.05);
    expect(c.crosses(front[0], front[1], front[2], mid[0], mid[1], mid[2])).toBe(false);
    expect(c.crosses(mid[0], mid[1], mid[2], behind[0], behind[1], behind[2])).toBe(true);
    const keep = wildSitePlacements(T("arcadia")).find((p) => p.site.kind === "ruin")!;
    const out = prefabPoint(keep.frame, 0, 14, 0.05), court = prefabPoint(keep.frame, 0, 1, 0.05), wall = prefabPoint(keep.frame, 14, 1, 0.05);
    const ck = structureCollider(T("arcadia"));
    expect(ck.crosses(out[0], out[1], out[2], court[0], court[1], court[2])).toBe(false); // through the gate
    expect(ck.crosses(court[0], court[1], court[2], wall[0], wall[1], wall[2])).toBe(true);
  });

  it("lets a player climb the watchtowers step by step to the lookout", () => {
    for (const name of ["a_watchtower", "m_relay"]) {
      const prefab = WILD_SITE_PREFABS.find((p) => p.name === name)!;
      const top = prefab.lookout[2];
      const boxes = prefab.solids.filter((s) => s[0] === 0 && s[7] === 0);
      const touching = (a: (typeof boxes)[number], b: (typeof boxes)[number]) =>
        Math.abs(a[1] - b[1]) <= a[3] + b[3] + 0.05 && Math.abs(a[2] - b[2]) <= a[4] + b[4] + 0.05;
      const start = boxes.filter((s) => s[6] <= 0.35);
      const seen = new Set(start);
      const queue = [...start];
      while (queue.length) {
        const a = queue.shift()!;
        for (const b of boxes) if (!seen.has(b) && touching(a, b) && b[6] - a[6] <= PLAYER_BODY.step && b[6] - a[6] > -2) { seen.add(b); queue.push(b); }
      }
      expect([...seen].some((s) => Math.abs(s[6] - top) < 1e-6), `${name}: lookout reachable`).toBe(true);
    }
  });

  it("finds a site by its discovery ring", () => {
    const t = T("meridian");
    for (const p of wildSitePlacements(t)) {
      const r = BODIES.meridian.radius + p.base;
      expect(wildSiteAt(t, p.dir[0] * r, p.dir[1] * r, p.dir[2] * r, 10)?.site.id).toBe(p.site.id);
    }
    const pad = padDirs(BODIES.meridian)[0]!;
    expect(wildSiteAt(t, pad[0] * 1000, pad[1] * 1000, pad[2] * 1000, 10)).toBeNull();
  });

  it("keeps natural props off the footprints", () => {
    const t = T("arcadia");
    const sites = wildSitePlacements(t);
    const faces = new Set(sites.map((p) => faceOf(p.dir[0], p.dir[1], p.dir[2])));
    const cpf = t.body.chunksPerFace;
    let checked = 0;
    for (const face of faces) {
      for (let cy = 0; cy < cpf; cy++) for (let cx = 0; cx < cpf; cx++) {
        for (const q of naturalChunkProps(t, face as Face, cx, cy)) {
          const l = Math.hypot(q.x, q.y, q.z);
          for (const p of sites) expect(chordMetres(p.dir, q.x / l, q.y / l, q.z / l, t.body.radius)).toBeGreaterThan(p.prefab.foot);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  }, 60_000);
});

it("NPC defs used by the sites exist in NPC_DEFS (append-only ids)", () => {
  for (const s of WILD_SITES) expect(NPC_DEFS[NPC_INDEX.get(s.guardian.kind)!]!.id).toBe(s.guardian.kind);
});
