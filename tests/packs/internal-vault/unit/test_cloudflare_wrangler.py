"""Cloudflare deploy bricks run the Wrangler CLI pinned by tools/wrangler/package-lock.json."""

from __future__ import annotations

import ast
import json
import subprocess

import pytest
from kit_target import target_root

REPO_ROOT = target_root()
TOOL_DIR = REPO_ROOT / "tools" / "wrangler"
DEPLOY_BRICKS = ("cfpages_static_deploy.py", "cfworkers_service_deploy.py")


def test_lockfile_pins_wrangler_from_the_public_registry_with_integrity():
    manifest = json.loads((TOOL_DIR / "package.json").read_text(encoding="utf-8"))
    version = manifest["dependencies"]["wrangler"]
    assert version[0].isdigit(), "the manifest pins an exact Wrangler version"

    lock = json.loads((TOOL_DIR / "package-lock.json").read_text(encoding="utf-8"))
    packages = {path: meta for path, meta in lock["packages"].items() if path}
    assert packages["node_modules/wrangler"]["version"] == version
    for path, meta in packages.items():
        assert meta["resolved"].startswith("https://registry.npmjs.org/"), path
        assert meta["integrity"].startswith("sha512-"), path


def test_deploy_bricks_do_not_resolve_packages_at_deploy_time():
    for name in DEPLOY_BRICKS:
        source = (REPO_ROOT / "bricks" / name).read_text(encoding="utf-8")
        tree = ast.parse(source)
        strings = {node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and isinstance(node.value, str)}
        assert "npx" not in strings, name
        assert "wrangler_command" in source, name


def test_wrangler_command_installs_the_locked_tree_without_scripts(monkeypatch, tmp_path):
    from bricks import cloudflare_wrangler_runtime as runtime

    tool_dir = tmp_path / "tools" / "wrangler"
    tool_dir.mkdir(parents=True)
    monkeypatch.setenv("GHOST_VAULT_ROOT", str(tmp_path))
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append((cmd, kwargs["cwd"]))
        entry = tool_dir / "node_modules" / "wrangler" / "bin" / "wrangler.js"
        entry.parent.mkdir(parents=True)
        entry.write_text("", encoding="utf-8")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(runtime.subprocess, "run", fake_run)
    command = runtime.wrangler_command()
    assert calls == [(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], str(tool_dir))]
    assert command == ["node", str(tool_dir / "node_modules" / "wrangler" / "bin" / "wrangler.js")]

    # Already installed: no second install.
    assert runtime.wrangler_command() == command
    assert len(calls) == 1


def test_wrangler_command_fails_closed_when_the_install_fails(monkeypatch, tmp_path):
    from bricks import cloudflare_wrangler_runtime as runtime

    (tmp_path / "tools" / "wrangler").mkdir(parents=True)
    monkeypatch.setenv("GHOST_VAULT_ROOT", str(tmp_path))
    monkeypatch.setattr(
        runtime.subprocess, "run", lambda cmd, **kwargs: subprocess.CompletedProcess(cmd, 1, "", "network down")
    )
    with pytest.raises(RuntimeError, match="Locked Wrangler installation failed"):
        runtime.wrangler_command()


@pytest.mark.parametrize("module", ["bricks.cfpages_static_deploy", "bricks.cfworkers_service_deploy"])
def test_deploy_bricks_refuse_a_task_supplied_wrangler_version(module):
    import importlib

    brick = importlib.import_module(module)
    with pytest.raises(ValueError, match="wrangler_version"):
        brick.execute({"accountid": "a", "writetoken": "t", "wrangler_version": "9.9.9"})
