# FIRSTLIGHT starter animation set: picks and renames clips from the Quaternius Universal Animation
# Library 1 + 2 (CC0, identical rigs) and authors the missing emotes (wave, point, cheer) on top of the
# idle. Exports one GLB holding the bare skeleton + all clips; every starter GLB binds by bone name.
#
#   blender -b --disable-autoexec --factory-startup --python build_anims.py -- \
#       --ual1 UAL1_Standard.glb --ual2 UAL2_Standard.glb --out starters_anims.glb
#
# Authored emotes are our own work (CC BY 4.0); the picked clips stay CC0 (Quaternius).

import argparse
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
from bpy_extras import anim_utils  # noqa: E402
from mathutils import Vector, Quaternion  # noqa: E402

import fl_rig as R  # noqa: E402

FPS = 30

# our clip name -> (pack, source clip)
CLIPS = {
    "idle": (1, "Idle_Loop"),
    "walk": (1, "Walk_Loop"),
    "run": (1, "Jog_Fwd_Loop"),
    "sprint": (1, "Sprint_Loop"),
    "jump": (1, "Jump_Start"),
    "fall": (1, "Jump_Loop"),
    "land": (1, "Jump_Land"),
    "swim": (1, "Swim_Fwd_Loop"),
    "swim_idle": (1, "Swim_Idle_Loop"),
    "roll": (1, "Roll"),
    "melee_light": (2, "Sword_Regular_A"),
    "melee_heavy": (2, "Sword_Regular_C"),
    "block": (2, "Sword_Block"),
    "punch": (1, "Punch_Jab"),
    "punch_heavy": (1, "Punch_Cross"),
    "aim": (1, "Pistol_Aim_Neutral"),
    "shoot": (1, "Pistol_Shoot"),
    "cast": (1, "Spell_Simple_Shoot"),
    "throw": (2, "OverhandThrow"),
    "hit": (1, "Hit_Chest"),
    "hit_heavy": (2, "Hit_Knockback"),
    "death": (1, "Death01"),
    "emote_dance": (1, "Dance_Loop"),
}

V = Vector


def find_action(name, pool):
    for a in pool:
        base = a.name.split("|")[-1]
        if a.name == name or base == name:
            return a
    for a in pool:
        if a.name.startswith(name):
            return a
    raise KeyError(name)


def channelbag(action):
    return anim_utils.action_get_channelbag_for_slot(action, action.slots[0])


def import_actions(path):
    before_obj = set(bpy.data.objects)
    before_act = set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=path)
    new_act = [a for a in bpy.data.actions if a not in before_act]
    for a in new_act:
        a.use_fake_user = True
    new_obj = [o for o in bpy.data.objects if o not in before_obj]
    return new_obj, new_act


def assign(rig, action):
    ad = rig.animation_data or rig.animation_data_create()
    ad.action = action
    if action.slots:
        ad.action_slot = action.slots[0]


def aim(rig, bname, direction):
    """Rotate a posed bone (minimal twist) so its Y axis points along `direction` (armature space)."""
    pb = rig.pose.bones[bname]
    m = pb.matrix.copy()
    y_old = m.col[1].xyz.normalized()
    q = y_old.rotation_difference(direction.normalized())
    nm = (q.to_matrix() @ m.to_3x3()).to_4x4()
    nm.translation = m.translation
    pb.matrix = nm
    bpy.context.view_layer.update()


def author(rig, base, name, bones, keys, length=None, straight=()):
    """New clip = base clip with `bones` re-keyed. keys: [(frame, {bone: direction or None})];
    None means 'take the base clip's pose at this frame'. `straight` bones are keyed at rest
    rotation on every non-None key."""
    sc = bpy.context.scene
    assign(rig, base)
    sampled = {}
    for f, _ in keys:
        sc.frame_set(f)
        sampled[f] = {b: rig.pose.bones[b].rotation_quaternion.copy() for b in list(bones) + list(straight)}
    act = base.copy()
    act.name = name
    act.use_fake_user = True
    cb = channelbag(act)
    for fc in list(cb.fcurves):
        if any(f'pose.bones["{b}"]' in fc.data_path for b in list(bones) + list(straight)):
            cb.fcurves.remove(fc)
    assign(rig, act)
    for f, targets in keys:
        sc.frame_set(f)
        if targets is None:
            for b in list(bones) + list(straight):
                rig.pose.bones[b].rotation_quaternion = sampled[f][b]
            bpy.context.view_layer.update()
        else:
            for b in bones:
                rig.pose.bones[b].rotation_quaternion = sampled[f][b]
            bpy.context.view_layer.update()
            for b in bones:  # parents first (order given)
                if b in targets:
                    aim(rig, b, targets[b])
            for b in straight:
                rig.pose.bones[b].rotation_quaternion = Quaternion()
        for b in list(bones) + list(straight):
            rig.pose.bones[b].keyframe_insert("rotation_quaternion", frame=f)
    return act


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    ap = argparse.ArgumentParser()
    ap.add_argument("--ual1", required=True)
    ap.add_argument("--ual2", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    R.reset()
    sc = bpy.context.scene
    sc.render.fps = FPS
    objs1, acts1 = import_actions(a.ual1)
    rig = next(o for o in objs1 if o.type == "ARMATURE")
    for o in objs1:
        if o is not rig:
            bpy.data.objects.remove(o, do_unlink=True)
    rig.name = R.RIG_NAME
    rig.data.name = R.RIG_NAME
    objs2, acts2 = import_actions(a.ual2)
    for o in objs2:
        bpy.data.objects.remove(o, do_unlink=True)
    keep = {}
    for ours, (pack, src) in CLIPS.items():
        act = find_action(src, acts1 if pack == 1 else acts2)
        keep[ours] = act
    idle = keep["idle"]
    up = V((0, 0, 1))

    # wave: right arm up, forearm swinging side to side
    def wave_pose(sw):
        return {"upperarm_r": V((-0.55, -0.12, 0.82)), "lowerarm_r": V((-0.1 + sw, -0.18, 0.95)),
                "hand_r": V((-0.1 + sw * 1.3, -0.25, 0.92))}
    wave_keys = [(0, None), (9, wave_pose(0.0)), (15, wave_pose(0.38)), (21, wave_pose(-0.3)), (27, wave_pose(0.38)),
                 (33, wave_pose(-0.3)), (39, wave_pose(0.38)), (46, wave_pose(0.05)), (62, None), (74, None)]
    keep["emote_wave"] = author(rig, idle, "emote_wave", ["upperarm_r", "lowerarm_r", "hand_r"], wave_keys)

    # point: right arm straight out ahead, index finger straight
    pt = {"upperarm_r": V((-0.28, -0.95, 0.12)), "lowerarm_r": V((-0.12, -1.0, 0.16)), "hand_r": V((-0.1, -1.0, 0.14))}
    pt2 = {"upperarm_r": V((-0.3, -0.95, 0.16)), "lowerarm_r": V((-0.14, -1.0, 0.2)), "hand_r": V((-0.12, -1.0, 0.18))}
    keep["emote_point"] = author(rig, idle, "emote_point", ["upperarm_r", "lowerarm_r", "hand_r"],
                                 [(0, None), (8, pt), (22, pt2), (48, pt), (62, None), (74, None)],
                                 straight=("index_01_r", "index_02_r", "index_03_r"))

    # cheer: both arms thrown up, pumping three times
    def cheer(up_amt):
        if up_amt:
            return {"upperarm_l": V((0.42, -0.12, 0.9)), "lowerarm_l": V((0.2, -0.12, 1.0)), "hand_l": V((0.2, -0.1, 1.0)),
                    "upperarm_r": V((-0.42, -0.12, 0.9)), "lowerarm_r": V((-0.2, -0.12, 1.0)), "hand_r": V((-0.2, -0.1, 1.0))}
        return {"upperarm_l": V((0.75, -0.15, 0.55)), "lowerarm_l": V((0.15, -0.3, 1.0)), "hand_l": V((0.1, -0.3, 1.0)),
                "upperarm_r": V((-0.75, -0.15, 0.55)), "lowerarm_r": V((-0.15, -0.3, 1.0)), "hand_r": V((-0.1, -0.3, 1.0))}
    bones = ["upperarm_l", "lowerarm_l", "hand_l", "upperarm_r", "lowerarm_r", "hand_r"]
    keep["emote_cheer"] = author(rig, idle, "emote_cheer", bones,
                                 [(0, None), (7, cheer(True)), (13, cheer(False)), (19, cheer(True)), (25, cheer(False)),
                                  (31, cheer(True)), (44, cheer(True)), (60, None), (74, None)])

    # drop everything else, rename, export the bare skeleton + clips
    keep_set = set(keep.values())
    for act in list(bpy.data.actions):
        if act not in keep_set:
            bpy.data.actions.remove(act)
    for ours, act in keep.items():
        act.name = ours
    rig.animation_data.action = None
    for pb in rig.pose.bones:
        pb.matrix_basis.identity()
    for o in bpy.context.scene.objects:
        o.select_set(o is rig)
    bpy.context.view_layer.objects.active = rig
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=a.out, export_format="GLB", use_selection=True, export_animations=True,
        export_animation_mode="ACTIONS", export_force_sampling=True, export_optimize_animation_size=True,
        export_anim_single_armature=True, export_reset_pose_bones=True, export_skins=True, export_morph=False,
        export_materials="NONE", export_def_bones=False, export_leaf_bone=False, export_yup=True,
        export_rest_position_armature=True)
    print("ANIMS", len(keep), sorted(keep))


main()
