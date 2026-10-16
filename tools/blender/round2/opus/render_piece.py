# Driver: build one building + its context and render its views.
#   blender -b --factory-startup --python render_piece.py -- --piece house|gate|outpost
#           [--views hero,aerial,kit] [--scale 100] [--samples 64] [--tag suffix]
import sys, os, math, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy
from mathutils import Vector, Matrix
import flkit as K

A = K.args()
PIECE = A.get('piece', 'house')
VIEWS = str(A.get('views', 'hero,aerial')).split(',')
SCALE = int(A.get('scale', 100))
SAMPLES = int(A.get('samples', 64))
TAG = A.get('tag', '')
OUT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'buildings'))
os.makedirs(OUT, exist_ok=True)

K.reset()
sc = bpy.context.scene
W, H = 1600, 900
K.setup_render(W * SCALE // 100, H * SCALE // 100, SAMPLES)

def out(name):
    return os.path.join(OUT, f"{PIECE}_{name}{TAG}.png")

if VIEWS == ['kit']:
    if PIECE == 'house':
        import house as mod
        tints = dict(slab=0xF6EEDF, roofrow=0xC65A3E, ridge=0xC65A3E, gable=0xF6EEDF, overdoor=0xE9D3AE)
        mats = [K.mat_kit(), K.mat_holo()]
        look = 'portus'
    elif PIECE == 'gate':
        import gate as mod
        g = 0x3FE0C8
        tints = dict(inlay=g, rune=g, spine=g, node=0xFFD27A, globe=g, membrane=g, banner=0x2F8F5B, crystal=0xFFD27A, pixel=g)
        mats = [K.mat_kit(), K.mat_holo(strength=1.3), mod.mat_portal()]
        look = 'portus'
    else:
        import outpost as mod
        tints = {}
        mats = [K.mat_kit(grit=0.8), K.mat_holo(strength=1.6)]
        look = 'meridian'
    P = mod.kit()
    K.kit_sheet(P, mats, out('kit_sheet'), tints=tints, look=look, max_row=15.0 if PIECE != 'outpost' else 22.0)

elif PIECE == 'house':
    import house, props
    look = K.LOOKS['portus']; R = look['R']
    sun = K.world_sky('portus', sun_az_deg=-58, sky_light=1.0)
    m_kit, m_holo = K.mat_kit(), K.mat_holo()
    K.planet_ground(R, K.mat_cobbles(scale=2.4))
    P = house.kit()
    hero = K.Building("house", [m_kit, m_holo], origin=K.on_planet(R, 0, 0))
    house.place(hero, P, 0)
    total = hero.report(out('budget').replace('.png', '.txt'))
    K.export_glb(hero, out('glb').replace('_glb', '').replace('.png', '.glb'))
    ctx = []
    for i, x, y, yaw in ((1, -8.7, 0.9, -0.07), (2, 8.8, 0.6, 0.06)):
        nb = K.Building(f"house_v{i}", [m_kit, m_holo], origin=K.on_planet(R, x, y, yaw))
        house.place(nb, P, i)
    X = props.portus_props()
    dress = K.Building("dress", [m_kit, m_holo])
    def at(me, x, y, yaw=0.0, s=1.0):
        dress.origin = K.on_planet(R, x, y, yaw)
        dress.put(me, scale=(s, s, s))
    at(X['barrel'], -3.9, -3.55, 0.3); at(X['barrel'], -4.5, -3.2, 1.2, 0.95); at(X['crate'], -4.25, -4.15, 0.4)
    at(X['crate'], 4.05, -3.6, 0.2); at(X['planter'], 1.35, -3.75)
    at(X['lamppost'], -5.2, -6.0); at(X['lamppost'], 5.6, -6.2)
    at(X['tree'], -13.5, -4.0, 0.0, 1.15); at(X['tree'], 13.8, -3.5, 1.0, 1.0)
    if 'hero' in VIEWS:
        g = K.on_planet(R, -3.4, -17.5) @ Vector((0, 0, 1.65))
        cam = K.camera("cam_hero", g, (0.5, 0, 5.8), lens=20)
        K.render(cam, out('hero_eye'))
    if 'aerial' in VIEWS:
        cam = K.camera("cam_aerial", (17.5, -23.0, 15.5), (0.3, 0.2, 3.6), lens=30)
        K.render(cam, out('aerial_34'))

elif PIECE == 'gate':
    import gate
    gate.scene(VIEWS, out, SAMPLES)

elif PIECE == 'outpost':
    import outpost
    outpost.scene(VIEWS, out, SAMPLES)

K.log("done", PIECE)
