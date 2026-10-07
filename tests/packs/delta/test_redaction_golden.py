"""Python side of the shared redaction policy (audit DL-001).

`packages/sanitize.py` and the Rust runtime (`crates/delta-core/src/redact.rs`) must agree on what is
credential-shaped. Both are tested against the same fixture, `redaction_golden.json`; the Rust test
is `crates/delta-core/tests/redaction_golden.rs`. A change that is not mirrored on both sides fails one
of the two.
"""

from __future__ import annotations

import json

import pytest
from kit_target import target_root

from packages.sanitize import redact_text, redact_url_credentials, sanitize_value

FIXTURE = target_root() / "crates" / "delta-core" / "tests" / "fixtures" / "redaction_golden.json"

# Credential-shaped inputs are placeholders in the fixture and assembled here, so that no file in either
# repository contains a string a secret scanner would report.
AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE"
GITHUB_TOKEN = "ghp_" + "a" * 36


def expand(value):
    if isinstance(value, str):
        return value.replace("<<AWS_KEY>>", AWS_KEY).replace("<<GITHUB_TOKEN>>", GITHUB_TOKEN)
    if isinstance(value, list):
        return [expand(item) for item in value]
    if isinstance(value, dict):
        return {key: expand(item) for key, item in value.items()}
    return value


CASES = [
    {**case, "input": expand(case["input"]), "expected": expand(case["expected"])}
    for case in json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]
]
SECRETS = [
    "hunter2",
    "abc123",
    "s3cret",
    "sk-abcdefghijklmnopqrstuvwxyz0123",
    AWS_KEY,
    GITHUB_TOKEN,
    "dBjftJeZ4CVPm",
]


def test_the_fixture_is_the_shared_one():
    assert len(CASES) >= 15
    assert json.loads(FIXTURE.read_text(encoding="utf-8"))["schema_version"] == 1


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_python_policy_matches_the_golden_case(case):
    assert sanitize_value(case["input"]) == case["expected"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_golden_results_are_stable_and_leak_nothing(case):
    assert sanitize_value(case["expected"]) == case["expected"]
    text = json.dumps(case["expected"], ensure_ascii=False)
    for secret in SECRETS:
        assert secret not in text


# --- command strings (the part DL-001 added) -----------------------------------------------------


def test_a_shell_command_loses_its_credentials_and_keeps_its_shape():
    command = "curl -H \"Authorization: Bearer abc123\" https://x.example/a?token=xyz --password hunter2 -o out.json"
    out = redact_text(command)
    assert out == "curl -H \"Authorization: [redacted]\" https://x.example/a?token=[redacted] --password [redacted] -o out.json"


@pytest.mark.parametrize(
    "text,expected",
    [
        ("--password hunter2", "--password [redacted]"),
        ("--token=abc123", "--token=[redacted]"),
        ("-secret 'a b c'", "-secret [redacted]"),
        ("--api-key AbC", "--api-key [redacted]"),
        ("X-Api-Key: AbC123", "X-Api-Key: [redacted]"),
        ("Set-Cookie: sid=1; Path=/", "Set-Cookie: [redacted]"),
        ("curl 'h.example/p?sig=ZZ&name=bob'", "curl 'h.example/p?sig=[redacted]&name=bob'"),
    ],
)
def test_each_announcing_form_is_scrubbed(text, expected):
    assert redact_text(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "",
        "ls -la /tmp --port 8080 --verbose",
        "git commit -m 'rotate the token handling'",
        "tokens are great; Keyboard: us",
        "--tokenizer bert-base",
        "see https://example.com/a?page=2#top",
        "C:/Users/me/Documents/report final.docx",
    ],
)
def test_text_without_credentials_is_untouched(text):
    assert redact_text(text) == text


def test_redaction_is_idempotent():
    once = redact_text("curl -H 'Authorization: Bearer abc' x?token=1 --password p sk-" + "a" * 30)
    assert redact_text(once) == once


def test_the_placeholders_stand_for_credential_shaped_text():
    assert redact_text(f"k {AWS_KEY} {GITHUB_TOKEN}") == "k [redacted] [redacted]"


def test_url_helper_alone_is_unchanged_for_non_http_schemes():
    assert redact_url_credentials("ftp://h/?token=x") == "ftp://h/?token=x"
    assert redact_url_credentials("https://h/p?access_token=t&state=s") == "https://h/p?access_token=[redacted]&state=s"
