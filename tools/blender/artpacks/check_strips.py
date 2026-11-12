# HD art pack check (#48): an HD texture, box-filtered down to the shipped size, must match the shipped
# texture closely (same layers in the same order, the same UV layout), or the client would draw the wrong
# kit texture or paint on the wrong part of a model. Our own code: MIT.
#
#   python3 -I check_strips.py <hd.webp> <shipped.webp> [--layers N]    # strips: per-layer PSNR
#   python3 -I check_strips.py <hd image> <shipped image>                # one image
#
# Prints the PSNR (dB) per layer (or of the whole image) and exits non-zero below 26 dB.
import sys

import numpy as np
from PIL import Image

MIN_DB = 26.0


def load(path):
    with Image.open(path) as im:
        return np.asarray(im.convert("RGBA"), dtype=np.float32) / 255.0


def layers_of(px, n):
    """Split a strip into its n square layers (any column count; pack.py save_strip)."""
    h, w, _ = px.shape
    for cols in range(1, n + 1):
        size = w // cols
        if size * cols == w and h == size * -(-n // cols):
            return [px[(i // cols) * size:(i // cols + 1) * size, (i % cols) * size:(i % cols + 1) * size] for i in range(n)]
    raise SystemExit(f"{w}x{h} is no grid of {n} square layers")


def box_down(px, size):
    k = px.shape[0] // size
    return px[:size * k, :size * k].reshape(size, k, size, k, 4).mean(axis=(1, 3))


def psnr(a, b, alpha):
    """RGB PSNR where the shipped alpha is set (cutout layers: the colour under a zero mask is undefined)."""
    m = alpha > 0.5
    if not m.any():
        return float("inf")
    err = ((a[..., :3] - b[..., :3]) ** 2)[m].mean()
    return float("inf") if err == 0 else 10 * np.log10(1.0 / err)


def main():
    hd, shipped = load(sys.argv[1]), load(sys.argv[2])
    n = int(sys.argv[sys.argv.index("--layers") + 1]) if "--layers" in sys.argv else 0
    pairs = list(zip(layers_of(hd, n), layers_of(shipped, n))) if n else [(hd, shipped)]
    worst = float("inf")
    for i, (a, b) in enumerate(pairs):
        d = psnr(box_down(a, b.shape[0]), b, b[..., 3])
        worst = min(worst, d)
        print(f"{'layer ' + str(i) if n else 'image'}: {d:.1f} dB")
    print(f"worst {worst:.1f} dB")
    sys.exit(0 if worst >= MIN_DB else 1)


main()
