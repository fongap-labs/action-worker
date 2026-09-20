#!/usr/bin/env python3
from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "validate-source-naming.py"


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

    (repo / "app.py").write_text("def load_data(is_enabled: bool):\n    can_run = True\n    return is_enabled and can_run\n", encoding="utf-8")
    (repo / "worker.rs").write_text("fn run_task(is_enabled: bool) {\n    let can_run = true;\n}\n", encoding="utf-8")
    (repo / "panel.ts").write_text("function openPanel(isEnabled: boolean) {\n  const canRender = true;\n}\n", encoding="utf-8")
    base = commit(repo, "base")

    (repo / "app.py").write_text("def load_data_for_current_repository(is_enabled: bool):\n    can_run = False\n    return is_enabled and can_run\n", encoding="utf-8")
    (repo / "worker.rs").write_text("fn run_repository_control_task(is_enabled: bool) {\n    let can_run = false;\n}\n", encoding="utf-8")
    (repo / "panel.ts").write_text("function openRepositoryControlPanel(isFeatureEnabled: boolean) {\n  const canRender = false;\n}\n", encoding="utf-8")
    valid = commit(repo, "valid long identifiers")
    result = run(repo, base, valid)
    assert result.returncode == 0, result.stderr

    (repo / "bad_name.py").write_text("def build_final_helper(enabled: bool):\n    ready = True\n    return enabled and ready\n", encoding="utf-8")
    invalid_py = commit(repo, "invalid python")
    result = run(repo, valid, invalid_py)
    assert result.returncode != 0
    assert "banned naming term" in result.stderr
    assert "boolean parameter 'enabled'" in result.stderr
    assert "boolean variable 'ready'" in result.stderr

    (repo / "bad_name.py").unlink()
    (repo / "worker.rs").write_text("fn run_repository_control_task(enabled: bool) {\n    let ready = true;\n}\n", encoding="utf-8")
    invalid_rust = commit(repo, "invalid rust")
    result = run(repo, invalid_py, invalid_rust)
    assert result.returncode != 0
    assert "boolean Rust parameter 'enabled'" in result.stderr
    assert "boolean Rust variable 'ready'" in result.stderr

    (repo / "worker.rs").write_text("fn run_task(is_enabled: bool) {\n    let can_run = true;\n}\n", encoding="utf-8")
    (repo / "panel.ts").write_text("function openRepositoryControlPanel(enabled: boolean) {\n  const ready = true;\n}\n", encoding="utf-8")
    invalid_ts = commit(repo, "invalid typescript")
    result = run(repo, invalid_rust, invalid_ts)
    assert result.returncode != 0
    assert "boolean TypeScript parameter 'enabled'" in result.stderr
    assert "boolean TypeScript variable 'ready'" in result.stderr

print("source naming tests passed")
