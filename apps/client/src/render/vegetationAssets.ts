// One meshopt GLB and one embedded PNG atlas, loaded before the quality probe and shader warm-up.
import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { abs, attribute, cameraViewMatrix, cross, dot, float, normalize, materialColor, mix, normalView, positionGeometry, positionLocal, positionViewDirection, positionWorld, renderGroup, select, sin, texture, time, uniform, vec3, vec4 } from "three/tsl";
import { BODY_IDS, PROP_KINDS, type BodyId, type PropKind } from "@firstlight/shared";
import { vegetationModels } from "./vegetationModels.ts";
import { config } from "../config.ts";
import { atmo } from "./atmosphere.ts";
import { PROP_PALETTES } from "./propGeometry.ts";
import { applyOccluderFade } from "./occluderFade.ts";

export interface VegetationAssets {
  geometry: Map<string, THREE.BufferGeometry>;
  atlas: THREE.Texture;
  impostors?: THREE.Texture;
}
let promise: Promise<VegetationAssets | null> | null = null;

export function preloadVegetation(): Promise<VegetationAssets | null> {
  return promise ??= load().catch((err: unknown) => {
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

const materials = new Map<string, THREE.MeshStandardNodeMaterial>();
/** One opaque alpha-tested atlas material per kind (and near/far), shared by every body: the body's
 * colours come from applyVegetationPalette. The color attribute is a role mask, not vertex colour:
 * r foliage, g bark, b stone, black flower/mushroom paint. */
export function vegetationMaterial(kind: PropKind, atlas: THREE.Texture, impostor = false): THREE.MeshStandardNodeMaterial {
  const key = `${kind}:${impostor ? "far" : "mesh"}`;
  let m = materials.get(key);
  if (m) return m;
  const t = tintsFor(kind);
  m = new THREE.MeshStandardNodeMaterial({ map: atlas, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.86, metalness: 0 });
  m.name = `vegetation:${key}`;
  const sample = texture(atlas);
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
  m.colorNode = sample.rgb.mul(tint).mul(mix(float(1), float(0.78), atmo.wet));
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
  if (!["rock", "boulder", "mushroom"].includes(kind)) {
    // No compute/storage buffers: attribute + time works on WebGPU and WebGL2.
    // Roots stay still; each instance carries its packed yaw seed through LOD changes.
    const weight = positionGeometry.y.mul(0.16).clamp(0, 1).pow(2);
    const phase = attribute("iWind", "float");
    const sway = sin(time.mul(1.4).add(phase).add(positionGeometry.y.mul(0.35))).mul(weight).mul(0.13);
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
