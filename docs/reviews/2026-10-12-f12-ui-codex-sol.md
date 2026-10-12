# Review: lane/f12-ui (inventory + onboarding), Codex gpt-6.1-sol

Reviewed `git diff dd4ed12..lane/f12-ui` (346b99a). Checkout unchanged. (Round 1 retried once after a "model at capacity" failure.)

## Blocker

None found. No repeat XP/medal farm or item duplication found in the reviewed paths.

## Should-fix

1. **Onboarding can persist completion without its rewards.** `apps/server/src/world/onboarding.ts:175`, also line 107.
   Dummy payout flags and the completion flag commit before character XP and Spark. A process crash between those writes permanently loses rewards: rejoining restores the paid-dummy flags or rejects onboarding as completed. Fault injection confirmed completion stat `1`, stored XP `0`, and Spark absent after a failed character save.
   **Fix:** Commit payout flags, character XP, and the medal together in one SQLite transaction. Send success messages after commit. Add failure/restart coverage using SQLite; the current onboarding tests use memory stores.

2. **The inventory offers a Prism Bubble action that does nothing.** `apps/client/src/ui/inventoryModel.ts:245`.
   Clicking "Use," pressing E, or right-clicking a bubble sends `use`. `BodyRoom.use()` handles tonics and patchkits only, so the request silently succeeds without any effect. The bubble also cannot reach the normal backpack "Equip" quick action because this branch returns first. Reproduced against the local test server.
   **Fix:** Implement the advertised server-authoritative bubble action, or provide an accurate supported action. Add an integration test asserting the resulting effect rather than only the outgoing message.

3. **Onboarding stops before the remaining required interactions.** `apps/client/src/game/onboardingSteps.ts:32`, `OnboardingClient.ts:91`.
   The sequence ends at attacking dummies, and the server completion message replaces it with "You're ready." A newcomer never receives the weapon-switching, pickup, map, phrase-wheel, optional voice opt-in, or portal instructions required by SPEC §6.12.
   **Fix:** Add the remaining client tutorial steps and retain the tutorial after the dummy payout until those steps finish or the player skips. Keep voice opt-in optional.

4. **Session takeover leaks trainee entries.** `apps/server/src/world/onboarding.ts:61`.
   Joining the same account from another window calls `BodyRoom.retire()`, which removes the old actor before `onLeave()` can invoke system cleanup. Consequently, `OnboardingSystem.onPlayerLeave()` never deletes that trainee. Reproduced: one takeover left two trainee entries with only one live actor. Repeated takeovers grow this map for the room's lifetime.
   **Fix:** Invoke system leave hooks during retirement before removing the actor, with cleanup safe to repeat. Add a takeover test asserting only the current trainee remains.

## Nit

None.

Validation: `pnpm typecheck` passed. All 12 selected test files passed, **172 tests**, including inventory, onboarding, sessions, persistence, SQLite stores, rules, panels, and server type stripping. No browser or live-site access used.

**Merge: no**
