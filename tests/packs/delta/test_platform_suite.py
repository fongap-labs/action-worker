"""Merged suite. Sections keep their original order:
  - test_credential_store.py: Behavioral tests for the Delta credential vault.
  - test_sanitize.py: SensitiveDataSanitizer — the one recursive scrubbing policy shared by audit rows,
  - test_url_address_guard.py: `web_fetch` / `browser_read_url` must not reach the machine's own network position.
  - test_release_gates.py: Release-gate scripts (layout restructure closeout): the retired-path gate and the
"""

from __future__ import annotations

from pathlib import Path
from packages.state_dir import default_state_dir
import os
import stat
import subprocess
import sys
import time
import packages.credential_store as vault
from packages.credential_store import CredentialStore
from packages.sanitize import (
    redact_url_credentials,
    sanitize_payload,
    sanitize_value,
)
import socket
import pytest
from integrations.web import guard as guard__url_address_guard
from integrations.web.fetch import build_fetch_tool
from kit_target import target_root
import importlib.util


# ==========================================================================
# from test_state_dir.py
# ==========================================================================

def test_state_dir_prefers_explicit_override(monkeypatch, tmp_path: Path) -> None:
    target = tmp_path / "delta-state"
    monkeypatch.setenv("DELTA_STATE_DIR", str(target))
    assert default_state_dir() == target

def test_state_dir_uses_home_on_non_windows(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.delenv("DELTA_STATE_DIR", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    if __import__("os").name != "nt":
        assert default_state_dir() == tmp_path / ".config" / "delta"

# ==========================================================================
# from test_credential_store.py
# ==========================================================================

def test_round_trip_persistence(tmp_path):
    store = CredentialStore(tmp_path / "secrets.json")
    store.put("slack:default", {"type": "token", "bot_token": "xoxb-123"})
    assert store.get("slack:default") == {"type": "token", "bot_token": "xoxb-123"}
    assert store.get("nonexistent") is None

def test_env_var_substitution(tmp_path, monkeypatch):
    monkeypatch.setenv("MY_TOK", "from-env")
    store = CredentialStore(tmp_path / "secrets.json")
    store.put("slack:default", {"type": "token", "bot_token": "${MY_TOK}"})
    assert store.get("slack:default")["bot_token"] == "from-env"

def test_dotenv_substitution(tmp_path):
    (tmp_path / ".env").write_text('DOCS_TOKEN = "shhh"' + "\n", encoding="utf-8")
    store = CredentialStore(tmp_path / "secrets.json")
    store.put("docs:default", {"headers": {"Authorization": "Bearer ${DOCS_TOKEN}"}})
    assert store.get("docs:default")["headers"]["Authorization"] == "Bearer shhh"

def test_unresolvable_ref_stays_literal(tmp_path):
    store = CredentialStore(tmp_path / "secrets.json")
    store.put("x", {"v": "${NOPE_NOT_SET}"})
    assert store.get("x")["v"] == "${NOPE_NOT_SET}"

def test_status_leaks_no_values(tmp_path):
    store = CredentialStore(tmp_path / "secrets.json")
    store.put(
        "gmail:default",
        {
            "type": "oauth",
            "access": "secret",
            "account_id": "me@x.com",
            "expires": time.time() - 10,
        },
    )
    store.put("slack:default", {"type": "token", "bot_token": "xoxb"})
    rows = {row["profile"]: row for row in store.status()}
    assert rows["gmail:default"]["type"] == "oauth"
    assert rows["gmail:default"]["account"] == "me@x.com"
    assert rows["gmail:default"]["expired"] is True
    assert rows["slack:default"]["expired"] is False
    blob = str(store.status())
    assert "secret" not in blob and "xoxb" not in blob

def test_vault_file_user_restricted(tmp_path):
    """The vault file must be restricted to the current user.
    POSIX: mode 0600; Windows: ACL with inheritance stripped."""
    path = tmp_path / "secrets.json"
    CredentialStore(path).put("x", {"a": 1})
    if sys.platform == "win32":
        out = subprocess.run(
            ["icacls", str(path)], capture_output=True, text=True
        ).stdout
        user = os.environ.get("USERNAME", "")
        assert user and user in out
        assert "NT AUTHORITY\\SYSTEM" not in out
        assert "BUILTIN\\Administrators" not in out
    else:
        assert stat.S_IMODE(os.stat(path).st_mode) == 0o600

def test_delete_returns_existence(tmp_path):
    store = CredentialStore(tmp_path / "secrets.json")
    store.put("x", {"a": 1})
    assert store.delete("x") is True
    assert store.delete("x") is False
    assert store.get("x") is None

def test_degraded_acl_marker_when_verification_fails(tmp_path, monkeypatch):
    """When ACL hardening cannot be verified, saving must still succeed but the
    degraded state must be persisted (marker file) so callers/UI can surface it.

    On a non-Windows runner, icacls does not exist so the apply subprocess.run
    raises OSError and _apply_user_restriction returns False via its except
    branch without reaching the mocked verifier.  Simulate the Windows shell:
    the apply call succeeds (no raise), leaving the mocked _verify_windows_acl
    as the sole verify oracle."""

    def _fake_icacls_apply(args, *a, **kw):
        return subprocess.CompletedProcess(args=args, returncode=0, stdout="", stderr="")

    path = tmp_path / "secrets.json"
    store = CredentialStore(path)
    monkeypatch.setattr(vault, "_ON_WINDOWS", True)
    monkeypatch.setenv("USERNAME", "testuser")
    monkeypatch.setattr(vault.subprocess, "run", _fake_icacls_apply)
    monkeypatch.setattr(vault, "_verify_windows_acl", lambda p: False)
    store.put("x", {"a": 1})
    assert store.get("x") == {"a": 1}
    assert store.acl_unprotected() is True
    # A later verified write clears the degraded flag.
    monkeypatch.setattr(vault, "_verify_windows_acl", lambda p: True)
    store.put("y", {"b": 2})
    assert store.acl_unprotected() is False

def test_corrupt_file_preserved_not_overwritten(tmp_path):
    """A corrupt vault file must be preserved as a .corrupt-<ts> sibling before
    a later save can overwrite it; loading degrades to empty state."""
    path = tmp_path / "secrets.json"
    path.write_text('{"slack": {"bot_token": "xoxb', encoding="utf-8")
    store = CredentialStore(path)
    assert store._load() == {}
    backups = list(tmp_path.glob("secrets.json.corrupt-*"))
    assert len(backups) == 1
    assert backups[0].read_text(encoding="utf-8").startswith('{"slack"')
    store.put("x", {"a": 1})
    assert store.get("x") == {"a": 1}
    assert len(list(tmp_path.glob("secrets.json.corrupt-*"))) == 1

def test_healthy_store_reports_acl_protected(tmp_path):
    """Happy path: a normal write verifies protection and sets no degraded flag."""
    path = tmp_path / "secrets.json"
    store = CredentialStore(path)
    store.put("x", {"a": 1})
    assert store.acl_unprotected() is False

# ==========================================================================
# from test_sanitize.py
# ==========================================================================

def test_secret_keys_redacted_at_any_depth():
    payload = {
        "bot_token": "xoxb-1",
        "nested": {"api_key": "k", "deeper": [{"access_token": "t"}]},
    }
    out = sanitize_payload(payload)
    assert out["bot_token"] == "[redacted]"
    assert out["nested"]["api_key"] == "[redacted]"
    assert out["nested"]["deeper"][0]["access_token"] == "[redacted]"

def test_sensitive_headers_redacted_by_name_wherever_they_sit():
    event = {
        "request": {"headers": {"Authorization": "Bearer abc", "Accept": "text/html"}},
        "response_cookies": {"Set-Cookie": "sid=1"},
    }
    out = sanitize_value(event)
    assert out["request"]["headers"]["Authorization"] == "[redacted]"
    assert out["request"]["headers"]["Accept"] == "text/html"
    assert out["response_cookies"]["Set-Cookie"] == "[redacted]"

def test_url_query_credentials_stripped_in_strings():
    url = "https://example.com/callback?code=abc&access_token=secret&state=xyz"
    assert redact_url_credentials(url) == (
        "https://example.com/callback?code=abc&access_token=[redacted]&state=xyz"
    )
    # Non-http(s) or non-URL strings pass through untouched.
    assert redact_url_credentials("ftp://h/?token=x") == "ftp://h/?token=x"
    assert redact_url_credentials("plain text") == "plain text"

def test_body_keys_redacted_wholesale_but_recursion_continues_elsewhere():
    out = sanitize_payload(
        {
            "body": "<html>anything</html>",
            "result_body": "also hidden",
            "note": "kept",
            "items": ["kept too", {"content": "hidden"}],
        }
    )
    assert out["body"] == "[redacted body]"
    assert out["result_body"] == "[redacted body]"
    assert out["note"] == "kept"
    assert out["items"][0] == "kept too"
    assert out["items"][1]["content"] == "[redacted body]"

# ==========================================================================
# from test_url_address_guard.py
# ==========================================================================

def _resolves_to(monkeypatch, ip: str):
    monkeypatch.setattr(
        guard__url_address_guard.socket, "getaddrinfo",
        lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 80))],
    )

@pytest.mark.parametrize("url,needle", [
    ("http://127.0.0.1:11434/api/tags", "loopback"),
    ("http://localhost:8000/", "loopback"),
    ("http://[::1]:8080/", "loopback"),
    ("http://169.254.169.254/latest/meta-data/", "link-local"),
    ("http://10.0.0.5/admin", "private"),
    ("http://192.168.1.1/", "private"),
    ("http://172.16.4.4/", "private"),
    ("http://0.0.0.0/", "refusing to fetch"),
    ("http://100.64.0.1/", "CGNAT"),
    ("http://100.127.255.254/", "CGNAT"),
])
def test_blocked_literals(url, needle):
    reason = guard__url_address_guard.check_url(url)
    assert reason and needle in reason

def test_cgnat_neighbours_still_allowed(monkeypatch):
    """100.64.0.0/10 is blocked, but the adjacent public 100.63/100.128 space is not."""
    _resolves_to(monkeypatch, "100.63.255.255")
    assert guard__url_address_guard.check_url("http://below.example/") is None
    _resolves_to(monkeypatch, "100.128.0.0")
    assert guard__url_address_guard.check_url("http://above.example/") is None

def test_ipv4_mapped_ipv6_loopback_is_blocked():
    """::ffff:127.0.0.1 must be judged as the v4 address it carries."""
    assert guard__url_address_guard.check_url("http://[::ffff:127.0.0.1]/")

def test_public_literal_is_allowed():
    assert guard__url_address_guard.check_url("https://93.184.216.34/") is None

@pytest.mark.parametrize("url", ["file:///etc/passwd", "ftp://example.com/x",
                                 "gopher://example.com/", "http://"])
def test_non_http_schemes_and_hostless_urls_are_refused(url):
    assert guard__url_address_guard.check_url(url)

def test_hostname_resolving_to_loopback_is_blocked(monkeypatch):
    """`localtest.me` and friends are public names with private answers."""
    _resolves_to(monkeypatch, "127.0.0.1")
    assert "loopback" in guard__url_address_guard.check_url("http://sneaky.example.com/")

def test_hostname_resolving_to_metadata_ip_is_blocked(monkeypatch):
    _resolves_to(monkeypatch, "169.254.169.254")
    assert guard__url_address_guard.check_url("http://metadata.example.com/")

def test_any_private_answer_blocks_a_split_horizon_name(monkeypatch):
    """One public and one private A record must not be a way through."""
    monkeypatch.setattr(
        guard__url_address_guard.socket, "getaddrinfo",
        lambda *a, **k: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 80)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 80)),
        ],
    )
    assert guard__url_address_guard.check_url("http://split.example.com/")

def test_public_hostname_is_allowed(monkeypatch):
    _resolves_to(monkeypatch, "93.184.216.34")
    assert guard__url_address_guard.check_url("https://example.com/docs") is None

def test_unresolvable_host_is_refused_not_fetched(monkeypatch):
    def boom(*a, **k):
        raise socket.gaierror("nodename nor servname provided")
    monkeypatch.setattr(guard__url_address_guard.socket, "getaddrinfo", boom)
    assert "could not resolve" in guard__url_address_guard.check_url("http://nope.invalid/")

class _Resp:
    def __init__(self, status=200, location=None, url="https://example.com/"):
        self.status_code = status
        self.headers = {"location": location} if location else {}
        self.url = _Url(url)
        self.text = "body"

    def raise_for_status(self):
        pass

class _Url(str):
    def join(self, other):
        return other

class _Client:
    """Records what was actually requested, so a blocked hop is provably not fetched."""

    def __init__(self, script):
        self.script = script
        self.requested = []
        self.calls = []

    def get(self, url, headers=None, extensions=None):
        self.requested.append(url)
        self.calls.append({"url": url, "headers": headers or {}, "extensions": extensions or {}})
        return self.script.pop(0)

def test_redirect_into_loopback_is_blocked_before_the_second_request(monkeypatch):
    _resolves_to(monkeypatch, "93.184.216.34")
    client = _Client([_Resp(302, location="http://127.0.0.1:11434/api/tags")])
    with pytest.raises(PermissionError, match="loopback"):
        guard__url_address_guard.get_checked(client, "https://example.com/start")
    assert client.requested == ["https://93.184.216.34/start"], (
        "the redirect target must never be requested"
    )

def test_allowed_redirect_chain_is_followed(monkeypatch):
    _resolves_to(monkeypatch, "93.184.216.34")
    client = _Client([_Resp(302, location="https://example.com/b"), _Resp(200)])
    resp = guard__url_address_guard.get_checked(client, "https://example.com/a")
    assert resp.status_code == 200
    assert client.requested == ["https://93.184.216.34/a", "https://93.184.216.34/b"]

def test_redirect_loop_is_bounded(monkeypatch):
    _resolves_to(monkeypatch, "93.184.216.34")
    client = _Client([_Resp(302, location="https://example.com/loop")] * 50)
    with pytest.raises(RuntimeError, match="too many redirects"):
        guard__url_address_guard.get_checked(client, "https://example.com/loop")

def test_checked_connection_address_returns_the_vetted_public_ip(monkeypatch):
    _resolves_to(monkeypatch, "93.184.216.34")
    assert guard__url_address_guard.checked_connection_address("https://example.com/docs") == "93.184.216.34"

def test_checked_connection_address_never_resolves_the_name_twice(monkeypatch):
    answers = iter(["93.184.216.34", "127.0.0.1"])
    calls = []

    def flipping(*args, **kwargs):
        calls.append((args, kwargs))
        ip = next(answers, "127.0.0.1")
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443))]

    monkeypatch.setattr(guard__url_address_guard.socket, "getaddrinfo", flipping)
    assert guard__url_address_guard.checked_connection_address("https://rebind.example.com/") == "93.184.216.34"
    assert len(calls) == 1

def test_checked_connection_address_rejects_private_targets(monkeypatch):
    _resolves_to(monkeypatch, "127.0.0.1")
    with pytest.raises(PermissionError, match="loopback"):
        guard__url_address_guard.checked_connection_address("https://internal.example/")

def test_checked_connection_address_preserves_public_ip_literals():
    assert guard__url_address_guard.checked_connection_address("https://93.184.216.34/") == "93.184.216.34"

def test_connection_is_pinned_to_the_vetted_address(monkeypatch):
    """The client must be told to connect to the address that was checked, with the
    original name in Host and SNI — never left to resolve the name a second time."""
    _resolves_to(monkeypatch, "93.184.216.34")
    client = _Client([_Resp(200)])
    guard__url_address_guard.get_checked(client, "https://example.com/docs")
    call = client.calls[0]
    assert call["url"] == "https://93.184.216.34/docs"
    assert call["headers"]["Host"] == "example.com"
    assert call["extensions"]["sni_hostname"] == "example.com"

def test_rebinding_after_the_check_cannot_reach_loopback(monkeypatch):
    """A ~0-TTL record that flips to 127.0.0.1 between check and connect must not
    matter: the connection goes to the address that passed the check."""
    answers = iter(["93.184.216.34", "127.0.0.1"])

    def flipping(*a, **k):
        ip = next(answers, "127.0.0.1")
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 80))]

    monkeypatch.setattr(guard__url_address_guard.socket, "getaddrinfo", flipping)
    client = _Client([_Resp(200)])
    guard__url_address_guard.get_checked(client, "http://rebind.example.com/")
    assert client.requested == ["http://93.184.216.34/"], (
        "the second resolution must never influence where the client connects"
    )

def test_pinned_host_header_preserves_an_explicit_port(monkeypatch):
    _resolves_to(monkeypatch, "93.184.216.34")
    client = _Client([_Resp(200)])
    guard__url_address_guard.get_checked(client, "http://example.com:8080/x")
    call = client.calls[0]
    assert call["url"] == "http://93.184.216.34:8080/x"
    assert call["headers"]["Host"] == "example.com:8080"
    assert "sni_hostname" not in call["extensions"], "plain http has no TLS handshake"

def test_ipv6_answers_are_pinned_with_brackets(monkeypatch):
    _resolves_to(monkeypatch, "2606:2800:220:1:248:1893:25c8:1946")
    client = _Client([_Resp(200)])
    guard__url_address_guard.get_checked(client, "https://example.com/")
    assert client.requested == ["https://[2606:2800:220:1:248:1893:25c8:1946]/"]

class _RequestClient:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def request(self, method, url, **kwargs):
        self.calls.append({"method": method, "url": url, **kwargs})
        return self.response

def test_checked_post_is_pinned_and_preserves_connector_credentials(monkeypatch):
    _resolves_to(monkeypatch, "93.184.216.34")
    response = _Resp(200)
    response.extensions = {}
    client = _RequestClient(response)
    guard__url_address_guard.request_checked(
        client,
        "POST",
        "https://git.example.com/api/query",
        headers={"Authorization": "Bearer secret"},
        json={"query": "x"},
    )
    call = client.calls[0]
    assert call["url"] == "https://93.184.216.34/api/query"
    assert call["headers"]["Host"] == "git.example.com"
    assert call["headers"]["Authorization"] == "Bearer secret"
    assert call["extensions"]["sni_hostname"] == "git.example.com"
    assert call["json"] == {"query": "x"}

def test_checked_request_blocks_private_target_before_sending(monkeypatch):
    _resolves_to(monkeypatch, "127.0.0.1")
    client = _RequestClient(_Resp(200))
    with pytest.raises(PermissionError, match="loopback"):
        guard__url_address_guard.request_checked(
            client,
            "GET",
            "https://internal.example/api",
            headers={"Authorization": "Bearer secret"},
        )
    assert client.calls == []

def test_checked_connector_request_rejects_redirect_without_replaying_credentials(monkeypatch):
    _resolves_to(monkeypatch, "93.184.216.34")
    client = _RequestClient(_Resp(302, location="https://other.example/"))
    with pytest.raises(RuntimeError, match="too many redirects"):
        guard__url_address_guard.request_checked(
            client,
            "GET",
            "https://git.example.com/api",
            headers={"Authorization": "Bearer secret"},
            max_redirects=0,
        )
    assert len(client.calls) == 1

def test_literal_address_urls_are_fetched_unchanged():
    client = _Client([_Resp(200)])
    guard__url_address_guard.get_checked(client, "https://93.184.216.34/x")
    call = client.calls[0]
    assert call["url"] == "https://93.184.216.34/x"
    assert "Host" not in call["headers"], "a literal needs no name-based Host override"

def test_logical_url_is_reported_not_the_pinned_address(monkeypatch):
    """Callers show the final URL to the model; it must be the name, not the address."""
    _resolves_to(monkeypatch, "93.184.216.34")
    resp = _Resp(200)
    resp.extensions = {}
    client = _Client([_Resp(302, location="https://example.com/b"), resp])
    out = guard__url_address_guard.get_checked(client, "https://example.com/a")
    assert out.extensions["logical_url"] == "https://example.com/b"

def test_web_fetch_returns_the_refusal_as_a_tool_error(monkeypatch):
    _resolves_to(monkeypatch, "127.0.0.1")
    out = build_fetch_tool()("http://sneaky.example.com/")
    assert "loopback" in out["error"]
    assert "text" not in out

def test_web_fetch_still_rejects_non_http_schemes():
    assert "http" in build_fetch_tool()("file:///etc/passwd")["error"]

def test_browser_contract_rejects_blocked_url_before_provider_execution():
    """Foundation owns the address policy even though Suite owns browser execution."""
    from integrations.connectors.browser_automation import browser_url_refusal

    reason = browser_url_refusal("http://169.254.169.254/latest/meta-data/")
    assert reason and "link-local" in reason

def _refusal(requested, final):
    from integrations.connectors.browser_automation import redirect_refusal

    return redirect_refusal(requested, final)

@pytest.mark.parametrize(
    "landed",
    [
        "http://169.254.169.254/latest/meta-data/",
        "http://192.168.1.1/admin",
        "http://127.0.0.1:8765/v1/health",
        "http://10.0.0.5/internal",
    ],
)
def test_a_public_link_that_lands_somewhere_internal_is_refused(landed):
    assert _refusal("https://short.link/x", landed)

def test_a_redirect_to_another_public_page_is_fine():
    assert _refusal("https://short.link/x", "https://example.com/article") is None

def test_no_redirect_costs_no_second_check():
    assert _refusal("https://example.com/", "https://example.com/") is None

def test_a_missing_final_url_is_not_treated_as_a_violation():
    assert _refusal("https://example.com/", "") is None

def test_the_refusal_names_where_it_landed():
    reason = _refusal("https://short.link/x", "http://169.254.169.254/")
    assert "169.254.169.254" in reason

# ==========================================================================
# from test_architecture_boundary_guard.py
# ==========================================================================

SCRIPT = target_root() / "scripts" / "check_architecture_boundary.py"

SPEC = importlib.util.spec_from_file_location("check_architecture_boundary", SCRIPT)

assert SPEC and SPEC.loader

guard__architecture_boundary_guard = importlib.util.module_from_spec(SPEC)

sys.modules[SPEC.name] = guard__architecture_boundary_guard

SPEC.loader.exec_module(guard__architecture_boundary_guard)

@pytest.fixture()
def repository(tmp_path: Path) -> Path:
    for target in guard__architecture_boundary_guard.SCAN_TARGETS:
        path = tmp_path / target
        if path.suffix:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("[project]\n", encoding="utf-8")
        else:
            path.mkdir(parents=True, exist_ok=True)
    return tmp_path

@pytest.mark.parametrize(
    ("relative_path", "contents", "rule_id"),
    [
        ("services/api.py", "from fastapi import FastAPI\n", "python-web-backend"),
        ("pyproject.toml", '[project]\ndependencies = ["uvicorn==1"]\n', "python-web-dependency"),
        ("packaging/build.ps1", "pyinstaller delta-server\n", "server-packaging"),
        ("apps/desktop/src/transport.ts", 'const url = "ws://127.0.0.1:8765/ws/session";\n', "desktop-legacy-transport"),
        ("core/engine.py", "class TurnEngine:\n    pass\n", "python-turn-authority"),
        ("core/runner.py", "from providers.router import ProviderRouter\n", "python-provider-authority"),
        ("core/runner.py", "import aisuite\n", "aisuite-application-runtime"),
        ("integrations/connectors/gateway.py", "from packages.credential_store import CredentialStore\nstore = CredentialStore()\n", "connector-concrete-secret-store"),
        ("apps/desktop/src/view.tsx", "export const PersonaView = () => null;\n", "persona-platform"),
        ("apps/desktop/src-tauri/src/runtime_ipc.rs", "let _ = ModelAuthority::open(path);\n", "tauri-direct-authority-construction"),
        ("apps/desktop/src-tauri/src/runtime_ipc.rs", "control_plane::list_sessions(path, None);\n", "tauri-direct-control-plane"),
        ("apps/desktop/src-tauri/src/runtime_ipc.rs", "let host = RuntimeHost::new(id, config);\n", "tauri-runtime-authority"),
    ],
)
def test_each_content_rule_is_enforced(
    repository: Path, relative_path: str, contents: str, rule_id: str
) -> None:
    path = repository / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(contents, encoding="utf-8")

    violations, evaluated = guard__architecture_boundary_guard.scan_repository(repository)

    assert rule_id in evaluated
    assert any(rule_id in violation for violation in violations)

@pytest.mark.parametrize("relative_path", tuple(guard__architecture_boundary_guard.STRUCTURAL_BANS))
def test_each_structural_rule_is_enforced(repository: Path, relative_path: str) -> None:
    path = repository / relative_path
    if Path(relative_path).suffix:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("retired", encoding="utf-8")
    else:
        path.mkdir(parents=True, exist_ok=True)
        (path / "retired.py").write_text("retired", encoding="utf-8")

    violations, evaluated = guard__architecture_boundary_guard.scan_repository(repository)

    assert f"path:{relative_path}" in evaluated
    assert any(relative_path in violation for violation in violations)

def test_clean_native_architecture_passes(repository: Path) -> None:
    source = repository / "apps/desktop/src/runtimeTransport.ts"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text('invoke("runtime_run", { modelId: "gpt-5.5" });\n', encoding="utf-8")
    rust = repository / "crates/delta-core/src/runtime.rs"
    rust.parent.mkdir(parents=True, exist_ok=True)
    rust.write_text("pub struct RuntimeHost;\n", encoding="utf-8")

    violations, evaluated = guard__architecture_boundary_guard.scan_repository(repository)

    assert violations == []
    assert {rule.id for rule in guard__architecture_boundary_guard.RULES}.issubset(evaluated)

def test_exemptions_are_narrow_and_documented() -> None:
    known_rules = {rule.id for rule in guard__architecture_boundary_guard.RULES}
    for exemption in guard__architecture_boundary_guard.EXEMPT_FILES.values():
        assert exemption.rules
        assert exemption.rules <= known_rules
        assert len(exemption.reason.strip()) >= 20

# ==========================================================================
# from test_release_gates.py
# ==========================================================================

REPO = target_root()

def _load(name: str):
    spec = importlib.util.spec_from_file_location(
        name, REPO / "scripts" / f"{name}.py"
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module

def test_repo_has_no_deprecated_paths():
    """Integration: the whole tracked tree is clean (the CI layout-check job runs the
    same script; this keeps pytest coverage on it too)."""
    result = subprocess.run(
        [sys.executable, str(REPO / "scripts" / "check_retired_paths.py")],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr

def test_gate_catches_every_retired_shape():
    gate = _load("check_retired_paths")
    # Fixtures are assembled at runtime: the gate scans every tracked file including
    # this one, so a literal retired path here would make the gate flag itself (CI regression). The segments below never appear joined in this file's source.
    stale_tail = "delta-server" + "-version.txt"
    shapes = [
        "packaging/" + stale_tail,
        "packaging\\" + stale_tail,
        "packaging/" + "delta-server" + ".spec",
        "packaging/" + "server" + "_entry.py",
        "packaging/" + "build" + "_portable.ps1",
        "packaging\\" + "build" + "_portable.ps1",
        "packaging/" + "scan" + "_portable_paths.ps1",
    ]
    for stale in shapes:
        violations = gate.violations_for(f"run {stale} now", "fake/file.yml")
        assert len(violations) == 1, (stale, violations)

def test_gate_ignores_current_paths_and_history():
    gate = _load("check_retired_paths")
    canonical = (
        "packaging/server/delta-server-version.txt"
        + " + packaging/portable/build_portable.ps1"
    )
    assert gate.violations_for(canonical, "fake/file.yml") == []
    # History files are exempt at the FILE level in find_violations, not by weakening
    # the patterns: the pattern still matches history content (built at runtime — the
    # gate scans this file too), the exemption is what spares CHANGELOG/UPSTREAM/
    # docs-governance.
    stale = "packaging/" + "delta-server" + "-version.txt"
    assert gate.violations_for(stale, "CHANGELOG.md")
    assert gate._is_exempt(REPO / "CHANGELOG.md")
    assert not gate._is_exempt(REPO / ".github" / "workflows" / "release.yml")

def test_version_sources_are_consistent():
    """The release workflow's prepare gate, run locally: all ten version sources read
    and agree, the version file's filevers/prodvers match, and CHANGELOG carries a
    dated release section."""
    result = subprocess.run(
        [sys.executable, str(REPO / "scripts" / "check_release_versions.py"), "--quiet"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr

def _version_module():
    return _load("check_release_versions")

def test_case1_stable_version_equivalent():
    """Case 1: stable version is equivalent across ecosystems.

    Python: 0.1.0, SemVer: 0.1.0 → dev PASS, release PASS.
    """
    m = _version_module()
    a = m.parse_version_identity("0.1.0")
    b = m.parse_version_identity("0.1.0")
    assert a == b
    assert not a.is_prerelease
    assert str(a) == "0.1.0"

def test_case2_dev_version_cross_ecosystem_equivalent():
    """Case 2: PEP 440 dev and SemVer dev are logically equivalent.

    Python: 0.1.0.dev0, SemVer: 0.1.0-dev.0 → dev PASS, release FAIL.
    """
    m = _version_module()
    pep440 = m.parse_version_identity("0.1.0.dev0")
    semver = m.parse_version_identity("0.1.0-dev.0")
    assert pep440 == semver
    assert pep440.is_prerelease
    assert semver.is_prerelease
    assert pep440.prerelease == "dev"
    assert pep440.prerelease_number == 0

def test_case3_real_version_mismatch_fails():
    """Case 3: different major/minor/patch must not be equal.

    Python: 0.1.0.dev0, Desktop: 0.1.1-dev.0 → FAIL.
    """
    m = _version_module()
    a = m.parse_version_identity("0.1.0.dev0")
    b = m.parse_version_identity("0.1.1-dev.0")
    assert a != b

def test_case4_different_prerelease_numbers_fails():
    """Case 4: same base but different prerelease number must not be equal.

    0.1.0.dev0 vs 0.1.0-dev.1 → FAIL.
    """
    m = _version_module()
    a = m.parse_version_identity("0.1.0.dev0")
    b = m.parse_version_identity("0.1.0-dev.1")
    assert a != b
    assert a.prerelease_number == 0
    assert b.prerelease_number == 1

def test_case5_release_mode_accepts_stable_baseline():
    """Case 5: the current v0.1.0 baseline is release-ready.

    All product version sources are stable 0.1.0 and CHANGELOG carries the
    matching dated baseline section, so the strict release gate must pass.
    """
    result = subprocess.run(
        [sys.executable, str(REPO / "scripts" / "check_release_versions.py"), "--quiet", "--release"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr

def test_release_mode_output_includes_version_and_tag(monkeypatch, tmp_path):
    """When GITHUB_OUTPUT is set, the script appends version= and tag=."""
    import os
    gh_out = tmp_path / "gh_out"
    result = subprocess.run(
        [sys.executable, str(REPO / "scripts" / "check_release_versions.py"), "--quiet"],
        capture_output=True,
        text=True,
        env={**os.environ, "GITHUB_OUTPUT": str(gh_out)},
    )
    assert result.returncode == 0
    content = gh_out.read_text()
    assert "version=" in content
    assert "tag=" in content

def test_portable_zip_structure_if_present():
    """If a portable ZIP has been built locally (releases/Delta-Windows-Portable.zip),
    verify its structure: exactly one top-level Delta/ directory and the required
    portable files. This is a lightweight local check that complements the full
    E2E build + smoke verification in .github/workflows/release.yml (build-portable job).

    Skips if no ZIP exists locally (the full E2E verification only runs in CI)."""
    import zipfile
    import pytest

    zip_path = REPO / "releases" / "Delta-Windows-Portable.zip"
    if not zip_path.exists():
        pytest.skip(
            f"No local portable ZIP at {zip_path}. "
            "Full E2E portable build + smoke verification runs in "
            ".github/workflows/release.yml (build-portable job)."
        )
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
        # Must contain exactly one top-level directory.
        tops = {n.split("/")[0] for n in names if n}
        assert len(tops) == 1, f"expected one top-level dir, got {tops}"
        assert "Delta" in tops, f"top-level dir must be Delta/, got {tops}"
        # Required files per packaging/portable/build_portable.ps1.
        required = [
            "Delta/",
            "Delta/Delta.exe",
            "Delta/App/",
            "Delta/Data/",
        ]
        for req in required:
            assert any(n.startswith(req) for n in names), f"missing required: {req}"
