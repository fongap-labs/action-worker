"""Trusted read-only migration preflight contract for Delta Code profile identities."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from kit_target import target_root


SCRIPT = target_root() / "scripts" / "delta-code-profile-audit.mjs"


def _script() -> Path:
    if not SCRIPT.is_file():
        pytest.skip("Delta Code profile migration audit has not been adopted")
    return SCRIPT


def _node(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["node", *args],
        cwd=target_root(),
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


def test_profile_audit_detects_legacy_new_and_mixed_without_leaking_config() -> None:
    script = _script()
    node_script = """
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { auditDeltaCodeProfile: audit } = await import(pathToFileURL(process.argv[1]).href);
const legacy = '@fongap-labs/dsh-delta-code';
const current = '@fongap-labs/delta-code';
const secret = 'never-print-this-private-token';
const old = { dependencies: { [legacy]: 'file:old' }, confidential: secret };
const newer = { dependencies: { [current]: 'link:somewhere' } };
assert.equal(audit({}, []).status, 'absent');
assert.equal(audit(old, []).status, 'legacy-only');
assert.equal(audit(newer, []).status, 'current-only');
assert.equal(audit({ ...old, dependencies: { [legacy]: 'old', [current]: 'new' } }, []).status, 'mixed');
assert.equal(audit({ dsh: { profile: { bundles: [legacy, current] } } }, []).status, 'mixed');
const patch = [{ insert: [{ id: 'dsh-delta-code', name: legacy }] }];
assert.equal(audit(newer, patch).status, 'mixed');
const report = audit(old, patch);
assert.equal(report.legacy.inserted, 1);
assert.equal(report.requiresExternalOverlayReview, true);
assert.doesNotMatch(JSON.stringify(report), /never-print-this-private-token/);
assert.throws(() => audit({}, [{ insert: 'not-an-array' }]), TypeError);
assert.throws(() => audit({ dsh: { profile: { bundles: 'not-an-array' } } }, []), TypeError);
"""
    run = _node("--input-type=module", "-e", node_script, str(script))
    assert run.returncode == 0, (
        f"Profile audit classification failed: stdout={run.stdout[-500:]} stderr={run.stderr[-1500:]}"
    )


def test_profile_audit_cli_is_read_only_and_fail_closed(tmp_path: Path) -> None:
    script = _script()
    profile = tmp_path / "profile"
    profile.mkdir()
    manifest = profile / "package.json"
    original = json.dumps(
        {"dependencies": {"@fongap-labs/dsh-delta-code": "1.0.0"}},
        indent=2,
    )
    manifest.write_text(original, encoding="utf-8")

    run = _node(str(script), str(profile))
    assert run.returncode == 1, (run.stdout, run.stderr)
    result = json.loads(run.stdout)
    assert result["status"] == "legacy-only"
    assert result["legacy"]["dependency"] is True
    assert result["scope"] == ["package.json", "cordis.patch.yml"]
    assert manifest.read_text(encoding="utf-8") == original
    assert sorted(path.name for path in profile.iterdir()) == ["package.json"]

    manifest.write_text(
        json.dumps({"dependencies": {"@fongap-labs/delta-code": "0.1.0"}}),
        encoding="utf-8",
    )
    clean = _node(str(script), str(profile))
    assert clean.returncode == 0, (clean.stdout, clean.stderr)
    assert json.loads(clean.stdout)["status"] == "current-only"

    manifest.write_text("not-json", encoding="utf-8")
    invalid = _node(str(script), str(profile))
    assert invalid.returncode == 2
    assert json.loads(invalid.stdout) == {
        "status": "invalid", "reason": "unreadable-profile-manifest",
    }
    assert "not-json" not in invalid.stdout + invalid.stderr


def test_profile_patch_never_executes_dynamic_yaml(tmp_path: Path) -> None:
    script = _script()
    # The profile's own patch is the only YAML examined. This test runs when
    # dependencies have been installed in the Delta checkout.
    profile = tmp_path / "profile"
    profile.mkdir()
    (profile / "package.json").write_text("{}", encoding="utf-8")
    (profile / "cordis.patch.yml").write_text(
        "- insert:\n"
        "    - id: dsh-delta-code\n"
        "      name: '@fongap-labs/dsh-delta-code'\n"
        "      config:\n"
        "        workspaceRoot: !!js 'process.exit(97)'\n",
        encoding="utf-8",
    )
    dependency_check = _node("-e", "require.resolve('js-yaml')")
    if dependency_check.returncode != 0:
        # Some central test stages inspect source before installing pnpm packages.
        pytest.skip("js-yaml is not yet installed in the target checkout")
    run = _node(str(script), str(profile))
    assert run.returncode == 1, (run.stdout, run.stderr)
    report = json.loads(run.stdout)
    assert report["status"] == "legacy-only"
    assert report["legacy"]["inserted"] == 1
    assert "process.exit" not in run.stdout + run.stderr
