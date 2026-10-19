// The sun shadow pass's main-thread costs (#49, D-framerate-1). Medium and up draw the sun's shadow map
// every frame, and in three r186 that pass took as much main-thread time as the main pass (M1,
// `?bench=g1` on Medium, CPU profile on both backends: 46% of the frame against 42%). Two of its costs
// were pure waste, and go here without changing a pixel:
//
// - three's shadow node draws the map with renderer.render(scene, shadowCamera), and every render()
//   starts with scene.updateMatrixWorld(): a second walk over the whole scene graph (3,500 objects in
//   Portus with 40 players, 2,700 of them bones) recomputing every matrix the main pass computed a
//   moment before. The shadow map is drawn from inside the main pass (the lights' shadow nodes update
//   before the first lit object is drawn), after that pass's own walk, so it skips its own.
// - The pass draws every caster with one override material and copies each caster's alphaTest into
//   it. Material's alphaTest setter bumps `version` whenever the value crosses 0, so with a single
//   cutout caster (a blossom, a cutout sign) among opaque ones the version moved several times a
//   frame, and every caster's render object recomputed its whole cache key (a walk over the
//   material's properties and node graph) every frame, only to find it unchanged. The override
//   material's alphaTest no longer bumps the version by itself; a caster material whose alpha-test
//   status changes bumps it once instead, so that caster's shadow render object is rebuilt as three
//   would rebuild it.
//
// `?oldshadowpass` keeps three's own pass (A/B runs).

import * as THREE from "three/webgpu";

/** What the shadow node's update gets: the frame's renderer and scene (three's NodeFrame). */
interface ShadowFrame {
  renderer: unknown;
  scene: { matrixWorldAutoUpdate: boolean };
}

/** The part of three's ShadowNode this wraps (three is pinned, SPEC §3). */
export interface ShadowNodeProto {
  updateShadow(frame: ShadowFrame): void;
  getShadowMaterial(): THREE.Material;
}

/** The renderer field three sets to the caster's own material while the override draws it. */
interface SourceAware {
  _currentSourceMaterial?: THREE.Material | null;
}

/** three's Material: alphaTest's backing field, and `version` (typed read-only, a plain counter at run time). */
type AlphaMaterial = { _alphaTest: number; version: number };

const stable = new WeakSet<THREE.Material>();

/**
 * Give the shadow pass's override material `m` an alphaTest that doesn't move its version as casters
 * come and go; it moves only when one caster's own material changes its alpha-test status (then that
 * caster's shadow render object is rebuilt, the others keep theirs). Without three's source-material
 * field it keeps three's own rule. Idempotent.
 */
export function stabiliseShadowMaterial(m: THREE.Material, renderer: unknown): void {
  if (stable.has(m)) return;
  stable.add(m);
  const self = m as unknown as AlphaMaterial;
  const r = renderer as SourceAware;
  const status = new WeakMap<THREE.Material, boolean>();
  Object.defineProperty(m, "alphaTest", {
    configurable: true,
    enumerable: false, // three's cache key lists the prototype's alphaTest getter already
    get: () => self._alphaTest,
    set: (v: number) => {
      const on = v > 0;
      const src = r._currentSourceMaterial;
      if (src) {
        const was = status.get(src);
        if (was !== undefined && was !== on) self.version++;
        status.set(src, on);
      } else if (on !== self._alphaTest > 0) self.version++;
      self._alphaTest = v;
    },
  });
}

const installs = new WeakMap<object, () => void>();

/**
 * Wrap three's shadow node (`proto`, default ShadowNode's) for the page's life: its pass skips the
 * scene's matrix walk and keeps a stable override material (see the header). Returns the undo (the
 * same one when already installed), or null when `proto` lacks three's methods (nothing changed).
 */
export function installShadowPass(proto: ShadowNodeProto = (THREE as unknown as { ShadowNode: { prototype: ShadowNodeProto } }).ShadowNode?.prototype): (() => void) | null {
  if (!proto || typeof proto.updateShadow !== "function" || typeof proto.getShadowMaterial !== "function") return null;
  const done = installs.get(proto);
  if (done) return done;
  const own = proto.updateShadow;
  proto.updateShadow = function (this: ShadowNodeProto, frame: ShadowFrame) {
    stabiliseShadowMaterial(this.getShadowMaterial(), frame.renderer);
    const scene = frame.scene;
    const auto = scene.matrixWorldAutoUpdate;
    scene.matrixWorldAutoUpdate = false;
    try {
      own.call(this, frame);
    } finally {
      scene.matrixWorldAutoUpdate = auto;
    }
  };
  const undo = () => {
    if (installs.get(proto) !== undo) return;
    proto.updateShadow = own;
    installs.delete(proto);
  };
  installs.set(proto, undo);
  return undo;
}
