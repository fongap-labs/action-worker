"""Server Edge deploy and configuration hardening (audit IV-004, IV-005).

These tests run shell code from a temporary directory only: no host is contacted and no deployment
runs. They need `bash`, which the Linux CI runner and Git for Windows both provide.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest
from kit_target import target_root

REPO_ROOT = target_root()
SERVICE = REPO_ROOT / "services" / "server-edge"
DEPLOY = REPO_ROOT / "environments" / "server-edge" / "deploy.sh"

pytestmark = pytest.mark.skipif(shutil.which("bash") is None, reason="needs bash")


def sh(script: str, *, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", "-c", script],
        capture_output=True,
        text=True,
        cwd=cwd,
        check=False,
    )


def posix(path: Path) -> str:
    return path.as_posix()


def load(path: Path, *names: str) -> subprocess.CompletedProcess[str]:
    """Load `path` with load_env_file in a fresh shell and print the named variables."""
    prints = "".join(f'printf "%s=%s\\n" {name} "${{{name}-<unset>}}"; ' for name in names)
    return sh(
        f'source "{posix(SERVICE)}/install/lib/common.sh"; '
        f'load_env_file "{posix(path)}" && {{ {prints}}}'
    )


# --- strict env loader (IV-005) ------------------------------------------------------------------


def test_a_plain_env_file_loads(tmp_path):
    env = tmp_path / "ok.env"
    env.write_bytes(b"# comment\r\n\r\nGOOD=a/b:c@d.e,f+g-h\r\nEMPTY=\r\n")
    result = load(env, "GOOD", "EMPTY")
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == ["GOOD=a/b:c@d.e,f+g-h", "EMPTY="]


@pytest.mark.parametrize(
    "line",
    [
        "A=$(touch {marker})",
        "A=`touch {marker}`",
        "A=1; touch {marker}",
        "A=1 && touch {marker}",
        "A=1 | touch {marker}",
        'A="quoted"',
        "A=two words",
        "A=a=b",
        "lower=1",
        "1A=1",
        "A B=1",
        "just text",
    ],
)
def test_anything_that_could_run_or_surprise_is_rejected_and_nothing_runs(tmp_path, line):
    marker = tmp_path / "pwned"
    env = tmp_path / "bad.env"
    env.write_text(line.format(marker=posix(marker)) + "\n", encoding="utf-8")
    result = load(env, "A")
    assert result.returncode != 0
    assert "invalid line 1" in result.stderr
    assert not marker.exists()


def test_a_missing_file_is_an_error(tmp_path):
    result = load(tmp_path / "missing.env", "A")
    assert result.returncode != 0
    assert "cannot read env file" in result.stderr


@pytest.mark.parametrize("module", ["infra", "proxy-hub", "public-edge"])
def test_every_release_defaults_file_loads_to_the_same_values_as_source(module):
    defaults = SERVICE / module / "config" / "defaults.env"
    names = sorted(
        {
            line.split("=", 1)[0]
            for line in defaults.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.startswith("#")
        }
    )
    assert names, "the defaults file defines variables"
    dump = "".join(f'printf "%s=%s\\n" {name} "${{{name}-<unset>}}"; ' for name in names)
    sourced = sh(f'source "{posix(defaults)}"; {dump}')
    loaded = load(defaults, *names)
    assert sourced.returncode == 0 and loaded.returncode == 0, (sourced.stderr, loaded.stderr)
    assert loaded.stdout == sourced.stdout


def test_the_settings_loaders_use_the_strict_loader_not_source():
    for relative in (
        "infra/scripts/load-settings.sh",
        "proxy-hub/scripts/load-settings.sh",
        "public-edge/scripts/load-settings.sh",
    ):
        text = (SERVICE / relative).read_text(encoding="utf-8")
        assert "load_env_file" in text, relative
        assert 'source "$defaults' not in text and 'source "$settings' not in text, relative
        assert 'source "$instance' not in text, relative
    configure = (SERVICE / "install" / "configure.sh").read_text(encoding="utf-8")
    assert "load_env_file" in configure and 'bash -n "$path"' not in configure


# --- backup retention (IV-004 c) -------------------------------------------------------------------


def make_backups(root: Path, count: int) -> list[Path]:
    made = []
    for index in range(count):
        directory = root / f"2026100{index + 1}T000000Z-{1000 + index}"
        (directory / "secrets" / "proxy-hub").mkdir(parents=True)
        (directory / "secrets" / "proxy-hub" / "controller-secret").write_text(f"old-{index}", encoding="utf-8")
        (directory / "restore.manifest").write_text("existing\tsecrets/x\n", encoding="utf-8")
        made.append(directory)
    return made


def prune(root: Path, keep: str = "3") -> subprocess.CompletedProcess[str]:
    return sh(f'source "{posix(SERVICE)}/install/lib/backups.sh"; prune_configure_backups "{posix(root)}" {keep}')


def test_only_the_three_newest_backups_survive_and_the_old_ones_are_gone(tmp_path):
    made = make_backups(tmp_path, 6)
    result = prune(tmp_path)
    assert result.returncode == 0, result.stderr
    assert sorted(path.name for path in tmp_path.iterdir()) == [path.name for path in made[3:]]
    assert not any(path.exists() for path in made[:3])


def test_five_runs_never_leave_more_than_three(tmp_path):
    for run in range(5):
        # configure.sh writes one new backup directory per run that replaces a file
        directory = tmp_path / f"2026101{run}T000000Z-{run}"
        (directory / "secrets").mkdir(parents=True)
        (directory / "secrets" / "key").write_text(f"old-{run}", encoding="utf-8")
        assert prune(tmp_path).returncode == 0
        assert len(list(tmp_path.iterdir())) <= 3
    assert sorted(p.name for p in tmp_path.iterdir()) == [
        "20261012T000000Z-2",
        "20261013T000000Z-3",
        "20261014T000000Z-4",
    ]


def test_fewer_backups_than_the_limit_are_kept_and_a_missing_directory_is_fine(tmp_path):
    made = make_backups(tmp_path, 2)
    assert prune(tmp_path).returncode == 0
    assert all(path.exists() for path in made)
    assert prune(tmp_path / "does-not-exist").returncode == 0


def test_a_non_numeric_limit_is_refused_and_removes_nothing(tmp_path):
    made = make_backups(tmp_path, 4)
    assert prune(tmp_path, "three").returncode != 0
    assert all(path.exists() for path in made)


def test_configure_prunes_after_the_commit():
    text = (SERVICE / "install" / "configure.sh").read_text(encoding="utf-8")
    assert text.index("committed=true") < text.index("prune_configure_backups")


# --- tailscale installer (IV-004 a) ----------------------------------------------------------------


def run_deploy(tmp_path: Path, *, install_sha256: str | None):
    curl_marker = tmp_path / "curl-called"
    run_marker = tmp_path / "installer-ran"
    # A stand-in for curl, exported as a function: it records the call and "downloads" an installer
    # that would leave a marker if it were ever executed.
    curl_function = (
        "curl() { "
        f'echo called > "{posix(curl_marker)}"; '
        'out=""; '
        'while [ "$#" -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done; '
        f"echo 'echo ran > \"{posix(run_marker)}\"' > \"$out\"; "
        "}; export -f curl; "
    )
    hash_line = f'export SERVER_EDGE_TAILSCALE_INSTALL_SHA256="{install_sha256}"; ' if install_sha256 else ""
    result = sh(
        'export PATH="/usr/bin:/bin"; '
        f"{curl_function}"
        "export SERVER_EDGE_TRANSPORT=tailscale DEPLOY_ENVIRONMENT=server-edge-test "
        "DEPLOY_SOURCE_SHA=0123456789abcdef0123456789abcdef01234567 "
        "SERVER_EDGE_TARGET_HOST=edge.example SERVER_EDGE_TARGET_USER=deploy "
        "SERVER_EDGE_CONFIG_BUNDLE='{}' SERVER_EDGE_SECRET_BUNDLE='{}'; "
        f"{hash_line}"
        f'bash "{posix(DEPLOY)}"'
    )
    return result, curl_marker, run_marker


def test_without_a_pinned_hash_the_installer_is_never_downloaded_or_run(tmp_path):
    if shutil.which("tailscale") and shutil.which("tailscale").startswith("/usr"):
        pytest.skip("a system tailscale would bypass the installer branch")
    result, curl_marker, run_marker = run_deploy(tmp_path, install_sha256=None)
    assert result.returncode == 1
    assert "SERVER_EDGE_TAILSCALE_INSTALL_SHA256 is not set" in result.stderr
    assert not curl_marker.exists(), "nothing may be downloaded"
    assert not run_marker.exists()


def test_a_wrong_pinned_hash_stops_before_the_installer_runs(tmp_path):
    result, curl_marker, run_marker = run_deploy(tmp_path, install_sha256="0" * 64)
    assert result.returncode == 1
    assert "does not match SERVER_EDGE_TAILSCALE_INSTALL_SHA256" in result.stderr
    assert curl_marker.exists()
    assert not run_marker.exists(), "an installer with the wrong hash must not run"
