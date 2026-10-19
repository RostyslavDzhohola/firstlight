#!/usr/bin/env bash
# HD art packs (#48, D-artpacks): the textures the client swaps in after arrival, built from the same
# sources as the shipped ones at a larger size, checked against the shipped files, then installed into
# apps/client/public/assets-dev/packs/hd/ with a manifest (render/artpacks/catalog.ts).
#
#   tools/blender/artpacks/build.sh                     # the packs in PACKS (default: town vegetation)
#   PACKS="town chars vegetation" LOOKS="hexwick ash" tools/blender/artpacks/build.sh
#
#   town        tools/blender/artpacks/build_town.sh: the Portus kit and Meridian layer strips at 1024²
#               layers (the shipped ones are 512²), from the hash-checked CC0 kits
#   chars       our sculpted characters (tools/blender/chars3d) baked at 2048² (shipped: 1024²); needs
#               the UAL1 archive (UAL1_ZIP) for the rig
#   vegetation  the mesh atlas at 4096² (tools/blender/vegetation --atlas-only; shipped: 2048² in the GLB)
#
# Never downloads anything and never runs code from an archive (each part checks the archive SHA-256
# and reads only glTF/PNG data with Blender's autoexec off). Every HD file, box-filtered down to the
# shipped size, must match the shipped file (check_strips.py, ≥ 26 dB): same layers, same UV layout.
#
# Env: VILLAGE_ZIP NATURE_ZIP SCIFI_ZIP UAL1_ZIP (archives), BLENDER, PACKS, LOOKS, KEEP_WORK=1.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
TB="$ROOT/tools/blender"
SHIPPED="$ROOT/apps/client/public/assets-dev"
OUT="$SHIPPED/packs/hd"
BLENDER="${BLENDER:-/opt/homebrew/bin/blender}"
PACKS="${PACKS:-town vegetation}"
LOOKS="${LOOKS:-hexwick ash kappa unit7 ninja kappa_b unit7_b}"
NATURE_ZIP="${NATURE_ZIP:-/tmp/fl-art-src/nature/download.zip}"
UAL1_ZIP="${UAL1_ZIP:-/tmp/fl-src/ual1/download.zip}"
WORK="$(mktemp -d /tmp/fl-artpacks.XXXXXX)"
if [ "${KEEP_WORK:-0}" = "1" ]; then echo "work folder: $WORK"; else trap 'chmod -R u+rwX "$WORK"; rm -rf "$WORK"' EXIT; fi
BL=("$BLENDER" -b --disable-autoexec --factory-startup --python-exit-code 1)
STAGE="$WORK/stage"
mkdir -p "$STAGE"
has() { case " $PACKS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

if has town; then
  "$HERE/build_town.sh" "$WORK/town" > "$WORK/town.log" 2>&1 || { tail -30 "$WORK/town.log"; exit 1; }
  mkdir -p "$STAGE/town"
  cp "$WORK/town/portus/portus_color.webp" "$WORK/town/portus/portus_normal.webp" "$STAGE/town/"
  cp "$WORK/town/meridian/meridian_color.webp" "$WORK/town/meridian/meridian_normal.webp" "$STAGE/town/"
  for f in portus_color portus_normal; do python3 -I "$HERE/check_strips.py" "$STAGE/town/$f.webp" "$SHIPPED/portus/$f.webp" --layers 16 | tail -1; done
  for f in meridian_color meridian_normal; do python3 -I "$HERE/check_strips.py" "$STAGE/town/$f.webp" "$SHIPPED/outposts/meridian/$f.webp" --layers 9 | tail -1; done
fi

if has chars; then
  printf '%s  %s\n' cc73fc4e495b82958207316596317a3f40b9fa38065bde1027937452da537724 "$UAL1_ZIP" | shasum -a 256 -c - >/dev/null
  mkdir "$WORK/ual1" "$WORK/chars"
  unzip -q "$UAL1_ZIP" -d "$WORK/ual1"
  UAL1="$(find "$WORK/ual1" -name 'UAL1_Standard.glb' | head -1)"
  [ -n "$UAL1" ] || { echo "UAL1 archive lacks UAL1_Standard.glb" >&2; exit 1; }
  for look in $LOOKS; do
    case "$look" in
      kappa_b) args=(--python "$TB/chars3d/rig_astra.py" -- --look "$look" --src "$TB/chars3d/astra/kappa.glb") ;;
      unit7_b) args=(--python "$TB/chars3d/rig_astra.py" -- --look "$look" --src "$TB/chars3d/astra/unit-7.glb") ;;
      *) args=(--python "$TB/chars3d/build.py" -- --char "$look") ;;
    esac
    (cd "$TB/chars3d" && "${BL[@]}" "${args[@]}" --ual1 "$UAL1" --out "$WORK/chars" --tex 2048) > "$WORK/chars_$look.log" 2>&1 \
      || { tail -30 "$WORK/chars_$look.log"; exit 1; }
  done
  mkdir -p "$STAGE/chars"
  python3 -I - "$WORK/chars" "$STAGE/chars" $LOOKS <<'PY'
import os, sys
from PIL import Image
src, out, looks = sys.argv[1], sys.argv[2], sys.argv[3:]
for n in looks:
    for kind, q in (("albedo", 90), ("normal", 95)):
        if kind == "normal" and n.endswith("_b"):
            continue  # the second looks draw the client's flat normal map
        im = Image.open(os.path.join(src, f"{n}_{kind}.png")).convert("RGBA" if kind == "albedo" else "RGB")
        im.save(os.path.join(out, f"{n}_{kind}.webp"), "WEBP", quality=q, method=6, exact=True)
PY
  for f in "$STAGE"/chars/*.webp; do python3 -I "$HERE/check_strips.py" "$f" "$SHIPPED/characters/$(basename "$f")" | tail -1; done
fi

if has vegetation; then
  printf '%s  %s\n' 298f6732b872e4cf7b30e6e7abf9641c7f6dc6b326df37ac089533ed7e3d58c9 "$NATURE_ZIP" | shasum -a 256 -c - >/dev/null
  mkdir "$WORK/nature" "$WORK/veg"
  unzip -q "$NATURE_ZIP" -d "$WORK/nature"
  (cd "$TB/vegetation" && "${BL[@]}" --python "$TB/vegetation/build_vegetation.py" -- --pack "$WORK/nature" --out "$WORK/veg" --atlas-size 4096 --atlas-only) \
    > "$WORK/veg.log" 2>&1 || { tail -30 "$WORK/veg.log"; exit 1; }
  mkdir -p "$STAGE/vegetation"
  python3 -I - "$WORK/veg/atlas.png" "$STAGE/vegetation/atlas.webp" <<'PY'
import sys
from PIL import Image
Image.open(sys.argv[1]).convert("RGBA").save(sys.argv[2], "WEBP", quality=90, alpha_quality=100, method=6, exact=True)
PY
  python3 -I "$HERE/glb_image.py" "$SHIPPED/vegetation/vegetation.glb" vegetation_atlas "$WORK/veg/shipped_atlas.png" >/dev/null
  python3 -I "$HERE/check_strips.py" "$STAGE/vegetation/atlas.webp" "$WORK/veg/shipped_atlas.png" | tail -1
fi

python3 -I "$HERE/manifest.py" "$STAGE" "$SHIPPED"
mkdir -p "$OUT"
rm -rf "${OUT:?}"/*
cp -R "$STAGE"/* "$OUT/"
du -sh "$OUT"
