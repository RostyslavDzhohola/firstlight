# Sculpted 3D starters (HANDOFF items 7, 6h and the character half of 6g)

The owner found the 2D portrait art "hilarious" and expected real 3D characters, at the level of
littleprince.dev: a sculpted, expressive character with stylised hair, cloth and a face. This note
covers the five starters built for that, how they are made, and what the game spends on them.

## How they are made (`tools/blender/chars3d/`)

- **Sculpted in code, not modelled by hand.** Each character is a recipe of parts. Every part is a
  signed-distance field in numpy: smooth unions blend shapes like clay. Cloth folds, hair strands,
  seams and dents are displacements on that field. The face is a lofted skull (front, back and width
  profiles per height), so the jaw line and the chin are drawn rather than blobbed. Blender's bundled
  OpenVDB turns each field into a dense mesh.
- **Game mesh from the sculpt.** For each part the pipeline drops faces buried inside other parts, keeps
  one side of thin cloth (the material is double-sided), decimates to the part's triangle budget, skins
  it to the shared rig and smart-unwraps a smoothed copy. One atlas per starter.
- **Textures from the sculpt, without a renderer.** Every texel of the game mesh is projected onto its
  part's sculpt, which gives exact normals for a tangent-space normal map, curvature and soft occlusion.
  A numpy "painter" uses them: warm occlusion, cavity darkening, worn edges, a top-down light gradient,
  weave and strand streaks, and painted faces (eyes with iris gradients, two catch-lights and a heavy
  upper lash, brows, mouth, blush). Palette parts are painted in neutral values; the client tints them.
- **Same rig, same clips.** The Quaternius UAL skeleton (CC0, 65 bones) and the existing clip set. Heads
  are about 1.1–1.15× life size so faces read at game distance; no bone moves.
- **Inputs:** only the CC0 UAL rig and clips (downloaded into new empty folders, hashes checked, read by
  Blender with autoexec off). The Universal Base Characters body is no longer used. Everything else is
  our own work (CC BY 4.0).

## Budgets (SPEC §8.1 / content.md §8.1: 10–15k triangles, 1 skinned mesh, ≤ 75 bones, one 1024² atlas)

| | Triangles | Bones | Textures |
|---|---:|---:|---|
| Each starter, LOD0 | 12–15k | 65 (shared rig) | albedo 1024² (alpha = painted accents) + normal 1024², WebP; 512² set on Low |
| Proposed LOD1 (mid tier) | ~4.5k (decimated LOD0, same UVs and weights) | 65 | same |
| Far | the existing capsule proxy | – | – |

Six palettes still work: Role vertex colours pick primary, secondary or accent per part, as before.
The cosmetic sockets (head, face, back, belt) are kept; the head and face sockets move up and out for
the bigger heads and scale hats and masks per starter (`render/Avatars.ts`).

## The five starters

### Hexwick, the young wizard (default palette Midnight)
- **Concept:** a bright, confident apprentice. Tousled dark-brown hair with a fringe swept to his right,
  big blue eyes, a small smile.
- **Silhouette:** slim; a long robe open at the front and flaring at the hem, bell sleeves with
  ink-stained cuffs, one long single-colour scarf trailing down his back, a satchel stuffed with quills
  on the right hip, a strap across the chest, boots under dark trousers.
- **Colours:** robe and scarf primary, silver trim and cuffs secondary, faint constellation embroidery
  in the accent glow. Avoid list kept: no round glasses, no scar, no two-colour house scarf, no crest.

### Brother Ash, the desert monk-knight (Sand)
- **Concept:** calm, older, watchful. His eyes stay visible under the hood (no dark hood with two
  glowing eyes); a hammered brass face-guard covers the nose and mouth.
- **Silhouette:** tall; a deep hood with a forward peak that drapes lower on the left shoulder, a long
  closed robe, a striped mantle wrapped over the left shoulder and across the body, brass prayer beads,
  a leather belt with brass rings and a sun-disc buckle, striped forearm wraps, wrapped sandal boots.
- **Colours:** robe and hood primary (sand), mantle, hem band and wraps secondary with woven
  sun-and-ash stripes, brass fixed. No brown-robe-over-cream-tunic, no sash.

### Kappa, the river ninja from the old stories (Moss)
- **Concept:** cheerful and sturdy, big amber eyes, a hooked beak.
- **Silhouette:** squat and wide; a domed shell of river stones (Voronoi plates) with a palette rim, a
  cream plastron with plate lines, webbed hands and three-toed feet, a short bark-brown hip wrap with a
  knotted sash, forearm wraps, a wide straw kasa with a palette band and chin cords, a dark bob of
  hair around the crown.
- **Colours:** skin stays natural green; rim, hat band and wraps recolour. No bandana masks, letter
  buckles, pads or sneakers.

### Unit 7, the ivory trooper (Ivory)
- **Concept:** compact and friendly-robotic.
- **Silhouette:** solid; rounded ivory plates with panel seams (chest, back, belly, pauldrons, limbs,
  knee caps) over a quilted grey undersuit (never black), a big rounded helmet with one round amber
  lens in a gunmetal ring, "07" stencilled on the left pauldron, a small power pack on the back with a
  status light, gunmetal gloves and belt pouches. No T-visor, no mouth grille, no ear caps.

### Hinoko, the fire ninja (new 5th starter; default palette Ember)
- **Name:** "Hinoko" is the ordinary Japanese word for flying sparks (火の粉), not a character name we
  know of. Alternatives if the owner prefers: "Takibi" (bonfire), "Sootstep". Checked against
  content.md §10: no franchise names or near-misses.
- **Concept:** lean and quick, sharp amber eyes between a charcoal hood and a cloth face mask, a few
  dark bangs with ember-warm tips.
- **Silhouette:** a hooded cowl that drapes onto the shoulders, a long rust scarf whose two tattered
  tails trail behind, a short wrap-front jacket (left over right) with a trimmed lapel and side slits,
  a wide belt with a knotted rope, baggy trousers tucked into shin wraps, bandage wraps on the forearms,
  fingerless gloves, split-toe tabi boots, a kunai pouch on the right thigh.
- **Emblem:** an original ember-in-a-ring mark on the back of the jacket, in the accent glow.
- **Colours (Ember palette):** hood, mask, jacket and trousers primary charcoal, scarf and lapel
  secondary rust, emblem accent orange.
- **IP line:** no orange jumpsuit, no forehead plate or headband, no leaf or spiral symbol, no whisker
  marks, no spiky blond hair, no copied technique names.

#### Kit
- **Ember Kunai** (starter weapon, ranged, 3 tiers like every family): thrown darts, 42 m/s with a
  slight drop, 35 m.

  | T | Lv | Damage | Rate s | Magazine | Reload s | Special | Price |
  |---|---|---:|---:|---:|---:|---|---:|
  | I | 1 | 13 | 0.38 | 8 | 1.3 | – | 60 |
  | II | 6 | 18 | 0.38 | 9 | 1.2 | pierce 1 | 300 |
  | III | 12 | 24 | 0.38 | 10 | 1.1 | pierce 1 | 900 |

  PvP time to kill (all hits): L1 T1 8 hits in 2.7 s; L6 T2 8 hits in 2.7 s; L12 T3 7 hits in 2.3 s,
  inside the 2.2–3.5 s sustained band (content.md §2.5).
- **Ember Seal** (signature fire technique, RMB): hold for a 0.4 s hand seal (a ring of light grows in
  front of the hands), release to throw a fireball (24 m/s, 30 m) that bursts on impact.

  | Kunai tier | Direct (incl. blast) | Splash | Radius | Burn | Cooldown |
  |---|---:|---:|---:|---|---:|
  | I | 30 | 20 | 2.5 m | 4/s × 3 s | 8 s |
  | II | 40 | 27 | 2.75 m | 5/s × 3 s | 7.5 s |
  | III | 52 | 35 | 3.0 m | 6/s × 3 s | 7 s |

  Heavy destruction like the other spells. The server times the hold, enforces the cooldown, and the
  seal spends no kunai. Never a one-shot at equal level (30 + 12 burn of 100 HP at L1).
- **Smoke-step dodge:** proposed, not built (the dodge lane owns the roll).

## Second looks: Kappa · Wayfarer and Unit 7 · Scout (round 2, `rig_astra.py`)

The owner kept both looks for Kappa and Unit 7 (content.md §2.4). The B models are the Astra
design-round meshes (static, unrigged, one palette atlas, the weapon modelled in the hand), rigged here:

- **Clean-up:** seam-split vertices welded; the held Riverstaff (pole and 12 reed rings) and carbine
  (6 parts) removed, matched by their boxes and checked by count; the thumb that gripped the weapon is
  replaced by a mirror of the free one; faces buried 6 mm inside another closed part of the same group,
  or 2 cm inside another body part that never swings out (torso, shell, head, chest, pack), are culled
  (2.5k and 2.0k faces). Limbs keep everything they could swing out of the body.
- **Skeleton:** every UAL bone keeps its name and T-pose frame; joints move to each body (spine heights
  mapped between pelvis and neck; arms, legs and hands from the parts' axes). The arm, hand and finger
  frames are turned (minimal rotation) onto the hanging arms for the bind. The GLB's joint nodes rest
  in the UAL frames (the exporter writes a pose with every bone back in its UAL frame) while the inverse
  bind matrices hold the A-pose, so every clip rotation means the same as on the other starters and
  sockets compute as before.
- **Weights:** per island group: rigid for hat, head parts, shell, hands, feet and every Unit 7 robot
  segment; heat weights restricted to the group's bones for Kappa's body, arms and legs and Unit 7's
  torso.
- **Clips:** shared. Their legs are short (pelvis 0.57 / 0.65 m vs 0.917 m), so the client scales only
  the pelvis position track by that ratio (feet stay on the ground, bobs and crouches shrink) and
  plays the locomotion clips faster by the same ratio.
- **Textures:** a fresh smart-projected atlas; each texel samples the design's palette atlas through the
  original UVs, plus baked occlusion (an OpenVDB level set of the whole mesh). Palette roles: Kappa's
  vest primary and shell rim secondary; Unit 7's ivory shell primary, grey joints secondary, the optic,
  chest light and antenna tip painted accents. No normal map file: the design has no sculpt detail, so
  both share one flat 4×4 texture made in the client (saves ~10.7 MiB of GPU memory on Medium).
- **Loading:** with the other looks, behind the loading screen. Each look's materials are their own
  shader builds (measured: a look fetched on first sight compiled 12 toon and 2 shadow builds in
  play), so the warm-up stands every look × palette; `?avatars&warmcheck` counts the builds after it
  (0 on WebGPU and WebGL2, Low/Medium/High).
- **Budgets:** 10,425 and 11,759 tris, 65 joints, 1 skinned mesh, 1024² + 512² sets.
- **Sockets:** per model (crown, face, back and belt points; hats and masks drawn 2.2–2.4× for the big
  heads). Kappa B's back socket sits on the shell, Unit 7 B's behind the radio pack.

## Approval renders (Phase A, 2026-10-15) and what is still rough

Renders: `/tmp/fl-go/chars/` (turnarounds in a neutral studio light; "game" renders emulate the
client's toon avatar shader under the Portus sun and sky; line-ups; the ninja in all six palettes; a
walk/idle contact sheet). Rebuild everything with `tools/blender/chars3d/build.sh`.

Known rough spots, to fix after the owner's notes:
- **Texel use:** the automatic unwrap packs only about a third of each 1024² atlas (many small
  islands), so textures are softer than they could be. Next: seam-based unwrapping to roughly double
  the density, faces first.
- **Hoods** (Brother Ash, Hinoko) read a little like bags; the ninja's cowl drape is a tall tube. Next:
  a shorter, wider capelet and a softer hood peak.
- **Toon light on faces:** the game's hard terminator draws a dark band across noses and cheeks. A
  softer ramp for skin (or the whole avatar) would suit the sculpted look better.
- **Secondary motion:** scarves, robe hems and hood tails are only skinned. Proposal: 6–8 spring bones
  per starter (within the 75-bone budget), simulated in the client for the nearest avatars only.
- **Small things:** Ash's prayer beads hang off the chest; hands are fists in the idle clip; Unit 7's
  first padding pattern read as scales (rebuilt with broad padding and smooth plates).
