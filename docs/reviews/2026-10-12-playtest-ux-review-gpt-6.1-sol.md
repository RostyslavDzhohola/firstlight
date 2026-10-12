# Review: lane/playtest-ux, Codex gpt-6.1-sol (round 1)

Reviewed `main..lane/playtest-ux` at `132f91c`.

## Blocker

None found.

## Should-fix

- `apps/server/src/world/npc/spawns.ts:241`: **Spawn filtering shifts persisted group IDs.** After
  deployment, restoration matches old numeric IDs using only member composition. A main snapshot
  restored against this branch marks a different six-Hopbit pack, 69.80 m away, as cleared with
  119 seconds remaining. The Golden Hopbit's unchanged physical pack shifts from ID 98 to 97,
  dropping its saved 15-minute cooldown and allowing immediate reappearance. This violates D33's
  copy-state persistence requirement. **Fix:** introduce stable spawn identities, migrate saved
  group and Golden timers, and add a main-layout snapshot regression.

## Nit

- `apps/client/src/game/onboardingProgress.test.ts:50`: The "server says done/skipped" cases both
  call `progress.end()` directly. They cannot catch missed messages, stale-room snapshots, or
  incorrect account selection in `OnboardingClient`. **Fix:** add lifecycle tests covering early
  and late `you` messages, room travel, account/guest switches, and done/skip followed by disposal.

## Validation

- `pnpm typecheck`: passed.
- `pnpm --filter @firstlight/client build`: passed.
- Nine relevant test files: 114 tests passed, no timeouts.
- `git diff --check`: passed.
- Spawn layouts remain deterministic. Dawnpad has three Hopbits; Clover Fields retains 29 for Pest
  Control. Fresh layouts retain E3's Golden Hopbit.
- No T binding conflict, account-key collision, malformed-storage crash, or map-placement
  regression found.
- Visual results at 1280×720, 1440×900 and 1920×1080 were not checked by this review (no browser).

**Merge: no**, pending the spawn-state migration fix.

## Builder's response

- Should-fix: fixed in `546a998` (saved state keyed by make-up + place; older saves drop group
  state and hold every Golden Hopbit until the latest saved return) and `73b2d05` (new saves omit
  the numeric ids, so a pre-key server skips them on rollback). Round 2 confirmed the forward path.
- Nit: deferred (no failure found by inspection; lifecycle tests to add with the next onboarding change).
- Visual check: done by the builder in the UI gallery at 1280×720 (onboarding attack/portal cards,
  Esc menu with How to play): no collisions or clipping.
