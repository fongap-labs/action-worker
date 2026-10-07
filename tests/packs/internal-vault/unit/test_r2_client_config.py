"""The R2 upload brick must not send botocore's default checksums to Cloudflare R2 (newer boto3)."""

from __future__ import annotations

import importlib.util

import pytest
from kit_target import target_root

REPO_ROOT = target_root()


def load_brick():
    pytest.importorskip("boto3")
    spec = importlib.util.spec_from_file_location("r2_storage_upload_under_test", REPO_ROOT / "bricks" / "r2_storage_upload.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RecordingConfig:
    """A stand-in for botocore's Config that accepts every option (botocore 1.36 and later)."""

    def __init__(self, **options):
        self.options = options


class OldConfig:
    """A stand-in for botocore before 1.36, which rejects the checksum options."""

    def __init__(self, **options):
        if "request_checksum_calculation" in options or "response_checksum_validation" in options:
            raise TypeError("Got unexpected keyword argument 'request_checksum_calculation'")
        self.options = options


def test_checksums_are_only_calculated_and_validated_when_the_api_requires_them(monkeypatch):
    brick = load_brick()
    monkeypatch.setattr(brick, "Config", RecordingConfig)
    options = brick.r2_client_config().options
    assert options["request_checksum_calculation"] == "when_required"
    assert options["response_checksum_validation"] == "when_required"
    assert options["signature_version"] == "s3v4"
    assert options["retries"] == {"max_attempts": 3}


def test_an_older_botocore_gets_the_plain_settings(monkeypatch):
    brick = load_brick()
    monkeypatch.setattr(brick, "Config", OldConfig)
    assert brick.r2_client_config().options == {"signature_version": "s3v4", "retries": {"max_attempts": 3}}


def test_the_installed_botocore_accepts_the_configuration():
    brick = load_brick()
    config = brick.r2_client_config()
    assert config.signature_version == "s3v4"


def test_the_client_is_built_from_that_configuration():
    text = (REPO_ROOT / "bricks" / "r2_storage_upload.py").read_text(encoding="utf-8")
    assert "config=r2_client_config()" in text
