"""Trusted Delta Code naming contract with a single current plugin identity."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from kit_target import target_root


CODE_ROOT = target_root() / "packages" / "plugin" / "delta-code"


def _migrated_root() -> Path:
    root = CODE_ROOT
    if not root.is_dir():
        pytest.skip("Delta Code plugin workspace has not been introduced")
    if not (root / "src" / "delta-code-repository" / "worktree-storage.ts").is_file():
        pytest.skip("Delta Code internal naming migration is not yet adopted")
    return root


def test_current_plugin_identity_without_legacy_compatibility() -> None:
    root = _migrated_root()
    manifest = json.loads((root / "package.json").read_text(encoding="utf-8"))
    assert manifest["name"] == "@fongap-labs/delta-code"

    patch = (root / "cordis.patch.yml").read_text(encoding="utf-8")
    assert "- id: delta-code\n" in patch
    assert "name: '@fongap-labs/delta-code'" in patch

    client = (root / "src" / "client.ts").read_text(encoding="utf-8")
    assert "ctx.configForms.get('delta-code')" in client
    assert "DELTA_CODE_GITHUB_" in client
    assert "DSH_DELTA_CODE_GITHUB_" not in client

    storage = (
        root / "src" / "delta-code-repository" / "worktree-storage.ts"
    ).read_text(encoding="utf-8")
    assert "WORKTREE_STORAGE_DIR = '.delta-code'" in storage
    assert "LEGACY_WORKTREE_STORAGE_DIR" not in storage

    # No old-plugin aliases, old path fallback or legacy runtime identifiers.
    for source in (root / "src").rglob("*.ts"):
        text = source.read_text(encoding="utf-8")
        assert "dsh-delta-code" not in text, str(source)
        assert "DSH_DELTA_CODE" not in text, str(source)
        assert "LEGACY_WORKTREE_STORAGE_DIR" not in text, str(source)

    workspace = (
        root / "src" / "delta-code-adapter" / "providers" / "dsh" / "workspace.ts"
    ).read_text(encoding="utf-8")
    assert "isInternalWorktreePath(path)" in workspace

    worktree = (
        root / "src" / "delta-code-adapter" / "providers" / "dsh" / "worktree.ts"
    ).read_text(encoding="utf-8")
    assert "LEGACY_WORKTREE_STORAGE_DIR" not in worktree
    assert "const storage = WORKTREE_STORAGE_DIR + '/worktrees'" in worktree
    assert "const dir = join(canonicalRoot, WORKTREE_STORAGE_DIR, 'worktrees')" in worktree
    assert "registeredTaskWorktree" in worktree
    assert "hasCompleteGitEvidence" in worktree
    assert "managed worktree has uncommitted changes" in worktree


def test_only_current_private_directory_is_recognized() -> None:
    root = _migrated_root()
    script = """
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const url = pathToFileURL(join(process.argv[1], 'src', 'delta-code-repository', 'worktree-storage.ts')).href;
const storage = await import(url);
assert.equal(storage.WORKTREE_STORAGE_DIR, '.delta-code');
assert.equal(storage.isInternalWorktreePath('.delta-code/worktrees/item'), true);
assert.equal(storage.isInternalWorktreePath('.dsh-delta-code/worktrees/item'), false);
assert.equal(storage.isInternalWorktreePath('src/index.ts'), false);
assert.equal(storage.isInternalWorktreePath('.delta-code-other/file'), false);
"""
    run = subprocess.run(
        ["node", "--experimental-strip-types", "--input-type=module", "-e", script, str(root)],
        cwd=target_root(),
        capture_output=True,
        text=True,
        timeout=45,
        check=False,
    )
    assert run.returncode == 0, (
        f"Delta Code naming contract failed: stdout={run.stdout[-1000:]} stderr={run.stderr[-2000:]}"
    )
