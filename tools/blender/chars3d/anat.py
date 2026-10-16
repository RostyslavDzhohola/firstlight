# FIRSTLIGHT sculpted characters: stylised anatomy on the shared skeleton (heads, hands, limbs, torso)
# as signed-distance fields, plus the face-paint helpers that go with each head.
# Proportions: the head is ~1.35x life size (about 6 heads tall), hands ~1.1x, so faces and gestures
# read at game distance. Our own code: MIT.

import math
import numpy as np

import sdf as S
from sdf import vec

F = np.float32


# ---------------------------------------------------------------------------------------------
# heads


def curve(keys):
    """Smooth 1D curve through (x, y) keys (Catmull-Rom, clamped ends) -> f(x array)."""
    xs = np.array([k[0] for k in keys], dtype=np.float64)
    ys = np.array([k[1] for k in keys], dtype=np.float64)
    order = np.argsort(xs)
    xs, ys = xs[order], ys[order]
    n = len(xs)
    m = np.zeros(n)
    for i in range(n):
        a, b = max(i - 1, 0), min(i + 1, n - 1)
        m[i] = (ys[b] - ys[a]) / (xs[b] - xs[a]) if b != a else 0.0

    def f(x):
        x = np.clip(np.asarray(x, dtype=np.float64), xs[0], xs[-1])
        i = np.clip(np.searchsorted(xs, x) - 1, 0, n - 2)
        h = xs[i + 1] - xs[i]
        t = (x - xs[i]) / h
        t2, t3 = t * t, t * t * t
        y = (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + \
            (t3 - t2) * h * m[i + 1]
        return y.astype(F)
    return f


def ellipse2(x, y, a, e):
    """Approximate signed distance to an axis-aligned ellipse with per-point semi-axes (IQ bound)."""
    k0 = np.sqrt((x / a) ** 2 + (y / e) ** 2)
    k1 = np.sqrt((x / (a * a)) ** 2 + (y / (e * e)) ** 2)
    return k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)


# Head profiles, metres, z relative to the eye line: yf = face front, yb = back of the skull,
# w = half width, ym = where the width peaks. The crown and the chin close with ellipsoidal caps.
HEAD_PROFILE = {
    "yf": [(-0.104, -0.1), (-0.081, -0.111), (-0.054, -0.119), (-0.027, -0.123), (0.0, -0.121), (0.03, -0.119)],
    "yb": [(-0.104, -0.03), (-0.081, 0.028), (-0.054, 0.078), (-0.027, 0.11), (0.0, 0.127), (0.03, 0.134)],
    "w": [(-0.104, 0.048), (-0.081, 0.076), (-0.054, 0.096), (-0.027, 0.107), (0.0, 0.111), (0.03, 0.116)],
    "ym": [(-0.104, -0.05), (-0.081, -0.01), (-0.054, 0.008), (0.0, 0.012), (0.03, 0.012)],
}
CROWN = {"z": 0.045, "y": 0.008, "r": (0.117, 0.127, 0.118)}  # top cap: centre height, centre y, radii
CHIN = {"z": -0.1, "y": -0.066, "r": (0.045, 0.034, 0.032)}  # bottom cap


def head_profile(face=None, crown=None, chin=None):
    prof = {k: list(v) for k, v in HEAD_PROFILE.items()}
    for k, v in (face or {}).items():
        prof[k] = list(v)
    cr = dict(CROWN, **(crown or {}))
    ch = dict(CHIN, **(chin or {}))
    for t in (0.18, 0.38, 0.56, 0.72, 0.85, 0.94, 0.985):
        z = cr["z"] + cr["r"][2] * t
        s = math.sqrt(max(0.0, 1 - t * t))
        prof["w"].append((z, cr["r"][0] * s))
        prof["yf"].append((z, cr["y"] - cr["r"][1] * s))
        prof["yb"].append((z, cr["y"] + cr["r"][1] * s))
        prof["ym"].append((z, cr["y"]))
    for t in (0.3, 0.55, 0.75, 0.9, 0.97):
        z = ch["z"] - ch["r"][2] * t
        s = math.sqrt(max(0.0, 1 - t * t))
        prof["w"].append((z, ch["r"][0] * s))
        prof["yf"].append((z, ch["y"] - ch["r"][1] * s))
        prof["yb"].append((z, ch["y"] + ch["r"][1] * s))
        prof["ym"].append((z, ch["y"]))
    zr = (ch["z"] - ch["r"][2] * 0.995, cr["z"] + cr["r"][2] * 0.995)
    return prof, zr


class Head:
    """A stylised head. Local frame: origin on the eye line at the midline, X left, -Y forward, Z up.
    Construction: a lofted skull/face (front, back and width profiles per height, so the jaw line and
    chin are drawn, not blobbed), then soft cheeks, a small upturned nose, eye dishes, a brow ridge,
    ears and a neck, all smooth-unioned."""

    def __init__(self, c=(0.0, 0.0, 1.725), profile=None, crown=None, chin=None, scale=1.0, cheek_c=(0.05, -0.1, -0.036),
                 cheek_r=(0.026, 0.016, 0.02), nose=(0.0, -0.124, -0.026), nose_r=(0.0105, 0.0115, 0.016), nose_tip=0.0085,
                 ears=(0.016, 0.026, 0.035), ear_c=(0.106, 0.02, -0.012), eye_x=0.045, eye_z=0.0, eye_w=0.038,
                 eye_h=0.046, socket=0.0018, neck_r=0.05, neck_len=0.2, brow=0.0, ear_tilt=10.0, cheek_k=0.0,
                 vox=0.0012):
        self.c = vec(c)
        c = self.c
        self.eye_x, self.eye_z, self.eye_w, self.eye_h = eye_x, eye_z, eye_w, eye_h
        prof, zr = head_profile(profile, crown, chin)
        pc = {k: curve(prof[k]) for k in prof}
        self.scale = scale
        V, T, Q = S.loft(pc, z_range=zr)
        V = V + c
        self.mesh = (V, T, Q)
        skull = S.MeshField(V, T, Q, vox=vox, band=0.05)
        cheeks = S.mirror_x(S.ellipsoid(c + vec(cheek_c), cheek_r))
        nose_b = S.ellipsoid(c + vec(nose), nose_r, S.rot((1, 0, 0), -24))
        tip = S.sphere(c + vec(nose) + vec((0, -0.008, -0.011)), nose_tip)
        neck = S.round_cone(c + vec((0, 0.03, -neck_len)), c + vec((0, 0.025, -0.05)), neck_r, neck_r * 0.95)
        sock = S.mirror_x(S.ellipsoid(c + vec((eye_x, -0.14, eye_z)), (eye_w * 0.95, 0.03, eye_h * 0.7)))
        browf = S.mirror_x(S.ellipsoid(c + vec((eye_x + 0.003, -0.115, eye_z + eye_h * 0.88)), (eye_w * 0.95, 0.012, 0.0075)))
        ear_shapes = []
        if ears:
            Re = S.rot((0, 1, 0), ear_tilt) @ S.rot((0, 0, 1), -15)
            ear_outer = S.ellipsoid(c + vec(ear_c), ears, Re)
            ear_cup = S.ellipsoid(c + vec(ear_c) + vec((0.008, -0.003, 0.0)),
                                  (ears[0] * 0.55, ears[1] * 0.62, ears[2] * 0.66), Re)
            ear_shapes.append(S.mirror_x(S.ssub(ear_outer, ear_cup, 0.006)))

        def field(P):
            d = skull(P)
            if cheek_k > 0:
                d = S.smin(d, cheeks(P), cheek_k)
            d = S.smin(d, neck(P), 0.06)
            if socket > 0:
                d = S.smax(d, -sock(P) - socket, 0.025)
            if brow > 0:
                d = S.smin(d, browf(P) + 0.0075 - brow, 0.02)
            d = S.smin(d, nose_b(P), 0.02)
            d = S.smin(d, tip(P), 0.01)
            for e in ear_shapes:
                d = S.smin(d, e(P), 0.012)
            return d
        if scale != 1.0:
            # stylisation: the whole head (face paint included, see face_uv) grows about the eye line
            inv = F(1.0 / scale)
            self.field = lambda P: field((P - c) * inv + c) * F(scale)
        else:
            self.field = field

    # face-space helpers for painting: front projection relative to the cranium centre
    def face_uv(self, P):
        """(u, v) in metres: u = character-left distance from the midline, v = height above the eye line."""
        return (P[:, 0] - self.c[0]) / self.scale, (P[:, 2] - self.c[2]) / self.scale - self.eye_z

    def front(self, P, N=None):
        """Weight that a point is on the face side (soft)."""
        w = S.smoothstep(-0.02, -0.07, (P[:, 1] - self.c[1]) / self.scale)
        if N is not None:
            w = w * S.smoothstep(0.1, 0.5, -N[:, 1])
        return w


# ---------------------------------------------------------------------------------------------
# hands, limbs, torso


FINGERS = ("index", "middle", "ring", "pinky")


def hand(sk, s, scale=1.1, mitten=False, finger_r=0.0105, palm=(0.05, 0.017), k=0.012):
    """Stylised hand on side s (+1 left / -1 right) along the hand and finger bones. Rest pose:
    fingers straight along +-X, palm facing down (-Z), thumb forward-down."""
    sd = "l" if s > 0 else "r"
    h0 = sk.head(f"hand_{sd}")
    m0 = sk.head(f"middle_01_{sd}")
    piv = h0
    parts = []
    ax = S.norm(m0 - h0)
    L = float(np.linalg.norm(m0 - h0))
    R = S.frame(ax, (0, 0, 1))  # columns: x side, y along, z up
    pc = (h0 + m0) * 0.5 + vec((0, 0.0, 0.002))
    parts.append(S.box(pc, (palm[0] * 0.5 * 1.0, L * 0.55, palm[1] * 0.5), R, rad=0.012))
    radii = {"index": 1.0, "middle": 1.05, "ring": 0.97, "pinky": 0.85}
    for fn in FINGERS:
        pts = [sk.head(f"{fn}_01_{sd}"), sk.head(f"{fn}_02_{sd}"), sk.head(f"{fn}_03_{sd}"), sk.tail(f"{fn}_03_{sd}")]
        # pull the knuckles back into the palm a little so the hand reads as one form
        pts[0] = pts[0] - ax * 0.012
        r = finger_r * radii[fn]
        if mitten:
            continue
        parts.append(S.tube(pts, [r * 1.05, r * 1.0, r * 0.93, r * 0.82], k=0.004))
    if mitten:
        a = sk.head(f"index_01_{sd}")
        b = sk.tail(f"pinky_03_{sd}")
        tipm = sk.tail(f"middle_03_{sd}")
        mc = (sk.head(f"middle_01_{sd}") + tipm) * 0.5
        parts.append(S.box(mc, (0.047, float(np.linalg.norm(tipm - sk.head(f"middle_01_{sd}"))) * 0.5, 0.012),
                           S.frame(ax, (0, 0, 1)), rad=0.011))
    tp = [sk.head(f"thumb_01_{sd}"), sk.head(f"thumb_02_{sd}"), sk.head(f"thumb_03_{sd}"), sk.tail(f"thumb_03_{sd}")]
    tr = finger_r * 1.12
    parts.append(S.tube(tp, [tr * 1.25, tr * 1.1, tr, tr * 0.88], k=0.004))
    f = S.smin_all(parts, k)
    if scale != 1.0:
        inv = 1.0 / scale
        return lambda P: f((P - piv) * F(inv) + piv) * F(scale)
    return f


def limb(sk, bones, radii, k=0.03, t0=0.0, t1=1.0):
    """Round cones along a bone chain; radii has len(bones)+1 entries (joint radii)."""
    pts = [sk.head(bones[0])] + [sk.tail(b) for b in bones]
    if t0:
        pts[0] = pts[0] * (1 - t0) + pts[1] * t0
    if t1 != 1.0:
        pts[-1] = pts[-2] * (1 - t1) + pts[-1] * t1
    segs = [S.round_cone(pts[i], pts[i + 1], radii[i], radii[i + 1]) for i in range(len(bones))]
    return S.smin_all(segs, k)


def torso(chest=(0.155, 0.105, 0.125), belly=(0.13, 0.095, 0.11), hips=(0.155, 0.11, 0.1), chest_z=1.33,
          belly_z=1.14, hips_z=0.96, k=0.06, shoulders=0.05):
    ch = S.ellipsoid((0, 0.005, chest_z), chest)
    be = S.ellipsoid((0, 0.0, belly_z), belly)
    hp = S.ellipsoid((0, 0.012, hips_z), hips)
    sh = S.capsule((0.15, 0.03, 1.43), (-0.15, 0.03, 1.43), shoulders)

    def f(P):
        d = S.smin(ch(P), be(P), k)
        d = S.smin(d, hp(P), k)
        d = S.smin(d, sh(P), 0.06)
        return d
    return f


def legs(sk, thigh=(0.085, 0.062), calf=(0.06, 0.04), knee=0.055, k=0.03, calf_bulge=0.012):
    out = []
    for s in (1, -1):
        sd = "l" if s > 0 else "r"
        a, b, c = sk.head(f"thigh_{sd}"), sk.tail(f"thigh_{sd}"), sk.tail(f"calf_{sd}")
        th = S.round_cone(a + vec((0, 0, 0.02)), b, thigh[0], knee)
        ca = S.round_cone(b, c, knee * 0.98, calf[1])
        bul = S.ellipsoid(b * 0.62 + c * 0.38 + vec((0, 0.018, 0)), (calf[0], calf[0] + calf_bulge, 0.11))
        out += [th, ca, bul]
    return S.smin_all(out, k)


def arms(sk, upper=(0.05, 0.042), fore=(0.04, 0.03), k=0.025, t1=1.0):
    out = []
    for s in (1, -1):
        sd = "l" if s > 0 else "r"
        a, b, c = sk.head(f"upperarm_{sd}"), sk.tail(f"upperarm_{sd}"), sk.tail(f"lowerarm_{sd}")
        c = b * (1 - t1) + c * t1
        out.append(S.round_cone(a, b, upper[0], upper[1]))
        out.append(S.round_cone(b, c, fore[0], fore[1]))
    return S.smin_all(out, k)
