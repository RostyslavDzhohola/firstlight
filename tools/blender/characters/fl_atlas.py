# FIRSTLIGHT character builder: the shared 512² colour/pattern atlas, painted procedurally with numpy.
# One atlas serves all four starters. Palette-driven tiles are neutral greys; the client multiplies them
# by the palette colour picked by the per-corner Role colour (R primary, G secondary, B accent).
# Our own code: MIT. The generated atlas is CC BY 4.0.

import math
import numpy as np

ROLE_RGBA = {
    "fixed": (0.0, 0.0, 0.0, 1.0),
    "primary": (1.0, 0.0, 0.0, 1.0),
    "secondary": (0.0, 1.0, 0.0, 1.0),
    "accent": (0.0, 0.0, 1.0, 1.0),
}

SIZE = 512
SW = 32  # swatch size (px); 4 rows of 16 swatches at the bottom
BIG = 128  # pattern/face tiles: 4 x 3 above the swatches


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))


class Tile:
    def __init__(self, index, name, role, px_rect):
        self.index = index
        self.name = name
        self.role = role
        x0, y0, x1, y1 = px_rect
        self.px = px_rect
        # inset half a texel + 1 texel so bilinear filtering never bleeds
        self.rect = ((x0 + 1.5) / SIZE, (y0 + 1.5) / SIZE, (x1 - 1.5) / SIZE, (y1 - 1.5) / SIZE)

    def centre(self):
        u0, v0, u1, v1 = self.rect
        return ((u0 + u1) / 2, (v0 + v1) / 2)

    def map(self, u, v):
        u0, v0, u1, v1 = self.rect
        u = min(1.0, max(0.0, u))
        v = min(1.0, max(0.0, v))
        return (u0 + (u1 - u0) * u, v0 + (v1 - v0) * v)

    def role_rgba(self):
        return ROLE_RGBA[self.role]


class Atlas:
    def __init__(self, seed=7):
        self.img = np.zeros((SIZE, SIZE, 4), dtype=np.float32)
        self.img[..., 3] = 1.0
        self.tiles = {}
        self.order = []
        self.n_sw = 0
        self.n_big = 0
        self.rng = np.random.default_rng(seed)

    def tile(self, name):
        if name not in self.tiles:
            raise KeyError(f"unknown atlas tile {name}")
        return self.tiles[name]

    def _add(self, name, role, rect):
        t = Tile(len(self.order), name, role, rect)
        self.tiles[name] = t
        self.order.append(t)
        return t

    def swatch(self, name, rgb, role="fixed", grit=0.025):
        i = self.n_sw
        self.n_sw += 1
        x0, y0 = (i % 16) * SW, (i // 16) * SW
        assert y0 + SW <= 4 * SW, "out of swatch space"
        t = self._add(name, role, (x0, y0, x0 + SW, y0 + SW))
        c = np.array(hex_rgb(rgb) if isinstance(rgb, str) else rgb, dtype=np.float32)
        block = np.tile(c, (SW, SW, 1))
        if grit:
            block *= 1.0 + (self.rng.random((SW, SW, 1)) - 0.5) * grit
        self.img[y0:y0 + SW, x0:x0 + SW, :3] = np.clip(block, 0, 1)
        return t

    def big(self, name, role, painter):
        i = self.n_big
        self.n_big += 1
        x0, y0 = (i % 4) * BIG, 4 * SW + (i // 4) * BIG
        assert y0 + BIG <= SIZE, "out of big-tile space"
        t = self._add(name, role, (x0, y0, x0 + BIG, y0 + BIG))
        # painter gets normalised coords (u right, v up) of shape (BIG, BIG)
        v, u = np.mgrid[0:BIG, 0:BIG].astype(np.float32)
        u = (u + 0.5) / BIG
        v = (v + 0.5) / BIG
        rgb = painter(u, v, self.rng)
        self.img[y0:y0 + BIG, x0:x0 + BIG, :3] = np.clip(rgb, 0, 1)
        return t

    def save(self, path):
        import bpy
        im = bpy.data.images.new("fl_atlas", SIZE, SIZE, alpha=False)
        im.pixels.foreach_set(self.img.ravel())
        im.filepath_raw = path
        im.file_format = "PNG"
        im.save()
        return im


# ---------------------------------------------------------------------------------------------
# painters (u, v in [0,1], v up). Return (H, W, 3).


def fill(u, c):
    out = np.zeros(u.shape + (3,), dtype=np.float32)
    out[...] = np.array(hex_rgb(c) if isinstance(c, str) else c, dtype=np.float32)
    return out


def sd_ellipse(u, v, cx, cy, rx, ry):
    return np.sqrt(((u - cx) / rx) ** 2 + ((v - cy) / ry) ** 2) - 1.0


def cover(sd, px=1.5 / BIG, scale=1.0):
    """Anti-aliased coverage from a normalised signed distance."""
    return np.clip(0.5 - sd * scale / (px * 2), 0, 1)[..., None]


def paint_constellation(base=0.80, star=1.0):
    def p(u, v, rng):
        out = fill(u, (base, base, base))
        out *= 1 + (rng.random(u.shape + (1,)) - 0.5) * 0.04
        stars = rng.random((26, 2)) * 0.9 + 0.05
        # thin connecting lines between a few neighbours
        for i in range(0, 24, 3):
            a, b = stars[i], stars[i + 1]
            d = b - a
            L = np.hypot(*d) + 1e-6
            t = np.clip(((u - a[0]) * d[0] + (v - a[1]) * d[1]) / (L * L), 0, 1)
            dist = np.hypot(u - (a[0] + d[0] * t), v - (a[1] + d[1] * t))
            m = np.clip(1 - dist / 0.006, 0, 1)[..., None] * 0.55
            out = out * (1 - m) + (base + (star - base) * 0.7) * m
        for s in stars:
            r = np.hypot(u - s[0], v - s[1])
            plus = np.minimum(np.abs(u - s[0]), np.abs(v - s[1]))
            m = np.clip(1 - r / 0.014, 0, 1) * np.clip(1 - plus / 0.004, 0, 1)
            m = np.maximum(m, np.clip(1 - r / 0.007, 0, 1))[..., None]
            out = out * (1 - m) + star * m
        return out
    return p


def paint_stripes(vals=(0.95, 0.62, 0.95, 0.82, 0.95, 0.62), sun=True):
    def p(u, v, rng):
        n = len(vals)
        band = np.floor(v * n * 2).astype(int) % n
        out = np.zeros(u.shape + (3,), dtype=np.float32)
        for i, val in enumerate(vals):
            out[band == i] = val
        # woven texture
        weave = (np.sin(u * 220) * np.sin(v * 220) > 0).astype(np.float32)[..., None]
        out *= 0.93 + 0.07 * weave
        if sun:
            # little sun marks along the light bands: a disc with short rays
            for cx in np.linspace(0.1, 0.9, 5):
                for cy in (0.25 / 2, 0.25 / 2 + 0.5):
                    r = np.hypot(u - cx, v - cy)
                    ang = np.arctan2(v - cy, u - cx)
                    rays = (np.cos(ang * 8) > 0.6) & (r < 0.045) & (r > 0.028)
                    m = ((r < 0.02) | rays).astype(np.float32)[..., None]
                    out = out * (1 - m) + 0.55 * m
        return out
    return p


def paint_stones(base="#55602f", rim="#2c3018"):
    def p(u, v, rng):
        pts = rng.random((22, 2))
        tones = [hex_rgb(c) for c in ("#5b6a33", "#6a7340", "#4f5a2c", "#7a7a4a", "#606b3a", "#58603a")]
        d1 = np.full(u.shape, 9.0)
        d2 = np.full(u.shape, 9.0)
        idx = np.zeros(u.shape, dtype=int)
        for i, q in enumerate(pts):
            # tile-wrapping distance so the pattern can repeat
            dx = np.minimum(np.abs(u - q[0]), 1 - np.abs(u - q[0]))
            dy = np.minimum(np.abs(v - q[1]), 1 - np.abs(v - q[1]))
            d = np.hypot(dx, dy)
            closer = d < d1
            d2 = np.where(closer, d1, np.minimum(d2, d))
            idx = np.where(closer, i, idx)
            d1 = np.where(closer, d, d1)
        out = np.zeros(u.shape + (3,), dtype=np.float32)
        for i in range(len(pts)):
            out[idx == i] = tones[i % len(tones)]
        edge = np.clip((d2 - d1) / 0.02, 0, 1)[..., None]
        # pebble shading: lighter towards cell centres
        out *= (0.85 + 0.25 * np.clip(1 - d1 / 0.18, 0, 1))[..., None]
        rimc = np.array(hex_rgb(rim), dtype=np.float32)
        return out * edge + rimc * (1 - edge)
    return p


def paint_seams(base=0.95, line=0.55):
    def p(u, v, rng):
        out = fill(u, (base, base, base))
        lines_u = [0.33, 0.7]
        lines_v = [0.22, 0.55, 0.85]
        for lu in lines_u:
            m = np.clip(1 - np.abs(u - lu) / 0.006, 0, 1)[..., None]
            out = out * (1 - m) + line * m
        for lv in lines_v:
            m = np.clip(1 - np.abs(v - lv) / 0.006, 0, 1)[..., None]
            out = out * (1 - m) + line * m
        for cx in (0.1, 0.9):
            for cy in (0.1, 0.9):
                r = np.hypot(u - cx, v - cy)
                m = np.clip(1 - r / 0.018, 0, 1)[..., None]
                out = out * (1 - m) + 0.7 * m
        # faint glaze variation
        out *= 1 + (np.sin(u * 9 + v * 5) * 0.015)[..., None]
        return out
    return p


def _seg_digit(u, v, x0, y0, w, h, segs):
    """7-segment stencil digit (gaps between segments read as stencil bridges)."""
    m = np.zeros(u.shape, dtype=bool)
    t = w * 0.24
    g = t * 0.45  # stencil bridge gap
    S = {
        "a": (x0 + g, y0 + h - t, x0 + w - g, y0 + h),
        "b": (x0 + w - t, y0 + h / 2 + g, x0 + w, y0 + h - g),
        "c": (x0 + w - t, y0 + g, x0 + w, y0 + h / 2 - g),
        "d": (x0 + g, y0, x0 + w - g, y0 + t),
        "e": (x0, y0 + g, x0 + t, y0 + h / 2 - g),
        "f": (x0, y0 + h / 2 + g, x0 + t, y0 + h - g),
        "g": (x0 + g, y0 + h / 2 - t / 2, x0 + w - g, y0 + h / 2 + t / 2),
    }
    for s in segs:
        a, b, c, d = S[s]
        m |= (u >= a) & (u <= c) & (v >= b) & (v <= d)
    return m


def paint_plate07(base=0.95, ink="#3a3f47"):
    def p(u, v, rng):
        out = paint_seams(base, 0.6)(u, v, rng)
        m = _seg_digit(u, v, 0.2, 0.3, 0.26, 0.42, "abcdef") | _seg_digit(u, v, 0.54, 0.3, 0.26, 0.42, "abc")
        mm = m.astype(np.float32)[..., None]
        c = np.array(hex_rgb(ink), dtype=np.float32)
        return out * (1 - mm) + c * mm
    return p


def paint_ink_cuff(base=0.92, ink="#1b1f36"):
    def p(u, v, rng):
        out = fill(u, (base, base, base))
        c = np.array(hex_rgb(ink), dtype=np.float32)
        for _ in range(7):
            cx, cy = rng.random(2)
            rx, ry = 0.006 + rng.random() * 0.016, 0.006 + rng.random() * 0.012
            m = cover(sd_ellipse(u, v, cx, cy, rx, ry), scale=min(rx, ry))
            out = out * (1 - m * 0.9) + c * m * 0.9
        return out
    return p


def paint_weave(a="#d8b866", b="#b8964a"):
    def p(u, v, rng):
        ca, cb = np.array(hex_rgb(a), dtype=np.float32), np.array(hex_rgb(b), dtype=np.float32)
        s = ((np.floor(u * 24) + np.floor(v * 24)) % 2).astype(np.float32)[..., None]
        stripe = (0.5 + 0.5 * np.sin((u + v) * 160))[..., None]
        out = ca * (1 - s) + cb * s
        return out * (0.9 + 0.1 * stripe)
    return p


def paint_face(skin, iris, eye_w=0.12, eye_h=0.15, eye_y=0.47, eye_dx=0.17, brows=True, mouth=True,
               lash="#20161a", brow="#3a241a", blush=True, slit=False, mouth_y=0.24, sclera="#fbf7f2"):
    """Anime-leaning face decal: big rounded eyes that read at three-quarter view. u right = the
    character's left (+X), v up."""
    def p(u, v, rng):
        out = fill(u, skin)
        skin_c = np.array(hex_rgb(skin), dtype=np.float32)
        lash_c = np.array(hex_rgb(lash), dtype=np.float32)
        for side in (-1, 1):
            cx = 0.5 + side * eye_dx
            cy = eye_y
            # sclera
            e = sd_ellipse(u, v, cx, cy, eye_w, eye_h)
            m = cover(e, scale=eye_w)
            out = out * (1 - m) + np.array(hex_rgb(sclera), dtype=np.float32) * m
            # iris with a darker top band and lighter bottom (anime gradient)
            ir = sd_ellipse(u, v, cx, cy - eye_h * 0.08, eye_w * 0.78, eye_h * 0.8)
            mi = cover(ir, scale=eye_w) * m
            ic = np.array(hex_rgb(iris), dtype=np.float32)
            grad = np.clip((v - (cy - eye_h)) / (2 * eye_h), 0, 1)[..., None]
            icol = ic * (1.25 - 0.65 * grad)
            out = out * (1 - mi) + icol * mi
            # pupil
            if slit:
                pu = sd_ellipse(u, v, cx, cy - eye_h * 0.08, eye_w * 0.16, eye_h * 0.62)
            else:
                pu = sd_ellipse(u, v, cx, cy - eye_h * 0.08, eye_w * 0.36, eye_h * 0.4)
            mp = cover(pu, scale=eye_w) * m
            out = out * (1 - mp) + np.array(hex_rgb("#120c10"), dtype=np.float32) * mp
            # highlights
            for hx, hy, hr in ((-0.35, 0.3, 0.22), (0.3, -0.38, 0.1)):
                hs = sd_ellipse(u, v, cx + hx * eye_w, cy + hy * eye_h, eye_w * hr, eye_w * hr)
                mh = cover(hs, scale=eye_w * hr) * m
                out = out * (1 - mh) + 1.0 * mh
            # thick upper lash line following the top of the eye, with a small outer flick
            top = np.abs(sd_ellipse(u, v, cx, cy - eye_h * 0.05, eye_w * 1.08, eye_h * 1.05))
            upper = (v > cy + eye_h * 0.15).astype(np.float32)[..., None]
            ml = np.clip(1 - top / 0.075, 0, 1)[..., None] * upper
            flick = cover(sd_ellipse(u, v, cx + side * eye_w * 1.05, cy + eye_h * 0.62, eye_w * 0.28, eye_h * 0.14),
                          scale=eye_w * 0.2)
            ml = np.maximum(ml, flick)
            out = out * (1 - ml) + lash_c * ml
            # lower lash hint
            low = np.abs(sd_ellipse(u, v, cx, cy + eye_h * 0.05, eye_w * 0.95, eye_h * 1.02))
            lower = ((v < cy - eye_h * 0.55) & (np.abs(u - cx) < eye_w * 0.6)).astype(np.float32)[..., None]
            mlow = np.clip(1 - low / 0.04, 0, 1)[..., None] * lower * 0.6
            out = out * (1 - mlow) + lash_c * mlow
            if brows:
                b = sd_ellipse(u, v, cx + side * 0.01, cy + eye_h * 1.75, eye_w * 1.0, eye_h * 0.16)
                mb = cover(b, scale=eye_w * 0.2)
                out = out * (1 - mb) + np.array(hex_rgb(brow), dtype=np.float32) * mb
            if blush:
                bl = sd_ellipse(u, v, cx + side * 0.04, cy - eye_h * 1.45, eye_w * 0.8, eye_h * 0.25)
                mbl = np.clip(-bl, 0, 1)[..., None] * 0.18
                out = out * (1 - mbl) + np.array(hex_rgb("#e0786a"), dtype=np.float32) * mbl
        if mouth:
            mo = sd_ellipse(u, v, 0.5, mouth_y, 0.05, 0.012)
            mm = cover(mo, scale=0.012) * 0.85
            out = out * (1 - mm) + np.array(hex_rgb("#7a3a34"), dtype=np.float32) * mm
            # tiny nose tick
            no = sd_ellipse(u, v, 0.505, eye_y - eye_h * 1.05, 0.01, 0.006)
            mn = cover(no, scale=0.006) * 0.5
            out = out * (1 - mn) + skin_c * 0.7 * mn
        return out
    return p
