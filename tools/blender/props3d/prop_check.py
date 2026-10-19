# FIRSTLIGHT sculpted props: clip check for a held prop. Plays shipped clips on a shipped character with
# the prop in the right-hand socket (as the client mounts it) and measures how deep the prop's vertices
# go into capsules around the body under the clothes (chars3d/clip_check.py's BODY, minus the holding
# arm). Run it on today's model too: a flag both share comes from the mount and the clip, not the model.
#
#   blender -b --disable-autoexec --factory-startup --python-exit-code 1 --python prop_check.py -- \
#       --char hexwick --prop emberglass [--dir <build dir> | --today] --clips idle,walk,cast --out <json>
#
# Our own code: MIT.

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "chars3d"))
sys.path.insert(0, HERE)

import bpy  # noqa: E402
import numpy as np  # noqa: E402

import bl  # noqa: E402
import hold  # noqa: E402
from clip_check import BODY, seg_dist  # noqa: E402
from clips import Clips  # noqa: E402

F = np.float32
HOLDING_ARM = {"upperarm_r", "forearm_r"}


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    ap = argparse.ArgumentParser()
    ap.add_argument("--char", required=True)
    ap.add_argument("--prop", required=True)
    ap.add_argument("--dir", default="")
    ap.add_argument("--today", action="store_true")
    ap.add_argument("--chars", default="/tmp/fl-props/ref")
    ap.add_argument("--clips", required=True)
    ap.add_argument("--step", type=int, default=2)
    ap.add_argument("--tol", type=float, default=0.02)
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    bl.reset()
    clips = Clips(os.path.join(a.chars, "starters_anims.glb"))
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(a.chars, f"{a.char}.glb"))
    new = set(bpy.data.objects) - before
    arm = next(o for o in new if o.type == "ARMATURE")
    for o in new:
        if o.type == "MESH":  # only the skeleton matters here; skinning every frame is slow
            bpy.data.objects.remove(o, do_unlink=True)
    if a.today:
        objs = hold.today_meshes("/tmp/fl-props/ref/today_weapons.json", a.prop)
    else:
        b0 = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=os.path.join(a.dir, f"{a.prop}.glb"))
        objs = [o for o in set(bpy.data.objects) - b0 if o.type == "MESH"]
    hold.hold(arm, objs, weapon_space_data=a.today)
    local = []
    for o in objs:
        co = np.empty(len(o.data.vertices) * 3, F)
        o.data.vertices.foreach_get("co", co)
        local.append((o, co.reshape(-1, 3)))
    mw = arm.matrix_world
    report = {"char": a.char, "prop": a.prop, "model": "today" if a.today else "new", "tol_m": a.tol, "clips": {}}
    total = 0
    for clip in a.clips.split(","):
        f0, f1 = clips.frames(clip)
        worst = {}
        for f in range(f0, f1 + 1, a.step):
            clips.pose([arm], clip, f)
            W = np.concatenate([co @ np.array(o.matrix_world, F)[:3, :3].T + np.array(o.matrix_world, F)[:3, 3]
                                for o, co in local])
            for name, b0n, b1, r in BODY:
                if name in HOLDING_ARM:
                    continue
                pa = np.array(mw @ arm.pose.bones[b0n].head, F)
                if isinstance(b1, tuple):
                    pb_ = arm.pose.bones[b1[0]]
                    y = (mw.to_3x3() @ pb_.matrix.col[1].xyz).normalized()
                    pb = pa + np.array(y, F) * F(b1[1])
                else:
                    pb = np.array(mw @ arm.pose.bones[b1].head, F)
                d = float((r - seg_dist(W, pa, pb)).max())
                if d > worst.get(name, (-9, 0))[0]:
                    worst[name] = (d, f)
        flags = sorted(({"body": n, "depth_m": round(d, 3), "frame": f} for n, (d, f) in worst.items() if d > a.tol),
                       key=lambda x: -x["depth_m"])
        total += len(flags)
        report["clips"][clip] = {"frames": f1 - f0 + 1, "flags": flags}
        print("PROPCHECK", a.prop, report["model"], clip, "OK" if not flags else flags[:3], flush=True)
    report["flags_total"] = total
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w") as fh:
        json.dump(report, fh, indent=1)
    print("PROPCHECK DONE", a.prop, report["model"], total, "flags", flush=True)


if __name__ == "__main__":
    main()
