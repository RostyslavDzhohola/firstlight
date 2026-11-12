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

## Round 2 (on 7113a46d + b9614c95)

Verdict: request changes. Round 1's items 2, 3, 5 and 6 confirmed fixed; 1 and 4 incomplete.

| # | Severity | Finding | Builder's decision |
|---|---|---|---|
| 1 | Blocker | `fight`'s PvP guard is narrower than the weapons: Riverstaff sweeps ±75°, chains/splash/piercing reach past the foe. | Fixed: `playerInHarmsWay` holds fire for any player in the front half within the weapon's reach + 3 m, or within 10 m of the foe; `fight` attacks only after a successful aim and a fresh check. |
| 2 | Should-fix | A dummy that disappears still counts as arrival (`?? 0`). | Fixed: only a standing dummy can be arrived at. |
| 3 | Should-fix | `esc` says "nothing changed" from the one-line status alone (Esc can drop a held inventory item). | Fixed: it says the one-line status is unchanged. |
| 4 | Nit | A JSON `null` body gives 500, not 400. | Fixed: only a non-array object is read. |

## Round 3 (on 78282fc6)

Verdict: request changes. Round 2's items 2–4 confirmed fixed.

| # | Severity | Finding | Builder's decision |
|---|---|---|---|
| 1 | Blocker | Projectiles travel range × 1.2 (combat.ts), past the guard's range + 3 m. | Fixed by scope, not by a bigger envelope: `attack` and `fight` are refused on production (read-only like `pnpm e2e:prod`, whose smoke never attacks). Locally the only other players are other test sessions; the guard stays as a courtesy and says it isn't a full damage model. |
| 2 | Blocker | Stormcoil's chain jumps reach past the 10 m radius. | Same decision as 1. |
| 3 | Should-fix | `Player.aim` returns true after exhausted retries; `fight` trusted it. | Fixed in `fight`: a shot needs the crosshair within Player.aim's tolerances on a fresh snapshot; a melee swing needs the foe within 20° (a strict crosshair made Brother Ash never swing). `Player.aim` itself is unchanged (the journeys rely on it). Verified live: Hexwick and Brother Ash both kill. |
