# Review: sky and moon lane (`night/sky` at `537cd494`), GPT-6.1 Sol, 2026-11-13

**Verdict: merge after fixes.** The sky and moon largely work, but mounted jumps trigger corrections,
mission L1 cannot be taken in the browser, and several consumers still leave Lumen out. No security
blocker.

## Findings

1. **Should-fix, `apps/client/src/game/PlayerController.ts:467`, `apps/server/src/world/movement.ts:129`:
   mounted jumps leave the validated envelope.** Tangential movement on the small sphere adds radial lift
   while the server assumes a ballistic radial path. Confirmed with the real controller against
   `validateMove`: a 16 m/s mounted jump on Lumen fails with `height` at 1.20 s (a flat 240 m sphere
   reproduces it; the on-foot sprint-jump passes). Integrate radial displacement apart from tangential;
   add a mounted low-gravity regression test.
2. **Should-fix, `packages/shared/src/content/missions.ts:221`, `apps/client/src/ui/panels.ts:138`: Lark
   never offers L1.** L1 has `giver: "guide_arcadia"`, but `GuidePanel` uses `missionsOn()`, which leaves
   out every mission with an explicit giver. Confirmed by execution. Use `missionsFrom(g.id)`; test it.
3. **Should-fix, `apps/client/src/game/QuestClient.ts:76`: Surveyor Odile cannot be opened.** The guide
   panel is created only for `PLANET_IDS`, which excludes Lumen. Gate on `GUIDES[body]`; test it.
4. **Should-fix: planet-only UI lists give missing or wrong moon information.** `panels.ts:274`: the
   Sites journal counts the Quietfall Wreck in its total but never draws its row. `homeModel.ts:134`: the
   pad counter's total leaves out Lumen's 12 pads while the count includes them (it can pass 44).
   `mapMarkers.ts:82`: Arcadia's moon portal and Lumen's return portal both say "Portal to Portus".
5. **Should-fix, `packages/agent-kit/src/walker.ts:203`: agents keep normal gravity on Lumen** (hard-coded
   `WALK.gravity = 18`). Use `bodyGravity(w.body)`.

## Checked and sound

Gravity comes from the server room's body; movement packets cannot choose it; reconnect, travel,
mounting, Skipstep, admin teleport and the sandbox do not carry another body's gravity. Creature kinds
and L1 are appended. Rooms, travel validation, agent body and travel enums, saved positions,
leaderboards and `/stats` take Lumen. Orbits stay finite and continuous across a day boundary and near
`Number.MAX_SAFE_INTEGER`; the night key light eases between bodies; orbit updates reuse scratch
storage; sky bodies are two instanced draws. Fall damage: small hops harmless, Lumen safe through 32 m,
lethal at 82 m. Tests: Lumen 5, orbits 8, vegetation 5, avatars 17, shaders 35, environment 31, shared
quests 17; balance 668/668. The lane's three client timeouts did not reproduce alone and are not on
paths it changed.

## Not checked

Browser and device behaviour, rendering on either backend, frame times, the footage.

## Fixes

| # | Fix | Commit |
|---|---|---|
| 1 | | |
| 2 | | |
| 3 | | |
| 4 | | |
| 5 | | |
