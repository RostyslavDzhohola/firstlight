# Review: play-test fixes lane (`night/play` at `73154b34`), GPT-6.1 Sol, 2026-11-13

**Verdict: merge after fixes.** The lane exposes sign-in codes on publicly reachable servers that are
misclassified as development, and mission tracking has two confirmed consistency bugs.

## Findings

1. **Blocker, `apps/server/src/auth/accounts.ts:339`: "not production" does not mean "local
   development".** With `NODE_ENV` unset and no Resend key, the server mounts an unauthenticated endpoint
   that returns any email's recent one-time code. It bypasses the `/api/auth` origin-secret middleware and
   has no local-connection restriction; the production client's build flag only stops its own fetch.
   Confirmed by HTTP probe: public-host and proxy headers, no credentials, HTTP 200 with the code. The
   Dockerfile's `NODE_ENV=production` is safe; an exposed staging server with it unset is not. Require an
   explicit development opt-in, enforce local-only access without trusting spoofable headers, answer
   `Cache-Control: no-store`; test unset `NODE_ENV`, public deployment URLs and proxy access.
2. **Should-fix, `apps/client/src/ui/trackerRows.ts:32`: an active trial overrides the player's tracked
   choice only in the panel.** With A4 running and A1 chosen, the panel marks A4 tracked while the compass
   and the server follow A1. Use one effective tracked mission everywhere; keep a trial's prominence
   separate from "tracked".
3. **Should-fix, `apps/server/src/world/quests/QuestSystem.ts:186`: rate-limited tracking changes vanish
   silently.** `track` shares the five-a-second quest budget; once spent, the server drops the change
   while the client has saved and shown it, and it only resends on a change or a join. Holding Shift+L
   repeats. Acknowledge the effective choice, refuse on throttle, coalesce and retry the latest choice,
   ignore key repeats.
4. **Nit, `apps/client/src/game/padMapping.test.ts:89`: the coverage exemption asserts the wrong thing.**
   "Settings → Missions collapses the panel" is false (that setting hides it). Test the real menu and
   header interaction, including the journal's Track action.

## Checked and sound

Tutorial completion uses durable account flags and a transactional XP and medal payment; reconnect,
rebirth, duplicate-payout and rollback tests pass; account merging carries the flags. Hostile `track` ids
are bounded and resolved against owned, unfinished missions. Regeneration uses server combat tags; weapon
attacks, harmful casts and incoming damage refresh them; the dead are skipped; burning suppresses it.
Targeted tests: dev-code 2/2, onboarding 14/14, regeneration 1/1, hunt-pointer 3/3, tracker rows 5/5;
`pnpm balance` 653/653.

## Not verified

Regeneration against bosses, trials and waves (the balance check excludes bosses and does not model
trial timing, so "cannot out-heal a fight" is not established there). Physical gamepad and touch,
WebGL2, the frame cost of the compass and tag code (they allocate per frame and add DOM work). Agent-seat
and guest-merge tutorial behaviour were traced in source only.

## Fixes

| # | Fix | Commit |
|---|---|---|
| 1 | | |
| 2 | | |
| 3 | | |
| 4 | | |
