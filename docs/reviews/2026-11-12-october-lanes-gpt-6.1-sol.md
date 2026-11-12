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
