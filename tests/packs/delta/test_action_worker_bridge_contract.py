"""Trusted Delta workflow bridge contract.

The original Harness workflow test covers jobs that Delta no longer ships.
These checks run from Action Worker against the pinned Delta target tree, so
a target PR cannot edit or bypass the contract it is tested against.
"""

from __future__ import annotations

import json

from kit_target import target_root


ROOT = target_root()
WORKFLOWS = ROOT / ".github" / "workflows"


def _source(name: str) -> str:
    return (WORKFLOWS / name).read_text(encoding="utf-8")


def test_only_approved_delta_workflow_bridges_are_present() -> None:
    assert {p.name for p in WORKFLOWS.iterdir() if p.is_file()} == {
        "ci.yml",
        "notify-action-worker.yml",
    }


def test_main_ci_is_dispatch_only_and_never_executes_target_pr_code() -> None:
    source = _source("ci.yml")
    assert "push:\n    branches: [main]" in source
    assert "workflow_dispatch:" in source
    assert "permissions: {}" in source
    assert "github.ref == 'refs/heads/main'" in source
    assert "run-central-ci-ref" in source
    assert "AW_DISPATCH_TOKEN: ${{ secrets.AW_DISPATCH_TOKEN }}" in source
    assert "repos/$GITHUB_REPOSITORY_OWNER/action-worker/dispatches" in source
    assert "actions/checkout@" not in source
    assert "pull_request_target:" not in source
    assert "pull_request:" not in source


def test_pr_notification_dispatches_without_checkout_or_local_review() -> None:
    source = _source("notify-action-worker.yml")
    assert "pull_request_target:" in source
    assert "types: [opened, synchronize, reopened, closed]" in source
    assert "push:\n    branches: [main]" in source
    assert "permissions: {}" in source
    assert "github.actor != 'dependabot[bot]'" in source
    for event in ("run-pr-governance", "cancel-pr-work", "run-intake"):
        assert f'event_type: "{event}"' in source
    assert "AW_DISPATCH_TOKEN: ${{ secrets.AW_DISPATCH_TOKEN }}" in source
    assert "repos/$GITHUB_REPOSITORY_OWNER/action-worker/dispatches" in source
    assert "actions/checkout@" not in source
    assert "pnpm install" not in source


def test_delta_ci_execution_manifest_keeps_one_product_verifier() -> None:
    manifest = json.loads(
        (ROOT / ".github" / "execution-manifest.json").read_text(encoding="utf-8")
    )
    assert manifest["schema_version"] == "1"
    jobs = manifest["operations"]["ci"]["jobs"]
    assert len(jobs) == 1
    job = jobs[0]
    assert job["id"] == "linux"
    assert job["runner_profile"] == "linux-standard"
    assert job["command"] == [
        "node",
        "{target_root}/scripts/delta-verify.mjs",
        "--ci",
    ]
    assert job["capability_requests"] == ["source.read"]
    assert (ROOT / "scripts" / "delta-verify.mjs").is_file()
