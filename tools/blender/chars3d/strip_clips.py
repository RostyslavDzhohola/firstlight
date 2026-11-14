# Drop the animation channels the client never plays from the shared clips GLB (D-perf-1).
# The client's slim() (apps/client/src/render/avatars/assets.ts) discards every scale track and every
# translation track but the pelvis' as it loads the clips, so they only cost download and parse time.
# Only the JSON changes: dropped channels, their samplers and the accessors nothing uses any more go; the
# kept accessors and the BIN chunk (meshopt-compressed buffer views) are copied byte for byte, so the
# clips the game plays are bit-identical. build.sh runs it on the raw export, before gltf-transform, so
# optimize also drops the unused bytes; on a shipped (meshopt) file it saves the JSON only.
#   python3 -I strip_clips.py <in.glb> <out.glb>
# Our own code: MIT.
import json
import struct
import sys

KEEP_TRANSLATION = {"pelvis"}


def read_glb(path):
    b = open(path, "rb").read()
    magic, version, _ = struct.unpack("<4sII", b[:12])
    assert magic == b"glTF" and version == 2, "not a glTF 2 binary"
    chunks, off = [], 12
    while off < len(b):
        n, kind = struct.unpack("<I4s", b[off:off + 8])
        chunks.append((kind, b[off + 8:off + 8 + n]))
        off += 8 + n
    assert chunks[0][0] == b"JSON"
    return json.loads(chunks[0][1]), chunks[1:]


def write_glb(path, doc, rest):
    js = json.dumps(doc, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    body = struct.pack("<I4s", len(js), b"JSON") + js
    for kind, data in rest:
        body += struct.pack("<I4s", len(data), kind) + data
    open(path, "wb").write(struct.pack("<4sII", b"glTF", 2, 12 + len(body)) + body)


def strip(doc):
    names = [n.get("name", "") for n in doc.get("nodes", [])]
    dropped = kept = 0
    for anim in doc.get("animations", []):
        channels, samplers, remap = [], [], {}
        for ch in anim["channels"]:
            path, node = ch["target"]["path"], ch["target"].get("node")
            if path == "scale" or (path == "translation" and names[node] not in KEEP_TRANSLATION):
                dropped += 1
                continue
            s = ch["sampler"]
            if s not in remap:
                remap[s] = len(samplers)
                samplers.append(anim["samplers"][s])
            channels.append({**ch, "sampler": remap[s]})
            kept += 1
        anim["channels"], anim["samplers"] = channels, samplers
    assert "pelvis" in names, "no pelvis node"
    prune_accessors(doc)
    return kept, dropped


def prune_accessors(doc):
    """Drop accessors no sampler, mesh or skin refers to, and renumber the references."""
    used = set()
    for anim in doc.get("animations", []):
        for s in anim["samplers"]:
            used.update((s["input"], s["output"]))
    for mesh in doc.get("meshes", []):
        for prim in mesh["primitives"]:
            used.update(prim.get("attributes", {}).values())
            if "indices" in prim:
                used.add(prim["indices"])
            for t in prim.get("targets", []):
                used.update(t.values())
    for skin in doc.get("skins", []):
        if "inverseBindMatrices" in skin:
            used.add(skin["inverseBindMatrices"])
    order = sorted(used)
    new = {old: i for i, old in enumerate(order)}
    doc["accessors"] = [doc["accessors"][i] for i in order]
    for anim in doc.get("animations", []):
        for s in anim["samplers"]:
            s["input"], s["output"] = new[s["input"]], new[s["output"]]
    for mesh in doc.get("meshes", []):
        for prim in mesh["primitives"]:
            prim["attributes"] = {k: new[v] for k, v in prim.get("attributes", {}).items()}
            if "indices" in prim:
                prim["indices"] = new[prim["indices"]]
            if "targets" in prim:
                prim["targets"] = [{k: new[v] for k, v in t.items()} for t in prim["targets"]]
    for skin in doc.get("skins", []):
        if "inverseBindMatrices" in skin:
            skin["inverseBindMatrices"] = new[skin["inverseBindMatrices"]]


if __name__ == "__main__":
    doc, rest = read_glb(sys.argv[1])
    kept, dropped = strip(doc)
    write_glb(sys.argv[2], doc, rest)
    print(f"STRIP clips: kept {kept} channels, dropped {dropped}")
