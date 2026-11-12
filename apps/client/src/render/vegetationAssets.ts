// One meshopt GLB and one embedded PNG atlas, loaded before the quality probe and shader warm-up.
import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { abs, attribute, cameraPosition, cameraViewMatrix, cross, dot, float, Fn, fract, If, max, normalWorld, normalize, mix, normalView, positionGeometry, positionLocal, positionViewDirection, positionWorld, pow, renderGroup, select, sin, smoothstep, texture, time, uniform, varying, vec3, vec4 } from "three/tsl";
import { BODY_IDS, PROP_KINDS, type BodyId, type PropKind } from "@firstlight/shared";
import { vegetationModels } from "./vegetationModels.ts";
import { config } from "../config.ts";
import { atmo } from "./atmosphere.ts";
import { PROP_PALETTES } from "./propGeometry.ts";
import { applyOccluderFade } from "./occluderFade.ts";
import type { TextureSlot } from "./artpacks/ArtPacks.ts";
import { mossy } from "./meadow.ts";
import { detailNoiseTexture } from "./noiseTexture.ts";
import { biplanar, groundUniforms } from "./terrainMaterial.ts";

export interface VegetationAssets {
  geometry: Map<string, THREE.BufferGeometry>;
  atlas: THREE.Texture;
  impostors?: THREE.Texture;
}
let promise: Promise<VegetationAssets | null> | null = null;
let loaded: VegetationAssets | null = null;

export function preloadVegetation(): Promise<VegetationAssets | null> {
  return promise ??= load().then((a) => (loaded = a)).catch((err: unknown) => {
    console.warn("[vegetation] assets failed to load; using procedural props", err);
    return null;
  });
}

async function load(): Promise<VegetationAssets> {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(`${config.assetBase}/vegetation/vegetation.glb`);
  const geometry = new Map<string, THREE.BufferGeometry>();
  const textures = new Map<string, THREE.Texture>();
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const g = vegetationGeometry(mesh.geometry, mesh.matrixWorld);
    // Source attributes are immutable templates, shared by instance geometry clones.
    g.computeBoundingSphere();
    geometry.set(mesh.name, g);
    const map = (mesh.material as THREE.MeshStandardMaterial).map;
    if (map) textures.set((mesh.material as THREE.Material).name, map);
  });
  const atlas = textures.get("vegetation_atlas");
  if (!atlas) throw new Error("vegetation atlas missing");
  atlas.anisotropy = 4;
  const impostors = textures.get("vegetation_impostors");
  if (!impostors) throw new Error("vegetation impostor atlas missing");
  impostors.anisotropy = 4;
  return { geometry, atlas, impostors };
}

/** Validate the whole pack before installing any part of it on a live planet. */
export function validateVegetationAssets(assets: VegetationAssets): void {
  if (!assets.atlas?.isTexture) throw new Error("vegetation atlas missing");
  if (!assets.impostors?.isTexture) throw new Error("vegetation impostor atlas missing");
  const names = new Set(BODY_IDS.flatMap((body) => PROP_KINDS.flatMap((kind) => vegetationModels(body, kind))));
  for (const name of names) {
    if (!name) continue;
    for (const lod of [0, 1]) {
      const key = `${name}_L${lod}`;
      const geometry = assets.geometry.get(key);
      if (!geometry) throw new Error(`vegetation model missing: ${key}`);
      const count = geometry.getAttribute("position")?.count;
      for (const [attrName, size] of [["position", 3], ["normal", 3], ["uv", 2], ["color", 3]] as const) {
        const attr = geometry.getAttribute(attrName);
        // glTF may encode COLOR_0 as RGB or RGBA; the shader reads only the RGB role mask.
        const sizeValid = attr && (attr.itemSize === size || attrName === "color" && attr.itemSize === 4);
        if (!attr || !count || attr.count !== count || !sizeValid) {
          throw new Error(`vegetation attribute invalid: ${key}.${attrName}`);
        }
        for (let i = 0; i < count; i++) for (let c = 0; c < size; c++) {
          if (!Number.isFinite(attr.getComponent(i, c))) throw new Error(`vegetation attribute non-finite: ${key}.${attrName}`);
        }
      }
      const index = geometry.index;
      if ((index?.count ?? count!) % 3 !== 0) throw new Error(`vegetation triangles invalid: ${key}`);
      if (index) for (let i = 0; i < index.count; i++) {
        const v = index.getX(i);
        if (!Number.isInteger(v) || v < 0 || v >= count!) throw new Error(`vegetation index invalid: ${key}`);
      }
    }
  }
}

/** Quantized glTF positions are normalized integer attributes. Baking node transforms into
 * those integers would clamp/wrap the transformed metres; expand them to Float32 first. */
export function vegetationGeometry(source: THREE.BufferGeometry, matrix: THREE.Matrix4): THREE.BufferGeometry {
  const g = source.clone();
  for (const name of ["position", "normal"]) {
    const attr = g.getAttribute(name);
    if (!attr) continue;
    const values = new Float32Array(attr.count * 3);
    for (let i = 0; i < attr.count; i++) {
      values[i * 3] = attr.getX(i);
      values[i * 3 + 1] = attr.getY(i);
      values[i * 3 + 2] = attr.getZ(i);
    }
    g.setAttribute(name, new THREE.BufferAttribute(values, 3));
  }
  for (const name of Object.keys(g.attributes)) if (!["position", "normal", "uv", "color"].includes(name)) g.deleteAttribute(name);
  return g.applyMatrix4(matrix);
}

function tintRatio(target: number, source: number): THREE.Color {
  const a = new THREE.Color(target), b = new THREE.Color(source);
  return new THREE.Color(a.r / b.r, a.g / b.g, a.b / b.b);
}

const FOLIAGE_GAIN = 3.6;
/** Near crowns self-shadow and keep some of their own shading; flat impostor cards get neither.
 *  Browser check: far cards read brighter than the near meshes, so the LOD switch popped. */
const NEAR_FOLIAGE_UP = 0.85;
const IMPOSTOR_FOLIAGE = 0.88;

/**
 * Per-kind tints from the current body's palette (applyVegetationPalette), shared render-group
 * uniforms. Baked in as constants they made every body's vegetation a different shader: a travel
 * compiled and linked them all again (WebGL: a synchronous link each). As uniforms the shader is the
 * same on every body, so the programs the kept warm-up samples hold are reused.
 */
const tints = new Map<PropKind, { leaf: ReturnType<typeof colorUniform>; bark: ReturnType<typeof colorUniform>; stone: ReturnType<typeof colorUniform> }>();
const colorUniform = () => uniform(new THREE.Color(1, 1, 1)).setGroup(renderGroup);
function tintsFor(kind: PropKind) {
  let t = tints.get(kind);
  if (!t) tints.set(kind, (t = { leaf: colorUniform(), bark: colorUniform(), stone: colorUniform() }));
  return t;
}
let paletteBody: BodyId | null = null;

/** The palette tints for `kind` on `body` (leaf includes FOLIAGE_GAIN; bark and stone are ratios to the atlas paint). */
export function vegetationTints(body: BodyId, kind: PropKind): { leaf: THREE.Color; bark: THREE.Color; stone: THREE.Color } {
  const p = PROP_PALETTES[body];
  const leaf = new THREE.Color(kind === "blossom" ? p.blossom : kind === "pine" ? p.pine : kind === "scrub" ? p.scrub : p.leaf).multiplyScalar(FOLIAGE_GAIN);
  return { leaf, bark: tintRatio(p.bark, 0x6b4a2f), stone: tintRatio(kind === "boulder" ? p.rock2 : p.rock, 0xa3ada6) };
}

/** Load `body`'s vegetation tints into the shared uniforms (one body's props are live at a time). */
export function applyVegetationPalette(body: BodyId) {
  paletteBody = body;
  for (const kind of PROP_KINDS) {
    const t = tintsFor(kind);
    const v = vegetationTints(body, kind);
    t.leaf.value.copy(v.leaf);
    t.bark.value.copy(v.bark);
    t.stone.value.copy(v.stone);
  }
}

/** The shared tint uniforms of `kind` (tests and debugging). */
export function vegetationTintUniforms(kind: PropKind): { leaf: THREE.Color; bark: THREE.Color; stone: THREE.Color } {
  const t = tintsFor(kind);
  return { leaf: t.leaf.value, bark: t.bark.value, stone: t.stone.value };
}

/** The body whose palette the vegetation uniforms hold (null before the first PropSystem). */
export function vegetationPaletteBody(): BodyId | null {
  return paletteBody;
}

/**
 * Foliage and rock shading (`foliagefx`, D-gfx-worlds-6): 1 on Medium and up, 0 on Low and with
 * `?nofoliagefx` (environment.ts sets it with the settings). The extra shading sits behind a branch
 * on this uniform, so switching it off takes its cost away without another shader.
 */
export const vegetationFx = uniform(1).setGroup(renderGroup);

const materials = new Map<string, THREE.MeshStandardNodeMaterial>();

type TextureNode = ReturnType<typeof texture>;
/**
 * Per shipped atlas: what the vegetation materials draw for it now, their texture nodes and the
 * materials (`map`). An HD art pack (render/artpacks, D-artpacks) rebinds the near-mesh atlas in every
 * material made from it; materials made later draw what it is bound to.
 */
const atlases = new Map<THREE.Texture, { current: THREE.Texture; nodes: TextureNode[]; materials: THREE.MeshStandardNodeMaterial[] }>();
function atlasBinding(base: THREE.Texture) {
  let b = atlases.get(base);
  if (!b) atlases.set(base, (b = { current: base, nodes: [], materials: [] }));
  return b;
}

/** The slot of a shipped atlas: rebinding it (same type, format and sampler) changes no program. */
export function vegetationAtlasSlot(base: THREE.Texture): TextureSlot {
  const b = atlasBinding(base);
  return {
    get texture() {
      return b.current;
    },
    set(t: THREE.Texture) {
      b.current = t;
      for (const n of b.nodes) n.value = t;
      for (const m of b.materials) m.map = t;
    },
  };
}

/** The loaded assets (null before they land or after a failure), for the HD pack's slot. */
export function loadedVegetation(): VegetationAssets | null {
  return loaded;
}
/** One opaque alpha-tested atlas material per kind (and near/far), shared by every body: the body's
 * colours come from applyVegetationPalette. The color attribute is a role mask, not vertex colour:
 * r foliage, g bark, b stone, black flower/mushroom paint. */
export function vegetationMaterial(kind: PropKind, atlas: THREE.Texture, impostor = false): THREE.MeshStandardNodeMaterial {
  const key = `${kind}:${impostor ? "far" : "mesh"}`;
  let m = materials.get(key);
  if (m) return m;
  const t = tintsFor(kind);
  const bound = atlasBinding(atlas);
  m = new THREE.MeshStandardNodeMaterial({ map: bound.current, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.86, metalness: 0 });
  m.name = `vegetation:${key}`;
  const sample = texture(bound.current);
  bound.nodes.push(sample);
  bound.materials.push(m);
  // Impostor foliage was baked neutral grey, while bark retains its source paint. This gives
  // a pixel-level role mask without downloading a third atlas. Dead trees are entirely bark.
  const neutral = abs(sample.r.sub(sample.g)).add(abs(sample.g.sub(sample.b))).lessThan(0.025);
  const foliage = select(neutral, float(1), float(0));
  const role = impostor ? kind === "deadtree" ? vec3(0, 1, 0) : vec3(foliage, float(1).sub(foliage), 0) : attribute("color", "vec3");
  // Neutral foliage texels average ~0.25 linear (median 0.20) in both atlases; the leaf tint carries
  // FOLIAGE_GAIN so a typical leaf lands near the body's palette colour instead of a third of it.
  const leaf = impostor ? t.leaf.mul(IMPOSTOR_FOLIAGE) : t.leaf;
  const tint = leaf.mul(role.r).add(t.bark.mul(role.g)).add(t.stone.mul(role.b))
    .add(vec3(1).mul(float(1).sub(role.r.add(role.g).add(role.b))));
  const sways = !["rock", "boulder", "mushroom"].includes(kind);
  // Each plant its own shade (D-gfx-worlds-1): the instance's wind phase doubles as a colour seed, so
  // a stand of trees isn't one flat green, and the near mesh and its far card stay the same shade.
  const shade = sways ? float(0.84).add(fract(attribute("iWind", "float").mul(3.71)).mul(0.3)) : float(1);
  const painted = sample.rgb.mul(tint).mul(mix(float(1), shade, role.r));
  // Moss on the sky-facing tops of rocks, where the planet grows any (worldLooks.ts ground.moss).
  const rocky = !impostor && (kind === "rock" || kind === "boulder");
  const base = rocky
    ? mossy(painted, groundUniforms.mossColor, groundUniforms.moss, dot(normalize(normalWorld), normalize(positionWorld)), sample.g.add(sample.r).mul(0.5))
    : painted;
  // ---- foliagefx: the look that makes a tree a volume and a rock a surface (no new models).
  const tall = ["oak", "pine", "blossom", "deadtree"].includes(kind);
  // Height in the plant, 0 at the ground to 1 at the crown (models are in metres, roots at 0).
  const vY = varying(positionGeometry.y, "vVegY");
  const upW = normalize(positionWorld);
  const viewW = normalize(cameraPosition.sub(positionWorld));
  const sunUp = dot(atmo.sunDir, upW);
  const day = smoothstep(-0.02, 0.15, sunUp);
  // Rocks: one triplanar tap of the detail noise, taken outside the branch (WGSL allows no
  // screen-space derivatives inside one); a rock is a handful of pixels, so it is all but free.
  const rockN = normalize(normalWorld);
  const rockTap: any = rocky ? biplanar(detailNoiseTexture(), positionWorld.div(1.7), rockN) : null;
  const shaded: any = Fn(() => {
    const c = base.toVar();
    const tap: any = rockTap ? rockTap.toVar() : null; // evaluated here, ahead of the branch
    If(vegetationFx.greaterThan(0.5), () => {
      // Contact shade: every plant and rock darkens into the ground it stands on.
      const contact = mix(float(0.52), float(1), smoothstep(0.0, tall ? 1.3 : 0.45, vY));
      if (rocky) {
        // Rocks: grain and cracks from the detail noise (triplanar: no stretching on any face),
        // lichen or dust in patches, lighter tops.
        const d = tap;
        const upness = dot(rockN, upW);
        const grain = float(1).add(d.r.sub(0.5).mul(0.5)).sub(smoothstep(0.88, 0.97, d.b).mul(0.3));
        const patch = smoothstep(0.5, 0.64, d.g.add(upness.mul(0.12))).mul(groundUniforms.lichenAmt);
        const lit = c.mul(grain).mul(mix(float(0.82), float(1.12), upness.mul(0.5).add(0.5)));
        c.assign(mix(lit, groundUniforms.lichen.mul(d.r.mul(0.5).add(0.6)), patch).mul(contact));
      } else {
        // Leaf clusters: patches of the crown a metre or so across run lighter and yellower or
        // darker and bluer, so a canopy is many masses of leaves, not one flat green.
        const p = positionWorld;
        const n1 = sin(dot(p, vec3(0.93, 1.21, 0.71))).mul(sin(dot(p, vec3(-0.67, 0.88, 1.13))));
        const n2 = sin(dot(p, vec3(2.9, -2.3, 3.4)).add(n1.mul(2.0)));
        const cluster = n1.mul(0.7).add(n2.mul(0.3));
        const leafTint = mix(vec3(0.8, 0.94, 1.02), vec3(1.2, 1.1, 0.78), cluster.mul(0.5).add(0.5)).mul(cluster.mul(0.1).add(0.98));
        // The crown is darker inside and below, brightest at the top where the sky reaches it.
        const crown = mix(float(0.7), float(1.12), smoothstep(tall ? 1.6 : 0.1, tall ? 6.5 : 1.1, vY));
        const leafK = role.r;
        // The side of the crown toward the sun is lighter, the far side deeper (the lighting itself
        // treats a crown as one surface facing the sky, so it has no sides of its own).
        const sunSide = impostor ? float(1) : mix(float(1), mix(float(0.74), float(1.24), smoothstep(-0.6, 0.9, dot(normalize(normalWorld), atmo.sunDir))), day);
        c.assign(c.mul(mix(vec3(1), leafTint.mul(crown).mul(sunSide), leafK)).mul(mix(contact, float(1), leafK.mul(tall ? 1 : 0.4))));
      }
    });
    return c;
  })();
  m.colorNode = shaded.mul(mix(float(1), float(0.78), atmo.wet));
  if (!rocky) {
    // Light through and round the leaves: looking toward the sun the crown glows, the shaded side
    // keeps a little of the sun (wrap), and at dusk the low sun rims trunks and crown edges.
    (m as THREE.MeshStandardNodeMaterial).emissiveNode = Fn(() => {
      const e = vec3(0).toVar();
      If(vegetationFx.greaterThan(0.5), () => {
        const back = pow(max(dot(viewW.negate(), atmo.sunDir), 0.0), 4.0);
        const through = (atmo.sunColor as any).mul(base).mul(role.r).mul(back.mul(0.6).add(0.06)).mul(day);
        e.assign(through);
        if (!impostor) {
          const low = smoothstep(0.6, 0.12, sunUp).mul(smoothstep(-0.08, 0.04, sunUp));
          const fres = pow(float(1).sub(abs(dot(normalize(normalView), normalize(positionViewDirection)))), 3.0);
          const side = dot(viewW, atmo.sunDir).mul(-0.5).add(0.5);
          e.addAssign((atmo.sunColor as any).mul(mix(base, vec3(1), 0.25)).mul(fres.mul(low).mul(side).mul(0.5)));
        }
      });
      return e;
    })();
  }
  m.opacityNode = sample.a;
  m.roughnessNode = mix(float(0.86), float(0.4), atmo.wet);
  // Foliage is lit as a canopy facing the sky. Leaf cards' own normals flip on back faces, which
  // left half of every crown dark; crossed impostor cards are entirely horizontal. Near meshes keep
  // some of their own shading so the switch to impostors doesn't pop in brightness.
  const upView = normalize(cameraViewMatrix.mul(vec4(normalize(positionWorld), 0)).xyz);
  // A card's bark stands for the trunk side facing the viewer, so a back-lit trunk stays dark
  // like the mesh it replaces. The small up term keeps it defined when looking straight down.
  const towardViewer = normalize(positionViewDirection.sub(upView.mul(dot(positionViewDirection, upView))).add(upView.mul(0.1)));
  if (impostor) m.normalNode = normalize(mix(towardViewer, upView, role.r));
  else if (!["rock", "boulder", "mushroom", "deadtree"].includes(kind)) m.normalNode = normalize(mix(normalView, upView, role.r.mul(NEAR_FOLIAGE_UP)));
  if (sways) {
    // No compute/storage buffers: attribute + time works on WebGPU and WebGL2.
    // Roots stay still; each instance carries its packed yaw seed through LOD changes.
    const weight = positionGeometry.y.mul(0.16).clamp(0, 1).pow(2);
    const phase = attribute("iWind", "float");
    const sway = sin(time.mul(1.4).add(phase).add(positionGeometry.y.mul(0.35))).mul(weight).mul(0.13)
      // Canopy flutter: leaves shiver on their own, faster and smaller than the trunk's sway.
      .add(impostor ? float(0) : sin(time.mul(3.3).add(phase.mul(1.7)).add(dot(positionGeometry, vec3(1.9, 2.7, 1.3)))).mul(attribute("color", "vec3").r).mul(weight.mul(0.6).add(0.2)).mul(0.035).mul(vegetationFx));
    // r186 applies instance transforms before positionNode. Bend in planet tangent space
    // while preserving that transformed position, including on the shadow pass.
    const up = normalize(positionLocal);
    const ref = select(abs(up.y).lessThan(0.95), vec3(0, 1, 0), vec3(1, 0, 0));
    const tangent = normalize(cross(ref, up));
    m.positionNode = positionLocal.add(tangent.mul(sway));
  }
  // Trunks, crowns and rocks between the camera and the player dissolve (occluderFade.ts).
  applyOccluderFade(m);
  materials.set(key, m);
  return m;
}
