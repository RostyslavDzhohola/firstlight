# FIRSTLIGHT sculpted characters: stitch render.py outputs into one contact sheet PNG.
#
#   python3 -I contact_sheet.py <out.png> "Title" <row title>=<png>[,<png>...] ...
#
# Each row is one or more images scaled to the same height and laid side by side under its title.
# Our own code: MIT.

import sys

from PIL import Image, ImageDraw, ImageFont

W = 1800
PAD = 16
BG = (28, 30, 36)
FG = (230, 232, 238)


def font(size):
    for path in ("/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Helvetica.ttc"):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def main():
    out, title, rows = sys.argv[1], sys.argv[2], sys.argv[3:]
    f_title, f_row = font(34), font(24)
    blocks = []
    for r in rows:
        name, paths = r.split("=", 1)
        ims = [Image.open(p).convert("RGB") for p in paths.split(",")]
        gap = 6
        total_w = W - 2 * PAD - gap * (len(ims) - 1)
        aspect = sum(im.width / im.height for im in ims)
        h = int(total_w / aspect)
        row = Image.new("RGB", (W - 2 * PAD, h), BG)
        x = 0
        for im in ims:
            w = int(im.width * h / im.height)
            row.paste(im.resize((w, h), Image.LANCZOS), (x, 0))
            x += w + gap
        blocks.append((name, row))
    H = PAD + 50 + sum(36 + b.height + PAD for _, b in blocks)
    sheet = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(sheet)
    d.text((PAD, PAD), title, font=f_title, fill=FG)
    y = PAD + 50
    for name, b in blocks:
        d.text((PAD, y), name, font=f_row, fill=FG)
        y += 36
        sheet.paste(b, (PAD, y))
        y += b.height + PAD
    sheet.save(out)
    print("SHEET", out, sheet.size)


main()
