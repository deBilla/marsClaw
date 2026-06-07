#!/usr/bin/env bash
# Build, sign, notarize, and DMG-package marsClaw.app.
#
# Pipeline: compile the engine (W2) → build the Swift menubar app → assemble the
# .app bundle (engine + assets embedded in Resources) → codesign inside-out with
# the hardened runtime → notarize via notarytool → staple → build a DMG →
# notarize + staple the DMG.
#
# Required env (for a release build):
#   SIGN_ID         "Developer ID Application: Your Name (TEAMID)"
#   NOTARY_PROFILE  a notarytool keychain profile name. Create once with:
#                     xcrun notarytool store-credentials NOTARY_PROFILE \
#                       --apple-id you@example.com --team-id TEAMID \
#                       --password <app-specific-password>
#
# Local smoke build without an Apple account:  ./scripts/package-mac.sh --adhoc
# (ad-hoc signed; Gatekeeper will warn — right-click → Open. Not for distribution.)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DIST="$ROOT/dist"
APP="$DIST/marsClaw.app"
ENTITLEMENTS="$ROOT/macapp/marsClaw.entitlements"
INFO_PLIST="$ROOT/macapp/Info.plist"

ADHOC=0
[ "${1:-}" = "--adhoc" ] && ADHOC=1

if [ "$ADHOC" = "0" ]; then
  : "${SIGN_ID:?set SIGN_ID to your Developer ID Application identity (or pass --adhoc)}"
  : "${NOTARY_PROFILE:?set NOTARY_PROFILE to your notarytool keychain profile (or pass --adhoc)}"
fi

bold() { printf "\033[1m%s\033[0m\n" "$1"; }

# 1) Engine: single binary + assets, both arches (universal app).
bold "1/6  Building engine (arm64 + x64)…"
bun run scripts/build-engine.ts --all

# 2) Swift menubar app (universal).
bold "2/6  Building Swift app…"
( cd macapp && swift build -c release --arch arm64 --arch x86_64 )
# Universal builds land under .build/apple/Products/Release; single-arch under .build/release.
SWIFT_BIN="$ROOT/macapp/.build/apple/Products/Release/marsClaw"
[ -f "$SWIFT_BIN" ] || SWIFT_BIN="$ROOT/macapp/.build/release/marsClaw"

# 3) Assemble the .app bundle.
bold "3/6  Assembling ${APP} …"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/engine"
cp "$SWIFT_BIN" "$APP/Contents/MacOS/marsClaw"
cp "$INFO_PLIST" "$APP/Contents/Info.plist"
# Embed each per-arch engine dir (binary + assets) under Resources/engine/<arch>.
# Copy arch dirs explicitly so stray files at dist/engine root never leak in.
for a in arm64 x64; do
  [ -d "$DIST/engine/$a" ] && cp -R "$DIST/engine/$a" "$APP/Contents/Resources/engine/$a"
done

# 4) Codesign inside-out (nested executables first, bundle last).
bold "4/6  Codesigning…"
if [ "$ADHOC" = "1" ]; then
  SIGN_ID="-"; SIGN_ARGS=(--force --options runtime --entitlements "$ENTITLEMENTS" --sign "-")
else
  SIGN_ARGS=(--force --timestamp --options runtime --entitlements "$ENTITLEMENTS" --sign "$SIGN_ID")
fi
# Sign every embedded engine binary (the Bun runtimes) with the same hardened
# entitlements (they JIT), then the app bundle itself.
find "$APP/Contents/Resources/engine" -type f -name marsclaw -print0 \
  | while IFS= read -r -d '' bin; do codesign "${SIGN_ARGS[@]}" "$bin"; done
codesign "${SIGN_ARGS[@]}" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

if [ "$ADHOC" = "1" ]; then
  bold "Ad-hoc build complete (unsigned for distribution): $APP"
  exit 0
fi

# 5) Notarize the app, then staple the ticket into it.
bold "5/6  Notarizing app…"
ZIP="$DIST/marsClaw.zip"
ditto -c -k --keepParent "$APP" "$ZIP"
xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$APP"
rm -f "$ZIP"

# 6) Build, notarize, and staple the DMG.
bold "6/6  Building DMG…"
DMG="$DIST/marsClaw.dmg"
STAGE="$DIST/dmg-stage"
rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "marsClaw" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$DMG"
rm -rf "$STAGE"

bold "Done → $DMG"
spctl --assess --type open --context context:primary-signature -v "$DMG" || true
