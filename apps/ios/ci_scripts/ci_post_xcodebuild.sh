#!/usr/bin/env bash

set -euo pipefail

# Xcode Cloud discovers scripts in ci_scripts/ next to the Xcode project.
# TestFlight workflows are identified by their workflow name. The explicit
# flag remains available for a workflow with a different naming convention.
workflow_name="${CI_WORKFLOW:-}"
if [[ "${ADLESS_AUTHORIZE_TESTFLIGHT_BUILD:-}" != "1" && ! "$workflow_name" =~ [Tt][Ee][Ss][Tt][Ff][Ll][Ii][Gg][Hh][Tt] ]]; then
  echo "Skipping TestFlight Worker authorization (workflow is not TestFlight)."
  exit 0
fi

if [[ "${CI_XCODEBUILD_ACTION:-}" != "archive" ]]; then
  echo "Skipping TestFlight Worker authorization because this is not an archive action."
  exit 0
fi

if [[ "${CI_XCODEBUILD_EXIT_CODE:-0}" != "0" ]]; then
  echo "Skipping TestFlight Worker authorization because xcodebuild failed."
  exit 0
fi

repo_root="${CI_WORKSPACE_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
archive_path="${CI_ARCHIVE_PATH:-}"

if [[ -z "$archive_path" ]]; then
  echo "CI_ARCHIVE_PATH is required for TestFlight Worker authorization." >&2
  exit 1
fi

app_info_plist="$archive_path/Products/Applications/Adless.app/Info.plist"
if [[ ! -f "$app_info_plist" ]]; then
  echo "Archived Adless.app was not found at: $app_info_plist" >&2
  exit 1
fi

if [[ -z "${BUILD_NUMBER:-}" ]]; then
  BUILD_NUMBER="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$app_info_plist")"
  export BUILD_NUMBER
fi

temporary_key=""
cleanup() {
  if [[ -n "$temporary_key" && -f "$temporary_key" ]]; then
    rm -f "$temporary_key"
  fi
}
trap cleanup EXIT

# Xcode Cloud commonly stores the ASC key as ASC_PRIVATE_KEY. The shared
# authorization helper consumes a path, so create a short-lived 0600 file.
if [[ -z "${ASC_KEY_PATH:-}" && -n "${ASC_PRIVATE_KEY:-}" ]]; then
  temporary_key="$(mktemp "${TMPDIR:-/tmp}/adless-asc-key.XXXXXX.p8")"
  chmod 600 "$temporary_key"
  printf '%s\n' "$ASC_PRIVATE_KEY" > "$temporary_key"
  export ASC_KEY_PATH="$temporary_key"
fi

cd "$repo_root"
exec "$repo_root/tools/appstore/authorize-testflight-build.sh"
