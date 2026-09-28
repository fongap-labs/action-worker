"""Pytest config + sys.path setup."""

from kit_target import target_root
import sys
from pathlib import Path

REPO_ROOT = target_root()
sys.path.insert(0, str(REPO_ROOT))