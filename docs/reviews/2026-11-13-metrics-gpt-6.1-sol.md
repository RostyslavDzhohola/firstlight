# Review: metrics lane (`night/metrics` at `8ada07c3`), GPT-6.1 Sol, 2026-11-13

**Verdict: merge after fixes.** The collector can present incomplete runs and failed correctness gates as
acceptable optimisation results: blockers before an automated loop uses it.

## Findings

1. **Blocker, `tools/metrics/collect.ts:445`: failed or missing measurements can pass.** Collection
   failures add notes and return partial metrics; the run still exits 0. Comparison fails only on `worse`,
   so missing groups become `gone` and also exit 0. A failed build can keep stale `dist` numbers.
   Confirmed: a run declaring every baseline group with `metrics: []` passes validation. Record per-group
   success and completeness, propagate subprocess failures, reject incomplete repeats, fail comparison on
   missing required metrics, killed server levels included.
2. **Should-fix, `collect.ts:156`, `schema.ts:165`: correctness gates tolerate and erase failures.**
   `tests.*.failed` has floor 1, so 0 → 1 failing test is "same"; medians hide intermittent failures
   (`[0,0,2]` folds to 0). Zero tolerance for correctness gates; aggregate them by maximum.
3. **Should-fix, `schema.ts:123`: comparison ignores incompatible definitions.** Same id, different
   `unit`, `better` or `group`: the baseline's wins silently (1000 ms → 2 s is "better"). Reject mismatches.
4. **Should-fix, `collect.ts:294`: pass comparisons ignore their measured noise floor** and publish costs
   when `p.valid` is false. Reject invalid reports; use at least `p.noiseMs` as each cost's floor.
5. **Should-fix, `collect.ts:346`: server samples need not be at the requested load.** The join wait
   expires after 150 s and samples anyway; a partial "bots joined" line also releases it; `RESULT` is
   accepted without `r.bots === n`. Require the requested live population before and through sampling;
   record the sampled population.
6. **Should-fix, `apps/client/src/render/props.ts:331`: the procedural fallback draws both levels fully.**
   The overlap in selection is installed for all, the fade mask only with downloaded vegetation assets. If
   they fail to load, both shapes draw through the band. Give the procedural materials the mask, or keep
   exclusive selection until the assets install.
7. **Should-fix, `apps/client/src/render/lodFade.ts:98`: shadows still switch abruptly.** Near geometry
   casts its full shadow after its colour coverage reaches zero, then drops it at `fullTo`. Fade shadow
   coverage with the level, keeping the occluder-shadow policy.
8. **Should-fix, `docs/metrics/baseline-2026-11-13.json`: the baseline lacks current default outputs**
   (all 14 `server.bots80.*`, eight per-body `pixel_ratio` / `canvas_mpx`, warm load). Regenerate with the
   final collector, or mark those unsupported and stop comparisons passing until populated.
9. **Should-fix, `collect.ts:463`: `--merge` can misattribute measurements** (first file's commit, dirty
   flag, machine and time for all). Reject incompatible provenance or keep it per group.

## Checked and sound

Metrics tests 17 passed; detail-level and pass-cost tests 19 passed; server security tests 24 passed.
`/api/metrics` is not public in production (it needs a strong load-test secret and `LOADTEST_ENABLED=1`);
the new fields are room timing and counts. With installed assets the colour masks are complementary; the
TSL used works on both backends; no new depth pre-pass. GTAO's shipped mode is unchanged.

## Not checked

Browser rendering, WebGL2 and Low output, the shadow look, clips, browser-dependent groups, the Medium
frame-cost claim (unpriced on a quiet machine).

## Fixes

| # | Fix | Commit |
|---|---|---|
| 1 | | |
| 2 | | |
| 3 | | |
| 4 | | |
| 5 | | |
| 6 | | |
| 7 | | |
| 8 | | |
| 9 | | |
