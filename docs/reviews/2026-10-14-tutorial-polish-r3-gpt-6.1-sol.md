# Tutorial HUD review, round 3

Verdict: **approve a41e89c for merge**. No new P1, P2, or P3 findings. Both round-2 findings are resolved. The end card is visibly present after the walked Arcadia arrival in this run.

Reviewed `git diff f7023b8..a41e89c`, with HEAD `a41e89c3c79b65f8eaef4c2683d76c8902c7531f`. Date: 2026-10-14, America/Chicago. Report only; no application code edits, commits, or deployment.

Artifact root: `~/Documents/Codex/2026-10-14/tutorial-polish/round3/`. Screenshot and JSON paths below are relative to that directory. A copy of this report is saved there as `REPORT.md`.

## Findings and observer review

No actionable findings in either the standards or spec review.

- `apps/client/src/ui/onboarding.ts:166-167` reveals after progress text is inserted. The isolated Dodge-to-Attack reproduction now ends render with `0 / 3`, card height 182.5625 px, scrollTop 12, and the entire Attack row visible. It requires no subsequent observer repair.
- `apps/client/src/ui/onboarding.ts:50-53,81-82` uses one ResizeObserver for the widget and checklist. Observing both is necessary because the checklist can shrink while the widget stays at max-height. The callback invalidates the panel rectangle and adjusts only checklist scrollTop. It does not change either observed element's dimensions, so there is no direct resize feedback loop. Work is bounded to size changes: a search of 12 rows, layout reads, and at most one scroll write. The next callout update re-measures the invalidated panel.
- `apps/client/src/ui/onboarding.ts:281` disconnects both observations before removing the HUD. The real-HUD fixture recorded zero extra reveal calls during one second after settling, zero during one second after a later panel shrink settled, and zero after disposal even when the disconnected root was reattached and resized. No ResizeObserver exceptions appeared. See `observer.json`.
- `apps/client/src/ui/onboarding.css:46-47` constrains the narrow label and preserves intrinsic widths when space permits. The placement cache still predates position-dependent wrapping, but no failure was reproduced in the requested placements; this is not a finding.

## Browser checks

| Check | Result | Screenshot / evidence |
|---|---|---|
| Attack, expanded, 1280×720 | PASS. Row y=517.28125–549.9375, list bottom=552; before any viewport resize or checklist retoggle after Attack arrived | `1280-attack-transition-verified.png`, matching JSON |
| Attack, expanded, 1600×900 | PASS. Fresh guest's uninterrupted Dodge-to-Attack transition; row y=575.9375–611.5, list bottom=717 | `run-1600/1600-attack-transition.png`, matching JSON; `run-1600/1600-dodge-before-transition.png` |
| Voice, expanded, 1280×720 | PASS. Row y=517.734375–550.390625, list bottom=552 | `1280-voice-row.png`, matching JSON |
| Voice, expanded, 1600×900 | PASS. Row y=578.9375–614.5, list bottom=717 | `1600-voice-row.png`, matching JSON |
| 600 px label inside viewport and clear of panel | PASS in a separate real-HUD fixture. Panel right=301; label x=341–576, 40 px panel gap and 24 px viewport margin. Title stays on one line; supporting sentence wraps to two | `600-label-beside-panel.png`, `labels.json` |
| Dummies label, 1600×900 | PASS. Title and supporting sentence each occupy one line in the live game and fixture | `run-1600/1600-attack-transition.png`, `run-1600/1600-dummies-label-live.json`; `1600-dummies-label-fixture.png`, `labels.json` |
| Arcadia label, 1600×900 | PASS. Title and supporting sentence each occupy one line; live label x=368–520.265625 clears panel right=327.875 | `1600-arcadia-label-live.png`, matching JSON; `1600-arcadia-label-fixture.png`, `labels.json` |
| Walked portal end card after Arcadia loads | PASS. Arcadia loaded, opaque loader hidden, completion card topmost and readable in both arrival screenshots | `portal-travel-loader.png`, `arcadia-loaded-first.png`, `arcadia-loaded-plus-2s.png`, `portal-visibility.json` |

The 1280 guest completed Dodge before Sprint because the step machine accepts inputs ahead of the displayed step. Its first incorrectly named Attack capture was still Sprint and is excluded under `excluded-sprint/`. The final 1280 live capture is genuinely Attack; `observer.json` additionally reproduces the exact Dodge-to-Attack ordering at that size. The 1600 guest uses the normal displayed step order.

## Existing end-card behavior

Walking into the portal finishes the tutorial with `done:true, moved:false` and the plain line, "The portals around the plaza lead to the three planets." The card exists under the opaque loader during travel. It becomes visible once Arcadia loads, then disappears at the original eight-second deadline.

The sampled completion deadline was performance.now()=141230.1 ms. Travel/loading began around 133251.4 ms; the loader was hidden and the card topmost at 136926 ms. That leaves about **4.30 seconds visible after arrival**. Both inspected Arcadia screenshots show it clearly. I do not consider the observed behavior a problem or a merge blocker.

There is an existing timing limitation: `apps/client/src/game/onboardingClient.ts:226-227,259-265` starts and retains a wall-clock deadline before travel. An arrival longer than eight seconds can consume the entire card lifetime. This run did not reproduce that outcome, so it does not prove the card appears after every slow arrival. If an eight-second readable window after arrival is required, start the dismissal timer at handover. This is outside a41e89c's fixes.

## Validation and browser method

- `pnpm typecheck`: PASS for shared, server, and client.
- `pnpm --filter @firstlight/client exec vitest run src/game src/ui`: PASS, 22 files, 144 tests, 2.05 s.
- `git diff --check f7023b8..a41e89c`: PASS.
- Saved execution summary: `validation.json`.

One Chrome browser process was used throughout, PID 39493, with fresh profile `/tmp/fl-village-headless/profile-2scZG2`. Before game navigation, its actual `ps` command line was checked for **both `--headless=new` and `--mute-audio`**. Evidence: `flags-verified-before-navigation.json`, `launch.json`. GPU flags included `--enable-gpu`, `--enable-unsafe-webgpu`, `--ignore-gpu-blocklist`, and `--use-angle=metal`. SystemInfo reports ANGLE Metal on Apple M1; the live console reports `[gfx] backend WebGPU, tier medium (auto), gpu ""`. DPR was 1.

All gameplay used CDP keyboard and mouse input. Native pointer lock was true in the row captures. No live progress completion calls, input-lock overrides, teleport, direct training messages, or camera assignment were used. The 600 px check and observer diagnostic were separate disposable real-HUD fixtures in tabs of the same browser, not claims of a 600 px gameplay run. The live guest received nine server-confirmed training hits and the Spark/50 XP completion payout; see `dummy-results.json`.

Primary gameplay console and page exceptions were captured throughout; the 1600 guest has `run-1600/console.json`. No warning, error, or page exception appeared. A fresh 1600 tab's first PLAY click ran before its listener was ready, so the starter wait timed out; I recovered the same tab through CDP and completed the check without another browser launch. This was a harness timing failure, not an application finding. Scripts are retained under `harness/`.

Only the launched Chrome process group was stopped. `cleanup.json` and `final-verification.json` record cleanup; PID 39493 is absent and the stack still responds at `http://127.0.0.1:5631`. The report remains uncommitted.
