// Pad-0 site data per body, from the real shared code (Node 24 strips the TS types): the ground
// height grid around pad 0 (geodesic east/north metres in content/places.ts tangentFrame), every
// breakable within 70 m (as placed by bodyBreakables), the rendered natural props, the portal home,
// world objects, places, NPC areas, other pads and the reference sun (render/looks.ts).
//   node tools/blender/pads/site_data.mjs <repo root> <out dir>
import { writeFileSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
const repo = process.argv[2], out = process.argv[3];
mkdirSync(out, { recursive: true });
const S = (p) => import(pathToFileURL(`${repo}/packages/shared/src/${p}`).href);
const { BODIES } = await S("planet/bodies.ts");
const { createTerrain } = await S("planet/terrain.ts");
const { padDirs, PAD_SAFE_RADIUS, PAD_FLAT_INNER, PAD_FLAT_OUTER } = await S("planet/pads.ts");
const { bodyBreakables, archetypeDef } = await S("planet/breakables.ts");
const { portalSpots } = await S("planet/portals.ts");
const { chunkProps, PROPS_VERSION } = await S("planet/props.ts");
const { chunkOf } = await S("planet/cubesphere.ts");
const { objectsOn, objectPos } = await S("content/world.ts");
const { tangentFrame, placesOn, placeDir } = await S("content/places.ts");
const { NPC_AREAS } = await S("content/npcs.ts");
const { resolveAreaDir, bossArena } = await S("content/arenas.ts");
const { skyDir } = await import(pathToFileURL(`${repo}/apps/client/src/render/sunFrame.ts`).href);
const { LOOKS } = await import(pathToFileURL(`${repo}/apps/client/src/render/looks.ts`).href);

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (v) => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };
const r3 = (x) => Math.round(x * 1000) / 1000;

for (const id of ["arcadia", "hollowmere", "meridian"]) {
  const body = BODIES[id];
  const R = body.radius;
  const terrain = createTerrain(body);
  const up = [...padDirs(body)[0]];
  const padH = terrain.padHeights[0];
  const { north, east } = tangentFrame(up);
  const C = up.map((u) => u * (R + padH));
  // Local tangent frame (Euclidean): x = east, y = north, z = up, origin = pad 0 top centre.
  const local = (p) => { const d = sub(p, C); return [r3(dot(d, east)), r3(dot(d, north)), r3(dot(d, up))]; };
  const ldir = (v) => [r3(dot(v, east)), r3(dot(v, north)), r3(dot(v, up))];
  // Geodesic (azimuthal equidistant) coords of a direction: east/north arc metres.
  const geo = (d) => {
    const k = Math.max(-1, Math.min(1, dot(d, up)));
    const t = Math.acos(k) * R;
    const te = dot(d, east), tn = dot(d, north);
    const h = Math.hypot(te, tn);
    return h < 1e-12 ? [0, 0] : [r3((te / h) * t), r3((tn / h) * t)];
  };
  // Direction of geodesic (e, n).
  const gdir = (e, n) => {
    const r = Math.hypot(e, n);
    if (r < 1e-9) return up;
    const t = r / R, s = Math.sin(t) / r;
    return norm([0, 1, 2].map((i) => up[i] * Math.cos(t) + (east[i] * e + north[i] * n) * s));
  };

  // Heights on a geodesic grid (h above R, the rendered triangle under each point).
  const L = 150, step = 1;
  const nx = Math.round((2 * L) / step) + 1;
  const heights = [];
  for (let j = 0; j < nx; j++) {
    for (let i = 0; i < nx; i++) {
      const e = -L + i * step, n = -L + j * step;
      const d = gdir(e, n);
      heights.push(r3(terrain.groundHeight(d[0], d[1], d[2])));
    }
  }

  // Breakables within 70 m (arc) of pad 0.
  const breakables = [];
  for (const b of bodyBreakables(terrain)) {
    const d = norm([b.px, b.py, b.pz]);
    const arc = Math.acos(Math.max(-1, Math.min(1, dot(d, up)))) * R;
    if (arc > 70) continue;
    const [ge, gn] = geo(d);
    breakables.push({
      id: b.id, kind: b.kind, scale: r3(b.scale), arc: r3(arc), east: ge, north: gn,
      base: local([b.px, b.py, b.pz]), baseH: r3(Math.hypot(b.px, b.py, b.pz) - R),
      right: ldir([b.rx, b.ry, b.rz]), up: ldir([b.ux, b.uy, b.uz]), fwd: ldir([b.fx, b.fy, b.fz]),
      shape: b.shape, hx: r3(b.hx), hz: r3(b.hz), h: r3(b.h), parts: (b.parts ?? []).map((q) => ({ ...q })), foot: r3(b.foot), size: b.size, hp: b.hp,
    });
  }
  breakables.sort((a, b) => a.arc - b.arc);

  // Natural props (as rendered: chunkProps) within 110 m: every chunk touched by the grid.
  const keys = new Map();
  for (let e = -L; e <= L; e += 16) for (let n = -L; n <= L; n += 16) {
    const d = gdir(e, n);
    const k = chunkOf(d[0], d[1], d[2], body.chunksPerFace);
    keys.set(`${k.face}:${k.cx}:${k.cy}`, k);
  }
  const props = [];
  for (const k of keys.values()) {
    for (const p of chunkProps(terrain, k.face, k.cx, k.cy)) {
      const d = norm([p.x, p.y, p.z]);
      const arc = Math.acos(Math.max(-1, Math.min(1, dot(d, up)))) * R;
      if (arc > 120) continue;
      const [ge, gn] = geo(d);
      props.push({ kind: p.kind, east: ge, north: gn, arc: r3(arc), pos: local([p.x, p.y, p.z]), h: r3(Math.hypot(p.x, p.y, p.z) - R), scale: r3(p.scale), yaw: r3(p.yaw) });
    }
  }

  // Portal home.
  const portals = portalSpots(body, terrain).map((s) => ({
    to: s.to, east: geo(s.dir)[0], north: geo(s.dir)[1], base: local(s.dir.map((v) => v * (R + s.h))), h: r3(s.h), center: local(s.center), facing: ldir(s.facing),
  }));

  // World objects (quests, guide, eggs) within 120 m.
  const objects = [];
  for (const o of objectsOn(id)) {
    const p = objectPos(o, terrain.groundHeight);
    const d = norm(p);
    const arc = Math.acos(Math.max(-1, Math.min(1, dot(d, up)))) * R;
    objects.push({ id: o.id, look: o.look, name: o.name, place: o.place, arc: r3(arc), ...(arc < 120 ? { east: geo(d)[0], north: geo(d)[1], pos: local(p) } : {}) });
  }
  objects.sort((a, b) => a.arc - b.arc);

  // Places and NPC areas (distance from pad 0).
  const places = placesOn(id).map((p) => { const d = placeDir(p); return { id: p.id, name: p.name, kind: p.kind, radius: p.radius, arc: r3(Math.acos(Math.max(-1, Math.min(1, dot(d, up)))) * R), dirGeo: geo(d) }; }).sort((a, b) => a.arc - b.arc);
  const areas = NPC_AREAS.filter((a) => a.planet === id).map((a) => { const d = resolveAreaDir(body, a.at); const arc = Math.acos(Math.max(-1, Math.min(1, dot(d, up)))) * R; return { id: a.id, radius: a.radius, arc: r3(arc), edge: r3(arc - a.radius), geo: geo(d) }; }).sort((a, b) => a.edge - b.edge);
  const pads = padDirs(body).map((p, i) => ({ i, arc: r3(Math.acos(Math.max(-1, Math.min(1, dot(p, up)))) * R), geo: geo(p), h: r3(terrain.padHeights[i]) }));
  const arena = bossArena(terrain);

  // Reference sun in the pad frame.
  const lk = LOOKS[id];
  const sd = skyDir(up[0], up[1], up[2], lk.sunElev, lk.sunAz, [0, 0, 0]);
  const sun = { elev: lk.sunElev, az: lk.sunAz, dir: ldir(sd), color: lk.sun, intensity: lk.sunIntensity, hemiSky: lk.hemiSky, hemiGround: lk.hemiGround, hemiIntensity: lk.hemiIntensity, zenith: lk.zenith, mid: lk.mid, horizon: lk.horizon, ground: lk.ground, fogDensity: lk.fogDensity, fogStart: lk.fogStart, grassRoot: lk.grassRoot, grassTip: lk.grassTip, exposure: lk.exposure, grade: lk.grade };

  const data = {
    body: id, R, padH: r3(padH), waterLevel: body.waterLevel, up, east, north,
    constants: { PAD_SAFE_RADIUS, PAD_FLAT_INNER, PAD_FLAT_OUTER, PROPS_VERSION, pad: { top: 8, bottom: 8.6, height: 0.6 } },
    grid: { L, step, n: nx, heights },
    breakables, props, portals, objects, places, areas, pads, sun,
    arena: arena ? { boss: arena.boss, radius: arena.radius, arc: r3(Math.acos(Math.max(-1, Math.min(1, dot(arena.up, up)))) * R) } : null,
  };
  writeFileSync(`${out}/site_${id}.json`, JSON.stringify(data));
  const hs = heights.filter((_, k) => { const i = k % nx, j = Math.floor(k / nx); const e = -L + i * step, n = -L + j * step; return Math.hypot(e, n) <= 50; });
  console.log(`${id}: R ${R} padH ${padH.toFixed(2)} water ${body.waterLevel}; ground within 50 m: ${Math.min(...hs).toFixed(2)}..${Math.max(...hs).toFixed(2)}; breakables<=70m ${breakables.length}; props<=110m ${props.length}; objects<120m ${objects.filter((o) => o.arc < 120).map((o) => o.id + "@" + o.arc.toFixed(1)).join(",")}`);
  console.log(`  portal`, JSON.stringify(portals));
  console.log(`  nearest areas`, areas.slice(0, 4).map((a) => `${a.id} centre ${a.arc.toFixed(0)} edge ${a.edge.toFixed(0)}`).join("; "));
  console.log(`  nearest pads`, pads.slice(1).sort((a, b) => a.arc - b.arc).slice(0, 3).map((p) => `${p.i}@${p.arc.toFixed(0)}`).join(" "), ` places<200`, places.filter((p) => p.arc < 200).map((p) => `${p.id}@${p.arc.toFixed(0)}`).join(" "));
  console.log(`  sun local`, sun && sun.dir);
}
