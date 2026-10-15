"""The AdFilter build keeps every source and licence attribution out of the generated header."""

from __future__ import annotations

import importlib.util
import json

from kit_target import target_root

REPO_ROOT = target_root()
SEPARATOR = "! " + "-" * 50
ATTRIBUTION_PREFIXES = ("! Sources:", "! Licence:", "! Licence-Notice:")


def _build_class():
    spec = importlib.util.spec_from_file_location("ad_filter_build_under_test", REPO_ROOT / "bricks" / "ad_filter_build.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.execute


def _build(tmp_path, notices=None) -> list[str]:
    local = tmp_path / "local.txt"
    local.write_text("||ads.example^\n##.banner\n! a comment\n||ads.example^\n", encoding="utf-8")
    args = {"output_file": str(tmp_path / "out.txt"), "local_sources": [str(local)]}
    if notices is not None:
        args["source_notices"] = notices
    _build_class()(args).run()
    return (tmp_path / "out.txt").read_text(encoding="utf-8").split("\n")


def _header(lines: list[str]) -> list[str]:
    return lines[: lines.index(SEPARATOR)]


def _task_args() -> dict:
    task = json.loads((REPO_ROOT / "projects" / "AdFilter" / "task.json").read_text(encoding="utf-8"))
    return task["steps"][0]["args"]


def test_the_task_declares_no_source_notices():
    args = _task_args()
    variables = (REPO_ROOT / "projects" / "AdFilter" / ".env.variables").read_text(encoding="utf-8")
    sources = next(line for line in variables.splitlines() if line.startswith("ADFILTER_REMOTE_SOURCES="))
    assert sources.count("https://") == 7
    assert "source_notices" not in args
    assert args["output_file"] == "${ADFILTER_OUTPUT_FILE}"
    assert args["remote_sources"] == "${ADFILTER_REMOTE_SOURCES}"


def test_header_is_the_marker_and_the_metadata_comments_only(tmp_path):
    header = _header(_build(tmp_path))
    assert header[0] == "[Adblock Plus 2.0]"
    assert all(line.startswith("!") for line in header[1:]), "the header must stay Adblock Plus comments"
    assert [line.split(":")[0] for line in header[1:]] == ["! Title", "! Version", "! Expires", "! Count", "! Updated", "! Homepage"]
    assert not any(line.startswith(ATTRIBUTION_PREFIXES) for line in header)


def test_a_stale_source_notices_config_is_ignored(tmp_path):
    notices = [
        {"name": "AdGuard Base Filter", "licence": "GPL-3.0", "url": "https://github.com/AdguardTeam/AdguardFilters"},
        {"name": "CJX's Annoyance List\n||evil.example^", "licence": "LGPL-3.0"},
    ]
    lines = _build(tmp_path, notices)
    assert not any(line.startswith(ATTRIBUTION_PREFIXES) for line in lines)
    assert not any("evil.example" in line or "AdGuard" in line or "LGPL-3.0" in line for line in lines)


def test_count_and_rules_are_unchanged(tmp_path):
    lines = _build(tmp_path)
    assert "! Count:       2" in lines
    assert lines[lines.index(SEPARATOR) + 2 :] == ["##.banner", "||ads.example^"]
