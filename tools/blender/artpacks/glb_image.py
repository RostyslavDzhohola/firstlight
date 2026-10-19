# Copy an embedded image out of a GLB (data only: the JSON chunk and the binary chunk). Our own code: MIT.
#
#   python3 -I glb_image.py <file.glb> <image or material name> <out file>
import json
import struct
import sys

glb, want, out = sys.argv[1], sys.argv[2], sys.argv[3]
data = open(glb, "rb").read()
magic, _version, _length = struct.unpack_from("<III", data, 0)
if magic != 0x46546C67:
    raise SystemExit("not a GLB")
jlen, jtype = struct.unpack_from("<II", data, 12)
doc = json.loads(data[20:20 + jlen])
blen, _btype = struct.unpack_from("<II", data, 20 + jlen)
binc = data[28 + jlen:28 + jlen + blen]
names = {i: im.get("name", "") for i, im in enumerate(doc.get("images", []))}
# by image name, else through the material whose base colour uses it
idx = next((i for i, n in names.items() if n == want), None)
if idx is None:
    for m in doc.get("materials", []):
        t = m.get("pbrMetallicRoughness", {}).get("baseColorTexture")
        if m.get("name") == want and t:
            idx = doc["textures"][t["index"]]["source"]
if idx is None:
    raise SystemExit(f"no image {want!r} in {glb} (images: {list(names.values())})")
bv = doc["bufferViews"][doc["images"][idx]["bufferView"]]
open(out, "wb").write(binc[bv.get("byteOffset", 0):bv.get("byteOffset", 0) + bv["byteLength"]])
print(f"{want}: {bv['byteLength']} bytes ({doc['images'][idx].get('mimeType')}) -> {out}")
