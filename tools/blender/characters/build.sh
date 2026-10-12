#!/usr/bin/env bash
# Rebuild the four starter characters + clips from scratch (headless; no GUI).
#
#   tools/blender/characters/build.sh            # fetch CC0 sources, build, compress, install
#   SRC=/tmp/fl-src tools/blender/characters/build.sh   # reuse an existing download folder
#
# 1. Downloads the free Standard tiers of three Quaternius CC0 packs from the creator's itch.io pages
#    into a NEW empty folder under /tmp (untrusted data: only the glTF/GLB files are read, by Blender
#    with autoexec disabled), and checks the archive hashes recorded in docs/ASSETS.md.
# 2. Runs build_characters.py and build_anims.py in Blender.
# 3. Compresses with @gltf-transform/cli 4.5.1 (meshopt + quantisation, lossless keyframe resample).
# 4. Installs into apps/client/public/assets-dev/characters/ and keeps a copy of the atlas in
#    assets-src/characters/.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
BLENDER="${BLENDER:-/opt/homebrew/bin/blender}"
GLTF="npx -y @gltf-transform/cli@4.5.1"
OUT_DEV="$ROOT/apps/client/public/assets-dev/characters"
OUT_SRC="$ROOT/assets-src/characters"
WORK="$(mktemp -d /tmp/fl-chars-build.XXXXXX)"

SHA_UAL1="cc73fc4e495b82958207316596317a3f40b9fa38065bde1027937452da537724"
SHA_UAL2="4008ea208a604773a2b2177d965f0f5d3195498b5bf838c3f5785d68e95f2a68"
SHA_UBC="fdbf1804c90dfc1ea03e992bff7da2dfd1a79318e13270a660180f9308455f40"

itch_dl() { # <game url> <upload name substring> <empty out dir>
  local game="$1" name="$2" out="$3" ua="Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130 Safari/537.36"
  mkdir -p "$out"
  (
    cd "$out"
    curl -s -c jar -b jar -A "$ua" -o page.html "$game"
    local csrf url upid csrf2 cdn
    csrf=$(grep -o 'name="csrf_token" value="[^"]*"' page.html | head -1 | sed 's/.*value="//;s/"$//')
    url=$(curl -s -c jar -b jar -A "$ua" -X POST --data-urlencode "csrf_token=$csrf" -H "X-Requested-With: XMLHttpRequest" \
      -e "$game" "$game/download_url" | python3 -I -c "import json,sys;print(json.load(sys.stdin)['url'])")
    curl -s -c jar -b jar -A "$ua" -o dl.html "$url"
    upid=$(python3 -I -c "
import re,sys
s=open('dl.html').read()
for m in re.finditer(r'data-upload_id=\"(\d+)\".{0,400}?title=\"([^\"]*)\"', s, re.S):
    if sys.argv[1] in m.group(2): print(m.group(1)); break" "$name")
    csrf2=$(grep -o 'name="csrf_token" value="[^"]*"' dl.html | head -1 | sed 's/.*value="//;s/"$//')
    cdn=$(curl -s -c jar -b jar -A "$ua" -X POST --data-urlencode "csrf_token=$csrf2" -H "X-Requested-With: XMLHttpRequest" \
      -e "$url" "$game/file/$upid?source=game_download&after_download_lightbox=1&as_props=1" |
      python3 -I -c "import json,sys;print(json.load(sys.stdin)['url'])")
    curl -s -L -A "$ua" -o download.zip "$cdn"
  )
}

fetch() { # <dir> <game url> <sha>
  local dir="$1" game="$2" sha="$3"
  if [ ! -f "$dir/download.zip" ]; then itch_dl "$game" "Standard" "$dir"; fi
  echo "$sha  $dir/download.zip" | shasum -a 256 -c - >/dev/null || { echo "hash mismatch: $dir" >&2; exit 1; }
  [ -d "$dir/x" ] || unzip -q -o "$dir/download.zip" -d "$dir/x"
}

SRC="${SRC:-$(mktemp -d /tmp/fl-chars-src.XXXXXX)}"
fetch "$SRC/ual1" https://quaternius.itch.io/universal-animation-library "$SHA_UAL1"
fetch "$SRC/ual2" https://quaternius.itch.io/universal-animation-library-2 "$SHA_UAL2"
fetch "$SRC/ubc" https://quaternius.itch.io/universal-base-characters "$SHA_UBC"
UAL1="$(find "$SRC/ual1/x" -name 'UAL1_Standard.glb' | head -1)"
UAL2="$(find "$SRC/ual2/x" -name 'UAL2_Standard.glb' | head -1)"
UBC="$(find "$SRC/ubc/x" -path '*Godot - UE*' -name 'Superhero_Male_FullBody.gltf' | head -1)"

"$BLENDER" -b --disable-autoexec --factory-startup --python "$HERE/build_characters.py" -- \
  --ual1 "$UAL1" --ubc "$UBC" --out "$WORK/raw" | grep -E "^(CHAR|BASE)"
"$BLENDER" -b --disable-autoexec --factory-startup --python "$HERE/build_anims.py" -- \
  --ual1 "$UAL1" --ual2 "$UAL2" --out "$WORK/raw/starters_anims.glb" | grep -E "^ANIMS"

mkdir -p "$OUT_DEV" "$OUT_SRC"
for f in hexwick ash kappa unit7 starters_anims; do
  $GLTF optimize "$WORK/raw/$f.glb" "$OUT_DEV/$f.glb" --compress meshopt --simplify false --flatten false \
    --join false --instance false --palette false --texture-compress false --prune-attributes false \
    --resample true --weld false >/dev/null
done
cp "$WORK/raw/starters_atlas.png" "$OUT_DEV/starters_atlas.png"
cp "$WORK/raw/starters_atlas.png" "$OUT_SRC/starters_atlas.png"
ls -l "$OUT_DEV"
