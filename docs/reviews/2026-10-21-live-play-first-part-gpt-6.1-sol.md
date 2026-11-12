# Live play: the first-part kit — lane/live-play, review round 4 (Codex gpt-6.1-sol)

Scope: the uncommitted diff on top of `aedbf4c6` (`apps/client/e2e/live/session.ts`, new `film.ts` and
`first-part.md`, `player.ts`, the test hook `src/debug/e2eHook.ts`, the README). Source-only review,
reasoning effort high, Standard tier. Context: the owner asked for a model to play the first part
(tutorial → Arcadia → Lark's three missions) live, filmed, with frame times measured.

| # | Severity | Finding | Decision |
|---|---|---|---|
| 1 | blocker | `rise` reached production: rebirth sends `respawn`, which replaces and saves the character. | Fixed: `rise` is local only, like `attack`, `fight`, `dev`, `save` and the first-part macros. |
| 2 | should-fix | A missing ffmpeg emits an unhandled child `error`; the film starts outside the session's cleanup. | Fixed: `Film.start` waits for `spawn`/`error` and settles on `close` or `error`; the session catches a failed start and plays on without a film. |
| 3 | should-fix | `stdin.write` ignores backpressure: an unbounded queue, and `stop()` can wait forever. | Fixed: past 256 MB queued the film ends there (still on the clock; every 40 ms slot needs a picture, so dropping frames isn't an option); `stop()` waits 5 min, then SIGINT (ffmpeg still writes the file), then SIGKILL; the reason shows on the `[live] video:` line. |
| 4 | should-fix | Skipping caption segments under 20 ms drops their time: later captions drift early. | Fixed: short segments are filtered first and durations come from the next kept segment's start, so every caption keeps its place on the film's clock. |
| 5 | should-fix | `thirsty` ignored the tonic cooldown: below 45% HP with a tonic cooling down, `quest` spun without moving. | Fixed: `thirsty` requires `tonicReady`. |
| 6 | should-fix | H1 has no `hunt.place`: `placeDir(undefined)` threw and the catch emptied all of Hollowmere's missions. | Fixed: each mission's spot is worked out on its own; one without a place just has no position. |
| 7 | should-fix | Deaths were counted from answer text (overcounts repeated dead answers, misses a death before an idle shutdown); the end report had no final state. | Fixed: deaths count alive → dead between answers and once more at shutdown, from a last snapshot that also feeds report.txt. |
| 8 | should-fix | `openHeading(25)` scanned walls only to 12 m, and fell back to 180° when nothing was clear. | Fixed: it scans the full run and refuses with a plain error (`walk pad`, then `step`) when no heading is clear. |
| 9 | nit | README said every quest fights nearby creatures first. | Fixed: the README describes hunts and errands separately. |

Verdict from the reviewer: request changes. All nine are addressed above; typecheck is clean. The fixes
are not yet re-reviewed or exercised by a full live run (the evening race was cut short by a machine
reboot; the owner moved testing to 3 am).
