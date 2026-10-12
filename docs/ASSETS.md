# Third-party asset registry

Every third-party file that ships in (or is used to build) FIRSTLIGHT, with author, source URL,
licence, download date, what we changed and a hash. Our own art is CC BY 4.0 (`LICENSE-ART`).

## Starter characters (lane/chars)

Shipped files: `apps/client/public/assets-dev/characters/` (built by `tools/blender/characters/build.sh`;
the asset pipeline moves them to the CDN later). Raw third-party archives are **not** in git; the build
script downloads them into a fresh `/tmp` folder and checks the hashes below.

| Source | Author | URL (creator's own page) | Licence (checked on the page **and** in the archive's `License.txt`) | Downloaded | Archive SHA-256 |
|---|---|---|---|---|---|
| Universal Animation Library [Standard] v3.0 | Quaternius | https://quaternius.itch.io/universal-animation-library | CC0 1.0 Universal | 2026-10-11 | `cc73fc4e495b82958207316596317a3f40b9fa38065bde1027937452da537724` |
| Universal Animation Library 2 [Standard] | Quaternius | https://quaternius.itch.io/universal-animation-library-2 | CC0 1.0 Universal | 2026-10-11 | `4008ea208a604773a2b2177d965f0f5d3195498b5bf838c3f5785d68e95f2a68` |
| Universal Base Characters [Standard] | Quaternius | https://quaternius.itch.io/universal-base-characters | CC0 1.0 Universal | 2026-10-11 | `fdbf1804c90dfc1ea03e992bff7da2dfd1a79318e13270a660180f9308455f40` |

What we used and changed (only the glTF/GLB files were opened, in headless Blender with autoexec off):

- **Skeleton:** the 65-joint UAL rig (`UAL1_Standard.glb`, root motion off), unchanged. It is the one
  shared skeleton for all four starters.
- **Clips (23 of 86):** renamed. UAL1: Idle_Loop→idle, Walk_Loop→walk, Jog_Fwd_Loop→run,
  Sprint_Loop→sprint, Jump_Start→jump, Jump_Loop→fall, Jump_Land→land, Swim_Fwd_Loop→swim,
  Swim_Idle_Loop→swim_idle, Roll→roll, Punch_Jab→punch, Punch_Cross→punch_heavy,
  Pistol_Aim_Neutral→aim, Pistol_Shoot→shoot, Spell_Simple_Shoot→cast, Hit_Chest→hit,
  Death01→death, Dance_Loop→emote_dance. UAL2: Sword_Regular_A→melee_light,
  Sword_Regular_C→melee_heavy, Sword_Block→block, OverhandThrow→throw, Hit_Knockback→hit_heavy.
  Re-exported through Blender at 30 fps; meshopt-compressed. The client also cuts subclips
  (jump_air, block_hold, roll_fast, land_short) and drops constant scale/translation tracks.
- **Body:** the UBC `Superhero_Male_FullBody` mesh and its skin weights, refitted onto the UAL rest
  pose. The realistic head was deleted and replaced with our own anime-leaning head. The body was
  decimated to ~7k triangles, then per character trimmed (covered regions removed), smoothed,
  inflated (Kappa), recoloured through our atlas, and dressed. UBC eyes, eyebrows, hair and textures
  are not used.

Our own work in these files (CC BY 4.0, "FIRSTLIGHT contributors"): the heads and painted faces, all
clothing, armour, hair, hats, hood, shell, boots and props on the characters; the atlas
(`starters_atlas.png`, also kept in `assets-src/characters/`); and the authored emotes
`emote_wave`, `emote_point` and `emote_cheer`. Weapon models are generated in code
(`apps/client/src/render/avatars/weapons.ts`, MIT).

Shipped outputs (2026-10-11 build):

| File | Bytes | SHA-256 (first 16) | Contents |
|---|---|---|---|
| `hexwick.glb` | 90,876 | `10316b8cd205004c` | 9,324 tris, 65 joints, 1 skinned mesh |
| `ash.glb` | 94,684 | `c929c8bf57bca006` | 9,015 tris, 65 joints, 1 skinned mesh |
| `kappa.glb` | 99,236 | `6a8997d068858327` | 10,452 tris, 65 joints, 1 skinned mesh |
| `unit7.glb` | 111,004 | `5f37fe49101f30c3` | 12,808 tris, 65 joints, 1 skinned mesh |
| `starters_anims.glb` | 1,134,936 | `99c15ec156dd9ca5` | skeleton + 26 clips |
| `starters_atlas.png` | 136,319 | `e413b0e6c7c51131` | 512² shared colour/pattern atlas |

Total: about 1.6 MB.

IP line: no franchise names, logos or near-copies. Each brief's avoid list (content.md §8.2) was
checked against the models:

- Hexwick: no round glasses or scar, and a single-colour scarf.
- Brother Ash: lantern-cage hilt with an amber-white flame-ribbon blade (not a cylinder hilt).
- Kappa: no bandana mask, belt buckle or elbow/knee pads.
- Unit 7: grey (not black) undersuit, one round lens, no T-visor and no ear caps.

## Horse (lane/horses)

Shipped file: `apps/client/public/assets-dev/animals/horse.glb` (built by `tools/blender/horse/build.sh`;
the asset pipeline moves it to the CDN later). The raw archive is **not** in git; the build script
downloads it into a fresh `/tmp` folder and checks the hash below.

| Source | Author | URL (creator's own page) | Licence | Downloaded | Archive SHA-256 |
|---|---|---|---|---|---|
| LowPoly Animated Animals (`Farm Animals Animated by Quaternius.zip`, 6.6 MB) | Quaternius | https://quaternius.itch.io/lowpoly-animated-animals | CC0 1.0 Universal: checked on the page in two places (the description, "CC0 License" with the creativecommons.org/publicdomain/zero/1.0 link, and itch's "Asset license: Creative Commons Zero v1.0 Universal" field). **The archive has no licence file** (only `Blends/`, `FBX/`, `OBJ/` and `Preview.gif`), so the page is the record | 2026-10-11 | `b4bc5f209368cafc21962934e7d676cf1cfb1f746a363086cd9f45c4385db70e` |

What we used and changed (only `FBX/Horse.fbx` was opened, in headless Blender 5.2.1 with autoexec off;
the `.blend` files were never opened):

- **Mesh and rig:** the horse mesh (690 triangles) and its 39-bone armature, unchanged, scaled by 0.305 so
  the back is 1.5 m high (the armature node carries the scale, so the clips stay valid).
- **Clips (4 of 6):** Idle→idle, Walk→walk, Run→run, Jump→jump, exported at the source's 24 fps; Death,
  WalkSlow and the object-level keys dropped. The client drops the constant scale tracks.
- **Colour:** the two flat materials became a per-corner role mask (coat / mane-tail-hooves); the FBX's
  plain white `Col` layer was removed. The client tints six coats from the mask (`content/horse.ts`).
- Compressed with `@gltf-transform/cli` 4.5.1 (meshopt + quantisation, keyframe resample, no prune: prune
  would drop the empty `saddle` socket node).

Our own work in this file (CC BY 4.0, "FIRSTLIGHT contributors"): the saddle seat with pommel and cantle,
the blanket, straps and stirrups (428 triangles, skinned to the Torso bone and fitted to the barrel by
ray casts), the blanket's role in the mask, and the `saddle` rider socket. The riding pose is generated in
code from the UAL idle clip (`apps/client/src/render/avatars/ride.ts`, MIT); the box horse fallback is in
code too (`apps/client/src/render/Horses.ts`, MIT).

Shipped output (2026-10-11 build):

| File | Bytes | SHA-256 (first 16) | Contents |
|---|---|---|---|
| `horse.glb` | 147,072 | `615314bc14b2af1a` | 1,118 tris, 39 joints, 1 skinned mesh, `saddle` node, 4 clips |

IP line: a generic farm horse with a plain saddle; no franchise names, brands or look-alike tack.
