#!/usr/bin/env bash
# Rebuild the sculpted starter characters (headless; no GUI) and install them for the client.
#
#   tools/blender/chars3d/build.sh                     # fetch the CC0 rig + clips, build all five, install
#   SRC=/tmp/fl-src tools/blender/chars3d/build.sh     # reuse a download folder (hashes are checked)
#   CHARS="hexwick ninja" tools/blender/chars3d/build.sh   # only some starters
#   JOBS=2 tools/blender/chars3d/build.sh              # parallel Blender processes (default 2)
#
# 1. Downloads the Quaternius Universal Animation Library 1 + 2 (CC0; rig and clips only, read as glTF
#    by Blender with autoexec off) into NEW empty folders and checks the archive hashes (docs/ASSETS.md).
# 2. build.py per starter: SDF sculpt -> game mesh -> skin -> UVs -> textures (see build.py).
# 3. build_anims.py (tools/blender/characters) for the shared clips.
# 4. Textures to WebP (1024² and 512² for the Low tier), GLBs through @gltf-transform/cli 4.5.1
#    (meshopt + quantisation), installed into apps/client/public/assets-dev/characters/.
# 5. Portraits and the line-up for the UI (render.py, the game look).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
BLENDER="${BLENDER:-/opt/homebrew/bin/blender}"
GLTF="pnpm dlx @gltf-transform/cli@4.5.1"
OUT_DEV="$ROOT/apps/client/public/assets-dev/characters"
WORK="${WORK:-$(mktemp -d /tmp/fl-chars3d.XXXXXX)}"
CHARS="${CHARS:-hexwick ash kappa unit7 ninja}"
JOBS="${JOBS:-2}"

SHA_UAL1="cc73fc4e495b82958207316596317a3f40b9fa38065bde1027937452da537724"
SHA_UAL2="4008ea208a604773a2b2177d965f0f5d3195498b5bf838c3f5785d68e95f2a68"

# shellcheck source=../characters/build.sh
eval "$(sed -n '/^itch_dl()/,/^}/p;/^fetch()/,/^}/p' "$HERE/../characters/build.sh")"

SRC="${SRC:-$(mktemp -d /tmp/fl-chars-src.XXXXXX)}"
fetch "$SRC/ual1" https://quaternius.itch.io/universal-animation-library "$SHA_UAL1"
fetch "$SRC/ual2" https://quaternius.itch.io/universal-animation-library-2 "$SHA_UAL2"
UAL1="$(find "$SRC/ual1/x" -name 'UAL1_Standard.glb' | head -1)"
UAL2="$(find "$SRC/ual2/x" -name 'UAL2_Standard.glb' | head -1)"

mkdir -p "$WORK/raw" "$OUT_DEV"
run_char() {
  "$BLENDER" -b --disable-autoexec --factory-startup --python "$HERE/build.py" -- \
    --char "$1" --ual1 "$UAL1" --out "$WORK/raw" > "$WORK/build_$1.log" 2>&1
  grep -E "^CHAR3D (DONE|joined)" "$WORK/build_$1.log" || { tail -30 "$WORK/build_$1.log"; return 1; }
}
for c in $CHARS; do
  while [ "$(jobs -rp | wc -l | tr -d ' ')" -ge "$JOBS" ]; do sleep 5; done
  run_char "$c" &
done
"$BLENDER" -b --disable-autoexec --factory-startup --python "$HERE/../characters/build_anims.py" -- \
  --ual1 "$UAL1" --ual2 "$UAL2" --out "$WORK/raw/starters_anims.glb" | grep -E "^ANIMS"
wait

# textures: WebP (python -I: our own PNGs only)
python3 -I "$HERE/webp.py" "$WORK/raw" "$OUT_DEV" $CHARS
for f in $CHARS starters_anims; do
  $GLTF optimize "$WORK/raw/$f.glb" "$OUT_DEV/$f.glb" --compress meshopt --simplify false --flatten false \
    --join false --instance false --palette false --texture-compress false --prune-attributes false \
    --resample true --weld false >/dev/null
done
rm -f "$OUT_DEV/starters_atlas.png"
ls -l "$OUT_DEV"
echo "work dir: $WORK"
