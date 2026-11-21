"""Central Windows-only native check for the BrowserBuild portable launcher.

Product PRs cannot modify the centrally owned CI entrypoint. The trusted pack
runs within the existing Windows CI job, without executing a Chromium build.
"""

from __future__ import annotations

import os
import subprocess

import pytest

from kit_target import target_root


@pytest.mark.skipif(os.name != "nt", reason="Native Windows launcher check")
def test_browserbuild_portable_launcher_cargo_check() -> None:
    project = target_root() / "projects" / "BrowserBuild"
    if not project.is_dir():
        pytest.skip("BrowserBuild is not present in this revision")

    manifest = project / "launcher" / "Cargo.toml"
    lockfile = project / "launcher" / "Cargo.lock"
    assert manifest.is_file(), "BrowserBuild launcher Cargo.toml is missing"
    assert lockfile.is_file(), "BrowserBuild launcher Cargo.lock is missing"

    target = "x86_64-pc-windows-msvc"
    installed = subprocess.run(
        ["rustup", "target", "add", target],
        capture_output=True,
        text=True,
        check=False,
        timeout=120,
    )
    assert installed.returncode == 0, (
        f"Could not install the Windows Rust target (exit {installed.returncode})"
    )

    checked = subprocess.run(
        [
            "cargo",
            "check",
            "--locked",
            "--manifest-path",
            str(manifest),
            "--target",
            target,
        ],
        cwd=project / "launcher",
        capture_output=True,
        text=True,
        check=False,
        timeout=180,
    )
    assert checked.returncode == 0, (
        f"BrowserBuild launcher Cargo check failed (exit {checked.returncode})"
    )
