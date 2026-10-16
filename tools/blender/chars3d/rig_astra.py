# FIRSTLIGHT starters, second looks: rig the Astra design-round meshes (Kappa B, Unit 7 B: static,
# unrigged GLBs made in-house) onto the shared Quaternius UAL skeleton, so they play the same clips as
# every other starter.
#
#   blender -b --disable-autoexec --factory-startup --python-exit-code 1 --python rig_astra.py -- \
#       --look kappa_b --src astra/kappa.glb --ual1 UAL1_Standard.glb --out <dir> [--tex 1024]
#
# 1. Import the static mesh (source hash pinned), weld the seam-split vertices, strip the held weapon
#    (the game draws weapons in the hand socket) and mirror the free thumb onto the hand that gripped it.
# 2. Skeleton: every UAL bone keeps its name and T-pose frame; the joints move to this body's
#    proportions. The arms hang in the mesh, so the arm and hand bones bind rotated down onto them.
#    The GLB's joint nodes rest in the UAL T-pose frames while the inverse bind matrices hold that
#    A-pose: the clips' local rotations then mean the same on this skeleton as on the others, and the
#    client only rescales the pelvis track (assets.ts).
# 3. Weights per island group: rigid for robot segments, hat, shell and hands; heat weights restricted
#    to the group's bones for the soft bodies.
# 4. A fresh UV atlas; the albedo keeps the design's painted colours (sampled through the original atlas
#    UVs) with baked occlusion. Palette-tinted islands (Role primary/secondary) are neutralised so the
#    palette supplies their colour; glowing islands become painted accents. Flat normal map.
# 5. Skinned GLB (Role vertex colours, no materials) + albedo/normal PNGs, like build.py.
#
# Our own code: MIT. The source meshes and the outputs are CC BY 4.0 (FIRSTLIGHT / Astra design round).

import argparse
import hashlib
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "characters"))

import bmesh  # noqa: E402
import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

import bl  # noqa: E402
import build as BU  # noqa: E402
import paint as PT  # noqa: E402
import sdf as S  # noqa: E402
import texbake as TB  # noqa: E402
from part import ROLE_RGBA  # noqa: E402

F = np.float32


def log(*a):
    print("CHAR3D", *a, flush=True)


# ---------------------------------------------------------------------------------------------
# looks. Coordinates are the source mesh's (Blender: Z up, facing -Y), left side (+X) for joints.


def kappa_groups(lo, hi, c):
    ax = abs(c[0])
    if lo[2] > 1.05:
        return "head"  # head, face, kasa, cords, crown dish
    if lo[1] > 0.04:
        return "shell"  # carapace, rim, plates
    if hi[2] < 0.18:
        return "foot"
    if ax > 0.3:
        return "hand" if hi[2] < 0.72 else "arm"
    if ax > 0.1 and hi[2] < 0.72:
        return "leg"
    return "torso"


def kappa_role(group, col):
    r, g, b = col
    if group == "torso" and g > 0.4 and b > 0.4 and r < 0.3:
        return "primary"  # the teal vest
    if group == "shell" and r > 0.75 and b < 0.6:
        return "secondary"  # the straw-coloured shell rim
    return "fixed"


def unit7_groups(lo, hi, c):
    ax = abs(c[0])
    if lo[1] > 0.14:
        return "pack"  # radio pack, lid, antenna
    if c[2] > 1.25 or (lo[2] > 1.15 and ax < 0.2):
        return "head"
    if ax < 0.1 and lo[2] > 1.1:
        return "neck"
    if ax < 0.05 and hi[0] - lo[0] > 0.5 and hi[2] - lo[2] > 0.5:
        return "torso"
    if ax < 0.05 and lo[2] > 0.7:
        return "chest"  # chest shell, vents, chest light
    if ax > 0.2 and c[2] > 0.92:
        return "upperarm"  # shoulder ball, pauldron, 07 marking, upper arm
    if ax > 0.33:
        return "lowerarm" if c[2] >= 0.75 else "hand"
    if c[2] > 0.5:
        return "thigh"
    return "calf" if c[2] > 0.22 else "foot"


def unit7_role(group, col):
    r, g, b = col
    if r > 0.85 and g > 0.83 and b > 0.72:
        return "primary"  # ivory ceramic
    if abs(r - 0.44) < 0.07 and abs(g - 0.5) < 0.07 and abs(b - 0.55) < 0.07:
        return "secondary"  # grey joints
    return "fixed"


def unit7_accent(col, mat):
    r, g, b = col
    return mat == 1 or (r > 0.85 and 0.6 < g < 0.85 and b < 0.55)  # optic, chest light, antenna tip


def kappa_strip(lo, hi):
    # the Riverstaff: its pole and the twelve reed rings
    return lo[0] > 0.44 and ((hi[2] - lo[2]) > 1.0 or (hi[2] - lo[2]) < 0.015)


def unit7_strip(lo, hi):
    # the carbine: body, battery, grip, barrel, muzzle ring, light
    return lo[0] > 0.40 and hi[0] > 0.5 and (lo[1] < -0.2 or hi[1] > 0.0 or hi[2] < 0.42)


ARM = ["clavicle", "upperarm", "lowerarm", "hand"]

LOOKS = {
    "kappa_b": dict(
        sha="8417520d9403cda3a5f466cfd56e01cd6b98056a662c1cd7169b7a9742d06099",
        strip=kappa_strip, n_strip=13,
        # (source thumb centre, gripping thumb centre): the left thumb curled round the staff
        mirror=[((-0.525, -0.155, 0.58), (0.395, -0.155, 0.58))],
        joints=dict(pelvis=(0, 0.02, 0.573), neck=(0, 0.0, 1.04), head=(0, -0.01, 1.11), head_len=0.2,
                    clav=(0.05, -0.01, 0.975), shoulder=(0.319, 0.009, 0.98), elbow=(0.395, -0.04, 0.825),
                    wrist=(0.47, -0.09, 0.67), knuckle=(0.46, -0.135, 0.55),
                    hip=(0.185, 0.0, 0.588), knee=(0.22, 0.0, 0.405), ankle=(0.24, -0.01, 0.15),
                    ball=(0.24, -0.2, 0.05), toe=(0.24, -0.3, 0.05)),
        groups=kappa_groups, role=kappa_role, accent=None,
        weights={
            "head": ("rigid", "Head"),
            "shell": ("rigid", "spine_02"),
            "torso": ("auto", ["pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "clavicle_l", "clavicle_r",
                               "thigh_l", "thigh_r"], "spine_02"),
            "arm": ("auto", ARM, "upperarm"),
            "hand": ("rigid", "hand"),
            "leg": ("auto", ["thigh", "calf", "foot"], "thigh"),
            "foot": ("rigid", "foot"),
        },
        texel={"head": 1.5, "hand": 1.2},
    ),
    "unit7_b": dict(
        sha="a052d6003f98bdd8f845342f69fd6cdb5271b3b66989768d306baf0dcbb91400",
        strip=unit7_strip, n_strip=6,
        mirror=[((-0.5115, -0.155, 0.64), (0.3885, -0.155, 0.64))],
        joints=dict(pelvis=(0, 0.0, 0.645), neck=(0, 0.0, 1.14), head=(0, 0.0, 1.21), head_len=0.2,
                    clav=(0.05, -0.01, 1.04), shoulder=(0.33, 0.0, 1.06), elbow=(0.43, -0.005, 0.84),
                    wrist=(0.45, -0.12, 0.72), knuckle=(0.45, -0.135, 0.61),
                    hip=(0.166, 0.0, 0.66), knee=(0.19, 0.0, 0.41), ankle=(0.2, 0.0, 0.17),
                    ball=(0.2, -0.2, 0.05), toe=(0.2, -0.3, 0.05)),
        groups=unit7_groups, role=unit7_role, accent=unit7_accent,
        weights={
            "pack": ("rigid", "spine_03"),
            "head": ("rigid", "Head"),
            "neck": ("rigid", "neck_01"),
            "torso": ("auto", ["pelvis", "spine_01", "spine_02", "spine_03", "thigh_l", "thigh_r"], "spine_02"),
            "chest": ("rigid", "spine_03"),
            "upperarm": ("rigid", "upperarm"),
            "lowerarm": ("rigid", "lowerarm"),
            "hand": ("rigid", "hand"),
            "thigh": ("rigid", "thigh"),
            "calf": ("rigid", "calf"),
            "foot": ("rigid", "foot"),
        },
        texel={"head": 1.5, "hand": 1.2},
    ),
}

NEUTRAL = 0.97  # palette-tinted islands: albedo level the palette colour multiplies


# ---------------------------------------------------------------------------------------------
# mesh


def import_source(path, sha):
    with open(path, "rb") as fh:
        got = hashlib.sha256(fh.read()).hexdigest()
    if got != sha:
        raise SystemExit(f"source hash mismatch for {path}: {got}")
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == "MESH"]
    if len(meshes) != 1:
        raise SystemExit(f"expected one mesh in {path}, got {len(meshes)}")
    ob = meshes[0]
    ob.data.transform(ob.matrix_world)
    ob.parent = None
    ob.matrix_world = Matrix()
    for o in new:
        if o is not ob:
            bpy.data.objects.remove(o, do_unlink=True)
    img = None
    for m in ob.data.materials:
        for n in (m.node_tree.nodes if m and m.node_tree else []):
            if n.type == "TEX_IMAGE" and n.image:
                img = n.image
    w, h = img.size
    atlas = np.array(img.pixels[:], dtype=F).reshape(h, w, 4)[..., :3]  # sRGB-encoded, rows bottom-up
    ob.data.uv_layers[0].name = "SRC"
    return ob, atlas


def mesh_arrays(ob):
    me = ob.data
    co = np.empty(len(me.vertices) * 3, F)
    me.vertices.foreach_get("co", co)
    nl = len(me.loops)
    vi = np.empty(nl, np.int32)
    me.loops.foreach_get("vertex_index", vi)
    npl = len(me.polygons)
    ls = np.empty(npl, np.int32)
    lt = np.empty(npl, np.int32)
    me.polygons.foreach_get("loop_start", ls)
    me.polygons.foreach_get("loop_total", lt)
    return co.reshape(-1, 3), vi, ls, lt


def islands(ob):
    """Face island ids (vertex-connected components), per face."""
    co, vi, ls, lt = mesh_arrays(ob)
    parent = np.arange(len(co))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    for f in range(len(ls)):
        vs = vi[ls[f]:ls[f] + lt[f]]
        r0 = find(vs[0])
        for v in vs[1:]:
            r = find(v)
            if r != r0:
                parent[r] = r0
    root = np.array([find(v) for v in range(len(co))])
    froot = root[vi[ls]]
    _, fis = np.unique(froot, return_inverse=True)
    return fis.ravel()


def island_info(ob, fis, atlas):
    co, vi, ls, lt = mesh_arrays(ob)
    me = ob.data
    uv = np.empty(len(me.loops) * 2, F)
    me.uv_layers["SRC"].data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)
    mi = np.empty(len(ls), np.int32)
    me.polygons.foreach_get("material_index", mi)
    h, w = atlas.shape[:2]
    fuv = np.array([uv[ls[f]:ls[f] + lt[f]].mean(0) for f in range(len(ls))])
    fcol = atlas[np.clip((fuv[:, 1] % 1.0) * h, 0, h - 1).astype(int), np.clip((fuv[:, 0] % 1.0) * w, 0, w - 1).astype(int)]
    info = []
    for k in range(fis.max() + 1):
        fs = np.nonzero(fis == k)[0]
        vs = np.unique(np.concatenate([vi[ls[f]:ls[f] + lt[f]] for f in fs]))
        P = co[vs]
        lo, hi = P.min(0), P.max(0)
        info.append(dict(faces=fs, lo=lo, hi=hi, c=(lo + hi) / 2, col=fcol[fs].mean(0), mat=int(np.bincount(mi[fs]).argmax())))
    return info


def weld_and_clean(ob):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.to_mesh(ob.data)
    bm.free()


def delete_faces(ob, faces):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.faces.ensure_lookup_table()
    kill = set(int(f) for f in faces)
    bmesh.ops.delete(bm, geom=[bm.faces[i] for i in kill], context="FACES")
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.to_mesh(ob.data)
    bm.free()


def mirror_island(ob, src_faces, dst_faces):
    """Replace the dst island by a mirror image (x -> -x) of the src island."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    flag = bm.faces.layers.int.new("mirrored")  # before taking references: a new layer reallocates
    bm.faces.ensure_lookup_table()
    src = [bm.faces[int(i)] for i in src_faces]
    dst = [bm.faces[int(i)] for i in dst_faces]
    dup = bmesh.ops.duplicate(bm, geom=src)
    nf = [g for g in dup["geom"] if isinstance(g, bmesh.types.BMFace)]
    nv = [g for g in dup["geom"] if isinstance(g, bmesh.types.BMVert)]
    for f in nf:
        f[flag] = 1
    for v in nv:
        v.co.x = -v.co.x
    bmesh.ops.reverse_faces(bm, faces=nf)
    bmesh.ops.delete(bm, geom=dst, context="FACES")
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.to_mesh(ob.data)
    bm.free()
    # keep the design's (custom) normals everywhere; the mirrored copy gets smooth vertex normals
    me = ob.data
    n = np.empty(len(me.loops) * 3, F)
    me.corner_normals.foreach_get("vector", n)
    n = n.reshape(-1, 3)
    vn = np.empty(len(me.vertices) * 3, F)
    me.vertex_normals.foreach_get("vector", vn)
    vn = vn.reshape(-1, 3)
    co, vi, ls, lt = mesh_arrays(ob)
    mir = np.empty(len(me.polygons), np.int32)
    me.attributes["mirrored"].data.foreach_get("value", mir)
    for f in np.nonzero(mir)[0]:
        for li in range(ls[f], ls[f] + lt[f]):
            n[li] = vn[vi[li]]
    me.normals_split_custom_set([tuple(x) for x in n])
    me.attributes.remove(me.attributes["mirrored"])


def closed_islands(ob, fis):
    """Islands where every edge has two faces (only those occlude: open decals have no inside)."""
    co, vi, ls, lt = mesh_arrays(ob)
    tri = np.stack([vi[ls], vi[ls + 1], vi[ls + 2]], axis=1)
    e = np.sort(np.concatenate([tri[:, [0, 1]], tri[:, [1, 2]], tri[:, [2, 0]]]), axis=1)
    fe = np.concatenate([fis, fis, fis])
    _, inv, cnt = np.unique(e, axis=0, return_inverse=True, return_counts=True)
    bad = np.unique(fe[cnt[inv.ravel()] != 2])
    return set(range(fis.max() + 1)) - set(bad.tolist())


CORE = {"torso", "shell", "head", "chest", "neck", "pack"}  # parts that never move apart much


def buried_faces(ob, fis, info):
    """Faces deep inside another closed island: of the same group (6 mm), or of another core part (2 cm).
    Limbs keep everything they could swing out of the body."""
    co, vi, ls, lt = mesh_arrays(ob)
    tri = np.stack([vi[ls], vi[ls + 1], vi[ls + 2]], axis=1)
    cen = co[tri].mean(1)
    closed = closed_islands(ob, fis)
    fgroup = np.array([d["group"] for d in info])[fis]
    kill = np.zeros(len(tri), bool)
    for g in sorted(set(d["group"] for d in info)):
        occ = [i for i, d in enumerate(info) if d["group"] == g and i in closed]
        if not occ:
            continue
        sel = np.isin(fis, occ)
        used, inv = np.unique(tri[sel], return_inverse=True)
        field = S.MeshField(co[used], tris=inv.reshape(-1, 3), vox=0.004, band=0.05, pad=0.06)
        for thr, targets in ((-0.006, fgroup == g), (-0.02, np.isin(fgroup, list(CORE - {g})) if g in CORE else None)):
            if targets is None or not targets.any():
                continue
            t = np.nonzero(targets)[0]
            dc = field(cen[t])
            dv = field(co[tri[t]].reshape(-1, 3)).reshape(-1, 3).max(1)
            kill[t] |= (dc < thr) & (dv < thr * 0.5)
    return kill


def unwrap(ob, angle, texel):
    """Smart project (the source is clean primitives) and scale to a uniform texel density x texel."""
    for o in bpy.context.scene.objects:
        o.select_set(False)
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=0.0, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    me = ob.data
    co, vi, ls, lt = mesh_arrays(ob)
    uv = np.empty(len(me.loops) * 2, F)
    me.uv_layers.active.data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)
    L = np.stack([ls, ls + 1, ls + 2], axis=1)
    P = co[vi[L]]
    U = uv[L]
    a3 = 0.5 * np.linalg.norm(np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0]), axis=1).sum()
    d1, d2 = U[:, 1] - U[:, 0], U[:, 2] - U[:, 0]
    a2 = 0.5 * np.abs(d1[:, 0] * d2[:, 1] - d2[:, 0] * d1[:, 1]).sum()
    uv *= math.sqrt(a3 / max(a2, 1e-12)) * texel
    me.uv_layers.active.data.foreach_set("uv", uv.ravel())


def find_island(info, centre, tol=0.01):
    hits = [i for i, d in enumerate(info) if np.all(np.abs(d["c"] - np.array(centre, F)) < tol)]
    if len(hits) != 1:
        raise SystemExit(f"island at {centre}: {len(hits)} matches")
    return hits[0]


# ---------------------------------------------------------------------------------------------
# skeleton


def side_name(n, s):
    return f"{n}_{'l' if s > 0 else 'r'}"


CENTRAL = {"root", "pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "Head"}


def is_generic(n):
    """A bone named without its side (hand, thigh, ...): the island group's side picks it."""
    return n not in CENTRAL and not n.endswith(("_l", "_r"))


def sided_spec(spec):
    bones = [spec[1]] if spec[0] == "rigid" else list(spec[1]) + [spec[2]]
    return any(is_generic(n) for n in bones)


def on_side(n, s):
    return side_name(n, s) if s != 0 and is_generic(n) else n


def fit_skeleton(rig, J):
    """Move the UAL joints onto this body; arm/hand frames rotate onto the hanging arms. Returns the
    UAL rest frames (armature space) by bone name, for the T-pose node rest at export."""
    v = lambda k, s=1: Vector((J[k][0] * s, J[k][1], J[k][2]))  # noqa: E731
    for o in bpy.context.scene.objects:
        o.select_set(False)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    eb = rig.data.edit_bones
    ual = {b.name: b.matrix.copy() for b in eb}
    ual_len = {b.name: b.length for b in eb}
    uh = {n: m.translation.copy() for n, m in ual.items()}
    for b in eb:
        b.use_connect = False
    head, rot, length = {}, {}, {}
    # spine: UAL heights mapped linearly between pelvis and neck
    p0, n0 = uh["pelvis"], uh["neck_01"]
    head["root"] = uh["root"]
    head["pelvis"] = v("pelvis")
    for n in ("spine_01", "spine_02", "spine_03"):
        t = (uh[n].z - p0.z) / (n0.z - p0.z)
        head[n] = v("pelvis").lerp(v("neck"), t)
    head["neck_01"] = v("neck")
    head["Head"] = v("head")
    chain = ["pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "Head"]
    for a, b in zip(chain, chain[1:]):
        length[a] = (head[b] - head[a]).length
    length["Head"] = J["head_len"]
    for s in (1, -1):
        cl, up, lo, ha = (side_name(n, s) for n in ARM)
        head[cl] = v("clav", s)
        head[up] = v("shoulder", s)
        head[lo] = v("elbow", s)
        head[ha] = v("wrist", s)
        length[cl] = (head[up] - head[cl]).length
        length[up] = (head[lo] - head[up]).length
        length[lo] = (head[ha] - head[lo]).length
        # rotations: minimal turn of each UAL segment onto this arm (parents first)
        d_up = (uh[lo] - uh[up]).normalized()
        r_up = d_up.rotation_difference((head[lo] - head[up]).normalized()).to_matrix()
        d_lo = r_up @ (uh[ha] - uh[lo]).normalized()
        r_lo = d_lo.rotation_difference((head[ha] - head[lo]).normalized()).to_matrix() @ r_up
        mid = side_name("middle_01", s)
        d_ha = r_lo @ (uh[mid] - uh[ha]).normalized()
        knuckle = v("knuckle", s)
        r_ha = d_ha.rotation_difference((knuckle - head[ha]).normalized()).to_matrix() @ r_lo
        rot[up], rot[lo], rot[ha] = r_up, r_lo, r_ha
        sh = (knuckle - head[ha]).length / (uh[mid] - uh[ha]).length
        length[ha] = ual_len[ha] * sh
        for b in eb:
            if b.name.endswith(f"_{'l' if s > 0 else 'r'}") and any(b.name.startswith(f) for f in ("thumb", "index", "middle", "ring", "pinky")):
                head[b.name] = head[ha] + r_ha @ ((uh[b.name] - uh[ha]) * sh)
                rot[b.name] = r_ha
                length[b.name] = ual_len[b.name] * sh
        th, ca, fo, ba, bl_ = (side_name(n, s) for n in ("thigh", "calf", "foot", "ball", "ball_leaf"))
        head[th], head[ca], head[fo], head[ba], head[bl_] = v("hip", s), v("knee", s), v("ankle", s), v("ball", s), v("toe", s)
        length[th] = (head[ca] - head[th]).length
        length[ca] = (head[fo] - head[ca]).length
        length[fo] = (head[ba] - head[fo]).length
        length[ba] = (head[bl_] - head[ba]).length
        length[bl_] = ual_len[bl_]
    missing = [b.name for b in eb if b.name not in head]
    if [m for m in missing if m != "root"]:
        raise SystemExit(f"unplaced bones: {missing}")
    for b in eb:
        if b.name == "root":
            continue
        fr = rot.get(b.name, Matrix.Identity(3)) @ ual[b.name].to_3x3()
        M = fr.to_4x4()
        M.translation = head[b.name]
        b.matrix = M
        b.length = max(length[b.name], 0.01)
    bpy.ops.object.mode_set(mode="OBJECT")
    return ual


def pose_ual_frames(rig, ual):
    """Pose every bone back into its UAL T-pose frame (positions follow this skeleton's offsets). The
    exporter writes this pose as the joint nodes' rest; the inverse binds stay at the fitted A-pose."""
    rest = {b.name: b.matrix_local.copy() for b in rig.data.bones}
    posed = {}

    def visit(b):
        if b.parent is None:
            posed[b.name] = rest[b.name]
            basis = Matrix()
        else:
            p = b.parent.name
            pos = posed[p] @ (rest[p].inverted() @ rest[b.name].translation)
            M = ual[b.name].to_3x3().to_4x4()
            M.translation = pos
            posed[b.name] = M
            basis = (rest[p].inverted() @ rest[b.name]).inverted() @ posed[p].inverted() @ M
        pb = rig.pose.bones[b.name]
        pb.rotation_mode = "QUATERNION"
        pb.matrix_basis = basis
        for c in b.children:
            visit(c)
    for b in rig.data.bones:
        if b.parent is None:
            visit(b)
    bpy.context.view_layer.update()


# ---------------------------------------------------------------------------------------------
# textures


def corner_attr(ob, layer):
    """Per-triangle corner values of a UV layer, in TB.mesh_tris order."""
    me = ob.data
    uv = np.empty(len(me.loops) * 2, F)
    me.uv_layers[layer].data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)
    npl = len(me.polygons)
    ls = np.empty(npl, np.int32)
    lt = np.empty(npl, np.int32)
    me.polygons.foreach_get("loop_start", ls)
    me.polygons.foreach_get("loop_total", lt)
    tri_l = []
    for k in range(3, int(lt.max()) + 1):
        sel = np.nonzero(lt == k)[0]
        for j in range(1, k - 1):
            tri_l.append(np.stack([ls[sel], ls[sel] + j, ls[sel] + j + 1], axis=1))
    return uv[np.concatenate(tri_l)]


def bilinear(img, uv):
    h, w = img.shape[:2]
    x = (uv[:, 0] % 1.0) * w - 0.5
    y = (uv[:, 1] % 1.0) * h - 0.5
    x0 = np.floor(x).astype(int)
    y0 = np.floor(y).astype(int)
    tx = (x - x0)[:, None]
    ty = (y - y0)[:, None]
    x0c, x1c = np.clip(x0, 0, w - 1), np.clip(x0 + 1, 0, w - 1)
    y0c, y1c = np.clip(y0, 0, h - 1), np.clip(y0 + 1, 0, h - 1)
    a = img[y0c, x0c] * (1 - tx) + img[y0c, x1c] * tx
    b = img[y1c, x0c] * (1 - tx) + img[y1c, x1c] * tx
    return a * (1 - ty) + b * ty


def lum(c):
    return c[..., 0] * 0.2126 + c[..., 1] * 0.7152 + c[..., 2] * 0.0722


# ---------------------------------------------------------------------------------------------
# main


def rig_look(name, src, ual1, out_dir, tex=1024):
    t0 = time.time()
    import fl_rig as R
    L = LOOKS[name]
    bl.reset()
    rig = R.import_rig(ual1)
    if any(abs(rig.matrix_world[i][j] - (1.0 if i == j else 0.0)) > 1e-6 for i in range(4) for j in range(4)):
        raise SystemExit("the UAL rig object is expected at the identity transform")
    ob, atlas = import_source(src, L["sha"])
    weld_and_clean(ob)
    fis = islands(ob)
    info = island_info(ob, fis, atlas)
    strip = [i for i, d in enumerate(info) if L["strip"](d["lo"], d["hi"])]
    if len(strip) != L["n_strip"]:
        raise SystemExit(f"{name}: weapon strip matched {len(strip)} islands, expected {L['n_strip']}")
    for s_c, d_c in L["mirror"]:
        s_i, d_i = find_island(info, s_c), find_island(info, d_c)
        mirror_island(ob, info[s_i]["faces"], info[d_i]["faces"])
        log(f"mirrored thumb {s_c} -> {d_c}")
        fis = islands(ob)
        info = island_info(ob, fis, atlas)
        strip = [i for i, d in enumerate(info) if L["strip"](d["lo"], d["hi"])]
    delete_faces(ob, np.concatenate([info[i]["faces"] for i in strip]))
    fis = islands(ob)
    info = island_info(ob, fis, atlas)
    log(f"{name}: stripped {len(strip)} weapon islands; {len(info)} islands, {len(ob.data.polygons)} tris")
    me = ob.data

    # per-face island id (the texture pass reads it back as part_id) and the island table
    at = me.attributes.new("part_id", "INT", "FACE")
    at.data.foreach_set("value", (fis + 1).astype(np.int32))
    groups = []
    for d in info:
        g = L["groups"](d["lo"], d["hi"], d["c"])
        d["group"] = g
        d["side"] = 1 if d["c"][0] >= 0 else -1
        d["role"] = L["role"](g, d["col"])
        d["accent"] = bool(L["accent"] and L["accent"](d["col"], d["mat"]))
        key = (g, d["side"] if sided_spec(L["weights"][g]) else 0)
        d["key"] = key
        if key not in groups:
            groups.append(key)
    log("groups:", ", ".join(f"{g}{'' if s == 0 else ('_l' if s > 0 else '_r')}:{sum(1 for d in info if d['key'] == (g, s))}" for g, s in groups))

    ga = me.attributes.new("group_id", "INT", "FACE")
    ga.data.foreach_set("value", np.array([groups.index(d["key"]) for d in info], np.int32)[fis])
    kill = buried_faces(ob, fis, info)
    n0 = len(me.polygons)
    BU.delete_faces(ob, kill)
    log(f"culled {int(kill.sum())} buried faces of {n0}")
    gid = np.empty(len(me.polygons), np.int32)
    me.attributes["group_id"].data.foreach_get("value", gid)

    J = L["joints"]
    ual = fit_skeleton(rig, J)

    # split by group -> weights + UVs per group -> join
    me.uv_layers.new(name="UVMap")
    me.uv_layers.active = me.uv_layers["UVMap"]
    parts = []
    for k, (g, s) in enumerate(groups):
        po = BU.copy_object(ob, f"{g}_{k}")
        BU.delete_faces(po, gid != k)
        spec = L["weights"][g]
        if spec[0] == "rigid":
            w = ("rigid", on_side(spec[1], s))
        else:
            w = ("auto", [on_side(n, s) for n in spec[1]], on_side(spec[2], s))
        BU.apply_weights(po, rig, w)
        po.data.uv_layers.active = po.data.uv_layers["UVMap"]
        unwrap(po, 66.0, L["texel"].get(g, 1.0))
        parts.append(po)
        log(f"  group {g}{'' if s == 0 else ('_l' if s > 0 else '_r')}: {len(po.data.polygons)} tris, {w}")
    bpy.data.objects.remove(ob, do_unlink=True)
    for o in bpy.context.scene.objects:
        o.select_set(False)
    for po in parts:
        po.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    char = parts[0]
    char.name = name
    char.data.name = name
    char.data.uv_layers.active = char.data.uv_layers["UVMap"]
    BU.pack_uvs(char, 0.004)
    me = char.data
    tris = bl.tri_count(char)

    # Role colours per island
    pid = np.empty(len(me.polygons), np.int32)
    me.attributes["part_id"].data.foreach_get("value", pid)
    co, vi, ls, lt = mesh_arrays(char)
    vrole = np.zeros((len(me.vertices), 4), F)
    vrole[:, 3] = 1
    for f in range(len(ls)):
        vrole[vi[ls[f]:ls[f] + lt[f]]] = ROLE_RGBA[info[pid[f] - 1]["role"]]
    role = me.color_attributes.new("Role", "FLOAT_COLOR", "POINT")
    role.data.foreach_set("color", vrole.ravel())
    log(f"joined: {tris} tris, {len(me.vertices)} verts, {time.time() - t0:.0f}s")

    # textures: rasterise the new layout; sample the design's colours through the source UVs
    P3, N3, UV3, PID = TB.mesh_tris(char)
    pid_map, pos, nrm, tan, bit = TB.rasterise(P3, N3, UV3, PID, tex)
    S3 = corner_attr(char, "SRC")
    Sp = np.concatenate([S3, np.zeros((len(S3), 3, 1), F)], axis=2)
    _, src_uv, _, _, _ = TB.rasterise(Sp, N3, UV3, PID, tex)
    covered = pid_map > 0
    log(f"raster {covered.mean():.2f} coverage, {time.time() - t0:.0f}s")
    if lt.max() != 3:
        raise SystemExit("expected a triangle mesh")
    field = S.MeshField(co, tris=np.stack([vi[ls], vi[ls + 1], vi[ls + 2]], axis=1), vox=0.005, band=0.18, pad=0.2)
    Pt = pos[covered]
    Nt = nrm[covered]
    base = bilinear(atlas, src_uv[covered][:, :2])
    ao = TB.sdf_ao(field, Pt + Nt * F(0.004), Nt, dists=(0.012, 0.025, 0.05, 0.09, 0.15))
    ids = pid_map[covered] - 1
    col_isl = np.array([d["col"] for d in info], F)
    roles = np.array([d["role"] for d in info])
    acc = np.array([d["accent"] for d in info])
    tinted = np.isin(roles[ids], ["primary", "secondary"])
    ratio = np.clip(base / np.maximum(col_isl[ids], 1e-3), 0, 1.3)
    rgb = np.where(tinted[:, None], ratio * F(NEUTRAL), base)
    h = max(float(co[:, 2].max()), 1.0)
    rgb = PT.shade(rgb.astype(F), Pt, Nt, ao=ao, ao_amt=0.5, top_light=0.08, z_range=(0.0, h))
    alpha = np.ones(len(rgb), F)
    a_sel = acc[ids]
    if a_sel.any():
        k = np.clip(lum(base[a_sel]) / np.maximum(lum(col_isl[ids][a_sel]), 1e-3), 0, 1)
        alpha[a_sel] = 1.0 - 0.9 * k
    albedo = np.zeros((tex, tex, 4), F)
    albedo[covered, :3] = rgb
    albedo[covered, 3] = alpha
    albedo, _ = TB.dilate(albedo, covered, 12)
    nmap = np.zeros((tex, tex, 4), F)
    nmap[...] = (0.5, 0.5, 1.0, 1.0)
    os.makedirs(out_dir, exist_ok=True)
    BU.save_png(albedo, os.path.join(out_dir, f"{name}_albedo.png"), alpha=True)
    BU.save_png(nmap, os.path.join(out_dir, f"{name}_normal.png"), alpha=False)
    log(f"textures, {time.time() - t0:.0f}s")

    # export: the source UVs and the island ids stay behind; joints rest in the UAL frames
    me.uv_layers.remove(me.uv_layers["SRC"])
    me.attributes.remove(me.attributes["part_id"])
    me.attributes.remove(me.attributes["group_id"])
    char.data.materials.clear()
    md = char.modifiers.new("Armature", "ARMATURE")
    md.object = rig
    char.parent = rig
    pose_ual_frames(rig, ual)
    export_posed(rig, char, os.path.join(out_dir, f"{name}.glb"))
    log(f"DONE {name}: {tris} tris, {time.time() - t0:.0f}s")


def export_posed(rig, mesh, path):
    for o in bpy.context.scene.objects:
        o.select_set(False)
    rig.select_set(True)
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = rig
    me = mesh.data
    me.color_attributes.active_color = me.color_attributes["Role"]
    me.color_attributes.render_color_index = me.color_attributes.find("Role")
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", use_selection=True, export_animations=False,
        export_skins=True, export_morph=False, export_materials="NONE", export_vertex_color="NAME",
        export_vertex_color_name="Role", export_all_vertex_colors=False, export_texcoords=True,
        export_normals=True, export_tangents=False, export_yup=True, export_apply=False,
        export_def_bones=False, export_leaf_bone=False, export_extras=False,
        export_rest_position_armature=False)


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--look", required=True, choices=sorted(LOOKS))
    ap.add_argument("--src", required=True)
    ap.add_argument("--ual1", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--tex", type=int, default=1024)
    a = ap.parse_args(argv)
    rig_look(a.look, a.src, a.ual1, a.out, a.tex)
