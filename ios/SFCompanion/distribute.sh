#!/usr/bin/env bash
# Archive SF Companion and upload it to TestFlight / App Store Connect.
#
# Prerequisites (one-time, done by a human in Apple's tools — not scriptable):
#   1. Apple Developer Program membership ($99/yr) on the signing Apple ID.
#   2. An app record in App Store Connect for bundle id com.ericrius1.sfcompanion.
#   3. Auth for the upload, EITHER:
#        a. An App Store Connect API key (.p8) in ~/.appstoreconnect/private_keys/
#           and export ASC_KEY_ID / ASC_ISSUER_ID below, OR
#        b. Just run `open build/SFCompanion.xcarchive` and use Xcode's
#           Organizer → Distribute App (no env vars needed).
#
# Usage:  ./distribute.sh            # archive + export/upload via API key
#         ./distribute.sh archive    # archive only, then hand off to Xcode Organizer
set -euo pipefail
cd "$(dirname "$0")"

TEAM=43T9DLFBPD
ARCHIVE="build/SFCompanion.xcarchive"

command -v xcodegen >/dev/null && xcodegen generate

echo "▶ Archiving for device…"
xcodebuild \
  -project SFCompanion.xcodeproj \
  -scheme SFCompanion \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  DEVELOPMENT_TEAM="$TEAM" \
  -allowProvisioningUpdates \
  archive

if [ "${1:-}" = "archive" ]; then
  echo "✔ Archive at $ARCHIVE — open it in Xcode Organizer to distribute:"
  echo "    open '$ARCHIVE'"
  exit 0
fi

echo "▶ Exporting + uploading to App Store Connect…"
AUTH=()
if [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ]; then
  AUTH=(-authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID"
        -authenticationKeyPath "$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8")
fi

xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist ExportOptions.plist \
  -exportPath build/export \
  "${AUTH[@]}" \
  -allowProvisioningUpdates

echo "✔ Uploaded. It appears in App Store Connect → TestFlight after processing (~5-15 min)."
