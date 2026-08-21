#!/usr/bin/env bash
#
# Submit the built WFES3 artifacts to Apple for notarisation and staple the
# resulting ticket.
#
# Notarisation is what lets the app run on someone else's Mac. Signing alone is
# not enough: Gatekeeper on a machine that has never seen the app checks for a
# notarisation ticket, and without one it refuses to launch it, reporting the
# app as damaged.
#
# CREDENTIALS
# This script deliberately takes no Apple ID or password arguments. Run the
# following once; it prompts for an app-specific password (created at
# appleid.apple.com, NOT your Apple ID password) and stores it in your keychain
# under a profile name:
#
#   xcrun notarytool store-credentials wfes3-notary \
#     --apple-id <your-apple-id> --team-id K58VA3MHPK
#
# After that the credential lives in the keychain only. Nothing sensitive is
# committed to this repository or passed through the environment.
#
# USAGE
#   npm run dist:mac        # build and sign first
#   npm run notarize        # or: scripts/notarize.sh [profile-name]
set -euo pipefail

PROFILE="${1:-wfes3-notary}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Matches directories.output in electron-builder.yml (kept outside the
# iCloud-synced project tree so codesign will accept the bundle).
DIST="${WFES3_DIST:-$HOME/Builds/WFES3}"
TEAM_ID="K58VA3MHPK"

if ! xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then
  cat >&2 <<EOF
error: no usable notarytool keychain profile named '$PROFILE'.

Create one (you will be prompted for an app-specific password from
https://appleid.apple.com, under "App-Specific Passwords"):

  xcrun notarytool store-credentials $PROFILE \\
    --apple-id <your-apple-id> --team-id $TEAM_ID

EOF
  exit 1
fi

shopt -s nullglob
artifacts=("$DIST"/*.dmg "$DIST"/*.zip)
if [ ${#artifacts[@]} -eq 0 ]; then
  echo "error: no .dmg or .zip found in $DIST - run 'npm run dist:mac' first" >&2
  exit 1
fi

APP="$DIST/mac-arm64/WFES3.app"

echo "Verifying signatures before submission..."
if [ -d "$APP" ]; then
  codesign --verify --deep --strict --verbose=2 "$APP"
  echo "  app signature OK"

  # The .app should already carry a stapled ticket, applied by the afterSign
  # hook BEFORE the artifacts were built. If it does not, the copy inside the
  # DMG has no ticket either, and Gatekeeper will need an online check on the
  # user's machine -- which fails if they are offline on first launch.
  if xcrun stapler validate "$APP" >/dev/null 2>&1; then
    echo "  app already stapled (built with WFES3_NOTARIZE=1)"
  else
    cat >&2 <<'WARN'

  WARNING: the .app has no stapled ticket, so the copy inside the DMG has none
  either. Stapling the DMG afterwards does NOT fix the app inside it. Rebuild
  with notarisation enabled so the app is stapled before the DMG is created:

      npm run dist:mac:release

WARN
  fi
fi

for artifact in "${artifacts[@]}"; do
  echo
  echo "Submitting $(basename "$artifact")..."
  # --wait blocks until Apple returns Accepted or Invalid.
  xcrun notarytool submit "$artifact" --keychain-profile "$PROFILE" --wait

  # Only a .dmg (or a .app, not a .zip) can carry a stapled ticket.
  case "$artifact" in
    *.dmg)
      echo "Stapling $(basename "$artifact")..."
      xcrun stapler staple "$artifact"
      xcrun stapler validate "$artifact"
      ;;
    *.zip)
      echo "  (zip archives cannot be stapled; staple the .app instead)"
      ;;
  esac
done

if [ -d "$APP" ]; then
  echo
  echo "Stapling the .app bundle..."
  xcrun stapler staple "$APP"
  echo "Gatekeeper assessment:"
  spctl --assess --type execute --verbose=4 "$APP"
fi

echo
echo "Done. A stapled artifact launches on a Mac that has never seen it before."
