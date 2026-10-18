# FIRSTLIGHT sculpted characters: bake follow-through for a character's extra bones (hood tips, braids,
# cloth panels, hanging props) into every clip. The shared clips never key these bones, so without this
# they would hang rigidly from their parents.
#
# Each chain is a damped spring per bone, simulated on the bone's tail in world space and written back
# as keyed rotations:
#   target  = the direction the bone would point if it followed its parent rigidly, bent back towards
#             world down by as much as the parent has turned away from its rest pose (the rest pose
#             already hangs), and pushed back by the "air" of the clip's locomotion speed (clips play
#             in place),
#   spring  = stiffness towards the target, damping on the tail velocity, fixed bone length,
#   limits  = a maximum angle from the rigid-follow direction, and capsule colliders on the body's bones
#             (thighs, calves, chest) the tail can't enter.
# Looping clips are simulated twice and the second pass is kept, so the end flows back into the start.
# Our own code: MIT.

import math

import bpy
from mathutils import Vector

FPS = 30
SUBSTEPS = 4

# clip -> (air speed m/s along +Y (the body moves -Y), vertical air m/s, loops)
CLIP_AIR = {
    "walk": (1.4, 0, True), "walk_mage": (1.2, 0, True), "run": (3.5, 0, True), "sprint": (6.0, 0, True),
    "swim": (1.5, 0, True), "swim_idle": (0, 0, True), "idle": (0, 0, True), "idle_mage": (0, 0, True),
    "fall": (0.5, 4.0, True), "emote_dance": (0, 0, True), "roll": (3.0, 0, False), "jump": (1.0, -2.0, False),
    "land": (0.5, 2.0, False), "block": (0, 0, True), "aim": (0, 0, True),
}


def _pose_seg(rig, name, length=None):
    """World segment of a posed bone; `length` overrides the (importer-guessed) bone length."""
    pb = rig.pose.bones[name]
    mw = rig.matrix_world
    h = mw @ pb.head
    if length is None:
        return h, mw @ pb.tail
    return h, h + (mw.to_3x3() @ pb.matrix.col[1].xyz).normalized() * length


def _closest_on_seg(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / max(ab.length_squared, 1e-9)))
    return a + ab * t


def _aim_world(rig, pb, direction):
    """Point the posed bone's Y axis along a world direction (minimal twist), via its pose matrix."""
    d_arm = (rig.matrix_world.inverted().to_3x3() @ direction).normalized()
    m = pb.matrix.copy()
    y_old = m.col[1].xyz.normalized()
    q = y_old.rotation_difference(d_arm)
    nm = (q.to_matrix() @ m.to_3x3()).to_4x4()
    nm.translation = m.translation
    pb.matrix = nm


def _follow(rig, pb):
    """(world direction of the bone if it followed its parent rigidly, world rotation of the parent
    from its rest pose to now). The second one says where the rest pose's "down" has gone."""
    par = pb.parent
    m = par.matrix @ (par.bone.matrix_local.inverted() @ pb.bone.matrix_local)
    mw3 = rig.matrix_world.to_3x3()
    delta = mw3 @ (par.matrix.to_3x3() @ par.bone.matrix_local.to_3x3().inverted()) @ mw3.inverted()
    return (mw3 @ m.col[1].xyz).normalized(), delta


def bake(rig, actions, chains, log=print):
    """chains: [{"bones": [...], "stiff": k, "damp": c, "gravity": g, "drag": d, "max_deg": a,
    "colliders": [(bone, radius) or (bone, radius, length), ...]}]. Keys rotation_quaternion on every frame of every action."""
    sc = bpy.context.scene
    sc.render.fps = FPS
    down = Vector((0, 0, -1))
    names = [b for ch in chains for b in ch["bones"]]
    for pb in rig.pose.bones:
        if pb.name in names:
            pb.rotation_mode = "QUATERNION"
    for act in actions:
        ad = rig.animation_data or rig.animation_data_create()
        ad.action = act
        if act.slots:
            ad.action_slot = act.slots[0]
        # drop any previous keys on the swing bones
        from bpy_extras import anim_utils
        cb = anim_utils.action_get_channelbag_for_slot(act, act.slots[0])
        for fc in list(cb.fcurves):
            if any(f'pose.bones["{b}"]' in fc.data_path for b in names):
                cb.fcurves.remove(fc)
        f0, f1 = (int(round(x)) for x in act.frame_range)
        air_y, air_z, loops = CLIP_AIR.get(act.name, (0.0, 0.0, False))
        air = Vector((0, air_y, air_z))
        frames = list(range(f0, f1 + 1))
        passes = [frames, frames] if loops else [[f0] * 20, frames]
        state = {}  # bone -> (tail position, velocity)
        dt = 1.0 / FPS / SUBSTEPS
        rec = {}
        for pi, seq in enumerate(passes):
            for f in seq:
                sc.frame_set(f)
                for pb_name in names:
                    rig.pose.bones[pb_name].rotation_quaternion = (1, 0, 0, 0)
                bpy.context.view_layer.update()
                for ch in chains:
                    cols = [(_pose_seg(rig, c[0], c[2] if len(c) > 2 else None), c[1]) for c in ch.get("colliders", [])]
                    for bname in ch["bones"]:
                        pb = rig.pose.bones[bname]
                        H = rig.matrix_world @ pb.head
                        L = pb.bone.length * rig.matrix_world.to_scale()[1]
                        fd, delta = _follow(rig, pb)
                        # the rest pose already hangs: gravity only pulls back towards world down by as much
                        # as the parent has turned "down" away since the rest pose
                        g_bias = down - delta @ down
                        tdir = (fd + g_bias * ch.get("gravity", 0.3) + air * ch.get("drag", 0.0) * 0.1).normalized()
                        T = H + tdir * L
                        p, v = state.get(bname, (T.copy(), Vector((0, 0, 0))))
                        for _ in range(SUBSTEPS):
                            a = (T - p) * ch["stiff"] - v * ch["damp"]
                            v = v + a * dt
                            p = p + v * dt
                            # fixed length
                            p = H + (p - H).normalized() * L
                            # angle limit around the rigid-follow direction
                            d = (p - H).normalized()
                            ang = d.angle(fd, 0.0)
                            lim = math.radians(ch.get("max_deg", 45))
                            if ang > lim:
                                axis = fd.cross(d)
                                if axis.length > 1e-6:
                                    from mathutils import Quaternion
                                    d = Quaternion(axis.normalized(), lim) @ fd
                                    p = H + d * L
                                    v = v * 0.5
                            # colliders: push the bone's middle and tail out of each capsule (a long panel can
                            # cross a shin with its middle while its tail is clear)
                            for _ in range(2):
                                for (a0, b0), r in cols:
                                    for t in (0.5, 1.0):
                                        x = H + (p - H) * t
                                        q = _closest_on_seg(x, a0, b0)
                                        off = x - q
                                        if off.length < r:
                                            n = off.normalized() if off.length > 1e-6 else (H - q).normalized()
                                            x = q + n * r
                                            p = H + (x - H).normalized() * L
                                            v = v - n * min(0.0, v.dot(n))
                        state[bname] = (p, v)
                        _aim_world(rig, pb, p - H)
                        bpy.context.view_layer.update()
                if pi == len(passes) - 1:
                    rec[f] = {b: rig.pose.bones[b].rotation_quaternion.copy() for b in names}
        for f, qs in rec.items():
            for b, q in qs.items():
                pb = rig.pose.bones[b]
                pb.rotation_quaternion = q
                pb.keyframe_insert("rotation_quaternion", frame=f)
        log(f"SWING {act.name}: {len(rec)} frames, loop={loops}, air=({air_y}, {air_z})")
