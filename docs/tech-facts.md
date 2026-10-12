# FIRSTLIGHT technical brief: verified versions, APIs and platform limits

Checked live on **2026-10-11**. `DECISIONS.md` is ground truth; this file only says how to build what it decided. Sources:

- the npm registry (`npm view`, plus tarballs unpacked into `/tmp` and read with grep);
- GitHub (`gh api`, and a sparse clone of three.js tag `r186`);
- official docs fetched with curl;
- the vendors' own CLI `--help` output.

**Labels.** **Measured** means I ran it this session on the owner's M1 (Node 24.19). **UNVERIFIED** means no primary source confirmed it. Where an earlier report disagrees, this file wins; the corrections are listed in each section.

---

## 1. Versions and pin list

### Verified facts

Versions come from `npm view {pkg} version` and publish dates from `time[<version>]` (https://registry.npmjs.org/{pkg}).

| Package | Latest | Published | Pin | Notes |
|---|---|---|---|---|
| `three` | 0.186.1 (r186) | 2026-09-24 | **`0.186.1` exact** | No r187 tag yet. `dev` is `187dev` and changes light registration and PMREM ([migration guide](https://github.com/mrdoob/three.js/wiki/Migration-Guide)) |
| `@types/three` | 0.186.0 | 2026-09-11 | `0.186.0` | |
| `colyseus` | 0.18.9 | 2026-09-30 | `0.18.9` exact | `engines.node >= 22.x`. Its dependencies pull in `@colyseus/auth`, redis-presence, redis-driver (ioredis), monitor and playground (see §4) |
| `@colyseus/core` | 0.18.18 | 2026-09-29 | `0.18.18` exact | Peer deps: `express ^4.16 \|\| ^5`, `zod ^4.1.12` |
| `@colyseus/schema` | 5.0.36 | 2026-10-03 | `5.0.36` exact | Prefers the `schema()`/`t.*` builders over decorators (§4) |
| `@colyseus/ws-transport` | 0.18.4 | 2026-09-25 | `0.18.4` | |
| `@colyseus/tools` | 0.18.9 | 2026-10-05 | `0.18.9` | `listen()` reads `PORT` |
| **`@colyseus/sdk`** (client) | 0.18.5 | 2026-10-03 | **`0.18.5`** | **The 0.18 client.** `colyseus.js` stopped at 0.16.22 (2025-10-22). It depends on `@colyseus/schema ^3` and can't talk to a 0.18 server ([migrating/0.17](https://docs.colyseus.io/migrating/0.17)) |
| `better-auth` | 1.7.7 | 2026-09-30 | `1.7.7` exact | `anonymous`, `emailOTP` and `jwt` plugins all exist (§5) |
| `vite` | 8.3.4 | 2026-10-08 | `^8.3.4` | Rolldown-based. Needs Node `^20.19 \|\| >=22.12` |
| `@vitejs/plugin-react` | 6.1.2 | 2026-10-05 | `6.1.2` | Peer `vite ^8` |
| `react`, `react-dom` | 19.3.0 | 2026-09-09 | `19.3.0` | DOM UI only (D7) |
| `zustand` | 5.0.15 | 2026-08-13 | `5.0.15` | |
| `@dimforge/rapier3d-compat` | 0.21.0 | 2026-09-25 | `0.21.0` exact | 0.20 moved the compat files into `dist/`. 0.21 changes low-level pipeline signatures (soft bodies) ([changelog](https://github.com/dimforge/rapier/blob/master/bindings/typescript/CHANGELOG.md)). The bindings now live in `dimforge/rapier/bindings/typescript`, and the old `rapier.js` repo is archived in all but name |
| `three-mesh-bvh` | 0.9.16 | 2026-10-08 | `0.9.16` | 0.9.16 fixes the BVH helper on r186 ([release](https://github.com/gkjohnson/three-mesh-bvh/releases/tag/v0.9.16)). CPU raycast doesn't depend on the renderer; WebGPU compute helpers exist |
| `recast-navigation` | 0.43.1 | 2026-02-04 | **not installed** | D4: no navmesh |
| `@gltf-transform/core`, `/functions`, `/extensions`, `/cli` | 4.5.1 | 2026-09-28 | `4.5.1` | Build-time only |
| `meshoptimizer` | 1.3.0 | 2026-09-25 | `1.3.0` | three r186 also bundles `examples/jsm/libs/meshopt_decoder.module.js` |
| `@dgreenheck/three-pinata` | 2.0.1 | 2025-11-11 | `2.0.1` | MIT. Peer `three >=0.158` (§3) |
| `wrangler` | 4.149.0 | 2026-10-08 | `4.149.0` (devDep / npx) | `engines.node >= 22` |
| `resend` | 6.32.1 | 2026-10-06 | `6.32.1` | `engines.node >= 20` |
| `better-sqlite3` | 13.0.3 | 2026-08-05 | `13.0.3` | **v13 is N-API with prebuilds inside the npm tarball** (linux-x64, linuxmusl-x64, darwin-arm64…), so GitHub releases have no assets ([v13.0.0 notes](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0)). `engines.node >=22`. No bundled types: use `@types/better-sqlite3` 9.6.0, which lags behind (no `db.explain()`) |
| `zzfx` | 1.4.0 | 2026-10-01 | `1.4.0` | MIT. `ZzFX.js` uses ES `export` but `package.json` has no `"type": "module"` and no types: fine through Vite, but add a `declare module "zzfx"` shim and never import it in Node |
| `typescript` | **7.0.2** | 2026-07-08 | `7.0.2` (typecheck only) | **The native Go compiler, with no JS API** (§1 implications) |
| `vitest` | 5.0.3 | 2026-09-30 | `5.0.3` | Node `^22.12 \|\| ^24 \|\| >=26`; peer `vite ^6.4 \|\| ^7 \|\| ^8` |
| `playwright`, `@playwright/test` | 1.64.0 | 2026-10-07 | `1.64.0` | |
| `express` | 5.3.0 | 2026-10-09 | `5.3.0` | Pin it yourself. Express 5 route syntax is `/api/auth/*splat` |
| `jose` | 6.2.12 | 2026-09-05 | `6.2.12` | JWKS verification in `onAuth` |
| `vercel` CLI | 63.1.2 | 2026-10-09 | npx | |
| `@railway/cli` | 5.64.2 | 2026-10-09 | npx | |

**Node.**
- **Node 24 "Krypton" is the current LTS:** 24.21.0, released 2026-09-07. It is Active LTS until 2026-10-20, then in maintenance until 2028-04-30. Node 26 is still "Current" (26.11.1) and only becomes LTS on **2026-10-28**. Sources: https://nodejs.org/dist/index.json, https://raw.githubusercontent.com/nodejs/Release/main/schedule.json
- **`node:sqlite` is not stable.** The docs for both v24 and v26 show "Stability: 1.2 - Release candidate" (RC since v24.15.0, [PR 61262](https://github.com/nodejs/node/pull/61262)). Sources: https://nodejs.org/docs/latest-v24.x/api/sqlite.html, https://nodejs.org/docs/latest-v26.x/api/sqlite.html
  - Measured: `DatabaseSync` works on 24.19 and bundles SQLite 3.53.3.

**TypeScript 7.0** ([announcement, 2026-07-08](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)):
- "does not ship with an API"; a new API is expected in 7.1. `@typescript/typescript6` (6.0.2) gives a side-by-side `tsc6` for tools that need the old API, such as typescript-eslint.
- The package's main export is now just `lib/version.cjs`.
- New defaults:
  - `strict: true`;
  - `types: []` (list `@types` explicitly);
  - `rootDir: ./`;
  - `noUncheckedSideEffectImports: true`.
- Hard errors: `baseUrl`, `moduleResolution: node/node10/classic`, `target: es5`, `esModuleInterop: false`.
- `@colyseus/schema` 5 supports TS 5, 6 and 7. Its `schema-codegen` needs TS 5 or 6, but a TypeScript client shares the schema files and doesn't need codegen (schema README in the 5.0.36 tarball).

**Bundle weight (measured, from the 0.21.0 tarballs):**
- `@dimforge/rapier3d-compat` `dist/rapier.mjs` (WASM inlined as base64): 4.34 MB raw, **1.65 MB gzip**, 1.20 MB brotli.
- Non-compat `@dimforge/rapier3d` `.wasm`: 3.08 MB raw, **1.17 MB gzip**, 0.85 MB brotli.

### Spec implications

- **Runtime: Node 24 LTS** (`"engines": {"node": ">=24 <25"}`, and pin the same on Railway). Colyseus, better-sqlite3 13 and wrangler all need ≥ 22. Moving to Node 26 after 2026-10-28 is optional.
- **SQLite driver: `better-sqlite3` 13.0.3, not `node:sqlite`**, which is still a release candidate. Keep the database behind one small module so it can be swapped later.
- **TypeScript 7.0.2 is used only for `tsc --noEmit`.**
  - Vite, Vitest and tsx transpile without it.
  - Set `"types": ["node"]` on the server and `["vite/client"]` on the client, `moduleResolution: "bundler"` on the client and `"nodenext"` on the server, with no `baseUrl`.
  - Don't add typescript-eslint. DECISIONS says "No CI"; if linting is added later, install `@typescript/typescript6` next to it.
- **Write Colyseus state with `schema()` / `t.*` builders, not `@type` decorators.** Decorators need `experimentalDecorators` + `useDefineForClassFields: false`, which "conflict with modern toolchain defaults (esbuild, SWC, Vite)" (schema README).
- **Client SDK: `@colyseus/sdk`.** Never install `colyseus.js`, and never install `@next` tags (they point at older 0.18 builds).
- **Rapier: use `-compat` on the client** (no WASM plugin needed in Vite), loaded after first paint. It costs ~1.65 MB gz of the 25 MB budget. Switch to the non-compat build plus a WASM plugin only if that becomes the bottleneck (it would save ~0.5 MB gz).
- Lockfile committed. Exact pins for `three`, `colyseus*`, `better-auth` and `@dimforge/*`: all four ship breaking changes in patch or minor releases.

---

## 2. three.js WebGPURenderer + TSL (r186)

### Verified facts

**Status**
- Still called experimental. The manual says: "The renderer itself is still in an experimental state although its maturity level has been greatly improved in the last years. Still, depending on your application and scene setup, you will encounter missing features or a better performance with `WebGLRenderer`." Sources: https://threejs.org/manual/pages/webgpurenderer.html (fetched today), https://github.com/mrdoob/three.js/blob/r186/manual/pages/webgpurenderer.html
- The same page lists `ShaderMaterial`, `RawShaderMaterial`, `onBeforeCompile()` and `EffectComposer` as not supported.
- r186 renamed the examples category from "webgpu (wip)" to "webgpu" ([commit d51eb06](https://github.com/mrdoob/three.js/commit/d51eb061e673cb9ec7f22c0277eefe925d7e2f05)).

**Fallback and imports**
- On fallback the renderer warns `WebGPU is not available, running under WebGL2 backend.` ([WebGPURenderer.js#L67](https://github.com/mrdoob/three.js/blob/r186/src/renderers/webgpu/WebGPURenderer.js#L67)).
- To find out which backend you got, check `renderer.backend.isWebGPUBackend` after `await renderer.init()`.
- Imports: `three/webgpu` → `build/three.webgpu.js`; `three/tsl` → `build/three.tsl.js`; `three/addons/*` → `examples/jsm/*` ([package.json](https://github.com/mrdoob/three.js/blob/r186/package.json)).
- `three` and `three/webgpu` both import `./three.core.js` (measured in the tarball), so core classes such as `Mesh` and `BufferGeometry` are shared with libraries that import plain `three`.

**Post-processing driver**
- The driver is **`RenderPipeline`** from `three/webgpu`. `PostProcessing` is a deprecated alias (since r183) that warns once.
- It has only `render()` and `dispose()`; there is **no compile method**.
- r186 adds `DirectRenderPipeline`.
- Sources: [Three.WebGPU.js#L14-16](https://github.com/mrdoob/three.js/blob/r186/src/Three.WebGPU.js#L14-L16), [RenderPipeline.js](https://github.com/mrdoob/three.js/blob/r186/src/renderers/common/RenderPipeline.js)

**Post nodes in r186** (48 files in [examples/jsm/tsl/display](https://github.com/mrdoob/three.js/tree/r186/examples/jsm/tsl/display); all paths below are `three/addons/tsl/display/<file>`):

| Effect | File → export | WebGL2 fallback | Notes |
|---|---|---|---|
| Bloom | `BloomNode.js` → `bloom(node, strength, radius, threshold)` | No guard | r186 made the blur faster. `AnamorphicNode` was removed in r185 |
| GTAO | `GTAONode.js` → `ao(depth, normal, camera)` | No guard | Needs a normal MRT. r185 made it darker and wider; r186 deprecated `distanceExponent`/`distanceFallOff` |
| SSAO (new in r186) | `SSAONode.js` → `ssao(depth, normal, camera)` | No guard | Cheaper AO option |
| SSR | `SSRNode.js` → `ssr(color, depth, normal, options)` | No guard | API changed in r185. Env map must be equirect HDR; PMREM isn't supported ([L709](https://github.com/mrdoob/three.js/blob/r186/examples/jsm/tsl/display/SSRNode.js#L709)) |
| TRAA | `TRAANode.js` → `traa(beauty, depth, velocity, camera)` | No guard | "MSAA must be disabled". Ghosting issue [#31892](https://github.com/mrdoob/three.js/issues/31892) is open |
| TAAU | `TAAUNode.js` → `taau(...)` | No guard | Added in r184; MSAA off |
| FXAA | `FXAANode.js` → `fxaa(node)` | No guard | Needs sRGB input: `outputColorTransform = false` plus `renderOutput()` |
| SMAA | `SMAANode.js` → `smaa(node)` | No guard | |
| DoF | `DepthOfFieldNode.js` → `dof(node, viewZ, focusDistance, focalLength, bokehScale)` | No guard | Photo mode |
| LUT grade | `Lut3DNode.js` → `lut3D(node, lut, size, intensity)` | No guard (WebGL2 has 3D textures) | Core `three/tsl` also has `cdl`, `saturation`, `vibrance`, `hue` and `posterize` |
| God rays | `GodraysNode.js` → `godrays(depth, camera, light)` | No guard | Point/directional lights only, with full shadows. **Won't accept the new `SunLight`** (`isSunLight`, not `isDirectionalLight`) |
| Volumetric light | core `VolumeNodeMaterial`; also `webgpu_postprocessing_fog` example | No guard | A material, not a pass |
| Outline, motion blur, film grain, vignette, chromatic aberration, FSR1 | `OutlineNode`, `MotionBlur`, `FilmNode`, `CRT.js` (`vignette`), `ChromaticAberrationNode`, `FSR1Node` | No guard | `lensDirt()` is on `dev` only |

What "no guard" means:
- Only `SSGINode` (WebGPU-only `rg11b10` check) and `OITPassNode` (MSAA) test the backend at all.
- None of the 33 `webgpu_postprocessing_*` examples check `WebGPU.isAvailable()`.
- CI screenshots skip `_ao`, `_dof`, `_ssgi`, `_sss` and `_traa` as "Black screen" ([puppeteer.js#L23-31](https://github.com/mrdoob/three.js/blob/r186/test/e2e/puppeteer.js#L23-L31)).
- So these effects build on WebGL2, but **nobody regression-tests that they look right or run fast there**.

**Compute on the WebGL2 fallback: it runs, but it is limited.**
- `WebGLBackend.compute()` uses transform feedback with `RASTERIZER_DISCARD` and `drawArrays(POINTS)` ([WebGLBackend.js#L918-981](https://github.com/mrdoob/three.js/blob/r186/src/renderers/webgl-fallback/WebGLBackend.js#L918-L981)).
- Dispatch is 1-D only: `[x,y,z]` warns and uses `x`. Indirect dispatch warns and falls back to `count`.
- Each invocation can write only its own element. Reading other elements needs `.setPBO(true)`.
- Barriers do nothing.
- Subgroups raise an error.
- There is no `workgroupArray`, no `textureStore` and no atomics: they are WGSL-only.
- Examples that need those (`compute_texture`, `sort_bitonic`…) check `WebGPU.isAvailable()`. Simple particle examples don't.

**Warm-up**
- `async init()` ([Renderer.js#L784](https://github.com/mrdoob/three.js/blob/r186/src/renderers/common/Renderer.js#L784)).
- `async compileAsync(scene, camera, targetScene = null, onProgress = null)` (L896). It yields between objects, but it **frustum-culls and picks the active LOD only**; WebGLRenderer's compile doesn't cull. r186 **skips shadow maps during precompile** (PR #33924).
- `async compileComputeAsync(computeNodes, onProgress)` is new in r186 (L1115).
- `renderer.debug.onNodeBuilderCreated` (r186, #34068) can count shader builds.
- `renderAsync()` is deprecated: use `render()` after `await init()`.

**Open issues that bite**
- [#34681](https://github.com/mrdoob/three.js/issues/34681): `PassNode.compileAsync()` has been broken since r183 and still is on `dev`.
  - A reporter measured 294 synchronous node builds, ~1.7 s of main thread, on the first `RenderPipeline.render()` with `fxaa()` (M4 Max).
  - A community fix (#34717) was closed unmerged on 2026-09-30.
- [#33821](https://github.com/mrdoob/three.js/issues/33821): material init is 16–36× slower than WebGLRenderer in a 10k-mesh microbenchmark.
  - Cause: a unique `uniform()` node per material produces a unique builder state.
  - Workaround: the `webgpu_instance_uniform` pattern.
- [#30560](https://github.com/mrdoob/three.js/issues/30560): "Current UBO system has severe performance issues with many render items". Labelled **High priority**, and the only open one.
  - Both backends are affected, and Metal is worst.
  - Third-party measurement on r186: WebGL2 backend 2.88 ms CPU vs WebGLRenderer 2.20 ms, ~2,350 vs ~1,300 GL calls.

**Batching**
- `BatchedMesh` on the WebGL2 fallback uses `WEBGL_multi_draw`, with a per-draw uniform loop as fallback since r184.
- On WebGPU it loops `drawIndexed` once per sub-draw; it is **not** a true multi-draw ([WebGPUBackend.js#L2124-2140](https://github.com/mrdoob/three.js/blob/r186/src/renderers/webgpu/WebGPUBackend.js#L2124-L2140)).
- `InstancedMesh` draws instanced on both backends.

**Shadows**
- `CSMShadowNode` (`three/addons/csm/CSMShadowNode.js`) works with WebGPURenderer only.
- New in r186: `SunLight` (`three/addons/lights/SunLight.js`): 2 cascades in one atlas, 1024² each.
  - Registered with `renderer.library.addLight(SunLightNode, SunLight)` in r186. This changes on `dev`.
- `PCFSoftShadowMap` was removed for WebGPURenderer in r186.

**Loaders**
- `KTX2Loader.detectSupport(renderer)` handles `isWebGPURenderer` through `renderer.hasFeature('texture-compression-*')`.
- `detectSupportAsync` is deprecated (r181): call `await renderer.init()` first (measured: `examples/jsm/loaders/KTX2Loader.js#L213-241` in the 0.186.1 tarball).

**Browsers**
- Safari 26.0 "adds support for WebGPU", and Safari 26.0 installs on Sonoma, Sequoia and Tahoe ([WebKit blog](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)).
  - r2-15 said `navigator.gpu` is missing on macOS 15. The WebKit post states no macOS requirement (**UNVERIFIED** either way).
- Firefox: Windows since 141; Apple-silicon macOS 26 since 145; older Apple-silicon macOS since 147; no Intel Mac, Linux or Android ([MDN BCD](https://github.com/mdn/browser-compat-data/blob/main/api/GPU.json)).

**Release-note churn (r183→r186)** ([releases](https://github.com/mrdoob/three.js/releases))
- `PostProcessing` → `RenderPipeline`.
- TSL renames (`directionToColor` → `packNormalToRGB`).
- `TiledLighting` → `ClusteredLighting`.
- `Source` → `TextureSource`.
- `Object3D.dispose()` added (subclasses call `super.dispose()`).
- `Sky` lost its `up` uniform.
- The CJS build is deprecated and the minified builds were removed.

### Spec implications

- **Pick the tier from the backend actually obtained:**
  1. `const r = new WebGPURenderer({ antialias: false }); await r.init();`
  2. `const webgpu = r.backend.isWebGPUBackend;`
  3. Run the ~2 s benchmark.
  4. Choose the tier.
- **Low/Medium on either backend:** `RenderPipeline` with `bloom` → `lut3D` (or `cdl` + `saturation`) → `fxaa`/`smaa`, and `outputColorTransform = false` with an explicit `renderOutput()`. Nothing WebGPU-only.
- **High/Ultra, gated by `isWebGPUBackend` (a decision, not a capability limit):**
  - `ao()` (GTAO);
  - `traa()` with MSAA off;
  - lake reflections via `ssr()` (needs normal and velocity MRT outputs);
  - compute grass and particles.
- **On the fallback, never build the compute nodes.** Use CPU or instanced-attribute grass and particles instead.
- **Fog/volumetrics:** use a height-fog node in the material plus a sky shader. Use `godrays()` only with a shadow-casting `DirectionalLight`, not `SunLight`.
- **Shadows:**
  - Low: blob shadows.
  - Medium: one `DirectionalLight` map with `PCFShadowMap`.
  - High/Ultra: `SunLight` (2×1024²) or `CSMShadowNode`.
- **Warm-up protocol (the loading screen hides it):**
  1. `await renderer.init()`.
  2. For each zone and tier: temporarily set `frustumCulled = false` on all meshes, force every LOD level, then run `await renderer.compileAsync(scene, camera, undefined, onProgress)`.
  3. `await renderer.compileComputeAsync(nodes)`.
  4. Render 3–5 real frames of the full `RenderPipeline` with shadows enabled, behind an opaque loading overlay.
  5. Hook `renderer.debug.onNodeBuilderCreated` and assert **zero** new builds over the next 120 frames in a test.
  6. Repeat when the tier changes.
- **Draw-call discipline** (because of #30560 and #33821):
  - share `NodeMaterial` instances;
  - never create a unique `uniform()` per material (use per-instance attributes or the instance-uniform pattern);
  - use `InstancedMesh` for vegetation and props, and `BatchedMesh` for kit pieces;
  - set `object.static = true` on static meshes;
  - budget **≤ ~300 draws on Medium**, then measure.
- **Loaders:** call `ktx2.detectSupport(renderer)` only after `init()`.
- **Renderer gate (DECISIONS):** the M1 Air test must run on the browser the owner records with. Also run it with `forceWebGL: true` to prove the fallback.
- Use only TSL and node materials. No `ShaderMaterial`, `onBeforeCompile` or pmndrs `postprocessing`, unless the gate fails and the plan switches to WebGLRenderer.

---

## 3. three-piñata (`@dgreenheck/three-pinata` 2.0.1)

### Verified facts

**Licence**
- MIT: npm `license: "MIT"`, and the tarball ships `LICENSE` ("Copyright (c) 2023 Daniel Greenheck").
- The GitHub repo keeps that file in `lib/LICENSE`, so GitHub's licence detection returns none. The `demo/` folder has no licence file.
- Open issue [#26](https://github.com/dgreenheck/three-pinata/issues/26) ("Is this library open source?", 2026-04-24) has no answer.
- Repo: 445 stars; last push 2026-05-12, demo meta tags only; last library release 2.0.1 on 2025-11-11. https://github.com/dgreenheck/three-pinata

**API**
- `new DestructibleMesh(geometry, outerMaterial, innerMaterial?)` extends `THREE.Mesh`.
- `.fracture(new FractureOptions({...}), onFragment?, onComplete?) → DestructibleMesh[]`. Fracture options:
  - `fractureMethod: "voronoi" | "simple"`;
  - `fragmentCount` (default 50);
  - `voronoiOptions: { mode: "3D" | "2.5D", seedPoints?, impactPoint?, impactRadius?, useApproximation? }`;
  - `seed`;
  - `textureScale`/`textureOffset` for the inner faces.
- `.slice(normal, origin)` / `.sliceWorld(...)`.
- Fragments carry two geometry groups: 0 = outer surface, 1 = new inner faces.
- Requires **manifold (watertight) meshes**.
- Source: package README.

**Renderer coupling: none.** Measured with grep over `src/`:
- It imports only core `three` (`Vector2`, `Vector3`, `Box3`, `BufferGeometry`, `Mesh`).
- No `ShaderMaterial`, `onBeforeCompile` or `WebGLRenderer` anywhere in `src/` or `build/`.
- Materials are just assigned, so `MeshStandardNodeMaterial` works.
- Because `three` and `three/webgpu` share `three.core.js`, its `Mesh` is the same class.

**Physics: not included.**
- "Library only handles geometry - you must add physics integration". The README's example uses Rapier convex hulls.
- The demo uses `@dimforge/rapier3d` ^0.13, WebGLRenderer and pmndrs postprocessing.

**Size:** `build/three-pinata.es.js` is 63 KB raw, 15.9 KB gzip (measured).

**Fracture cost (measured):** Node 24.19 V8 on Apple M1. Median of 5 runs after 1 warm-up, Voronoi, fixed seeds, run in a sandbox (`node --permission`).

| Mesh | Fragments | 3D ms | 2.5D ms | Output tris (3D) |
|---|---|---|---|---|
| Box, 12 tris (crate) | 8 / 16 / 32 / 64 | 3.1 / 11.8 / 36 / 153 | 2.2 / 9.1 / 55 / 345 | 676 / 1,817 / 6,434 / 21,659 |
| Box seg 4, 192 tris | 8 / 16 / 32 / 64 | 5.4 / 18 / 59 / 202 | 5.1 / 19 / 75 / 436 | 1,355 / 3,181 / 8,208 / 21,099 |
| Cylinder pillar, 128 tris | 8 / 16 / 32 / 64 | 10.4 / 38 / 173 / 647 | 12.0 / 50 / 170 / 1,026 | 2,969 / 8,343 / 21,738 / 76,850 |
| Icosphere, 1,280 tris (statue proxy) | 8 / 16 / 32 / 64 | 7.3 / 23 / 66 / 220 | — | 1,749 / 3,898 / 8,024 / 20,477 |

- At 64 fragments it logged "Failed to find final triangle, exiting early." several times (triangulation failures).
- 2.5D was **not** faster here, contradicting the README.
- Fracturing multiplies triangle counts 5–600×.

### Spec implications

- **Pre-fracture; don't fracture live.** A 16-piece live fracture costs 10–50 ms, which is a visible hitch at 60 fps.
  - At load, in a **Web Worker** (it is pure geometry), fracture each destructible archetype into **8–12 pieces**: crate, barrel, fence section, statue, pillar, camp wall, arena cover. Use 2–3 seeds each.
  - Transfer the `BufferGeometry` arrays back to the main thread and cache them.
- **On a server `broke` event** `{id, archetype, variant, impactDir}`:
  1. Hide the intact mesh.
  2. Spawn the cached fragments from a pool.
  3. Give each a client-only Rapier dynamic body with a `convexHull` collider and an impulse away from `impactDir`.
  4. After ~10 s, fade, remove and return them to the pool.
- **Determinism:** since variants come from fixed seeds, all clients see the same shatter pattern. That is cosmetic; the server only tracks intact or broken and the rebuild timer.
- **Budgets:**
  - ≤ 150 live debris bodies;
  - ≤ 12 pieces per object;
  - beyond that, the oldest debris despawns early.
  - Each fragment has 2 material groups, so 2 draws: 12 pieces ≈ 24 draws per broken object. Count this in the draw budget.
- **Assets:** every destructible mesh must be made manifold in Blender (Mesh → Clean Up → Make Manifold), checked by the export script. The inner faces use a cheap shared "fracture" `NodeMaterial`.
- **Licence hygiene:** depend on the npm package (MIT). Don't copy `demo/` code, which carries no licence; write our own Rapier glue.

---

## 4. Colyseus 0.18

### Verified facts

**Status**
- 0.18 is stable `latest`. Publish history:
  - 0.18.0 published to npm 2026-05-22;
  - announcement blog post 2026-08-20 (https://colyseus.io/blog/colyseus-018-is-here/);
  - GitHub release 2026-08-25 (https://github.com/colyseus/colyseus/releases/tag/0.18).
- There are no 0.19 previews; the roadmap goes to 1.0 (https://docs.colyseus.io/roadmap).
- Server packages need Node ≥ 22.
- @colyseus/core went from 0.18.0 to 0.18.18 in about 4.5 months.

**Client**
- `import { Client, Callbacks } from "@colyseus/sdk"` (https://docs.colyseus.io/sdk). The docs' CDN snippet still says 0.17.
- `client.auth.token = jwt`:
  - HTTP matchmake calls send `Authorization: Bearer`;
  - the WebSocket URL carries `?_authToken=` (`src/HTTP.ts:493`, `src/Client.ts:461` in the sdk 0.18.5 tarball).

**Room configuration**
- Plain class properties (https://docs.colyseus.io/room#configuration-properties):
  - `state = new S()`;
  - `maxClients` (default ∞);
  - `patchRate` (default **50 ms = 20 Hz**; `null` disables);
  - `autoDispose`;
  - `maxMessagesPerSecond`;
  - `seatReservationTimeout` (default 15 s).
- `setPatchRate()`/`setState()` are deprecated.
- **`setSimulationInterval` → `setTimestep(cb, ms)`**, default 16.6 ms. `setFixedTimestep(step, tickRate)` also exists (https://docs.colyseus.io/migrating/0.18).

**Interest management** (https://docs.colyseus.io/state/view)
- Basic calls: `client.view = new StateView()`, then `view.add(obj, tag?)`, `view.remove(obj, tag?)`, `view.has(obj)`.
- New in 0.18: `view.subscribe(collection, priorityFn?)`.
- Field tags: `t.x().view(tag?)` (builder) or `@view()`.
- A tagged map needs **each item** added to the view.
- Costs (https://docs.colyseus.io/state/optimization):
  - one `.view()` field switches the room to per-client encoding;
  - clients with the same slice should share a StateView;
  - re-adding an entity resends all its fields;
  - "Avoid relying on StateView for large datasets: it is not optimized for that yet."
- Call `view.dispose()` on leave (schema `src/encoder/StateView.ts`).
- `@filter`/`@filterChildren` are gone.
- Schema limits:
  - ≤ 63 fields per class in 0.18;
  - `.view()` fields at index ≥ 32 take a slower path;
  - classes with > 8 fields allocate per instance (schema README).

**Matchmaking** (https://docs.colyseus.io/matchmaker)
- `defineRoom(PlanetRoom).filterBy(["planet"]).sortBy({ clients: -1 })` fills the fullest room first. `clients` counts reserved seats too.
- A room locks automatically when connected clients plus reserved seats reach `maxClients`, and unlocks when a seat frees.
- **No option caps rooms per type or filter.** `joinOrCreate` creates a new room whenever none is available (`src/MatchMaker.ts:201`).
- A client that omits `planet` matches any room.
- `joinById` **rejects locked (including full) rooms** (https://docs.colyseus.io/matchmaker/visibility).
- Server API:
  - `matchMaker.query(cond, sort)`, `createRoom`, `getRoomById`, `remoteRoomCall`;
  - `reserveSeatFor(room, clientOptions, authData)`. **This skips `onAuth`;** `authData` becomes `client.auth`.
- Client: `client.consumeSeatReservation(reservation)`.
- `matchMaker.controller.exposedMethods = [...]` limits what clients may call.

**Auth** (https://docs.colyseus.io/auth/room)
- Signature: `static async onAuth(token, options, context)`. `context` has `token`, `headers` (`Headers`), `ip` (from `x-real-ip` → first `x-forwarded-for` → `x-client-ip` → socket) and `req`.
- Return values: an object becomes `client.auth`; `true` means no payload; a falsy value means `AUTH_FAILED`.
- **Reconnects skip `onAuth`.**
- **Hidden default (verified in source):**
  - The `colyseus` package does `export * from "@colyseus/auth"`. As a side effect, that **replaces the default `Room.onAuth` with an HS256 `JWT_SECRET` check**.
  - With no secret, any token is ignored and the player joins.
  - With a secret, Better Auth's EdDSA tokens fail.
  - Source: `src/index.ts:54-110` in https://registry.npmjs.org/@colyseus/auth/-/auth-0.18.4.tgz

**Presence (single process)** (https://docs.colyseus.io/server/presence)
- `LocalPresence` by default: `subscribe`/`unsubscribe`/`publish`, plus key-value, set and hash commands.
- Available as `this.presence` in rooms and `matchMaker.presence` elsewhere. Room subscriptions are removed when the room is disposed.
- **`publish` runs subscribers synchronously**: an exception in a subscriber is thrown back into the publisher.
- Online counts: `matchMaker.stats.local.ccu` counts joined clients only; the `clients` field from `query()` includes reserved seats.

**Transport and server** (https://docs.colyseus.io/server/transport/ws)
- `WebSocketTransport` defaults: `maxPayload` 4096 B, `pingInterval` 3000 ms, `pingMaxRetries` 2, `perMessageDeflate` off. New: `beforeUpgrade(req, ctx)`.
- Server shape: `defineServer({ rooms, transport, express: (app) => {...}, presence })`, then `listen(server)` from `@colyseus/tools`.
- **CORS:** the default reflects any `Origin` with credentials. A listener registered ahead of Express sets it on **every** HTTP route and answers every `OPTIONS` with 204 (`src/router/index.ts:97-115`).
  - Override with `matchMaker.controller.getCorsHeaders` (https://docs.colyseus.io/server/http-routes#cors).

**WebRTC plugin** (https://docs.colyseus.io/room/plugins/webrtc)
- `colyseus/plugins/webrtc` exists in 0.18.9, with browser side `@colyseus/webrtc/client`.
- Messages:
  - client → server: `webrtc:join`;
  - relayed: `webrtc:offer`, `webrtc:answer`, `webrtc:ice-candidate`;
  - server → client: `webrtc:peers`, `webrtc:peer-joined`, `webrtc:peer-left`.
- It meshes every opted-in client with no proximity check, and the docs advise raising `maxPayload` to 16 KB for SDP.

**Breaking changes since 0.16** (https://docs.colyseus.io/migrating/0.17, https://docs.colyseus.io/migrating/0.18)
- `Room<{ state, metadata, client }>`.
- `onLeave(client, code: number)`.
- New `onDrop`/`onReconnect`; `allowReconnection(client, seconds)`.
- `CloseCode.*` constants; codes 4000–4010 are reserved.
- `client.id` was removed: use `sessionId`.
- `setMetadata` **replaces** metadata rather than merging.
- Message validation: `messages = { type: validate(zodSchema, handler) }`. Invalid input closes the connection with 4002.

### Spec implications

**Server skeleton (0.18 shapes)**

```ts
// server/app.ts
import { defineServer, defineRoom, matchMaker } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { listen } from "@colyseus/tools";
export const server = defineServer({
  transport: new WebSocketTransport({ maxPayload: 16 * 1024 }),          // SDP > 4 KB
  rooms: { planet: defineRoom(PlanetRoom).filterBy(["planet"]).sortBy({ clients: -1 }) },
  express: (app) => {
    app.all("/api/auth/*splat", toNodeHandler(auth));                    // before express.json()
    app.use(express.json());
    app.post("/api/play", play);                                         // the only way into a room
  },
});
matchMaker.controller.exposedMethods = ["reconnect"];                    // no client-side joinOrCreate/joinById
matchMaker.controller.getCorsHeaders = (h) => ({
  "Access-Control-Allow-Origin": ALLOWED.has(h.get("origin")) ? h.get("origin")! : "https://firstlight.one4all.dev",
  "Access-Control-Allow-Credentials": "true", "Vary": "Origin" });
listen(server);
```

```ts
// PlanetRoom
export class PlanetRoom extends Room<{ state: PlanetState }> {
  state = new PlanetState(); maxClients = 40; patchRate = 50; maxMessagesPerSecond = 60;
  static async onAuth() { throw new ServerError(403, "use /api/play"); } // also neutralises @colyseus/auth's default
  onCreate(o) { this.setTimestep((dt) => this.tick(dt), 50); this.presence.subscribe("announce", m => this.broadcast("announce", m)); }
  onJoin(client) { client.view = new StateView(); /* add own player + nearby */ }
  onDrop(client) { this.allowReconnection(client, 30); }
  onLeave(client) { client.view?.dispose(); }
}
```

- **One custom route, `POST /api/play`, handles every join:**
  1. verify the Better Auth session or JWT;
  2. apply the 320 global cap and the queue;
  3. pick the room: `matchMaker.query({ name: "planet", planet }, { clients: -1 })`, take the first unlocked room with enough free seats, create a second copy if fewer than 2 exist (behind a per-planet mutex), otherwise queue;
  4. call `reserveSeatFor(room, { planet }, authPayload)`.

  The client then calls `consumeSeatReservation`. This fixes several problems at once:
  - the no-cap-on-copies gap;
  - the omitted-`planet` hole;
  - `joinById` failing on full rooms;
  - the JWT in the WebSocket URL, because no token is needed in the WS URL any more. Call `/api/play` with our own `fetch` and never set `client.auth.token`, or the SDK appends `?_authToken=` to the WebSocket URL.
- **Parties:** the party leader's `roomId` is passed to `/api/play`. To make "always the same copy" hold, **solo players only enter a copy with ≤ 36 occupants** (4 seats of headroom). A party only enters a copy with room for the whole party; otherwise it goes to the other copy or the queue. Reconnect windows (30 s) hold seats; count them.
- **Never leave the default `onAuth` live.** Override it in every room (above) even though `/api/play` is the only entry point. Never set `JWT_SECRET`.
- **`this.metadata`:** spread the old value (`{...this.metadata, ...}`), or the `planet` filter key disappears.
- **Rates:** `patchRate = 50` (20 Hz, as DECISIONS says) **and** `setTimestep(..., 50)`. The default simulation loop is 60 Hz.
- **AOI:**
  - tag the entity map `.view()`;
  - give each client its own `StateView`, recomputed at 5 Hz;
  - use hysteresis (add at ≤ 80 m, remove at ≥ 100 m; tune per planet);
  - always add the client's own player and party members;
  - **measure encode time at 40 bots** in the load test. The docs call StateView unoptimised for large datasets.
  - Fallback if it's too slow: put every player in one shared un-viewed map and apply views only to NPCs, loot piles and props.
- **Schema:** builder style. Keep hot fields (position, rotation, hp) in the first 32 indexes. Use small nested schemas (≤ 8 fields) for per-tick entities.
- **Proximity voice:** don't use `WebRTCPlugin` as-is. Copy its ~100-line relay into our own room handler and gate both `join` and every relay on distance (or the same radio channel) plus block lists.
- **Cross-room:** `matchMaker.presence.publish("announce", …)` for admin messages; `presence.subscribe("user:<id>")` for party invites. Wrap subscriber bodies in try/catch, since `publish` is synchronous.
- **Online count:** the landing page reads `matchMaker.stats.local.ccu` through a cached public endpoint (≤ 1 request/s).
- **Bans:** a JWT expiry doesn't end a live session, and reconnects skip `onAuth`. Admin ban must also `client.leave(CloseCode...)` and refuse reconnects through `onReconnect` checks.
- **Transport:** stay on the default `ws` transport. uWebSockets needs an Express compatibility layer, and Better Auth's Node handler expects real Node request/response objects (judgement, UNVERIFIED).

---

## 5. Better Auth 1.7.7

Source paths below refer to the unpacked 1.7.7 tarballs (`better-auth/dist/…`, `@better-auth/core`, `@better-auth/kysely-adapter`). Docs: https://better-auth.com/docs/….

### Verified facts

**Plugins**
- `anonymous`, `emailOTP` and `jwt` all exist and import from `better-auth/plugins`. Subpaths: `better-auth/plugins/anonymous`, `/email-otp`, `/jwt`.
- The client plugins `anonymousClient`, `emailOTPClient` and `jwtClient` come from `better-auth/client/plugins`.
- Docs: https://better-auth.com/docs/plugins/anonymous, https://better-auth.com/docs/plugins/email-otp, https://better-auth.com/docs/plugins/jwt

**Anonymous → `onLinkAccount({ anonymousUser: {user, session}, newUser: {user, session}, ctx })`** (`plugins/anonymous/index.mjs`)
- It runs in an after-hook on paths starting with `/sign-in`, `/sign-up`, `/callback`, `/verify-email` and similar, so **`/sign-in/email-otp` triggers it**. It fires only when the response sets a new session cookie and the request carried an anonymous session.
- After it, the guest user, sessions and accounts are deleted unless `disableDeleteAnonymousUser` is set.
- **Email-OTP sign-in creates a new user row** (`emailVerified: true`, `name: body.name || ""`) (`plugins/email-otp/routes.mjs:410-425`). **The account id changes when a guest saves**, and the guest's name is lost unless `name` is passed.
- Errors thrown in the hook:
  - An `APIError` thrown in it becomes the response, but the new `Set-Cookie` is kept: the player is signed into the new account and the guest isn't deleted (`api/dispatch.mjs:108-133`).
  - A plain `Error` probably yields a 500 without the new cookie (UNVERIFIED).
- Options: `generateName(ctx)` (default `"Anonymous"`); the guest email is `<id>@anonymous.placeholder.invalid` unless `emailDomainName` is set.
- Open issues:
  - [#10563](https://github.com/better-auth/better-auth/issues/10563) (atomic promote) is still an open feature request; PR #10974 is unmerged.
  - **[#11533](https://github.com/better-auth/better-auth/issues/11533)** (open): a stale cookie for a deleted session makes a successful sign-in end with **no session cookie**, including `/sign-in/anonymous`. Fix PR #11590 is unmerged.

**emailOTP** (`plugins/email-otp/*`)
- Signature: `sendVerificationOTP({ email, otp, type }, ctx?)` with `type` = `"sign-in" | "email-verification" | "forget-password" | "change-email"`.
- Defaults: `otpLength` 6, `expiresIn` 300 s, `allowedAttempts` 3, `storeOTP: "plain"` (`"hashed"` available), `resendStrategy: "rotate"`, rate limit **3 per 60 s** on every OTP path.
- `sign-in` sends a code even when no user exists.
- **Errors thrown by the send function are swallowed, and the endpoint returns `{ success: true }`** (`context/create-context.mjs:215-225`; [#11107](https://github.com/better-auth/better-auth/issues/11107)).
- There is no per-email send cap ([#11162](https://github.com/better-auth/better-auth/issues/11162)).
- Client calls: `authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" })`, then `authClient.signIn.emailOtp({ email, otp, name? })`.

**JWT plugin** (`plugins/jwt/*`)
- Endpoints: `GET /api/auth/token` (needs a session) and `GET /api/auth/jwks`.
- Key: default **EdDSA / Ed25519**, generated on first use, private key encrypted with the auth secret, stored in a **`jwks` table that needs a migration**.
- Claims: `expirationTime` default `"15m"`; `iss`/`aud` default to the `baseURL` origin; `sub` = user id.
- **The default payload is the whole user object, including email.** Use `definePayload`.
- Unless `disableSettingJwtHeader` is set, every `get-session` call also signs a JWT into a `set-auth-jwt` header.
- Rotation (`jwks.rotationInterval`) is off by default.
- **`auth.api.verifyJWT({ body: { token } })` exists (undocumented).** It returns `{ payload }`, which is `null` on failure rather than throwing. The documented alternative is `jose` `createRemoteJWKSet` + `jwtVerify` ([docs](https://better-auth.com/docs/plugins/jwt)).
- `/token` and `/jwks` send no `Cache-Control`.

**Cookies on `firstlight.one4all.dev` ↔ `api.firstlight.one4all.dev`**
- **Same-site.** The PSL has `dev` but no `one4all` rule (https://publicsuffix.org/list/public_suffix_list.dat). `vercel.app` and `up.railway.app` are themselves on the PSL.
- Defaults (`cookies/index.mjs`): `__Secure-better-auth.session_token`, `HttpOnly`, `Secure` (https `baseURL`), `SameSite=Lax`, `Path=/`, host-only.
  - `crossSubDomainCookies` would default its domain to the `baseURL` host, not the parent domain.
  - No `__Host-` prefix support (#10806).
- **Safari caps the cookie at 7 days if `api.firstlight.one4all.dev` sets it directly.** WebKit's CNAME- and IP-cloaking defence caps cookies set in responses to same-site subresource requests when the host's CNAME differs from the first party's, or, with no CNAME, when the IP differs in the first 16 bits. Railway custom domains are a **CNAME to `*.up.railway.app`**.
  - Sources: WebKit `Source/WebKit/NetworkProcess/cocoa/NetworkTaskCocoa.mm` (7-day constant `24_h * 7`); https://webkit.org/blog/11338/cname-cloaking-and-bounce-tracking-defense/; https://webkit.org/tracking-prevention/; https://docs.railway.com/networking/domains/working-with-domains
- **CSRF:** cookie-bearing POSTs must carry an `Origin` from `baseURL` or `trustedOrigins`. The client uses `credentials: "include"` by default.

**Rate limiting** (`api/rate-limiter/index.mjs`, https://better-auth.com/docs/concepts/rate-limit)
- On only in production. Default `window` 10 s, `max` 100, storage `"memory"`.
- **Built-in rule: paths starting with `/sign-in` get 3 per 10 s per IP. That includes `/sign-in/anonymous`.** OTP send: 3 per 60 s.
- Override with `rateLimit.customRules`.
- The window slides forward on every allowed request ([#11660](https://github.com/better-auth/better-auth/issues/11660)).
- IP detection: `advanced.ipAddress.ipAddressHeaders` (default `["x-forwarded-for"]`). A multi-IP header resolves to null unless `trustedProxies` is set.
- **With no IP, everyone shares one `"no-trusted-ip"` bucket** (still in 1.7.7).
- **Railway documents `X-Real-IP`** (not `X-Forwarded-For`) (https://docs.railway.com/networking/public-networking/specs-and-limits). Vercel's external rewrites forward `x-real-ip`, `x-forwarded-for`, `x-forwarded-host` and `x-forwarded-proto` (https://vercel.com/docs/routing/rewrites). `x-vercel-forwarded-for` isn't forwarded to external origins.

**Express and database**
- `toNodeHandler(auth)` from `better-auth/node`, on `app.all("/api/auth/*splat", …)` **before `express.json()`** (https://better-auth.com/docs/integrations/express).
- A raw better-sqlite3 **or** `node:sqlite` `DatabaseSync` can be passed as `database` (Kysely adapter auto-detects; native transactions since 1.7.0).
- **The CLI is now `npx auth@latest migrate`.** `@better-auth/cli` is deprecated (last 1.4.21).
- Programmatic migrations: `getMigrations(auth.options)` from `better-auth/db/migration`.
- Runtime schema validation is on in production, so requests fail until migrated (https://better-auth.com/docs/concepts/database).
- 1.7 changes ([upgrade guide](https://better-auth.com/docs/guides/1-7-upgrade-guide)): atomic OTP and rate-limit consume; `getIp` → `getIP`. No default changes to these three plugins.

### Corrections to r2-14

1. **Domains.** `BETTER_AUTH_URL` = `https://firstlight.one4all.dev` (the proxied public origin, which is also JWT `iss`/`aud`). The rewrite target and the game server URL become `https://api.firstlight.one4all.dev`.
2. **Keep the Vercel rewrite for `/api/auth/*`** even though the hosts are now same-site. Calling the API host directly triggers Safari's 7-day CNAME cap, which would lose guests who stay away a week. r2-14's guess is now confirmed from WebKit source.
3. **IP headers.** `["x-vercel-forwarded-for","x-forwarded-for"]` is wrong. Use an origin-secret-gated middleware that copies the first `x-forwarded-for` entry into a private header, and set `ipAddressHeaders` to that header (snippet below).
4. **Rate limits.** `/sign-in/anonymous` is 3 per 10 s per IP. r2-14 missed it; add a custom rule.
5. **Missing gotchas:**
   - #11533 (stale cookie);
   - guest name lost on save;
   - send errors reported as success;
   - the default JWT payload includes email.
6. **CLI** is `auth`, not `@better-auth/cli`.
7. **`verifyJWT`** returns `{ payload: null }` on failure; it doesn't throw. Keep the `!payload?.sub` check. SQL must quote `"user"`.
8. **Colyseus join:** r2-14 used `joinOrCreate` with `onAuth`. This brief uses `/api/play` + `reserveSeatFor` (§4), so the JWT is checked on HTTP and never sits in a WebSocket URL.

### Spec implications

**Flow**
1. `firstlight.one4all.dev/api/auth/*` is proxied by Vercel to Railway. Its cookie is first-party and host-only on `firstlight.one4all.dev`.
2. `authClient.getSession()`. If there's no session, call `signIn.anonymous()`. Calling `getSession()` first also clears a stale cookie (#11533 workaround).
3. `authClient.token()` → a 15-min JWT.
4. `fetch("https://api.firstlight.one4all.dev/api/play", { method: "POST", headers: { Authorization: "Bearer " + jwt } })`. No cookies; Colyseus' default CORS headers already allow `Authorization`.
5. The server verifies the JWT and checks that `sub` exists and isn't banned, then calls `reserveSeatFor`.
6. `consumeSeatReservation` opens the WebSocket.

**Config skeleton** (server, same process as Colyseus)

```ts
import Database from "better-sqlite3";
import { betterAuth } from "better-auth";
import { anonymous, emailOTP, jwt } from "better-auth/plugins";
export const authDb = new Database("/data/auth.db");                         // game.db separate
export const auth = betterAuth({
  database: authDb,
  secret: process.env.BETTER_AUTH_SECRET,           // also encrypts the JWKS key: rotate only via versioned `secrets`
  baseURL: "https://firstlight.one4all.dev",        // public proxied origin → auto-trusted, JWT iss/aud
  session: { expiresIn: 60 * 60 * 24 * 180 },       // 180 d; cookie refreshed daily (updateAge 1 d)
  rateLimit: { customRules: { "/sign-in/anonymous": { window: 60, max: 20 }, "/sign-in/email-otp": { window: 60, max: 5 } } },
  advanced: { ipAddress: { ipAddressHeaders: ["x-firstlight-client-ip"] }, backgroundTasks: { handler: (p) => { void p; } } },
  plugins: [
    anonymous({ generateName: () => `Wanderer-${randomInt(1000, 10000)}`,
      onLinkAccount: async ({ anonymousUser, newUser }) => {                  // id changes on save
        moveAccountData(anonymousUser.user.id, newUser.user.id);             // one idempotent game.db transaction; merge rule if target has characters
        liveClients.rekey(anonymousUser.user.id, newUser.user.id); } }),
    emailOTP({ storeOTP: "hashed", async sendVerificationOTP({ email, otp, type }) {
      if (type !== "sign-in" || !otpBudget.take(email)) return;              // own per-email + global caps
      const { error } = await resend.emails.send({ from: "FIRSTLIGHT <login@firstlight.one4all.dev>", to: email,
        subject: `${otp} is your FIRSTLIGHT code`, text: `Your FIRSTLIGHT code is ${otp}. It expires in 5 minutes.` }); // no links
      if (error) metrics.otpSendFailed(error.name); } }),                     // BA reports success regardless
    jwt({ disableSettingJwtHeader: true, jwt: { expirationTime: "15m",
      definePayload: ({ user }) => ({ name: user.name, guest: !!user.isAnonymous }) } }),
  ],
});
// Express, in order:
// 1. app.use("/api/auth", originSecretGate, copyFirstXffTo("x-firstlight-client-ip"), noStore)
// 2. app.all("/api/auth/*splat", toNodeHandler(auth))
// 3. app.use(express.json())
// Boot: await (await getMigrations(auth.options)).runMigrations()   // or pre-deploy: npx auth@latest migrate
```

**Verifying in `/api/play`:** `const { payload } = await auth.api.verifyJWT({ body: { token } })`. Same process, no network. Then `SELECT 1 FROM "user" WHERE id = ?` to reject merged or deleted guests, then the ban check. `jose` + `createRemoteJWKSet("https://firstlight.one4all.dev/api/auth/jwks")` is the documented fallback.

**Origin secret on the rewrite.** Use a Vercel `routes` entry that sets `x-origin-secret` from an env var, so direct calls to `api.firstlight.one4all.dev/api/auth/*` get a 403 (`vercel.json` shape in §8). This also makes the forwarded IP trustworthy.

**Tests to add:**
- `onLinkAccount` fires on email-OTP sign-in and moves characters;
- the guest name is preserved (pass `name`);
- sign-in over a stale cookie;
- `verifyJWT` rejects expired, foreign and merged tokens;
- the OTP budget.

**Abuse:**
- per-email caps (e.g. 3/hour) and a global cap (e.g. 60/hour, under Resend's free 100/day) on OTP sends;
- the resend button disabled for 60 s;
- optional captcha plugin on `/email-otp/send-verification-otp`.

---

## 6. Cloudflare: Workers static assets and Realtime TURN

### Verified facts: static assets (free plan)

**Limits** (https://developers.cloudflare.com/workers/platform/limits/)
- **20,000 files per Worker version** (100,000 on paid).
- **25 MiB per file**.
- `_headers`: 100 rules, 2,000 characters per line.

**Billing**
- "Requests to static assets are free and unlimited". Only requests that invoke a Worker script count toward the free 100,000/day (Error 1027) (https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/).
- No egress or bandwidth charges (https://developers.cloudflare.com/workers/platform/pricing/).
- **Traps:**
  - with `run_worker_first`, matching requests invoke the script and get **429** after the free limit;
  - enabling Workers Caching bills every request, assets included (https://developers.cloudflare.com/workers/cache/).

**`_headers`** (https://developers.cloudflare.com/workers/static-assets/headers/)
- It applies to asset responses, including assets-only Workers.
- Matching rules stack, and duplicate headers are **comma-joined**.
- `Access-Control-Allow-Origin` takes `*`, `null` or one exact origin.
- The default is `Cache-Control: public, max-age=0, must-revalidate` + `ETag`.

**Config**
- An assets-only Worker needs no `main`: `{ "name", "compatibility_date", "assets": { "directory": "./public", "not_found_handling": "none" } }` (https://developers.cloudflare.com/workers/wrangler/configuration/).

**Auth**
- Interactive: `wrangler login` (OAuth; `--device` for headless).
- Non-interactive: `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`, from the **"Edit Cloudflare Workers"** token template (https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).

**workers.dev**
- One `<account>.workers.dev` subdomain per account, set in the dashboard. A Worker is served at `<name>.<account>.workers.dev`.
- wrangler 4.149 source:
  - interactively it offers to register the subdomain;
  - non-interactively it fails with an onboarding link;
  - when it detects an AI agent it auto-registers one named after the directory.
- A workers.dev host isn't a zone, so it can't have WAF or rate-limit rules (https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).

### Verified facts: Realtime TURN

**Pricing**
- "free tier of 1,000 GB", shared with the Realtime SFU, then $0.05/GB (https://developers.cloudflare.com/realtime/turn/faq/, https://developers.cloudflare.com/realtime/sfu/platform/pricing/).
- **Only Cloudflare → client traffic is billed.** The relay → peer hop is not.
- STUN is free.

**Creating a key**
- Dashboard, or `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/calls/turn_keys` (token permission "Calls Write").
- Returns `uid` (key id) and `key` (bearer token).
- Up to 1,000 keys.

**Minting credentials**
- `POST https://rtc.live.cloudflare.com/v1/turn/keys/$TURN_KEY_ID/credentials/generate-ice-servers` with `Authorization: Bearer $TURN_KEY_API_TOKEN` and `{"ttl": N}` → **201** `{ iceServers: [ {urls:[stun…]}, {urls:[turn…, turns…], username, credential} ] }`.
- Revoke: `POST …/credentials/$USERNAME/revoke` → 204 (https://developers.cloudflare.com/realtime/turn/generate-credentials/).
- **Max credential lifetime is 48 h.** Longer allocations need fresh credentials through `RTCPeerConnection.setConfiguration()`, and an expired credential disconnects (FAQ).
- The docs advise filtering out **port 53** URLs ("known to be blocked by web browsers").

**Ports and limits** (https://developers.cloudflare.com/realtime/turn/)
- Ports: STUN 3478/udp; TURN 3478/udp, 443/udp, 3478/tcp, 80/tcp; TURNS 5349, 443.
- Relay addresses are IPv4 only.
- Per-allocation limits: ~50–100 Mbps, 5–10 kpps.
- Card requirement for the free tier: **UNVERIFIED** (not stated in the docs).

### Corrections to r2-13

- **TURN egress isn't double-counted.** It is ≈ 405 GB/month at the 50 CCU × 2 h scenario, not 405–810 GB.
- **Mint one credential per player instead of caching a shared 4 h credential.** Use a TTL longer than a play session and at most 48 h, refresh with `setConfiguration`, and revoke on block or ban.
- Filter out `:53` URLs and the STUN entry: STUN is useless under `iceTransportPolicy: "relay"`.

### Spec implications

**Asset Worker**
- `firstlight-assets` deployed with `npx wrangler@4.149.0 deploy`, auth via an "Edit Cloudflare Workers" API token kept in the builder's env.
- `public/_headers`:
  ```
  /*
    Access-Control-Allow-Origin: *
  /v/*
    Cache-Control: public, max-age=31536000, immutable
  ```
  Use `*`, because there are two client origins and no credentials. Don't set `Cache-Control` in two overlapping rules.
- Lay content out under `/v/<buildId>/…` and **keep the previous build's directory in each deploy**. A deploy replaces the whole asset set, so players mid-session would otherwise 404 on lazy loads. Watch the 20,000-file cap.
- Loaders fetch with plain GETs: no custom headers, `crossOrigin = "anonymous"`. Split anything over 25 MiB.
- Never enable `run_worker_first` or Workers Caching on this Worker.

**TURN**
- Railway vars `TURN_KEY_ID` and `TURN_KEY_API_TOKEN`.
- The room mints `generate-ice-servers` with `ttl: 43200` (12 h) when a player enables voice, and re-mints every 6 h, applied through `setConfiguration`. Revoke on ban.
- The client uses `iceTransportPolicy: "relay"` and drops `:53` URLs.

**Voice budget (estimate):** 50 kbps per stream ≈ 22.5 MB per listener-stream-hour.
- At the 12-peer cap with everyone talking (no DTX), that is ≈ 0.27 GB per player-hour, so 1,000 GB ≈ 3,700 player-hours.
- With Opus DTX and proximity gating it will be far less.
- Watch TURN analytics in week 1.

---

## 7. Railway (CLI 5.64.2)

### Verified facts

**Commands** (docs at https://docs.railway.com/cli/*; checked against `npx @railway/cli@5.64.2 … --help`)
- `railway init --name firstlight`.
- `railway add --service game-server`. Non-interactive runs need `--service`, `--repo`, `--image` or `--database`.
- **Volume:** `railway volume --service game-server add --mount-path /data`. `volume add` has no `--service` of its own (its `--help` lists only `--mount-path` and `--json`). The help *example* `volume add --service api …` therefore fails with "unexpected argument".
- **Variables:** `railway variable set KEY=VAL … --service <s> --skip-deploys`; `--stdin` takes one key. `railway variables --set` is legacy.
- **Custom domain:** `railway domain api.firstlight.one4all.dev --service game-server --port 2567`.
  - It prints a **CNAME → `<x>.up.railway.app`** plus a **TXT verification record**, and both are required. Read the exact TXT name with `railway domain status <domain>`.
  - Hobby allows 2 custom domains per service (https://docs.railway.com/networking/domains/working-with-domains).
- **Replica CPU/RAM limits: dashboard only** (Service → Settings → Deploy → Replica Limits) (https://docs.railway.com/pricing/cost-control). Neither the CLI nor the IaC reference exposes them.
- `railway scale --service game-server us-east=1` sets replicas per region (`us-west`, `us-east`, `eu-west`, `southeast-asia`). **US East (Virginia) is `us-east4-eqdc4a`** (https://docs.railway.com/deployments/regions).
- **Usage alert:** `railway usage limit set --target workspace --soft 25`. `--soft` is the email alert; `--hard` is optional, minimum $10; omit it.
  - **The limit is workspace-wide**, covering every project in the owner's workspace, not only FIRSTLIGHT.
  - Only a workspace admin can set it.
  - Source: `railway usage limit set --help` and https://docs.railway.com/pricing/cost-control ("Do I need to set a hard limit to set a custom email alert? No.")
- **Tokens:** `RAILWAY_TOKEN` is a project token (deploy and logs); `RAILWAY_API_TOKEN` is an account or workspace token. Setting both is an error (https://docs.railway.com/cli/login).
- **Config as Code (`railway.json`/`railway.toml`) is deprecated.** "New services cannot opt into Config as Code. Existing Config as Code files stop being read on **2026-12-01**." The replacement is `.railway/railway.ts` IaC (https://docs.railway.com/infrastructure-as-code).

**Hobby plan** (https://docs.railway.com/pricing/plans)
- $5/month including $5 of usage.
- RAM $10/GB-month, CPU $20/vCPU-month, **egress $0.05/GB**, volume $0.15/GB-month.
- **Volumes up to 5 GB**; 6 replicas and up to 8 vCPU / 8 GB per replica.

**Networking and volumes**
- WebSockets work over HTTP/1.1 on public and custom domains with no configuration, are exempt from the HTTP duration and idle limits, and are capped at 10,000 connections.
- Railway sets `X-Real-IP`, `X-Forwarded-Proto` and `X-Forwarded-Host` (https://docs.railway.com/networking/public-networking/specs-and-limits).
- **A service with a volume can't have replicas, and redeploys have brief downtime.** Changing region with a volume attached means a migration with downtime (https://docs.railway.com/volumes/reference).

**Node version** (https://railpack.com/languages/node)
- Order: `RAILPACK_NODE_VERSION` → `devEngines.runtime` → `engines.node` → `.nvmrc` → `.node-version` → default **`lts`**.
- `lts` becomes Node 26 on 2026-10-28.

### Corrections to r2-14

- `railway volume add --mount-path /data --service …` → `railway volume --service game-server add --mount-path /data`.
- Hostnames change to `api.firstlight.one4all.dev` / `firstlight.one4all.dev`.
- Add the soft-alert command, the config-as-code deprecation, the 5 GB volume cap, and the region-first rule.

### Spec implications

**Setup order** (region before volume):
```bash
railway init --name firstlight
railway add --service game-server
railway scale --service game-server us-east=1            # confirm no other region keeps a replica
railway volume --service game-server add --mount-path /data
railway variable set --service game-server --skip-deploys NODE_ENV=production PORT=2567 RAILPACK_NODE_VERSION=24 \
  BETTER_AUTH_URL=https://firstlight.one4all.dev CLIENT_ORIGIN=https://firstlight.one4all.dev \
  AUTH_DB_PATH=/data/auth.db GAME_DB_PATH=/data/game.db 'EMAIL_FROM=FIRSTLIGHT <login@firstlight.one4all.dev>'
openssl rand -base64 32 | railway variable set BETTER_AUTH_SECRET --stdin --service game-server --skip-deploys
# likewise via --stdin: RESEND_API_KEY, ORIGIN_SECRET, TURN_KEY_ID, TURN_KEY_API_TOKEN, STATS_TOKEN
railway up --service game-server --detach
railway domain api.firstlight.one4all.dev --service game-server --port 2567   # then add CNAME + TXT via vercel dns (§8)
railway usage limit set --target workspace --soft 25
```

- **Set by hand in the dashboard:** Replica Limits **2 vCPU / 2 GB**. Record that it was done in `DECISIONS.md`.
- **No `railway.json`:** configure through the dashboard or CLI. Pin Node with both `engines.node: "24.x"` and `RAILPACK_NODE_VERSION=24`.
- **Every deploy restarts the only replica**, because the volume rules out replicas.
  - All players disconnect and in-memory rooms (boss timers, piles not yet flushed) die.
  - So: flush state to SQLite on `SIGTERM` (Colyseus graceful shutdown), make the client show "server updating…" and auto-rejoin via `/api/play`, and **batch deploys**. "Continuous deploys" means kicking everyone each time.
- Keep the SQLite files well under the **5 GB** Hobby volume cap. Death piles are capped at 1,000 per planet; prune analytics.
- **The $25 alert includes the owner's other Railway projects.** Note it in the run log, and check `railway usage --json` during the load test.

---

## 8. Vercel (CLI 63.1.2)

### Verified facts

**Project and domains**
- `vercel project add <name>`, then `vercel link --yes --project <name>`, then `vercel --prod` (https://vercel.com/docs/cli/project).
- `vercel domains add firstlight.one4all.dev <project>`, then `vercel domains verify …` (https://vercel.com/docs/domains/set-up-custom-domain).

**DNS records** (https://vercel.com/docs/cli/dns)
- Syntax: `vercel dns add <domain> <name> <A|AAAA|ALIAS|CNAME|TXT> <value>`; MX is `vercel dns add <domain> <name> MX <value> <priority>`. Quote TXT values.
- Multi-level names such as `resend._domainkey.firstlight` work (https://resend.com/docs/knowledge-base/vercel).
- A subdomain can CNAME to an external service without being added to a project (https://vercel.com/docs/domains/managing-dns-records).

**Rewrites and routes**
- External rewrites act as a reverse proxy, with a 120 s timeout (`ROUTER_EXTERNAL_TARGET_ERROR`) (https://vercel.com/docs/limits).
- **Projects created on or after 2026-04-06 cache upstream responses that carry `Cache-Control`.** Opt out with the `x-vercel-enable-rewrite-caching: 0` header in `vercel.json` `headers` (https://vercel.com/docs/routing/rewrites).
- `routes` (PCRE) can sit alongside `rewrites`, `redirects` and `headers`. A route's `transforms` can `set` `request.headers` from env vars listed in `env` (https://vercel.com/docs/project-configuration/vercel-json).
- `redirects` support `has: [{ type: "host", value }]`.

**Hobby limits** (https://vercel.com/docs/plans/hobby)
- 100 GB Fast Data Transfer, 10 GB Fast Origin Transfer, 1M CDN requests and 1M function invocations per month.
- Going over gives **`503 DEPLOYMENT_PAUSED`** that never resumes by itself: wait 30 days or upgrade (https://vercel.com/kb/guide/why-is-my-account-deployment-blocked).
- Non-commercial use only; donations are fine (https://vercel.com/docs/limits/fair-use-guidelines).

### Spec implications

**Commands**
```bash
vercel project add playfirstlight && vercel link --yes --project playfirstlight && vercel --prod
vercel domains add firstlight.one4all.dev playfirstlight
vercel dns add one4all.dev api.firstlight CNAME <x>.up.railway.app            # from `railway domain`
vercel dns add one4all.dev <railway-verify-name>.firstlight TXT "<value>"      # name/value from `railway domain status`
# Resend records (§9), values from Resend after creating the domain:
vercel dns add one4all.dev resend._domainkey.firstlight TXT "p=…"
vercel dns add one4all.dev send.firstlight MX feedback-smtp.us-east-1.amazonses.com 10
vercel dns add one4all.dev send.firstlight TXT "v=spf1 include:amazonses.com ~all"
vercel dns add one4all.dev _dmarc.firstlight TXT "v=DMARC1; p=none;"
```

**`vercel.json`** (needs a Vercel env var `ORIGIN_SECRET`, with the same value on Railway):
```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "routes": [{ "src": "/api/auth/(.*)", "dest": "https://api.firstlight.one4all.dev/api/auth/$1",
    "transforms": [{ "type": "request.headers", "op": "set", "target": { "key": "x-origin-secret" },
                     "args": "$ORIGIN_SECRET", "env": ["ORIGIN_SECRET"] }] }],
  "redirects": [{ "source": "/:path*", "has": [{ "type": "host", "value": "playfirstlight.vercel.app" }],
                  "destination": "https://firstlight.one4all.dev/:path*", "permanent": false }],
  "headers": [
    { "source": "/api/auth/:path*", "headers": [{ "key": "x-vercel-enable-rewrite-caching", "value": "0" }] },
    { "source": "/assets/:path*", "headers": [{ "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }] }
  ]
}
```

- The server also sends `Cache-Control: no-store` on every `/api/auth/*` response. The proxy honours upstream headers, so this is the primary guard.
- **Day-1 check:** `/api/auth/token` returns `x-vercel-cache: MISS`.
- The SPA fallback for `/admin` and `/stats` alongside `routes` is untested; verify on a preview deploy.
- **Redirect `playfirstlight.vercel.app` to the canonical host.** `vercel.app` is a public suffix, so it has its own cookie jar and would fail Better Auth's origin check.
- **Budget at ~2 MB from Vercel per visit:** ≈ 50,000 cold visits per month, before either 100 GB or (at ~20 requests per visit) 1M requests binds. Repeat visits hit the immutable cache.
- If a launch spike nears the cap, upgrading to Pro ($20) is a **spending stop: ask the owner**.

---

## 9. Resend

### Verified facts

**Adding a domain**
- Through the dashboard (including "Auto Configure" via Domain Connect for Vercel DNS), or `POST https://api.resend.com/domains {"name","region"}` (https://resend.com/docs/add-a-domain).
- `POST /domains` needs a **`full_access`** key. `sending_access` keys can only send and can be **restricted to one `domain_id`** (https://resend.com/docs/api-reference/api-keys/create-api-key).
- Region defaults to `us-east-1`; changing it means delete and re-add (https://resend.com/docs/api-reference/domains/create-domain).

**Records for `firstlight.one4all.dev`** (in the `one4all.dev` zone)
- DKIM TXT `resend._domainkey.firstlight`;
- SPF MX `send.firstlight` → `feedback-smtp.us-east-1.amazonses.com` (priority 10);
- SPF TXT `send.firstlight` → `v=spf1 include:amazonses.com ~all`;
- recommended DMARC TXT `_dmarc.firstlight` → `v=DMARC1; p=none;`.
- Each subdomain is verified on its own: usually ~15 min, up to 72 h.
- Sources: https://resend.com/docs/knowledge-base/vercel, https://resend.com/docs/dashboard/domains/dmarc

**Limits**
- **Free: 3,000 emails/month and 100/day** (resets 00:00 UTC), **3 domains**. Sending pauses above 4% bounces or 0.08% complaints (https://resend.com/docs/knowledge-base/account-quotas-and-limits).
- Pro: $20 for 50k/month with no daily cap. Scale: from $90 (https://resend.com/docs/knowledge-base/what-is-resend-pricing).
- **Rate limit: 10 requests/s per team**, shared across keys, then 429 (https://resend.com/docs/api-reference/rate-limit).
- Without a verified domain, mail goes only to the account owner (403 otherwise). No production approval is needed.

### Corrections to r2-14

- The "reuse an already-verified domain, zero DNS" path is gone. `firstlight.one4all.dev` needs 3 records plus DMARC.
- The 10/s rate limit and the pricing figures in r2-14 still hold.

### Spec implications

- **Codex adds the domain in the Resend dashboard** (DECISIONS). The builder adds the four records with `vercel dns add` and triggers verification.
- The runtime key on Railway is `sending_access`, restricted to the `firstlight.one4all.dev` domain id.
- **OTP send budget:** per email ≤ 3/hour; global ≤ 80/day while on the free plan, below the 100/day cap shared with the owner's other uses of the account.
- Over budget, the UI says "Saving is busy, try again later" and the character stays a guest. Never fail silently: Better Auth reports success even when Resend errors, so check the budget and the Resend result ourselves.
- Plain-text email with the code in the subject and **no links**.
- **Check the plan before launch.** On the free plan with 3 domains already used, the subdomain can't be added. More than ~80 saves a day needs Pro ($20), which is a spending stop: ask the owner.

---

## Risks and surprises

These would break the plan or quietly undermine it if missed, most severe first.

1. **Colyseus auth bypass by default.** `import … from "colyseus"` re-exports `@colyseus/auth`, which **patches `Room.onAuth`** with an HS256 `JWT_SECRET` check.
   - With no secret, any token, and no token at all, is let in with a warning.
   - With a secret, every Better Auth (EdDSA) token is rejected.
   - Fix: override `static onAuth` in every room and route all joins through `/api/play` + `reserveSeatFor`.
2. **Colyseus CORS is wide open on every HTTP route, auth included.** It reflects any `Origin` with credentials and answers all `OPTIONS` before Express. Override `matchMaker.controller.getCorsHeaders`.
3. **The world-copy rules need custom matchmaking.**
   - Colyseus has no "max 2 rooms per planet".
   - `joinById` rejects full rooms, so "party always lands in the leader's copy" fails at 40/40.
   - A client that omits `planet` matches any room.
   - Fix: `/api/play` plus 4 reserved seats of party headroom (solos only enter copies with ≤ 36 occupants).
4. **Safari caps the session cookie at 7 days** if `api.firstlight.one4all.dev` (a CNAME to Railway) sets it, even though it is same-site. **Keep the Vercel `/api/auth/*` proxy**, or unsaved guests vanish after a week away.
5. **Better Auth sharp edges in 1.7.7:**
   - The account id **changes on save**, so all game rows must move in `onLinkAccount`.
   - A stale cookie silently undoes sign-in (#11533; call `getSession()` first).
   - `/sign-in/anonymous` is limited to **3 per 10 s per IP**, with a sliding window. LAN cafés and school NATs will hit it, so add a custom rule.
   - OTP send failures are reported as success.
   - The default JWT payload includes the email.
   - The guest name is lost on save unless `name` is passed.
6. **Shader warm-up can't rely on `compileAsync` alone.**
   - It frustum-culls, compiles only the active LOD, and skips shadow pipelines.
   - `PassNode.compileAsync` has been broken since r183 (#34681). A reporter saw ~1.7 s of synchronous builds on the first post-processed frame.
   - Warm-up must render real frames behind the loading screen, and be checked with `debug.onNodeBuilderCreated`.
7. **WebGPURenderer is still "experimental" (manual, r186)** and has a High-priority per-draw UBO cost (#30560, worst on Metal) plus slow material init (#33821).
   - Draw-call and material discipline is mandatory.
   - The 60 fps M1 gate is unmeasured for these nodes.
   - GTAO, TRAA and DoF aren't CI-tested ("Black screen" skips).
   - **`godrays()` won't take the new `SunLight`.**
   - WebGL2 "compute" is 1-D transform feedback with no atomics, shared memory or texture writes.
8. **three-piñata live fracture costs 10–50 ms at 16 pieces and 150–650 ms at 64**, with triangulation failures at 64 (measured). Meshes must be manifold.
   - **Pre-fracture in a worker at load** and spawn pooled fragments.
   - The repo's licence is only in `lib/`; `demo/` code is unlicensed.
9. **Every Railway deploy kicks every player.** A volume means one replica only. "Continuous deploys" needs a graceful shutdown that flushes to SQLite, client auto-rejoin, and batched deploys.
10. **Railway config-as-code is deprecated.** New services can't use `railway.json`; existing files stop working on 2026-12-01.
    - Replica CPU/RAM limits are **dashboard-only**.
    - The `$25` alert is **workspace-wide**, covering the owner's other projects too.
    - The documented `railway volume add --service` form fails to parse; put `--service` on `volume`.
11. **Node LTS changes in 17 days.** Node 26 becomes LTS on 2026-10-28, and Railway's Railpack defaults to `lts`. Pin Node 24 explicitly.
    - `node:sqlite` is still a release candidate, so use better-sqlite3 13.
12. **TypeScript 7 is the npm `latest` and has no compiler API.**
    - Tools that `require("typescript")` break: typescript-eslint, and `schema-codegen`.
    - The new defaults (`types: []`, `rootDir`, `strict`) break naive tsconfigs.
    - Use Colyseus `schema()` builders, not decorators.
13. **`colyseus.js` is a trap.** It is the npm name everyone remembers but stopped at 0.16 (schema 3) and can't talk to 0.18. Use `@colyseus/sdk`.
    - The `@next` dist-tags of colyseus, core and schema point to *older* builds than `latest`.
14. **Resend's free plan allows 100 emails/day and 3 domains**, shared with the owner's other uses.
    - A launch with more than ~80 saves a day, or a bot run, exhausts it.
    - If 3 domains are already used, the subdomain can't be added at all.
    - Upgrading is a spending stop.
15. **Cloudflare asset deploys replace the whole asset set.** Players mid-session 404 on lazy loads unless the previous build's files ship too.
    - Free plan: 20,000 files.
    - `run_worker_first` or Workers Caching would turn free asset requests into metered or 429-limited ones.
16. **TURN credentials last at most 48 h, and expiry disconnects.** Mint per player and refresh with `setConfiguration`. r2-13's cost range double-counted egress (≈ 405 GB, not 405–810 GB, at its scenario).
17. **Colyseus StateView is "not optimized for large datasets".** Any `.view()` field switches the room to per-client encoding. Measure encode time with 40 bots; the fallback is views only for NPCs, props and piles.
18. **Unverified until day 1:**
    - whether Railway overwrites a client-supplied `X-Real-IP` (affects bans and `context.ip`);
    - which client IP reaches Railway through the Vercel rewrite;
    - that `Origin` survives the rewrite;
    - that `/api/auth/*` isn't cached (`x-vercel-cache`);
    - whether Safari 26 on macOS 15 exposes `navigator.gpu` (r2-15 said no; WebKit's post states no OS requirement).
    - Test on the owner's actual browser and OS.
