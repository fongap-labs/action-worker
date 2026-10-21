"""Engine tests: dispatcher run_step, retry, secret redaction."""

from kit_target import target_root
import json
import os
import subprocess
import sys
from pathlib import Path


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


class TestTaskPayloadSource:
    """The Dispatcher must accept the task the way bootstrap.sh supplies it.

    bootstrap.sh renders the task in memory and pipes it into the Dispatcher,
    so a missing path argument means "the payload is on stdin". A Dispatcher
    that only reads sys.argv[1] fails every scheduled task before it runs a
    single step.
    """

    def _run_with_payload(self, payload: str, timeout: int = 30) -> subprocess.CompletedProcess:
        env = {**os.environ, "PYTHONPATH": str(REPO_ROOT)}
        return subprocess.run(
            [sys.executable, str(ENGINE / "dispatcher.py")],
            input=payload,
            capture_output=True, text=True, env=env, timeout=timeout,
        )

    def test_rendered_task_piped_on_stdin(self, tmp_path):
        """The production shape: render_task.py output piped into the Dispatcher."""
        task = _render_task([
            {"id": "s1", "target": "bricks.__test__.dummy_ok", "args": {}},
        ], tmp_path)
        env = {**os.environ, "PYTHONPATH": str(REPO_ROOT)}
        rendered = subprocess.run(
            [sys.executable, str(PREFLIGHT / "render_task.py"), str(task)],
            capture_output=True, text=True, env=env, timeout=30,
        )
        assert rendered.returncode == 0
        proc = self._run_with_payload(rendered.stdout)
        assert proc.returncode == 0
        assert "all tasks completed" in proc.stderr

    def test_task_payload_piped_on_stdin(self, tmp_path):
        task = _render_task([
            {"id": "s1", "target": "bricks.__test__.dummy_ok", "args": {}},
        ], tmp_path)
        proc = self._run_with_payload(task.read_text(encoding="utf-8"))
        assert proc.returncode == 0
        assert "all tasks completed" in proc.stderr

    def test_empty_stdin_rejected(self):
        proc = self._run_with_payload("")
        assert proc.returncode != 0
        assert "empty task payload" in proc.stderr

    def test_malformed_stdin_rejected(self):
        proc = self._run_with_payload("{not json")
        assert proc.returncode != 0
        assert "cannot parse task payload" in proc.stderr

    def test_stdin_payload_must_be_object(self):
        proc = self._run_with_payload("[1, 2]")
        assert proc.returncode != 0
        assert "INVALID_TASK_FILE" in proc.stderr
