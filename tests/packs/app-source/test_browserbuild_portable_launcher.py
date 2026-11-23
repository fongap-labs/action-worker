"""Central Windows-only native check for the BrowserBuild portable launcher.

Product PRs cannot modify the centrally owned CI entrypoint. The trusted pack
runs within the existing Windows CI job, checking and testing the Rust
launcher without executing a Chromium build.
"""

from __future__ import annotations

import json
import os
import re
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

    tested = subprocess.run(
        [
            "cargo",
            "test",
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
        timeout=240,
    )
    assert tested.returncode == 0, (
        f"BrowserBuild launcher native unit tests failed (exit {tested.returncode})\n"
        f"stdout:\n{tested.stdout[-3000:]}\nstderr:\n{tested.stderr[-3000:]}"
    )


@pytest.mark.skipif(os.name != "nt", reason="Native Windows PowerShell syntax check")
def test_browserbuild_release_powershell_syntax() -> None:
    project = target_root() / "projects" / "BrowserBuild"
    # The independent Brave stable release pipeline is introduced in app-source
    # after the legacy full-source-build staging. Never fail existing branches
    # merely because the new official-runtime pin does not yet exist.
    spec_file = project / "upstream" / "official-runtime.json"
    if not spec_file.is_file():
        pytest.skip("Official Brave release pipeline is not present in this revision")

    manifest = json.loads((project / "release.manifest.json").read_text(encoding="utf-8"))
    spec = json.loads(spec_file.read_text(encoding="utf-8"))
    assert manifest["builds"][0]["runner_profile"] == "windows-build"
    assert spec["distribution"] == "official-verified-brave-binary"
    assert re.fullmatch(r"[a-f0-9]{64}", spec["archive_sha256"])
    assert spec["archive_name"] == f"brave-{spec['release_tag']}-win32-x64.zip"
    assert spec["archive_url"] == (
        f"https://github.com/brave/brave-browser/releases/download/"
        f"{spec['release_tag']}/{spec['archive_name']}"
    )

    scripts = sorted((project / "scripts").glob("*.ps1"))
    assert len(scripts) >= 5
    command = (
        "$tokens = $null; $errors = $null; "
        "[System.Management.Automation.Language.Parser]::ParseFile("
        "$env:BROWSERBUILD_PS_SCRIPT, [ref]$tokens, [ref]$errors) | Out-Null; "
        "if ($errors.Count -ne 0) { "
        "$errors | ForEach-Object { Write-Output $_.ToString() }; exit 1 }"
    )
    for script in scripts:
        env = dict(os.environ)
        env["BROWSERBUILD_PS_SCRIPT"] = str(script)
        completed = subprocess.run(
            ["pwsh", "-NoProfile", "-NonInteractive", "-Command", command],
            cwd=project,
            env=env,
            capture_output=True,
            text=True,
            check=False,
            timeout=45,
        )
        assert completed.returncode == 0, (
            f"BrowserBuild PowerShell script is invalid: {script.name}\n"
            f"stdout: {completed.stdout[-3000:]}\n"
            f"stderr: {completed.stderr[-3000:]}"
        )
