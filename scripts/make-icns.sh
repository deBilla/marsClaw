#!/usr/bin/env bash
# Generate a macOS .icns app icon from a single PNG (assets/logo.png).
#
#   ./scripts/make-icns.sh [SRC_PNG] [OUT_ICNS]
#   defaults: assets/logo.png → dist/marsClaw.icns
#
# Builds the full .iconset (16–1024, @1x and @2x) with sips, then iconutil.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${1:-$ROOT/assets/logo.png}"
OUT="${2:-$ROOT/dist/marsClaw.icns}"

[ -f "$SRC" ] || { echo "make-icns: source not found: $SRC" >&2; exit 1; }

WORK="$(mktemp -d)"
ICONSET="$WORK/icon.iconset"
mkdir -p "$ICONSET" "$(dirname "$OUT")"
trap 'rm -rf "$WORK"' EXIT

# name → pixel size for each required iconset slot.
gen() { sips -s format png -z "$2" "$2" "$SRC" --out "$ICONSET/$1" >/dev/null; }
gen icon_16x16.png       16
gen icon_16x16@2x.png    32
gen icon_32x32.png       32
gen icon_32x32@2x.png    64
gen icon_128x128.png     128
gen icon_128x128@2x.png  256
gen icon_256x256.png     256
gen icon_256x256@2x.png  512
gen icon_512x512.png     512
gen icon_512x512@2x.png  1024

iconutil -c icns "$ICONSET" -o "$OUT"
echo "✓ icon → $OUT"
