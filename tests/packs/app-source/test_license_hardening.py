"""Hardening of the license service (audit APP-004, APP-005, APP-006): audit volume, rate-limit identity, code pepper file,
request size and Content-Security-Policy."""

from __future__ import annotations

import re
import time
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

import app as license_app
import codes
import db
import settings

ADMIN = {"Authorization": "Bearer test-admin-token"}
VICTIM = "SP-AAAA-BBBB-CCCC"


@pytest.fixture(autouse=True)
def clean_state(monkeypatch):
    license_app._rate_limit_store.clear()
    license_app._signer_cache.clear()
    conn = db.get_db()
    try:
        for table in ("audit_logs", "bindings", "redeem_codes"):
            conn.execute(f"DELETE FROM {table}")
        conn.commit()
    finally:
        conn.close()
    # The IP limit is not what these tests are about.
    monkeypatch.setattr(settings, "RATE_LIMIT_IP_PER_MIN", 10_000)
    yield


@pytest.fixture(scope="module", autouse=True)
def signing_key():
    key = ec.generate_private_key(ec.SECP256R1())
    Path(settings.PRIVATE_KEY_PATH).write_bytes(
        key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    )


@pytest.fixture()
def client():
    return license_app.app.test_client()


def make_code(client) -> str:
    response = client.post("/admin/api/codes", json={}, headers=ADMIN)
    assert response.status_code == 201
    return response.get_json()["code"]


def redeem(client, code, instance=VICTIM, ip="203.0.113.7"):
    return client.post("/api/redeem", json={"code": code, "instance_id": instance}, headers={"X-Forwarded-For": ip})


def wrong_code(i: int) -> str:
    return codes.generate_code()


def events(kind=None):
    rows = [dict(r) for r in db.list_logs(5000)]
    return [r for r in rows if kind is None or r["event_type"] == kind]


# --- APP-004: audit volume --------------------------------------------------


def test_failed_requests_from_one_address_are_audited_up_to_a_limit(client, monkeypatch):
    monkeypatch.setattr(settings, "AUDIT_PER_IP_PER_MIN", 5)
    for _ in range(40):
        assert redeem(client, "SP-AAAA-AAAA-AAAA", instance="not-an-id").status_code == 400
    assert len(events("invalid_instance")) == 5
    assert events("audit_suppressed") == []  # the summary is written with the next row that gets through


def test_the_surplus_is_summarised_in_one_row_written_together_with_the_next_event(client, monkeypatch):
    monkeypatch.setattr(settings, "AUDIT_PER_IP_PER_MIN", 5)
    for _ in range(25):
        redeem(client, "SP-AAAA-AAAA-AAAA", instance="not-an-id")
    # The one-minute window passes.
    license_app._rate_limit_store.pop("audit:203.0.113.7", None)

    writes = []
    original = db.audit_log_many
    monkeypatch.setattr(db, "audit_log_many", lambda rows: (writes.append(len(rows)), original(rows))[1])
    redeem(client, "SP-AAAA-AAAA-AAAA", instance="not-an-id")

    assert writes == [2], "the summary and the new event share one write"
    summary = events("audit_suppressed")
    assert len(summary) == 1
    assert summary[0]["ip_address"] == "203.0.113.7"
    assert "20 further events" in summary[0]["detail"]


def test_one_noisy_address_does_not_use_up_another_addresss_audit_budget(client, monkeypatch):
    monkeypatch.setattr(settings, "AUDIT_PER_IP_PER_MIN", 3)
    for _ in range(20):
        redeem(client, "SP-AAAA-AAAA-AAAA", instance="bad", ip="203.0.113.50")
    redeem(client, "SP-AAAA-AAAA-AAAA", instance="bad", ip="203.0.113.51")
    assert len([e for e in events("invalid_instance") if e["ip_address"] == "203.0.113.51"]) == 1


def test_a_request_makes_at_most_one_audit_write(client, monkeypatch):
    writes = []
    original = db.audit_log_many
    monkeypatch.setattr(db, "audit_log_many", lambda rows: (writes.append(len(rows)), original(rows))[1])
    code = make_code(client)
    writes.clear()
    assert redeem(client, code).status_code == 200
    assert redeem(client, wrong_code(0), instance="SP-1111-2222-3333").status_code == 404
    assert writes == [1, 1]


def test_successes_and_operator_actions_are_never_throttled(client, monkeypatch):
    monkeypatch.setattr(settings, "AUDIT_PER_IP_PER_MIN", 1)
    for _ in range(3):
        make_code(client)
    for _ in range(30):
        redeem(client, "SP-AAAA-AAAA-AAAA", instance="bad")
    assert len(events("code_created")) == 3
    code = make_code(client)
    assert redeem(client, code).status_code == 200
    assert len(events("redeem_success")) == 1


def test_old_audit_rows_are_purged_and_recent_ones_kept(client):
    db.audit_log("old_probe")
    db.audit_log("recent_probe")
    conn = db.get_db()
    try:
        conn.execute(
            "UPDATE audit_logs SET timestamp = ? WHERE event_type = 'old_probe'", (int(time.time()) - 91 * 86400,)
        )
        conn.commit()
    finally:
        conn.close()
    assert db.purge_audit_logs(90) == 1
    kinds = [e["event_type"] for e in events()]
    assert "recent_probe" in kinds and "old_probe" not in kinds
    assert db.purge_audit_logs(90) == 0


def test_the_retention_period_is_configurable_and_bounded():
    assert settings.AUDIT_RETENTION_DAYS == 90
    assert settings.AUDIT_PER_IP_PER_MIN == 20


# --- APP-004: request size --------------------------------------------------


def test_an_oversized_request_is_refused_without_an_audit_row(client):
    big = {"code": "x" * 1_000_000, "instance_id": VICTIM}
    response = client.post("/api/redeem", json=big)
    assert response.status_code == 413
    assert response.get_json() == {"error": "request too large"}
    assert events() == []
    assert client.post("/admin/api/codes", json={"note": "x" * 100_000}, headers=ADMIN).status_code == 413


def test_a_normal_request_is_not_affected_by_the_size_limit(client):
    assert settings.MAX_REQUEST_BYTES == 4096
    assert redeem(client, make_code(client)).status_code == 200


# --- APP-005: a stranger cannot spend the owner's attempts ------------------


def test_failures_from_another_address_do_not_block_the_owner(client, monkeypatch):
    monkeypatch.setattr(settings, "RATE_LIMIT_INSTANCE_PER_HOUR", 3)
    for i in range(3):
        assert redeem(client, wrong_code(i), ip="198.51.100.9").status_code == 404
    assert redeem(client, wrong_code(9), ip="198.51.100.9").status_code == 429  # the stranger is limited
    owner_code = make_code(client)
    assert redeem(client, owner_code, ip="203.0.113.7").status_code == 200  # the owner is not


def test_a_success_clears_the_failures_for_that_address_and_id(client, monkeypatch):
    monkeypatch.setattr(settings, "RATE_LIMIT_INSTANCE_PER_HOUR", 3)
    code = make_code(client)
    for i in range(2):
        assert redeem(client, wrong_code(i)).status_code == 404
    assert redeem(client, code).status_code == 200
    for i in range(3):
        assert redeem(client, wrong_code(i)).status_code == 404
    assert redeem(client, wrong_code(9)).status_code == 429


def test_malformed_requests_do_not_count_against_an_id(client, monkeypatch):
    monkeypatch.setattr(settings, "RATE_LIMIT_INSTANCE_PER_HOUR", 2)
    for _ in range(10):
        assert redeem(client, "not-a-code").status_code == 400
    assert redeem(client, make_code(client)).status_code == 200


def test_the_id_is_case_insensitive_for_the_limit(client, monkeypatch):
    monkeypatch.setattr(settings, "RATE_LIMIT_INSTANCE_PER_HOUR", 2)
    assert redeem(client, wrong_code(0), instance="SP-aaaa-bbbb-cccc").status_code == 404
    assert redeem(client, wrong_code(1), instance="SP-AAAA-BBBB-CCCC").status_code == 404
    assert redeem(client, wrong_code(2), instance="sp-aaaa-bbbb-cccc").status_code == 429


# --- APP-005: pepper from a file --------------------------------------------


def test_the_pepper_is_read_from_the_pepper_file(tmp_path, monkeypatch, capsys):
    secret = "p" * 40
    path = tmp_path / "code-pepper"
    path.write_text(secret + "\n", encoding="utf-8")
    monkeypatch.delenv("SECUREPIGEON_CODE_PEPPER", raising=False)
    monkeypatch.setenv("SECUREPIGEON_CODE_PEPPER_FILE", str(path))
    assert settings._load_code_pepper() == secret
    captured = capsys.readouterr()
    assert secret not in captured.out + captured.err


def test_the_environment_pepper_wins_over_the_file(tmp_path, monkeypatch):
    path = tmp_path / "code-pepper"
    path.write_text("from-file-" + "f" * 30, encoding="utf-8")
    monkeypatch.setenv("SECUREPIGEON_CODE_PEPPER", "from-env-" + "e" * 30)
    monkeypatch.setenv("SECUREPIGEON_CODE_PEPPER_FILE", str(path))
    assert settings._load_code_pepper().startswith("from-env-")


def test_a_missing_pepper_file_keeps_the_service_running_with_a_warning(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("SECUREPIGEON_CODE_PEPPER", raising=False)
    monkeypatch.setenv("SECUREPIGEON_CODE_PEPPER_FILE", str(tmp_path / "absent"))
    assert settings._load_code_pepper() == ""
    assert "no code pepper" in capsys.readouterr().err


def test_a_short_pepper_is_flagged_but_used(tmp_path, monkeypatch, capsys):
    path = tmp_path / "code-pepper"
    path.write_text("short", encoding="utf-8")
    monkeypatch.delenv("SECUREPIGEON_CODE_PEPPER", raising=False)
    monkeypatch.setenv("SECUREPIGEON_CODE_PEPPER_FILE", str(path))
    assert settings._load_code_pepper() == "short"
    err = capsys.readouterr().err
    assert "shorter than 32" in err and "short\n" not in err.replace("shorter", "")


def test_a_peppered_code_hash_differs_from_the_plain_hash_and_legacy_rows_still_work(client, monkeypatch):
    code = make_code(client)  # stored without a pepper (plain SHA-256)
    monkeypatch.setattr(settings, "CODE_PEPPER", "q" * 40)
    assert codes.hash_code(code) != codes.legacy_hash_code(code)
    assert redeem(client, code).status_code == 200  # found through the legacy hash and re-hashed
    assert db.find_code(codes.hash_code(code)) is not None
    assert db.find_code(codes.legacy_hash_code(code)) is None


# --- APP-006: Content-Security-Policy ---------------------------------------


@pytest.mark.parametrize("path", ["/", "/admin"])
def test_html_pages_carry_a_nonce_policy_without_unsafe_inline(client, path):
    response = client.get(path)
    policy = response.headers["Content-Security-Policy"]
    nonce = re.search(r"script-src 'nonce-([^']+)'", policy).group(1)
    assert "unsafe-inline" not in policy and "unsafe-eval" not in policy
    assert "default-src 'none'" in policy and "frame-ancestors 'none'" in policy and "base-uri 'none'" in policy
    body = response.get_data(as_text=True)
    assert f'<script nonce="{nonce}">' in body
    assert f'<style nonce="{nonce}">' in body
    assert f"style-src 'nonce-{nonce}'" in policy


def test_every_inline_script_and_style_has_the_nonce_and_no_inline_handlers(client):
    for path in ("/", "/admin"):
        body = client.get(path).get_data(as_text=True)
        assert not re.search(r"<script(?![^>]*nonce=)", body), path
        assert not re.search(r"<style(?![^>]*nonce=)", body), path
        assert not re.search(r"\son[a-z]+\s*=", body), f"inline event handler in {path}"
        assert 'style="' not in body


def test_the_nonce_changes_on_every_response(client):
    first = client.get("/").headers["Content-Security-Policy"]
    second = client.get("/").headers["Content-Security-Policy"]
    assert first != second


def test_api_responses_get_a_deny_all_policy(client):
    assert client.get("/health").headers["Content-Security-Policy"] == "default-src 'none'; frame-ancestors 'none'"
    assert client.get("/admin/api/codes", headers=ADMIN).headers["Content-Security-Policy"].startswith("default-src 'none'")


def test_admin_buttons_are_wired_without_inline_handlers(client):
    body = client.get("/admin").get_data(as_text=True)
    for button in ("saveTokenBtn", "createCodeBtn", "loadCodesBtn", "loadLogsBtn"):
        assert f'id="{button}"' in body
        assert f"getElementById('{button}').addEventListener('click'" in body
