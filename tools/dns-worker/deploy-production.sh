#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN secret is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID secret is required}"

config_path="apps/dns-worker/wrangler.toml"

testflight_builds="$(
  python3 tools/dns-worker/testflight_builds.py merge-for-deploy \
    --config "$config_path" \
    --print-builds
)"
test -n "$testflight_builds"

npx --yes wrangler@4 deploy \
  --env="" \
  --config "$config_path" \
  --var "APPLE_TESTFLIGHT_BUILD_VERSIONS:$testflight_builds"

python3 tools/dns-worker/testflight_builds.py verify \
  --builds "$testflight_builds"
