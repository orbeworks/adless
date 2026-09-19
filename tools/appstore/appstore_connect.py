#!/usr/bin/env python3
"""Small App Store Connect API client used by the iOS release workflow.

The release workflow intentionally keeps the Apple API integration here instead
of adding a third-party dependency to the repository. The script only handles
release orchestration, beta groups and testing notes. It does not invent review
contact information or change subscription pricing or public store metadata.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


API_ROOT = "https://api.appstoreconnect.apple.com"
JWT_AUDIENCE = "appstoreconnect-v1"
JWT_LIFETIME_SECONDS = 15 * 60
POLL_INTERVAL_SECONDS = 30
POLL_ATTEMPTS = 40

RELEASEABLE_STATES = {
    "PREPARE_FOR_SUBMISSION",
    "REJECTED",
    "DEVELOPER_REJECTED",
    "INVALID_BINARY",
    "METADATA_REJECTED",
}

SAFE_SKIP_STATES = {
    "READY_FOR_REVIEW",
    "WAITING_FOR_REVIEW",
    "IN_REVIEW",
    "PENDING_DEVELOPER_RELEASE",
    "PENDING_APPLE_RELEASE",
    "READY_FOR_SALE",
    "READY_FOR_DISTRIBUTION",
    "DEVELOPER_REMOVED_FROM_SALE",
    "PROCESSING_FOR_APP_STORE",
}


class APIError(RuntimeError):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _der_length(data: bytes, offset: int) -> tuple[int, int]:
    first = data[offset]
    offset += 1
    if first & 0x80 == 0:
        return first, offset
    count = first & 0x7F
    if count == 0 or count > 4:
        raise ValueError("invalid DER length")
    end = offset + count
    if end > len(data):
        raise ValueError("truncated DER length")
    return int.from_bytes(data[offset:end], "big"), end


def _der_integer(data: bytes, offset: int) -> tuple[bytes, int]:
    if offset >= len(data) or data[offset] != 0x02:
        raise ValueError("invalid DER integer")
    length, value_offset = _der_length(data, offset + 1)
    end = value_offset + length
    if end > len(data):
        raise ValueError("truncated DER integer")
    return data[value_offset:end], end


def _der_signature_to_jwt_signature(signature: bytes) -> bytes:
    """Convert OpenSSL's DER ECDSA signature to JWT's r||s representation."""

    if not signature or signature[0] != 0x30:
        raise ValueError("OpenSSL did not return a DER ECDSA signature")
    _, offset = _der_length(signature, 1)
    r, offset = _der_integer(signature, offset)
    s, offset = _der_integer(signature, offset)
    if offset != len(signature):
        raise ValueError("unexpected data after DER ECDSA signature")
    return r.lstrip(b"\x00").rjust(32, b"\x00") + s.lstrip(b"\x00").rjust(32, b"\x00")


def make_token(key_id: str, issuer_id: str, key_path: Path) -> str:
    now = int(time.time())
    header = {"alg": "ES256", "kid": key_id, "typ": "JWT"}
    payload = {
        "iss": issuer_id,
        "iat": now,
        "exp": now + JWT_LIFETIME_SECONDS,
        "aud": JWT_AUDIENCE,
    }
    unsigned = f"{_b64url(json.dumps(header, separators=(',', ':')).encode())}.{_b64url(json.dumps(payload, separators=(',', ':')).encode())}"
    result = subprocess.run(
        ["openssl", "dgst", "-sha256", "-sign", str(key_path)],
        input=unsigned.encode("ascii"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"could not sign App Store Connect token: {result.stderr.decode(errors='replace').strip()}")
    signature = _der_signature_to_jwt_signature(result.stdout)
    return f"{unsigned}.{_b64url(signature)}"


class Client:
    def __init__(self, key_id: str, issuer_id: str, key_path: Path) -> None:
        self.credentials = (key_id, issuer_id, key_path)
        self.token = make_token(key_id, issuer_id, key_path)
        self.token_created_at = time.time()

    def request(self, method: str, path_or_url: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        url = path_or_url if path_or_url.startswith("http") else API_ROOT + path_or_url
        if urllib.parse.urlsplit(url).netloc != "api.appstoreconnect.apple.com" or not url.startswith(API_ROOT + "/"):
            raise ValueError("Refusing to send Apple credentials to an unexpected API origin")
        if time.time() - self.token_created_at >= JWT_LIFETIME_SECONDS - 60:
            self.token = make_token(*self.credentials)
            self.token_created_at = time.time()
        request = urllib.request.Request(
            url,
            method=method,
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            },
            data=json.dumps(body).encode("utf-8") if body is not None else None,
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read()
        except urllib.error.HTTPError as error:
            # API responses may echo submitted review/contact data. Do not log
            # their bodies or request headers; inspect details in ASC instead.
            raise APIError(error.code, f"App Store Connect API HTTP {error.code}; inspect the operation in App Store Connect") from None
        if not raw:
            return {}
        return json.loads(raw)

    def all_resources(self, path: str) -> list[dict[str, Any]]:
        resources: list[dict[str, Any]] = []
        next_url: str | None = path
        while next_url:
            page = self.request("GET", next_url)
            resources.extend(page.get("data", []))
            next_url = page.get("links", {}).get("next")
        return resources


def _attributes(resource: dict[str, Any]) -> dict[str, Any]:
    return resource.get("attributes", {})


def app_store_version(client: Client, app_id: str, version_string: str) -> dict[str, Any] | None:
    resources = client.all_resources(f"/v1/apps/{urllib.parse.quote(app_id)}/appStoreVersions?limit=200")
    for resource in resources:
        attrs = _attributes(resource)
        if attrs.get("platform") == "IOS" and attrs.get("versionString") == version_string:
            return resource
    return None


def app_builds(client: Client, app_id: str) -> list[dict[str, Any]]:
    quoted_id = urllib.parse.quote(app_id)
    return client.all_resources(f"/v1/apps/{quoted_id}/builds?limit=200")


def write_output(values: dict[str, str]) -> None:
    output_path = os.environ.get("GITHUB_OUTPUT")
    if not output_path:
        return
    with open(output_path, "a", encoding="utf-8") as output:
        for key, value in values.items():
            output.write(f"{key}={value}\n")


def command_preflight(client: Client, args: argparse.Namespace) -> None:
    version = app_store_version(client, args.app_id, args.version)
    if version is None:
        raise RuntimeError(
            f"App Store version {args.version} does not exist in App Store Connect. "
            "Create and prepare the version there before pushing to main."
        )
    state = _attributes(version).get("appStoreState", "UNKNOWN")
    version_id = version["id"]
    if state in RELEASEABLE_STATES:
        should_release = "true"
        message = f"App Store version {args.version} is {state}; release may continue."
    elif state in SAFE_SKIP_STATES:
        should_release = "false"
        message = f"App Store version {args.version} is already {state}; no new submission will be created."
    else:
        raise RuntimeError(
            f"App Store version {args.version} has unsupported state {state}. "
            "Resolve it in App Store Connect before releasing."
        )
    print(message)
    write_output(
        {
            "should_release": should_release,
            "version_id": version_id,
            "version_state": state,
            "message": message,
        }
    )


def command_next_build(client: Client, args: argparse.Namespace) -> None:
    highest = 0
    for resource in app_builds(client, args.app_id):
        raw_version = _attributes(resource).get("version")
        try:
            highest = max(highest, int(str(raw_version)))
        except (TypeError, ValueError):
            continue
    next_build = max(highest + 1, args.minimum)
    print(next_build)
    write_output({"build_number": str(next_build)})


def marketing_version_tuple(value: str) -> tuple[int, int, int]:
    if not re.fullmatch(r"[0-9]+(?:\.[0-9]+){1,2}", value):
        raise ValueError("Marketing version must have two or three numeric components")
    components = [int(part) for part in value.split(".")]
    return tuple((components + [0, 0, 0])[:3])


def marketing_version_string(value: tuple[int, int, int]) -> str:
    return ".".join(str(part) for part in value)


def command_next_marketing(client: Client, args: argparse.Namespace) -> None:
    """Select an App Store version that is not closed for new builds."""

    current = marketing_version_tuple(args.current_version)
    versions = [
        resource
        for resource in client.all_resources(
            f"/v1/apps/{urllib.parse.quote(args.app_id)}/appStoreVersions?limit=200"
        )
        if _attributes(resource).get("platform") == "IOS"
    ]
    closed_states = {
        "READY_FOR_SALE",
        "READY_FOR_DISTRIBUTION",
        "REMOVED_FROM_SALE",
        "DEVELOPER_REMOVED_FROM_SALE",
        "PENDING_DEVELOPER_RELEASE",
        "PENDING_APPLE_RELEASE",
        "PROCESSING_FOR_APP_STORE",
    }
    closed_versions = [
        marketing_version_tuple(str(_attributes(resource)["versionString"]))
        for resource in versions
        if _attributes(resource).get("appStoreState") in closed_states
    ]
    if closed_versions:
        latest_closed = max(closed_versions)
        next_after_closed = (latest_closed[0], latest_closed[1], latest_closed[2] + 1)
    else:
        next_after_closed = (0, 0, 0)
    open_versions = [
        marketing_version_tuple(str(_attributes(resource)["versionString"]))
        for resource in versions
        if _attributes(resource).get("appStoreState") not in closed_states
    ]
    selected = max(current, next_after_closed, *open_versions)
    value = marketing_version_string(selected)
    print(value)
    write_output({"marketing_version": value})


def require_internal_group(client: Client, app_id: str, group_id: str) -> None:
    group_path = f"/v1/betaGroups/{urllib.parse.quote(group_id, safe='')}"
    group = client.request("GET", group_path)["data"]
    app = client.request("GET", group_path + "/app")["data"]
    if _attributes(group).get("isInternalGroup") is not True or app.get("id") != app_id:
        raise RuntimeError("The beta group must be internal and belong to the requested app")


def command_testflight_preflight(client: Client, args: argparse.Namespace) -> None:
    requested = marketing_version_tuple(args.version)
    app = client.request("GET", f"/v1/apps/{urllib.parse.quote(args.app_id, safe='')}")["data"]
    if _attributes(app).get("bundleId") != "com.orbeworks.adless":
        raise RuntimeError("The TestFlight app must have the production Adless bundle identifier")
    require_internal_group(client, args.app_id, args.group_id)
    closed_states = {
        "READY_FOR_SALE", "READY_FOR_DISTRIBUTION", "REMOVED_FROM_SALE",
        "DEVELOPER_REMOVED_FROM_SALE", "PENDING_DEVELOPER_RELEASE",
        "PENDING_APPLE_RELEASE", "PROCESSING_FOR_APP_STORE",
    }
    versions = client.all_resources(
        f"/v1/apps/{urllib.parse.quote(args.app_id, safe='')}/appStoreVersions?limit=200"
    )
    for version in versions:
        attrs = _attributes(version)
        if attrs.get("platform") == "IOS" and attrs.get("appStoreState") in closed_states:
            if requested <= marketing_version_tuple(str(attrs.get("versionString", ""))):
                raise RuntimeError(
                    "Increase MARKETING_VERSION in the Xcode project: "
                    "it must be newer than the approved App Store version"
                )
    if args.external:
        require_beta_metadata(client, args.app_id)
    print(f"TestFlight version {args.version} and requested distribution prerequisites verified (read-only)")


def require_beta_metadata(client: Client, app_id: str) -> list[dict[str, Any]]:
    app_path = f"/v1/apps/{urllib.parse.quote(app_id, safe='')}"
    localizations = client.all_resources(app_path + "/betaAppLocalizations?limit=200")
    if not localizations or any(
        not _attributes(item).get(field)
        for item in localizations for field in ("description", "feedbackEmail", "locale")
    ):
        raise RuntimeError("Complete TestFlight > Test Information: beta description and feedback email in every language")
    detail = client.request("GET", app_path + "/betaAppReviewDetail").get("data") or {}
    attrs = _attributes(detail)
    if any(not attrs.get(field) for field in (
        "contactEmail", "contactFirstName", "contactLastName", "contactPhone",
    )):
        raise RuntimeError("Complete TestFlight > Test Information > Beta App Review contact details")
    if attrs.get("demoAccountRequired") and (
        not attrs.get("demoAccountName") or not attrs.get("demoAccountPassword")
    ):
        raise RuntimeError("Resolve the beta review sign-in requirements in App Store Connect")
    return localizations


def command_distribute_beta(client: Client, args: argparse.Namespace) -> None:
    # No public App Store submission in this command. Only external groups of
    # this app receive the build; create an external group if none exists.
    localizations = require_beta_metadata(client, args.app_id)
    build_path = f"/v1/builds/{urllib.parse.quote(args.build_id, safe='')}"
    build = client.request("GET", build_path)["data"]
    app = client.request("GET", build_path + "/app")["data"]
    attrs = _attributes(build)
    if app.get("id") != args.app_id or attrs.get("processingState") != "VALID":
        raise RuntimeError("The processed build must belong to the requested app")
    if attrs.get("buildAudienceType") != "APP_STORE_ELIGIBLE" or attrs.get("expired"):
        raise RuntimeError("External TestFlight requires a non-expired build exported without internal-only restrictions")
    notes = args.notes_file.read_text(encoding="utf-8").strip()
    if not notes or len(notes) > 4000:
        raise ValueError("TestFlight testing notes must contain 1–4000 characters")
    existing_notes = client.all_resources(build_path + "/betaBuildLocalizations?limit=200")
    by_locale = {_attributes(item).get("locale"): item for item in existing_notes}
    for localization in localizations:
        locale = _attributes(localization)["locale"]
        existing = by_locale.get(locale)
        if existing and _attributes(existing).get("whatsNew") == notes:
            continue
        data = {"type": "betaBuildLocalizations", "attributes": {"whatsNew": notes}}
        if existing:
            data["id"] = existing["id"]
            client.request("PATCH", f"/v1/betaBuildLocalizations/{existing['id']}", {"data": data})
        else:
            data["attributes"]["locale"] = locale
            data["relationships"] = {"build": {"data": {"type": "builds", "id": args.build_id}}}
            client.request("POST", "/v1/betaBuildLocalizations", {"data": data})

    detail = client.request("GET", build_path + "/buildBetaDetail")["data"]
    state = _attributes(detail).get("externalBuildState")
    if state not in {"READY_FOR_BETA_SUBMISSION", "WAITING_FOR_BETA_REVIEW", "IN_BETA_REVIEW",
                     "BETA_APPROVED", "IN_BETA_TESTING", "READY_FOR_BETA_TESTING"}:
        raise RuntimeError(f"External TestFlight state {state} requires attention in App Store Connect")
    client.request("PATCH", f"/v1/buildBetaDetails/{detail['id']}", {
        "data": {"type": "buildBetaDetails", "id": detail["id"],
                 "attributes": {"autoNotifyEnabled": True}},
    })
    groups = [group for group in client.all_resources(f"/v1/apps/{args.app_id}/betaGroups?limit=200")
              if _attributes(group).get("isInternalGroup") is False]
    if not groups:
        group = client.request("POST", "/v1/betaGroups", {"data": {
            "type": "betaGroups",
            "attributes": {"name": "Adless Beta", "isInternalGroup": False,
                           "publicLinkEnabled": False},
            "relationships": {"app": {"data": {"type": "apps", "id": args.app_id}}},
        }})["data"]
        groups.append(group)
    for group in groups:
        command_add_beta_build(client, argparse.Namespace(group_id=group["id"], build_id=args.build_id))
    # Reread: Apple may have advanced the review state while assigning groups.
    state = _attributes(client.request("GET", build_path + "/buildBetaDetail")["data"]).get("externalBuildState")
    if state == "READY_FOR_BETA_SUBMISSION":
        client.request("POST", "/v1/betaAppReviewSubmissions", {"data": {
            "type": "betaAppReviewSubmissions",
            "relationships": {"build": {"data": {"type": "builds", "id": args.build_id}}},
        }})
        state = "WAITING_FOR_BETA_REVIEW"
    elif state not in {"WAITING_FOR_BETA_REVIEW", "IN_BETA_REVIEW", "BETA_APPROVED",
                       "IN_BETA_TESTING", "READY_FOR_BETA_TESTING"}:
        raise RuntimeError(f"External TestFlight state changed to {state}; inspect in App Store Connect")
    print(f"Build assigned to {len(groups)} TestFlight groups; external status: {state}. Invitations automatic when Apple permits testing.")
    write_output({"external_state": state})


def command_wait_build(client: Client, args: argparse.Namespace) -> None:
    for attempt in range(1, POLL_ATTEMPTS + 1):
        matches = [
            resource
            for resource in app_builds(client, args.app_id)
            if str(_attributes(resource).get("version")) == str(args.build_number)
        ]
        if matches:
            matches.sort(key=lambda resource: _attributes(resource).get("uploadedDate", ""), reverse=True)
            build = matches[0]
            attrs = _attributes(build)
            processing_state = attrs.get("processingState", "UNKNOWN")
            print(f"Build {args.build_number}: {processing_state} (poll {attempt}/{POLL_ATTEMPTS})")
            if processing_state == "VALID":
                write_output({"build_id": build["id"], "processing_state": processing_state})
                return
            if processing_state == "INVALID":
                raise RuntimeError(f"Apple rejected build {args.build_number} during processing: {attrs}")
        else:
            print(f"Build {args.build_number}: not visible yet (poll {attempt}/{POLL_ATTEMPTS})")
        time.sleep(POLL_INTERVAL_SECONDS)
    raise RuntimeError(f"Timed out waiting for build {args.build_number} to become VALID")


def command_add_beta_build(client: Client, args: argparse.Namespace) -> None:
    if getattr(args, "require_internal", False):
        if not args.app_id:
            raise ValueError("--app-id is required with --require-internal")
        require_internal_group(client, args.app_id, args.group_id)
    group_path = f"/v1/betaGroups/{urllib.parse.quote(args.group_id)}/builds?limit=200"
    assigned_builds = client.all_resources(group_path)
    if any(resource.get("id") == args.build_id for resource in assigned_builds):
        print(f"Build {args.build_id} is already assigned to beta group {args.group_id}")
        return

    client.request(
        "POST",
        f"/v1/betaGroups/{urllib.parse.quote(args.group_id)}/relationships/builds",
        {"data": [{"type": "builds", "id": args.build_id}]},
    )
    print(f"Assigned build {args.build_id} to beta group {args.group_id}")


def _review_submission(client: Client, app_id: str) -> dict[str, Any]:
    body = {
        "data": {
            "type": "reviewSubmissions",
            "attributes": {"platform": "IOS"},
            "relationships": {"app": {"data": {"type": "apps", "id": app_id}}},
        }
    }
    return client.request("POST", "/v1/reviewSubmissions", body)["data"]


def command_attach_submit(client: Client, args: argparse.Namespace) -> None:
    version = app_store_version(client, args.app_id, args.version)
    if version is None:
        raise RuntimeError(f"App Store version {args.version} disappeared while releasing")
    version_id = version["id"]
    state = _attributes(version).get("appStoreState")
    if state in SAFE_SKIP_STATES:
        print(f"App Store version {args.version} became {state}; stopping without a second submission")
        return

    if state not in RELEASEABLE_STATES:
        raise RuntimeError(f"App Store version is no longer releaseable ({state})")

    client.request("PATCH", f"/v1/appStoreVersions/{urllib.parse.quote(version_id)}", {
        "data": {"type": "appStoreVersions", "id": version_id,
                 "attributes": {"releaseType": "AFTER_APPROVAL"}},
    })

    client.request(
        "PATCH",
        f"/v1/appStoreVersions/{urllib.parse.quote(version_id)}/relationships/build",
        {"data": {"type": "builds", "id": args.build_id}},
    )
    print(f"Linked build {args.build_id} to App Store version {version_id}")

    try:
        submission = _review_submission(client, args.app_id)
    except APIError as error:
        raise RuntimeError(
            f"Could not create the review submission ({error.status}). "
            "The build was uploaded and linked; finish the submission in App Store Connect."
        ) from error
    submission_id = submission["id"]
    client.request(
        "POST",
        "/v1/reviewSubmissionItems",
        {
            "data": {
                "type": "reviewSubmissionItems",
                "relationships": {
                    "reviewSubmission": {"data": {"type": "reviewSubmissions", "id": submission_id}},
                    "appStoreVersion": {"data": {"type": "appStoreVersions", "id": version_id}},
                },
            }
        },
    )
    client.request(
        "PATCH",
        f"/v1/reviewSubmissions/{urllib.parse.quote(submission_id)}",
        {
            "data": {
                "type": "reviewSubmissions",
                "id": submission_id,
                "attributes": {"submitted": True},
            }
        },
    )
    print(f"App Store version {args.version} submitted; automatic production release AFTER Apple approval")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--key-id", required=True)
    parser.add_argument("--issuer-id", required=True)
    parser.add_argument("--key-path", required=True, type=Path)
    subparsers = parser.add_subparsers(dest="command", required=True)

    preflight = subparsers.add_parser("preflight")
    preflight.add_argument("--app-id", required=True)
    preflight.add_argument("--version", required=True)

    next_build = subparsers.add_parser("next-build")
    next_build.add_argument("--app-id", required=True)
    next_build.add_argument("--minimum", required=True, type=int)

    next_marketing = subparsers.add_parser("next-marketing")
    next_marketing.add_argument("--app-id", required=True)
    next_marketing.add_argument("--current-version", required=True)

    testflight = subparsers.add_parser("testflight-preflight")
    testflight.add_argument("--app-id", required=True)
    testflight.add_argument("--version", required=True)
    testflight.add_argument("--group-id", required=True)
    testflight.add_argument("--external", action="store_true")

    wait_build = subparsers.add_parser("wait-build")
    wait_build.add_argument("--app-id", required=True)
    wait_build.add_argument("--build-number", required=True)

    add_beta_build = subparsers.add_parser("add-beta-build")
    add_beta_build.add_argument("--group-id", required=True)
    add_beta_build.add_argument("--build-id", required=True)
    add_beta_build.add_argument("--require-internal", action="store_true")
    add_beta_build.add_argument("--app-id")

    distribute = subparsers.add_parser("distribute-beta")
    distribute.add_argument("--app-id", required=True)
    distribute.add_argument("--build-id", required=True)
    distribute.add_argument("--notes-file", required=True, type=Path)

    attach = subparsers.add_parser("attach-submit")
    attach.add_argument("--app-id", required=True)
    attach.add_argument("--version", required=True)
    attach.add_argument("--build-id", required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        client = Client(args.key_id, args.issuer_id, args.key_path)
        if args.command == "preflight":
            command_preflight(client, args)
        elif args.command == "next-build":
            command_next_build(client, args)
        elif args.command == "next-marketing":
            command_next_marketing(client, args)
        elif args.command == "testflight-preflight":
            command_testflight_preflight(client, args)
        elif args.command == "wait-build":
            command_wait_build(client, args)
        elif args.command == "add-beta-build":
            command_add_beta_build(client, args)
        elif args.command == "distribute-beta":
            command_distribute_beta(client, args)
        elif args.command == "attach-submit":
            command_attach_submit(client, args)
        else:
            raise RuntimeError(f"unsupported command: {args.command}")
    except (APIError, OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
