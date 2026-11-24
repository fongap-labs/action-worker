"""Trusted Delta workflow bridge contract.

The original Harness workflow test covers jobs that Delta no longer ships.
These checks run from Action Worker against the pinned Delta target tree, so
a target PR cannot edit or bypass the contract it is tested against.
"""

from __future__ import annotations

import json
import re

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


def test_delta_ci_execution_manifest_keeps_trusted_product_verifiers() -> None:
    manifest = json.loads(
        (ROOT / ".github" / "execution-manifest.json").read_text(encoding="utf-8")
    )
    assert manifest["schema_version"] == "1"
    jobs = manifest["operations"]["ci"]["jobs"]
    # The pre-migration baseline has only Linux; the new release route declares both.
    assert [job["id"] for job in jobs] in (["linux"], ["linux", "windows"])
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
    if len(jobs) == 2:
        assert jobs[1] == {
            "id": "windows",
            "runner_profile": "windows-standard",
            "command": ["pwsh", "-File", "{central_root}/tests/packs/delta/windows-desktop-ci.ps1"],
            "timeout_minutes": 90,
            "capability_requests": ["source.read"],
        }


def test_windows_ci_builds_and_relocates_the_actual_portable_layout() -> None:
    source = (ROOT / "tests" / "packs" / "delta" / "windows-desktop-ci.ps1").read_text(
        encoding="utf-8"
    )
    assert "26.13.1" in source
    assert "build-delta-release.ps1" in source
    assert "verify-delta-release.mjs" in source
    assert "App,Data,Other" in source
    assert "portable-checksum-verification" in source
    assert "Other/THIRD_PARTY_NOTICES.md" in source
    assert "App/Delta.exe" in source
    assert "Data/UserData" in source
    assert "Data/Home" in source
    assert "release-archive-extraction" in source
    assert "DELTA_REUSE_ELECTRON_OUTPUT" not in source
    assert "Get-ChildItem -LiteralPath $portableOutput" in source
    assert "relocated-executable-startup" in source


def test_pinned_bubblewrap_archive_requires_verified_digest() -> None:
    script = (ROOT / "scripts" / "prepare-ci-bubblewrap.sh").read_text(
        encoding="utf-8"
    )
    assert re.search(r"(?m)^readonly BUBBLEWRAP_SHA256='[0-9a-f]{64}'$", script)
    assert 'readonly BUBBLEWRAP_URL="https://launchpad.net/ubuntu/+source/bubblewrap/' in script
    assert "/+build/" in script
    assert "/+files/bubblewrap_" in script
    assert not re.search(r"https?://[^/'\"\s]+/ubuntu(?:-ports)?/pool/", script)
    assert 'acquire_verified_archive "$BUBBLEWRAP_URL" "$BUBBLEWRAP_SHA256" "$archive"' in script


def test_archived_agent_notes_are_excluded_from_staged_pairing() -> None:
    source = (ROOT / "lefthook.yml").read_text(encoding="utf-8")
    assert "pre-commit:\n" in source
    assert "pre-merge-commit:\n" in source
    marker = "- name: translation pairing (staged records)"
    blocks = source.split(marker)
    assert len(blocks) == 3
    for block in blocks[1:]:
        pairing = block.split("\n    - name:", maxsplit=1)[0]
        assert "exclude:\n        - '.agents/notes/archived/**'" in pairing
