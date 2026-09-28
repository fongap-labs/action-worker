"""Bootstrap tests: validation, cleanup, exit code preservation."""

from kit_target import target_root
import os
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

REPO_ROOT = target_root()
BOOTSTRAP = REPO_ROOT / "bootstrap.sh"

pytestmark = pytest.mark.skipif(
    shutil.which("bash") is None,
    reason="bash not available in this environment",
)


def _run_bootstrap(args: list[str], env: dict | None = None, timeout: int = 10):
    full_env = {**os.environ}
    if env:
        full_env.update(env)
    return subprocess.run(
        ["bash", str(BOOTSTRAP), *args],
        capture_output=True, text=True, env=full_env, timeout=timeout,
    )


# -- Conflict Check isolated tests --
# Runs the conflict check logic in a minimal bash subshell so we don't need
# the full verified source snapshot that bootstrap.sh requires.

def _conflict_check(tmp_path: Path, env_vars_content: str = "", secrets_content: str = "") -> subprocess.CompletedProcess:
    """Run the Conflict Check snippet from bootstrap.sh in a temp directory.

    Args:
        tmp_path: pytest tmp_path fixture directory.
        env_vars_content: content for .env.variables file.
        secrets_content: content for .secrets.required file.
    """
    env_file = tmp_path / ".env.variables"
    env_file.write_text(env_vars_content, encoding="utf-8")

    secrets_file = tmp_path / ".secrets.required"
    secrets_file.write_text(secrets_content, encoding="utf-8")

    snippet = textwrap.dedent(f"""\
        set -Eeuo pipefail

        PROJECT_FULL="{tmp_path.as_posix()}"
        _env_variables="${{PROJECT_FULL}}/.env.variables"

        _var_names=""
        if [[ -f "${{_env_variables}}" ]]; then
            _var_names=$(
                sed \
                    -e '/^[[[:space:]]*#/d' \
                    -e '/^[[[:space:]]*$/d' \
                    -e 's/=.*$//' \
                    -e 's/^[[:space:]]*//' \
                    -e 's/[[[:space:]]]*$//' \
                    "${{_env_variables}}" |
                sort -u
            )
        fi

        _sec_names=""
        if [[ -f "${{PROJECT_FULL}}/.secrets.required" ]]; then
            _sec_names=$(
                sed \
                    -e '/^[[[:space:]]*#/d' \
                    -e '/^[[[:space:]]*$/d' \
                    -e 's/^[[:space:]]*//' \
                    -e 's/[[[:space:]]]*$//' \
                    "${{PROJECT_FULL}}/.secrets.required" |
                sort -u
            )
        fi

        if [[ -n "${{_var_names}}" && -n "${{_sec_names}}" ]]; then
            _conflicts=$(comm -12 <(echo "${{_var_names}}") <(echo "${{_sec_names}}"))
            if [[ -n "${{_conflicts}}" ]]; then
                echo "CONFLICT:${{_conflicts}}"
                exit 1
            fi
        fi

        echo "NO_CONFLICT"
    """)

    return subprocess.run(
        ["bash", "-c", snippet],
        capture_output=True,
        text=True,
        timeout=10,
    )


class TestBootstrapValidation:
    def test_missing_project_arg(self):
        proc = _run_bootstrap([])
        assert proc.returncode != 0
        assert "project" in proc.stderr.lower()

    def test_invalid_project_name(self):
        ref = "a" * 40
        proc = _run_bootstrap(["bad/project!", ref])
        assert proc.returncode != 0
        assert "invalid" in proc.stderr.lower()

    def test_project_too_long(self):
        ref = "a" * 40
        proc = _run_bootstrap(["x" * 100, ref])
        assert proc.returncode != 0
        assert "too long" in proc.stderr.lower()

    def test_invalid_sha(self):
        proc = _run_bootstrap(["AdFilter", "short"])
        assert proc.returncode != 0
        assert "40-char" in proc.stderr.lower() or "sha" in proc.stderr.lower()

    def test_missing_source_dir(self):
        ref = "a" * 40
        env = {k: v for k, v in os.environ.items() if k != "AW_SOURCE_DIR"}
        proc = _run_bootstrap(["AdFilter", ref], env=env)
        assert proc.returncode != 0
        assert "AW_SOURCE_DIR" in proc.stderr


class TestBootstrapStructure:
    def test_no_github_token_fallback(self):
        """bootstrap.sh must not use GITHUB_TOKEN as a credential fallback."""
        text = BOOTSTRAP.read_text(encoding="utf-8")
        assert "GITHUB_TOKEN" not in text

    def test_no_private_repo_alias(self):
        """bootstrap.sh must not use PRIVATE_REPO or PRIVATE_REF aliases."""
        text = BOOTSTRAP.read_text(encoding="utf-8")
        assert "PRIVATE_REPO" not in text
        assert "PRIVATE_REF" not in text

    def test_no_pip_upgrade(self):
        """bootstrap.sh must not run pip install --upgrade pip."""
        text = BOOTSTRAP.read_text(encoding="utf-8")
        assert "pip install --upgrade pip" not in text
        assert "pip upgrade" not in text.lower()

    def test_no_eval_for_resolve_env(self):
        """bootstrap.sh must not eval resolve_env output."""
        text = BOOTSTRAP.read_text(encoding="utf-8")
        assert "eval " not in text

    def test_cleanup_uses_exit_only(self):
        """cleanup should only be trapped on EXIT, not INT/TERM."""
        text = BOOTSTRAP.read_text(encoding="utf-8")
        # EXIT trap should exist
        assert "trap cleanup EXIT" in text
        # INT and TERM should NOT call cleanup directly
        assert "trap cleanup EXIT INT TERM" not in text

    def test_tools_preflight_includes_required(self):
        """Tool preflight must check envsubst, grep, sed, and jq."""
        text = BOOTSTRAP.read_text(encoding="utf-8")
        for tool in ["envsubst", "grep", "sed", "jq"]:
            assert tool in text, f"Tool {tool} missing from preflight"

    def test_source_snapshot_requires_no_execution_credential(self):
        """bootstrap.sh must consume the prechecked local source snapshot."""
        text = BOOTSTRAP.read_text(encoding="utf-8")
        assert "AW_SOURCE_DIR" in text
        assert "git -C" in text
        assert "rev-parse HEAD" in text
        assert "AW_EXECUTION_TOKEN" not in text
        assert "AW_EXECUTION_REPOSITORY" not in text
        assert "git fetch" not in text
        assert "http.extraHeader" not in text

    def test_conflict_check_exists(self):
        """bootstrap.sh must check variable/secret conflicts."""
        text = BOOTSTRAP.read_text(encoding="utf-8")
        assert "declared as both variable and secret" in text

    def test_env_variables_direct_read(self):
        """bootstrap.sh must read .env.variables directly."""
        text = BOOTSTRAP.read_text(encoding="utf-8")

        assert '_env_variables="${PROJECT_FULL}/.env.variables"' in text
        assert '--dotenv "${_env_variables}"' in text
        assert 'cp "${PROJECT_FULL}/.env.variables"' not in text

    def test_dependency_install_does_not_disable_transitive_deps(self):
        """bootstrap.sh must not use --no-deps when installing Python dependencies."""
        text = BOOTSTRAP.read_text(encoding="utf-8")
        assert "--no-deps" not in text

    def test_dependency_integrity_is_checked(self):
        """bootstrap.sh must run pip check after dependency installation."""
        text = BOOTSTRAP.read_text(encoding="utf-8")
        assert "pip check" in text

    def test_conflict_check_uses_sed_not_grep(self):
        """Conflict check must use sed, not grep, to avoid pipefail on empty files."""
        text = BOOTSTRAP.read_text(encoding="utf-8")
        # Find the Conflict Check section
        assert "::group::Conflict Check" in text
        idx = text.index("::group::Conflict Check")
        section = text[idx:idx + 1500]
        # The variable reading logic must not use grep for filtering
        assert "grep" not in section.split("::endgroup::")[0]

    def test_no_legacy_project_secrets_protocol_in_runtime(self):
        forbidden = "PROJECT_" + "SECRETS_JSON"

        targets = [
            REPO_ROOT / "bootstrap.sh",
            REPO_ROOT / "preflight",
            REPO_ROOT / "engine",
            REPO_ROOT / "projects",
        ]

        for target in targets:
            if not target.exists():
                continue

            if target.is_file():
                content = target.read_text(
                    encoding="utf-8",
                    errors="ignore",
                )
                assert forbidden not in content, (
                    f"Found legacy secret protocol in "
                    f"{target.relative_to(REPO_ROOT)}"
                )
                continue

            for path in target.rglob("*"):
                if not path.is_file():
                    continue

                content = path.read_text(
                    encoding="utf-8",
                    errors="ignore",
                )

                assert forbidden not in content, (
                    f"Found legacy secret protocol in "
                    f"{path.relative_to(REPO_ROOT)}"
                )

    def test_cleanup_unsets_injected_secrets(self):
        """cleanup function must unset variables tracked in _GHOST_LOADED_VARS."""
        text = BOOTSTRAP.read_text(encoding="utf-8")
        assert "unset \"${var_name}\"" in text

    def test_no_execution_token_contract_remains(self):
        """Execution source access belongs to the central control plane only."""
        text = BOOTSTRAP.read_text(encoding="utf-8")
        assert "AW_EXECUTION_TOKEN" not in text
        assert "AW_EXECUTION_REPOSITORY" not in text

    def test_secret_cleanup_before_dispatch(self):
        """Non-required secrets must be cleared before Task Dispatch."""
        text = BOOTSTRAP.read_text(encoding="utf-8")
        assert "Secret Cleanup" in text
        assert "_SECRET_ENV_NAMES_FILE" in text
        assert "Non-required secret still present before Task Dispatch" in text

    def test_baseline_env_snapshot_required(self):
        """bootstrap.sh must require action-worker base environment snapshot."""
        text = BOOTSTRAP.read_text(encoding="utf-8")
        assert "action-worker-base-env.names" in text
        assert "Missing action-worker base environment snapshot" in text

    def test_no_github_token_in_project_env(self):
        """GITHUB_TOKEN must not be available to project tasks."""
        text = BOOTSTRAP.read_text(encoding="utf-8")
        assert "GITHUB_TOKEN" not in text

    def test_secret_values_not_in_logs(self):
        """Secret values must not appear in bootstrap.log output."""
        text = BOOTSTRAP.read_text(encoding="utf-8")
        # Must not have echo of secret values in injection section
        assert 'echo "${_sv}"' not in text


class TestConflictCheck:
    """Isolated tests for the Conflict Check logic.

    These run the exact sed/comm snippet from bootstrap.sh in a temporary
    directory, without needing vault clone or GitHub credentials.
    """

    def test_env_comments_only(self, tmp_path):
        """.env.variables with only comments must pass conflict check."""
        proc = _conflict_check(
            tmp_path,
            env_vars_content="# This is a comment\n# Another comment\n",
        )
        assert proc.returncode == 0
        assert "NO_CONFLICT" in proc.stdout

    def test_env_empty(self, tmp_path):
        """Empty .env.variables must pass conflict check."""
        proc = _conflict_check(tmp_path, env_vars_content="")
        assert proc.returncode == 0
        assert "NO_CONFLICT" in proc.stdout

    def test_secrets_empty(self, tmp_path):
        """Empty .secrets.required must pass conflict check."""
        proc = _conflict_check(tmp_path, secrets_content="")
        assert proc.returncode == 0
        assert "NO_CONFLICT" in proc.stdout

    def test_no_conflict(self, tmp_path):
        """Variable and secret with different names must pass."""
        proc = _conflict_check(
            tmp_path,
            env_vars_content="VAR_A=hello\nVAR_B=world\n",
            secrets_content="SECRET_X\nSECRET_Y\n",
        )
        assert proc.returncode == 0
        assert "NO_CONFLICT" in proc.stdout

    def test_conflict_fails(self, tmp_path):
        """Variable and secret with the same name must fail."""
        proc = _conflict_check(
            tmp_path,
            env_vars_content="API_KEY=abc\nVAR_B=world\n",
            secrets_content="API_KEY\nSECRET_Y\n",
        )
        assert proc.returncode != 0
        assert "CONFLICT:API_KEY" in proc.stdout

    def test_conflict_outputs_variable_name(self, tmp_path):
        """Conflict failure must output the specific conflicting variable name."""
        proc = _conflict_check(
            tmp_path,
            env_vars_content="DB_PASS=secret\nAPI_KEY=abc\n",
            secrets_content="DB_PASS\nAPI_TOKEN\n",
        )
        assert proc.returncode != 0
        assert "CONFLICT:DB_PASS" in proc.stdout

    def test_env_only_blank_lines(self, tmp_path):
        """.env.variables with only blank lines must pass."""
        proc = _conflict_check(
            tmp_path,
            env_vars_content="\n\n\n  \n\t\n",
        )
        assert proc.returncode == 0
        assert "NO_CONFLICT" in proc.stdout

    def test_env_comments_and_blank_lines_mixed(self, tmp_path):
        """.env.variables with mixed comments and blank lines must pass."""
        proc = _conflict_check(
            tmp_path,
            env_vars_content="# comment\n\n  # indented\n\n",
        )
        assert proc.returncode == 0
        assert "NO_CONFLICT" in proc.stdout

    def test_secrets_comments_only(self, tmp_path):
        """.secrets.required with only comments must pass."""
        proc = _conflict_check(
            tmp_path,
            secrets_content="# secret list\n# placeholder\n",
        )
        assert proc.returncode == 0
        assert "NO_CONFLICT" in proc.stdout

    def test_multiple_conflicts(self, tmp_path):
        """Multiple conflicting names must all be reported."""
        proc = _conflict_check(
            tmp_path,
            env_vars_content="KEY_A=1\nKEY_B=2\n",
            secrets_content="KEY_A\nKEY_B\n",
        )
        assert proc.returncode != 0
        assert "CONFLICT:KEY_A" in proc.stdout
        assert "KEY_B" in proc.stdout

    def test_both_files_empty(self, tmp_path):
        """Both empty files must pass conflict check."""
        proc = _conflict_check(tmp_path, env_vars_content="", secrets_content="")
        assert proc.returncode == 0
        assert "NO_CONFLICT" in proc.stdout
