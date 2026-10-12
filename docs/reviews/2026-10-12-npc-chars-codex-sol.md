# NPC + characters merge review (Codex gpt-6.1-sol, high), 2026-10-12

Reviewed `820bd24..2447afe` (merges of lane/npc and lane/chars). Typecheck clean; 229 tests passed. Read-only, no browser.

## Blocker
1. Overkill steals top-dealer rewards (`npc/NpcSystem.ts:354`): contribution records full hit, not HP removed. Fix: cap by pre-hit HP.
2. NPC movement restrictions trust the client (`NpcSystem.ts:429`, `boss.ts:525` Undertow pull): slows/roots/pulls never enforced server-side; dodge allowed during Cease-and-Desist. Fix: store effects on the actor; enforce in movement validation; simulate pulls.
3. Leaving the arena bypasses anti-solo split mechanics (`boss.ts:646`): leave during the telegraph, return before reset. Fix: keep the marked/participant set through detonation, or reset on abandonment.

## Should-fix
- Boss loot recipients from stale cached state, radius+5, no dead/membership check (`boss.ts:372`).
- Dead contributor's surviving party members lose credit (`boss.ts:380`): expand contributors by account via partyOf before filtering recipients.
- Rewards bypass D26 transactions (`rewards.ts:149`): withTx + deferred pile broadcasts.
- Boss weak points use generic headshot geometry/multipliers (`boss.ts:354`): Longshot ×1.8 leaks ×1.2 through closed armour; define boss weak-point volumes.
- Summons unbounded; Cantor children survive their summoner (`boss.ts:678`, `NpcSystem.ts:388`).
- Avatar speed history shared via module-level `_prev` (`render/Avatars.ts:256`).
- Avatar teardown leaks cloned skeleton bone textures (`Avatars.ts:423`).
- Late arrivals see broken arena cover as intact (`world/npcs/arena.ts:39`): send a snapshot on join/AOI entry.
- Telegraph decals create a material per decal during combat (`world/npcs/telegraphs.ts:23`): share materials / instance attributes, prewarm.
- Malformed admin spawn → NaN positions (`NpcSystem.ts:601`): validate finite input, default to admin position.
- Compliance Officer aura never applied (`npcs.ts:434`, `NpcSystem.ts:407`).

## Nit
- `tools/blender/characters/build.sh:19` uses `npx`; use `pnpm dlx`.
