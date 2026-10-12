# Staged scenes (SPEC §6.13, finish line F13)

Five scenes for the video. Each is set by the admin command `stage <n>`: it teleports the admin
and the **crew** into a formation at the scene spot, heals them to full and sets the scene (boss and
NPC spawns, a loot pile, PvP protection off). Code: `apps/server/src/world/quests/stage.ts`.

## How to run a scene

- **Who is crew:** the admin who typed the command, other admins, load-test bots, and **members of
  the admin's party**. In production only the owner's account is admin, so the other windows join
  the owner's party (Tab → invite, within 30 m) before staging. Crew within 80 m of the admin are
  pulled in; add `all` (`stage 3 all`) to pull every crew member in the same planet copy.
- **Typing it:** in the admin window press <kbd>`</kbd> (backquote) to open the admin console and
  type `stage 2`. Or open the admin window with `?stage=2` in the URL (add `&all` for `all`): it
  stages itself once it has joined.
- **Other bodies:** if the scene is on another body, the admin's client travels there and repeats the
  command on arrival. Party members follow through party travel (parties lane); then run `stage n`
  once more (or `stage n all`) to pull them into formation.
- **Getting the cast ready:** the console also takes `level <n>`, `give <id> [tier] [qty]`,
  `coins <n>`, `heal` (admin window only; for other windows use the moderation tools).
- **Camera:** photo mode (<kbd>F9</kbd>, photo-mode lane) in the admin window: free camera, FOV, DoF,
  exposure, planet grade. Hide the HUD there. Record with the screen recorder of your choice.
- **Spawns:** bosses and NPC groups are requested on the game event bus
  (`spawnRequest`, reason `"stage"`). They appear once the NPC/boss lane handles that event; until
  then the scene is set without them (the toast still says the scene is set).

## 1 · Portus crowd under the sky planets

| | |
|---|---|
| Body / spot | Portus, plaza centre (`portus_plaza`) |
| Formation | ring around the centre, 6 m radius (+3 m per extra 12 people) |
| Windows | 1 admin/camera + 3–7 players (everyone spawns in the plaza anyway; party members are pulled into the ring) |
| Set by the command | everyone healed, ring formation |
| Camera moves | Start low in the ring's centre looking up past the players' heads at the three planets in the sky; slow 90° orbit; end on the portal ring with Arcadia's turquoise portal in frame. Second take: crane up from the Portus Exchange stall (Juno Vale) over the crowd to the Hall of Firsts wall. |
| Notes | Use phrase-wheel bubbles (G) and the music-reactive lights for life. The Hall of Firsts wall shows claimed plaques live. |

## 2 · Arcadia vista — Tidewrath rising from the lake

| | |
|---|---|
| Body / spot | Arcadia, the Gull Point overlook (`gull_point_overlook`), 21 m above Glasswater Lake |
| Formation | a line along the overlook edge, 2.5 m apart, facing the lake |
| Windows | 1 admin/camera + 1–3 players |
| Set by the command | Tidewrath spawn requested at its lair (`gull_point`, the shore 86 m east of the lake centre) |
| Camera moves | Over-the-shoulder from behind the line, looking down to the shore and the two Tide Stones; hold until the coral spikes break the surface; slow push-in as Tidewrath rises; cut to a low shot from the shore looking up at it with the players silhouetted on the overlook. |
| Notes | Golden-hour grade is Arcadia's default. Mission A3 ("The Big Lake") ends here, so a fresh character can be shown completing it. |

## 3 · Hollowmere chapel at dusk vs the Hollow Court

| | |
|---|---|
| Body / spot | Hollowmere, 14 m south of the Drowned Chapel altar (`drowned_chapel`), knee-deep water |
| Formation | an arc 8 m out, facing the chapel |
| Windows | 1 admin/camera + 2–3 fighters (level 8–11, T2 weapons: `level 10`, `give sunbrand 2`) |
| Set by the command | 4 Bonewalkers + 2 Bone Archers requested at the chapel |
| Camera moves | Track along the arc at knee height so the water and the candle-lit chapel fill the background; the bones rise; whip-pan to the first clash; finish on a wide shot from the chapel steps with the violet dusk sky. |
| Notes | The three bell ropes (egg E5) hang beside the altar — keep them out of the hero shot so the secret stays a secret. |

## 4 · Meridian canyon co-op vs The Receiver

| | |
|---|---|
| Body / spot | Meridian, Foreclosure Yard (`foreclosure_yard`) |
| Formation | pairs at ±16 m east/west of the yard centre (where the two Override Consoles sit, 32 m apart) |
| Windows | 1 admin/camera + 2 fighters (level 19–20, T3 weapons: `level 20`, `give stillshot 3`, `give comet 3`) |
| Set by the command | The Receiver spawn requested at its lair |
| Camera moves | Open wide from the gantry overlook (`yard_gantry`, 22 m up — mission M3's target) over the container yard; cut between the two console holders as they hold for 3 s; the Receiver kneels and the rear hatch opens; orbit the hatch while both fire. |
| Notes | The co-op mechanic needs exactly the two-place split: put one fighter on each console. |

## 5 · Wild-west PvP with destruction and a loot pile

| | |
|---|---|
| Body / spot | Arcadia, 60 m east of Blockyard Camp (`blockyard_camp`) — outside every safe ring |
| Formation | two lines 20 m apart facing each other, 3 m spacing |
| Windows | 1 admin/camera + 2–4 fighters (two sides) |
| Set by the command | spawn protection off for the cast; a staged loot pile (Comet Launcher, Scatterpipe, 3 Small Tonics, 150 coins) dropped between the lines |
| Camera moves | Low dolly between the lines toward the glowing pile; the first Comet shot shatters the camp wall behind one line (destruction lane); slow-motion feel by holding on the debris; end on a winner looting the pile. |
| Notes | Friendly fire is on and death is real: fighters lose everything (that is the point of the scene). Use throwaway guest characters. |
