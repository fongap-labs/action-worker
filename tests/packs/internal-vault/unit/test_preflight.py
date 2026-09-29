"""Preflight tests: env validation, secret checking, task schema."""

from kit_target import target_root
import json
import os
import subprocess
import sys
from pathlib import Path


REPO_ROOT = target_root()
FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
PREFLIGHT = REPO_ROOT / "preflight"

import shutil
HAS_BASH = shutil.which("bash") is not None


def _preflight_env():
    return {**os.environ, "PYTHONPATH": str(REPO_ROOT)}


def _clean_env(*names):
    env = {k: v for k, v in os.environ.items() if k not in names}
    env["PYTHONPATH"] = str(REPO_ROOT)
    return env


class TestResolveEnv:
    def test_valid_env(self):
        from preflight.resolve_env import _parse_env_variables
        dotenv = FIXTURES / "sample_project" / ".env.variables"
        fixed, required, dup, conflict, invalid = _parse_env_variables(dotenv)
        assert "AW_FOO_VAR" in fixed
        assert fixed["AW_FOO_VAR"] == "hello"
        assert "AW_BAR_VAR" in fixed
        assert fixed["AW_BAR_VAR"] == "world"
        assert required == []
        assert dup == []
        assert conflict == []
        assert invalid == []

    def test_invalid_key_skipped(self):
        from preflight.resolve_env import _parse_env_variables
        dotenv = FIXTURES / "sample_bad_env_key" / ".env.variables"
        fixed, required, dup, conflict, invalid = _parse_env_variables(dotenv)
        assert "GOOD" in fixed
        assert "1BAD" in invalid

    def test_bare_key_from_env(self, tmp_path):
        env_file = tmp_path / ".env.variables"
        env_file.write_text("PUBLIC_URL\n", encoding="utf-8")
        env = _clean_env("PUBLIC_URL")
        env["PUBLIC_URL"] = "https://example.com"
        proc = subprocess.run(
            [sys.executable, str(PREFLIGHT / "resolve_env.py"),
             "--dotenv", str(env_file)],
            capture_output=True, text=True, env=env,
        )
        assert proc.returncode == 0
        data = json.loads(proc.stdout)
        assert data["required"] == ["PUBLIC_URL"]
        assert data["resolved"]["PUBLIC_URL"] == "https://example.com"
        assert data["missing"] == []
        assert data["fixed"] == {}

    def test_bare_key_missing_fails(self, tmp_path):
        env_file = tmp_path / ".env.variables"
        env_file.write_text("MISSING_VAR\n", encoding="utf-8")
        env = _clean_env("MISSING_VAR")
        proc = subprocess.run(
            [sys.executable, str(PREFLIGHT / "resolve_env.py"),
             "--dotenv", str(env_file)],
            capture_output=True, text=True, env=env,
        )
        assert proc.returncode == 1
        assert "FAIL: missing required variables:" in proc.stderr
        assert "MISSING_VAR" in proc.stderr
        data = json.loads(proc.stdout)
        assert "MISSING_VAR" in data["missing"]

    def test_fixed_overrides_external(self, tmp_path):
        env_file = tmp_path / ".env.variables"
        env_file.write_text("FOO=internal\n", encoding="utf-8")
        env = _clean_env("FOO")
        env["FOO"] = "github"
        proc = subprocess.run(
            [sys.executable, str(PREFLIGHT / "resolve_env.py"),
             "--dotenv", str(env_file)],
            capture_output=True, text=True, env=env,
        )
        assert proc.returncode == 0
        data = json.loads(proc.stdout)
        assert data["fixed"]["FOO"] == "internal"
        assert "FOO" not in data["resolved"]

    def test_duplicate_key_fails(self, tmp_path):
        env_file = tmp_path / ".env.variables"
        env_file.write_text("FOO=abc\nFOO=def\n", encoding="utf-8")
        proc = subprocess.run(
            [sys.executable, str(PREFLIGHT / "resolve_env.py"),
             "--dotenv", str(env_file)],
            capture_output=True, text=True, env=_preflight_env(),
        )
        assert proc.returncode == 1
        assert "FAIL: duplicate variable: FOO" in proc.stderr

    def test_fixed_required_conflict_fails(self, tmp_path):
        env_file = tmp_path / ".env.variables"
        env_file.write_text("FOO=abc\nFOO\n", encoding="utf-8")
        proc = subprocess.run(
            [sys.executable, str(PREFLIGHT / "resolve_env.py"),
             "--dotenv", str(env_file)],
            capture_output=True, text=True, env=_preflight_env(),
        )
        assert proc.returncode == 1
        assert "FAIL: FOO declared as both fixed and required" in proc.stderr

    def test_required_duplicate_fails(self, tmp_path):
        env_file = tmp_path / ".env.variables"
        env_file.write_text("FOO\nFOO\n", encoding="utf-8")
        proc = subprocess.run(
            [sys.executable, str(PREFLIGHT / "resolve_env.py"),
             "--dotenv", str(env_file)],
            capture_output=True, text=True, env=_preflight_env(),
        )
        assert proc.returncode == 1
        assert "FAIL: duplicate variable: FOO" in proc.stderr

    def test_comments_and_empty_lines(self, tmp_path):
        env_file = tmp_path / ".env.variables"
        env_file.write_text("# comment\n\nFOO=bar\n# another\n", encoding="utf-8")
        proc = subprocess.run(
            [sys.executable, str(PREFLIGHT / "resolve_env.py"),
             "--dotenv", str(env_file)],
            capture_output=True, text=True, env=_preflight_env(),
        )
        assert proc.returncode == 0
        data = json.loads(proc.stdout)
        assert data["fixed"]["FOO"] == "bar"

    def test_json_output(self):
        dotenv = FIXTURES / "sample_project" / ".env.variables"
        proc = subprocess.run(
            [sys.executable, str(PREFLIGHT / "resolve_env.py"),
             "--dotenv", str(dotenv)],
            capture_output=True, text=True, env=_preflight_env(),
        )
        assert proc.returncode == 0
        data = json.loads(proc.stdout)
        assert "fixed" in data
        assert "resolved" in data
        assert "missing" in data
        assert data["fixed"]["AW_FOO_VAR"] == "hello"

    def test_track_file(self, tmp_path):
        dotenv = FIXTURES / "sample_project" / ".env.variables"
        track = tmp_path / "loaded.list"
        proc = subprocess.run(
            [sys.executable, str(PREFLIGHT / "resolve_env.py"),
             "--dotenv", str(dotenv),
             "--track-file", str(track)],
            capture_output=True, text=True, env=_preflight_env(),
        )
        assert proc.returncode == 0
        assert track.exists()
        names = track.read_text().splitlines()
        assert "AW_FOO_VAR" in names
        assert "AW_BAR_VAR" in names


class TestInjectSecrets:
    def test_required_secret_exists(self, tmp_path):
        secrets_required = tmp_path / ".secrets.required"
        secrets_required.write_text("CLOUDFLARE_ACCOUNT_ID\nCLOUDFLARE_API_TOKEN\n", encoding="utf-8")
        env = _clean_env("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN")
        env["CLOUDFLARE_ACCOUNT_ID"] = "account123"
        env["CLOUDFLARE_API_TOKEN"] = "token123"
        proc = subprocess.run(
            [sys.executable, str(PREFLIGHT / "inject_secrets.py"),
             "--secrets-required", str(secrets_required)],
            capture_output=True, text=True, env=env,
        )
        assert proc.returncode == 0
        data = json.loads(proc.stdout)
        assert data["count"] == 2
        assert "CLOUDFLARE_ACCOUNT_ID" in data["names"]
        assert "CLOUDFLARE_API_TOKEN" in data["names"]
        assert data["missing"] == []

    def test_required_secret_missing_fails(self, tmp_path):
        secrets_required = tmp_path / ".secrets.required"
        secrets_required.write_text("AW_TEST_TOKEN\n", encoding="utf-8")
        env = _clean_env("AW_TEST_TOKEN")
        proc = subprocess.run(
            [sys.executable, str(PREFLIGHT / "inject_secrets.py"),
             "--secrets-required", str(secrets_required)],
            capture_output=True, text=True, env=env,
        )
        assert proc.returncode == 1
        assert "FAIL: missing required secrets:" in proc.stderr
        assert "AW_TEST_TOKEN" in proc.stderr
        data = json.loads(proc.stdout)
        assert "AW_TEST_TOKEN" in data["missing"]

    def test_extra_secrets_in_env_ignored(self, tmp_path):
        secrets_required = tmp_path / ".secrets.required"
        secrets_required.write_text("CLOUDFLARE_ACCOUNT_ID\n", encoding="utf-8")
        env = _clean_env("CLOUDFLARE_ACCOUNT_ID", "OTHER_SECRET", "ANOTHER_SECRET")
        env["CLOUDFLARE_ACCOUNT_ID"] = "account123"
        env["OTHER_SECRET"] = "other_value"
        env["ANOTHER_SECRET"] = "another_value"
        proc = subprocess.run(
            [sys.executable, str(PREFLIGHT / "inject_secrets.py"),
             "--secrets-required", str(secrets_required)],
            capture_output=True, text=True, env=env,
        )
        assert proc.returncode == 0
        data = json.loads(proc.stdout)
        assert data["count"] == 1
        assert "CLOUDFLARE_ACCOUNT_ID" in data["names"]
        assert "OTHER_SECRET" not in data["names"]
        assert "ANOTHER_SECRET" not in data["names"]

    def test_duplicate_secret_name_fails(self, tmp_path):
        secrets_required = tmp_path / ".secrets.required"
        secrets_required.write_text("FOO_TOKEN\nFOO_TOKEN\n", encoding="utf-8")
        env = _clean_env("FOO_TOKEN")
        env["FOO_TOKEN"] = "value"
        proc = subprocess.run(
            [sys.executable, str(PREFLIGHT / "inject_secrets.py"),
             "--secrets-required", str(secrets_required)],
            capture_output=True, text=True, env=env,
        )
        assert proc.returncode == 1
        assert "FAIL: Invalid secret names:" in proc.stderr

    def test_invalid_secret_name_fails(self, tmp_path):
        secrets_required = tmp_path / ".secrets.required"
        secrets_required.write_text("1BAD_NAME\n", encoding="utf-8")
        env = _clean_env("1BAD_NAME")
        env["1BAD_NAME"] = "value"
        proc = subprocess.run(
            [sys.executable, str(PREFLIGHT / "inject_secrets.py"),
             "--secrets-required", str(secrets_required)],
            capture_output=True, text=True, env=env,
        )
        assert proc.returncode == 1
        assert "FAIL: Invalid secret names:" in proc.stderr

    def test_secret_value_not_output(self, tmp_path):
        secrets_required = tmp_path / ".secrets.required"
        secrets_required.write_text("AW_TEST_TOKEN\n", encoding="utf-8")
        env = _clean_env("AW_TEST_TOKEN")
        # NOT A REAL SECRET: fake token value, never printed by inject_secrets.
        env["AW_TEST_TOKEN"] = "ghp_secret_value_1234567890"

        proc = subprocess.run(
            [sys.executable, str(PREFLIGHT / "inject_secrets.py"),
             "--secrets-required", str(secrets_required)],
            capture_output=True, text=True, env=env,
        )
        assert proc.returncode == 0
        stdout_str = proc.stdout
        assert "ghp_secret_value" not in stdout_str
        data = json.loads(proc.stdout)
        assert "names" in data
        assert "secrets" not in data

    def test_secret_value_masked(self, tmp_path):
        secrets_required = tmp_path / ".secrets.required"
        secrets_required.write_text("AW_TEST_TOKEN\n", encoding="utf-8")
        env = _clean_env("AW_TEST_TOKEN")
        # NOT A REAL SECRET: format-valid fake GitHub PAT, masked by add-mask.
        env["AW_TEST_TOKEN"] = "gh" "p_test12345678901234567890123456789012ab"

        proc = subprocess.run(
            [sys.executable, str(PREFLIGHT / "inject_secrets.py"),
             "--secrets-required", str(secrets_required)],
            capture_output=True, text=True, env=env,
        )
        assert proc.returncode == 0
        assert "::add-mask::gh" "p_test12345678901234567890123456789012ab" in proc.stderr

    def test_no_secrets_required_passes(self):
        proc = subprocess.run(
            [sys.executable, str(PREFLIGHT / "inject_secrets.py"),
             "--secrets-required", "/nonexistent/path"],
            capture_output=True, text=True, env=_preflight_env(),
        )
        assert proc.returncode == 0
        data = json.loads(proc.stdout)
        assert data["count"] == 0
        assert data["missing"] == []

    def test_multiple_secrets_partial_missing(self):
        secrets_required = FIXTURES / "fongapblog" / ".secrets.required"
        env = _clean_env("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN",
                         "ALGOLIA_APP_ID", "ALGOLIA_WRITE_KEY")
        env["CLOUDFLARE_ACCOUNT_ID"] = "account123"
        env["CLOUDFLARE_API_TOKEN"] = "token123"
        proc = subprocess.run(
            [sys.executable, str(PREFLIGHT / "inject_secrets.py"),
             "--secrets-required", str(secrets_required)],
            capture_output=True, text=True, env=env,
        )
        assert proc.returncode == 1
        assert "ALGOLIA_APP_ID" in proc.stderr
        assert "ALGOLIA_WRITE_KEY" in proc.stderr
        data = json.loads(proc.stdout)
        assert "CLOUDFLARE_ACCOUNT_ID" in data["names"]
        assert "CLOUDFLARE_API_TOKEN" in data["names"]
        assert "ALGOLIA_APP_ID" in data["missing"]
        assert "ALGOLIA_WRITE_KEY" in data["missing"]

    def test_track_file_records_names_only(self, tmp_path):
        secrets_required = tmp_path / ".secrets.required"
        secrets_required.write_text("AW_TEST_TOKEN\n", encoding="utf-8")
        track = tmp_path / "secrets.list"
        env = _clean_env("AW_TEST_TOKEN")
        env["AW_TEST_TOKEN"] = "ghp_test_token_value"
        proc = subprocess.run(
            [sys.executable, str(PREFLIGHT / "inject_secrets.py"),
             "--secrets-required", str(secrets_required),
             "--track-file", str(track)],
            capture_output=True, text=True, env=env,
        )
        assert proc.returncode == 0
        assert track.exists()
        names = track.read_text().splitlines()
        assert "AW_TEST_TOKEN" in names
        content = track.read_text()
        assert "ghp_" not in content

    def test_comments_and_empty_lines(self, tmp_path):
        secrets_required = tmp_path / ".secrets.required"
        secrets_required.write_text("# comment\n\nVALID_SECRET\n# another\n", encoding="utf-8")
        env = _clean_env("VALID_SECRET")
        env["VALID_SECRET"] = "value123456"
        proc = subprocess.run(
            [sys.executable, str(PREFLIGHT / "inject_secrets.py"),
             "--secrets-required", str(secrets_required)],
            capture_output=True, text=True, env=env,
        )
        assert proc.returncode == 0
        data = json.loads(proc.stdout)
        assert data["count"] == 1
        assert "VALID_SECRET" in data["names"]

    def test_only_required_secrets_in_output(self, tmp_path):
        """Output must only contain names from .secrets.required, not extra env vars."""
        secrets_required = tmp_path / ".secrets.required"
        secrets_required.write_text("CLOUDFLARE_ACCOUNT_ID\nCLOUDFLARE_API_TOKEN\n", encoding="utf-8")
        env = _clean_env("CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN",
                         "EXECUTION_TOKEN", "GITHUB_TOKEN", "OTHER_RANDOM_SECRET")
        env["CLOUDFLARE_ACCOUNT_ID"] = "account123"
        env["CLOUDFLARE_API_TOKEN"] = "token123"
        env["EXECUTION_TOKEN"] = "ghp_should_not_appear"
        env["GITHUB_TOKEN"] = "gho_should_not_appear"
        env["OTHER_RANDOM_SECRET"] = "value"
        proc = subprocess.run(
            [sys.executable, str(PREFLIGHT / "inject_secrets.py"),
             "--secrets-required", str(secrets_required)],
            capture_output=True, text=True, env=env,
        )
        assert proc.returncode == 0
        data = json.loads(proc.stdout)
        assert data["count"] == 2
        assert set(data["names"]) == {"CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"}
        assert "EXECUTION_TOKEN" not in data["names"]
        assert "GITHUB_TOKEN" not in data["names"]
        assert "OTHER_RANDOM_SECRET" not in data["names"]
        assert data["missing"] == []

    def test_secret_value_not_in_stdout(self, tmp_path):
        """Secret values must never appear in stdout JSON output."""
        secrets_required = tmp_path / ".secrets.required"
        secrets_required.write_text("MY_SECRET\n", encoding="utf-8")
        secret_value = "super_secret_value_abc123xyz"
        env = _clean_env("MY_SECRET")
        env["MY_SECRET"] = secret_value
        proc = subprocess.run(
            [sys.executable, str(PREFLIGHT / "inject_secrets.py"),
             "--secrets-required", str(secrets_required)],
            capture_output=True, text=True, env=env,
        )
        assert proc.returncode == 0
        assert secret_value not in proc.stdout
        data = json.loads(proc.stdout)
        assert "values" not in data
        assert "secrets" not in data


class TestCrossFileConflict:
    def test_variable_secret_conflict_detected(self, tmp_path):
        env_file = tmp_path / ".env.variables"
        env_file.write_text("SHARED_TOKEN\n", encoding="utf-8")
        secrets_file = tmp_path / ".secrets.required"
        secrets_file.write_text("SHARED_TOKEN\n", encoding="utf-8")

        env = _clean_env("SHARED_TOKEN")
        env["SHARED_TOKEN"] = "some_value"

        resolve_proc = subprocess.run(
            [sys.executable, str(PREFLIGHT / "resolve_env.py"),
             "--dotenv", str(env_file)],
            capture_output=True, text=True, env=env,
        )
        assert resolve_proc.returncode == 0

        inject_proc = subprocess.run(
            [sys.executable, str(PREFLIGHT / "inject_secrets.py"),
             "--secrets-required", str(secrets_file)],
            capture_output=True, text=True, env=env,
        )
        assert inject_proc.returncode == 0

        resolve_data = json.loads(resolve_proc.stdout)
        inject_data = json.loads(inject_proc.stdout)

        var_names = set(resolve_data.get("fixed", {}).keys()) | set(resolve_data.get("required", []))
        sec_names = set(inject_data.get("names", []))
        conflicts = var_names & sec_names
        assert "SHARED_TOKEN" in conflicts


class TestValidateTask:
    def test_valid_task(self):
        task = FIXTURES / "sample_project" / "task.json"
        proc = subprocess.run(
            [sys.executable, str(PREFLIGHT / "validate_task.py"), str(task)],
            capture_output=True, text=True, env=_preflight_env(),
        )
        assert proc.returncode == 0

    def test_valid_task_from_foreign_working_directory(self, tmp_path):
        task = FIXTURES / "sample_project" / "task.json"
        proc = subprocess.run(
            [sys.executable, str(PREFLIGHT / "validate_task.py"), str(task)],
            capture_output=True, text=True, env=_preflight_env(), cwd=tmp_path,
        )
        assert proc.returncode == 0, proc.stderr

    def test_dag_cycle(self):
        task = FIXTURES / "sample_cycle" / "task.json"
        proc = subprocess.run(
            [sys.executable, str(PREFLIGHT / "validate_task.py"), str(task)],
            capture_output=True, text=True, env=_preflight_env(),
        )
        assert proc.returncode != 0
        assert "circular" in proc.stderr.lower() or "cycle" in proc.stderr.lower()

    def test_bad_target(self):
        task = FIXTURES / "sample_bad_target" / "task.json"
        proc = subprocess.run(
            [sys.executable, str(PREFLIGHT / "validate_task.py"), str(task)],
            capture_output=True, text=True, env=_preflight_env(),
        )
        assert proc.returncode != 0

    def test_forbidden_field(self):
        task = FIXTURES / "sample_forbidden_field" / "task.json"
        proc = subprocess.run(
            [sys.executable, str(PREFLIGHT / "validate_task.py"), str(task)],
            capture_output=True, text=True, env=_preflight_env(),
        )
        assert proc.returncode != 0


class TestLintEnv:
    def test_passes(self):
        proj = FIXTURES / "sample_lint"
        env = {**_preflight_env(), "AW_FOO_VAR": "hello"}
        proc = subprocess.run(
            [sys.executable, str(PREFLIGHT / "lint_env.py"), str(proj)],
            capture_output=True, text=True, env=env,
        )
        assert proc.returncode == 0

    def test_missing_var(self):
        proj = FIXTURES / "sample_lint"
        env = {k: v for k, v in os.environ.items() if k != "AW_FOO_VAR"}
        env["PYTHONPATH"] = str(REPO_ROOT)
        proc = subprocess.run(
            [sys.executable, str(PREFLIGHT / "lint_env.py"), str(proj)],
            capture_output=True, text=True, env=env,
        )
        assert proc.returncode != 0


class TestRedact:
    def test_github_pat(self):
        from preflight.redact import Redactor
        r = Redactor()
        text = "Found token: gh" "p_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn"
        out = r.redact(text)
        assert "gh" "p_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn" not in out
        assert "REDACTED" in out

    def test_registered_value(self):
        from preflight.redact import Redactor
        r = Redactor()
        r.register("my_custom_secret_12345")
        out = r.redact("leak: my_custom_secret_12345 here")
        assert "my_custom_secret_12345" not in out

    def test_bearer(self):
        from preflight.redact import Redactor
        r = Redactor()
        text = "Header: Bearer abcdefghijklmnopqrstuvwxyz1234567890"
        out = r.redact(text)
        assert "abcdefghijklmnopqrstuvwxyz1234567890" not in out

    def test_private_key(self):
        from preflight.redact import Redactor
        r = Redactor()
        text = "-----BEGIN RSA PRIVATE " "KEY-----\nABCDEFG\n-----END RSA PRIVATE KEY-----"
        out = r.redact(text)
        assert "ABCDEFG" not in out
        assert "REDACTED" in out

    def test_openai_style_key(self):
        from preflight.redact import Redactor
        r = Redactor()
        secret = "sk-proj-aB3dE5fG7hI9jK1lM3nO5pQ7"
        out = r.redact(f"header value {secret} end")
        assert secret not in out
        assert "REDACTED" in out

    def test_google_api_key(self):
        from preflight.redact import Redactor
        r = Redactor()
        secret = "AI" "zaSy0123456789012345678901234567890123"
        out = r.redact(f"url?key={secret}")
        assert secret not in out
        assert "REDACTED" in out

    def test_jwt(self):
        from preflight.redact import Redactor
        r = Redactor()
        secret = (
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
            "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6Ikp3dCJ9."
            "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
        )
        out = r.redact(f"token {secret} end")
        assert secret not in out
        assert "REDACTED" in out

    def test_discord_webhook(self):
        from preflight.redact import Redactor
        r = Redactor()
        secret = "https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"
        out = r.redact(f"notify {secret} done")
        assert secret not in out
        assert "REDACTED" in out

    def test_slack_webhook(self):
        from preflight.redact import Redactor
        r = Redactor()
        # Assembled at runtime: one literal would trip GitHub push protection,
        # which scans fixtures exactly like production code.
        secret = "https://hooks.slack.com/" + "services/T00000000/B00000000/abcdefghijklmnopqrstuvwx"
        out = r.redact(f"notify {secret} done")
        assert secret not in out
        assert "REDACTED" in out

    def test_high_entropy_token(self):
        from preflight.redact import Redactor
        r = Redactor()
        secret = "aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zA7bC9"
        out = r.redact(f"opaque {secret} value")
        assert secret not in out
        assert "REDACTED" in out

    def test_commit_sha_is_not_redacted(self):
        from preflight.redact import Redactor
        r = Redactor()
        sha = "3f2a1b4c5d6e7f8091a2b3c4d5e6f708192a3b4c"
        out = r.redact(f"bootstrap_ref={sha}")
        assert sha in out
