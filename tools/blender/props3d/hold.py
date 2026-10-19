# FIRSTLIGHT sculpted props: weapon space and the right-hand socket, the way the client uses them.
#
# Weapon space (apps/client/src/render/avatars/weapons.ts): origin = centre of the grip, +Z = forward
# (blade tip, staff head, muzzle), +Y = up, +X = right, in glTF axes. Blender is Z up with -Y forward,
# so a weapon-space point (x, y, z) is (x, -z, y) in Blender (the glTF importer's own conversion).
# Socket (apps/client/src/render/Avatars.ts, SOCKETS.hand_r): in the palm, 3/4 of the way from the wrist
# to the middle knuckle and 2.5 cm below it, parented to hand_r, its axes = the model's axes at rest.
# Swords, staffs, wands and bows go in with no rotation (guns get GUN_GRIP; not used here).
# Our own code: MIT.

import numpy as np
from mathutils import Matrix, Vector

F = np.float32
W2B = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], F)  # blender = W2B @ weapon
AX = {"x": 0, "y": 1, "z": 2}


def w2b(V):
    return np.asarray(V, F) @ W2B.T


def w2b_matrix():
    return Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))


def display_matrix(up="z", side="y"):
    """Weapon space -> an upright display frame: weapon `up` to Blender Z, weapon `side` (the profile)
    to Blender X, so a camera on -Y sees the profile with the long axis vertical."""
    u, s = AX[up], AX[side]
    o = 3 - u - s
    R = np.zeros((3, 3), F)
    R[:, u] = (0, 0, 1)
    R[:, s] = (1, 0, 0)
    cyclic = (s, u, o) in ((0, 1, 2), (1, 2, 0), (2, 0, 1))
    R[:, o] = (0, -1, 0) if cyclic else (0, 1, 0)  # e_s x e_u = +-e_o, and X x Z = -Y
    M = Matrix.Identity(4)
    for i in range(3):
        for j in range(3):
            M[i][j] = float(R[i, j])
    return M


def socket_point(arm):
    b = arm.data.bones
    return b["hand_r"].head_local.lerp(b["middle_01_r"].head_local, 0.75) + Vector((0, 0, -0.025))


def hold(arm, objs, weapon_space_data=False):
    """Parent objs (one object or a list) to a hand_r socket on arm. weapon_space_data: the meshes are in
    weapon axes (sculpt previews, today's models); otherwise they are in Blender axes (an imported GLB)."""
    import bpy
    sock = bpy.data.objects.new(f"socket_{arm.name}", None)
    bpy.context.scene.collection.objects.link(sock)
    sock.parent = arm
    sock.parent_type = "BONE"
    sock.parent_bone = "hand_r"
    pp = arm.data.pose_position
    arm.data.pose_position = "REST"
    bpy.context.view_layer.update()
    sock.matrix_world = arm.matrix_world @ Matrix.Translation(socket_point(arm))
    bpy.context.view_layer.update()
    arm.data.pose_position = pp
    for obj in objs if isinstance(objs, (list, tuple)) else [objs]:
        obj.parent = sock
        obj.matrix_parent_inverse = Matrix.Identity(4)
        obj.matrix_basis = w2b_matrix() if weapon_space_data else Matrix.Identity(4)
    return sock


def today_meshes(json_path, wid, name=None):
    """Today's procedural model of weapon `wid` (dumped from weapons.ts) as Blender objects in weapon
    axes (pass weapon_space_data=True to hold()), one per material, with flat Principled materials."""
    import json

    import bpy

    import bl
    data = json.load(open(json_path))[wid]
    objs = []
    for i, m in enumerate(data):
        V = np.asarray(m["pos"], F).reshape(-1, 3)
        idx = np.asarray(m["idx"] if m["idx"] is not None else range(len(V)), np.int64).reshape(-1, 3)
        ob = bl.mesh_from_arrays(f"{name or wid}_today_{i}", V, None, idx)
        mat = bpy.data.materials.new(f"{wid}_today_{i}")
        mat.use_nodes = True
        b = mat.node_tree.nodes["Principled BSDF"]
        col = tuple(int(m["color"][k:k + 2], 16) / 255 for k in (0, 2, 4))
        lin = bl.srgb_to_lin(col)
        b.inputs["Base Color"].default_value = (*lin, 1)
        b.inputs["Roughness"].default_value = float(m["roughness"])
        b.inputs["Metallic"].default_value = float(m["metalness"])
        em = tuple(int(m["emissive"][k:k + 2], 16) / 255 for k in (0, 2, 4))
        if m["basic"]:
            em, k = col, 3.2
        else:
            k = float(m["emissiveIntensity"])
        if k > 0 and any(em):
            b.inputs["Emission Color"].default_value = (*bl.srgb_to_lin(em), 1)
            b.inputs["Emission Strength"].default_value = k
        ob.data.materials.append(mat)
        objs.append(ob)
    return objs
