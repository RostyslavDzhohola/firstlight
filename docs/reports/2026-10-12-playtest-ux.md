# Chrome play-test UX fixes

Worktree: `fl-wt-ux`. Branch: `lane/playtest-ux`. Base: `c9ddf29`.
Implemented locally on October 12, 2026 from `/tmp/fl-chrome-test/REPORT.md`.
Browser verification is pending the owner's visual check. No push, deployment, merge, browser,
computer use, or external service access was performed. The vegetation lane's three files are untouched.

## Commits

- `edc38f3`: Map labels with collision avoidance and edge protection.
- `8b9d0b0`: Per-account tutorial persistence, compact HUD, and loot-tip wording.
- `afd1e3d`: Responsive pause menu and boss invitation copy.
- `9d53986`: Landing-pad hostile clearance and smaller Dawnpad pack.
- `500d4cc`: Seed the tutorial from fresh room state when the initial message arrived before its listener.

Each implementation commit carries `Co-Authored-By: Codex gpt-6.1-sol <noreply@openai.com>`.

## Per-item status

1. **Implemented, visual check pending.** Map labels share one placement pass on every body.
   Portals and pads take priority over shops, NPC/party names and boss names, then landmarks.
   Labels stack or flip sides, avoid other labels and markers, and get leader lines to their markers.
   Lower-priority labels hide when no nearby space is available. The Portus cluster has a regression test.
2. **Implemented, visual check pending.** Label rectangles clamp inside the canvas with a margin.
   Terrain still clips to the globe, but the canvas no longer has a circular CSS crop that cuts off
   names near Meridian's rim. Edge, overcrowding and marker-clearance regression tests pass.
3. **Implemented, visual check pending.** How to play uses flexible columns and wrapping rows.
   It scrolls internally when too tall, and can take keyboard focus for scrolling. The left menu's
   rows scroll independently so footer shortcuts stay inside the viewport. Short windows get smaller
   outer spacing.
4. **Implemented, pure-module tests pass.** Completed client steps save as
   `fl.onboarding.v1:<encoded-user-id>` using the local player's account id from room state.
   A fresh Portus client restores them after reload or travel. No token is stored. Dummy completion
   is excluded and continues to use server hits. A server done/skipped response or a current Portus
   `you` state without onboarding clears saved tips and stops later writes. Old body HUD state cannot
   clear the current account's progress. Partial distances/timers are not saved. Storage failures
   leave the tutorial usable in memory.
5. **Implemented, visual check pending.** One smaller card sits on the left below the upper HUD,
   with a slim rail beneath it. The full checklist is collapsed by default. Press **T** while playing,
   or click the checklist summary when the mouse is free, to expand/collapse it. That choice persists
   per account separately from tip completion. The card no longer repeats the next step. Native
   details/summary controls, tutorial labels, polite card announcements, keyboard focus and an
   accessible progress count remain. Gallery variants use the same live HUD.
6. **Implemented, visual check pending.** The E step and its card now say **Loot piles · E** and
   explicitly introduce a tip. E still acknowledges the tip, as requested; it does not claim a pickup.
7. **Implemented, server tests pass.** Generated hostile groups stay at least 45 m from every
   pad, including member offsets and their idle roaming range. This applies to packs, camps and
   hostile singles. Wildlife retains its prior clearance. Camps/singles seek a dry position with
   enough clearance; invalid hostile candidates are rejected. Dawnpad's closest hostile pack has
   three Hopbits at a center distance of **67.84 m**. The minimum hostile clearance after offsets
   and roaming is **52.32 m** on Arcadia, **51.40 m** on Hollowmere and **51.89 m** on Meridian.
   These are initial/idle placement rules; enemies can still pursue a player who engages them.
8. **Implemented, visual check pending.** The boss rule now reads:
   "Bring a friend, watch for the opening, and take them on together."

## Validation

- `pnpm vitest run apps/client/src/ui/mapLabels.test.ts`: 3 passed, with failing tests before implementation.
- `pnpm vitest run apps/client/src/game/onboardingProgress.test.ts`: 6 passed, with failing persistence,
  completion-clearing and preference tests before implementation.
- `pnpm vitest run apps/client/src/game/onboardingSteps.test.ts`: 12 passed.
- `pnpm vitest run apps/server/test/npc-spawns.test.ts`: 5 passed. All three planets failed the
  clearance regression before the change; the nearest-pack test failed at six members before its cap.
- `pnpm vitest run apps/server/test/npc-unit.test.ts`: 23 passed.
- `pnpm vitest run apps/server/test/onboarding.test.ts`: 12 passed after the room-state follow-up.
- `pnpm typecheck`: passed for shared, server and client.
- `pnpm --filter @firstlight/client build`: passed.
- Separate Vite build with `ui-gallery.html` as input: passed, output in
  `apps/client/node_modules/.cache/playtest-ux-gallery/`.
- Full `pnpm test`: **115 files and 1,077 tests passed** in 94.69 seconds. Run once; no timeouts
  or timeout reruns were needed. Log: `node_modules/.cache/playtest-ux-tests.log`.
- The full run preceded the final eight-line room-state bootstrap fix in `500d4cc`. After that fix,
  client persistence tests, server onboarding tests, monorepo typecheck and the production client
  build were checked again. The full suite was not repeated, following the one-run constraint.
- `git diff c9ddf29 --check`: passed.

## Visual checks

Use **1280 × 720**, **1440 × 900**, and **1920 × 1080** windows. The gallery needs only the client
dev server. Paths below are relative to whichever local client port the owner uses.

- In Portus, press **M**. Check all three portal names, Portus Exchange and Hall of Firsts, then
  drag the globe through several orientations. Names should not overwrite each other; leader lines
  should identify displaced names. Check that pads remain clickable on the planets.
- In Meridian, press **M** and rotate Glasspan Salt Flats and The Last Billboard toward either rim.
  Names should stay inside the square canvas rather than lose their first letters. Also inspect
  Arcadia and Hollowmere maps, especially pad/boss/landmark clusters.
- Open **Esc → How to play** with the tutorial active and with a guest save row available. Check
  "Whistle · ride horse", "Phrase wheel (hold)", Voice's Shift/Esc keys, the three rules and footer
  shortcuts. Scroll the controls panel and menu rows if needed. Check the new boss sentence.
  Gallery: `/ui-gallery.html?screen=menu` and `?screen=menu-logout`.
- Gallery: `/ui-gallery.html?screen=onboarding`, `?screen=onboarding-attack`,
  `?screen=onboarding-loot`, `?screen=onboarding-portal`, and `?screen=onboarding-done`.
  Add `&expanded` for the full checklist and `&low` for the existing Low-tier style. The default
  card and rail should leave the center and right side open. Click the summary to check its focus
  outline and expanded scrolling. The loot card should clearly read as an E-to-continue tip.
- In a fresh account's live Portus tutorial, complete several client actions **before finishing all
  dummies**. Press **T**, reload, and verify both the completed checkmarks and checklist choice.
  Leave for a planet and return to Portus while still eligible; the same actions should remain
  checked, including the portal step. Verify another account starts with its own progress and choice.
  Finish/skip the server tutorial and confirm it does not resume after a reload.
- Arrive at **Arcadia's Dawnpad**, walk out toward the nearest hostile group, and check for a
  three-Hopbit encounter farther from arrival. Wildlife may still be closer. Combat behavior,
  encounter difficulty and visible positions have not been browser-tested in this lane.
