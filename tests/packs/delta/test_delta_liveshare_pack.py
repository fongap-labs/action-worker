"""Run trusted LiveShare regression tests against the pinned Delta checkout."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

from kit_target import target_root


PACK_ROOT = Path(__file__).resolve().parent


def test_liveshare_relay_contract() -> None:
    target = target_root()
    environment = os.environ.copy()
    environment["CENTRAL_TEST_TARGET_ROOT"] = str(target)
    result = subprocess.run(
        ["node", "--experimental-strip-types", "--test", str(PACK_ROOT / "liveshare-relay-test.mjs")],
        cwd=target,
        env=environment,
        check=False,
        text=True,
        capture_output=True,
    )
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
