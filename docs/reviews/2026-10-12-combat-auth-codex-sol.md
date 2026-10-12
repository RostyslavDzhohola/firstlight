# Review: combat core + accounts (Codex gpt-6.1-sol, high) — through a3ca98c

Blockers
1. Session replacement can clone/overwrite characters (kick 4001 → onDrop keeps old actor 30 s; onReconnect doesn't check ownership; cross-room lingering bodies survive replacement joins).
2. Account linking corrupts the winning character (displaced actors autosave over winner; a.state keeps guest HP/pos; lingering guests not rekeyed; sqliteStores recreates deleted accounts).
3. Loot transfers not atomic with character persistence (drop persists pile but not inventory; death/pickup commit separately).
4. Full-draw bow shots require no draw (server trusts charge:1; client grants full charge without RMB).

Should fix
5. Body changes via /api/play bypass travel/combat restrictions (authorize travel server-side).
6. Displaced browsers fight for the session (4001/4002 auto-rejoin every 1.5 s).
7. Email sign-in bypasses display-name validation/uniqueness (Better Auth user.name used).
8. Logout can complete while walking (0.3 m steps < 0.4 m threshold) and the loggedOut flag is sticky.
9. Hammer slam bypasses charge/cooldown and double-hits (arc + radial).
10. Protection doesn't prevent attacks; burn applied even when damage rejected.
11. Hitscan origin within 7 m of head can bypass nearby cover.
12. Short oblique projectile segments miss capsules (rayCapsule clamp bug).
13. Tier gates only on attacks, not equip/use.
14. Healing rounds up every tick (tonic heals ~60 instead of 40).
15. Rockets double-count direct damage (direct 70 + splash 45).
16. Last departing client lets an empty room dispose while bodies linger.

Nice to have
17. Autosave writes individually inside the tick (batch in one transaction).
18. Bot tokens can enter public rooms (derive room mode from identity).
