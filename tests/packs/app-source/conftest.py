"""The license-service tests import its modules (db, ...) by bare name."""

import sys

from kit_target import target_root

sys.path.insert(0, str(target_root() / "projects" / "SecurePigeon" / "server-edge" / "app-hub" / "license-service"))
