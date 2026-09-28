"""Locates the repository under test for pack suites (never this repository)."""

from __future__ import annotations

import os
from pathlib import Path


def target_root() -> Path:
    value = os.environ.get("CENTRAL_TEST_TARGET_ROOT", "")
    path = Path(value)
    if not value or not path.is_absolute():
        raise RuntimeError("CENTRAL_TEST_TARGET_ROOT must be an absolute path to the repository under test.")
    return path.resolve()
