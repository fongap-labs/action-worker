"""The license-service tests import its modules (db, app, ...) by bare name.

The service reads its settings from the environment when it is first imported, so
point it at a throw-away data folder (and a known admin token) before any test module loads it.
"""

import os
import sys
import tempfile

from kit_target import target_root

sys.path.insert(0, str(target_root() / "projects" / "SecurePigeon" / "server-edge" / "app-hub" / "license-service"))

_DATA_DIR = tempfile.mkdtemp(prefix="license-service-test-")
os.environ["LICENSE_DATA_DIR"] = _DATA_DIR
os.environ["ADMIN_TOKEN"] = "test-admin-token"
os.environ["PRIVATE_KEY_PATH"] = os.path.join(_DATA_DIR, "test-signing-key.pem")
os.environ["TRUSTED_PROXY_HOPS"] = "1"
os.environ["RATE_LIMIT_IP_PER_MIN"] = "3"
os.environ.pop("CODE_PEPPER", None)
