// The wild sites on a planet (content/wildSites.ts, planet/wildSites.ts): the Blender-built prefabs of
// tools/blender/sites, drawn exactly where the shared placement puts their colliders.
//
// Draw budget: one planet's GLB (sites_<body>.glb, ~100–250 KB) holds each prefab twice (LOD0 and a
// decimated LOD1, both vertex-coloured, no textures) plus its emissive bits. Each site is one mesh
// (one draw, one shadow draw) and, where it has lamps or crystals, one small glow mesh. A site is drawn
// within SITE_DRAW_DISTANCE (its landmark further: they are meant to be seen from afar), LOD0 within
// the tier's SITE_LOD_DISTANCE, LOD1 beyond, and three's frustum culling does the rest. Every site on a
// body shares two materials, and a hidden one-triangle mesh of each sits in the group from the start
// so the loading screen's warm-up compiles both before play.
//
// Fallback: if the GLB can't load, the collider solids are drawn as plain boxes and cylinders (two
// instanced draws), so nothing blocks the player invisibly.

import * as THREE from "three/webgpu";
import { vertexColor } from "three/tsl";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { Terrain } from "@firstlight/shared";
import { wildSitePlacements, wildSiteSolids, type WildSitePlacement } from "@firstlight/shared/planet/wildSites";
import { config } from "../config.ts";
import type { ResolvedSettings } from "../render/quality.ts";

/** Camera distance (m) within which a site is drawn; landmarks reach further. */
export const SITE_DRAW_DISTANCE = { site: 520, landmark: 1100 } as const;
/** Camera distance (m) within which a site shows LOD0 (per tier; Low always LOD1). */
export const SITE_LOD_DISTANCE: Record<ResolvedSettings["tier"], number> = { low: 0, medium: 70, high: 110, ultra: 160 };
/** Shadows: a site casts within this distance of the camera (Medium and up). */
const SHADOW_DISTANCE = 140;
const LOD_HYSTERESIS = 5;

interface SiteMeshes {
  place: WildSitePlacement;
  lod: [THREE.Mesh, THREE.Mesh];
  glow: THREE.Mesh | null;
  centre: THREE.Vector3;
  far: number;
  shown: 0 | 1 | -1;
}

let litMaterial: THREE.MeshStandardNodeMaterial | null = null;
let glowMaterial: THREE.MeshBasicNodeMaterial | null = null;

/** The sites' lit material: vertex colours, matte, with a faint height tint so the ground contact reads. */
function siteMaterial(): THREE.MeshStandardNodeMaterial {
  if (!litMaterial) {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.88, metalness: 0 });
    m.colorNode = vertexColor();
    m.name = "wildSites:lit";
    litMaterial = m;
  }
  return litMaterial;
}

/** Lamps, crystals, beacons: their own colour, bright enough to bloom (above every body's threshold). */
function siteGlowMaterial(): THREE.MeshBasicNodeMaterial {
  if (!glowMaterial) {
    const m = new THREE.MeshBasicNodeMaterial();
    m.colorNode = vertexColor().rgb.mul(2.4);
    m.name = "wildSites:glow";
    glowMaterial = m;
  }
  return glowMaterial;
}

/** Flat-shaded copy of a GLB geometry (the build ships no normals: every face is flat). */
function flat(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g.clone();
  out.deleteAttribute("normal");
  out.computeVertexNormals();
  out.computeBoundingSphere();
  return out;
}

const glbCache = new Map<string, Promise<Map<string, THREE.BufferGeometry> | null>>();

/** One planet's site geometries by node name (`<prefab>`, `<prefab>_lod1`, `<prefab>_glow`), or null if it failed. */
export function loadSiteGeometry(body: string, fetchUrl = `${config.assetBase}/sites/sites_${body}.glb`): Promise<Map<string, THREE.BufferGeometry> | null> {
  let p = glbCache.get(fetchUrl);
  if (!p) {
    p = new GLTFLoader()
      .loadAsync(fetchUrl)
      .then((gltf) => {
        const out = new Map<string, THREE.BufferGeometry>();
        gltf.scene.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) out.set(m.name, flat(m.geometry));
        });
        return out;
      })
      .catch((err) => {
        console.warn(`[sites] sites_${body}.glb failed to load; drawing the colliders`, err);
        glbCache.delete(fetchUrl);
        return null;
      });
    glbCache.set(fetchUrl, p);
  }
  return p;
}

function frameMatrix(p: WildSitePlacement, out = new THREE.Matrix4()): THREE.Matrix4 {
  const f = p.frame;
  return out.set(f.rx, f.ux, f.fx, f.px, f.ry, f.uy, f.fy, f.py, f.rz, f.uz, f.fz, f.pz, 0, 0, 0, 1);
}

export class WildSites {
  readonly group = new THREE.Group();
  readonly sites: SiteMeshes[] = [];
  /** Resolves once the meshes (or the fallback) are in the group. */
  readonly ready: Promise<void>;
  private fallback: THREE.InstancedMesh[] = [];
  private lodDistance: number;
  private shadows: boolean;
  private disposed = false;

  constructor(private readonly terrain: Terrain, settings: ResolvedSettings, source = loadSiteGeometry(terrain.body.id)) {
    this.group.name = "wildSites";
    this.lodDistance = SITE_LOD_DISTANCE[settings.tier];
    this.shadows = settings.tier !== "low";
    // Warm-up meshes: hidden, one triangle each, so both pipelines compile on the loading screen.
    const tri = new THREE.BufferGeometry();
    tri.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0.01, 0, 0, 0, 0.01, 0], 3));
    tri.setAttribute("normal", new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    tri.setAttribute("color", new THREE.Float32BufferAttribute([1, 1, 1, 1, 1, 1, 1, 1, 1], 3));
    for (const mat of [siteMaterial(), siteGlowMaterial()]) {
      const m = new THREE.Mesh(tri, mat);
      m.visible = false;
      m.frustumCulled = false;
      m.name = "wildSites:warmup";
      this.group.add(m);
    }
    const places = wildSitePlacements(terrain);
    this.ready = places.length === 0 ? Promise.resolve() : source.then((geo) => {
      if (this.disposed) return;
      if (geo) this.build(places, geo);
      else this.buildFallback();
    });
  }

  private build(places: readonly WildSitePlacement[], geo: Map<string, THREE.BufferGeometry>) {
    for (const place of places) {
      const name = place.prefab.name;
      const g0 = geo.get(name), g1 = geo.get(`${name}_lod1`) ?? g0;
      if (!g0 || !g1) {
        console.warn(`[sites] ${name} missing from the GLB`);
        continue;
      }
      const m = frameMatrix(place);
      const mk = (g: THREE.BufferGeometry, mat: THREE.Material, label: string) => {
        const mesh = new THREE.Mesh(g, mat);
        mesh.name = `wildSite:${place.site.id}:${label}`;
        mesh.matrixAutoUpdate = false;
        mesh.matrix.copy(m);
        mesh.matrixWorldNeedsUpdate = true;
        mesh.visible = false;
        mesh.receiveShadow = true;
        this.group.add(mesh);
        return mesh;
      };
      const lod: [THREE.Mesh, THREE.Mesh] = [mk(g0, siteMaterial(), "lod0"), mk(g1, siteMaterial(), "lod1")];
      const gg = geo.get(`${name}_glow`);
      const glow = gg ? mk(gg, siteGlowMaterial(), "glow") : null;
      if (glow) glow.receiveShadow = false;
      const centre = new THREE.Vector3(place.frame.px, place.frame.py, place.frame.pz).addScaledVector(
        new THREE.Vector3(place.frame.ux, place.frame.uy, place.frame.uz), place.prefab.height * 0.4);
      const far = place.site.kind === "landmark" ? SITE_DRAW_DISTANCE.landmark : SITE_DRAW_DISTANCE.site;
      this.sites.push({ place, lod, glow, centre, far, shown: -1 });
    }
  }

  /** The colliders as plain stone (boxes and cylinders, two instanced draws). */
  private buildFallback() {
    const solids = wildSiteSolids(this.terrain);
    const mat = new THREE.MeshStandardNodeMaterial({ color: 0x8a8378, roughness: 0.9 });
    const box = new THREE.BoxGeometry(2, 1, 2).translate(0, 0.5, 0);
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 12).translate(0, 0.5, 0);
    for (const shape of [0, 1] as const) {
      const list = solids.filter((s) => s.shape === shape);
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(shape ? cyl : box, mat, list.length);
      const m = new THREE.Matrix4();
      list.forEach((s, i) => {
        m.set(s.rx * s.hx, s.ux * s.h, s.fx * s.hz, s.px, s.ry * s.hx, s.uy * s.h, s.fy * s.hz, s.py, s.rz * s.hx, s.uz * s.h, s.fz * s.hz, s.pz, 0, 0, 0, 1);
        im.setMatrixAt(i, m);
      });
      im.computeBoundingSphere();
      im.name = "wildSites:fallback";
      this.group.add(im);
      this.fallback.push(im);
    }
  }

  applySettings(s: ResolvedSettings) {
    this.lodDistance = SITE_LOD_DISTANCE[s.tier];
    this.shadows = s.tier !== "low";
    for (const x of this.sites) x.shown = -1;
  }

  /** Per frame: which sites show, at which detail level, and which cast shadows. */
  update(camera: THREE.Camera) {
    const cam = camera.position;
    for (const x of this.sites) {
      const d = cam.distanceTo(x.centre);
      if (d > x.far) {
        if (x.shown !== -1) {
          x.lod[0].visible = x.lod[1].visible = false;
          if (x.glow) x.glow.visible = false;
          x.shown = -1;
        }
        continue;
      }
      const lim = this.lodDistance + (x.shown === 0 ? LOD_HYSTERESIS : 0);
      const want: 0 | 1 = d < lim ? 0 : 1;
      if (want !== x.shown) {
        x.lod[0].visible = want === 0;
        x.lod[1].visible = want === 1;
        if (x.glow) x.glow.visible = true;
        x.shown = want;
      }
      const cast = this.shadows && d < SHADOW_DISTANCE;
      const mesh = x.lod[want];
      if (mesh.castShadow !== cast) mesh.castShadow = cast;
      x.lod[want ? 0 : 1].castShadow = false;
    }
  }

  /** Draw calls and triangles the sites add this frame (bench and the report). */
  stats(): { draws: number; triangles: number } {
    let draws = 0, triangles = 0;
    for (const x of this.sites) {
      if (x.shown === -1) continue;
      for (const m of [x.lod[x.shown], x.glow]) {
        if (!m) continue;
        draws++;
        triangles += (m.geometry.getAttribute("position")!.count / 3) | 0;
      }
    }
    return { draws, triangles };
  }

  dispose() {
    this.disposed = true;
    for (const x of this.sites) for (const m of [...x.lod, x.glow]) m?.removeFromParent();
    for (const f of this.fallback) {
      f.removeFromParent();
      f.dispose();
    }
    this.group.clear();
  }
}
