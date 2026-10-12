#!/usr/bin/env bash
# Rebuild the horse from its CC0 source (headless; no GUI).
#
#   tools/blender/horse/build.sh                  # fetch the CC0 pack, build, compress, install
#   SRC=/tmp/fl-horse-src tools/blender/horse/build.sh   # reuse an existing download folder
#
# 1. Downloads Quaternius "LowPoly Animated Animals" (CC0) from the creator's itch.io page into a NEW
#    empty folder under /tmp (untrusted data: only FBX/Horse.fbx is read, by Blender with autoexec
#    disabled) and checks the archive hash recorded in docs/ASSETS.md.
# 2. Runs build_horse.py in Blender (scale to metres, saddle + socket, role mask, four clips).
# 3. Compresses with @gltf-transform/cli 4.5.1 (meshopt + quantisation, keyframe resample; no prune,
#    which would drop the empty `saddle` socket node).
# 4. Installs apps/client/public/assets-dev/animals/horse.glb.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
BLENDER="${BLENDER:-/opt/homebrew/bin/blender}"
GLTF="pnpm dlx @gltf-transform/cli@4.5.1"
OUT_DEV="$ROOT/apps/client/public/assets-dev/animals"
WORK="$(mktemp -d /tmp/fl-horse-build.XXXXXX)"
GAME="https://quaternius.itch.io/lowpoly-animated-animals"
SHA_PACK="b4bc5f209368cafc21962934e7d676cf1cfb1f746a363086cd9f45c4385db70e"

itch_dl() { # <game url> <upload name substring> <empty out dir>  (same flow as tools/blender/characters)
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

SRC="${SRC:-$(mktemp -d /tmp/fl-horse-src.XXXXXX)}"
if [ ! -f "$SRC/dl/download.zip" ]; then itch_dl "$GAME" "Farm Animals" "$SRC/dl"; fi
echo "$SHA_PACK  $SRC/dl/download.zip" | shasum -a 256 -c - >/dev/null || { echo "hash mismatch: $SRC/dl/download.zip" >&2; exit 1; }
[ -d "$SRC/x" ] || unzip -q -o "$SRC/dl/download.zip" "FBX/Horse.fbx" -d "$SRC/x"

"$BLENDER" -b --disable-autoexec --factory-startup --python "$HERE/build_horse.py" -- \
  --fbx "$SRC/x/FBX/Horse.fbx" --out "$WORK/horse_raw.glb" | grep -E "^HORSE"

mkdir -p "$OUT_DEV"
$GLTF optimize "$WORK/horse_raw.glb" "$OUT_DEV/horse.glb" --compress meshopt --simplify false --flatten false \
  --join false --instance false --palette false --texture-compress false --prune false --prune-attributes false \
  --resample true --weld false >/dev/null
ls -l "$OUT_DEV"
shasum -a 256 "$OUT_DEV/horse.glb"
