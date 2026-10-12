# M11 #5 round 2 implementation report

Worktree: `fl-wt-m11`, branch `lane/m11-cosmetics`. Responds to the findings in
`docs/reviews/2026-10-12-m11-cosmetics-codex-sol.md` at reviewed commit `bfffbe3`.
This is an implementation report, not a new independent review.

## Findings

- **B1 fixed, `0c65e98`.** The shared egg helper now commits the reward item, any offering,
  life claim, eligible medal and first-finder reservation in the same SQLite transaction.
  Medal cache changes, Hall broadcasts and reward messages follow the commit. The existing
  helper covers E1 through E12. Real-message SQLite tests cover E1 and E10 through E12:
  medal-write failure pays nothing, same-session retry pays once, restart between attempts
  preserves the unpaid claim, a failed final character save rolls back the medal and Hall,
  and simultaneous finishers earn their rewards with one durable first-finder. E1 also checks
  the offering is retained on failure and charged once on success. Repeated claims pay nothing.
- **S1 fixed, `3f340ad`.** Cosmetic pity is held outside the room in a process-wide map keyed
  by account, life and cosmetic. The 539-miss probe now pays on roll 540 after recreating the
  same copy or entering another copy. Other accounts and new lives have separate counters.
  This also covers the original planet cosmetics. `docs/content.md` documents that server
  restarts and six hours without an eligible roll reset counters. There is no per-copy
  persistence or database migration.
- **N1 fixed, `caa23ec`.** The three lockout-expiry sleeps now wait for the account timers to
  clear. Deliberate quest-message pacing remains.

## Validation

- Red before implementation: all three new eggs failed the SQLite medal-write rollback test;
  the copy-recreation probe failed its roll-540 assertion.
- Targeted tests passed after implementation: the 16 SQLite claim tests, 23 NPC unit tests,
  M11 egg tests, original quest tests, egg penalties and rollback tests.
- Merged local `main` at `8ac39dc` into the lane without conflicts. Incoming changes were
  `docs/STATUS.md` and the original review. The builder's status text was preserved.
- `pnpm typecheck`: passed.
- `pnpm --filter @firstlight/client build`: passed.
- Full `pnpm test`, run once: 110 files passed and one failed; 1,060 tests passed and one
  failed, out of 111 files and 1,061 tests. The sole failure was the static contract assertion
  requiring the old two-argument medal call. It now accepts the optional deferred-effects
  argument. `pnpm vitest run apps/server/test/contracts.test.ts`: all five tests passed.
  No files timed out. The full suite was not repeated.
- `git diff --check`: passed.

No browser, computer use, external services, push, deployment or merge into main was performed.
Round 2 changes no client or shared code, and adds no egg solutions to comments, user-facing
text or the client bundle. Local client build output is in `apps/client/dist/`.
