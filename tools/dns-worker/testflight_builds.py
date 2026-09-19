#!/usr/bin/env python3
"""Maintain only the existing production Worker's TestFlight app-version allowlist.

No code upload, KV/DO access, route updates, or secret-value reads. Callers must
serialize with Worker deployments using adless-dns-worker-production concurrency.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

WORKER = "adless-dns"
ALLOWLIST = "APPLE_TESTFLIGHT_BUILD_VERSIONS"
API_ROOT = "https://api.cloudflare.com/client/v4"


def parse_builds(value: str) -> set[str]:
    if not isinstance(value, str) or len(value) > 4096:
        raise ValueError("Invalid TestFlight app-version allowlist")
    if not value.strip():
        return set()
    builds = {part.strip() for part in value.split(",")}
    if any(not re.fullmatch(r"[1-9][0-9]{0,17}(?:\.[0-9]{1,18}){0,2}", part) for part in builds):
        raise ValueError("TestFlight allowlist must contain explicit app version values only")
    return builds


def format_builds(builds: set[str]) -> str:
    value = ",".join(sorted(builds, key=lambda value: tuple(int(part) for part in value.split("."))))
    parse_builds(value)
    return value


def validated_bindings(settings: dict[str, Any]) -> dict[str, dict[str, Any]]:
    bindings = settings.get("bindings")
    if not isinstance(bindings, list) or not all(
        isinstance(b, dict) and isinstance(b.get("name"), str) for b in bindings
    ):
        raise ValueError("Worker settings have no valid bindings")
    by_name = {b["name"]: b for b in bindings}
    if len(by_name) != len(bindings):
        raise ValueError("Worker settings contain duplicate bindings")
    expected_text = {
        "DEPLOYMENT_ENV": "production",
        "APPLE_BUNDLE_ID": "com.orbeworks.adless",
        "APPLE_APP_ID": "6803552143",
        "APPLE_ALLOWED_ENVIRONMENTS": "Production",
        "APPLE_NOTIFICATION_ENVIRONMENTS": "Production,Sandbox",
    }
    for name, value in expected_text.items():
        if by_name.get(name, {}).get("type") != "plain_text" or by_name[name].get("text") != value:
            raise ValueError(f"Unexpected production Worker policy: {name}")
    for name, kind in {
        "AUTH": "kv_namespace", "STATS": "durable_object_namespace",
        "AUTHORITY": "durable_object_namespace", "AUTH_TOKEN_DERIVATION_SECRET": "secret_text",
        ALLOWLIST: "plain_text",
    }.items():
        if by_name.get(name, {}).get("type") != kind:
            raise ValueError(f"Required Worker binding is missing or has the wrong type: {name}")
    parse_builds(by_name[ALLOWLIST].get("text"))
    return by_name


def settings_patch(settings: dict[str, Any], app_version: str) -> tuple[dict[str, Any], str]:
    new_version = parse_builds(app_version)
    if len(new_version) != 1 or app_version not in new_version:
        raise ValueError("Exactly one app version is required")
    bindings = validated_bindings(settings)
    merged = format_builds(parse_builds(bindings[ALLOWLIST]["text"]) | new_version)
    # Inherit every other binding server-side, including opaque secret values.
    # https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/edit/
    patch = {"bindings": [
        {"name": name, "type": "plain_text", "text": merged} if name == ALLOWLIST
        else {"name": name, "type": "inherit"}
        for name in bindings
    ]}
    return patch, merged


def multipart_settings(settings: dict[str, Any]) -> tuple[bytes, str]:
    boundary = "adless-settings-" + uuid.uuid4().hex
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"settings\"\r\n"
        "Content-Type: application/json\r\n\r\n"
        + json.dumps(settings, separators=(",", ":"))
        + f"\r\n--{boundary}--\r\n"
    ).encode()
    return body, f"multipart/form-data; boundary={boundary}"


class CloudflareClient:
    def __init__(self) -> None:
        self.token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
        account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
        if not self.token:
            raise ValueError("CLOUDFLARE_API_TOKEN secret is missing")
        if not re.fullmatch(r"[a-fA-F0-9]{32}", account_id):
            raise ValueError("CLOUDFLARE_ACCOUNT_ID secret is missing or invalid")
        self.url = f"{API_ROOT}/accounts/{account_id}/workers/scripts/{WORKER}/settings"

    def request(self, method: str, settings: dict[str, Any] | None = None) -> dict[str, Any]:
        headers = {
            "Authorization": f"Bearer {self.token}", "Accept": "application/json",
            "User-Agent": "Adless-TestFlight-Workflow/1.0",
        }
        body = None
        if settings is not None:
            body, headers["Content-Type"] = multipart_settings(settings)
        request = urllib.request.Request(self.url, method=method, headers=headers, data=body)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                envelope = json.loads(response.read())
        except urllib.error.HTTPError as error:
            # Do not echo API responses, headers, account identifiers, or tokens.
            raise RuntimeError(f"Cloudflare settings request failed (HTTP {error.code})") from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            raise RuntimeError("Cloudflare settings request failed; no credentials were logged") from None
        if not isinstance(envelope, dict) or envelope.get("success") is not True or not isinstance(envelope.get("result"), dict):
            raise RuntimeError("Cloudflare settings request did not return successful settings")
        return envelope["result"]


def add_build(client: CloudflareClient, app_version: str) -> None:
    before = client.request("GET")
    patch, merged = settings_patch(before, app_version)
    previous = validated_bindings(before)
    if parse_builds(previous[ALLOWLIST]["text"]) != parse_builds(merged):
        client.request("PATCH", patch)
    # Reread even on retries/no-ops. Never claim success from a PATCH alone.
    after = validated_bindings(client.request("GET"))
    if parse_builds(after[ALLOWLIST]["text"]) != parse_builds(merged):
        raise RuntimeError("Worker allowlist update could not be confirmed")
    if {k: v for k, v in previous.items() if k != ALLOWLIST} != {
        k: v for k, v in after.items() if k != ALLOWLIST
    }:
        raise RuntimeError("Worker bindings changed during allowlist update; stop distribution and inspect")
    print(f"Confirmed TestFlight app version {app_version}; other Worker bindings preserved")


def merged_deploy_builds(settings: dict[str, Any], config_path: Path) -> str:
    # The deployment job already uses Python 3.12; no extra dependency needed.
    import tomllib

    with config_path.open("rb") as handle:
        config = tomllib.load(handle)
    if config.get("name") != WORKER:
        raise ValueError("Only the existing adless-dns Worker is in scope")
    configured = parse_builds(config.get("vars", {}).get(ALLOWLIST))
    published = parse_builds(validated_bindings(settings)[ALLOWLIST]["text"])
    return format_builds(configured | published)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("check", help="Read-only validation of access and production bindings")
    add = commands.add_parser("add", help="Add one validated build; updates remote settings")
    add.add_argument("--app-version", required=True)
    merge = commands.add_parser("merge-for-deploy", help="Read-only union of published and local builds")
    merge.add_argument("--config", type=Path, required=True)
    merge.add_argument(
        "--print-builds",
        action="store_true",
        help="Print only the merged build list for non-GitHub deployment tooling",
    )
    verify = commands.add_parser("verify", help="Read-only check after Worker deployment")
    verify.add_argument("--builds", required=True)
    args = parser.parse_args()
    try:
        client = CloudflareClient()
        if args.command == "add":
            add_build(client, args.app_version)
        else:
            settings = client.request("GET")
            bindings = validated_bindings(settings)
            if args.command == "check":
                print("Existing production Worker access, policy, and binding names verified")
            elif args.command == "merge-for-deploy":
                builds = merged_deploy_builds(settings, args.config)
                if args.print_builds:
                    print(builds)
                    return 0
                output = os.environ.get("GITHUB_OUTPUT")
                if output:
                    with open(output, "a", encoding="utf-8") as handle:
                        handle.write(f"builds={builds}\n")
                print("Published TestFlight allowlist preserved for the upcoming Worker deployment")
            elif not parse_builds(args.builds).issubset(parse_builds(bindings[ALLOWLIST]["text"])):
                raise RuntimeError("Worker deployment lost authorized TestFlight builds")
            else:
                print("Worker deployment preserved the TestFlight allowlist")
    except (ValueError, RuntimeError, OSError, ImportError):
        # Messages above are sanitized; do not emit a traceback or remote body.
        error = sys.exc_info()[1]
        if isinstance(error, (ValueError, RuntimeError)):
            print(f"error: {error}", file=sys.stderr)
        else:
            print("error: local configuration unavailable (merge-for-deploy requires Python 3.11+)", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
