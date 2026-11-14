# Review: sculpted weapons lane (`night/weapons` at `46ec266d`), GPT-6.1 Sol, 2026-11-13

**Verdict: merge after fixes.** No blockers; an optional asset download can prevent entry, missing icons
have no fallback, and the head-clearance work is not done.

## Findings

1. **Should-fix, `apps/client/src/render/avatars/sculpted.ts:57`: an optional weapon download can hold
   the loading screen for good.** Every GLB and texture is awaited with no deadline; avatar loading
   awaits the preload and game entry awaits avatar loading. Confirmed with an in-memory probe: a rejected
   GLB settles safely, a never-settling one keeps the preload pending. Bound the optional loads, keep the
   procedural models after the deadline, and stop late completions changing materials after warm-up.
2. **Should-fix, `apps/client/src/ui/sprites.ts:1061`: failed rendered icons leave blank inventory and
   shop slots.** `itemSprite()` always picks the remote rendered image for the six sculpted weapons; the
   pixel sprites are never used when it is missing or corrupt. Keep the pixel sprite under the image, or
   pick the rendered icon only after it has loaded.
3. **Should-fix: #63's clearance while moving is still open** (long weapons pass through or behind the
   head in run, sprint and roll). Add a carry pose or mount adjustment for movement, keep the attack
   poses, check the long weapons on two starters.

## Checked and sound

Server-owned inventory and catalogue values decide damage, range, pierce count, magazine, block share
and cooldowns; switching weapons keeps the reload deadline. Spear and lantern use the existing safe-zone,
protection and wall gates, and the sites' solids. Rare rewards roll once at the guardian's death (1/6)
and survive payout retries; reconnecting does not re-roll; pickup is public, like existing piles.
Entries are appended at 22–24; unknown indexes are guarded in the client paths read. The warm-up holds
all six sculpted materials. Preload added: 957,368 bytes (484,850 on Low) in 18 requests. The crossbow's
burst classification is a documented balance exception, not hidden arithmetic. Tests: new-weapons 4/4,
wild-sites 3/3, weapon models 2/2, town walls 11/11, balance 755/755.

## Not checked

Browser rendering, WebGL2 and Low looks, pipeline counts after warm-up, movement clipping, Blender
rebuild equivalence.

## Fixes

| # | Fix | Commit |
|---|---|---|
| 1 | `preloadSculptedWeapons` resolves after `SCULPTED_PRELOAD_DEADLINE_MS` (15 s) at the latest; items not in keep their code-built models for the visit, and files that land later are dropped, so nothing changes a material after the warm-up. Test with an injected never-settling GLB (fake timers): pending forever before, resolves at the deadline after; a late file leaves the item code-built. | `0a3bb81e` |
| 2 | `itemSprite` returns the rendered icon only after `installSprites`' one request for it has loaded; until then, or on error, the pixel sprite (inventory, shop, death, pick screens). Test with a stand-in `Image`. | `5bd1f77c` |
| 3 | A carry grip while running, sprinting and rolling: the block grip's per-weapon turn in the hand socket became two held poses (`HELD_GRIP_DEG` block / carry). Long weapons turn 75–90° about the socket's Y axis (D-fix-moon-3). Clip check on Hexwick and Kappa, sculpted and code-built models: run and sprint go from 5–9 cm into the head to no flag; the roll loses its 8.5–9 cm head flag but keeps 2–6.6 cm into the right thigh and calf (the axe's and bow's 6.3–6.6 cm are at the grip, unchanged by all 18 rotations tried: the roll tucks the fist into the leg; needs a weapon-class roll clip). Aim, cast, attack and walk keep the mount. #63 stays open for the roll and for heavy melee. | `f7a042eb` |
