#!/bin/bash
# Rebrand the DEV Electron bundle so the macOS dock says "WFES3", not "Electron".
#
# The dock label in development comes from the stock Electron binary's own
# Info.plist -- neither app.setName() nor electron-builder touches it, because
# in dev we launch node_modules/electron's Electron.app directly. The packaged
# app is named by electron-builder.yml (productName: WFES3); this script only
# fixes the development experience.
#
# npm install replaces the bundle, so this runs as the postinstall step.
# Modifying the bundle invalidates its ad-hoc signature, which macOS on Apple
# Silicon enforces, so it is re-signed ad-hoc afterwards (the same kind of
# signature it shipped with).
set -euo pipefail

APP="$(dirname "$0")/../node_modules/electron/dist/Electron.app"
PLIST="$APP/Contents/Info.plist"

[ -f "$PLIST" ] || { echo "brand-dev-electron: no dev Electron bundle (not macOS or not installed); skipping"; exit 0; }
[ "$(uname)" = "Darwin" ] || { echo "brand-dev-electron: not macOS; skipping"; exit 0; }

current=$(/usr/libexec/PlistBuddy -c "Print :CFBundleName" "$PLIST" 2>/dev/null || echo "")
if [ "$current" = "WFES3" ]; then
  echo "brand-dev-electron: already branded"
  exit 0
fi

/usr/libexec/PlistBuddy -c "Set :CFBundleName WFES3" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName WFES3" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string WFES3" "$PLIST"
codesign --force --deep --sign - "$APP" 2>/dev/null
echo "brand-dev-electron: dev dock label is now WFES3"
