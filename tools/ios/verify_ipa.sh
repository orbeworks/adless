#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 PATH_TO_IPA" >&2
  exit 2
fi

ipa="$1"
temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"' EXIT
unzip -q "$ipa" -d "$temporary_directory"
app_count="$(find "$temporary_directory/Payload" -maxdepth 1 -type d -name '*.app' -print | wc -l | tr -d '[:space:]')"
test "$app_count" -eq 1
app="$(find "$temporary_directory/Payload" -maxdepth 1 -type d -name '*.app' -print -quit)"
test "$(basename "$app")" = "Adless.app"
test -z "$(find "$app" -type d -name '*.appex' -print -quit)"
test -z "$(unzip -Z1 "$ipa" | grep -E '(^|/)(PacketTunnel|DNSProxy|.*\.appex)(/|$)' || true)"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist")" = "com.orbeworks.adless"
test "$(/usr/libexec/PlistBuddy -c 'Print :AdlessEnvironment' "$app/Info.plist")" = "production"
test "$(/usr/libexec/PlistBuddy -c 'Print :AdlessDNSCloudBaseURL' "$app/Info.plist")" = "https://adless-dns.orbeworks.workers.dev"
if [ -n "${ADLESS_EXPECTED_BUILD_NUMBER:-}" ]; then
  test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$app/Info.plist")" = "$ADLESS_EXPECTED_BUILD_NUMBER"
fi
if [ -n "${ADLESS_EXPECTED_MARKETING_VERSION:-}" ]; then
  test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Info.plist")" = "$ADLESS_EXPECTED_MARKETING_VERSION"
fi
codesign --verify --deep --strict "$app"
script_directory="$(CDPATH='' cd "$(dirname "$0")" && pwd)"
sh "$script_directory/verify_distribution_profile.sh" "$app"
echo "Verified IPA with one Adless.app, dns-settings, and no embedded extensions."
