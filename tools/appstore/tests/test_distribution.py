"""Offline regression tests: no Apple credentials, network or publication."""
from __future__ import annotations

import argparse
import contextlib
import importlib.util
import io
import plistlib
import subprocess
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("asc", ROOT / "tools/appstore/appstore_connect.py")
asc = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(asc)


def resource(identifier, **attrs):
    return {"id": identifier, "attributes": attrs}


class DistributionTests(unittest.TestCase):
    def setUp(self):
        self.client = MagicMock()
        self.state = "READY_FOR_BETA_SUBMISSION"
        self.audience = "APP_STORE_ELIGIBLE"
        self.groups = [resource("internal", isInternalGroup=True), resource("external", isInternalGroup=False)]
        self.assigned = False
        self.client.request.side_effect = self.request
        self.client.all_resources.side_effect = self.resources
        self.notes = ROOT / "docs/app-store/testflight-notes.txt"
        self.args = argparse.Namespace(app_id="app", build_id="build", notes_file=self.notes)
        self.stdout = contextlib.redirect_stdout(io.StringIO())
        self.stdout.__enter__()
        self.addCleanup(self.stdout.__exit__, None, None, None)

    def resources(self, path):
        if "/betaAppLocalizations" in path:
            return [resource("locale", locale="pt-BR", description="Test app", feedbackEmail="test@example.invalid")]
        if "/betaBuildLocalizations" in path:
            return []
        if "/betaGroups?" in path:
            return self.groups
        if "/builds?" in path:
            return [resource("build")] if self.assigned else []
        raise AssertionError(path)

    def request(self, method, path, body=None):
        if method == "GET":
            if path.endswith("/betaAppReviewDetail"):
                return {"data": resource("review", contactEmail="test@example.invalid", contactFirstName="Test",
                                         contactLastName="Reviewer", contactPhone="000", demoAccountRequired=False)}
            if path.endswith("/buildBetaDetail"):
                return {"data": resource("detail", externalBuildState=self.state)}
            if path.endswith("/app"):
                return {"data": resource("app")}
            if path == "/v1/builds/build":
                return {"data": resource("build", processingState="VALID", buildAudienceType=self.audience, expired=False)}
            raise AssertionError(path)
        if method == "POST" and path == "/v1/betaGroups":
            return {"data": resource("new-external", **body["data"]["attributes"])}
        return {}

    def writes(self):
        return [c.args for c in self.client.request.call_args_list if c.args[0] != "GET"]

    def test_beta_assigns_only_external_and_submits_beta_review(self):
        asc.command_distribute_beta(self.client, self.args)
        writes = self.writes()
        self.assertTrue(any(p == "/v1/betaGroups/external/relationships/builds" for _, p, _ in writes))
        self.assertFalse(any("/internal/" in p for _, p, _ in writes))
        self.assertTrue(any(p == "/v1/betaAppReviewSubmissions" for _, p, _ in writes))
        self.assertFalse(any("/reviewSubmissions" in p or "/appStoreVersions" in p for _, p, _ in writes))
        self.assertTrue(any(b["data"].get("attributes", {}).get("autoNotifyEnabled") for _, _, b in writes))

    def test_creates_external_group_without_enabling_public_link(self):
        self.groups = self.groups[:1]
        asc.command_distribute_beta(self.client, self.args)
        create = next(b for _, p, b in self.writes() if p == "/v1/betaGroups")
        self.assertIs(create["data"]["attributes"]["isInternalGroup"], False)
        self.assertIs(create["data"]["attributes"]["publicLinkEnabled"], False)

    def test_in_review_or_approved_not_submitted_again(self):
        for state in ("WAITING_FOR_BETA_REVIEW", "IN_BETA_REVIEW", "BETA_APPROVED", "IN_BETA_TESTING", "READY_FOR_BETA_TESTING"):
            with self.subTest(state=state):
                self.client.reset_mock()
                self.state = state
                self.assigned = True
                asc.command_distribute_beta(self.client, self.args)
                self.assertFalse(any(p == "/v1/betaAppReviewSubmissions" or p.endswith("/relationships/builds") for _, p, _ in self.writes()))

    def test_internal_only_build_cannot_reach_external_group(self):
        self.audience = "INTERNAL_ONLY"
        with self.assertRaisesRegex(RuntimeError, "internal-only"):
            asc.command_distribute_beta(self.client, self.args)
        self.assertEqual([], self.writes())

    def test_rejected_or_compliance_pending_stops_distribution(self):
        for state in ("BETA_REJECTED", "MISSING_EXPORT_COMPLIANCE", "EXPIRED", "UNKNOWN"):
            with self.subTest(state=state):
                self.client.reset_mock()
                self.state = state
                with self.assertRaises(RuntimeError):
                    asc.command_distribute_beta(self.client, self.args)
                self.assertFalse(any(p == "/v1/betaAppReviewSubmissions" or p.endswith("/relationships/builds") for _, p, _ in self.writes()))

    def test_missing_metadata_stops_before_any_write(self):
        self.client.all_resources.side_effect = None
        self.client.all_resources.return_value = []
        with self.assertRaisesRegex(RuntimeError, "Test Information"):
            asc.command_distribute_beta(self.client, self.args)
        self.assertEqual([], self.writes())

    def test_internal_group_guard_rejects_external_group(self):
        self.client.request.side_effect = None
        self.client.request.side_effect = [{"data": resource("external", isInternalGroup=False)}, {"data": resource("app")}]
        args = argparse.Namespace(app_id="app", group_id="external", build_id="build", require_internal=True)
        with self.assertRaisesRegex(RuntimeError, "internal"):
            asc.command_add_beta_build(self.client, args)
        self.assertEqual([], self.writes())

    def test_internal_preflight_does_not_require_beta_review_metadata(self):
        args = argparse.Namespace(app_id="app", group_id="internal", version="1.0.1", external=False)
        self.client.request.side_effect = None
        self.client.request.return_value = {"data": resource("app", bundleId="com.orbeworks.adless")}
        self.client.all_resources.side_effect = None
        self.client.all_resources.return_value = [resource("v", platform="IOS", versionString="1.0", appStoreState="READY_FOR_SALE")]
        with patch.object(asc, "require_internal_group"), patch.object(asc, "require_beta_metadata") as metadata:
            asc.command_testflight_preflight(self.client, args)
            metadata.assert_not_called()
            args.external = True
            asc.command_testflight_preflight(self.client, args)
            metadata.assert_called_once()
            args.version = "1.0"
            with self.assertRaisesRegex(RuntimeError, "MARKETING_VERSION"):
                asc.command_testflight_preflight(self.client, args)

    def test_next_marketing_skips_closed_train_and_reuses_open_train(self):
        args = argparse.Namespace(app_id="app", current_version="1.0.1")
        self.client.all_resources.side_effect = lambda path: [
            resource("closed", platform="IOS", versionString="1.0.1", appStoreState="READY_FOR_SALE"),
            resource("open", platform="IOS", versionString="1.0.2", appStoreState="PREPARE_FOR_SUBMISSION"),
        ]
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            asc.command_next_marketing(self.client, args)
        self.assertEqual("1.0.2\n", output.getvalue())

    def test_next_marketing_advances_after_open_train_is_closed(self):
        args = argparse.Namespace(app_id="app", current_version="1.0.1")
        self.client.all_resources.side_effect = lambda path: [
            resource("closed", platform="IOS", versionString="1.0.2", appStoreState="READY_FOR_SALE"),
        ]
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            asc.command_next_marketing(self.client, args)
        self.assertEqual("1.0.3\n", output.getvalue())

    def test_main_sets_automatic_release_and_submits_public_review(self):
        version = resource("version", appStoreState="PREPARE_FOR_SUBMISSION")
        self.client.request.side_effect = None
        self.client.request.return_value = {"data": resource("submission")}
        args = argparse.Namespace(app_id="app", version="1.0.1", build_id="build")
        with patch.object(asc, "app_store_version", return_value=version):
            asc.command_attach_submit(self.client, args)
        writes = self.writes()
        self.assertEqual(writes[0][2]["data"]["attributes"], {"releaseType": "AFTER_APPROVAL"})
        self.assertTrue(any(p == "/v1/reviewSubmissions" for _, p, _ in writes))
        self.assertEqual(writes[-1][2]["data"]["attributes"], {"submitted": True})
        self.assertFalse(any("/beta" in p for _, p, _ in writes))

    def test_main_does_not_resubmit_or_write_an_unsupported_state(self):
        args = argparse.Namespace(app_id="app", version="1.0.1", build_id="build")
        for state in ("IN_REVIEW", "READY_FOR_SALE", "READY_FOR_DISTRIBUTION"):
            with patch.object(asc, "app_store_version", return_value=resource("version", appStoreState=state)):
                asc.command_attach_submit(self.client, args)
        with patch.object(asc, "app_store_version", return_value=resource("version", appStoreState="UNKNOWN")):
            with self.assertRaises(RuntimeError):
                asc.command_attach_submit(self.client, args)
        self.assertEqual([], self.writes())


class WorkflowContractTests(unittest.TestCase):
    def test_temporary_build_directories_are_cleaned_on_shell_exit(self):
        common = (ROOT / ".githooks" / "common.sh").read_text(encoding="utf-8")
        for function_name in ("run_worker_deploy_dry_runs", "run_ios_tests"):
            with self.subTest(function_name=function_name):
                start = common.index(f"{function_name}() (")
                end = common.index("\n)\n", start)
                function = common[start:end]
                self.assertIn("trap '", function)
                self.assertIn(" EXIT", function)
                self.assertNotIn(" RETURN", function)

    def test_daily_cleanup_covers_private_and_session_temp_roots(self):
        cleanup = (ROOT / "tools" / "dev" / "cleanup-adless-temp.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn("temp_roots=(/private/tmp)", cleanup)
        self.assertIn("getconf DARWIN_USER_TEMP_DIR", cleanup)
        self.assertIn('temp_roots+=("$session_temp_root")', cleanup)
        self.assertIn('-type d -name \'adless*\'', cleanup)
        self.assertIn('stat -f \'%u\'', cleanup)
        self.assertIn('Skipping active temporary directory', cleanup)

    def test_promotion_workflows_open_only_the_expected_pull_requests(self):
        workflows = (
            ("open-develop-to-beta-pr.yml", "develop", "beta"),
            ("open-beta-to-main-pr.yml", "beta", "main"),
        )
        for filename, head, base in workflows:
            with self.subTest(filename=filename):
                text = (ROOT / ".github/workflows" / filename).read_text(encoding="utf-8")
                compact = " ".join(text.split())
                self.assertIn(f"- {head}", text)
                self.assertIn("pull-requests: write", text)
                self.assertIn("contents: read", text)
                self.assertIn(f"--base {base}", compact)
                self.assertIn(f"--head {head}", compact)
                self.assertIn("--state open", compact)
                self.assertIn(f"compare/{base}...{head}", compact)
                self.assertIn("gh pr create", compact)
                self.assertIn('if [ -n "$existing_pr" ]; then', text)
                self.assertLess(text.index("gh pr list"), text.index("gh pr create"))
                self.assertIn("concurrency:", text)
                self.assertIn("cancel-in-progress: false", text)
                self.assertNotIn("gh pr merge", compact)
                self.assertNotIn("auto-merge", compact)

    def test_export_audience_and_build_number_are_explicit(self):
        for filename, internal in (("ExportOptions-TestFlight-Internal.plist", True),
                                   ("ExportOptions-TestFlight.plist", False), ("ExportOptions.plist", False)):
            with self.subTest(file=filename):
                config = plistlib.loads((ROOT / "docs/app-store" / filename).read_bytes())
                self.assertEqual(config["testFlightInternalTestingOnly"], internal)
                self.assertIs(config["manageAppVersionAndBuildNumber"], False)
                self.assertEqual(config["method"], "app-store-connect")

    def test_github_ios_workflows_are_removed_for_xcode_cloud(self):
        self.assertFalse((ROOT / ".github/workflows/testflight-ios.yml").exists())
        self.assertFalse((ROOT / ".github/workflows/release-ios.yml").exists())

    def test_cross_origin_apple_request_is_rejected_before_network(self):
        with patch.object(asc, "make_token", return_value="not-a-real-credential"), patch.object(asc.urllib.request, "urlopen") as network:
            client = asc.Client("key", "issuer", Path("unused"))
            with self.assertRaises(ValueError):
                client.request("GET", "https://example.invalid/page")
            network.assert_not_called()

if __name__ == "__main__":
    unittest.main()
