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
