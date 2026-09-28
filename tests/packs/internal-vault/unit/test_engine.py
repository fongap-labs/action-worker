"""Engine tests: dispatcher run_step, retry, secret redaction."""

from kit_target import target_root
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = target_root()
FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
ENGINE = REPO_ROOT / "engine"
PREFLIGHT = REPO_ROOT / "preflight"


def _render_task(steps: list, tmp: Path) -> Path:
    p = tmp / "task.json"
    p.write_text(json.dumps({"steps": steps}, indent=2), encoding="utf-8")
    return p


def _run_dispatcher(task_path: Path, env_extra: dict | None = None, timeout: int = 30) -> subprocess.CompletedProcess:
    env = {**os.environ, "PYTHONPATH": str(REPO_ROOT)}
    if env_extra:
        env.update(env_extra)
    return subprocess.run(
        [sys.executable, str(ENGINE / "dispatcher.py"), str(task_path)],
        capture_output=True, text=True, env=env, timeout=timeout,
    )


class TestRunStep:
    def test_successful_step(self, tmp_path):
        task = _render_task([
            {"id": "s1", "target": "bricks.__test__.dummy_ok", "args": {}},
        ], tmp_path)
        proc = _run_dispatcher(task)
        assert proc.returncode == 0

    def test_step_failure_exits_nonzero(self, tmp_path):
        task = _render_task([
            {"id": "s1", "target": "bricks.__test__.dummy_fail", "args": {}},
        ], tmp_path)
        proc = _run_dispatcher(task)
        assert proc.returncode != 0
        assert "RUNTIME_FAILURE" in proc.stderr

    def test_secret_redaction_in_summary(self, tmp_path):
        env = {**os.environ,
               "GHOST_SUMMARY_FILE": str(tmp_path / "summary.json"),
               "PYTHONPATH": str(REPO_ROOT)}
        task = _render_task([
            {"id": "s1", "target": "bricks.__test__.dummy_secret_leak", "args": {}},
        ], tmp_path)
        proc = subprocess.run(
            [sys.executable, str(ENGINE / "dispatcher.py"), str(task)],
            capture_output=True, text=True, env=env, timeout=30,
        )
        summary_file = tmp_path / "summary.json"
        if summary_file.exists():
            text = summary_file.read_text(encoding="utf-8")
            assert "gh" "p_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn" not in text
        stderr_text = proc.stderr or ""
        assert "gh" "p_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn" not in stderr_text

    def test_dependency_skipped_after_failure(self, tmp_path):
        summary_file = tmp_path / "summary.json"
        task = _render_task([
            {"id": "a", "target": "bricks.__test__.dummy_fail", "args": {}},
            {"id": "b", "target": "bricks.__test__.dummy_ok", "args": {}, "depends_on": ["a"]},
        ], tmp_path)
        proc = _run_dispatcher(task, {"GHOST_SUMMARY_FILE": str(summary_file)})
        assert proc.returncode != 0
        assert summary_file.exists()

        summary = json.loads(summary_file.read_text(encoding="utf-8"))
        statuses = {step["step_id"]: step["status"] for step in summary["steps"]}
        assert summary["status"] == "failed"
        assert statuses == {"a": "failed", "b": "skipped"}


class TestTopology:
    def test_dag_cycle_detected(self, tmp_path):
        task = _render_task([
            {"id": "a", "target": "bricks.__test__.dummy_ok", "args": {}, "depends_on": ["b"]},
            {"id": "b", "target": "bricks.__test__.dummy_ok", "args": {}, "depends_on": ["a"]},
        ], tmp_path)
        proc = _run_dispatcher(task)
        assert proc.returncode != 0

    def test_unknown_target(self, tmp_path):
        task = _render_task([
            {"id": "x", "target": "nonexistent.module", "args": {}},
        ], tmp_path)
        proc = _run_dispatcher(task)
        assert proc.returncode != 0
