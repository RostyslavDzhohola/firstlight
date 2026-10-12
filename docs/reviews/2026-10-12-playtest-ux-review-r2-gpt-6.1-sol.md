# FIRSTLIGHT playtest UX review, round 2

Reviewed `lane/playtest-ux` at `546a998a926dba88e0ce73626f7a28c216c14208` against `main` at `c9ddf29470364e9fe7f6b5f1e7369aec54fdd9b1`, including the full 19-file `main...HEAD` diff. Read `AGENTS.md` and relevant specifications/decisions. Report only; no source edits, commits, pushes, browsers, or deployment. The requested report is the only worktree change.

## Blockers

None.

## Should-fix

1. **Rollback to unpatched main restores state onto the wrong layout and loses the Golden cooldown.** `apps/server/src/world/npc/persist.ts:44` and `apps/server/src/world/npc/persist.ts:52` still write the new layout's numeric IDs in `p` and the first Golden tuple element, while retaining `v: 1`. Main accepts the format but ignores `k` and the third tuple element, then interprets those IDs against its old layout. Parsing compatibility does not preserve identity.

   Reproduced with the actual writer/reader extracted from local main and JSON serialization: clear branch group 2 and pop its Golden at group 97, snapshot, then restore with main's reader and layout. Main clears its unrelated six-Hopbit group 2, **69.797 m** from the saved group, and restores **no Golden cooldown**. Main's Golden is group 98, so it can return before the saved 15-minute deadline. This is the round-1 defect in reverse.

   **Fix:** ship a key-aware persistence compatibility release on the main layout before deploying the spawn-layout change, and make that patched release the rollback target. It must read keyed entries by identity, handle legacy entries conservatively, and write keys. Alternatively, provide an explicit reverse migration that maps keyed state onto the old layout before starting unpatched main, preserving Golden deadlines. Simply deleting snapshots or bumping `v` would also lose cooldowns. Add a regression using the real main layout/writer and the rollback reader; the synthetic shifted-layout tests at `apps/server/test/npc-persist-layout.test.ts:29` do not cover this path. Applying the new key-aware reader to the old layout restored the Golden deadline at old ID 98 in the probe.

## Nits

1. **Deferred from round 1: test the onboarding lifecycle itself.** `apps/client/src/game/onboardingProgress.test.ts:9` tests the storage helper, but does not drive `OnboardingClient` construction and room-message ordering. Add focused coverage for initial `you` before construction, delayed `you`, travel back from another body, and done/skipped followed by disposal. Assert that stale prior-room state cannot erase incomplete tips and that disposal cannot recreate cleared progress. No new failure was found by inspection.

## Migration and deploy order

- **Forward restore is correct under the implemented, lossy migration policy.** Main's actual writer produces group entries without `k` and two-element Golden tuples. The new reader drops all legacy group dead/cleared state rather than assigning it to a different pack. This can respawn cleared packs early and resurrect partially killed members once per legacy snapshot migration. It does not preserve ordinary group timers. Legacy Golden deadlines are applied to every Golden-bearing point using the latest deadline, so a popped Golden does not return early; other Goldens can be delayed conservatively.
- The actual main-writer probe restored Arcadia's legacy deadline `1900000` at new Golden ID 97 and restored no wrong cleared group. Keyed snapshots preserve unchanged group identities despite numeric ID shifts. Boss timer/fight handling is unchanged.
- **Client/server deployment order is independent for this diff.** No shared protocol, schema, or content-index change requires a matching client release. Old/new clients can use either server revision. The persistence hazard concerns server versions sharing saved copy state. Upgrade the server through a compatible reader/writer release before changing its layout, and use that release for rollback. Drain old room owners before switching versions that would read/write the same copy state.
- The supplied round-1 repro now passes, but it calls the new snapshot writer on the old layout and therefore creates keyed entries. It does not prove migration from deployed main's keyless output. The separate probe used both actual main persistence functions. Deployment conclusions use the supplied deployed-main premise and the local main commit; no live server or database was inspected.

## Direction quantization

`apps/server/src/world/npc/persist.ts:37` uses deterministic direction calculations and `Math.round(v * 1e5)`. With unchanged inputs, code, and Node runtime, rounding at a half boundary does not vary between restarts. Eight fresh Node **v24.19.0** processes produced identical complete directions and keys for all **531** generated points. Each body's keys were unique: Arcadia 104, Hollowmere 187, Meridian 240.

The closest measured component to a rounding boundary was about **1.79e-9** in direction units, well above ordinary last-bit floating-point variation. This supports stability on the tested runtime, not a guarantee across future runtime/platform or generation-algorithm changes. A coarser grid also has half boundaries and increases collision tolerance; there is no demonstrated restart defect requiring coarsening. Keep the current resolution. If identity must survive generation changes, use explicit stable candidate/area IDs rather than changing the rounding precision.

## Validation and remaining scope

- `pnpm typecheck`: passed for shared, server, and client.
- `pnpm vitest run apps/server/test/npc-persist-layout.test.ts apps/server/test/copy-state.test.ts apps/server/test/npc-unit.test.ts apps/server/test/m11-egg-persistence.test.ts apps/server/test/npc-spawns.test.ts`: **5 files, 62 tests passed**. No timeout or isolated rerun was needed.
- Client onboarding progress/steps and map-label tests: **3 files, 21 tests passed**.
- `git diff main...HEAD --check`: passed.
- Local probes: `/tmp/fl-review-codex-ux/r2-migration.mjs`, `/tmp/fl-review-codex-ux/r2-key-stability.mjs`, and the supplied `/tmp/fl-review-codex-ux/spec-spawn-migration.mjs`.

The full diff yielded no additional blocker, should-fix, documented standards violation, or actionable code smell. Visual checks remain unperformed as requested. Passing tests do not resolve the demonstrated rollback defect.

**Verdict: merge after fixes.**
