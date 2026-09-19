"""Offline contracts for the production and development Worker workflows."""
from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
WORKFLOWS = ROOT / ".github" / "workflows"


class WorkerDeployWorkflowContractTests(unittest.TestCase):
    def assert_health_contract(self, filename: str, endpoint: str, environment: str) -> None:
        workflow = (WORKFLOWS / filename).read_text(encoding="utf-8")
        compact = " ".join(
            line.strip().removesuffix("\\").rstrip()
            for line in workflow.splitlines()
            if line.strip()
        )
        expected = (
            'curl --fail --silent --show-error --retry 3 '
            f'"{endpoint}/healthz" '
            "| python3 -c 'import json, sys; data=json.load(sys.stdin); "
            f'assert data == {{"status": "ok", "environment": "{environment}"}}, data\''
        )
        self.assertIn(expected, compact)

    def test_production_health_check_uses_the_production_endpoint_and_environment(self):
        self.assert_health_contract(
            "deploy-dns-worker.yml",
            "https://adless-dns.orbeworks.workers.dev",
            "production",
        )

    def test_development_health_check_uses_the_development_endpoint_and_environment(self):
        self.assert_health_contract(
            "deploy-dns-worker-development.yml",
            "https://adless-dns-development.orbeworks.workers.dev",
            "development",
        )

    def test_each_workflow_contains_only_its_own_health_endpoint(self):
        production = (WORKFLOWS / "deploy-dns-worker.yml").read_text(encoding="utf-8")
        development = (WORKFLOWS / "deploy-dns-worker-development.yml").read_text(encoding="utf-8")
        self.assertNotIn("adless-dns-development", production)
        self.assertNotIn('"environment": "development"', production)
        self.assertNotIn("https://adless-dns.orbeworks.workers.dev/healthz", development)
        self.assertNotIn('"environment": "production"', development)


if __name__ == "__main__":
    unittest.main()
