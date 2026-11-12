# Frame rate, loader stills and art packs (lanes of 2026-10-18) — review at integration (Codex gpt-6.1-sol)

Scope: `origin/main...lane/framerate`, `...lane/showcase`, `...lane/artpacks` and the two merge
resolutions on `oasis/integration` (`renderer.ts`, `bench.ts`), reviewed at `1811d86c`. Source review,
reasoning effort high, Standard tier. `pnpm typecheck` clean; 193 targeted tests passed, 3 manifest tests
skipped (the pack files aren't shipped). No blockers.

| # | Lane | Severity | Where | Finding |
|---|---|---|---|---|
| 1 | framerate | should-fix | `render/probe.ts:118–124` | Extras are accepted on the second measurement's GPU median alone; its CPU times and frame intervals are ignored, so a device where grass/shadows cost more CPU than the M1 model keeps (and saves) extras despite a measured regression. |
| 2 | framerate | should-fix | `render/probe.ts:106,118–124` | Later measurements can't invalidate the probe: a tab hidden during the extras measurement only clears extras (`valid` stays the first measurement's), and during the High re-probe it selects High and may persist. |
| 3 | showcase | nit | `ui/loadingStills.ts:183` | Old figures are removed after 1.7 s but reduced-motion CSS fades for 3 s: the old still vanishes mid-fade. |
| 4 | showcase | nit | `ui/loadingStills.ts:146,203–214` | A destination change or stop invalidates callbacks but leaves the image request/decode running; a second request starts at once. |
| 5 | artpacks | should-fix | `render/artpacks/ArtPacks.ts:225–230` | A missing manifest (the normal case today) warns and clears the cache, so every travel or rewarm asks and warns again. |
| 6 | artpacks | should-fix | `render/artpacks/ArtPacks.ts:181–189` | Upload steps run without error handling after leaving the queue: a throwing `initTexture()` escapes before the frame renders, and later frames can swap in a texture that never uploaded. |
| 7 | artpacks | should-fix | `render/artpacks/env.ts:35–52` | The strip worker has no `error`/`messageerror` handler or decode deadline: a worker failure leaves the group `loading` forever. |
| 8 | artpacks | should-fix | `render/artpacks/ArtPacks.ts:279–280,346–348` | Abandoned textures get `Texture.dispose()` only; a decoded 2D pack's `ImageBitmap` is closed only after a successful upload. |

Verdicts: framerate and artpacks: fix before shipping; showcase: safe as merged. The merge resolutions
add nothing. Decisions and fixes are recorded below this line as they land.

## Fixes

On `lane/october-fixes` (Claude Opus 5.5), one commit per finding (3 and 4 together; 2 has a
follow-up). Each test failed before its fix and passes after. Decisions: D-octfix-1, D-octfix-2.

| # | Commit | Fix | Test |
|---|---|---|---|
| 1 | `aae7f00c` | The extras measurement's main-thread p50 and frame interval are judged too (`extrasRegression` in `render/extrasPlan.ts`): each may take the larger of Medium's prediction and its budget, within noise; past it, no extras. | `render/probe.test.ts` "drops extras … when the main thread slows" / "… when the frames slow", "keeps extras … inside the budget"; `render/extrasPlan.test.ts` "extrasRegression" |
| 2 | `e95e8f8e`, `d84b856a` | One visibility watcher (a `visibilitychange` listener and a check every frame) spans the whole probe; a hidden moment anywhere gives session-only Medium, no extras, nothing saved. The follow-up gives the warm-ups the frame hook again (the first commit dropped it). | `render/probe.test.ts` "runProbe and a tab hidden at any stage": Medium's warm-up, the extras' warm-up and measurement, the High re-probe's warm-up and measurement, between them; "runs the caller's frame hook … in every warm-up" |
| 3 | `e548423e` | The old still goes on its own opacity `transitionend`, with a timer at the computed `transition-duration` (3 s under reduced motion) as the backstop; no fade means a plain swap. | `ui/loadingStills.test.ts` "under reduced motion's slower fade", "goes when its fade ends (transitionend)", "plain swap" |
| 4 | `e548423e` | Loads take an `AbortSignal`; a destination change or stop cancels the one in flight (`loadStill` drops the image's `src`); a cancelled still isn't counted as broken. | `ui/loadingStills.test.ts` "a destination change or a stop cancels the download on its way", "loadStill … cancelled" |
| 5 | `4fb24248` | `env.manifest()` resolves null for "no packs here" (4xx, not a manifest): cached for the session, one `console.info`. A rejection (network, 5xx) is retried on a doubling timer, at most 3 a session; a pause holds the retry. | `render/artpacks/ArtPacks.test.ts` "no manifest …: one quiet line", "a transient manifest failure …", "a manifest that keeps failing stops after its tries" |
| 6 | `212ebee9` | Upload steps, `uploadSteps()` and the rebind run under try/catch; a failure frees the whole group, keeps (or puts back) the shipped bindings and takes the same two tries as a failed download. | `render/artpacks/ArtPacks.test.ts` "an upload step that throws …", "setting the upload up … that throws", "a rebind that throws part way" |
| 7 | `4a22c79c` | `stripDecoder()` handles the worker's `error`/`messageerror` and gives each job a 30 s deadline: every job it holds fails, the worker is replaced, and the group's normal cleanup and retry run. | `render/artpacks/env.test.ts`; `ArtPacks.test.ts` "a decode that fails (the strip worker's error or deadline) …" |
| 8 | `9614bc89` | `freeTexture()` is the one release path for HD textures: it closes a held `ImageBitmap` and disposes. | `render/artpacks/ArtPacks.test.ts` "a pause frees a half-made group's bitmaps", "a texture made after its group was given up", "a group that fails part way" |
