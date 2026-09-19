#!/bin/bash

set -euo pipefail

if [[ "${CI:-}" != "TRUE" && "${CI_XCODE_CLOUD:-}" != "TRUE" ]]; then
  exit 0
fi

: "${ASC_KEY_ID:?ASC_KEY_ID must be configured in Xcode Cloud}"
: "${ASC_ISSUER_ID:?ASC_ISSUER_ID must be configured in Xcode Cloud}"
: "${ASC_PRIVATE_KEY:?ASC_PRIVATE_KEY must be configured in Xcode Cloud}"
: "${CI_BUILD_NUMBER:?CI_BUILD_NUMBER is required in Xcode Cloud}"

root_dir="$(cd "$(dirname "$0")/.." && pwd)"
project_file="$root_dir/apps/ios/Adless.xcodeproj/project.pbxproj"
app_id="${ASC_APP_ID:-6803552143}"
current_version="$(sed -n 's/^[[:space:]]*MARKETING_VERSION = \([^;]*\);/\1/p' "$project_file" | head -n 1)"
if [[ -z "$current_version" ]]; then
  echo "Could not read MARKETING_VERSION from $project_file" >&2
  exit 1
fi
if ! [[ "$CI_BUILD_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "CI_BUILD_NUMBER must be an integer, got: $CI_BUILD_NUMBER" >&2
  exit 1
fi

temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/adless-asc.XXXXXX")"
trap 'rm -rf "$temporary_dir"' EXIT
key_path="$temporary_dir/AuthKey.p8"
printf '%s\n' "$ASC_PRIVATE_KEY" > "$key_path"
chmod 600 "$key_path"

marketing_version="$(python3 "$root_dir/tools/appstore/appstore_connect.py" \
  --key-id "$ASC_KEY_ID" \
  --issuer-id "$ASC_ISSUER_ID" \
  --key-path "$key_path" \
  next-marketing \
  --app-id "$app_id" \
  --current-version "$current_version")"

if ! [[ "$marketing_version" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]]; then
  echo "App Store Connect returned an invalid marketing version: $marketing_version" >&2
  exit 1
fi

echo "Using Adless marketing version $marketing_version and build $CI_BUILD_NUMBER"
cd "$root_dir"
xcrun agvtool new-marketing-version "$marketing_version"
xcrun agvtool new-version -all "$CI_BUILD_NUMBER"
