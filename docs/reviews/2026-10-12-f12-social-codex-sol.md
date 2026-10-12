# Review: lane/f12-social, Codex gpt-6.1-sol

Reviewed all six commits, `0df813f..a56b36b`. Checkout remains clean.

## Blocker

None confirmed. The original repeated-block mint-budget attack is addressed. I did not demonstrate continued audio reception from an honest blocker.

## Should-fix

1. **Account merges bypass party block protection.** `apps/server/src/social/system.ts:160`; `apps/server/src/social/index.ts:22`.
   Saved account A blocks B, joins B's party as a guest, then signs into A. The merge preserves the block but carries the guest's party membership into A. The probe confirmed that the blocked pair remained together and `partyRoomFor(A)` still routed to B's copy, exposing live positions.
   **Fix:** reconcile affected parties against merged blocks before publishing state or allowing routing. Test incoming/outgoing blocks and destination-party retention through real sign-in.

2. **OTP rate-limit responses enumerate saved addresses.** `apps/server/src/auth/better-auth.ts:94-98`.
   Without a session, an exhausted saved address returns `429 SAVING_BUSY`; an unknown address returns `200`. The probe confirmed this with Better Auth's IP limiter enabled, within its eight-request allowance. Awaiting email delivery also creates a timing difference.
   **Fix:** make public responses independent of address eligibility, budget exhaustion, and delivery failure. Decouple delivery timing and test exhausted budgets and a delayed mailer.

3. **Failed six-hour TURN refreshes keep postponing their retry.** `apps/server/src/world/voice/VoiceSystem.ts:247-249,321-322`.
   The failed refresh retains stale credentials. Every tick calls `sendIce()`, whose early-return branch advances `turnRetryAt` another 30 seconds. Recovery cannot trigger another mint until the old credential expires. Forty simulated one-second ticks produced only one failed mint, with the deadline still ahead. Pending block rotations during this period are also delayed.
   **Fix:** preserve an existing retry deadline when returning early; advance it only after a failed attempt or budget refusal. Test successful recovery after 30 seconds.

4. **Saving or merging resets report limits.** `apps/server/src/social/limits.ts:35-40`; `apps/server/src/social/index.ts:22`.
   A guest files five reports, then saves/signs into another account. Reports move in SQLite, but limiter history stays under the old ID. The real sign-in probe exhausted the guest budget and immediately obtained another slot after merging. Same-target protection also resets when either identity changes.
   **Fix:** merge unexpired reporter and target histories during linking, or enforce limits from persisted report history. Test both reporter and target merges, including an exhausted destination account. Ordinary rejoin protection and eviction timing look correct.

5. **Pruning can delete a guest immediately after a long session ends.** `apps/server/src/auth/prune.ts:47-60`.
   A level-1 guest keeps one connection open for over 30 days without further auth/account HTTP requests. The live registry protects them while connected, but their old join/auth timestamps make them eligible immediately after leaving. Recent character saves and gameplay-session activity are ignored. The probe confirmed deletion after disconnect despite a fresh character save.
   **Fix:** persist gameplay last-seen during saves/leave, or include recent character/session activity in eligibility. Protect lingering actors and test long sessions ending or interrupted by restart.

## Nit

1. **Cooldown suppresses revocation for newly established blocked pairs.** `apps/server/src/world/voice/VoiceSystem.ts:483-485`.
   A blocks T and triggers rotation. B then exchanges signalling with T using the new credential and blocks T within ten minutes. The probe confirmed no revocation or pending rotation. Both clients receive `voice:drop`, and an honest blocker closes its connection, so this does **not** demonstrate an audio leak.
   **Fix:** document the conditional server cutoff and test this multi-blocker case. An unconditional relay cutoff would require revocation scoped to the pair/allocation.

2. **Guest deletion is not atomic across databases.** `apps/server/src/auth/prune.ts:89-92`.
   Game deletion commits before auth deletion. An injected auth failure preserved the user/session but removed their game account and character. Level-1 coins and nonempty inventory also do not prevent eligibility; piles remain by design.
   **Fix:** use recoverable deletion jobs or coordinated rollback for ordinary errors, test interruption between phases, and document the loot deletion policy. The 5,000-per-run cap passed a 5,001-candidate probe.

`pnpm typecheck` passed. All **205 tests across 10 relevant files passed**, with no timeouts. Level-2 saving, returning-email sign-in, and account-link tests passed, but they miss the transitions above.

Reviewer's note: one earlier probe's cleanup let TURN revoke calls fall through to `fetch` with synthetic credentials (a boundary slip; no real credentials used or printed). The stub was corrected and the probe rerun with every TURN request mocked and other non-local requests refused.

**Merge: no**
