"""Run Delta capability regression tests against the pinned source checkout."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

from kit_target import target_root


PACK_ROOT = Path(__file__).resolve().parent


def test_delta_capability_contract() -> None:
    target = target_root()
    environment = os.environ.copy()
    environment["CENTRAL_TEST_TARGET_ROOT"] = str(target)
    tests = sorted(PACK_ROOT.glob("*-test.mjs"))
    result = subprocess.run(
        ["node", "--experimental-strip-types", "--test", *(str(path) for path in tests)],
        cwd=target,
        env=environment,
        check=False,
        text=True,
        capture_output=True,
    )
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
