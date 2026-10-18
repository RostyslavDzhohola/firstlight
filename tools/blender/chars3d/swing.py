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
# Looping clips settle over up to six cycles of their unique frames, then one cycle is recorded and its last
# quarter eased into the first frame, so the end flows back into the start.
# Our own code: MIT.

import math

import bpy
from mathutils import Quaternion, Vector

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


def _limit(p, H, fd, L, lim):
    """Clamp the tail p to the cone of half-angle lim around fd; True if it had to move."""
    d = (p - H).normalized()
    if d.angle(fd, 0.0) <= lim:
        return p, False
    axis = fd.cross(d)
    if axis.length < 1e-6:
        return H + fd * L, True
    return H + (Quaternion(axis.normalized(), lim) @ fd) * L, True


def _collide(p, H, L, cols, samples=(0.5, 1.0)):
    """Rotate the bone (fixed length) so its sample points leave every capsule. A sample at fraction t
    pushed to x' turns the bone towards x': it lands on the ray H->x' at t*L, which may still be short of
    the surface, so callers iterate. Returns (tail, push normal or None)."""
    n_last = None
    for (a0, b0), r in cols:
        for t in samples:
            x = H + (p - H) * t
            q = _closest_on_seg(x, a0, b0)
            off = x - q
            if off.length < r:
                n = off.normalized() if off.length > 1e-6 else (H - q).normalized()
                p = H + (q + n * r - H).normalized() * L
                n_last = n
    return p, n_last


def _depth(p, H, cols, samples=(0.5, 1.0)):
    worst = 0.0
    for (a0, b0), r in cols:
        for t in samples:
            x = H + (p - H) * t
            worst = max(worst, r - (x - _closest_on_seg(x, a0, b0)).length)
    return worst


def bake(rig, actions, chains, lengths=None, log=print):
    """chains: [{"bones": [...], "stiff": k, "damp": c, "gravity": g, "drag": d, "max_deg": a,
    "colliders": [(bone, radius) or (bone, radius, length), ...]}]. lengths: {bone: metres} from the
    recipe (the glTF importer guesses bone lengths, glTF has no tails). Keys rotation_quaternion on every
    frame of every action. Returns {clip: {"seam_deg": worst loop seam, "unsolved": frames left inside a
    collider or outside the angle limit}}."""
    sc = bpy.context.scene
    sc.render.fps = FPS
    down = Vector((0, 0, -1))
    names = [b for ch in chains for b in ch["bones"]]
    lengths = lengths or {}
    stats = {}
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
        # loops: the last frame repeats the first, so simulate the unique frames only, settle over several
        # cycles until the state stops changing, then record one cycle
        frames = list(range(f0, f1)) if loops else list(range(f0, f1 + 1))
        state = {}  # bone -> (tail position, velocity)
        dt = 1.0 / FPS / SUBSTEPS
        unsolved = 0

        def step(f, record):
            nonlocal unsolved
            sc.frame_set(f)
            for pb_name in names:
                rig.pose.bones[pb_name].rotation_quaternion = (1, 0, 0, 0)
            bpy.context.view_layer.update()
            for ch in chains:
                cols = [(_pose_seg(rig, c[0], c[2] if len(c) > 2 else None), c[1]) for c in ch.get("colliders", [])]
                lim = math.radians(ch.get("max_deg", 45))
                for bname in ch["bones"]:
                    pb = rig.pose.bones[bname]
                    H = rig.matrix_world @ pb.head
                    L = lengths.get(bname, pb.bone.length * rig.matrix_world.to_scale()[1])
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
                        p = H + ((p + v * dt) - H).normalized() * L
                        # constraints solved together: alternate collision and angle limit a few times;
                        # the angle limit is applied last, so it always holds
                        for _ in range(4):
                            p, n = _collide(p, H, L, cols)
                            if n is not None:
                                v = v - n * min(0.0, v.dot(n))
                            p, moved = _limit(p, H, fd, L, lim)
                            if moved:
                                v = v * 0.5
                            if n is None and not moved:
                                break
                    if record and _depth(p, H, cols) > 0.01:
                        unsolved += 1
                    state[bname] = (p, v)
                    _aim_world(rig, pb, p - H)
                    bpy.context.view_layer.update()
            if record:
                return {b: rig.pose.bones[b].rotation_quaternion.copy() for b in names}

        if loops:
            prev = None
            for _ in range(6):
                for f in frames:
                    step(f, False)
                snap = {b: state[b][0].copy() for b in names}
                if prev and max((snap[b] - prev[b]).length for b in names) < 0.002:
                    break
                prev = snap
        else:
            for _ in range(20):
                step(f0, False)
        rec = {f: step(f, True) for f in frames}
        seam = 0.0
        if loops:
            # close the seam: ease the last quarter (at most 8 frames) towards the first frame
            first = rec[f0]
            for b in names:
                seam = max(seam, math.degrees(rec[frames[-1]][b].rotation_difference(first[b]).angle))
            n = max(1, min(8, len(frames) // 4))
            for i, f in enumerate(frames[-n:], start=1):
                w = i / (n + 1)
                rec[f] = {b: rec[f][b].slerp(first[b], w) for b in names}
            rec[f1] = {b: first[b].copy() for b in names}
        for f, qs in rec.items():
            for b, q in qs.items():
                pb = rig.pose.bones[b]
                pb.rotation_quaternion = q
                pb.keyframe_insert("rotation_quaternion", frame=f)
        stats[act.name] = {"seam_deg_before_ease": round(seam, 1), "unsolved_bone_frames": unsolved}
        log(f"SWING {act.name}: {len(rec)} frames, loop={loops}, air=({air_y}, {air_z}), "
            f"seam before ease {seam:.1f} deg, unsolved {unsolved}")
    return stats
