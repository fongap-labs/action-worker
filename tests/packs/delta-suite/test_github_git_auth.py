"""The GitHub token reaches git only through a header scoped to the configured GitHub host."""

from __future__ import annotations

import os
import shutil
import subprocess

import pytest

from advanced.connectors.github_auth import git_auth_env


class _Secrets:
    def __init__(self, profile: dict[str, str] | None) -> None:
        self._profile = profile

    def get(self, key: str) -> dict[str, str] | None:
        return self._profile if key == "github:default" else None


def test_header_key_is_scoped_to_the_github_host(monkeypatch):
    monkeypatch.delenv("GITHUB_GIT_URL", raising=False)
    env = git_auth_env(_Secrets({"token": "fake-token"}))
    assert env["GIT_CONFIG_COUNT"] == "1"
    assert env["GIT_CONFIG_KEY_0"] == "http.https://github.com/.extraHeader"
    assert env["GIT_CONFIG_VALUE_0"].startswith("AUTHORIZATION: basic ")

    monkeypatch.setenv("GITHUB_GIT_URL", "https://git.example.internal/")
    assert git_auth_env(_Secrets({"token": "fake-token"}))["GIT_CONFIG_KEY_0"] == (
        "http.https://git.example.internal/.extraHeader"
    )


def test_no_environment_without_a_connected_token():
    assert git_auth_env(_Secrets(None)) == {}
    assert git_auth_env(_Secrets({})) == {}


@pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")
@pytest.mark.parametrize(
    ("url", "is_sent"),
    [
        ("https://github.com/fongap-labs/delta.git", True),
        ("https://evil.example/fongap-labs/delta.git", False),
        ("https://github.com.evil.example/fongap-labs/delta.git", False),
        ("http://github.com/fongap-labs/delta.git", False),
    ],
)
def test_git_sends_the_header_only_to_the_github_host(monkeypatch, url, is_sent):
    monkeypatch.delenv("GITHUB_GIT_URL", raising=False)
    env = {**os.environ, **git_auth_env(_Secrets({"token": "fake-token"}))}
    result = subprocess.run(
        ["git", "config", "--get-urlmatch", "http.extraHeader", url],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert bool(result.stdout.strip()) is is_sent
