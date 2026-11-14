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
| 1 | `/api/account/dev-code` needs `DEV_SIGNIN_CODES=1` (set only by the server's `pnpm dev` script; a production config with it refuses to boot), is never mounted in production, answers `Cache-Control: no-store`, and serves only a caller whose TCP socket address is loopback with a loopback Host and no forwarding header naming anyone else (`localDevRequest`, `auth/ip.ts`). Tests: no opt-in with `NODE_ENV` unset → 404; opt-in from the LAN address → 404, also with spoofed `Host`, `X-Forwarded-For`, `X-Real-IP`, `Forwarded`; a loopback proxy forwarding a remote caller → 404; a rebound host name → 404; production with everything forced on → 404. The sweep found the same mistake in `/api/play`'s development loopback exemption (it trusted `X-Real-IP`); it now keys on the socket (`loopbackCaller`). D-fixplay-1 | `4ee49781`, `a3968d70` |
| 2 | The panel's tracked row is `trackedMission(open, body, chosen)`, the same as the compass and the server's hunt targets; a running trial leads the list, lit, with its objective and a "Trial running" kicker, and owns the collapsed line, but is not called tracked | `282f5ac5` |
| 3 | The server answers `track` with `tracked {id}` or, throttled, `denied {action: "track", reason: "slow down"}`; the client's `TrackSync` keeps one send in flight, coalesces to the latest choice, retries after a refusal or a lost send, resends on a new room; Shift+L steps once per press and L ignores key repeats. New server message `tracked`: PROTOCOL_VERSION bump at integration | `81b4d058` |
| 4 | The exemption is replaced by `ui/missionsReach.test.ts`: the pad opens the journal from the pause menu's Journal row (now the shared `MENU_KEY_ROWS`), the real focus navigator reaches the Track buttons and a new "Fold the missions panel (L)" button, and A on them tracks and folds; touch taps the panel's header (folds) and rows (tracks). The coverage test reads the pause rows instead of claiming Settings collapses the panel | `3f9807e9` |
| Not verified: regeneration vs bosses, trials, waves | The balance model now measures every boss's and trial's longest pause: Tidewrath and the Receiver 10.4 s (plate window), the Hollow King 9.0 s, H4 23 s and T2 25 s between waves, the race and collect trials none. Regeneration is held for a boss's fighters while it is engaged and for a defend runner until the attempt ends (`REGEN.PAUSED_IN`, `holdRegen`), and `pnpm balance` fails an unheld encounter that reaches the delay. D-fixplay-2 | `dcfd4169` |
