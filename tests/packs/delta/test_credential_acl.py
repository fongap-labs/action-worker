"""Credential files are created owner-only and their protection is judged by SID (audit DL-002, step 1).

`_dacl_grants_only` compares SIDs read from the saved DACL, so the verdict does not depend on the
language of Windows (the old check looked for the English names `NT AUTHORITY\\SYSTEM`).
"""

from __future__ import annotations

import os
import stat
import sys

import pytest

import packages.credential_store as vault
from packages.credential_store import CredentialStore

USER = "S-1-5-21-1111-2222-3333-1001"


# --- pure SDDL judgement (runs everywhere) -----------------------------------------------------


def test_a_protected_dacl_for_the_user_only_is_accepted():
    assert vault._dacl_grants_only(f"D:PAI(A;;FA;;;{USER})", USER)
    assert vault._dacl_grants_only(f"D:P(A;OICI;FA;;;{USER})", USER.lower())


@pytest.mark.parametrize(
    "sddl",
    [
        f"D:P(A;;FA;;;{USER})(A;;FA;;;SY)",
        f"D:P(A;;FA;;;{USER})(A;;FA;;;BA)",
        f"D:P(A;;FA;;;{USER})(A;;FA;;;WD)",
        f"D:PAI(A;ID;FA;;;{USER})",
        f"D:(A;;FA;;;{USER})",
        "D:P(A;;FA;;;S-1-5-21-9-9-9-500)",
        "D:P",
        "garbage",
        "D:P(A;;FA;;;",
    ],
)
def test_groups_inherited_entries_open_and_foreign_dacls_are_rejected(sddl):
    assert not vault._dacl_grants_only(sddl, USER)


def test_the_local_administrator_alias_counts_only_for_rid_500():
    admin = "S-1-5-21-1111-2222-3333-500"
    assert vault._dacl_grants_only("D:PAI(A;;FA;;;LA)", admin)
    assert not vault._dacl_grants_only("D:PAI(A;;FA;;;LA)", USER)
    assert not vault._dacl_grants_only("D:PAI(A;;FA;;;LA)(A;;FA;;;SY)", admin)


def test_deny_entries_are_not_grants():
    assert vault._dacl_grants_only(f"D:P(D;;FA;;;WD)(A;;FA;;;{USER})", USER)


# --- creation ---------------------------------------------------------------------------------


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX mode bits")
def test_the_file_is_owner_only_from_its_creation_even_with_a_wide_umask(tmp_path):
    previous = os.umask(0)
    try:
        target = tmp_path / "secret.txt"
        vault._create_private_file(target, "x")
        assert stat.S_IMODE(os.stat(target).st_mode) == 0o600
    finally:
        os.umask(previous)


def test_an_existing_file_is_replaced_not_reused(tmp_path):
    target = tmp_path / "secret.txt"
    target.write_text("old")
    vault._create_private_file(target, "new")
    assert target.read_text() == "new"


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX mode bits")
def test_a_stale_temp_file_with_loose_permissions_does_not_survive_a_save(tmp_path):
    path = tmp_path / "secrets.json"
    stale = tmp_path / "secrets.json.tmp"
    stale.write_text("stale")
    os.chmod(stale, 0o666)
    CredentialStore(path).put("x", {"a": 1})
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert not stale.exists()


# --- surfacing failures ------------------------------------------------------------------------


def test_status_rows_carry_the_protection_flag(tmp_path):
    store = CredentialStore(tmp_path / "secrets.json")
    store.put("x", {"type": "token", "bot_token": "xoxb"})
    assert [row["acl_unprotected"] for row in store.status()] == [False]


def test_a_file_that_cannot_be_confirmed_is_reported_and_still_saved(tmp_path, monkeypatch):
    store = CredentialStore(tmp_path / "secrets.json")
    monkeypatch.setattr(vault, "_apply_user_restriction", lambda path, *, is_dir: False)
    store.put("x", {"a": 1})
    assert store.get("x") == {"a": 1}
    assert store.acl_unprotected() is True
    assert store.status()[0]["acl_unprotected"] is True


def test_a_failing_folder_restriction_is_not_swallowed_silently(tmp_path, monkeypatch, caplog):
    calls = []

    def apply(path, *, is_dir):
        calls.append(is_dir)
        if is_dir:
            raise OSError("not supported here")
        return True

    store = CredentialStore(tmp_path / "secrets.json")
    monkeypatch.setattr(vault, "_apply_user_restriction", apply)
    with caplog.at_level("WARNING", logger="packages.credential_store"):
        store.put("x", {"a": 1})
    assert calls == [True, False]
    assert any("could not restrict the credential folder" in record.getMessage() for record in caplog.records)
    assert store.get("x") == {"a": 1}


# --- real Windows ACLs (only where icacls exists) -----------------------------------------------


@pytest.mark.skipif(sys.platform != "win32", reason="needs Windows ACLs")
def test_windows_vault_file_grants_only_the_current_users_sid(tmp_path):
    path = tmp_path / "secrets.json"
    CredentialStore(path).put("x", {"a": 1})
    sid = vault._current_user_sid()
    assert sid, "the current user's SID must be readable"
    assert vault._dacl_grants_only(vault._read_windows_sddl(path), sid)
    assert vault.verify_user_restricted(path) is True


@pytest.mark.skipif(sys.platform != "win32", reason="needs Windows ACLs")
def test_windows_a_loose_file_is_restricted_by_the_next_save(tmp_path):
    path = tmp_path / "secrets.json"
    path.write_text("{}", encoding="utf-8")  # inherits the folder's access, like an older build's file
    CredentialStore(path).put("x", {"a": 1})
    assert vault.verify_user_restricted(path) is True
    assert not list(tmp_path.glob("*.tmp"))
