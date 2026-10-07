"""The AdFilter build names each source and its licence in comment lines of the generated header."""

from __future__ import annotations

import importlib.util
import json

import pytest
from kit_target import target_root

REPO_ROOT = target_root()
SEPARATOR = "! " + "-" * 50


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


def _task_notices() -> list[dict]:
    task = json.loads((REPO_ROOT / "projects" / "AdFilter" / "task.json").read_text(encoding="utf-8"))
    return task["steps"][0]["args"]["source_notices"]


def test_the_task_declares_a_licence_for_every_remote_source():
    variables = (REPO_ROOT / "projects" / "AdFilter" / ".env.variables").read_text(encoding="utf-8")
    sources = next(line for line in variables.splitlines() if line.startswith("ADFILTER_REMOTE_SOURCES="))
    assert sources.count("https://") == 7
    notices = _task_notices()
    assert len(notices) == 7
    assert all(item["name"] and item["licence"] for item in notices)


def test_header_lists_sources_and_licences_as_comments(tmp_path):
    lines = _build(tmp_path, _task_notices())
    header = _header(lines)
    text = "\n".join(header)
    assert header[0] == "[Adblock Plus 2.0]"
    assert all(line.startswith("!") for line in header[1:]), "the header must stay Adblock Plus comments"
    assert "! Sources:" in header and "! Licence:" in header
    assert any(line.startswith("! Licence-Notice:") and "output/adfilter/NOTICE" in line for line in header)
    for notice in _task_notices():
        assert f"!   {notice['name']}: {notice['licence']}" in header
    assert "GPL-3.0" in text and "LGPL-3.0" in text and "CC BY 3.0" in text


def test_count_and_rules_are_unchanged_by_the_notice_lines(tmp_path):
    lines = _build(tmp_path, _task_notices())
    assert "! Count:       2" in lines
    assert lines[lines.index(SEPARATOR) + 2 :] == ["##.banner", "||ads.example^"]


def test_without_notices_the_header_is_the_original_one(tmp_path):
    header = _header(_build(tmp_path))
    assert [line.split(":")[0] for line in header[1:]] == ["! Title", "! Version", "! Expires", "! Count", "! Updated", "! Homepage"]


def test_a_configured_value_cannot_start_a_rule_line(tmp_path):
    lines = _build(tmp_path, [{"name": "x\n||evil.example^", "licence": "y\r\n##.evil"}])
    assert not any(line.startswith(("||evil", "##.evil")) for line in lines)
    assert all(line.startswith("!") for line in _header(lines)[1:])


@pytest.mark.parametrize("bad", [[{"name": "only a name"}], ["a string"], "not json"])
def test_incomplete_notices_are_rejected(tmp_path, bad):
    with pytest.raises(ValueError, match="PARAM_ERROR"):
        _build(tmp_path, bad)
