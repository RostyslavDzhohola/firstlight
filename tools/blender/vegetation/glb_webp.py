# Re-encode the PNG images embedded in a GLB as lossless WebP (EXT_texture_webp), every pixel kept
# (D-perf-2). cwebp -lossless -exact keeps the RGB under transparent texels too, so cutout edges and
# mipmaps filter exactly as before. Each image is decoded back (dwebp) and compared with the PNG
# (ffmpeg, RGBA) before the file is written; any difference fails the run. Every other buffer view
# (meshopt-compressed or not) is copied byte for byte, only moved.
#   python3 -I glb_webp.py <in.glb> <out.glb>
# Needs cwebp, dwebp and ffmpeg on PATH. Our own code: MIT.
import json
import os
import struct
import subprocess
import sys
import tempfile

EXT = "EXT_texture_webp"


def read_glb(path):
    b = open(path, "rb").read()
    magic, version, _ = struct.unpack("<4sII", b[:12])
    assert magic == b"glTF" and version == 2, "not a glTF 2 binary"
    n, kind = struct.unpack("<I4s", b[12:20])
    assert kind == b"JSON"
    doc = json.loads(b[20:20 + n])
    off = 20 + n
    bn, bkind = struct.unpack("<I4s", b[off:off + 8])
    assert bkind == b"BIN\x00"
    return doc, b[off + 8:off + 8 + bn]


def write_glb(path, doc, bin_):
    js = json.dumps(doc, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    bin_ += b"\x00" * (-len(bin_) % 4)
    body = struct.pack("<I4s", len(js), b"JSON") + js + struct.pack("<I4s", len(bin_), b"BIN\x00") + bin_
    open(path, "wb").write(struct.pack("<4sII", b"glTF", 2, 12 + len(body)) + body)


def rgba(path, tmp):
    raw = os.path.join(tmp, os.path.basename(path) + ".rgba")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgba", raw], check=True)
    return open(raw, "rb").read()


def to_webp(png, tmp, name):
    src, dst, back = (os.path.join(tmp, f"{name}.{e}") for e in ("png", "webp", "back.png"))
    open(src, "wb").write(png)
    subprocess.run(["cwebp", "-quiet", "-lossless", "-exact", "-z", "9", "-metadata", "none", src, "-o", dst], check=True)
    subprocess.run(["dwebp", "-quiet", dst, "-o", back], check=True)
    if rgba(src, tmp) != rgba(back, tmp):
        raise SystemExit(f"{name}: the WebP does not decode to the PNG's pixels")
    return open(dst, "rb").read()


def segments(doc):
    """Every (holder, key prefix) that points into buffer 0: plain views and meshopt sources."""
    out = []
    for v in doc["bufferViews"]:
        if v.get("buffer") == 0:
            out.append(v)
        mo = v.get("extensions", {}).get("EXT_meshopt_compression")
        if mo and mo.get("buffer") == 0:
            out.append(mo)
    return sorted(out, key=lambda s: s.get("byteOffset", 0))


def main(src, dst):
    doc, bin_ = read_glb(src)
    replace = {}
    with tempfile.TemporaryDirectory() as tmp:
        for i, im in enumerate(doc.get("images", [])):
            if im.get("mimeType") != "image/png" or "bufferView" not in im:
                continue
            v = doc["bufferViews"][im["bufferView"]]
            o = v.get("byteOffset", 0)
            webp = to_webp(bin_[o:o + v["byteLength"]], tmp, im.get("name") or f"image{i}")
            replace[id(v)] = webp
            im["mimeType"] = "image/webp"
            print(f"WEBP {im.get('name', i)}: {v['byteLength']} -> {len(webp)} bytes, pixels identical")
    if not replace:
        print("WEBP nothing to do")
        write_glb(dst, doc, bin_)
        return
    # Rebuild buffer 0 in the same order, 16-byte aligned, the images swapped.
    new, end = bytearray(), 0
    for s in segments(doc):
        o, n = s.get("byteOffset", 0), s["byteLength"]
        assert o >= end, "overlapping buffer views"
        end = o + n
        data = replace.get(id(s), bin_[o:o + n])
        new += b"\x00" * (-len(new) % 16)
        s["byteOffset"], s["byteLength"] = len(new), len(data)
        new += data
    doc["buffers"][0]["byteLength"] = len(new)
    # The images are WebP now: textures name them through the extension (required: no PNG fallback).
    webp_images = {i for i, im in enumerate(doc["images"]) if im.get("mimeType") == "image/webp"}
    for t in doc.get("textures", []):
        if t.get("source") in webp_images:
            t.setdefault("extensions", {})[EXT] = {"source": t.pop("source")}
    for key in ("extensionsUsed", "extensionsRequired"):
        doc[key] = sorted(set(doc.get(key, [])) | {EXT})
    write_glb(dst, doc, bytes(new))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
