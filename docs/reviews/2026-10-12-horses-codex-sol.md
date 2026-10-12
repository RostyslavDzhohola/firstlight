# Horses lane review (Codex gpt-6.1-sol), 2026-10-12

Scope: `git diff main...daaa266` (lane/horses). Saved verbatim; the builder decides. Disposition is in the lane's final report and commits after daaa266.

Reviewed `main...daaa266`, the HEAD at review start. Concurrent commits are excluded; line references use that snapshot. No files edited.

1. **Major** · [BodyRoom.ts:449](../../apps/server/src/world/BodyRoom.ts:449)  
   Dismount grants another 600 ms of horse-speed refill, but fire/melee immediately become available. A modified client can run at 16 m/s while attacking on foot, including after being thrown.  
   **Fix:** Replace ongoing horse-speed refill with bounded allowance for already-in-flight mounted inputs.

2. **Major** · [HorseSystem.ts:133](../../apps/server/src/world/horses/HorseSystem.ts:133)  
   `onLeave` removes the actor before calling horse cleanup. Consequently, a consented departure outside safety deletes the horse but leaves the lingering body’s `mounted` and `PF.MOUNTED` set, with an elevated hit capsule and no horse. Confirmed by an in-memory probe.  
   **Fix:** Clear mounting on the departing actor before removing it from `actors`.

3. **Major** · [CombatClient.ts:209](../../apps/client/src/game/CombatClient.ts:209)  
   The mounted early return prevents the client from sending `use` for Tonics and Patchkits, despite §1.6 explicitly allowing both.  
   **Fix:** Process permitted healing-item use before returning from the mounted branch.

4. **Minor** · [HorseSystem.ts:150](../../apps/server/src/world/horses/HorseSystem.ts:150)  
   Same-body pad fast travel neither invokes `onPlayerLeave` nor emits a travel event. The horse survives, and a mounted player arrives still mounted, contrary to travel cleanup rules.  
   **Fix:** Despawn the horse and clear mounting when fast travel succeeds.

5. **Minor** · [HorseSystem.ts:60](../../apps/server/src/world/horses/HorseSystem.ts:60)  
   A client’s deep-water dismount arriving before the next tick is treated as an ordinary dismount. If surrounding candidates are underwater, the horse stays there instead of returning to `lastDry`. Confirmed by a probe.  
   **Fix:** Determine the water dismount reason from authoritative terrain when handling the request.

6. **Minor** · [combat.ts:113](../../apps/server/src/world/combat.ts:113)  
   Capsule position is rewound, but mounting uses the current state. Mount/dismount transitions therefore shift the historical target by 0.8 m, causing valid headshots to miss within the rewind window.  
   **Fix:** Record mounted state in position history and rewind it with the position.

7. **Minor** · [HorseSystem.ts:111](../../apps/server/src/world/horses/HorseSystem.ts:111)  
   Mounting clears scope once, but the unchanged `scope` handler accepts subsequent `{on:true}` messages while mounted. Server refusal required by §1.6 is incomplete.  
   **Fix:** Reject scope activation while mounted.

8. **Minor** · [CombatClient.ts:271](../../apps/client/src/game/CombatClient.ts:271)  
   Clicking an equipped whistle bypasses `?nohorses`. Two clicks can mount an invisible horse while horse rendering, movement synchronization, and H/E controls are disabled.  
   **Fix:** Apply the same `horsesEnabled` check to equipped-whistle input.

9. **Minor** · [HorseSystem.ts:165](../../apps/server/src/world/horses/HorseSystem.ts:165)  
   Every tick copies mounted position/facing into the unfiltered horse map, although clients draw ridden horses from their riders. This duplicates movement traffic room-wide.  
   **Fix:** Update horse coordinates at mount/dismount; derive ridden transforms from player state.

