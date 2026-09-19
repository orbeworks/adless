#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

: "${ASC_KEY_ID:?ASC_KEY_ID secret is required}"
: "${ASC_ISSUER_ID:?ASC_ISSUER_ID secret is required}"
: "${ASC_KEY_PATH:?ASC_KEY_PATH must point to the App Store Connect .p8 key}"
: "${BUILD_NUMBER:?BUILD_NUMBER is required}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN secret is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID secret is required}"

app_id="${ADLESS_APP_STORE_ID:-6803552143}"

python3 tools/appstore/appstore_connect.py \
  --key-id "$ASC_KEY_ID" \
  --issuer-id "$ASC_ISSUER_ID" \
  --key-path "$ASC_KEY_PATH" \
  wait-build \
  --app-id "$app_id" \
  --build-number "$BUILD_NUMBER"

python3 tools/dns-worker/testflight_builds.py add \
  --build-number "$BUILD_NUMBER"
