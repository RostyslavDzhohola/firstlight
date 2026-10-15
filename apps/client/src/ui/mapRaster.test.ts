import { describe, expect, it } from "vitest";
import { BODIES, createTerrain } from "@firstlight/shared";
import { placeDir } from "@firstlight/shared/content/places";
import { townDir } from "@firstlight/shared/planet/townFrame";
import { atlasResolution, bakeAtlas, renderView, rgba, sampleAtlas, TOWN_CLASS, townRaster } from "./mapRaster.ts";
import { mapView } from "./mapView.ts";

const arcadia = createTerrain("arcadia");
// A coarse atlas keeps the test fast; the game bakes ~384 texels per face in a worker.
const atlas = bakeAtlas(arcadia, 48);

describe("map raster", () => {
  it("bakes ~2 m texels on the planets and finer ones for the Portus town", () => {
    expect(atlasResolution(BODIES.portus.radius)).toBe(320);
    expect(atlasResolution(BODIES.arcadia.radius)).toBe(384);
    expect(atlasResolution(BODIES.hollowmere.radius)).toBe(480);
    expect(atlasResolution(BODIES.meridian.radius)).toBe(512);
  });

  it("paints lakes as water and the land as land", () => {
    const lake = placeDir("glasswater_lake");
    const [r, g, b] = rgba(sampleAtlas(atlas, lake[0], lake[1], lake[2]));
    expect(b).toBeGreaterThan(r + 30);
    const pad = placeDir("dawnpad");
    const [pr, pg, pb, pa] = rgba(sampleAtlas(atlas, pad[0], pad[1], pad[2]));
    expect(pa).toBe(255);
    expect(pg).toBeGreaterThan(pb); // grass, not water
    expect(g).toBeGreaterThan(0);
    expect(pr).toBeGreaterThanOrEqual(0);
  });

  it("draws a view: the centre is the atlas colour there, off the globe is transparent", () => {
    const c = placeDir("dawnpad");
    const v = mapView(c, 0, 30, 64, 64); // the whole globe (radius 30 px) in a 64 px square
    const out = new Uint32Array(64 * 64);
    renderView(atlas, v, out, { radius: BODIES.arcadia.radius });
    const centre = out[32 * 64 + 32]!;
    const at = (() => {
      // pixel (32, 32)'s centre is half a pixel off the view centre
      const a = 0.5 / 30, b = -0.5 / 30, z = Math.sqrt(1 - a * a - b * b);
      return [a * v.e[0] + b * v.n[0] + z * v.c[0], a * v.e[1] + b * v.n[1] + z * v.c[1], a * v.e[2] + b * v.n[2] + z * v.c[2]];
    })();
    expect(centre).toBe(sampleAtlas(atlas, at[0]!, at[1]!, at[2]!));
    expect(rgba(out[0]!)[3]).toBe(0);
    expect(rgba(out[63 * 64 + 63]!)[3]).toBe(0);
  });

  it("lays out the Portus town plan: paved plaza, stone keep, roofed market hall, oak crowns", () => {
    const t = townRaster();
    const at = (e: number, n: number) => t.cls[Math.floor((n + t.half) / t.cell) * t.n + Math.floor((e + t.half) / t.cell)];
    expect(at(-5, -3)).toBe(TOWN_CLASS.paving);
    expect(at(0, 52.6)).toBe(TOWN_CLASS.stone);
    expect(at(10.6, 27.6)).toBe(TOWN_CLASS.roof);
    expect(at(0.4, -29.5)).toBe(TOWN_CLASS.tree);
    expect(at(0, -80)).toBe(TOWN_CLASS.none); // the fields south of the walls
  });

  it("puts the town plan on Portus views in the town's own orientation (north up = the castle)", () => {
    const portus = createTerrain("portus");
    const small = bakeAtlas(portus, 16);
    const t = townRaster();
    const R = BODIES.portus.radius;
    // 1 px = 1 m around the plaza, north-up.
    const v = mapView([0, 1, 0], 0, R, 160, 160);
    const out = new Uint32Array(160 * 160);
    renderView(small, v, out, { radius: R, town: t });
    const keep = out[(80 - 53) * 160 + 80]!; // 52.6 m north = up
    const south = out[(80 + 53) * 160 + 80]!;
    expect(rgba(keep)).toEqual([128, 124, 134, 255]); // stone
    expect(rgba(south)).not.toEqual(rgba(keep));
    const k = townDir(0, 52.6, R);
    expect(k[2]).toBeGreaterThan(0); // the keep is toward +Z: the compass's north
  });
});
