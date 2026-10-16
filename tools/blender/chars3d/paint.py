# FIRSTLIGHT sculpted characters: procedural "hand painting" in numpy.
# Everything works on arrays of surface samples (texels or vertices): P positions (rest pose, metres),
# N normals, optional AO and cavity. Colours are sRGB in [0, 1].
# Our own code: MIT. The painted textures are CC BY 4.0.

import numpy as np

import sdf as S

F = np.float32


def hexc(h):
    h = h.lstrip("#")
    return np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)], dtype=F)


def mix(a, b, t):
    t = np.asarray(t, dtype=F)
    if t.ndim == 1:
        t = t[:, None]
    return a * (1 - t) + b * t


def fill(n, c):
    return np.tile(np.asarray(c, dtype=F)[None, :], (n, 1))


def sstep(a, b, x):
    return S.smoothstep(a, b, x)


def soft_ellipse(u, v, cu, cv, ru, rv, edge=0.15, rot=0.0):
    """1 inside an ellipse, 0 outside, soft edge (fraction of the radius)."""
    du, dv = u - cu, v - cv
    if rot:
        c, s = np.cos(rot), np.sin(rot)
        du, dv = du * c + dv * s, -du * s + dv * c
    r = np.sqrt((du / ru) ** 2 + (dv / rv) ** 2)
    return 1 - sstep(1 - edge, 1 + edge, r)


def stroke(u, v, pts, width, soft=0.35):
    """Soft brush stroke along a polyline [(u, v)...] with width (scalar or per-point list)."""
    out = np.zeros(len(u), dtype=F)
    widths = width if isinstance(width, (list, tuple)) else [width] * len(pts)
    for i in range(len(pts) - 1):
        a = np.array(pts[i], dtype=F)
        b = np.array(pts[i + 1], dtype=F)
        d = b - a
        L2 = float(d @ d) or 1e-12
        t = np.clip(((u - a[0]) * d[0] + (v - a[1]) * d[1]) / L2, 0, 1)
        du = u - (a[0] + t * d[0])
        dv = v - (a[1] + t * d[1])
        dist = np.sqrt(du * du + dv * dv)
        w = widths[i] * (1 - t) + widths[i + 1] * t
        out = np.maximum(out, 1 - sstep(w * (1 - soft), w * (1 + soft * 0.5), dist))
    return out


# ---------------------------------------------------------------------------------------------
# faces


class Face:
    """Painted face: eyes (sclera, iris with gradient, pupil, two catch-lights, heavy upper lash),
    brows, mouth, blush. Coordinates are the head's front projection (anat.Head.face_uv)."""

    def __init__(self, iris="#3a8fb8", iris_dark="#173a5a", lash="#2a1a14", brow="#4b2f25", sclera="#f6f1ea",
                 mouth="#9a4a42", blush="#f0907a", blush_amt=0.35, eye_x=0.045, eye_w=0.038, eye_h=0.046,
                 iris_r=0.0168, look=(0.0, 0.0), brow_tilt=0.0, brow_lift=0.0, brow_w=0.0034, smile=0.004,
                 mouth_w=0.015, mouth_y=-0.066, lid=0.0, lower_lid=0.0, lash_w=0.0032, brows=True, mouth_on=True,
                 eye_tilt=0.0, lid_line=True, glow=0.0):
        self.__dict__.update(locals())
        del self.__dict__["self"]

    def eye_masks(self, u, v):
        """Per side: returns dict of masks for the eye on the side of each sample."""
        s = np.sign(u)
        s[s == 0] = 1
        au = np.abs(u)
        ex, ew, eh = self.eye_x, self.eye_w * 0.5, self.eye_h * 0.5
        # eye white: a rounded shape, flatter top under the lid, rounder bottom
        du = au - ex
        dv = v.copy()
        if self.eye_tilt:
            dv = dv - du * self.eye_tilt
        top = eh * (1 - self.lid)
        rv = np.where(dv > 0, top, eh)
        shape = np.sqrt((du / ew) ** 2 + (dv / rv) ** 2)
        white = 1 - sstep(0.94, 1.02, shape)
        lu, lv = self.look
        ir = self.iris_r
        ic = (du - lu * ew * 0.5, dv - lv * eh * 0.4 + eh * 0.04)
        rr = np.sqrt(ic[0] ** 2 + (ic[1] / 1.12) ** 2)
        iris = (1 - sstep(ir * 0.94, ir * 1.02, rr)) * white
        pupil = (1 - sstep(ir * 0.42, ir * 0.5, rr)) * white
        hl1 = soft_ellipse(du * s, dv, -0.0045 + ex * 0, eh * 0.28, ir * 0.36, ir * 0.3, 0.3)  # outer-upper catchlight
        hl1 = soft_ellipse(du, dv, -s * 0 + ir * 0.35 * s, eh * 0.25, ir * 0.34, ir * 0.3, 0.3)
        hl2 = soft_ellipse(du, dv, -ir * 0.3 * s, -eh * 0.32, ir * 0.17, ir * 0.14, 0.3)
        # upper lash: a thick band hugging the top of the eye, thicker and flicked at the outer corner
        lash_t = self.lash_w * (1.0 + 0.9 * sstep(-0.2 * ew, ew, du))
        top_edge = np.abs(shape - 1.0) * np.minimum(rv, ew)
        upper = (dv > -eh * 0.15) & (shape > 0.7)
        lash = (1 - sstep(lash_t * 0.6, lash_t, top_edge)) * upper
        flick = stroke(du, dv, [(ew * 0.85, eh * 0.35), (ew * 1.22, eh * 0.62)], [lash_t * 0.8, lash_t * 0.15])
        lash = np.maximum(lash, flick)
        lower = (dv < -eh * 0.35) & (du > -ew * 0.1)
        lash_low = (1 - sstep(0.0008, 0.0016, top_edge)) * lower * 0.55
        crease = np.zeros_like(u)
        if self.lid_line:
            cr = np.sqrt((du / (ew * 1.08)) ** 2 + ((dv - eh * 0.2) / (top * 1.18)) ** 2)
            crease = (1 - sstep(0.0, 0.07, np.abs(cr - 1.0))) * (dv > eh * 0.45) * 0.35
        return dict(white=white, iris=iris, pupil=pupil, hl1=hl1 * white, hl2=hl2 * white, lash=np.maximum(lash, lash_low),
                    crease=crease, ic=ic, rr=rr)

    def paint(self, rgb, u, v, front):
        """Paint over skin colours rgb (N,3) where front (0..1) says the sample faces forward."""
        n = len(u)
        out = rgb.copy()
        au = np.abs(u)
        # blush on the cheeks and the nose tip
        if self.blush_amt:
            bl = soft_ellipse(au, v, self.eye_x + 0.006, -0.036, 0.022, 0.013, 0.9) * self.blush_amt
            bl = np.maximum(bl, soft_ellipse(au, v, 0.0, -0.035, 0.009, 0.007, 0.9) * self.blush_amt * 0.5)
            out = mix(out, hexc(self.blush), bl * front)
        m = self.eye_masks(u, v)
        f = front
        sc = hexc(self.sclera)
        out = mix(out, sc, m["white"] * f)
        # iris: dark rim, darker top, warm lighter bottom
        rr, ir = m["rr"], self.iris_r
        ic_v = m["ic"][1]
        ib = mix(fill(n, hexc(self.iris_dark)), fill(n, hexc(self.iris)), sstep(ir * 0.7, -ir * 0.6, ic_v))
        ib = mix(ib, fill(n, np.minimum(hexc(self.iris) * 1.35 + 0.08, 1.0)), sstep(-ir * 0.1, -ir * 0.9, ic_v) * 0.45)
        ib = mix(ib, fill(n, hexc(self.iris_dark) * 0.6), sstep(ir * 0.75, ir * 0.98, rr))
        out = mix(out, ib, m["iris"] * f)
        out = mix(out, fill(n, hexc(self.iris_dark) * 0.35), m["pupil"] * f)
        # lid shadow across the top of the eye
        sh = sstep(0.2, 1.0, v / (self.eye_h * 0.5)) * m["white"] * 0.35
        out = out * (1 - (sh * f)[:, None])
        out = mix(out, fill(n, (1, 1, 1)), np.maximum(m["hl1"], m["hl2"]) * f)
        out = mix(out, fill(n, hexc(self.lash)), m["lash"] * f)
        out = mix(out, out * 0.8, m["crease"] * f)
        if self.brows:
            s = np.sign(u)
            bx = self.eye_x + 0.002
            by = self.eye_h * 0.5 + 0.012 + self.brow_lift
            t = self.brow_tilt
            pts = [(bx - 0.019, by - 0.002 - t), (bx - 0.004, by + 0.003), (bx + 0.012, by + 0.002 + t * 0.6),
                   (bx + 0.021, by - 0.004 + t * 0.8)]
            br = stroke(au, v, pts, [self.brow_w * 0.9, self.brow_w * 1.15, self.brow_w * 0.9, self.brow_w * 0.35])
            out = mix(out, fill(n, hexc(self.brow)), br * f)
        if self.mouth_on:
            mw, my, sm = self.mouth_w, self.mouth_y, self.smile
            pts = [(-mw, my + sm), (-mw * 0.45, my + sm * 0.15), (0, my), (mw * 0.45, my + sm * 0.15), (mw, my + sm)]
            line = stroke(u, v, pts, [0.0007, 0.0013, 0.0015, 0.0013, 0.0007])
            out = mix(out, fill(n, hexc(self.mouth)), line * f * 0.9)
            lip = soft_ellipse(u, v, 0.0, my - 0.0045, mw * 0.45, 0.0025, 0.8) * 0.18
            out = mix(out, out * F(0.85) + hexc(self.mouth) * F(0.15), lip * f)
        if self.glow:
            pass
        return out, m


# ---------------------------------------------------------------------------------------------
# generic surface treatments


def shade(rgb, P, N, ao=None, cavity=None, ao_tint="#5a3a40", ao_amt=0.55, top_light=0.12, cav_amt=0.35,
          edge_amt=0.12, z_range=(0.0, 1.9)):
    """Painterly shading baked into the albedo: warm ambient occlusion, cavity darkening, worn convex
    edges, a soft top-down light gradient."""
    out = rgb.copy()
    if ao is not None:
        a = np.clip(ao, 0, 1)[:, None]
        tint = hexc(ao_tint)
        occ = out * (tint * 0.6 + 0.4)
        out = out * a + occ * (1 - a) * (1 - ao_amt) + out * (1 - a) * (ao_amt * 0)
        out = mix(rgb, out, ao_amt / 0.55 if ao_amt < 0.55 else 1.0)
    if cavity is not None:
        cav = np.clip(-cavity, 0, 1)
        out = out * (1 - cav_amt * cav)[:, None]
        edge = np.clip(cavity, 0, 1)
        out = out + (1 - out) * (edge_amt * edge)[:, None]
    if top_light:
        t = np.clip((P[:, 2] - z_range[0]) / (z_range[1] - z_range[0]), 0, 1)
        up = np.clip(N[:, 2], -1, 1) * 0.5 + 0.5
        out = out * (1 - top_light + top_light * (0.55 * t + 0.45 * up) * 1.6)[:, None]
    return np.clip(out, 0, 1)


def variation(rgb, P, amt=0.06, freq=9.0, seed=0, hue=0.03):
    """Low-frequency colour variation (value and a little hue) like uneven paint."""
    n1 = S.fbm(P, freq, 3, seed)
    n2 = S.fbm(P, freq * 1.7, 2, seed + 5)
    out = rgb * (1 + amt * n1)[:, None]
    out[:, 0] += hue * n2
    out[:, 2] -= hue * n2
    return np.clip(out, 0, 1)


def weave(P, freq=420.0, amt=0.05):
    """Fine cloth weave as a value modulation."""
    a = np.sin(P[:, 0] * freq + P[:, 2] * freq * 0.15) * np.sin(P[:, 2] * freq + P[:, 1] * freq * 0.2)
    return 1 - amt * (a * 0.5 + 0.5)


def strands(P, axis, freq=900.0, amt=0.18, seed=3):
    """Hair-strand streaks across `axis` (direction of the hair flow)."""
    ax = np.asarray(axis, dtype=F)
    ax = ax / np.linalg.norm(ax)
    # project out the flow direction and stripe across it, wobbling slightly
    Q = P - (P @ ax)[:, None] * ax[None, :]
    n = S.vnoise(Q * F(1.0), freq * 0.05, seed)
    s = np.sin((Q[:, 0] + Q[:, 1] * 0.7 + Q[:, 2] * 0.4) * freq + n * 6.0)
    return 1 - amt * (s * 0.5 + 0.5)
