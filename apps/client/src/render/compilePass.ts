// Compile the scene for the render context its frames really use (warm-up, SPEC §4.1).
//
// three r186 keys a material's node build by the render context (RenderObject.getMaterialCacheKey adds
// `context.id`), and a context by (render target attachments, MRT, call depth) (RenderContexts.get).
// The game draws the scene through the post pipeline's scene pass: a half-float render target with
// its own MRT, rendered from inside the pipeline's quad render and any render-to-texture steps around
// it (call depth 2 on Medium, where FXAA wraps the chain). compileAsync(scene, camera) picks the
// canvas context at depth 0, so everything it compiled was a variant no frame used,
// and the first real warm-up frame built every material again in one go (WebGL: 0.7–4.9 s with the
// loading screen frozen, plus a synchronous program link per new shader).
//
// passCallDepth learns the pass's call depth from one render (the caller hides the scene, so it costs
// a background and the post quads); compileForPass selects the scene pass's target and MRT and asks
// for that depth while compileAsync chooses its context (synchronously, before its first await),
// then restores all three. compileAsync already builds and links one object at a time and yields between
// them, so the loading screen keeps animating.

/** The parts of three's Renderer this touches (private ones included; three is pinned, SPEC §3). */
export interface PassCompileRenderer {
  getRenderTarget(): unknown;
  setRenderTarget(target: unknown): void;
  getMRT(): unknown;
  setMRT(mrt: unknown): void;
  compileAsync(scene: unknown, camera: unknown): Promise<unknown>;
  _renderContexts?: { get(renderTarget?: unknown, mrt?: unknown, callDepth?: number): unknown };
}

export interface PassLike {
  renderTarget: unknown;
  getMRT(): unknown;
}

type ContextGet = (renderTarget?: unknown, mrt?: unknown, callDepth?: number) => unknown;

/** Run `fn` with three's context lookup wrapped; always unwraps. */
function withContextGet<T>(renderer: PassCompileRenderer, wrap: (get: ContextGet) => ContextGet, fn: () => T): T {
  const contexts = renderer._renderContexts!;
  const own = Object.prototype.hasOwnProperty.call(contexts, "get");
  const get = contexts.get;
  contexts.get = wrap(get);
  try {
    return fn();
  } finally {
    if (own) contexts.get = get;
    else delete (contexts as { get?: unknown }).get;
  }
}

/**
 * The call depth at which `renderOnce` asks for a context on `passTarget` (the scene pass's render
 * target), or null if it never does or three's internals aren't what this expects.
 */
export function passCallDepth(renderer: PassCompileRenderer, passTarget: unknown, renderOnce: () => void): number | null {
  if (typeof renderer._renderContexts?.get !== "function") return null;
  let depth: number | null = null;
  withContextGet(
    renderer,
    (get) =>
      function (this: unknown, renderTarget?: unknown, mrt?: unknown, callDepth = 0) {
        if (renderTarget === passTarget && depth === null) depth = callDepth;
        return get.call(this, renderTarget, mrt, callDepth);
      },
    renderOnce,
  );
  return depth;
}

/**
 * compileAsync for the scene pass's context (`depth` from passCallDepth). Falls back to the plain
 * call without a pass or a depth, or when three's internals aren't what this expects (a different
 * three version), so it never breaks a boot.
 */
export function compileForPass(renderer: PassCompileRenderer, scene: unknown, camera: unknown, pass: PassLike | null, depth: number | null): Promise<unknown> {
  const contexts = renderer._renderContexts;
  if (!pass || depth === null || !contexts || typeof contexts.get !== "function") return renderer.compileAsync(scene, camera);
  const prevTarget = renderer.getRenderTarget();
  const prevMrt = renderer.getMRT();
  try {
    renderer.setRenderTarget(pass.renderTarget);
    renderer.setMRT(pass.getMRT());
    // The context is chosen in compileAsync's synchronous part; the rest runs after we restore.
    return withContextGet(
      renderer,
      (get) =>
        function (this: unknown, renderTarget?: unknown, mrt?: unknown, callDepth = 0) {
          return get.call(this, renderTarget, mrt, renderTarget === pass.renderTarget && callDepth === 0 ? depth : callDepth);
        },
      () => renderer.compileAsync(scene, camera),
    );
  } finally {
    renderer.setRenderTarget(prevTarget);
    renderer.setMRT(prevMrt);
  }
}

/** The renderer state a pipeline render changes (public, plus three's render stack). Loosely typed:
 *  three's private fields aren't in its typings. */
export interface GuardedRenderer {
  getRenderTarget(): unknown;
  setRenderTarget(target: unknown, activeCubeFace?: number, activeMipmapLevel?: number): void;
  getActiveCubeFace?(): number;
  getActiveMipmapLevel?(): number;
  getMRT(): unknown;
  setMRT(mrt: unknown): void;
  toneMapping: unknown;
  outputColorSpace: unknown;
  xr?: { enabled: boolean };
  autoClear: boolean;
  autoClearColor: boolean;
  autoClearDepth: boolean;
  autoClearStencil: boolean;
  transparent: boolean;
  opaque: boolean;
  lighting: unknown;
  contextNode: unknown;
  _callDepth?: number;
  _currentRenderContext?: unknown;
  _currentRenderObjectFunction?: unknown;
  _handleObjectFunction?: unknown;
  _nodes?: { nodeFrame?: { renderId: number } };
}

/**
 * Save what a RenderPipeline render changes and only puts back when nothing throws (three r186:
 * RenderPipeline.render and PassNode.updateBefore restore without `finally`; Renderer._renderScene
 * leaves its call depth, current context and the lighting stack unbalanced). `restore(false)` after a
 * normal render puts the public state back; `restore(true)` after a throw also rebalances three's
 * render stack to where it was. The caller should still stop trusting the pipeline (see compileScene).
 */
export function saveRenderState(
  renderer: GuardedRenderer,
  scene: { visible: boolean; name: string; overrideMaterial: unknown },
  camera: { layers: { mask: number } },
): { restore(failed: boolean): void } {
  const r = renderer;
  const lightingStack = (r.lighting as { _cache?: unknown[] } | null)?._cache;
  const saved = {
    target: r.getRenderTarget(),
    cubeFace: r.getActiveCubeFace?.() ?? 0,
    mip: r.getActiveMipmapLevel?.() ?? 0,
    mrt: r.getMRT(),
    toneMapping: r.toneMapping,
    outputColorSpace: r.outputColorSpace,
    xr: r.xr?.enabled,
    autoClear: r.autoClear,
    autoClearColor: r.autoClearColor,
    autoClearDepth: r.autoClearDepth,
    autoClearStencil: r.autoClearStencil,
    transparent: r.transparent,
    opaque: r.opaque,
    lighting: r.lighting,
    contextNode: r.contextNode,
    visible: scene.visible,
    name: scene.name,
    overrideMaterial: scene.overrideMaterial,
    layers: camera.layers.mask,
    callDepth: r._callDepth,
    renderContext: r._currentRenderContext,
    renderObjectFunction: r._currentRenderObjectFunction,
    handleObjectFunction: r._handleObjectFunction,
    renderId: r._nodes?.nodeFrame?.renderId,
    lightingStack: lightingStack?.length,
  };
  return {
    restore(failed: boolean) {
      r.setRenderTarget(saved.target, saved.cubeFace, saved.mip);
      r.setMRT(saved.mrt);
      r.toneMapping = saved.toneMapping;
      r.outputColorSpace = saved.outputColorSpace;
      if (r.xr && saved.xr !== undefined) r.xr.enabled = saved.xr;
      r.autoClear = saved.autoClear;
      r.autoClearColor = saved.autoClearColor;
      r.autoClearDepth = saved.autoClearDepth;
      r.autoClearStencil = saved.autoClearStencil;
      r.transparent = saved.transparent;
      r.opaque = saved.opaque;
      r.lighting = saved.lighting;
      r.contextNode = saved.contextNode;
      scene.visible = saved.visible;
      scene.name = saved.name;
      scene.overrideMaterial = saved.overrideMaterial;
      camera.layers.mask = saved.layers;
      if (!failed) return;
      if (saved.callDepth !== undefined) r._callDepth = saved.callDepth;
      if ("_currentRenderContext" in r) r._currentRenderContext = saved.renderContext;
      if ("_currentRenderObjectFunction" in r) r._currentRenderObjectFunction = saved.renderObjectFunction;
      if ("_handleObjectFunction" in r) r._handleObjectFunction = saved.handleObjectFunction;
      if (saved.renderId !== undefined && r._nodes?.nodeFrame) r._nodes.nodeFrame.renderId = saved.renderId;
      if (lightingStack && saved.lightingStack !== undefined) lightingStack.length = saved.lightingStack;
    },
  };
}
