#!/usr/bin/env python3
"""Validate changed configuration identifiers against central naming rules."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

PLATFORM_PREFIXES = ("RUNNER_", "ACTIONS_")
PLATFORM_NAMES = {
    "GH_TOKEN",
    "NODE_OPTIONS",
    "GITHUB_ACTION",
    "GITHUB_ACTIONS",
    "GITHUB_ACTOR",
    "GITHUB_ACTOR_ID",
    "GITHUB_API_URL",
    "GITHUB_BASE_REF",
    "GITHUB_ENV",
    "GITHUB_EVENT_NAME",
    "GITHUB_EVENT_PATH",
    "GITHUB_GRAPHQL_URL",
    "GITHUB_HEAD_REF",
    "GITHUB_JOB",
    "GITHUB_OUTPUT",
    "GITHUB_PATH",
    "GITHUB_REF",
    "GITHUB_REF_NAME",
    "GITHUB_REF_PROTECTED",
    "GITHUB_REF_TYPE",
    "GITHUB_REPOSITORY",
    "GITHUB_REPOSITORY_ID",
    "GITHUB_REPOSITORY_OWNER",
    "GITHUB_REPOSITORY_OWNER_ID",
    "GITHUB_RETENTION_DAYS",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_NUMBER",
    "GITHUB_SERVER_URL",
    "GITHUB_SHA",
    "GITHUB_STEP_SUMMARY",
    "GITHUB_TRIGGERING_ACTOR",
    "GITHUB_WORKFLOW",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_WORKFLOW_SHA",
    "GITHUB_WORKSPACE",
}
TOKEN_RE = re.compile(r"\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b")


def parts(name: str) -> list[str]:
    return [part for part in name.strip("_").split("_") if part]


def changed_paths(root: Path, base: str, head: str) -> list[Path]:
    proc = subprocess.run(
        ["git", "diff", "--name-only", "--diff-filter=ACMR", base, head],
        cwd=root,
        check=True,
        text=True,
        stdout=subprocess.PIPE,
    )
    return [Path(raw) for raw in proc.stdout.splitlines() if raw and (root / raw).is_file()]


def should_scan(path: Path) -> bool:
    if path.parts[:2] == (".github", "workflows") and path.suffix.lower() in {".yml", ".yaml"}:
        return True
    if path.name in {".env.variables", ".secrets.required", ".dev.vars.example"}:
        return True
    if path.name == "wrangler.jsonc":
        return True
    if path.parts and path.parts[0] == "config" and path.suffix.lower() in {".json", ".jsonc", ".toml", ".yml", ".yaml"}:
        return True
    return False


def is_platform_name(name: str) -> bool:
    return name in PLATFORM_NAMES or name.startswith(PLATFORM_PREFIXES)


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: validate-config-naming.py <base-sha> <head-sha>", file=sys.stderr)
        return 64

    root = Path.cwd()
    errors: list[str] = []
    checked = 0

    for path in changed_paths(root, sys.argv[1], sys.argv[2]):
        if not should_scan(path):
            continue
        checked += 1
        text = (root / path).read_text(encoding="utf-8")
        for name in sorted(set(TOKEN_RE.findall(text))):
            if is_platform_name(name):
                continue
            if len(parts(name)) > 3:
                errors.append(f"{path.as_posix()}: configuration name '{name}' exceeds three segments")
            if name.startswith("GH_") and name != "GH_TOKEN":
                errors.append(f"{path.as_posix()}: custom GitHub configuration '{name}' must use GITHUB_")
            if name.startswith("CF_"):
                errors.append(f"{path.as_posix()}: custom Cloudflare configuration '{name}' must use CLOUDFLARE_")
            if name.endswith("_PAT") or "_PAT_" in name:
                errors.append(f"{path.as_posix()}: credential '{name}' must use TOKEN or KEY instead of PAT")

    if errors:
        print("configuration naming violations:", file=sys.stderr)
        for error in sorted(set(errors)):
            print(f"  {error}", file=sys.stderr)
        return 1

    print(f"configuration naming conventions passed ({checked} changed config files)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
