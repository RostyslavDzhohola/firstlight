# Tutorial HUD polish review

Verdict: **request changes before merge**. Four P2 findings remain, plus a P3 projection-boundary defect. The heading fix, normal left/right arrows, panel avoidance at the two requested sizes, Voice timeout dash, and sprint flooring work. Typecheck and all 141 requested tests pass.

Reviewed `git diff main...lane/tutorial-polish`, HEAD `0dd44468603d1cb6e6c7d220137d6a379838b6e2`, main and merge-base `862cffc5c6ee4205eca7e9937840e377e815d418`. Date: 2026-10-14. Report only. No application code changed, no commits, no deployment.

## Findings

### P2: Near-straight-behind arrows point back into the screen

`apps/client/src/ui/calloutPlace.ts:50` extends the projected direction by a fixed factor of four, then points from the edge pin toward that synthetic target. Near straight behind, this target remains inside the edge rectangle. The arrow reverses even though its pin is on the correct edge.

The actual helper, at 1600×900 with no panel, returns a left pin at x=28 pointing right for `{x:0.01,y:0,z:1.2}`. The mirrored input pins right and points left. `{x:0,y:0,z:1.2}` pins at the bottom and points up, contrary to the intended down fallback. Live CDP mouse turns reproduced the inward diagonal at both sizes. At 1280×720 the projection was `[0.02284,-0.01668,1.04909]`, and the arrow beside the panel pointed down-right at `0.725rad`, rather than outward toward the corrected upper-left direction.

Fix the direction calculation using the outward ray or an extension guaranteed to lie beyond the pin. Preserve the direction correction when avoiding the panel. Add angle assertions for near-behind and dead-behind inputs; the existing behind test checks only the pin's side.

Evidence: [1280 live](<~/Documents/Codex/2026-10-14/tutorial-polish/1280-entry/11-dummies-near-straight-behind.png>), [1600 live](<~/Documents/Codex/2026-10-14/tutorial-polish/1600-final/11-dummies-near-straight-behind.png>), corresponding JSON, and `1280-entry/supplement.json`.

### P2: Portal completion never renders its dash or tick

The new row selection in `apps/client/src/ui/onboarding.ts:126` never executes for the final portal completion. `apps/client/src/game/OnboardingClient.ts:225` calls `showDone()` and returns before `hud.render()` at line 231; `showDone()` hides the checklist at `apps/client/src/ui/onboarding.ts:245`.

In the walked run, the model changed to `done:true,moved:false`, the player arrived in Arcadia, and the DOM row remained `fl-onb__st is-now` with `listHidden:true`. No final tick was displayed. The 45-second timeout run stayed in Portus and produced `done:true,moved:true`, with the same hidden `is-now` row and no dash. The end-card ordering predates this patch, but it prevents the patch's requested final-row feedback from working. The Voice timeout does receive the new dash because another step follows it.

Render the completed state before the end card, and make the final outcome observable in the checklist or completion card. Merely rendering and immediately hiding the row would still fail the requested visible dash/tick check. Keep the deliberate timeout and server payout behavior.

Evidence: [walked completion](<~/Documents/Codex/2026-10-14/tutorial-polish/1280-entry/21-portal-entry-result.png>), `1280-entry/entry-model.json`. The 1600×900 timeout evidence is recorded in `1600-final/timeout-observed.json` and `20-portal-timeout-observed.png`.

### P2: The current checklist row is scrolled using the previous card's height

`apps/client/src/ui/onboarding.ts:131` calls `revealCurrent()` before replacing the card at line 141. A taller replacement card then reduces the list's available height. The current row becomes clipped again and no further scroll occurs until a state change or checklist toggle.

At 1280×720, the live Voice row occupied y=537.73…570.39 while the list ended at y=552. The heading was whole, but most of the highlighted Voice row was below the clipped list. The live dummy row was also clipped by about 10 px. The 1600×900 Voice capture likewise shows the active row below the list edge. Gallery initialization passed because its initial details toggle triggers a later reveal; it does not prove live step transitions are correct.

Build the new card first, then reveal the current row after the final layout is available. Recheck the row on resize as well as panel toggles.

Evidence: [1280 Voice](<~/Documents/Codex/2026-10-14/tutorial-polish/1280-entry/15-voice-heading.png>), [1600 Voice](<~/Documents/Codex/2026-10-14/tutorial-polish/1600-final/15-voice-heading.png>), and their measured JSON.

### P2: On tiny screens, moving beside the panel flips the label back over it

`apps/client/src/ui/calloutPlace.ts:37` moves the pin to `avoid.right + 24`, then `pointer()` at line 54 flips the label whenever that pin exceeds half the viewport width. On a narrow screen this places the label on the panel side.

A real HUD at 600×720 had panel x=21…301. The relocated pin was x=325, but `.is-flip` put the dummy label at x=38.06…309, overlapping almost the full panel. This was a supplemental HUD reproduction, not a 600 px gameplay run.

Choose the label side using its full rectangle and available space. Fall back above or below the panel when neither side fits.

Evidence: [600 px HUD overlap](<~/Documents/Codex/2026-10-14/tutorial-polish/1280-entry/supplement-600-panel-overlap.png>), `1280-entry/supplement.json`.

### P3: A point exactly on the camera plane produces NaN placement

`apps/client/src/ui/calloutPlace.ts:44` does not guard non-finite projections. An exact side-on projection can contain Infinity and NaN; multiplication by a zero edge scale then returns NaN coordinates and angle. The actual helper reproduced this boundary in the supplemental check. JSON serializes those non-finite results as null. This is a deterministic helper-level reproduction, not a claim that normal mouse sampling hit the exact plane.

Guard non-finite projections, or retain a finite camera-space direction for edge placement.

## Browser results

Artifact root: `~/Documents/Codex/2026-10-14/tutorial-polish/`. Screenshot paths below are relative to that root.

| Check | 1600×900 | 1280×720 | Evidence |
|---|---|---|---|
| Fresh guest through tutorial | PASS, server accepted all nine dummy hits and paid Spark/50 XP; final Portal allowed to time out | PASS, all tutorial actions, server payout, then walked into Arcadia | `1600-final/dummy-results.json`, `1280-entry/dummy-results.json`, `1280-entry/21-portal-entry-result.png` |
| Voice heading whole, checklist expanded | PASS | PASS | `1600-final/15-voice-heading.png`, `1280-entry/15-voice-heading.png` |
| Portal heading whole, checklist expanded | PASS | PASS | `1600-final/16-portal-heading-voice-dash.png`, `1280-entry/16-portal-heading-voice-dash.png` |
| Dummies off screen left | PASS | PASS | `1600-timeout/08-dummies-off-left.png`, `1280-entry/08-dummies-off-left.png` |
| Dummies off screen right | PASS | PASS | `1600-final/12-dummies-off-right-confirmed.png`, `1280-entry/12-dummies-off-right-confirmed.png` |
| Dummies behind, correct edge-arrow direction | FAIL near straight behind | FAIL near straight behind | Both final run folders: `11-dummies-near-straight-behind.png` |
| Arcadia projected behind panel, label moved beside it and arrow points back | PASS | PASS | Both final run folders: `17-portal-behind-panel.png` |
| Collapse/re-expand checklist updates placement | PASS | PASS | Both final run folders: `18-portal-collapsed.png`, `19-portal-expanded.png` |
| Voice timeout shows dash, no tick | PASS | PASS | Both final run folders: `16-portal-heading-voice-dash.png`, corresponding row class `is-moved is-opt` |
| Portal timeout shows dash, no tick | FAIL, final row hidden without rendering completion | Not repeated; walked variant used here | `1600-final/20-portal-timeout-observed.png`, `timeout-observed.json` |
| Actual portal entry shows tick | Not repeated; timeout variant used here | FAIL for row feedback; travel itself PASS | `1280-entry/21-portal-entry-result.png`, `entry-model.json` |
| Sprint counter | PASS, 244 samples, highest incomplete value 1.9867, highest text `1.9 / 2 s` | PASS, sprint completed through real input; exact rounding boundary covered by sampled large run and unit test | `1600-final/sprint-samples.json`, both final run folders' `04-sprint-start.png` and completion captures |
| Current row fully visible after taller card | FAIL on Voice | FAIL on Voice and Attack | `15-voice-heading.png` and JSON in both final folders; `1280-entry/07-dummies-front.png` |
| Gallery screens | PASS | PASS | `1600-timeout/gallery-{1600,1280}-{onboarding,onboarding-attack,onboarding-loot,onboarding-portal,onboarding-done,kit-onboarding}.png`, `gallery.json` |

## Code and layout checks

- Compact selectors have greater specificity than their `kit.css` counterparts. The card and rail do not shrink, and only the checklist scrolls. `.is-moved` and `.is-done` are exclusive, so tick styling does not leak into the dash.
- Both changed gallery call sites use the projected-point API correctly. All six onboarding/gallery variants rendered at both requested sizes, including the end card and static kit example.
- Stable placement caches avoid layout reads. Instrumenting the actual widget recorded zero `getBoundingClientRect()` calls across 60 identical `setCallout()` calls, and one after resize invalidation. Position/style updates are gated by the rounded placement key.
- Resize invalidates only the panel cache, not `boxSize`. A hidden first layout cached the 160×48 fallback permanently until text changed; after showing the actual label it was 178×50, while the cache stayed 160×48. The panel recovered on the next visible call. Invalidate/retry the label measurement on resize and after a zero-size measurement. This is a verified cache-contract gap; no separate visible failure was established for the normal left-panel geometry.
- Existing limitation retained: a target may pass the 0.95 on-screen test while its label extends beyond the right edge. The first 1600 run measured a box ending at x=1802.92 on a 1600 px viewport. See `1600-timeout/09-dummies-off-right.json`. The target itself was still on screen, so that image is not used as the off-screen-right arrow result.
- Automatic tutorial start, deliberate 45-second wrap-up, and early portal departure were not raised as defects.

## Validation and method

`pnpm typecheck`: PASS, shared/server/client TypeScript checks completed.

`pnpm --filter @firstlight/client exec vitest run src/game src/ui`: PASS, 22 files and 141 tests, 3.83 s. Includes the added five placement tests and sprint/moved-on coverage. No application files were edited to test these cases.

Browser used the existing tutorial-live CDP harness, copied/adapted under the artifact root's `harness/`. Local URL `http://127.0.0.1:5631`; the listening Vite process's cwd was verified as this worktree's `apps/client`. Every Chrome process had a fresh temporary profile, `--headless=new`, `--enable-gpu`, `--use-angle=metal`, DPR 1, and exact emulated viewport dimensions. SystemInfo reports Apple M1 through ANGLE Metal; the live game reports WebGPU. The large run's GPU adapter reports `apple`, `metal-3`, `isFallbackAdapter:false`, saved in `1600-final/adapter.json`. No desktop Chrome session, computer use, teleports, progress-completion calls, direct training messages, inventory mutation, or camera-vector assignments were used. Gameplay used CDP keyboard/mouse events. Read-only inspection supplied positions for input-driven navigation. The documented input-lock allowance was used; native pointer lock was also true in authoritative live captures.

`1280-entry` is the complete ordered small run. `1600-final` is the completed large run with the timeout variant; its early repeated setup left the checklist collapsed during some early captures, and it was expanded before Voice/Portal. Expanded dummy-left evidence comes from the first large run. `1600-timeout` is an excluded navigation attempt after a gallery tab released pointer lock; only its verified earlier arrow capture and separate gallery results are cited. Its incorrectly named Voice/Portal captures were still on Attack and are excluded. The large retry initially hit a display-name 409, then completed after a new throwaway name and a readiness wait. That setup timeout and premature inspection errors are harness errors, not game defects. The small run captured no page console errors/warnings/exceptions. Raw console, network and native Chrome stderr logs are retained per run.

The large retry's observer retained its earlier helper instance and could overwrite the generic input/evidence filenames. Use `1600-final/gameplay-inputs.json` and `gameplay-evidence.json` for that run's authoritative final gameplay records; per-capture geometry JSON is independent of those helpers.

Only this review report is added in the worktree, uncommitted. All test Chrome process groups are stopped after evidence capture. The owner's development stack is left running.
