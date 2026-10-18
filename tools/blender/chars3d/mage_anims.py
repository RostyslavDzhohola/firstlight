# FIRSTLIGHT sculpted characters: the mage test character's clip set. Takes the shared starter clips,
# adds three signature clips keyframed here (a personality idle, a cast with a visible wind-up, a walk
# with attitude), then bakes follow-through for the mage's extra bones (swing.py) into every clip and
# exports one GLB with the mage skeleton (65 shared joints + the extras) and all clips.
#
#   blender -b --disable-autoexec --factory-startup --python-exit-code 1 --python mage_anims.py -- \
#       --mage <raw>/mage.glb --anims <raw>/starters_anims.glb --out <raw>/mage_anims.glb
#
# Authored clips and the baked swing tracks are our own work (CC BY 4.0); the shared clips stay CC0.
# Our own code: MIT.

import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import bpy  # noqa: E402
from bpy_extras import anim_utils  # noqa: E402
from mathutils import Quaternion, Vector  # noqa: E402

import swing  # noqa: E402

V = Vector

CHAINS = [
    {"bones": ["hood_01", "hood_02"], "stiff": 45, "damp": 7, "gravity": 0.5, "drag": 1.2, "max_deg": 45,
     "colliders": [("Head", 0.15, 0.24), ("neck_01", 0.1), ("spine_03", 0.14)]},
    {"bones": ["braid_01", "braid_02", "braid_03"], "stiff": 40, "damp": 6.5, "gravity": 0.45, "drag": 0.8,
     "max_deg": 40, "colliders": [("spine_03", 0.12), ("spine_02", 0.13), ("spine_01", 0.15), ("pelvis", 0.17),
                                   ("thigh_l", 0.12), ("upperarm_l", 0.08), ("lowerarm_l", 0.07)]},
    {"bones": ["panel_f_01", "panel_f_02"], "stiff": 55, "damp": 8, "gravity": 0.2, "drag": 1.2, "max_deg": 45,
     "colliders": [("thigh_l", 0.115), ("thigh_r", 0.115), ("calf_l", 0.085), ("calf_r", 0.085)]},
    {"bones": ["panel_b_01", "panel_b_02"], "stiff": 55, "damp": 8, "gravity": 0.2, "drag": 1.4, "max_deg": 45,
     "colliders": [("thigh_l", 0.115), ("thigh_r", 0.115), ("calf_l", 0.085), ("calf_r", 0.085)]},
    {"bones": ["sash_01", "sash_02"], "stiff": 32, "damp": 5, "gravity": 0.35, "drag": 1.5, "max_deg": 55,
     "colliders": [("thigh_l", 0.12), ("calf_l", 0.09)]},
    {"bones": ["lantern_01"], "stiff": 28, "damp": 3.5, "gravity": 0.6, "drag": 0.8, "max_deg": 50,
     "colliders": [("thigh_r", 0.13), ("lowerarm_r", 0.1), ("hand_r", 0.09, 0.15)]},
]


def channelbag(action):
    return anim_utils.action_get_channelbag_for_slot(action, action.slots[0])


def assign(rig, action):
    ad = rig.animation_data or rig.animation_data_create()
    ad.action = action
    if action.slots:
        ad.action_slot = action.slots[0]


def aim(rig, bname, direction):
    """Rotate a posed bone (minimal twist) so its Y axis points along a world direction."""
    pb = rig.pose.bones[bname]
    d = (rig.matrix_world.inverted().to_3x3() @ direction).normalized()
    m = pb.matrix.copy()
    q = m.col[1].xyz.normalized().rotation_difference(d)
    nm = (q.to_matrix() @ m.to_3x3()).to_4x4()
    nm.translation = m.translation
    pb.matrix = nm
    bpy.context.view_layer.update()


def author(rig, base, name, order, keys, end=None):
    """New clip = base clip with the bones in `order` re-keyed. keys: [(frame, {bone: world direction})];
    a bone missing from a key's dict takes the base clip's pose at that frame. Bones are aimed in `order`
    (parents first). end: trim every curve (base ones too) to this last frame."""
    sc = bpy.context.scene
    assign(rig, base)
    sampled = {}
    for f, _ in keys:
        sc.frame_set(f)
        sampled[f] = {b: rig.pose.bones[b].rotation_quaternion.copy() for b in order}
    act = base.copy()
    act.name = name
    act.use_fake_user = True
    cb = channelbag(act)
    for fc in list(cb.fcurves):
        if any(f'pose.bones["{b}"]' in fc.data_path for b in order):
            cb.fcurves.remove(fc)
    assign(rig, act)
    for f, targets in keys:
        sc.frame_set(f)
        for b in order:
            rig.pose.bones[b].rotation_quaternion = sampled[f][b]
        bpy.context.view_layer.update()
        for b in order:
            if b in targets:
                aim(rig, b, targets[b].normalized())
        for b in order:
            rig.pose.bones[b].keyframe_insert("rotation_quaternion", frame=f)
    if end is not None:
        for fc in channelbag(act).fcurves:
            while len(fc.keyframe_points) and fc.keyframe_points[-1].co.x > end + 1e-3:
                fc.keyframe_points.remove(fc.keyframe_points[-1])
            fc.update()
        act.frame_range = (0, end)
    # smooth, slightly eased motion between our keys
    for fc in channelbag(act).fcurves:
        if any(f'pose.bones["{b}"]' in fc.data_path for b in order):
            for kp in fc.keyframe_points:
                kp.interpolation = "BEZIER"
                kp.handle_left_type = kp.handle_right_type = "AUTO_CLAMPED"
            fc.update()
    return act


ARMS = ["upperarm_l", "lowerarm_l", "hand_l", "upperarm_r", "lowerarm_r", "hand_r"]
SPINE = ["spine_01", "spine_02", "spine_03", "neck_01", "Head"]


def folded(breath=0.0, tilt=0.0):
    """Hands folded in front of the waist, one over the other; a slight heron stoop."""
    b = breath
    return {
        "spine_02": V((0, -0.1 - b * 0.03, 1)), "spine_03": V((0, -0.16 + b * 0.04, 1)),
        "neck_01": V((tilt * 0.3, -0.28, 1)), "Head": V((tilt, -0.06, 1)),
        "upperarm_l": V((0.26, -0.26, -0.93)), "lowerarm_l": V((-0.6, -0.62, 0.36 + b * 0.03)),
        "hand_l": V((-0.7, -0.5, 0.2)),
        "upperarm_r": V((-0.24, -0.32, -0.92)), "lowerarm_r": V((0.62, -0.74, -0.06 + b * 0.03)),
        "hand_r": V((0.7, -0.6, -0.1)),
    }


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    ap = argparse.ArgumentParser()
    ap.add_argument("--mage", required=True)
    ap.add_argument("--anims", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", default="", help="comma list: bake only these clips (debug)")
    a = ap.parse_args(argv)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.fps = swing.FPS
    bpy.ops.import_scene.gltf(filepath=a.mage)
    rig = next(o for o in sc.objects if o.type == "ARMATURE")
    for o in list(sc.objects):
        if o is not rig:
            bpy.data.objects.remove(o, do_unlink=True)
    before = set(bpy.data.objects)
    acts_before = set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=a.anims)
    for o in set(bpy.data.objects) - before:
        bpy.data.objects.remove(o, do_unlink=True)
    clips = {act.name: act for act in bpy.data.actions if act not in acts_before}
    for act in clips.values():
        act.use_fake_user = True
    for pb in rig.pose.bones:
        pb.rotation_mode = "QUATERNION"

    idle, walk = clips["idle"], clips["walk"]
    li = int(idle.frame_range[1])
    lw = int(walk.frame_range[1])
    order = SPINE + ARMS
    # idle_mage: folded hands, slow breath, the head tilting to one side and back (a listening heron)
    k = [(0, folded(0, 0)), (int(li * 0.25), folded(1, 0.05)), (int(li * 0.5), folded(0, 0.14)),
         (int(li * 0.75), folded(1, 0.08)), (li, folded(0, 0))]
    new = {"idle_mage": author(rig, idle, "idle_mage", order, k)}

    # cast_mage: gather (lean back, right hand drawn up and back, left palm out) -> hold = the tell ->
    # strike (lean in, right palm thrust forward, left arm swept back) -> settle back to the folded idle
    gather = {"spine_02": V((0, 0.12, 1)), "spine_03": V((0.04, 0.16, 1)), "neck_01": V((0, -0.05, 1)),
              "Head": V((0, -0.12, 1)),
              "upperarm_r": V((-0.55, 0.38, 0.75)), "lowerarm_r": V((-0.25, 0.5, 0.85)), "hand_r": V((-0.15, 0.45, 0.9)),
              "upperarm_l": V((0.45, -0.78, -0.25)), "lowerarm_l": V((0.12, -0.95, 0.22)), "hand_l": V((0.08, -0.85, 0.5))}
    gather2 = dict(gather, spine_03=V((0.05, 0.2, 1)), upperarm_r=V((-0.5, 0.45, 0.8)), lowerarm_r=V((-0.2, 0.55, 0.85)))
    strike = {"spine_02": V((0, -0.22, 1)), "spine_03": V((-0.04, -0.3, 1)), "neck_01": V((0, -0.2, 1)),
              "Head": V((0, -0.05, 1)),
              "upperarm_r": V((-0.18, -0.96, 0.18)), "lowerarm_r": V((-0.04, -1, 0.14)), "hand_r": V((0.0, -0.9, 0.42)),
              "upperarm_l": V((0.42, 0.32, -0.85)), "lowerarm_l": V((0.25, 0.5, -0.82)), "hand_l": V((0.2, 0.5, -0.8))}
    k = [(0, folded()), (8, gather), (15, gather2), (19, strike), (25, strike), (40, folded(1)), (50, folded())]
    new["cast_mage"] = author(rig, idle, "cast_mage", order, k, end=50)

    # walk_mage: the shared walk's legs; hands stay folded, a forward stoop, the head bobbing with the steps
    def wpose(phase):
        p = folded(phase, 0.03 * (1 if phase > 0.5 else -1))
        p["spine_01"] = V((0, -0.08, 1))
        return p
    k = [(int(lw * t), wpose(ph)) for t, ph in ((0, 0), (0.25, 1), (0.5, 0), (0.75, 1), (1.0, 0))]
    new["walk_mage"] = author(rig, walk, "walk_mage", ["spine_01"] + order, k)
    clips.update(new)

    todo = [clips[n] for n in sorted(clips)] if not a.only else [clips[n] for n in a.only.split(",")]
    # spring lengths from the recipe: the glTF importer guesses bone lengths (glTF has no bone tails)
    import importlib
    import numpy as np
    spec = importlib.import_module("recipes.mage").EXTRA_BONES
    lengths = {n: float(np.linalg.norm(np.subtract(t, h))) for n, (_, h, t) in spec.items()}
    stats = swing.bake(rig, todo, CHAINS, lengths=lengths)
    with open(os.path.splitext(a.out)[0] + "_swing.json", "w") as fh:
        import json
        json.dump(stats, fh, indent=1)
    for act in bpy.data.actions:
        if act not in todo:
            bpy.data.actions.remove(act)
    rig.animation_data.action = None
    for pb in rig.pose.bones:
        pb.matrix_basis.identity()
    for o in sc.objects:
        o.select_set(o is rig)
    bpy.context.view_layer.objects.active = rig
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=a.out, export_format="GLB", use_selection=True, export_animations=True,
        export_animation_mode="ACTIONS", export_force_sampling=True, export_optimize_animation_size=True,
        export_anim_single_armature=True, export_reset_pose_bones=True, export_skins=True, export_morph=False,
        export_materials="NONE", export_def_bones=False, export_leaf_bone=False, export_yup=True,
        export_rest_position_armature=True)
    print("MAGE_ANIMS", len(todo), sorted(x.name for x in todo), flush=True)


main()
