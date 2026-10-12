# Review: live smoke-test fixes (lane/smoke-fixes), Codex gpt-6.1-sol

Source: Codex's live smoke test of production after the play-test UX deploy (9356edb): the expanded
tutorial checklist ran into the player card; grass grew through Dawnpad's stone disc.

## Round 1 (5b8413b)

- **Blocker:** per-vertex grass masking in `terrain.worker.ts` didn't stop blades on the pad:
  `GrassSystem.fill` interpolates neighbouring weights (7 blades inside the disc at Medium).
  Apply the exclusion at each blade root.
- **Should-fix:** a clipped checklist has no usable scroll path while playing (pointer locked;
  unlocking opens the full-screen pause overlay).
- **Nit:** "8.6 m across" should say radius.
- Verified: the CSS arithmetic leaves 36–43 px between the widget and an 8u player card at
  1280×720 … 1920×1080; chord vs arc error < 0.00024 m; worker cost bounded.

## Round 2 (268d5f7)

Blade roots are excluded per pad (12/12/20 checks per accepted candidate, only during cell
generation); the current step scrolls into view inside the widget only; Skip stays in the pause
menu. Client typecheck passed, 292 client tests passed. **Verdict: approve.**
