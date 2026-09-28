"""Merged suite. Sections keep their original order:
  - test_server_edge_environments.py
  - test_server_edge_monorepo.py
"""

from kit_target import target_root
import json
import os
import subprocess
import sys
from pathlib import Path


# ==========================================================================
# from test_server_edge_environments.py
# ==========================================================================

SCRIPT = target_root() / "environments" / "server-edge" / "materialize.py"

def run_materialize(tmp_path: Path, config: dict, secrets: dict) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["EDGE_CONFIG_BUNDLE"] = json.dumps({"schema_version": 1, "files": config})
    env["EDGE_SECRET_BUNDLE"] = json.dumps({"schema_version": 1, "files": secrets})
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--output", str(tmp_path / "instance")],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

def test_materialize_config_and_secrets(tmp_path: Path) -> None:
    result = run_materialize(
        tmp_path,
        {"infra.env": "INFRA_OVERLAY=auto\n", "publications.json": '{"schema_version":1,"services":{}}\n'},
        {"proxy-hub/providers/primary.url": "https://secret.example.invalid/sub\n"},
    )

    assert result.returncode == 0, result.stderr
    root = tmp_path / "instance"
    assert (root / "config" / "infra.env").read_text() == "INFRA_OVERLAY=auto\n"
    secret = root / "secrets" / "proxy-hub" / "providers" / "primary.url"
    assert secret.read_text() == "https://secret.example.invalid/sub\n"
    assert secret.stat().st_mode & 0o777 == 0o600
    assert "https://secret.example.invalid" not in result.stdout
    assert "https://secret.example.invalid" not in result.stderr

def test_rejects_secret_path_traversal(tmp_path: Path) -> None:
    result = run_materialize(tmp_path, {}, {"../escape": "secret"})
    assert result.returncode != 0
    assert not (tmp_path / "escape").exists()

def test_rejects_nested_config_path(tmp_path: Path) -> None:
    result = run_materialize(tmp_path, {"nested/infra.env": "VALUE=1\n"}, {})
    assert result.returncode != 0

# ==========================================================================
# from test_server_edge_monorepo.py
# ==========================================================================

ROOT = target_root()

SERVICE = ROOT / "services" / "server-edge"

DEPLOY = ROOT / "environments" / "server-edge" / "deploy.sh"

ENV_DOC = ROOT / "environments" / "server-edge" / "README.md"

DEPLOYMENT_DOC = SERVICE / "docs" / "DEPLOYMENT.md"

BOOTSTRAP = SERVICE / "install" / "bootstrap.sh"

DEPLOY_MANIFEST = ROOT / ".github" / "deploy.json"

LOCAL_DEPLOY_WORKFLOW = ROOT / ".github" / "workflows" / "server-edge-deploy.yml"

OVERLAY_HEALTH = SERVICE / "infra" / "network" / "overlay" / "healthcheck.sh"

def test_server_edge_source_is_owned_by_internal_vault() -> None:
    assert (SERVICE / "VERSION").is_file()
    assert (SERVICE / "manifests" / "modules.json").is_file()
    assert (SERVICE / "install" / "install.sh").is_file()
    assert (SERVICE / "profiles" / "minimal.json").is_file()

def test_deploy_uses_local_monorepo_source() -> None:
    text = DEPLOY.read_text(encoding="utf-8")
    assert "services/server-edge" in text
    assert "raw.githubusercontent.com/fongap/server-edge" not in text
    assert "--source '$remote_dir/release'" in text
    assert 'git -C "$REPO_ROOT" rev-parse HEAD' in text

def test_bootstrap_does_not_fetch_repository() -> None:
    text = BOOTSTRAP.read_text(encoding="utf-8")
    assert "--source" in text
    assert "api.github.com/repos" not in text
    assert "raw.githubusercontent.com" not in text
    assert "EDGE_SOURCE=internal-vault" in text

def test_deploy_is_source_owned_and_centrally_executed() -> None:
    manifest = json.loads(DEPLOY_MANIFEST.read_text(encoding="utf-8"))
    assert manifest == {
        "schema_version": "1",
        "adapter": "source-script",
        "automatic": False,
        "ignore_docs_only": True,
        "runner_profile": "production-deploy",
        "environment": "server-edge-cloud-edge",
        "entrypoint": "environments/server-edge/deploy.sh",
    }
    assert not LOCAL_DEPLOY_WORKFLOW.exists()

def test_primary_server_edge_identity_is_cloud_edge() -> None:
    text = ENV_DOC.read_text(encoding="utf-8") + DEPLOYMENT_DOC.read_text(encoding="utf-8")
    assert "cloud-edge" in text
    assert "server-edge-cloud-edge" in text
    assert "oracle-main" not in text
    assert "server-edge-oracle-main" not in text

def test_deploy_preflights_release_before_remote_install() -> None:
    text = DEPLOY.read_text(encoding="utf-8")
    assert 'stage "Validating Server Edge release"' in text
    assert 'bash "$SERVICE_DIR/install/validate.sh" --static' in text
    assert 'selected Server Edge profile does not exist' in text

def test_overlay_healthcheck_uses_infra_owned_setting() -> None:
    text = OVERLAY_HEALTH.read_text(encoding="utf-8")
    assert "INFRA_OVERLAY" in text
    assert "EDGE_OVERLAY" not in text
