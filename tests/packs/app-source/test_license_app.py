"""HTTP-level tests for the license service: admin auth, rate-limit identity, input handling, signing."""

from __future__ import annotations

import os
import struct
import time
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

import app as license_app
import codes
import db
import settings

ADMIN = {"Authorization": "Bearer test-admin-token"}
INSTANCE = "SP-AAAA-BBBB-CCCC"


@pytest.fixture(autouse=True)
def clean_state():
    license_app._rate_limit_store.clear()
    license_app._signer_cache.clear()
    conn = db.get_db()
    try:
        for table in ("audit_logs", "bindings", "redeem_codes"):
            conn.execute(f"DELETE FROM {table}")
        conn.commit()
    finally:
        conn.close()
    yield


@pytest.fixture(scope="module")
def signing_key() -> ec.EllipticCurvePrivateKey:
    key = ec.generate_private_key(ec.SECP256R1())
    Path(settings.PRIVATE_KEY_PATH).write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    return key


@pytest.fixture()
def client():
    return license_app.app.test_client()


def make_code(client, **body) -> str:
    response = client.post("/admin/api/codes", json=body, headers=ADMIN)
    assert response.status_code == 201, response.get_json()
    return response.get_json()["code"]


def redeem(client, code, instance=INSTANCE, ip="203.0.113.7"):
    return client.post(
        "/api/redeem",
        json={"code": code, "instance_id": instance},
        headers={"X-Forwarded-For": ip},
    )


def parse_license(blob: bytes) -> tuple[bytes, bytes]:
    magic, _version, payload_len, sig_len = struct.unpack("<5sBHH", blob[:10])
    assert magic == b"SPLIC"
    payload = blob[10 : 10 + payload_len]
    return payload, blob[10 + payload_len : 10 + payload_len + sig_len]


# --- admin authentication ---------------------------------------------------


@pytest.mark.parametrize(
    "method,path",
    [
        ("get", "/admin/api/codes"),
        ("post", "/admin/api/codes"),
        ("get", "/admin/api/logs"),
        ("post", "/admin/api/codes/abc/disable"),
        ("get", "/admin/api/codes/abc/bindings"),
        ("delete", "/admin/api/codes/abc/bindings/SP-AAAA-BBBB-CCCC"),
    ],
)
def test_admin_api_rejects_missing_and_wrong_token(client, method, path):
    assert getattr(client, method)(path).status_code == 401
    wrong = {"Authorization": "Bearer nope"}
    assert getattr(client, method)(path, headers=wrong).status_code == 401
    assert getattr(client, method)(path, headers={"Authorization": "test-admin-token"}).status_code == 401


def test_admin_token_in_query_string_is_not_accepted(client):
    assert client.get("/admin/api/codes?token=test-admin-token").status_code == 401


def test_admin_api_accepts_the_token(client):
    assert client.get("/admin/api/codes", headers=ADMIN).status_code == 200


def test_admin_page_is_static_and_uses_no_innerhtml(client):
    response = client.get("/admin")
    assert response.status_code == 200
    text = response.get_data(as_text=True)
    assert "innerHTML" not in text  # audit-log fields are untrusted; the page must use textContent
    assert "Bearer" in text


def test_failed_admin_logins_are_throttled_and_audited(client):
    statuses = [client.get("/admin/api/codes").status_code for _ in range(settings.ADMIN_FAIL_PER_MIN + 2)]
    assert statuses[0] == 401 and statuses[-1] == 429
    events = [row["event_type"] for row in db.list_logs(500)]
    assert "admin_auth_failed" in events


# --- admin input handling ---------------------------------------------------


def test_logs_limit_is_clamped_not_crashing(client):
    for _ in range(5):
        db.audit_log("probe")
    assert client.get("/admin/api/logs?limit=abc", headers=ADMIN).status_code == 200
    assert len(client.get("/admin/api/logs?limit=-5", headers=ADMIN).get_json()) == 1
    assert len(client.get("/admin/api/logs?limit=0", headers=ADMIN).get_json()) == 1
    assert len(client.get("/admin/api/logs?limit=99999", headers=ADMIN).get_json()) <= settings.ADMIN_LOG_MAX
    assert len(client.get("/admin/api/logs?limit=2", headers=ADMIN).get_json()) == 2


@pytest.mark.parametrize(
    "body",
    [{"features": "many"}, {"features": 16}, {"features": -1}, {"product": "other"}, {"edition": "gold"}],
)
def test_create_code_rejects_bad_input(client, body):
    response = client.post("/admin/api/codes", json=body, headers=ADMIN)
    assert response.status_code == 400
    assert "error" in response.get_json()


# --- rate limiting identity -------------------------------------------------


def test_rate_limit_uses_forwarded_client_ip_behind_the_proxy(client):
    # Invalid IDs are rejected with 400 but still count against the caller's IP bucket.
    for _ in range(settings.RATE_LIMIT_IP_PER_MIN):
        assert redeem(client, "SP-AAAA-BBBB-CCCC", instance="bad", ip="198.51.100.1").status_code == 400
    assert redeem(client, "SP-AAAA-BBBB-CCCC", instance="bad", ip="198.51.100.1").status_code == 429
    # A different visitor behind the same proxy is not affected.
    assert redeem(client, "SP-AAAA-BBBB-CCCC", instance="bad", ip="198.51.100.2").status_code == 400


def test_rate_limit_sweep_drops_expired_keys():
    now = time.time()
    license_app._rate_limit_store["ip:old"] = [now - 7200]
    license_app._rate_limit_store["ip:empty"] = []
    license_app._rate_limit_store["ip:fresh"] = [now]
    license_app._rate_limit_calls = license_app._RATE_LIMIT_SWEEP_EVERY - 1
    license_app._rate_limit("ip:trigger", 5, 60)
    assert set(license_app._rate_limit_store) == {"ip:fresh", "ip:trigger"}


# --- untrusted text in the audit log ----------------------------------------


def test_untrusted_instance_id_is_clipped_and_stripped_before_logging(client):
    evil = "<img src=x onerror=alert(1)>\n\x00" + "A" * 500
    assert redeem(client, "SP-AAAA-BBBB-CCCC", instance=evil).status_code == 400
    logged = [r["instance_id"] for r in db.list_logs(50) if r["event_type"] == "invalid_instance"]
    assert logged and len(logged[0]) <= 70
    assert "\n" not in logged[0] and "\x00" not in logged[0]


# --- issuing licenses ---------------------------------------------------------


def test_redeem_signs_a_license_that_verifies_and_uses_the_code_settings(client, signing_key):
    code = make_code(client, features=1)
    response = redeem(client, code)
    assert response.status_code == 200
    payload, signature = parse_license(response.data)
    assert len(payload) == 52
    signing_key.public_key().verify(signature, payload, ec.ECDSA(hashes.SHA256()))
    assert struct.unpack_from("<I", payload, 39)[0] == 1  # features come from the code, not a constant
    assert payload[22] == 1  # edition pro
    assert payload[51] == 1  # key_id
    assert payload[23:29] == bytes.fromhex("AAAABBBBCCCC")


def test_second_instance_cannot_take_a_bound_code(client, signing_key):
    code = make_code(client)
    assert redeem(client, code).status_code == 200
    assert redeem(client, code, instance="SP-DDDD-EEEE-FFFF", ip="203.0.113.9").status_code == 403
    assert redeem(client, code).status_code == 200  # same device may re-download


def test_signing_failure_returns_500_without_leaking_details(client, monkeypatch, tmp_path):
    missing = tmp_path / "no-such-key.pem"
    monkeypatch.setattr(settings, "PRIVATE_KEY_PATH", str(missing))
    code = make_code(client)
    response = redeem(client, code)
    assert response.status_code == 500
    assert str(missing) not in response.get_data(as_text=True)


# --- optional pepper --------------------------------------------------------


def test_pepper_upgrades_legacy_rows_on_first_redeem(client, monkeypatch, signing_key):
    code = make_code(client)  # stored as plain SHA-256 (no pepper configured)
    legacy = codes.legacy_hash_code(code)
    assert db.find_code(legacy) is not None

    monkeypatch.setattr(settings, "CODE_PEPPER", "unit-test-pepper")
    peppered = codes.hash_code(code)
    assert peppered != legacy
    assert redeem(client, code).status_code == 200
    assert db.find_code(peppered) is not None
    assert db.find_code(legacy) is None
    # Codes created after the pepper is on are stored peppered from the start.
    fresh = make_code(client)
    assert db.find_code(codes.hash_code(fresh)) is not None
    assert db.find_code(codes.legacy_hash_code(fresh)) is None


# --- settings ---------------------------------------------------------------


def test_settings_ignore_bad_values(monkeypatch, capsys):
    monkeypatch.setenv("SETTINGS_TEST_VALUE", "abc")
    assert settings._int("SETTINGS_TEST_VALUE", 7) == 7
    monkeypatch.setenv("SETTINGS_TEST_VALUE", "-3")
    assert settings._int("SETTINGS_TEST_VALUE", 7, minimum=1) == 7
    monkeypatch.setenv("SETTINGS_TEST_VALUE", " 12 ")
    assert settings._int("SETTINGS_TEST_VALUE", 7) == 12
    monkeypatch.delenv("SETTINGS_TEST_VALUE")
    assert settings._int("SETTINGS_TEST_VALUE", 7) == 7
    assert "ignoring" in capsys.readouterr().err


def test_admin_token_is_generated_once_and_kept(monkeypatch, tmp_path):
    monkeypatch.delenv("ADMIN_TOKEN", raising=False)
    monkeypatch.setattr(settings, "DATA_DIR", tmp_path)
    first = settings.admin_token()
    assert len(first) >= 32
    assert settings.admin_token() == first
    assert (tmp_path / "admin-token").read_text().strip() == first
    if os.name == "posix":
        assert (tmp_path / "admin-token").stat().st_mode & 0o077 == 0
    monkeypatch.setenv("ADMIN_TOKEN", "from-env")
    assert settings.admin_token() == "from-env"
