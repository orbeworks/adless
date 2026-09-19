#!/bin/sh
set -eu

expected_bundle_id=com.orbeworks.adless.dev
expected_environment=development
expected_worker_url=https://adless-dns-development.orbeworks.workers.dev
scheme_name='Adless Dev'
configuration_name='Debug Dev'

fail() {
  echo "error: $1" >&2
  exit 1
}

for command_name in xcodebuild xcrun open osascript ditto codesign plutil python3; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required"
done
test "$(uname -s)" = Darwin || fail "this installer requires macOS"

script_directory="$(CDPATH='' cd "$(dirname "$0")" && pwd)"
repository_root="$(CDPATH='' cd "$script_directory/../.." && pwd)"
source_ios="$repository_root/apps/ios"
source_project="$source_ios/Adless.xcodeproj"
source_scheme="$source_project/xcshareddata/xcschemes/Adless Dev.xcscheme"
source_configuration="$source_ios/Configurations/Development.xcconfig"
source_storekit="$source_ios/Adless.storekit"

test -d "$source_project" || fail "Adless.xcodeproj is missing"
test -f "$source_scheme" || fail "the shared Adless Dev scheme is missing"
test -f "$source_configuration" || fail "Development.xcconfig is missing"
test -f "$source_storekit" || fail "Adless.storekit is missing"

python3 - "$source_scheme" <<'PY' || exit 1
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
launch = root.find("LaunchAction")
if launch is None or launch.get("buildConfiguration") != "Debug Dev":
    raise SystemExit("error: Adless Dev LaunchAction must use Debug Dev")
storekit = launch.find("StoreKitConfigurationFileReference")
if storekit is None or storekit.get("identifier") != "../../Adless.storekit":
    raise SystemExit("error: Adless Dev LaunchAction must enable Adless.storekit")
arguments = launch.find("CommandLineArguments")
enabled = arguments is not None and any(
    item.get("argument") == "-useStoreKitProducts" and item.get("isEnabled") == "YES"
    for item in arguments.findall("CommandLineArgument")
)
if not enabled:
    raise SystemExit("error: Adless Dev must enable -useStoreKitProducts")
PY

grep -Fqx "ADLESS_ENVIRONMENT = $expected_environment" "$source_configuration" \
  || fail "Development.xcconfig has the wrong environment"
grep -Fqx "ADLESS_APP_BUNDLE_IDENTIFIER = $expected_bundle_id" "$source_configuration" \
  || fail "Development.xcconfig has the wrong bundle identifier"
grep -Fqx "ADLESS_DNS_CLOUD_BASE_URL = https:/\$()/adless-dns-development.orbeworks.workers.dev" "$source_configuration" \
  || fail "Development.xcconfig does not point to the development Worker"

requested_device="${1:-${ADLESS_IOS_DEVICE:-}}"
destinations="$(xcodebuild -project "$source_project" -scheme "$scheme_name" -showdestinations 2>&1)" \
  || fail "unable to list Xcode destinations"
destination_record="$(printf '%s\n' "$destinations" | python3 -c '
import re
import sys

requested = sys.argv[1]
devices = []
for line in sys.stdin:
    match = re.search(r"\{ platform:iOS, arch:[^,]+, id:([^,]+), name:(.+) \}", line)
    if match and "Simulator" not in line and "placeholder" not in match.group(1):
        devices.append((match.group(1).strip(), match.group(2).strip()))
if requested:
    devices = [
        item
        for item in devices
        if requested in item[0] or requested.casefold() in item[1].casefold()
    ]
if len(devices) != 1:
    available = ", ".join(f"{name} ({identifier})" for identifier, name in devices) or "none"
    raise SystemExit(f"error: expected one matching physical iPhone, found: {available}")
print(devices[0][0] + "|" + devices[0][1])
' "$requested_device")" || exit 1
device_id="${destination_record%%|*}"
device_name="${destination_record#*|}"

lock_state="$(xcrun devicectl device info lockState --device "$device_id" 2>&1)" \
  || fail "unable to query $device_name; connect and trust the iPhone"
printf '%s\n' "$lock_state" | grep -Fq 'passcodeRequired: false' \
  || fail "unlock $device_name, keep its screen on, and run this script again"

temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/adless-dev-install.XXXXXX")"
temporary_ios="$temporary_root/ios"
derived_data="$temporary_root/DerivedData"
preserve_workspace=false

cleanup_temporary_root() {
  test -d "$temporary_root" || return 0
  if [ "$preserve_workspace" = true ]; then
    test ! -d "$derived_data" || find "$derived_data" -depth -delete
    test ! -f "$temporary_root/signed-entitlements.plist" \
      || find "$temporary_root/signed-entitlements.plist" -delete
  else
    find "$temporary_root" -depth -delete
  fi
}

trap cleanup_temporary_root EXIT HUP INT TERM
ditto "$source_ios" "$temporary_ios"
echo "Preparing isolated Xcode workspace at $temporary_root"

xcodebuild \
  -project "$temporary_ios/Adless.xcodeproj" \
  -scheme "$scheme_name" \
  -configuration "$configuration_name" \
  -destination "platform=iOS,id=$device_id" \
  -derivedDataPath "$derived_data" \
  build

app="$derived_data/Build/Products/Debug Dev-iphoneos/Adless.app"
test -d "$app" || fail "the Adless Dev app bundle was not produced"
info_plist="$app/Info.plist"
test "$(plutil -extract CFBundleIdentifier raw -o - "$info_plist")" = "$expected_bundle_id" \
  || fail "built app has the wrong bundle identifier"
test "$(plutil -extract AdlessEnvironment raw -o - "$info_plist")" = "$expected_environment" \
  || fail "built app has the wrong environment"
test "$(plutil -extract AdlessDNSCloudBaseURL raw -o - "$info_plist")" = "$expected_worker_url" \
  || fail "built app has the wrong Worker URL"

signed_entitlements="$temporary_root/signed-entitlements.plist"
codesign -d --entitlements :- "$app" > "$signed_entitlements" 2>/dev/null \
  || fail "unable to read signed app entitlements"
python3 - "$signed_entitlements" "$expected_bundle_id" <<'PY' || exit 1
import plistlib
import sys

with open(sys.argv[1], "rb") as handle:
    entitlements = plistlib.load(handle)
application_identifier = entitlements.get("application-identifier", "")
if not application_identifier.endswith("." + sys.argv[2]):
    raise SystemExit("error: signed application-identifier does not match Adless Dev")
if entitlements.get("com.apple.developer.networking.networkextension") != ["dns-settings"]:
    raise SystemExit("error: signed app must contain only the dns-settings network extension entitlement")
PY

xcrun devicectl device install app --device "$device_id" "$app"
open -a Xcode "$temporary_ios/Adless.xcodeproj"

osascript - "$scheme_name" "$device_name" <<'APPLESCRIPT'
on run arguments
    set requestedScheme to item 1 of arguments
    set requestedDevice to item 2 of arguments
    tell application "Xcode" to activate
    tell application "System Events"
        tell process "Xcode"
            set frontmost to true
            repeat 120 times
                try
                    tell menu 1 of menu bar item "Product" of menu bar 1
                        if exists menu item requestedScheme of menu 1 of menu item "Scheme" then exit repeat
                    end tell
                end try
                delay 0.25
            end repeat
            tell menu 1 of menu bar item "Product" of menu bar 1
                tell menu 1 of menu item "Scheme" to click menu item requestedScheme
                delay 0.5
                tell menu 1 of menu item "Destination" to click menu item requestedDevice
                delay 0.5
                click menu item "Run"
            end tell
        end tell
    end tell
end run
APPLESCRIPT

preserve_workspace=true
echo "Installed $expected_bundle_id on $device_name."
echo "Xcode Run started with the Adless Dev scheme and Adless.storekit enabled."
echo "The app points only to $expected_worker_url."
echo "The temporary source workspace remains at $temporary_ios while the debug session is active."
echo "Temporary DerivedData is removed automatically when this installer exits."
