#!/usr/bin/env bash
# HD art pack, town part (#48, D-artpacks): the Portus kit strips and Meridian's strips at 1024² layers,
# built from the same CC0 kits and the same layer list as the shipped 512² strips (tools/blender/portus,
# tools/blender/pads), so the client can swap them into the same materials after arrival.
#
#   tools/blender/artpacks/build_town.sh <out dir>     # writes <out>/portus/*.webp, <out>/meridian/*.webp
#
# Never downloads anything and never runs code from the kits: the archives are checked against their
# SHA-256 (docs/ASSETS.md), only their glTF folders, textures and licence texts are extracted (data only)
# into a fresh temporary folder, and Blender reads them as glTF/PNG data with autoexec disabled.
# Only the strips are kept: the geometry, layout and manifests stay the shipped ones (the strips are a
# drop-in for the same layers, checked by tools/blender/artpacks/check_strips.py).
#
# Env: VILLAGE_ZIP, NATURE_ZIP, SCIFI_ZIP (kit archives), BLENDER, LAYER (default 1024), KEEP_WORK=1.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
TB="$ROOT/tools/blender"
OUT="${1:?usage: build_town.sh <out dir>}"
VILLAGE_ZIP="${VILLAGE_ZIP:-/tmp/fl-art-src/village/download.zip}"
NATURE_ZIP="${NATURE_ZIP:-/tmp/fl-art-src/nature/download.zip}"
SCIFI_ZIP="${SCIFI_ZIP:-/tmp/fl-art-src/scifi-megakit/download.zip}"
BLENDER="${BLENDER:-/opt/homebrew/bin/blender}"
LAYER="${LAYER:-1024}"
WORK="$(mktemp -d /tmp/fl-artpacks-town.XXXXXX)"
if [ "${KEEP_WORK:-0}" = "1" ]; then echo "work folder: $WORK"; else trap 'chmod -R u+rwX "$WORK"; rm -rf "$WORK"' EXIT; fi
BL=("$BLENDER" -b --disable-autoexec --factory-startup --python-exit-code 1)

# Medieval Village MegaKit, Stylized Nature MegaKit and Modular SciFi MegaKit [Standard] (Quaternius, CC0).
printf '%s  %s\n' e60dea67c10f30dccccfbff92a7933f5ea5cfe99be0e2a0fa5118cceabeec5c4 "$VILLAGE_ZIP" | shasum -a 256 -c - >/dev/null
printf '%s  %s\n' 298f6732b872e4cf7b30e6e7abf9641c7f6dc6b326df37ac089533ed7e3d58c9 "$NATURE_ZIP" | shasum -a 256 -c - >/dev/null
printf '%s  %s\n' 6fae60cf5189e44dff0bd91097f094a765acc6d57d64a85a0cc0dd56e03035e3 "$SCIFI_ZIP" | shasum -a 256 -c - >/dev/null
mkdir "$WORK/village" "$WORK/nature" "$WORK/scifi" "$WORK/data" "$WORK/design" "$WORK/portus" "$WORK/design_meridian" "$WORK/meridian"
(cd "$TB/portus" && python3 -I "$TB/portus/extract.py" "$VILLAGE_ZIP" "Medieval Village MegaKit[Standard]/" "$WORK/village")
(cd "$TB/portus" && python3 -I "$TB/portus/extract.py" "$NATURE_ZIP" "" "$WORK/nature")
(cd "$TB/pads" && python3 -I "$TB/pads/extract_kit.py" "$SCIFI_ZIP" "Modular SciFi MegaKit[Standard]/" "$WORK/scifi" glTF Textures)

# Portus: the design build (prefabs and their kit textures), then the pack at the HD layer size
# (its tree impostors are rendered again at that size; Cycles on the CPU).
(cd "$TB/portus" && "${BL[@]}" --python "$TB/portus/build.py" -- \
  --village "$WORK/village/glTF" --nature "$WORK/nature/glTF" --out "$WORK/design" --renders none) > "$WORK/build.log" 2>&1 \
  || { tail -40 "$WORK/build.log"; exit 1; }
(cd "$TB/portus" && "${BL[@]}" --python "$TB/portus/pack.py" -- \
  --design "$WORK/design" --out "$WORK/portus" --layer "$LAYER") > "$WORK/pack.log" 2>&1 || { tail -40 "$WORK/pack.log"; exit 1; }

# Meridian (Arcadia and Hollowmere use the Portus strips).
(cd "$ROOT" && node "$TB/pads/site_data.mjs" "$ROOT" "$WORK/data") > "$WORK/site_data.log" 2>&1 || { cat "$WORK/site_data.log"; exit 1; }
(cd "$TB/pads" && "${BL[@]}" --python "$TB/pads/design.py" -- \
  --body meridian --site "$WORK/data/site_meridian.json" --village "$WORK/village/glTF" --nature "$WORK/nature/glTF" \
  --scifi "$WORK/scifi" --out "$WORK/design_meridian" --export-dir "$WORK/design_meridian/prefabs" --export-only) \
  > "$WORK/design_meridian.log" 2>&1 || { tail -40 "$WORK/design_meridian.log"; exit 1; }
(cd "$TB/pads" && "${BL[@]}" --python "$TB/pads/pack.py" -- \
  --body meridian --design "$WORK/design_meridian" --out "$WORK/meridian" --layer "$LAYER") > "$WORK/pack_meridian.log" 2>&1 \
  || { tail -40 "$WORK/pack_meridian.log"; exit 1; }

mkdir -p "$OUT/portus" "$OUT/meridian"
cp "$WORK/portus/portus_color.webp" "$WORK/portus/portus_normal.webp" "$OUT/portus/"
cp "$WORK/meridian/meridian_color.webp" "$WORK/meridian/meridian_normal.webp" "$OUT/meridian/"
ls -l "$OUT"/portus "$OUT"/meridian
