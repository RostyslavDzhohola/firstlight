# Review: lane/f12-sky, Codex gpt-6.1-sol

Reviewed all 11 commits in `0df813f..lane/f12-sky`, HEAD `6aa53d1`. No source edits; tracked worktree remains clean.

## Blocker

None found in this diff.

## Should-fix

1. **Held stages show the wrong time on previous-build clients.** `apps/server/src/world/SkySystem.ts:100`
   Previous clients ignore `dayHold` and calculate time from `dayOffset`. Holding sets that offset to zero, so existing clients show natural time. The probe requested dusk at `0.83`; the previous-client calculation returned `0.62`.
   **Fix:** Populate `dayOffset = want - dayAt(body, now)` even when holding. Older clients then initially show the requested time. Negotiate hold support or require a refresh for fully frozen staging. Add mixed-build coverage.

2. **Backward clock snaps skip intervening lightning.** `apps/client/src/render/environment.ts:238`
   A resync moves the estimated server clock backward 60 seconds during the same storm. The cached strike survives because weather and `slotStart` remain unchanged. The probe retained a strike at **+63.289 seconds** although the next deterministic strike was **+11.303 seconds**. No thunder fired during the following 50 seconds.
   **Fix:** Invalidate cached lightning on clock snaps and clear stale flash/pending-strike state. Add a backward-correction lightning test.

3. **Long overrides desynchronize lightning across client builds.** `packages/shared/src/sky.ts:202`
   Old and new clients receive the same 30-minute storm. Immediately after its first ten-minute boundary, the previous implementation selects **+602.640 seconds**; this branch selects **+621.726 seconds**, with different seeds.
   **Fix:** Preserve the legacy sequence during the compatibility period, or negotiate the schedule version and refresh incompatible clients before long overrides. Test against the previous implementation.

## Nit

1. **Window boundaries exceed the documented 25-second maximum strike interval.** `packages/shared/src/sky.ts:204`
   Restarting the interval at each boundary produced a **34.042-second gap** in a 240-minute Arcadia storm. The test checks minimum spacing but misses the maximum.
   **Fix:** Preserve cadence across boundaries, or document and test the longer boundary gaps.

## Validation

- `pnpm typecheck`: passed.
- `pnpm --filter @firstlight/client build`: passed.
- Relevant Vitest runs: **9 files, 184 tests passed**, including WGSL/GLSL generation, type stripping, staging and warm-up. No timeouts.
- Four scratch probes reproduced the findings.
- Missing `since`/`dayHold` causes no wire crash. Expiry ticks and room recreation clear overrides; stages on one copy are last-command-wins. The new uniform preserves shader topology.

Merge: no
