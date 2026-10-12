# F12 confirmation review (Codex gpt-6.1-sol, high), commit b274af9

All six requested prior findings are closed. No new blocker found. Three non-blocking regressions remain below.

## Checks run

- Verified detached HEAD `b274af9481247c858d601d5297e754cd6caec9bd`. Reviewed `668ec82..b274af9`. Checkout clean before and after; no repository files changed. All scratch source, SQLite fixtures and logs are under `(scratch) `.
- `pnpm typecheck`: passed, exit 0, shared/server/client. Run once.
- `pnpm vitest run --no-cache --configLoader runner --maxWorkers 3`: passed, exit 0, **103 files / 956 tests**, **153.44 s**. Run once; no timeouts or file reruns. Flags avoid checkout caches and limit shared-machine load.
- Adapted and ran the previous reward, onboarding post-commit, assisted-boss, prop traversal and checkpoint retry probes. Added network-level centre teleport/corrupt-rejoin, HP ordering and small regression probes. Every probe exited 0.
- Offline preload cleared inherited service credentials and refused non-loopback fetches. TURN tests use a stub refusing unmocked calls. No browser/computer use, live site or external services.
- Reviewed XP/level commit and rollback ordering, boss kill-before-loot credit, swept collision and its boss-cover forwarding, normal movement/prop support/escape, horses, swimming, knockback, checkpoint backoff/restoration, OTP routes and budgets, pruning, reserved names and inventory drop confirmation. Relevant regressions all passed in the full suite. No new dependency, asset or licence/IP problem found in the diff.

Evidence: `typecheck.log`, `vitest.log`, and the named `*-probe.mts` / `*-probe.log` files in the scratch directory. The suite exercises the real local Better Auth/Colyseus paths; client inventory verification is pure logic plus source inspection, without a browser.

## Prior findings

| Prior item | Status | How verified at b274af9 |
|---|---|---|
| B1: mission XP committed outside reward transaction | Closed | SQLite reward probe: level-5 completion stores **930 XP**, matching live XP; rehydrate/retry keeps 930. Level-up completion invokes **one save**, storing **80 XP / level 2 / done=true**. An injected second-save failure is never reached. Full-suite rollback tests confirm failed first saves leave rewards unpaid and retry pays once. |
| B2: onboarding completion can pay twice | Closed | Adapted SQLite final-dummy attack commits **50 XP / completion=1**, uses one save and retires the trainee. Another attack and reinserting an all-down trainee still leave **50 XP / completion=1**. Full suite also covers transaction failure and later write failures. |
| S1: assisted boss XP awards permanent level medals | Closed | Adapted probe now drives actual boss death through `dealDamage`, rather than calling loot directly. Assisted kills crossing **10 and 20** award neither Ten Down nor Firstlight; live and stored life are unofficial before level-up events. |
| S2: endpoint-only prop checks | Closed | Original production fence fixture's **1.397 m** traversal is refused as `prop`. Full suite covers fence/campwall crossings, walking beside a fence, supported tops, escape after rebuild, compound colliders, terrain sprinting, horse limits, swimming/wading and stacked knockback. |
| S3: failed copy checkpoint not retried | Closed | Original SQLite crate fixture fails its first save, then recovers: **3 attempts**, durable destruction row, crate remains broken on recreation. Passing copy-state tests also reopen SQLite after failed NPC camp checkpoints, exercise bounded backoff/timer retry and retain staging restrictions during failures. |
| Opus N-B1: two-packet planet-centre teleport | Closed | Non-admin network probe sends centre then a target **1007 m** away: **2 corrections / 0 m displacement**. Centre, NaN and deep-under-surface saved positions rejoin at finite pad positions; zero-vector ground snapping and horse placement remain finite. Full suite checks restored characters can walk. |

## Blocker

None found.

## Should-fix

### N-S1. Level-up healing is missing from the committed snapshot

`apps/server/src/world/BodyRoom.ts:1009` and `:1286`.

Reward callers save XP/level before `showLevel()` adds HP to synchronized state. SQLite mission probe confirms **live HP 110**, but the committed **level-2 row has HP 100**. A process interruption before the next save restores 100/110. This regresses the previous save-after-healing order, while XP and rewards remain correct.

**Fix:** include projected level-up HP in the same reward transaction and rollback; defer synchronized publication and messages until commit. Recoverable HP discrepancy, not permanent progression loss. Evidence: `hp-order-probe.log`.

### N-S2. Recovery marks expire while saving may still be broken

`apps/server/src/world/admission.ts:63`.

After one hour, sweeping removes a failed-death recovery mark before the account's health check. Probe keeps saves throwing: admission changes from refused to allowed with **zero health writes**. The user can reload the last alive snapshot during the same storage failure. The failed death transaction rolls back its pile, so this is not a demonstrated item dupe.

**Fix:** retain the requirement for a successful storage check when admission resumes; bound memory separately, for example with a global recovery-health gate or durable recovery marker. Evidence: `small-regressions-probe.log`; the new storage-recovery test currently explicitly accepts this lapse.

### N-S3. Holding X satisfies the new drop confirmation

`apps/client/src/ui/inventory.ts:44`.

The key handler passes every keydown to the cursor without filtering `KeyboardEvent.repeat`. One sustained physical press therefore arms the drop, then keyboard autorepeat confirms it. Pure-model probe confirms a second forwarded KeyX at **500 ms** produces `drop`; the handler source confirms repeated events use that path. No UI/browser was used.

**Fix:** swallow/ignore repeated destructive keydowns so confirmation requires a second physical press. Clear the armed confirmation when the panel closes or its selected item changes. Evidence: `small-regressions-probe.log`.

## Nit

None additional.

F12 sign-off: yes
