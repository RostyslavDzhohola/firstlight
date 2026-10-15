# Pad outposts: pack one body's design build (design.py --export-dir) into the game's asset.
#
#   blender -b --disable-autoexec --factory-startup --python pack.py -- --body arcadia --design <dir> --out <dir>
#
# <design> holds prefabs/*.glb (+ prefabs/textures) and <body>_layout.json from design.py. Reads only our
# own build output. Reuses the Portus pack (tools/blender/portus/pack.py): glTF reader, LOD1 roof shells,
# texture layers and the GLB writer, so the asset has the Portus town's format: one node per prefab and
# LOD, primitives "town_opaque"/"town_cutout", COLOR_0 = linear tint + material slot.
#
# Writes <body>_raw.glb (build.sh meshopt-compresses it), site.json (prefab table with collider solids,
# layout with baked base heights, paths: the input of gen_outposts.py) and pack_report.json.
# Arcadia and Hollowmere use only the village/nature kit layers, so they keep the Portus town's layer
# order and texture strips (portus_color.webp / portus_normal.webp: no new textures); their slots are the
# Portus slots with body tints, plus a few plain-colour slots. Meridian gets its own strip (sci-fi trims).
import sys, os, json, math
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "portus"))
import pack as PP  # noqa: E402

ARGV = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def opt(name, default=None):
    if name in ARGV:
        i = ARGV.index(name)
        return ARGV[i + 1]
    return default


BODY = opt("--body")
if BODY not in ("arcadia", "hollowmere", "meridian") or not opt("--design") or not opt("--out"):
    raise SystemExit("pads/pack.py: pass --body <arcadia|hollowmere|meridian> --design <dir> --out <dir>")
PP.configure(opt("--design"), opt("--out"))
LAYOUT = json.load(open(os.path.join(PP.DESIGN, f"{BODY}_layout.json")))


def log(*a):
    print(f"[pack {BODY}]", *a, flush=True)


def lin(hexv):
    c = [((hexv >> 16) & 255) / 255, ((hexv >> 8) & 255) / 255, (hexv & 255) / 255]
    return tuple(round(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4, 4) for x in c)


Z4 = (0, 0, 0, 0)
# Glow slots (emissive = the slot tint x the shader's glow strength, over the bloom threshold): lamps,
# lanterns, light strips. Their tint is the light's colour; the albedo layer is plain white.
GLOW = {"M_GlowTeal": lin(0x5effd0), "M_GlowAmber": lin(0xffb347)}
# Body tints on top of the Portus slot tints (linear multiply only, like the design renders).
TINTS = {
    "arcadia": {},
    "hollowmere": {"MI_UnevenBrick": (0.70, 0.66, 0.82), "MI_Plaster": (0.62, 0.60, 0.72), "MI_RockTrim": (0.62, 0.60, 0.74),
                   "MI_WoodTrim": (0.52, 0.46, 0.50), "MI_WoodTrim_Wear": (0.50, 0.45, 0.50), "MI_Brick": (0.62, 0.58, 0.70),
                   "MI_RoundTiles": (0.42, 0.40, 0.52), "MI_MetalOrnaments": (0.55, 0.55, 0.62)},
    "meridian": {},
}[BODY]


def slot(name, layer, tint, rough, metal, normal, emissive=Z4, night=Z4, cutout=False, glow=0.0):
    return dict(name=name, layer=layer, tint=list(tint), rough=rough, metal=metal, normal=normal, emissive=list(emissive),
                night=list(night), cutout=cutout, glow=glow)


if BODY in ("arcadia", "hollowmere"):
    SHARED_STRIPS = "portus"
    LAYERS = PP.LAYERS
    LAYER_INDEX = PP.LAYER_INDEX
    SLOTS = []
    for s in PP.SLOTS:
        name, layer, tint, rough, metal, nscale, emis, night, cut = s
        t = TINTS.get(name, (1, 1, 1))
        tint = tuple(round(a * b, 4) for a, b in zip(tint, t))
        if BODY == "hollowmere" and name == "MI_WindowGlass":
            # Hollowmere's windows carry the dusk: candle-warm, always lit (the glow mode), not just at night.
            SLOTS.append(slot(name, LAYER_INDEX["white"], lin(0xb06a30), 0.2, 0.0, 0.0, glow=1.0))
            continue
        SLOTS.append(slot(name, LAYER_INDEX[layer], tint, rough, metal, nscale, emis, night, cut))
    W = LAYER_INDEX["white"]
    SLOTS += [
        slot("M_Brass", W, lin(0xc8902e), 0.45, 0.3, 0.0),
        slot("M_Bone", W, lin(0xd8d0c0), 0.7, 0.0, 0.0),
        slot("M_GlowWarm", W, (0.3, 0.09, 0.012), 0.6, 0.0, 0.0, emissive=(1.0, 0.36, 0.06, 0.85)),  # Portus' flame
        slot("M_GlowTeal", W, GLOW["M_GlowTeal"], 0.5, 0.0, 0.0, glow=1.0),
        slot("M_GlowAmber", W, GLOW["M_GlowAmber"], 0.5, 0.0, 0.0, glow=1.0),
    ]
else:
    SHARED_STRIPS = None
    LAYERS = [
        ("trim01", "T_Trim_01_BaseColor_Red.png", "T_Trim_01_Normal.png", "tile"),
        ("trim02", "T_Trim_02_BaseColor_Red.png", "T_Trim_02_Normal.png", "tile"),
        ("trim02v", "T_Trim_02_BaseColor.png", "T_Trim_02_Normal.png", "tile"),
        ("trim03", "T_Trim_03_BaseColor.png", "T_Trim_03_Normal.png", "tile"),
        ("cables", "T_Trim_03_Cables.png", "T_Trim_03_Normal.png", "tile"),
        ("padded", "T_PaddedWall_BaseColor.png", "T_PaddedWall_Normal.png", "tile"),
        ("rocktrim", "T_RockTrim_BaseColor.png", "T_RockTrim_Normal.png", "tile"),
        ("cloth", "T_Cloth_Palette.png", None, "nearest"),
        ("white", None, None, "white"),
    ]
    LAYER_INDEX = {k[0]: i for i, k in enumerate(LAYERS)}
    L = LAYER_INDEX
    DECK = 0.82  # design.py DECK_TINT
    SLOTS = [
        slot("MI_Trim_01", L["trim01"], (1, 1, 1), 0.55, 0.15, 1.0),
        slot("MI_Trim_02", L["trim02"], (1, 1, 1), 0.55, 0.15, 1.0),
        slot("MI_Trim_02_Variation", L["trim02v"], (1, 1, 1), 0.55, 0.15, 1.0),
        slot("MI_Trim_03", L["trim03"], (1, 1, 1), 0.6, 0.1, 1.0),
        slot("MI_Trim_03_Deck", L["trim03"], (DECK, DECK, DECK), 0.62, 0.1, 1.0),
        slot("MI_Trim_03_Cables", L["cables"], (1, 1, 1), 0.6, 0.1, 1.0),
        slot("MI_Trim_03_Dark", L["cables"], (0.5, 0.5, 0.5), 0.6, 0.1, 1.0),
        slot("MI_PaddedWall", L["padded"], (1, 1, 1), 0.75, 0.0, 1.0),
        slot("MI_RockTrim", L["rocktrim"], (1.0, 0.86, 0.76), 0.86, 0.0, 1.0),
        slot("MI_WindowGlass", L["white"], (0.05, 0.075, 0.1), 0.2, 0.0, 0.0, night=(1.0, 0.72, 0.38, 0.85)),
        slot("M_Glass", L["white"], (0.05, 0.075, 0.1), 0.2, 0.0, 0.0, night=(1.0, 0.72, 0.38, 0.85)),
        slot("M_Cloth", L["cloth"], (1, 1, 1), 0.9, 0.0, 0.0),
        slot("M_GlowTeal", L["white"], GLOW["M_GlowTeal"], 0.5, 0.0, 0.0, glow=1.0),
        slot("M_GlowAmber", L["white"], GLOW["M_GlowAmber"], 0.5, 0.0, 0.0, glow=1.0),
    ]

SLOT_INDEX = {s["name"]: i for i, s in enumerate(SLOTS)}
# The Portus pack's helpers read these module globals: Part.cutout, parts_of, roof_lod, layer_images.
PP.LAYERS = LAYERS
PP.LAYER_INDEX = LAYER_INDEX
PP.SLOTS = [(s["name"], None, None, None, None, None, None, None, s["cutout"]) for s in SLOTS]
PP.SLOT_INDEX = SLOT_INDEX


def tree_card(name):
    """LOD1 crossed cards for a tree that is the Portus town's tree_oak (same module, same lightening):
    the card size the Portus pack derives from the bounds, showing the Portus impostor layer's left half."""
    prims = PP.load_prefab(name)
    pos = np.concatenate([p["pos"] for p in prims])
    # glTF space: x right, y up, z front -> Blender x, -z, y (render_impostor measures Blender x/y extents)
    hw = max(abs(pos[:, 0].min()), abs(pos[:, 0].max()), abs(pos[:, 2].min()), abs(pos[:, 2].max())) * 1.02
    top = pos[:, 1].max() * 1.01
    scale = max(top, 4 * hw)
    return PP.card_parts(SLOT_INDEX["Impostor_Broad"], scale / 4, scale, 0.0, 0.5)


def main():
    prefab_info = LAYOUT["prefabs"]
    names = []
    for it in LAYOUT["layout"]:
        if it["prefab"] not in names:
            names.append(it["prefab"])
    b = BODY[0]
    for extra in (f"{b}_pad", f"{b}_waystone"):
        if extra not in names:
            names.append(extra)
    glb = PP.GLB()
    glb.doc["asset"]["generator"] = "FIRSTLIGHT tools/blender/pads/pack.py"
    glb.doc["scenes"][0]["name"] = f"{BODY}_outpost"
    prefabs, report = [], {"prefabs": {}}
    for name in names:
        lod0 = PP.parts_of(PP.load_prefab(name))
        cls = prefab_info[name]["cls"]
        lod1 = None
        if cls == "building" and "MI_RoundTiles" in SLOT_INDEX and any(p.slot == SLOT_INDEX["MI_RoundTiles"] for p in lod0):
            lod1 = PP.roof_lod(lod0)
        elif cls == "tree":
            lod1 = tree_card(name)
        glb.mesh(name, PP.split(lod0))
        if lod1 is not None:
            glb.mesh(name + "__L1", PP.split(lod1))
        game_cls = {"pad": "static", "tree": "tree", "building": "building", "prop": "prop", "static": "static"}[cls]
        lod_mode = "geom" if lod1 is not None else ("none" if game_cls == "prop" else "same")
        pos = np.concatenate([p.pos for p in lod0])
        bound = float(np.max(np.linalg.norm(pos[:, [0, 2]], axis=1)))
        solids = [[round(float(v), 3) for v in s] for s in prefab_info[name]["solids"]]
        prefabs.append(dict(name=name, cls=game_cls, lod=lod_mode, tris=[PP.tris(lod0), PP.tris(lod1) if lod1 is not None else 0],
                            height=float(pos[:, 1].max()), radius=bound, solids=solids))
        report["prefabs"][name] = dict(cls=game_cls, lod=lod_mode, lod0=PP.tris(lod0), lod1=PP.tris(lod1) if lod1 is not None else 0,
                                       cutout0=PP.tris([p for p in lod0 if p.cutout]))
        log(f"{name:16s} {game_cls:9s} LOD0 {PP.tris(lod0):6d}  LOD1 {PP.tris(lod1) if lod1 is not None else '-':>6}  solids {len(solids)}")

    glass = [i for i, s in enumerate(SLOTS) if s["name"] in ("MI_WindowGlass", "M_Glass")]
    extras = {"outpost": {"version": 1, "body": BODY, "layerSize": PP.LAYER, "layers": [l[0] for l in LAYERS], "slots": SLOTS,
                          "glassSlots": glass, "sharedStrips": SHARED_STRIPS}}
    glb.write(os.path.join(PP.OUT, f"{BODY}_raw.glb"), extras)
    if SHARED_STRIPS is None:
        color, mask, normal = PP.layer_images({})
        strip_c = np.concatenate([np.concatenate([c, a[..., None]], axis=2) for c, a in zip(color, mask)]).astype(np.float32)
        strip_n = np.concatenate(normal).astype(np.float32)
        PP.save_webp(strip_c, os.path.join(PP.OUT, f"{BODY}_color.webp"), 82)
        PP.save_webp(strip_n, os.path.join(PP.OUT, f"{BODY}_normal.webp"), 90)

    index = {p["name"]: i for i, p in enumerate(prefabs)}
    layout = [dict(prefab=it["prefab"], east=it["east"], north=it["north"], yaw=it["yaw"], scale=it["scale"], base=it["base"],
                   label=it["label"]) for it in LAYOUT["layout"]]
    site = dict(body=BODY, prefabs=prefabs, layout=layout, paths=[dict(name=p["name"], width=p["width"], mat=p["mat"], pts=p["pts"]) for p in LAYOUT["paths"]],
                pad=index[f"{b}_pad"], waystone=index[f"{b}_waystone"])
    with open(os.path.join(PP.OUT, "site.json"), "w") as f:
        json.dump(site, f, indent=1)
    report["layers"] = [l[0] for l in LAYERS]
    report["slotTable"] = SLOTS
    report["sharedStrips"] = SHARED_STRIPS
    with open(os.path.join(PP.OUT, "pack_report.json"), "w") as f:
        json.dump(report, f, indent=1)
    log("done")


main()
