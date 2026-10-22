---
name: models-as-code
description: Sculpt FIRSTLIGHT 3D models in code with headless Blender. Use for a new or remade character or character look, a new or remade weapon or held prop, or a change to a sculpted recipe.
---

# Models as code

FIRSTLIGHT's sculpted models are Python **recipes**. Each part is a signed distance field. The build meshes it, culls the buried faces, decimates it to a triangle budget, packs UVs, bakes and paints the textures in numpy, and exports a game GLB.

- **Characters** live in `tools/blender/chars3d`, with recipes in `recipes/`.
- **Weapons and held props** live in `tools/blender/props3d`, with recipes in `items/`. They reuse the chars3d helpers.

Every script's header carries its command line, so read it there.

The two test reports are the worked examples, with pictures of the target look. Read the one for your kind of model before step 1:

- `docs/reports/2026-10-18-chars-mage-test.md`: Orla, a character with extra bones and swing.
- `docs/reports/2026-10-19-props-test.md`: three weapons, compared with today's code-built ones.

## The look

The owner kept this method for the detail in these models. Aim every recipe at the same look:

- **One signature per model that reads at 10 m.** Examples: the staff's glowing bulb in copper tines, the axe's bright honed edge against a dark head, the bow's two-tone yew. Name the signature in the brief's tie-breakers and check it in the game-scale render.
- **Shapes from real making.** Forged, turned, wrapped, bound and riveted: a hooked beard, a flared butt knob, cord turns, a D-section limb. Each model gets its own proportions. Orla stands tall and slim beside the stockier starters.
- **Triangles go to the silhouette, and detail goes in the paint.** Paint worked metal with dents and bands, wood grain along the axis, grime in cavities (from AO and curvature), edge highlights and temper colours, and bake a normal map for relief.
- **Glow is painted.** Albedo alpha = 1 − glow, and the painted colour is what glows. The palette tints only the parts with a Role (usually the grip wrap or cloth), so the signature colour holds in every palette.

## Steps

1. **Brief**, in the recipe header. Write what the model is, 2–3 feel references (how it should feel, not how to build it), tie-breakers, and an IP avoid list. Check the names against `docs/content.md` §10 and the looks against the avoid lists in §8.2. Done when the tie-breakers name the signature and the avoid list names the near-misses for this kind of thing.
2. **Reference** what exists, in the poses the game uses. For an item, preview today's model in the hand (`preview_prop.py --today`) at frames from the clips its weapon class plays. For a character, line it up with the shipped starters at game scale. Done when you have seen the existing model held or posed. This step found the game's bow lying sideways in aim and shoot.
3. **Part previews.** Build one part at a time, coarse and fast (`preview_parts.py`, `preview_prop.py`), and make one fix per preview. Look at each part upright, and also posed:
   - Items: preview them held at clip frames with `preview_prop.py --hand`. Upright hides mount faults.
   - Characters: `preview_parts.py` shows only the T-pose, which hides cloth faults. Before the full build, render a `build.py --fast` build with `render.py` at its default pose (`idle`, frame 20, arms down).

   Done when every part reads right both upright and posed.
4. **Build** with `build.sh`. Then render a close-up and a game-scale view (held, or in the line-up). Done when both are clean. Bake creases show only close up; mount and scale faults show only in the game-scale view.
5. **Clip check** after every build: `clip_check.py` for characters, `prop_check.py` for items. Run it on the old model too. Render the worst three flags before acting: twice in the tests, a flag (or a missing one) came from the checker. Done when every flag is explained as the model's, the mount's or clip's, or the checker's, and each of the model's own flags is fixed or reported.
6. **Codex review** (gpt-6.1-sol) of the recipe and any tool change, before the final build. Save it under `docs/reviews/`.
7. **Contact sheet** (`contact_sheet.py`): turnarounds, close-ups, a same-scale line-up, and the model in the game look next to today's model. It is the closing gate. Save it, with the stats and clip-check JSON, next to a short report under `docs/reports/`.

## Running Blender

- Run every script as `blender -b --disable-autoexec --factory-startup --python-exit-code 1 --python <script> -- <args>`. Without `--python-exit-code 1`, a Python error still exits 0.
- Run builds under `nice -n 10`, in the background, one Blender process at a time, after checking `uptime`. The Mac has 16 GB, other threads run town builds and browser tests on it, and it rebooted on 2026-10-21 when three heavy sessions ran together.
- Outputs go under `/tmp`, and a reboot wipes them. Copy everything a report cites into the repo next to the report.

## Reference

**Budgets.**
- Characters: about 14–16k triangles, a 1024² albedo and normal map, a 512² Low set.
- Held props: about 1.7–2.2k triangles, a 512² albedo and normal map, a 256² Low set. That comes to about 150 KB per prop at 512², or about 90 KB at 256².
- GLBs go through the same `gltf-transform` flags as `chars3d/build.sh`.

**Weapon space** (glTF axes): the origin is at the grip, +Z points to the tip or head, +Y is up at rest (the edge side for blades), and +X is right. In Blender a point (x, y, z) is (x, −z, y). Long weapons run along +Z, bows included: limbs along +Z, the back towards −X, the string at +X. `hold.py` copies the client's right-hand socket and its axes. Keep it in step with `Avatars.ts`.

**Clips.**
- `starters_anims.glb` is a bare node tree: Blender imports it as empties, not an armature. Pose an armature from it with `props3d/clips.py`.
- Set the scene to 30 fps. At Blender's factory 24 fps, every requested frame lands at the wrong moment.
- A character with extra bones gets its own clips file: `mage_anims.py` adds its clips and `swing.py` bakes the follow-through.

**Recipe knobs.** `Part` (`chars3d/part.py`) sets each part's `vox` (meshing detail), `tris` (budget), `texel` (texture density), `role` (the palette slot: fixed, primary, secondary or accent) and `cull_eps` (how deep cut edges sink into other parts). For props, setting `part.uv_bands` after construction cuts long UV islands into bands. For helpers, see:
- sculpt: `chars3d/sdf.py`, `props3d/shapes.py`;
- paint: `chars3d/paint.py`, `props3d/ppaint.py`.

**Lessons from the tests:**
- A shape's defining notch is what makes it read. An axe beard's underside must scoop above the straight line, or it reads as a generic broad axe.
- Keep grain noise along a shaft stretched and under a millimetre, or the shaft reads as bamboo. Divide any displacement by a conservative slope bound, so the field stays a distance.
- Build thin curved parts (tines, strings) as splines through smooth tubes. Polyline corners show.
- Give hanging parts chain weights with a reach falloff. Garments follow the forearm, not the hand. Split wide panels into left and right halves (#64).
- In the swing bake, gravity acts only as far as the parent has turned since rest, and loops settle before they are recorded and eased.
- On thin blades, the bake's normal-agreement guard keeps projections off the far face. The cheeks still crease close up (#59).
- A square texture wastes most of itself on a long prop, and `uv_bands` helps only a little (#60).
- The clip checkers sample whole triangles, because long faces hide between vertices. They report depths at the client's model scale.

## Known gaps

#54 tracks what the tests left open, ticket by ticket. Check it before relying on these:

- The props tools read a reference folder that so far lived only in `/tmp`. The dump of today's code-built weapons has no script in the repo yet (#57).
- The game doesn't load sculpted weapons yet (#61), nor a character's own clips and extra bones (#65).
