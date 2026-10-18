# FIRSTLIGHT sculpted characters: clip check. Plays every clip on a built character and flags hands and
# hanging props that pass into the body.
#
#   blender -b --disable-autoexec --factory-startup --python-exit-code 1 --python clip_check.py -- \
#       --char <raw>/mage.glb --anims <raw>/mage_anims.glb --recipe mage --out <dir>/clipcheck.json
#
# 1. Rest pose first: the character's bind pose must match the shared skeleton's real rest pose
#    (rig_rest.json, dumped from the CC0 rig), never the first frame of some clip. A character bound to a
#    clip's first frame looks right in that clip and wrong in all the others (hands through the body).
#    Extra bones must match the recipe's EXTRA_BONES.
# 2. Then every clip, every 2nd frame: the skinned mesh is evaluated and each watched vertex set (hands,
#    and the recipe's props) is tested against capsules around the BODY under the clothes (spine, head,
#    thighs, calves). Penetration = capsule radius - distance. The rest pose gives a baseline per pair.
#    A pair is flagged when it goes deeper than the tolerance past its baseline.
# Our own code: MIT.

import argparse
import importlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import bpy  # noqa: E402
import numpy as np  # noqa: E402

from skel import Skel  # noqa: E402

F = np.float32

# body capsules under the clothes: (name, from bone, to bone or (bone, metres along its Y), radius)
BODY = [
    ("pelvis", "pelvis", "spine_01", 0.115),
    ("belly", "spine_01", "spine_02", 0.105),
    ("chest", "spine_02", "spine_03", 0.105),
    ("upper_chest", "spine_03", "neck_01", 0.095),
    ("head", "Head", ("Head", 0.2), 0.095),
    ("thigh_l", "thigh_l", "calf_l", 0.07),
    ("thigh_r", "thigh_r", "calf_r", 0.07),
    ("calf_l", "calf_l", "foot_l", 0.05),
    ("calf_r", "calf_r", "foot_r", 0.05),
    ("upperarm_l", "upperarm_l", "lowerarm_l", 0.05),
    ("upperarm_r", "upperarm_r", "lowerarm_r", 0.05),
    ("forearm_l", "lowerarm_l", "hand_l", 0.04),
    ("forearm_r", "lowerarm_r", "hand_r", 0.04),
]
SKIP = {("hand_l", "forearm_l"), ("hand_r", "forearm_r"), ("hand_l", "upperarm_l"), ("hand_r", "upperarm_r")}
FINGERS = [f"{f}_0{i}_{s}" for f in ("index", "middle", "ring", "pinky", "thumb") for i in (1, 2, 3) for s in "lr"]
SETS_DEFAULT = {
    "hand_l": (["hand_l"] + [b for b in FINGERS if b.endswith("_l")], 0.02),
    "hand_r": (["hand_r"] + [b for b in FINGERS if b.endswith("_r")], 0.02),
}


def import_glb(path):
    before = set(bpy.data.objects)
    acts_before = set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.data.objects if o not in before], [a for a in bpy.data.actions if a not in acts_before]


def seg_dist(P, a, b):
    ab = b - a
    t = np.clip(((P - a) @ ab) / max(float(ab @ ab), 1e-9), 0, 1)
    return np.linalg.norm(P - (a + t[:, None] * ab), axis=1)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    ap = argparse.ArgumentParser()
    ap.add_argument("--char", required=True)
    ap.add_argument("--anims", required=True)
    ap.add_argument("--recipe", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--step", type=int, default=2)
    a = ap.parse_args(argv)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.fps = 30
    objs, _ = import_glb(a.char)
    rig = next(o for o in objs if o.type == "ARMATURE")
    mesh = next(o for o in objs if o.type == "MESH" and o.parent is rig)
    for o in objs:
        if o not in (rig, mesh):
            bpy.data.objects.remove(o, do_unlink=True)
    aobjs, actions = import_glb(a.anims)
    for o in aobjs:
        bpy.data.objects.remove(o, do_unlink=True)
    for act in actions:
        act.use_fake_user = True
    report = {"char": os.path.basename(a.char), "rest": {}, "clips": {}, "flags": []}

    # 1. rest pose against the shared skeleton's real rest (not a clip's first frame)
    sk = Skel()
    mw = rig.matrix_world
    dev = {}
    for n in sk.names():
        if n not in rig.data.bones:
            dev[n] = None
            continue
        h = np.array(mw @ rig.data.bones[n].head_local, F)
        dev[n] = float(np.linalg.norm(h - sk.head(n)))
    missing = [n for n, d in dev.items() if d is None]
    worst = max((d, n) for n, d in dev.items() if d is not None)
    report["rest"]["shared_bones_missing"] = missing
    report["rest"]["shared_bones_max_dev_m"] = round(worst[0], 5)
    report["rest"]["shared_bones_worst"] = worst[1]
    extra = {}
    sets = dict(SETS_DEFAULT)
    if a.recipe:
        rec = importlib.import_module(f"recipes.{a.recipe}")
        for n, (par, head, tail) in getattr(rec, "EXTRA_BONES", {}).items():
            b = rig.data.bones.get(n)
            extra[n] = None if b is None else round(float(np.linalg.norm(np.array(mw @ b.head_local, F) - np.array(head, F))), 5)
        sets.update(getattr(rec, "CLIP_CHECK_SETS", {}))
    report["rest"]["extra_bones_dev_m"] = extra
    ok_rest = not missing and worst[0] < 0.002 and all(v is not None and v < 0.002 for v in extra.values())
    report["rest"]["ok"] = ok_rest
    # the first frames of the clips, for the record: how far each clip's frame 0 is from the rest pose
    # (this is what binding to "frame 0" would have baked into the mesh)
    f0dev = {}
    for act in actions:
        rig.animation_data_create()
        rig.animation_data.action = act
        if act.slots:
            rig.animation_data.action_slot = act.slots[0]
        sc.frame_set(int(act.frame_range[0]))
        f0dev[act.name] = round(max(float((mw @ rig.pose.bones[n].head - mw @ rig.data.bones[n].head_local).length)
                                    for n in ("hand_l", "hand_r", "lowerarm_l", "lowerarm_r")), 3)
    report["rest"]["clip_frame0_hand_offset_from_rest_m"] = f0dev
    print("CLIPCHECK rest ok" if ok_rest else "CLIPCHECK rest FAILED", worst, missing, extra, flush=True)

    # 2. vertex sets by dominant weight
    me = mesh.data
    names = [g.name for g in mesh.vertex_groups]
    dom = np.full(len(me.vertices), -1)
    best = np.zeros(len(me.vertices), F)
    for v in me.vertices:
        for g in v.groups:
            if g.weight > best[v.index]:
                best[v.index] = g.weight
                dom[v.index] = g.group
    dom_name = np.array([names[i] if i >= 0 else "" for i in dom])
    idx = {k: np.nonzero(np.isin(dom_name, bones))[0] for k, (bones, _) in sets.items()}
    report["sets"] = {k: int(len(v)) for k, v in idx.items()}

    def body_caps():
        out = []
        for name, b0, b1, r in BODY:
            pa = np.array(mw @ rig.pose.bones[b0].head, F)
            if isinstance(b1, tuple):
                pb_ = rig.pose.bones[b1[0]]
                y = (mw.to_3x3() @ pb_.matrix.col[1].xyz).normalized()
                pb = pa + np.array(y, F) * F(b1[1])
            else:
                pb = np.array(mw @ rig.pose.bones[b1].head, F)
            out.append((name, pa, pb, r))
        return out

    def depths():
        dg = bpy.context.evaluated_depsgraph_get()
        ev = mesh.evaluated_get(dg)
        m = ev.to_mesh()
        co = np.empty(len(m.vertices) * 3, F)
        m.vertices.foreach_get("co", co)
        ev.to_mesh_clear()
        co = co.reshape(-1, 3)
        M = np.array(mesh.matrix_world, F)
        co = co @ M[:3, :3].T + M[:3, 3]
        res = {}
        for name, pa, pb, r in body_caps():
            for k, ids in idx.items():
                if not len(ids) or (k, name) in SKIP:
                    continue
                d = r - seg_dist(co[ids], pa, pb)
                res[(k, name)] = float(d.max())
        return res

    rig.animation_data.action = None
    for pb in rig.pose.bones:
        pb.matrix_basis.identity()
    sc.frame_set(0)
    base = depths()
    report["baseline_rest"] = {f"{k}|{c}": round(v, 4) for (k, c), v in base.items() if v > -0.05}
    for act in sorted(actions, key=lambda x: x.name):
        rig.animation_data.action = act
        if act.slots:
            rig.animation_data.action_slot = act.slots[0]
        f0, f1 = (int(round(x)) for x in act.frame_range)
        worst_pairs = {}
        for f in range(f0, f1 + 1, a.step):
            sc.frame_set(f)
            for key, d in depths().items():
                over = d - max(base.get(key, -1.0), 0.0)
                if over > worst_pairs.get(key, (-9, 0))[0]:
                    worst_pairs[key] = (over, f)
        flags = []
        for (k, c), (over, f) in worst_pairs.items():
            tol = sets[k][1]
            if over > tol:
                flags.append({"set": k, "body": c, "depth_m": round(over, 3), "frame": f})
        flags.sort(key=lambda x: -x["depth_m"])
        top = max(worst_pairs.items(), key=lambda kv: kv[1][0])
        report["clips"][act.name] = {"frames": f1 - f0 + 1, "flags": flags,
                                     "worst": {"set": top[0][0], "body": top[0][1], "depth_m": round(top[1][0], 3),
                                               "frame": top[1][1]}}
        for fl in flags:
            report["flags"].append(dict(fl, clip=act.name))
        print("CLIPCHECK", act.name, "OK" if not flags else f"{len(flags)} flags", flags[:3], flush=True)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w") as fh:
        json.dump(report, fh, indent=1)
    print("CLIPCHECK DONE", len(report["flags"]), "flags over", len(report["clips"]), "clips", flush=True)


main()
