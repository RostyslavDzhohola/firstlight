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
