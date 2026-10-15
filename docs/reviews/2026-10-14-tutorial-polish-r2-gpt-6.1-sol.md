# Tutorial HUD review, round 2

Verdict: **request changes before merge**. One P2 remains: the Attack row is still clipped on a normal 1280×720 transition. There is also a P3 right-edge clipping nit at 600 px. The arrow fixes, Voice row, portal-timeout wording, panel avoidance, projection guard, and cache corrections pass. The walked portal outcome uses the correct plain text in the model/DOM, but its screenshot captured the travel loader, so visible end-card verification is incomplete.

Reviewed HEAD `f7023b8f3759b0226d89c0951b669f4a7372742d`, first with `git diff 0dd4446..f7023b8`, then the complete `git diff main...lane/tutorial-polish`. Main and merge-base remain `862cffc5c6ee4205eca7e9937840e377e815d418`. Review date: 2026-10-14, America/Chicago. Report only. No application code edited, no commit, no deployment.

## Findings

### P2: Reveal still precedes the progress text's final layout

`apps/client/src/ui/onboarding.ts:150` calls `revealCurrent()` after `buildCard()`, but before the new progress text is inserted at line 156. The empty progress row is shorter. Filling it grows the card, shrinks the checklist, and clips the current row again without another reveal.

A fresh guest at 1280×720, checklist expanded before the early steps, reproduced this on the actual Dodge → Attack transition. The highlighted Attack row occupies y=524.28125…556.9375; the list ends at y=552. Its lower 4.9375 px are clipped. Native pointer lock was true. This capture was made before resizing or toggling the checklist. The 1600×900 transition passes because the row has more room. Resizing the small viewport also repairs the row, which is why the earlier resize-only capture passed.

An isolated real-HUD reproduction confirms the cause:

| Phase | Card height | Bar text | List scrollTop | Attack row bottom |
|---|---:|---|---:|---:|
| Before reveal | 175.4375 | empty | 0 | 554.8125 |
| After reveal | 175.4375 | empty | 5 | 549.8125 |
| Render complete | 182.5625 | `0 / 3` | 5 | 556.9375 |
| Diagnostic reveal after render | 182.5625 | `0 / 3` | 12 | 549.9375 |

Move the reveal after progress-bar text/fill updates, or initialize that text before measuring. Recheck an uninterrupted Dodge → Attack transition at 1280×720 without an intervening resize or checklist toggle.

Evidence: `resumed/run-2/1280-attack-transition.png` and matching JSON; `resumed/run-2/1280-hud-attack-transition-repro.png`; `resumed/run-2/row-height-transition.json`.

### P3: The 600 px label clears the panel but extends beyond the viewport

`apps/client/src/ui/calloutPlace.ts:71` returns the right-hand label when neither side fits. This fixes the prior panel overlap, but supplies no wrapping or vertical fallback.

In the same 600×720 real-HUD reproduction as round 1, the panel ends at x=301, the arrow is x=325, and the label spans x=341…611.9375. The box's right border/padding is clipped by 11.9375 px. The main instruction remains readable, so this is a nit rather than a merge blocker. Constrain/wrap the label to available space or choose a placement above/below the panel when both horizontal placements fail.

Evidence: `resumed/run-1/600-label-beside-panel.png`, `resumed/run-1/supplement.json`.

## Browser results

Artifact root: `~/Documents/Codex/2026-10-14/tutorial-polish/round2/`. Paths below are relative to it. `resumed/run-1` and `resumed/run-2` contain the authoritative checks from this restart.

| Check | Result | Screenshot / evidence |
|---|---|---|
| Near-behind arrows, 1600×900 | PASS. Projection `[0.019085,-0.002217,1.083016]`; outward angle `-3.076rad` | `resumed/run-1/1600-near-behind-confirmed.png` and JSON |
| Near-behind arrows, 1280×720 | PASS. Projection `[0.019062,0.004294,1.083022]`; outward angle `3.016rad` | `resumed/run-1/1280-near-behind-confirmed.png` and JSON |
| Broader behind-camera arrows, both sizes | PASS. Both actual projections have z>1 and arrows follow the corrected outward ray | `resumed/run-1/1600-verified-dummies-behind.png`, `resumed/run-1/1280-verified-dummies-behind.png`, matching JSON |
| Attack row after live card transition, 1600×900 | PASS. Row bottom 611.5, list bottom 717 | `resumed/run-1/1600-attack-transition.png` and JSON |
| Attack row after live card transition, 1280×720 | **FAIL, P2**. Row bottom 556.9375, list bottom 552 | `resumed/run-2/1280-attack-transition.png` and JSON |
| Voice row after live card transition, 1600×900 | PASS. Row bottom 714.5, list bottom 717 | `resumed/run-1/1600-voice-row.png` and JSON |
| Voice row after live card transition, 1280×720 | PASS. Row bottom 550.390625, list bottom 552 | `resumed/run-2/15-voice-heading.png` and JSON |
| Voice row on resize | PASS at both sizes and when returning to 1600 | `resumed/run-1/1280-voice-row.png`, `resumed/run-1/1600-voice-row-resize.png`, matching JSON |
| Natural portal timeout, 1600×900 | PASS. Still in Portus, `done:true,moved:true`; visible end card has the Arcadia instruction | `resumed/run-1/1600-portal-timeout-end-card.png`, `portal-timeout-outcome.json` |
| Actual portal entry, 1280×720 | PASS for travel/model/DOM wording; **FAIL TO VERIFY visible end card**. Reached Arcadia with `done:true,moved:false`; plain line is in the DOM. Screenshot shows the opaque travel loader | `resumed/run-2/21-portal-entry-result.png`, `entry-model.json`, `evidence.json` |
| 600 px label beside panel | PASS for prior overlap finding; P3 viewport clipping remains | `resumed/run-1/600-label-beside-panel.png`, `supplement.json` |
| Arcadia beside panel, 1600×900 | PASS. Target projects under panel at x≈199.5; arrow x=352 points left; label starts x=368, clear of panel right=327.875 | `resumed/run-1/1600-arcadia-beside-panel.png` and JSON |
| Arcadia beside panel, 1280×720 | PASS | `resumed/run-2/17-portal-behind-panel.png` and JSON |
| On-screen label near right edge, 1600×900 HUD fixture | PASS. Flips left; box right=1545, within viewport | `resumed/run-1/1600-onscreen-label-right-edge.png`, `supplement.json` |

The exact dead-behind helper case now returns a down arrow at `π/2`; mirrored near-behind helper cases point left/right correctly. The non-finite camera-plane case returns finite coordinates and angle. These are helper checks, not claims that live input sampled the exact camera plane. See `resumed/run-1/supplement.json`.

The hidden-first-layout cache now remains null after a 0×0 measurement, then caches the actual 178×50 size when visible. Sixty identical calls cause zero panel rectangle reads; resize invalidation causes one new read and a fresh label measurement. Both round-1 cache notes are addressed.

## Final-step judgment

Using the end card to carry the portal outcome is a reasonable answer to the original finding. The checklist is replaced and normally collapsed, so a fleeting final dash/tick would not improve feedback. The natural timeout now visibly says, "When you're ready, walk into the Arcadia portal on the plaza (levels 1–7)." It does not imply the player has travelled.

The walked run reached Arcadia and selected "The portals around the plaza lead to the three planets." with `moved:false`. That verifies the intended branch in the live code. It does **not** establish that the player could see this card after travel: the saved screenshot is the loading overlay. I stopped the test Chrome before inspecting that image, so I cannot close the visual check. No replacement screenshot was fabricated or inferred from DOM text. This is a review limitation, not a newly confirmed application defect. The builder should repeat that visible check before sign-off.

## Validation

Carried forward the two interrupted attempts' confirmed results at this exact HEAD, also recorded in `round2/validation.json`:

- `pnpm typecheck`: PASS for shared, server, and client.
- `pnpm --filter @firstlight/client exec vitest run src/game src/ui`: PASS, 22 files, 144 tests.

I did not rerun these tests. Both requested diff ranges pass `git diff --check`. The full branch review found no further issues beyond the P2 and P3 above. Server authority and payout logic are unchanged. Each authoritative guest run received nine server-confirmed training hits and the Spark/50 XP payout through real attacks; see each run's `dummy-results.json`.

## Browser method and limitations

The stack at `http://127.0.0.1:5631` was verified as Vite PID 78487 with cwd in this worktree's `apps/client`. It was left running.

Before loading the game, I verified the launched Chrome process command line with `ps`: **both `--headless=new` and `--mute-audio` were present**. The authoritative browser was PID 16671 with fresh profile `/tmp/fl-village-headless/profile-zLkBeo`. Evidence: `resumed/flags-verified-before-navigation.json`, `resumed/launch.json`. Flags also included `--enable-gpu`, `--enable-unsafe-webgpu`, `--ignore-gpu-blocklist`, `--use-angle=metal`, `--disable-background-timer-throttling`, `--disable-renderer-backgrounding`, and `--disable-backgrounding-occluded-windows`.

SystemInfo reports ANGLE Metal on Apple M1. The adapter reports vendor `apple`, architecture `metal-3`; the live renderer is `WebGPURenderer`. Viewports used DPR 1. All authoritative gameplay and HUD checks used this one browser process, navigating/opening tabs and fresh guest contexts, with device-metrics resizing. No owner Chrome, computer use, or speaker-based audio test was used. Audio stayed muted by the process flag.

Gameplay used CDP keyboard and mouse input. The documented input-lock allowance was used; native pointer lock was also true in authoritative arrow, row, and Arcadia captures. No teleport, direct training message, inventory mutation, camera-vector assignment, or progress-completion call was used in gameplay. Supplemental checks construct separate real HUD/step fixtures in gallery tabs; the row diagnostic re-reveal changes only its disposable fixture.

There were two harness deviations worth retaining:

- An initial launch, PID 15765, also verified both required flags, navigated, then immediately shut down when terminal stdin closed. No gameplay checks ran there. Its evidence is under `bootstrap-stdin-abort/`. This means the restart had an extra bootstrap launch, contrary to the requested single-launch rule. The complete authoritative run used PID 16671 throughout.
- An initial `Browser.setWindowBounds` attempt released pointer lock. Those stale arrow captures and the disrupted navigation are excluded under `resumed/excluded-unlocked/`. The checks were repeated in fresh guest tabs in the same Chrome, using device metrics. Startup clicks before listener readiness and two invalid evaluation expressions were harness failures, not product findings.

The authoritative walked screenshot's loading-overlay limitation is described above. The saved `run-2/console.json` has no warnings, errors, or page exceptions; it includes the normal graphics auto-tier reduction. Run 1's saved page console covers its startup only, not the full run. Chrome stderr and the harness/evidence files are retained.

Only the test Chrome process group was stopped at the end. `resumed/cleanup.json` records PID 16671's cleanup, and both launched PIDs were absent on the final process check. No existing browser or development-server process was stopped. Only this review report is added in the worktree, uncommitted.
