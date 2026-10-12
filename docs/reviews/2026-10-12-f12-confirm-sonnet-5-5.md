# F12 confirmation review (Sonnet 5.5), commit b274af9

I changed no repo files; `git status` is clean at b274af9. Scratch is in `(scratch dir)`. I used no browser and no external service.

## Checks run
- **`pnpm typecheck`:** exit 0 (shared, server, client).
- **`pnpm vitest run`:** 103 files, 956 tests, all passed, 91 s, exit 0. Nothing timed out, so no reruns. No `.skip`, `.only` or `.todo` anywhere in the diff or the tree.
- **Blocker tests, run by name (verbose):** 20 of 20 passed.
  - Codex B1: the three mission-XP tests, the kill-reward test, and the E1 coin test.
  - Codex B2: the two "onboarding pays once" tests, and the staged-copy Spark test.
  - Opus N-B1: the centre/NaN teleport, deep-step and rejoin tests.
  - Also fence/campwall hop, wading on all three planets, and dodge-spam.
- **Lockfile:** `pnpm install --frozen-lockfile --lockfile-only --offline` on a scratch copy of the manifests passed, so the exact vite pin matches `pnpm-lock.yaml`. No `^`, `~` or `*` ranges remain in any `package.json`.
- **Reserved-name probe** (45 reserved-style and 23 ordinary names run through `isReservedName`).
- **Dodge probe:** a scratch run of the real `validateMove` against a flat world.
- **Pre-public greps:**
  - No `/Users/…` paths, personal emails or secret patterns in the tracked tree.
  - The "OASIS/Sixers/Sorrento" hits are only in `docs/content.md` (the avoid-list and a Ready Player Me mention), which pre-public §6 already covers.
  - History still has one `/Users` line (plus the render paths), which is N5 below.

## My prior items

| Item | Status at b274af9 | Evidence |
|---|---|---|
| S1 STATUS stale | Fixed | M6, M7 and M11 current; lane table shows horses and the earlier lanes merged; F2, F10 and F11 re-measured on 668ec82 (2.86 ms; 59.9 fps with p95 18.6 ms, storm 18.5 ms; 59.2 fps with p95 21.9 ms). The F12 row and round-2 lane rows still say "fixing" (see nits). |
| S2 voice-mute persistence "not built" | Fixed | `docs/risk-assessment.md:84` and STATUS M9 now say migration 5 `voice_mute`. |
| S3 browser coverage (T9 card) | Open | `docs/tests/e2e-cards.md` still ends at T8. This round added more client UI (drop confirm, boot screens, Patchkit right-click in the saddle). Run T9 through Codex computer use before sharing the link. |
| S4 no README | Fixed | `README.md` added. I checked each claim against the repo: three planets plus the Portus hub, group-only bosses, death piles, Node 24 / pnpm 10, licence files and notices all exist. `CONTRIBUTING.md` is still missing, which is now listed in pre-public §7. |
| S5 "Hopbit" is a one-letter variant | Deferred (owner decision) | Recorded in pre-public §6 as a display-name-only rename. `content.md` §10 still marks it "OK", which contradicts that note. |
| S6 reserved names over-match | Fixed | Observer, Badminton, Ecosystem, Supporter, Unofficial, Systemic, Preserver, Modest, Device and Developers all pass. AdminBob, ADM1N, Bob_Server and xXAdminXx are still rejected. `config.test.ts` covers both directions. Side effect in nit N-1. |
| N1 AGENTS.md lists close codes only to 4104 | Fixed | 4105 documented; it matches `CLOSE.STORAGE` and `arrival.ts`. |
| N2 stale "no production emitter" comment | Fixed | Comments now explain why the remaining `bossKill` events are synthetic, and `stage-admin.test.ts` drives real assisted kills. |
| N3 `contracts.test.ts` greps source text | Accepted | No change needed; behaviour tests exist. |
| N4 `award()` reads copy state first | Fixed | The `medals.has` check now runs before `official()`. |
| N5 pre-public `/Users` check can't reach 0 | Partly fixed | A parenthetical was added to the check line, but the recipe's replace list was not extended. Add an explicit regex line. |
| N6 vite caret | Fixed | Exact `8.3.4`, lockfile specifier updated. |
| N7 fixed sleeps in movement tests | Deferred | The reason still holds (the server budget uses `Date.now()`). The file went from 39 to 52 `sleep(` calls. See nit N-2. |
| N8 `FireMsg.t` and `melee.t` comments, `travel.viaPad` | Fixed | The protocol comments now match the server. |
| N9 inventory X drop, pickup toast | Fixed | See UX notes below. |
| N10 production DB-path env | Closed | Production at 668ec82 booted and F2 ran on it, so `AUTH_DB_PATH` and `GAME_DB_PATH` are set. |

## Codex and Opus blockers (spot-checked)
- **Codex B1 (mission XP lost):**
  - `addXp` writes XP and level inside the same `persist` transaction as `done`, coins and items; level-up effects run only after commit and add no second save.
  - Verified by the restart read-back, the "second write fails" and the retry-once tests.
  - Kills and boss loot use the same split. A failed kill save pays and announces nothing, and the next kill pays once.
- **Codex B2 (onboarding paid twice):**
  - The completion is now conditional on the stat going 0 to 1, and it runs through `persist`.
  - The trainee is retired before the after-commit effects.
  - The test fails every write after the commit and shows XP stays 50 with completion at 1.
- **Codex S1, S2, S3:** closed.
  - Assisted boss kills: `bossKill` is now emitted before the loot, and a test confirms levelling past 10 and 20 awards no medal and saves `life.unofficial`.
  - Fence and campwall hops: corrected.
  - Checkpoints: retried with backoff, and a recovered store gets the newest state.
- **Opus N-B1 (teleport through the planet centre):**
  - Closed. `validateMove` refuses non-finite or sub-half-radius targets and uses NaN-safe comparisons.
  - `snapToGround`, the horse whistle and the load-time position check are guarded, with rejoin tests for `[0,0,0]` and NaN.
  - I re-checked the geometry: a free radial step only reaches the centre, which is now refused. Any other far hop costs about 2·sqrt(r1·r2)·sin(θ/2), so there is no free hop.
- **Opus SF1–SF9:**
  - SF1–SF3 (path sweep, shared swim depth, Spark exempt from staging) are closed.
  - SF4–SF9 (load-test piles, guest pruning, OTP endpoints and error answers, per-account OTP cap, banned refusal, self-delete, pad-cheese clock) are closed, with real-flow auth tests.

## Review notes by lens
- **Content vs `content.md`:**
  - The Patchkit card text (tier 2: 0.9 s channel, 40% over 2 s, 4 m, 6 s cooldown) matches `weapons.ts` and §2.3.
  - Dodge 4.5 m in 0.3 s matches the client.
  - `content.md:157` says "Tonics and Patchkits still work" from the saddle, but the code and client now also allow the Prism Bubble there and in safe zones.
- **Test quality:**
  - Globals are restored: `SOCIAL_RULES` in `finally`, `COPY_RETRY` in `afterEach`, and stores and tuning reset by `startServer`.
  - The new tests use real paths, with failure injection at `repo.save` and real SQLite handles.
  - Positive waits use `waitFor` or `until`.
  - The weak spots are in nits N-2 and N-4.
- **UX:**
  - The drop confirm works. A first X on a hovered slot arms it and shows "Press X again to drop it"; a second X within 1.5 s drops. A picked item or a drag to the drop zone still drops at once. `send()` re-renders so the hint shows immediately, and a timer clears it.
  - The pickup toast reads "Picked up 4 item(s) · 3 in your backpack (I)".
  - The tooltip says "X twice drops it".
  - The boot failure screens for stale version, storage lockout and refused device are clear, and their strings match the server.
- **Auth and IP:**
  - Better Auth endpoints the game doesn't use now answer 404.
  - Every failed code check gets one 400 answer.
  - README licence lines match `LICENSE-ART`.
  - No new IP issues.

## New items

### Blocker
None.

### Should-fix
1. **A failed save loses boss and kill payouts with no retry.** `apps/server/src/world/npc/boss.ts:589` catches a `bossLoot` failure and moves on; `apps/server/src/world/npc/rewards.ts:144` does the same for `rewardKill`.
   - Scenario: a transient SQLite error at the kill tick. A group that fought a boss for minutes loses XP, coins and items, and ordinary kills also lose their hunt credit. The transaction rolls back cleanly, but nothing re-runs it.
   - Fix: retry the same payout on the next ticks, a few times with backoff. A retry cannot double-pay because the failed transaction left nothing behind. Leave the 4105 lockout as it is.
2. **T9 browser card (carry-over of S3).** Run it before the link is shared. It is not a code gate.

### Nit
- **N-1. Reserved names: glued lowercase now passes** (`apps/server/src/db/names.ts:59`). My probe: `adminbob`, `gameadmin`, `theadmin`, `serverbob`, `supportteam`, `systemmsg`, `devbob`, `modbob` and `officialfl` pass; the old substring filter blocked them. Add `admin`, `oversight` and `sysop` as prefix or suffix rules, which don't hit Badminton or Observer. Don't do this for `staff`, which would block the name Staffan.
- **N-2. Fixed sleeps before positive assertions** (`apps/server/test/movement.test.ts:162, 573, 639`). Each is `sleep(300)` then `expect(corrections > 0)`, which can fail on a loaded machine. Use `await waitFor(() => corrections > 0)`; `waitFor` is already imported.
- **N-3. Dodge-spam residual.** The probe shows DODGE sent every 1.1 s sustains 12.6 m/s with 0% refusals, against 10.8 m/s (with the 1.2 slack) without it. That is about 17% better than before, down from roughly 14.9 m/s. Lower `dodgeBurst` toward about 1.3 plus slack and set the cooldown to the client's 1.2 s. The bank (3.5 m) already covers a legitimate dodge.
- **N-4. Mission tests emit synthetic `kill` events** (`apps/server/test/rollback.test.ts:209` and onward), against AGENTS.md's real-path rule. The kill-reward test does drive the real path.
- **N-5. Docs:**
  - README lists proximity voice, but F6 is blocked on the owner's TURN key. Add "when the relay key is set".
  - README credits "Claude Opus 5.5 with Codex reviewers" and omits the Sonnet and Opus reviews.
  - `content.md` §10 says "OK" for Hopbit while pre-public says it violates the rule.
  - `content.md:157` is missing the Bubble.
  - STATUS lane rows and the F12 row still say the two round-2 lanes are in progress. Update after this verdict.
  - STATUS credits the F11 improvement to "the F12 client lane removed per-frame allocations", which is an untested guess.
- **N-6. Not in this diff:** the camera reset on every server correction (`PlayerController.teleport`, lines 103–111), from Opus's nit list.

F12 sign-off: yes
