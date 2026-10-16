# Round 2 building pieces as prefab meshes (see convert.py): the Portus market house (Opus design A,
# sized to the town's four house plots), the portal gates (A: Opus "Waygate"; B: Astra's pale stone
# arch), Meridian's Waystation Nine (Opus) and Hollowmere's stilt shelter (Astra). Each function
# returns one Blender mesh in the prefab frame (Z up, front -Y, ground z = 0, origin at the footprint
# centre) with "Col" corner colours and OK_* slot materials, its shading baked.
#
# Astra's GLBs are design-round files read as glTF data (hash-pinned: ASTRA_FILES), never run.

import hashlib
import os
import sys

import bpy
from mathutils import Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "opus"))

import convert as CV  # noqa: E402
import flkit as K  # noqa: E402

# Astra's two design-round GLBs, kept beside this script (round2/astra/) and pinned by SHA-256.
ASTRA_DIR = os.environ.get("ASTRA_BUILDINGS", os.path.join(HERE, "astra"))
ASTRA_FILES = {
    "gate": ("portus-portal-gate.glb", "0d75d162cd363615e73f2c72187ee893501c53d3a2b896fe3d523ee4e5b8c270"),
    "shelter": ("hollowmere-arrival-outpost.glb", "b0d5c0d13147d2f82e686f332bb492fd95404ec4c24050ef5ffa33c3263fdbc3"),
}


def _astra_path(key):
    name, sha = ASTRA_FILES[key]
    path = os.path.join(ASTRA_DIR, name)
    data = open(path, "rb").read()
    got = hashlib.sha256(data).hexdigest()
    if sha is not None and got != sha:
        raise SystemExit(f"{name}: SHA-256 {got} does not match the pinned {sha}")
    return path


def _baked(me, **kw):
    CV.ensure_uv(me)
    return CV.bake_shading(me, **kw)


def _drop_source_materials(mats):
    """The Opus kit's own materials are only read for colours: remove them (or move their names out of
    the way) so a host scene's material of the same name ("M_Portal") is never shadowed."""
    for m in mats:
        if m.users == 0:
            bpy.data.materials.remove(m)
        else:
            m.name = "R2SRC_" + m.name


# ------------------------------------------------------------------------------------------------
# Portus market house (Opus A)
# ------------------------------------------------------------------------------------------------
def house(w, d, variant, name, lod1=False):
    """The market house on a w x d plot (walls; plinth +0.15 m round). Variant picks the roof and
    plaster tints (0 coral, 1 slate, 2 moss, 3 plum). lod1: without the shelf goods, flower boxes,
    string lights, wire, sign, wall lantern, finial and loft hoist."""
    import house as H
    H.configure(w, d)
    P = H.kit()
    mats = [K.mat_kit(), K.mat_holo()]
    B = K.Building(name, mats)
    H.place(B, P, variant)
    skip = ("H_flowerbox", "H_bulb", "H_wire", "H_sign_frame", "H_sign_holo", "H_lantern", "H_finial", "H_loft") if lod1 else ()
    me = CV.flkit_to_mesh(B, name, skip=skip)
    for ob in list(B.objs):
        bpy.data.objects.remove(ob)
    _drop_source_materials(mats)
    return _baked(me, seed=variant)


# ------------------------------------------------------------------------------------------------
# Portal gate A (Opus "Waygate")
# ------------------------------------------------------------------------------------------------
def gate_a(world, name, dais=True):
    """The floating-arch gate tinted for `world` (its destination). dais=False leaves out the
    two-step dais, inlay and obelisks (a gate standing on a landing platform's edge)."""
    import gate as G
    P = G.kit()
    mats = [K.mat_kit(), K.mat_holo(strength=1.3), G.mat_portal()]
    B = K.Building(name, mats)
    G.place(B, P, world, fx=False)
    skip = ("G_pixel", "G_membrane")
    if not dais:
        skip = skip + ("G_dais", "G_inlay", "G_obelisk", "G_crystal")
    me = CV.flkit_to_mesh(B, name, skip=skip)
    for ob in list(B.objs):
        bpy.data.objects.remove(ob)
    _drop_source_materials(mats)
    return _baked(me, seed=3)


# ------------------------------------------------------------------------------------------------
# Meridian Waystation Nine (Opus outpost A)
# ------------------------------------------------------------------------------------------------
def waystation(name):
    import outpost as O
    P = O.kit()
    mats = [K.mat_kit(grit=0.8), K.mat_holo(strength=1.6)]
    B = K.Building(name, mats)
    O.place(B, P)
    me = CV.flkit_to_mesh(B, name)
    for ob in list(B.objs):
        bpy.data.objects.remove(ob)
    _drop_source_materials(mats)
    return _baked(me, seed=9)


# ------------------------------------------------------------------------------------------------
# Astra pieces: portal gate B and the Hollowmere stilt shelter
# ------------------------------------------------------------------------------------------------
def gate_b(name):
    me = CV.astra_to_mesh(_astra_path("gate"), name)
    _front_to_minus_y(me)
    return _baked(me, seed=4)


def shelter(name):
    me = CV.astra_to_mesh(_astra_path("shelter"), name)
    _front_to_minus_y(me)
    return _baked(me, seed=5)


def _front_to_minus_y(me):
    """Astra's buildings already face -Y after the glTF import (their stairs, door and dials): no turn."""
    return me
