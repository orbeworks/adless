#!/bin/sh
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: $0 [--layout-only] PATH_TO_XCARCHIVE" >&2
  exit 2
fi

layout_only=false
if [ "$#" -eq 2 ]; then
  test "$1" = "--layout-only"
  layout_only=true
  archive="$2"
else
  archive="$1"
fi

app="$archive/Products/Applications/Adless.app"
test -d "$app"
app_count="$(find "$archive/Products/Applications" -mindepth 1 -maxdepth 1 -type d -name '*.app' -print | wc -l | tr -d '[:space:]')"
test "$app_count" -eq 1
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist")" = "com.orbeworks.adless"
test "$(/usr/libexec/PlistBuddy -c 'Print :AdlessEnvironment' "$app/Info.plist")" = "production"
test "$(/usr/libexec/PlistBuddy -c 'Print :AdlessDNSCloudBaseURL' "$app/Info.plist")" = "https://adless-dns.orbeworks.workers.dev"

if [ -d "$app/PlugIns" ]; then
  plugin_count="$(find "$app/PlugIns" -type d -name '*.appex' -print | wc -l | tr -d '[:space:]')"
  test "$plugin_count" -eq 0
fi
test -z "$(find "$archive" -type d -name '*.appex' -print -quit)"

if [ "$layout_only" = true ]; then
  echo "Verified Adless.app archive with no embedded extensions."
  exit 0
fi

script_directory="$(CDPATH='' cd "$(dirname "$0")" && pwd)"
sh "$script_directory/verify_distribution_profile.sh" "$app"
echo "Verified signed Adless.app archive with dns-settings and no embedded extensions."
