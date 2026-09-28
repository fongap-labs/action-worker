"""Suite-side contract tests for Foundation/Suite compatibility.

These tests verify that the Suite repository maintains the boundary
contract with Foundation:
1. No direct dependency on delta-core / delta_core
2. No direct Foundation authority imports
3. Explicit manifest activation through delta-suite-install
4. No second runtime authority
5. Suite capabilities integrate through public SDK/contract boundaries
"""

from __future__ import annotations
from kit_target import target_root

import ast
import pathlib
import re
import sys
import tomllib

import pytest

ROOT = target_root()


def _scan_files(suffixes: set[str], skip_dirs: set[str]):
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        if any(part in skip_dirs for part in path.parts):
            continue
        if path.suffix.lower() not in suffixes:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        yield path.relative_to(ROOT), text


SKIP_DIRS = {".git", "node_modules", "target", ".venv", "dist", "build", "__pycache__", ".pytest_cache", ".ruff_cache"}
SOURCE_SUFFIXES = {".py", ".rs", ".ts", ".tsx", ".js", ".mjs", ".json", ".toml"}
GUARD_FILES = {"tests/test_suite_contract.py", "scripts/check_boundaries.py"}
FOUNDATION_E2E_PREFIX = "tests/foundation_runtime_e2e/"


def _norm(rel):
    return str(rel).replace("\\", "/")


class TestNoDirectFoundationDependency:
    """Suite must not directly depend on Foundation internals."""

    def test_no_foundation_python_internal_imports(self):
        """Suite runtime code must use delta_extension_api, not integrations/packages."""
        violations = []
        pattern = re.compile(
            r"^\s*(?:from|import)\s+(?:integrations|packages)(?:\.|\s|$)",
            re.M,
        )
        for rel, text in _scan_files({".py"}, SKIP_DIRS):
            normalized = _norm(rel)
            if normalized in GUARD_FILES or normalized.startswith("tests/"):
                continue
            if pattern.search(text):
                violations.append(normalized)
        assert not violations, f"Foundation Python internal imports: {violations}"

    def test_no_delta_core_import(self):
        """No Suite code should import delta_core or delta-core."""
        violations = []
        pattern = re.compile(r"\bdelta-core\b|\bdelta_core\b", re.I)
        for rel, text in _scan_files(SOURCE_SUFFIXES, SKIP_DIRS):
            normalized = _norm(rel)
            if normalized in GUARD_FILES or normalized.startswith(FOUNDATION_E2E_PREFIX):
                continue
            if pattern.search(text):
                violations.append(str(rel))
        assert not violations, f"Direct delta-core references found: {violations}"

    def test_no_core_runtime_native_path(self):
        """No Suite code should reference core/runtime-native paths."""
        violations = []
        pattern = re.compile(r"core/runtime-native", re.I)
        for rel, text in _scan_files(SOURCE_SUFFIXES, SKIP_DIRS):
            if _norm(rel) in GUARD_FILES:
                continue
            if pattern.search(text):
                violations.append(str(rel))
        assert not violations, f"core/runtime-native references: {violations}"

    def test_no_python_core_import(self):
        """No Suite Python should import from core/."""
        violations = []
        pattern = re.compile(r"^\s*(?:from|import)\s+core(?:\.|\s|$)", re.I | re.M)
        for rel, text in _scan_files({".py"}, SKIP_DIRS):
            if _norm(rel) in GUARD_FILES:
                continue
            if pattern.search(text):
                violations.append(str(rel))
        assert not violations, f"Direct core imports found: {violations}"

    def test_no_foundation_internal_imports(self):
        """Suite runtime code must use delta_extension_api, never Foundation internals."""
        violations = []
        pattern = re.compile(
            r"^\s*(?:from|import)\s+(?:integrations|packages)(?:\.|\s|$)",
            re.I | re.M,
        )
        for rel, text in _scan_files({".py"}, SKIP_DIRS):
            if _norm(rel) in GUARD_FILES or _norm(rel).startswith("tests/"):
                continue
            if pattern.search(text):
                violations.append(str(rel))
        assert not violations, f"Direct Foundation internal imports: {violations}"


class TestPublicExtensionApiOnly:
    """Suite advanced code must depend on the stable Foundation facade only."""

    def test_no_direct_foundation_internal_imports(self):
        violations = []
        pattern = re.compile(
            r"^\s*(?:from|import)\s+(?:integrations|packages)(?:\.|\s|$)",
            re.M,
        )
        for rel, text in _scan_files({".py"}, SKIP_DIRS):
            if not _norm(rel).startswith("advanced/"):
                continue
            if pattern.search(text):
                violations.append(str(rel))
        assert not violations, f"Foundation internal imports: {violations}"


class TestSuiteToolOwnership:
    """Suite must not rebuild Foundation baseline connector tools."""

    def test_connector_aggregation_excludes_foundation_baseline_builders(self):
        source = (ROOT / "advanced/connectors/connector_tools.py").read_text(encoding="utf-8")
        assert "build_browser_tools" not in source
        assert "make_email_tools" not in source
        assert "delta_extension_api.browser" not in source

    def test_suite_secret_lookup_uses_local_structural_contract(self):
        for relative in (
            "advanced/connectors/connector_tools.py",
            "advanced/connectors/connector_support.py",
            "advanced/connectors/tool_execution.py",
        ):
            source = (ROOT / relative).read_text(encoding="utf-8")
            assert "delta_extension_api.credentials" not in source
            assert "SecretStore" in source


class TestNoSecondAuthority:
    """Suite must not create a second runtime/authority plane."""

    def test_no_second_runtime(self):
        """No Suite code should create RuntimeHost/RuntimeHandle."""
        violations = []
        pattern = re.compile(r"\bRuntimeHost::new\s*\(|\bRuntimeHandle::spawn\s*\(")
        for rel, text in _scan_files({".rs", ".py"}, SKIP_DIRS):
            if str(rel) == "tests/test_suite_contract.py":
                continue
            if pattern.search(text):
                violations.append(str(rel))
        assert not violations, f"Second runtime authority: {violations}"

    def test_no_authority_construction(self):
        """No Suite code should directly construct Foundation authorities."""
        violations = []
        pattern = re.compile(
            r"\b(?:ModelAuthority|RuntimeAuthorities|MemoryStore|AutomationStore|"
            r"McpStore|SkillStore|ApplicationStore|ApprovalWriter)"
            r"::open\s*\("
        )
        for rel, text in _scan_files({".rs", ".py"}, SKIP_DIRS):
            if str(rel) == "tests/test_suite_contract.py":
                continue
            if pattern.search(text):
                violations.append(str(rel))
        assert not violations, f"Direct authority construction: {violations}"


class TestInstallEntryPoint:
    """Suite activation must be explicit and manifest-based."""

    def test_install_script_is_canonical_activation_path(self):
        config = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
        assert "entry-points" not in config["project"]
        assert config["project"]["scripts"]["delta-suite-install"] == "advanced.install:main"


class TestNoPrivateFunctionLeakage:
    """Suite-owned modules must expose explicit public cross-module helpers."""

    def test_no_private_import(self):
        """AST guard catches relative and parenthesized private imports."""
        violations = []
        for rel, text in _scan_files({".py"}, SKIP_DIRS):
            if _norm(rel) in GUARD_FILES or _norm(rel).startswith("tests/"):
                continue
            tree = ast.parse(text)
            for node in ast.walk(tree):
                if not isinstance(node, ast.ImportFrom):
                    continue
                module = node.module or ""
                suite_owned = (
                    node.level > 0
                    or module == "advanced"
                    or module.startswith("advanced.")
                )
                if not suite_owned:
                    continue
                for alias in node.names:
                    if alias.name.startswith("_") and not alias.name.startswith("__"):
                        violations.append(f"{rel}: {alias.name}")
        assert not violations, f"Private Suite imports: {violations}"


class TestFoundationCompatibilityPin:
    """Production compatibility must target an immutable Foundation revision."""

    def test_foundation_contract_is_immutable_and_version_aligned(self):
        config = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
        foundation = config["tool"]["delta-suite"]["foundation"]
        ref = foundation["git-ref"]
        version = foundation["version"]

        assert re.fullmatch(r"[0-9a-f]{40}", ref), ref
        assert foundation["capability-abi"] == 2
        assert foundation["worker-manifest"] == 1
        assert foundation["connector-catalog"] == 1

        dependencies = config["project"]["dependencies"]
        assert f"delta=={version}" in dependencies

        delta_source = config["tool"]["uv"]["sources"]["delta"]
        assert delta_source["git"] == "https://github.com/fongap-labs/delta.git"
        assert delta_source["rev"] == ref


class TestRepositoryBoundary:
    """Verify the repository boundary is maintained."""

    def test_no_forbidden_roots(self):
        """No forbidden top-level authority roots."""
        forbidden = {"apps", "core", "runtime", "trust", "state", "ledger", "vault"}
        for name in ROOT.iterdir():
            if name.is_dir() and name.name in forbidden:
                pytest.fail(f"Forbidden root: {name.name}")

    def test_allowed_roots_only(self):
        """Only approved top-level directories."""
        allowed = {
            ".github", "advanced", "docs", "scripts", "tests",
            ".gitignore", "README.md", "AGENTS.md", "CLAUDE.md",
            "PROVENANCE.md", "SECURITY.md",
            "CHANGELOG.md", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md",
            "pyproject.toml", "uv.lock", ".pre-commit-config.yaml",
        }
        for item in ROOT.iterdir():
            if (
                item.name.startswith(".git")
                or item.name.startswith(".pytest")
                or item.name.startswith(".ruff")
                or item.name in {"build", "dist"}
                or item.name.endswith(".egg-info")
            ):
                continue
            if item.is_file() or item.is_dir():
                assert item.name in allowed, f"Unapproved entry: {item.name}"


class TestCustomConnectorEndpointSafety:
    """User-configurable connector hosts must use the Foundation address guard."""

    def test_custom_endpoint_validators_require_address_checks(self):
        source = (ROOT / "advanced/connectors/descriptors.py").read_text(encoding="utf-8")
        for function_name in ("_validate_gitlab", "_validate_posthog"):
            start = source.index(f"def {function_name}")
            next_def = source.find("\ndef ", start + 4)
            block = source[start: next_def if next_def >= 0 else len(source)]
            assert "should_check_address=True" in block

    def test_custom_endpoint_runtime_requests_require_address_checks(self):
        cases = {
            "advanced/connectors/provider_developer.py": ("gitlab_api(profile)", 4),
            "advanced/connectors/provider_analytics_finance.py": ("_posthog_base(profile)", 2),
        }
        for relative, (needle, expected) in cases.items():
            source = (ROOT / relative).read_text(encoding="utf-8")
            assert source.count(needle) == expected
            position = 0
            for _ in range(expected):
                position = source.index(needle, position)
                call_start = source.rfind("execute_http_request(", 0, position)
                call_end = source.index("\n        )", position)
                block = source[call_start:call_end]
                assert "should_check_address=True" in block
                position += len(needle)
