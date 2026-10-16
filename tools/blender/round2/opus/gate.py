# Portus portal gate ("Waygate"): stone pylons on a stepped dais, a floating arch of voussoirs held
# by a light spine, a brass orbit ring, a holographic destination planet and a portal membrane.
# Front faces -Y (players walk +Y through it). Glow pieces are separate kit meshes so each gate
# instance is tinted to its world (per-instance colour).
import math, random
from mathutils import Vector, Matrix
import bpy
import flkit as K
from flkit import C

rng = random.Random(5)
PAL = dict(stone=0xE4D7C0, stone2=0xBFAE93, stone3=0xD2C2A6, brass=0xD9A441, iron=0x2E2B2F, white=0xFFFFFF,
           cloth=0xF4EBDD)
WORLDS = {
    'arcadia':    dict(glow=0x3FE0C8, accent=0xFFD27A, banner=0x2F8F5B, name="ARCADIA"),
    'hollowmere': dict(glow=0xB27CFF, accent=0x9EFFD8, banner=0x4A3260, name="HOLLOWMERE"),
    'meridian':   dict(glow=0xFF7A4A, accent=0x4FE0D8, banner=0xA3402B, name="MERIDIAN"),
    # Round 2: the planets' home gate back to Portus (warm, the portal's own colour).
    'portus':     dict(glow=0xFFD8A8, accent=0xFFE6B0, banner=0x8A5A2E, name="PORTUS"),
}
PX, ZD = 2.35, 0.40          # pylon centre x, dais top
ZS = 5.0                     # arch springing height
RA = PX                      # arch centre-line radius
OPEN = PX - 0.5              # half opening width

def kit():
    P = {}
    # ---- dais: 12-sided, two tiers
    p = K.Piece("G_dais")
    p.lathe([(0.0, 0.0), (4.9, 0.0), (4.9, 0.17), (4.75, 0.21), (4.25, 0.21), (4.25, 0.37), (4.1, 0.41), (0.0, 0.41)],
            seg=12, col=PAL['stone2'], kind='stone')
    P['dais'] = p.mesh(sharp_deg=35)
    # glowing inlay ring + approach lines (tinted)
    p = K.Piece("G_inlay")
    p.lathe([(3.35, 0.415), (3.55, 0.415)], seg=24, col=PAL['white'], kind='glow', glow=0.55, cap0=False, cap1=False)
    for x in (-0.9, 0.9):
        p.box((0.10, 2.9, 0.02), (x, -1.95, 0.41), col=PAL['white'], kind='glow', glow=0.55)
    P['inlay'] = p.mesh()
    # ---- pylon pieces
    p = K.Piece("G_pylon_base"); p.box((1.5, 1.7, 0.62), (0, 0, 0.31), col=PAL['stone2'], kind='stone', bevel=0.05, taper=(0.9, 0.92)); P['pbase'] = p.mesh()
    p = K.Piece("G_pylon_seg"); p.box((1.08, 1.26, 1.18), (0, 0, 0.59), col=PAL['stone'], kind='stone', bevel=0.045, taper=(0.95, 0.96)); P['pseg'] = p.mesh()
    p = K.Piece("G_panel")
    p.box((0.78, 0.05, 0.92), (0, 0, 0), col=PAL['stone2'], kind='stone', bevel=0.015)
    P['panel'] = p.mesh()
    p = K.Piece("G_band"); p.box((1.16, 1.34, 0.13), (0, 0, 0.065), col=PAL['brass'], kind='brass', bevel=0.02); P['band'] = p.mesh()
    p = K.Piece("G_capital")
    p.box((1.36, 1.5, 0.22), (0, 0, 0.11), col=PAL['stone3'], kind='stone', bevel=0.04, taper=(1.08, 1.06))
    p.box((1.50, 1.62, 0.16), (0, 0, 0.30), col=PAL['stone2'], kind='stone', bevel=0.035)
    P['capital'] = p.mesh()
    # rune: a vertical circuit line with a diamond node (front face, y = 0 plane, glow, tinted)
    p = K.Piece("G_rune")
    p.box((0.06, 0.03, 0.80), (0, 0, 0), col=PAL['white'], kind='glow', glow=0.8)
    p.box((0.20, 0.03, 0.20), (0, 0, 0.12), rot=(0, math.radians(45), 0), col=PAL['white'], kind='glow', glow=0.8)
    p.box((0.22, 0.03, 0.05), (0.08, 0, -0.28), col=PAL['white'], kind='glow', glow=0.8)
    P['rune'] = p.mesh()
    # ---- arch voussoir (annular sector in the XZ plane, centred on angle 0 = +X), depth 1.0
    def sector(a_half, ri, ro, n=2):
        outer = [(ro * math.cos(-a_half + 2 * a_half * k / n), ro * math.sin(-a_half + 2 * a_half * k / n)) for k in range(n + 1)]
        inner = [(ri * math.cos(-a_half + 2 * a_half * k / n), ri * math.sin(-a_half + 2 * a_half * k / n)) for k in range(n + 1)]
        return outer + list(reversed(inner))
    p = K.Piece("G_voussoir")
    p.prism(sector(math.radians(7.8), RA - 0.46, RA + 0.46), 1.0, plane='XZ', col=PAL['stone'], kind='stone', bevel=0.035)
    P['vous'] = p.mesh(sharp_deg=40)
    p = K.Piece("G_keystone")
    p.prism(sector(math.radians(11.5), RA - 0.55, RA + 0.78, 2), 1.25, plane='XZ', col=PAL['stone3'], kind='stone', bevel=0.04)
    p.prism(sector(math.radians(8.5), RA + 0.10, RA + 0.62, 2), 0.06, plane='XZ', loc=(0, -0.64, 0), col=PAL['brass'], kind='brass')
    P['key'] = p.mesh(sharp_deg=40)
    # light spine: half torus through the voussoir centres (tinted glow, visible in the gaps)
    p = K.Piece("G_spine")
    p.torus(RA, 0.16, seg=20, rseg=5, a0=0.0, a1=math.pi, rot=(math.pi / 2, 0, 0), col=PAL['white'], kind='glow', glow=1.0)
    P['spine'] = p.mesh()
    # brass orbit ring (tilted, behind the arch) with nodes
    p = K.Piece("G_orbit")
    p.torus(RA + 1.25, 0.055, seg=26, rseg=4, a0=math.radians(-10), a1=math.radians(190), rot=(math.pi / 2, 0, 0), col=PAL['brass'], kind='brass')
    P['orbit'] = p.mesh()
    p = K.Piece("G_node"); p.sphere(0.13, (0, 0, 0), u=6, v=4, col=PAL['white'], kind='glow', glow=1.0); P['node'] = p.mesh()
    # destination hologram: planet + ring (M_Holo), and its brass cradle on the keystone
    p = K.Piece("G_globe")
    p.sphere(0.55, (0, 0, 0), ico=2, col=PAL['white'], kind='glow', mat=1)
    p.torus(0.86, 0.025, seg=24, rseg=3, rot=(math.radians(72), math.radians(-18), 0), col=PAL['white'], kind='glow', mat=1)
    P['globe'] = p.mesh(sharp_deg=80)
    p = K.Piece("G_cradle")
    p.torus(0.36, 0.035, seg=12, rseg=3, a0=math.pi, a1=2 * math.pi, rot=(math.pi / 2, 0, 0), col=PAL['brass'], kind='brass')
    p.cyl(0.07, 0.30, (0, 0, -0.50), seg=6, col=PAL['brass'], kind='brass')
    P['cradle'] = p.mesh()
    # portal membrane (M_Portal): opening rect + arch, in the XZ plane at y=0
    p = K.Piece("G_membrane")
    r = OPEN + 0.08
    pts = [(-r, ZD), (r, ZD)] + [(r * math.cos(math.pi * k / 14), ZS + r * math.sin(math.pi * k / 14)) for k in range(15)]
    p.quad([(u, 0.0, v) for u, v in pts], col=PAL['white'], kind='glow', mat=2)
    P['membrane'] = p.mesh(sharp_deg=10)
    # banner: rod + cloth with a pointed tail (front face y = 0), cloth tinted per world
    p = K.Piece("G_banner_rod")
    p.cyl(0.03, 1.15, (0, -0.10, 0), rot=(0, math.pi / 2, 0), seg=5, col=PAL['brass'], kind='brass')
    for x in (-0.6, 0.6):
        p.sphere(0.06, (x, -0.10, 0), u=5, v=3, col=PAL['brass'], kind='brass')
    P['rod'] = p.mesh()
    p = K.Piece("G_banner")
    p.prism([(-0.45, 0.0), (0.45, 0.0), (0.45, -1.75), (0.0, -2.1), (-0.45, -1.75)], 0.03, plane='XZ', loc=(0, -0.12, -0.03),
            col=PAL['white'], kind='cloth')
    P['banner'] = p.mesh()
    p = K.Piece("G_banner_mark")       # cream emblem ring on the banner (not tinted)
    p.torus(0.22, 0.035, seg=10, rseg=3, rot=(math.pi / 2, 0, 0), loc=(0, -0.145, -0.85), col=PAL['cloth'], kind='cloth')
    p.box((0.11, 0.02, 0.11), (0, -0.145, -0.85), rot=(0, math.radians(45), 0), col=PAL['cloth'], kind='cloth')
    p.box((0.9, 0.02, 0.06), (0, -0.145, -1.55), col=PAL['cloth'], kind='cloth')
    P['mark'] = p.mesh()
    # flanking obelisk with a floating crystal
    p = K.Piece("G_obelisk")
    p.box((0.62, 0.62, 0.30), (0, 0, 0.15), col=PAL['stone2'], kind='stone', bevel=0.03)
    p.box((0.42, 0.42, 1.55), (0, 0, 1.05), col=PAL['stone'], kind='stone', taper=(0.7, 0.7))
    p.cyl(0.30, 0.06, (0, 0, 1.86), seg=8, col=PAL['brass'], kind='brass')
    P['obelisk'] = p.mesh()
    p = K.Piece("G_crystal")
    p.lathe([(0.0, -0.32), (0.16, 0.0), (0.0, 0.42)], seg=4, col=PAL['white'], kind='glow', glow=0.9)
    P['crystal'] = p.mesh(sharp_deg=10)
    # digital corpuscles (FX, would be particles in the game: not counted)
    p = K.Piece("G_pixel"); p.box((0.11, 0.11, 0.11), col=PAL['white'], kind='glow', glow=1.0); P['pixel'] = p.mesh()
    return P

def place(B, P, world='arcadia', fx=True):
    Wd = WORLDS[world]
    g, ac = Wd['glow'], Wd['accent']
    vr = random.Random(hash(world) & 0xffff)
    put = B.put
    put(P['dais'])
    put(P['inlay'], tint=g)
    for sx in (-1, 1):
        x = sx * PX
        put(P['pbase'], (x, 0, ZD))
        z = ZD + 0.62
        for i in range(3):
            put(P['pseg'], (x, 0, z), tint=K.jit(0xFFFFFF, 0.04, vr))
            if i == 0:
                put(P['rune'], (x, -0.645, z + 0.6), tint=g)
                put(P['panel'], (x, -0.62, z + 0.59))
            put(P['rune'], (sx * (PX - 0.555), 0, z + 0.6), rot=(0, 0, -sx * math.pi / 2), tint=g)
            z += 1.18
            if i < 2:
                put(P['band'], (x, 0, z - 0.065))
        put(P['capital'], (x, 0, ZS - 0.38))
        put(P['rod'], (x, -0.74, ZS - 0.85))
        put(P['banner'], (x, -0.74, ZS - 0.85), tint=Wd['banner'])
        put(P['mark'], (x, -0.74, ZS - 0.85))
    # arch: 7 voussoirs + keystone, floating with gaps (rotation about Y puts angle 0 at +X)
    lift = 0.24
    angs = [7.8, 27.4, 47.0, 66.6, 113.4, 133.0, 152.6, 172.2]
    for a in angs:
        ar = math.radians(a)
        put(P['vous'], (0, 0, ZS + lift), rot=(0, -ar, 0), tint=K.jit(0xFFFFFF, 0.04, vr))
    put(P['key'], (0, 0, ZS + lift + 0.06), rot=(0, -math.pi / 2, 0))
    put(P['spine'], (0, 0, ZS + lift), tint=g)
    put(P['orbit'], (0, 0.55, ZS - 0.1))
    for a in (-10, 42, 138, 190):
        ar = math.radians(a)
        rr = RA + 1.25
        put(P['node'], (rr * math.cos(ar), 0.55, ZS - 0.1 + rr * math.sin(ar)), tint=ac)
    put(P['cradle'], (0, -0.1, ZS + RA + 1.35))
    put(P['globe'], (0, -0.1, ZS + RA + 1.72), rot=(0.3, 0.2, 0.5), tint=g)
    put(P['membrane'], (0, 0.05, 0), tint=g)
    for sx in (-1, 1):
        put(P['obelisk'], (sx * 3.05, -2.3, ZD))
        put(P['crystal'], (sx * 3.05, -2.3, ZD + 2.45), rot=(0, 0, 0.4), tint=ac)
    if fx:
        for k in range(26):
            a = vr.uniform(0.1, math.pi - 0.1)
            rr = RA + vr.uniform(-0.2, 0.9)
            up = vr.uniform(0.0, 1.8) ** 1.5
            s = vr.uniform(0.5, 1.3) * (1 - up / 3.0)
            put(P['pixel'], (rr * math.cos(a), vr.uniform(-0.6, 0.6), ZS + lift + rr * math.sin(a) + up),
                rot=(vr.random() * 3, vr.random() * 3, vr.random() * 3), scale=(s, s, s), tint=g if k % 3 else ac, count=False)
    return B

def mat_portal(name="M_Portal"):
    """Swirling membrane (a TSL shader in the game): object-space swirl noise, tinted by the instance colour."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree; N = nt.nodes; L = nt.links
    for n in list(N):
        N.remove(n)
    out = N.new("ShaderNodeOutputMaterial")
    tc = N.new("ShaderNodeTexCoord")
    sub = N.new("ShaderNodeVectorMath"); sub.operation = 'SUBTRACT'; sub.inputs[1].default_value = (0, 0, 3.1)
    L.new(tc.outputs["Object"], sub.inputs[0])
    sq = N.new("ShaderNodeVectorMath"); sq.operation = 'MULTIPLY'; sq.inputs[1].default_value = (1.0, 0.0, 0.62)
    L.new(sub.outputs[0], sq.inputs[0])
    ln = N.new("ShaderNodeVectorMath"); ln.operation = 'LENGTH'; L.new(sq.outputs[0], ln.inputs[0])
    ang = N.new("ShaderNodeMath"); ang.operation = 'MULTIPLY'; ang.inputs[1].default_value = -1.9
    L.new(ln.outputs["Value"], ang.inputs[0])
    vrot = N.new("ShaderNodeVectorRotate"); vrot.rotation_type = 'Y_AXIS'
    L.new(sub.outputs[0], vrot.inputs["Vector"]); L.new(ang.outputs[0], vrot.inputs["Angle"])
    st = N.new("ShaderNodeVectorMath"); st.operation = 'MULTIPLY'; st.inputs[1].default_value = (1.0, 1.0, 0.35)
    L.new(vrot.outputs[0], st.inputs[0])
    nz = N.new("ShaderNodeTexNoise"); nz.inputs["Scale"].default_value = 1.6; nz.inputs["Detail"].default_value = 4
    nz.inputs["Distortion"].default_value = 0.6
    L.new(st.outputs[0], nz.inputs["Vector"])
    ramp = N.new("ShaderNodeValToRGB"); cr = ramp.color_ramp
    cr.elements[0].position = 0.30; cr.elements[0].color = (0.05, 0.05, 0.05, 1)
    cr.elements[1].position = 0.78; cr.elements[1].color = (1.0, 1.0, 1.0, 1)
    e = cr.elements.new(0.55); e.color = (0.45, 0.45, 0.45, 1)
    L.new(nz.outputs["Fac"], ramp.inputs[0])
    obi = N.new("ShaderNodeObjectInfo")
    # colour = tint * (0.35 + ramp) + white * ramp^4
    add = N.new("ShaderNodeMath"); add.operation = 'ADD'; add.inputs[1].default_value = 0.35
    L.new(ramp.outputs["Color"], add.inputs[0])
    tcol = N.new("ShaderNodeVectorMath"); tcol.operation = 'SCALE'
    L.new(obi.outputs["Color"], tcol.inputs[0]); L.new(add.outputs[0], tcol.inputs["Scale"])
    p4 = N.new("ShaderNodeMath"); p4.operation = 'POWER'; p4.inputs[1].default_value = 4
    L.new(ramp.outputs["Color"], p4.inputs[0])
    hot = N.new("ShaderNodeVectorMath"); hot.operation = 'MULTIPLY_ADD'
    L.new(p4.outputs[0], hot.inputs[0]); hot.inputs[1].default_value = (0.9, 0.9, 0.9)
    L.new(tcol.outputs[0], hot.inputs[2])
    # brighter toward the rim (radial in the squashed space)
    rim = N.new("ShaderNodeMapRange"); rim.inputs[1].default_value = 0.6; rim.inputs[2].default_value = 2.0
    rim.inputs[3].default_value = 0.8; rim.inputs[4].default_value = 1.9
    L.new(ln.outputs["Value"], rim.inputs[0])
    sc2 = N.new("ShaderNodeVectorMath"); sc2.operation = 'SCALE'
    L.new(hot.outputs[0], sc2.inputs[0]); L.new(rim.outputs[0], sc2.inputs["Scale"])
    em = N.new("ShaderNodeEmission"); L.new(sc2.outputs[0], em.inputs[0]); em.inputs[1].default_value = 1.9
    tr = N.new("ShaderNodeBsdfTransparent")
    mix = N.new("ShaderNodeMixShader"); mix.inputs[0].default_value = 0.22
    L.new(em.outputs[0], mix.inputs[1]); L.new(tr.outputs[0], mix.inputs[2])
    L.new(mix.outputs[0], out.inputs[0])
    return m

def scene(VIEWS, out, SAMPLES):
    import house, props
    look = K.LOOKS['portus']; R = look['R']
    K.world_sky('portus', sun_az_deg=-62, sky_light=1.0)
    m_kit, m_holo, m_portal = K.mat_kit(), K.mat_holo(strength=1.3), mat_portal()
    K.planet_ground(R, K.mat_cobbles(scale=1.5, c1=0xC8B79E, c2=0xB09C82, c3=0xD9CBB4, grout=0x8A7A66))
    P = kit()
    Cc = Vector((0, -12.0))
    gates = {}
    for world, th in (('arcadia', 0.0), ('hollowmere', -60.0), ('meridian', 60.0)):
        t = math.radians(th)
        x, y = Cc.x + 12.0 * math.sin(t), Cc.y + 12.0 * math.cos(t)
        B = K.Building(f"gate_{world}", [m_kit, m_holo, m_portal], origin=K.on_planet(R, x, y, -t))
        place(B, P, world)
        gates[world] = B
        if world == 'arcadia':
            B.report(out('budget').replace('.png', '.txt'))
            K.export_glb(B, out('glb').replace('_glb', '').replace('.png', '.glb'))
        # portal light
        ld = bpy.data.lights.new(f"PL_{world}", 'POINT'); ld.energy = 420; ld.shadow_soft_size = 1.2
        ld.color = K.C(WORLDS[world]['glow'])[:3]
        lo = bpy.data.objects.new(f"PL_{world}", ld); bpy.context.scene.collection.objects.link(lo)
        lo.matrix_world = K.on_planet(R, x, y, -t) @ Matrix.Translation((0, -0.9, 2.6))
    # Portus houses behind the gate ring
    HP = house.kit()
    for i, (th, rr, v) in enumerate(((-24, 21.5, 1), (24, 21.5, 2), (-88, 19.5, 0), (88, 19.5, 3), (0, 25.5, 0))):
        t = math.radians(th)
        x, y = Cc.x + rr * math.sin(t), Cc.y + rr * math.cos(t)
        hb = K.Building(f"bg_house{i}", [m_kit, m_holo], origin=K.on_planet(R, x, y, -t))
        house.place(hb, HP, v)
    X = props.portus_props()
    dress = K.Building("dress", [m_kit, m_holo])
    def at(me, x, y, yaw=0.0, s=1.0):
        dress.origin = K.on_planet(R, x, y, yaw)
        return dress.put(me, scale=(s, s, s))
    for (x, y) in ((-6.5, -6.0), (6.5, -6.0)):
        at(X['lamppost'], x, y)
    for (x, y, s) in ((-9.5, 3.0, 1.1), (9.0, 3.5, 1.0), (-15.5, -1.0, 1.2), (15.0, -1.5, 1.1)):
        at(X['tree'], x, y, x, s)
    fig = props.figure()
    at(fig, 0.55, -3.9, 0.12)
    if 'hero' in VIEWS:
        g = K.on_planet(R, 2.6, -11.6) @ Vector((0, 0, 1.6))
        cam = K.camera("cam_hero", g, (-0.25, 0, 4.6), lens=21)
        K.render(cam, out('hero_eye'))
    if 'aerial' in VIEWS:
        cam = K.camera("cam_aerial", (13.5, -31.0, 21.0), (0.0, -7.0, 1.2), lens=30)
        K.render(cam, out('aerial_34'))
    if 'close' in VIEWS:
        g = K.on_planet(R, -2.6, -6.2) @ Vector((0, 0, 1.4))
        cam = K.camera("cam_close", g, (0.2, 0, 5.6), lens=24)
        K.render(cam, out('detail'))
