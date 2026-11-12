# HUD moments and the home page (lane/look-and-feel) — review round 1 (Codex gpt-6.1-sol)

Scope: `c5547f5b...b79a4f80`. Static review, reasoning effort medium, Standard tier, time-boxed; no tests
run. No blockers.

| # | Severity | Where | Finding |
|---|---|---|---|
| 1 | should-fix | `apps/client/src/game/MomentsClient.ts:231` | Banner processing runs on while a menu or photo mode hides the HUD: queued banners show, sound and expire unseen. |
| 2 | should-fix | `apps/client/src/ui/moments.ts:92` | Mission banners leave out item rewards while `bannerCovers()` suppresses the toast that named them (A3's Large Tonic is never announced). |
| 3 | should-fix | `apps/client/src/ui/momentsView.ts:209` | Hit wedges and kill marks use Web Animations with fixed transforms whatever the reduced-motion preference. |
| 4 | should-fix | `apps/client/src/game/MomentsClient.ts:105` | Creature kills put the wire-format `killerName` (`npc:dusk_wolf`) in the feed. |
| 5 | nit | `apps/client/src/home/home.ts:185` | The hidden hero reschedules itself every second for the whole session; `initHome()` drops its stop callback. |

Verdict: request changes. Decisions and fixes are recorded below this line as they land.

## Fixes

All five accepted and fixed (lane agent, Claude Opus 5.5).

| # | Fix | Commit | Test |
|---|---|---|---|
| 1 | `BannerQueue.pause/resume`; `MomentsHud.tick(now, hidden)` stops the banner clock under `body.fl-paused` or photo mode, the banner on screen resumes with the hold it had left; the feed's clock is unchanged. | `a35e1e9a` | `ui/moments.test.ts` "pauses while the HUD is hidden…"; `ui/momentsView.test.ts` "waits while the HUD is hidden…" |
| 2 | The mission and trial reward line names the granted items (`itemsLine`), from the payload's `items` when sent, else the mission catalogue minus extra cosmetics unless `you.cosmeticsExtras`. A3 reads "+180 XP · +60 ◎ · 1 × Large Tonic". | `1eea7dc9` | `ui/moments.test.ts` "names the items a mission paid…" |
| 3 | Hit wedges and the kill mark check `prefers-reduced-motion` before `animate()`: a brief static hold (opacity only, no transform or fade). | `9b0f359f` | `ui/momentsView.test.ts` "reduced motion" |
| 4 | `feedKiller()` (ui/eventFeed.ts) resolves `npc:<kind>` with `classifyKiller()` and the NPC catalogue; the death feed uses it. | `50ff8639` | `ui/eventFeed.test.ts` "who a death names as the killer" |
| 5 | `startHeroStills` takes a `wake` subscription; home.ts wakes it on `onLandingShown` and `visibilitychange`, and the hidden hero parks with no timer. | `3df3302d` | `home/homeHero.test.ts` "parks with no timer while hidden…" |
