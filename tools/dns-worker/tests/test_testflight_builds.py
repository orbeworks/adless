"""Settings-only Cloudflare automation, mocked: never deploys or uses secrets."""
from __future__ import annotations

import contextlib
import copy
import importlib.util
import io
import json
import unittest
from pathlib import Path
from unittest.mock import MagicMock, mock_open, patch

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("builds", ROOT / "tools/dns-worker/testflight_builds.py")
builds = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builds)


def settings():
    text = {"DEPLOYMENT_ENV": "production", "APPLE_BUNDLE_ID": "com.orbeworks.adless",
            "APPLE_APP_ID": "6803552143", "APPLE_ALLOWED_ENVIRONMENTS": "Production",
            "APPLE_NOTIFICATION_ENVIRONMENTS": "Production,Sandbox", builds.ALLOWLIST: "2,6"}
    result = {"bindings": [{"name": k, "type": "plain_text", "text": v} for k, v in text.items()]}
    result["bindings"] += [{"name": "AUTH", "type": "kv_namespace", "namespace_id": "fixture-kv"},
                           {"name": "STATS", "type": "durable_object_namespace", "class_name": "Stats"},
                           {"name": "AUTHORITY", "type": "durable_object_namespace", "class_name": "Stats"},
                           {"name": "AUTH_TOKEN_DERIVATION_SECRET", "type": "secret_text"}]
    return result


class BuildAllowlistTests(unittest.TestCase):
    def test_only_explicit_build_numbers(self):
        self.assertEqual(builds.parse_builds("2,6,2"), {"2", "6"})
        self.assertEqual(builds.format_builds({"81", "7", "80"}), "7,80,81")
        for value in ("*", "2,*", "0", "02", "-1", "6\nEVIL=1", "1.0.2", ",", "1,", "1" * 4097, None):
            with self.subTest(value=str(value)[:20]), self.assertRaises(ValueError):
                builds.parse_builds(value)

    def test_preserves_old_builds_and_inherits_all_other_bindings(self):
        original = settings()
        original["bindings"][-1]["text"] = "synthetic-secret-must-not-copy"
        payload, merged = builds.settings_patch(original, "9")
        self.assertEqual(merged, "2,6,9")
        for binding in payload["bindings"]:
            if binding["name"] != builds.ALLOWLIST:
                self.assertEqual(binding, {"name": binding["name"], "type": "inherit"})
        self.assertNotIn("synthetic-secret", json.dumps(payload))
        self.assertNotIn("routes", payload)

    def test_rejects_wrong_environment_or_missing_bindings(self):
        for index in range(len(settings()["bindings"])):
            bad = settings()
            del bad["bindings"][index]
            with self.assertRaises(ValueError):
                builds.validated_bindings(bad)
        bad = settings()
        bad["bindings"][3]["text"] = "Production,Sandbox"
        with self.assertRaises(ValueError):
            builds.settings_patch(bad, "9")

    def test_rejects_duplicate_bindings_and_multiple_new_builds(self):
        bad = settings()
        bad["bindings"].append(copy.deepcopy(bad["bindings"][0]))
        with self.assertRaises(ValueError):
            builds.validated_bindings(bad)
        with self.assertRaises(ValueError):
            builds.settings_patch(settings(), "9,10")

    def test_multipart_contains_only_settings(self):
        payload, _ = builds.settings_patch(settings(), "9")
        data, content_type = builds.multipart_settings(payload)
        self.assertIn('name="settings"', data.decode())
        self.assertIn("multipart/form-data; boundary=", content_type)
        self.assertNotIn(b'filename=', data)

    def test_update_confirmed_by_readback(self):
        before = settings()
        after = settings()
        builds.validated_bindings(after)[builds.ALLOWLIST]["text"] = "2,6,9"
        client = MagicMock()
        client.request.side_effect = [before, {}, after]
        with contextlib.redirect_stdout(io.StringIO()):
            builds.add_build(client, "9")
        self.assertEqual([c.args[0] for c in client.request.call_args_list], ["GET", "PATCH", "GET"])

    def test_existing_build_does_not_patch(self):
        client = MagicMock()
        client.request.return_value = settings()
        with contextlib.redirect_stdout(io.StringIO()):
            builds.add_build(client, "6")
        self.assertEqual([c.args[0] for c in client.request.call_args_list], ["GET", "GET"])

    def test_lost_update_or_changed_binding_cannot_claim_success(self):
        for mutate in (False, True):
            after = settings()
            if mutate:
                bindings = builds.validated_bindings(after)
                bindings[builds.ALLOWLIST]["text"] = "2,6,9"
                bindings["AUTH"]["namespace_id"] = "different"
            client = MagicMock()
            client.request.side_effect = [settings(), {}, after]
            with self.assertRaises(RuntimeError):
                builds.add_build(client, "9")

    def test_merge_deployment_preserves_remote_builds(self):
        # Inject the stdlib parser on older macOS Python. Exercise its real TOML
        # parsing separately using Python 3.11+ (as configured on the runner).
        parser = MagicMock()
        parser.load.return_value = {"name": builds.WORKER, "vars": {builds.ALLOWLIST: "2,10"}}
        with patch.dict("sys.modules", {"tomllib": parser}), patch.object(Path, "open", mock_open()):
            self.assertEqual(builds.merged_deploy_builds(settings(), Path("unused")), "2,6,10")
            parser.load.return_value["name"] = "another-worker"
            with self.assertRaises(ValueError):
                builds.merged_deploy_builds(settings(), Path("unused"))

    def test_no_api_call_without_credentials(self):
        with patch.dict("os.environ", {}, clear=True), self.assertRaises(ValueError):
            builds.CloudflareClient()


if __name__ == "__main__":
    unittest.main()
