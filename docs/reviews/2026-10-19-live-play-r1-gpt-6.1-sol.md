# Live play sessions — lane/live-play, review round 1 (Codex gpt-6.1-sol)

Scope: `main...b368f636` (`apps/client/e2e/live/`, `live.config.ts`, `player.ts` `clickAt`, the
`e2e:live` scripts). Standards and correctness. The reviewer read code only: no suite, no session.

Verdict: request changes. Config inheritance, headless + muted enforcement, API-scoped guest
marking, prod refusal of `dev`/`save` and `pnpm e2e` not picking up `live/session.ts` are correct.

| # | Severity | Finding | Builder's decision |
|---|---|---|---|
| 1 | Blocker | `fight` can shoot through another player (J3.4's in-line guard is missing); on production that is a real person. | Fixed: J3.4's guard, plus no melee swing with a player beside the foe, plus J3.4's point-blank back-off. |
| 2 | Should-fix | The idle timer runs during a command; `quit` races queued commands; shutdown isn't awaited. | Fixed: the idle clock runs only between commands; `quit`/idle mark the session closing, later commands get 503; cleanup in `finally` awaits the queue and `server.close`. |
| 3 | Should-fix | A malformed request (no `args`) throws outside the command's catch and poisons the queue. | Fixed: request validated (400), and the queue catches every failure. |
| 4 | Should-fix | A missing target counts as arrival (`walk mission` in Portus; an NPC dropping out of the nearest 40). | Fixed: an unavailable goal is refused up front; losing a target reports "lost sight of", never "arrived". |
| 5 | Should-fix | `dodge` says pass when the server snapped the roll back. | Fixed: a correction is a FAIL, as in J5.3. |
| 6 | Should-fix | `blink` can pass with no picture samples. | Fixed: ≤ 50 samples or probe errors is "inconclusive", as `expectNoBlinking` requires. |
