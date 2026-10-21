"""Delta's naming gate must still fail on runtime code and stay quiet on test modules.

The gate reported every descriptive test function name in a Rust unit-test module that
lives in its own `tests.rs` file as a production naming violation, which left the gate red
on the whole tree. The exclusion has to keep the gate able to fail, so the cases below
run the real script against a synthetic tree.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from kit_target import target_root

REPO_ROOT = target_root()
SCRIPT = REPO_ROOT / "scripts" / "check_naming.py"

LONG_RUNTIME_FUNCTION = "fn a_function_with_four_name_parts() {}\n"


def _run_gate(tree: Path) -> subprocess.CompletedProcess:
    """Run the real gate over a synthetic tree.

    The script resolves its own root from its location, so a copy of it in the tree is
    what makes the gate look at that tree.
    """
    scripts = tree / "scripts"
    scripts.mkdir(parents=True, exist_ok=True)
    shutil.copy2(SCRIPT, scripts / "check_naming.py")
    return subprocess.run(
        [sys.executable, str(scripts / "check_naming.py")],
        capture_output=True,
        text=True,
        timeout=120,
    )


@pytest.fixture()
def tree(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    (root / "crates" / "example" / "src").mkdir(parents=True)
    return root


def test_a_long_runtime_function_is_reported(tree: Path) -> None:
    (tree / "crates" / "example" / "src" / "lib.rs").write_text(
        LONG_RUNTIME_FUNCTION, encoding="utf-8"
    )
    proc = _run_gate(tree)
    assert proc.returncode != 0
    assert "exceeds three segments" in proc.stdout


def test_a_long_test_module_function_is_allowed(tree: Path) -> None:
    (tree / "crates" / "example" / "src" / "tests.rs").write_text(
        LONG_RUNTIME_FUNCTION, encoding="utf-8"
    )
    proc = _run_gate(tree)
    assert proc.returncode == 0
    assert proc.stdout.strip() == "naming conventions passed"
