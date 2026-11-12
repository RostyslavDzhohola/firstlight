# The orrery menu example (lane/menu-orrery) — review round 1 (Codex gpt-6.1-sol)

Scope: commit `fcecc5c3` (D-menu-1). Static review with in-memory probes, reasoning effort medium,
Standard tier. No blockers. Found sound: every player name goes through `textContent`; the classic
page's `display: none` takes its controls out of the tab order.

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | should-fix | `shown` started `true`: a home import that finished after an immediate Play missed the hide, leaving the frame loop and the key handler alive in play. | It starts from the landing's real state. |
| 2 | should-fix | The delayed `reset()` after a dive survived a failed load and could cancel the next dive. | One timer, cleared on reset, show/hide, a new dive and dispose. |
| 3 | should-fix | `pointercancel` ran the release handler (a cancelled short gesture could pick a world or start Play); no blur or lost-capture cleanup. | Cancel, lost capture and window blur end the drag without picking; the active pointer id is tracked. |
| 4 | should-fix | Click suppression measured horizontal movement only: a long vertical drag over the front world started Play. | Movement is the distance from pointer-down in both directions. Checked in a browser. |
| 5 | should-fix | Off-screen and covered tags were only transparent: invisible tab stops, read by screen readers. | They are `hidden`; the front world's tag carries `aria-pressed`. |
| 6 | should-fix | Each plate update rebuilt the action button: a count update could drop keyboard focus. | Both forms of the action are built once and switched; focus follows a switch. |
| 7 | should-fix | The WebGL context and buffer stayed alive under the game's own renderer. | The context is released when the landing leaves the page and restored if it comes back. Release checked in a browser; the restore path is not exercised. |
| 8 | should-fix | No `webglcontextlost` handling: a lost context left an empty sky over the hidden classic page. | Loss shows the classic page; restoration rebuilds the sky. Not exercised in a browser. |
| 9 | should-fix | A DPR cap alone doesn't bound the shader's cost (a 4K window is 8–19 million pixels). | A pixel budget of 3.7 million (about 2560 × 1440) scales the drawing buffer down. Unit-tested; weak GPUs still unmeasured. |
| 10 | should-fix | A failed sign-out explained itself only on the hidden classic page. | The account corner shows the error in a status line. |
| 11 | nit | "The nearer world wins" was claimed without overlapping discs. | A test lines two worlds up on one bearing and asserts the nearer is picked. |
