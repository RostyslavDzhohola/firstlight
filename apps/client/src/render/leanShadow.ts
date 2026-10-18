// Lean shadow casters (#39, D-load-3). three's shadow pass draws every caster with one override
// material, but asks Renderer._getShadowNodes(material) for the caster's own nodes and builds them
// into the override: the colour (for its alpha: a cutout), depth, position and mask. So the avatars'
// toon colour (the albedo texture, the palette constants) and the horses' coat colours were built
// into their shadow fragments, though the alpha they gave was a constant 1 and the shadow pass writes
// depth only: every look × palette (42) and coat (6) had its own shadow build and pipeline, and with
// each skinned build's own bone-buffer name no two shared a GPU program either.
//
// A material registered here (leanShadow(m): avatarMaterial, horseMaterial) takes three's default
// opaque shadow path instead (no colour node): every caster of one rig and side shares one shadow
// build, 2 in all, and writes the same depth. Whenever a registered material carries anything that
// shapes its shadow (a texture map, an alpha test or map, transparency, a cast-shadow, depth or
// position node, a mask other than the camera fade's keep-all) it goes through three's own path, as
// unregistered materials (weapons, cosmetics) always do.
//
// installLeanShadows() wraps the renderer's method for the renderer's whole life (createRenderer, before
// the first shadow render): play renders the shadow map every frame, and three caches shadow nodes per
// material version. Without three's method (another version) nothing changes. `?fullshadow` leaves
// three's own path everywhere (A/B runs).

import type * as THREE from "three/webgpu";
import { keepsWholeShadow } from "./occluderFade.ts";

/** What three's shadow pass takes from a caster's material. */
export interface ShadowNodes {
  version?: number;
  colorNode: unknown;
  depthNode: unknown;
  positionNode: unknown;
}

/** The private part of three's Renderer this touches (three is pinned, SPEC §3). */
export interface ShadowNodesRenderer {
  _getShadowNodes?: (material: THREE.Material) => ShadowNodes;
}

const registered = new WeakSet<THREE.Material>();

/** Let `m` cast a lean shadow whenever nothing in it shapes its shadow (see castsLeanShadow). */
export function leanShadow<M extends THREE.Material>(m: M): M {
  registered.add(m);
  return m;
}

const isNode = (x: unknown) => !!x && (x as { isNode?: boolean }).isNode === true;

/**
 * Whether `m` takes the default opaque shadow path now: registered, and nothing that shapes its
 * shadow. The mask three would use for shadows is maskShadowNode, else maskNode; the camera fade's
 * keep-all shadow mask (occluderFade.ts) discards nothing, so it doesn't count.
 */
export function castsLeanShadow(m: THREE.Material): boolean {
  if (!registered.has(m)) return false;
  const x = m as THREE.Material & Partial<Record<"map" | "alphaMap" | "castShadowNode" | "depthNode" | "castShadowPositionNode" | "positionNode" | "maskShadowNode" | "maskNode", unknown>>;
  if ((x.map as THREE.Texture | null | undefined)?.isTexture || x.alphaMap || m.alphaTest > 0 || m.transparent) return false;
  if (isNode(x.castShadowNode) || isNode(x.depthNode) || isNode(x.castShadowPositionNode) || isNode(x.positionNode)) return false;
  const mask = x.maskShadowNode || x.maskNode;
  return !isNode(mask) || keepsWholeShadow(mask);
}

const installed = new WeakSet<object>();

/** Whether `renderer` has lean shadows (installLeanShadows ran on it). */
export function leanShadowsOn(renderer: object): boolean {
  return installed.has(renderer);
}

/**
 * Registered materials cast lean shadows on `renderer` from now on (idempotent). False when three's
 * method isn't there (nothing changed).
 */
export function installLeanShadows(renderer: ShadowNodesRenderer): boolean {
  const own = renderer._getShadowNodes;
  if (typeof own !== "function") return false;
  if (installed.has(renderer)) return true;
  installed.add(renderer);
  const lean = new WeakMap<THREE.Material, ShadowNodes>();
  renderer._getShadowNodes = function (this: unknown, material: THREE.Material): ShadowNodes {
    if (!castsLeanShadow(material)) return own.call(this, material);
    let nodes = lean.get(material);
    if (nodes?.version !== material.version) {
      nodes = { version: material.version, colorNode: null, depthNode: null, positionNode: null };
      lean.set(material, nodes);
    }
    return nodes;
  };
  return true;
}
