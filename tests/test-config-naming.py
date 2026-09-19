#!/usr/bin/env python3
from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "validate-config-naming.py"


def run(repo: Path, base: str, head: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["python3", str(SCRIPT), base, head],
        cwd=repo,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def commit(repo: Path, message: str) -> str:
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-qm", message], cwd=repo, check=True)
    return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()


with tempfile.TemporaryDirectory() as tmp:
    repo = Path(tmp)
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo, check=True)

    workflow = repo / ".github" / "workflows"
    workflow.mkdir(parents=True)
    (workflow / "validate-ci.yml").write_text(
        "env:\n  GATEWAY_KEY_AIR: ok\n  GITHUB_REPOSITORY_OWNER_ID: platform\n  GH_TOKEN: tool\n",
        encoding="utf-8",
    )
    base = commit(repo, "base")

    (workflow / "validate-ci.yml").write_text(
        "env:\n  GATEWAY_KEY_AIR: ok\n  GITHUB_REPOSITORY_OWNER_ID: platform\n  GH_TOKEN: tool\n",
        encoding="utf-8",
    )
    valid = commit(repo, "valid")
    result = run(repo, base, valid)
    assert result.returncode == 0, result.stderr

    (workflow / "validate-ci.yml").write_text(
        "env:\n  TOO_LONG_CONFIG_NAME: bad\n  GH_CONTROL_TOKEN: bad\n  ACTION_WORKER_PAT: bad\n",
        encoding="utf-8",
    )
    invalid = commit(repo, "invalid")
    result = run(repo, valid, invalid)
    assert result.returncode != 0
    assert "exceeds three segments" in result.stderr
    assert "must use GITHUB_" in result.stderr
    assert "instead of PAT" in result.stderr

print("configuration naming tests passed")
