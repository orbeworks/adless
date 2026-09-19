"""Offline contracts for the production Worker deploy command."""
from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
WORKFLOWS = ROOT / ".github" / "workflows"


class WorkerDeployWorkflowContractTests(unittest.TestCase):
    def test_production_deploy_command_preserves_allowlist_and_deploys_worker(self):
        deploy_script = (ROOT / "tools" / "dns-worker" / "deploy-production.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn("merge-for-deploy", deploy_script)
        self.assertIn("--print-builds", deploy_script)
        self.assertIn("wrangler@4 deploy", deploy_script)
        self.assertIn("APPLE_TESTFLIGHT_BUILD_VERSIONS:$testflight_builds", deploy_script)
        self.assertIn("testflight_builds.py verify", deploy_script)


if __name__ == "__main__":
    unittest.main()
