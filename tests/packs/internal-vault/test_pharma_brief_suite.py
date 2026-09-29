"""Merged suite. Sections keep their original order:
  - test_pharma_brief.py
  - test_pharma_brief_publish.py
  - test_pharma_brief_publish_meta.py
  - test_pharma_brief_resilient.py
  - test_pharma_brief_runtime.py
  - test_pharma_brief_semantic_decision.py
  - test_pharma_brief_visual.py
  - test_pharma_brief_weekly.py
"""

from pathlib import Path
import pytest
from bricks.pharma_brief_build import (
    _derive_event_signal,
    _derive_week_signal,
    _editorial_header,
    _merge_candidates,
    _normalize_events,
    _normalize_scores,
    _parse_source_catalog,
    _select_deep_candidates,
    execute as PharmaBriefBuilder,
)
from preflight.validate_task import validate_task
import json
from bricks.pharma_brief_publish import execute as execute__pharma_brief_publish
from bricks.pharma_brief_publish_meta import _publish_meta, _topic_tags, execute as execute__pharma_brief_publish_meta
from bricks.pharma_brief_resilient import _local_executive_view, _local_sections, execute as execute__pharma_brief_resilient
import requests
from bricks import pharma_brief_resilient as resilient
from bricks.pharma_brief_runtime import execute as execute__pharma_brief_runtime
from bricks.pharma_brief_source_runtime import execute as SourceRuntime
from bricks.card_visual import LAYOUT_CARD, STYLE_NOTEBOOK, TONE_PROFESSIONAL
from bricks.pharma_brief_visual import (
    _LAYOUT_TYPE,
    _VISUAL_STYLE,
    _VISUAL_TONE,
    _extract_metric,
    _page_html as _page_html__pharma_brief_visual,
    _topic_card,
    _week_label,
    execute as PharmaBriefVisual,
)
from bricks.pharma_brief_weekly import (
    _clip_text,
    _english_heavy,
    _event_block,
    _merge_reader_fields,
    _page_html as _page_html__pharma_brief_weekly,
    _quality_issues,
    _sanitize_final,
    execute as PharmaBriefWeekly,
)


# ==========================================================================
# from test_pharma_brief.py
# ==========================================================================

def test_parse_source_catalog_supports_priorities_and_extended_kinds():
    value = (
        "P0|regulatory|FDA|https://example.com/fda,"
        "P1|company|Pfizer|https://example.com/pfizer,"
        "P4|technology|Nature|https://example.com/nature,"
        "P4|regional|Nikkei|https://example.com/nikkei"
    )
    sources = _parse_source_catalog(value)
    assert [item["priority"] for item in sources] == ["P0", "P1", "P4", "P4"]
    assert [item["kind"] for item in sources] == ["regulatory", "company", "technology", "regional"]

def test_parse_source_catalog_keeps_legacy_three_field_format():
    sources = _parse_source_catalog("regulatory|FDA|https://example.com/fda")
    assert sources[0]["priority"] == "P3"
    assert sources[0]["kind"] == "regulatory"

def test_parse_source_catalog_accepts_multiline_and_comments():
    value = """
# P0
P0|regulatory|FDA|https://example.com/fda
P1|company|Pfizer|https://example.com/pfizer
"""
    sources = _parse_source_catalog(value)
    assert [item["name"] for item in sources] == ["FDA", "Pfizer"]

def test_parse_source_catalog_rejects_unknown_kind():
    with pytest.raises(ValueError, match="SOURCE_CONFIG_ERROR"):
        _parse_source_catalog("P3|community|demo|https://example.com")

def test_score_formula_is_deterministic():
    scores = _normalize_scores({
        "strategic_impact": 10, "industry_impact": 8, "capital_impact": 6,
        "execution_risk": 4, "confidence": 9, "scope": 7, "novelty": 5,
    })
    assert scores["overall_score"] == 7.8

def test_signal_rules_cover_opportunity_caution_disruption_and_mixed():
    assert _derive_event_signal(_normalize_scores({
        "strategic_impact": 6, "industry_impact": 6, "capital_impact": 8,
        "execution_risk": 5, "confidence": 8, "scope": 7, "novelty": 7,
    })) == "opportunity"
    assert _derive_event_signal(_normalize_scores({
        "strategic_impact": 7, "industry_impact": 6, "capital_impact": 5,
        "execution_risk": 8, "confidence": 8, "scope": 6, "novelty": 6,
    })) == "caution"
    assert _derive_event_signal(_normalize_scores({
        "strategic_impact": 9, "industry_impact": 9, "capital_impact": 7,
        "execution_risk": 8, "confidence": 8, "scope": 8, "novelty": 8,
    })) == "disruption"
    assert _derive_event_signal(_normalize_scores({
        "strategic_impact": 9, "industry_impact": 3, "capital_impact": 9,
        "execution_risk": 3, "confidence": 8, "scope": 7, "novelty": 8,
    })) == "mixed"

def _event__pharma_brief(idx: int, **overrides):
    value = {
        "id": f"E{idx}",
        "event_key": f"company|asset|event-{idx}",
        "category": "deal",
        "title": f"event-{idx}",
        "fact": "fact",
        "why_it_matters": "why",
        "industry_implication": "industry",
        "company_implication": "company",
        "capital_implication": "capital",
        "next_watch": ["watch"],
        "source_refs": ["FDA"],
        "scores": {
            "strategic_impact": 7,
            "industry_impact": 7,
            "capital_impact": 7,
            "execution_risk": 4,
            "confidence": 8,
            "scope": 7,
            "novelty": 7,
        },
    }
    value.update(overrides)
    return value

def _builder__pharma_brief(sources: str) -> PharmaBriefBuilder:
    return PharmaBriefBuilder({
        "api_key": "key",
        "base_url": "https://api.example.com/v1",
        "model": "demo",
        "sources": sources,
        "source_extract_chars": 2600,
        "candidate_batch_chars": 9000,
        "max_candidate_events": 40,
        "max_deep_analysis_events": 20,
        "max_calls": 48,
        "token_budget": 500000,
        "llm_min_interval_seconds": 0,
    })

def test_event_selection_keeps_normal_events_bounded():
    source_map = {"FDA": {"priority": "P0", "kind": "regulatory", "name": "FDA", "url": "https://example.com"}}
    selected = _normalize_events([_event__pharma_brief(idx) for idx in range(10)], source_map)
    assert 5 <= len(selected) <= 8

def test_black_swan_is_critical_and_forced_beyond_normal_limit():
    source_map = {"FDA": {"priority": "P0", "kind": "regulatory", "name": "FDA", "url": "https://example.com"}}
    events = [_event__pharma_brief(idx) for idx in range(10)]
    events.append(_event__pharma_brief(
        99,
        title="全球召回触发供应中断",
        fact="监管机构宣布全球召回并造成关键药品供应中断",
        black_swan=True,
        scores={
            "strategic_impact": 10, "industry_impact": 10, "capital_impact": 9,
            "execution_risk": 10, "confidence": 9, "scope": 10, "novelty": 10,
        },
    ))
    selected = _normalize_events(events, source_map)
    critical = [event for event in selected if event["alert_level"] == "CRITICAL"]
    assert critical
    assert critical[0]["black_swan"] is True
    assert len(selected) == 9

def test_p3_single_source_caps_confidence_and_conflict_caps_to_six():
    source_map = {"Media": {"priority": "P3", "kind": "industry", "name": "Media", "url": "https://example.com"}}
    event = _event__pharma_brief(1, source_refs=["Media"], evidence_conflict=True, conflict_note="金额口径不一致")
    selected = _normalize_events([event], source_map)
    assert selected[0]["scores"]["confidence"] <= 6
    assert selected[0]["evidence_conflict"] is True

def test_change_detection_marks_escalation_from_previous_week():
    source_map = {"FDA": {"priority": "P0", "kind": "regulatory", "name": "FDA", "url": "https://example.com"}}
    previous = {
        "company|asset|event-1": {
            "event_key": "company|asset|event-1",
            "alert_level": "WATCH",
            "signal": "neutral",
            "scores": {"overall_score": 5.0},
            "black_swan": False,
        }
    }
    event = _event__pharma_brief(1, scores={
        "strategic_impact": 9, "industry_impact": 9, "capital_impact": 8,
        "execution_risk": 8, "confidence": 9, "scope": 8, "novelty": 8,
    })
    selected = _normalize_events([event], source_map, previous)
    assert selected[0]["change"] == "escalated"

def test_candidate_merge_clusters_same_event_and_preserves_evidence():
    candidates = [
        {"event_key": "a|b|approval", "title": "A", "fact": "x", "source_refs": ["FDA"], "importance": 8},
        {"event_key": "a|b|approval", "title": "A2", "fact": "longer fact", "source_refs": ["Company"], "importance": 9},
    ]
    merged = _merge_candidates(candidates, 40)
    assert len(merged) == 1
    assert set(merged[0]["source_refs"]) == {"FDA", "Company"}

def test_builder_does_not_cap_configured_sources():
    catalog = ",".join(f"P3|industry|S{i}|https://example.com/{i}" for i in range(25))
    builder = _builder__pharma_brief(catalog)
    assert len(builder.sources) == 25

def test_candidate_batches_bound_request_size():
    catalog = ",".join(f"P3|industry|S{i}|https://example.com/{i}" for i in range(8))
    builder = _builder__pharma_brief(catalog)
    sources = [
        {**source, "text": "x" * 5000, "quality_score": 100}
        for source in builder.sources
    ]
    batches = builder._batches(sources)
    assert len(batches) >= 3
    assert max(len(batch) for batch in batches) <= 3

def test_failed_batch_splits_until_single_source(monkeypatch):
    builder = _builder__pharma_brief("P0|regulatory|A|https://example.com/a,P1|company|B|https://example.com/b")
    batch = [
        {**builder.sources[0], "text": "A 本周发布重大监管更新 " * 20},
        {**builder.sources[1], "text": "B 本周发布管线更新 " * 20},
    ]

    def fake_extract(items):
        if len(items) > 1:
            raise RuntimeError("504")
        return [{
            "event_key": f"k|{items[0]['name']}",
            "category": "competition",
            "title": items[0]["name"],
            "fact": "fact",
            "source_refs": [items[0]["name"]],
            "importance": 8,
            "black_swan_hint": False,
        }]

    monkeypatch.setattr(builder, "_extract_candidates", fake_extract)
    result = builder._extract_candidates_resilient(batch)
    assert {item["source_refs"][0] for item in result} == {"A", "B"}

def test_single_high_priority_failure_uses_conservative_fallback(monkeypatch):
    builder = _builder__pharma_brief("P0|regulatory|FDA|https://example.com/fda")
    source = {**builder.sources[0], "text": "FDA announces a major drug safety update with additional restrictions."}
    monkeypatch.setattr(builder, "_extract_candidates", lambda items: (_ for _ in ()).throw(RuntimeError("504")))
    result = builder._extract_candidates_resilient([source])
    assert result
    assert result[0]["source_refs"] == ["FDA"]
    assert result[0]["fallback"] is True

def test_single_p4_failure_does_not_promote_unverified_lead(monkeypatch):
    builder = _builder__pharma_brief("P4|sentiment|Forum|https://example.com/forum")
    source = {**builder.sources[0], "text": "市场传闻很多但没有一手证据 " * 20}
    monkeypatch.setattr(builder, "_extract_candidates", lambda items: (_ for _ in ()).throw(RuntimeError("429")))
    assert builder._extract_candidates_resilient([source]) == []

def test_deep_analysis_prefers_high_priority_evidence_and_keeps_black_swan():
    source_map = {
        "FDA": {"priority": "P0"},
        "Media": {"priority": "P3"},
    }
    candidates = [
        {"title": "media", "source_refs": ["Media"], "importance": 10, "black_swan_hint": False},
        {"title": "official", "source_refs": ["FDA"], "importance": 7, "black_swan_hint": False},
        {"title": "critical", "source_refs": ["Media"], "importance": 9, "black_swan_hint": True},
    ]
    selected = _select_deep_candidates(candidates, source_map, 1)
    assert selected[0]["title"] == "critical"
    assert any(item["title"] == "official" for item in selected)

def test_editorial_header_enforces_title_and_overview_limits():
    final = {"hook_title": "这是一条超过二十个字符长度的全球制药行业观察标题需要被截断", "overview": "概" * 200}
    title, overview = _editorial_header(final)
    assert len(title) <= 20
    assert len(overview) <= 140

def test_week_signal_detects_mixed_top_events():
    events = [
        {"signal": "opportunity", "scores": {"overall_score": 8.2}, "black_swan": False},
        {"signal": "caution", "scores": {"overall_score": 7.8}, "black_swan": False},
        {"signal": "neutral", "scores": {"overall_score": 7.0}, "black_swan": False},
    ]
    assert _derive_week_signal(events) == "mixed"

def test_pharmabrief_task_passes_real_validator():
    validate_task(Path("projects/PharmaBrief/task.json"))

# ==========================================================================
# from test_pharma_brief_publish.py
# ==========================================================================

def _runner__pharma_brief_publish(tmp_path, *, fail_on_skip=False):
    return execute__pharma_brief_publish({"source_dir": str(tmp_path), "fail_on_skip": fail_on_skip})

def test_publish_guard_treats_skip_as_successful_noop(tmp_path):
    edition = tmp_path / "2026-09-14"
    edition.mkdir(parents=True)
    (edition / "manifest.json").write_text(
        json.dumps({"status": "skip", "content": {"skip_reason": "可靠候选事件不足"}}, ensure_ascii=False),
        encoding="utf-8",
    )
    result = _runner__pharma_brief_publish(tmp_path).run()
    assert result["success"] is True
    assert result["artifacts"]["publication_ready"] is False
    assert result["artifacts"]["status"] == "skip"
    assert result["artifacts"]["reason"] == "可靠候选事件不足"

def test_publish_guard_can_fail_on_skip(tmp_path):
    edition = tmp_path / "2026-09-14"
    edition.mkdir(parents=True)
    (edition / "manifest.json").write_text(
        json.dumps({"status": "skip", "content": {"skip_reason": "insufficient evidence"}}),
        encoding="utf-8",
    )
    with pytest.raises(RuntimeError, match="PHARMABRIEF_SKIP_DIAGNOSTIC"):
        _runner__pharma_brief_publish(tmp_path, fail_on_skip=True).run()

def test_publish_guard_fails_without_manifest(tmp_path):
    with pytest.raises(RuntimeError, match="PHARMABRIEF_NO_PUBLICATION.*manifest not found"):
        _runner__pharma_brief_publish(tmp_path).run()

def test_publish_guard_fails_for_unknown_status(tmp_path):
    edition = tmp_path / "2026-09-14"
    edition.mkdir(parents=True)
    (edition / "manifest.json").write_text(json.dumps({"status": "unknown"}), encoding="utf-8")
    with pytest.raises(RuntimeError, match="PHARMABRIEF_NO_PUBLICATION.*unexpected manifest status"):
        _runner__pharma_brief_publish(tmp_path).run()

def test_publish_guard_marks_publish_manifest_ready(tmp_path):
    edition = tmp_path / "2026-09-14"
    edition.mkdir(parents=True)
    (edition / "manifest.json").write_text(json.dumps({"status": "publish"}), encoding="utf-8")
    result = _runner__pharma_brief_publish(tmp_path).run()
    assert result["success"] is True
    assert result["artifacts"]["status"] == "publish"
    assert result["artifacts"]["publication_ready"] is True

# ==========================================================================
# from test_pharma_brief_publish_meta.py
# ==========================================================================

def _content():
    return {
        "hook_title": "诺和诺德儿童减重数据亮眼，",
        "overview": "诺和诺德STEP Young试验显示儿童减重显著获益；FDA监管动态和小细胞肺癌临床数据也值得关注。",
        "events": [
            {
                "category": "clinical",
                "title": "司美格鲁肽儿童肥胖III期数据积极",
                "fact": "GLP-1在儿童肥胖人群显示减重获益。",
                "why_it_matters": "儿童肥胖适应症可能扩大GLP-1市场。",
                "industry_implication": "肥胖治疗竞争继续加剧。",
                "company_implication": "企业需关注后续适应症扩展。",
                "source_refs": ["NovoNordisk"],
            },
            {
                "category": "regulatory",
                "title": "FDA发布新的监管信息",
                "fact": "监管变化需要持续跟踪。",
                "source_refs": ["FDA"],
            },
            {
                "category": "deal",
                "title": "药企资产交易继续活跃",
                "fact": "交易活动反映资源配置变化。",
                "source_refs": ["Novartis"],
            },
        ],
    }

def _write_manifest(out, date="2026-09-13", status="publish", content=None):
    out.mkdir(parents=True)
    manifest = {
        "schema_version": 2,
        "project": "PharmaBrief",
        "date": date,
        "status": status,
        "content": content if content is not None else _content(),
    }
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")

def test_publish_meta_contract():
    meta = _publish_meta(_content())
    assert meta["title"] == "诺和诺德儿童减重数据亮眼"
    assert len(meta["title"]) <= 20
    assert len(meta["intro"]) <= 120
    assert len(meta["tags"]) == 5
    assert len(set(meta["tags"])) == 5
    assert "GLP-1" in meta["tags"]

def test_publish_meta_clips_long_intro_to_120():
    content = _content()
    content["overview"] = "概" * 180
    meta = _publish_meta(content)
    assert len(meta["intro"]) == 120

def test_topic_tags_are_content_driven_and_unique():
    tags = _topic_tags(_content())
    assert len(tags) == 5
    assert tags[0] == "GLP-1"
    assert "减重与肥胖" in tags
    assert "临床研发" in tags
    assert len(set(tags)) == 5

def test_execute_writes_publish_md_and_manifest_metadata(tmp_path):
    out = tmp_path / "2026-09-13"
    _write_manifest(out)

    result = execute__pharma_brief_publish_meta({"output_dir": str(tmp_path), "date": "2026-09-13"}).run()

    assert result["success"] is True
    assert result["artifacts"]["date"] == "2026-09-13"
    assert result["artifacts"]["status"] == "publish"
    publish = (out / "publish.md").read_text(encoding="utf-8")
    assert "**标题**：诺和诺德儿童减重数据亮眼" in publish
    assert "**引言**：" in publish
    assert publish.count("#") >= 6  # heading + five tags

    updated = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert updated["publish"]["title"] == "诺和诺德儿童减重数据亮眼"
    assert len(updated["publish"]["intro"]) <= 120
    assert len(updated["publish"]["tags"]) == 5

def test_execute_skips_metadata_for_skip_manifest(tmp_path):
    out = tmp_path / "2026-09-13"
    _write_manifest(
        out,
        status="skip",
        content={"skip_reason": "Pro判断可靠事件不足", "events": []},
    )
    (out / "publish.md").write_text("stale", encoding="utf-8")

    result = execute__pharma_brief_publish_meta({"output_dir": str(tmp_path), "date": "2026-09-13"}).run()

    assert result["success"] is True
    assert result["artifacts"]["status"] == "skip"
    assert result["artifacts"]["published"] is False
    assert result["artifacts"]["reason"] == "Pro判断可靠事件不足"
    assert not (out / "publish.md").exists()
    updated = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert "publish" not in updated

def test_execute_uses_generated_manifest_when_run_crosses_midnight(tmp_path):
    out = tmp_path / "2026-09-13"
    _write_manifest(out, date="2026-09-13")

    result = execute__pharma_brief_publish_meta({"output_dir": str(tmp_path)}).run()

    assert result["success"] is True
    assert result["artifacts"]["date"] == "2026-09-13"
    assert (out / "publish.md").is_file()

def test_explicit_missing_date_does_not_silently_use_another_edition(tmp_path):
    _write_manifest(tmp_path / "2026-09-13", date="2026-09-13")

    with pytest.raises(RuntimeError, match="manifest not found"):
        execute__pharma_brief_publish_meta({"output_dir": str(tmp_path), "date": "2026-09-14"}).run()

# ==========================================================================
# from test_pharma_brief_resilient.py
# ==========================================================================

def _event__pharma_brief_resilient(idx: int, category: str, *, industry=7, capital=6, risk=4):
    return {
        "id": f"E{idx:02d}",
        "event_key": f"event-{idx}",
        "category": category,
        "title": f"事件{idx}",
        "fact": f"事实{idx}",
        "why_it_matters": f"影响{idx}",
        "industry_implication": f"产业影响{idx}",
        "company_implication": f"经营影响{idx}",
        "capital_implication": f"资本影响{idx}",
        "next_watch": [f"观察{idx}"],
        "source_refs": ["FDA"],
        "evidence_conflict": False,
        "conflict_note": "",
        "black_swan": False,
        "alert_level": "WATCH",
        "scores": {
            "strategic_impact": 8,
            "industry_impact": industry,
            "capital_impact": capital,
            "execution_risk": risk,
            "confidence": 8,
            "scope": 7,
            "novelty": 7,
        },
    }

def _builder__pharma_brief_resilient(sources="P0|regulatory|FDA|https://example.com/fda"):
    return execute__pharma_brief_resilient({
        "api_key": "key",
        "base_url": "https://api.example.com/v1",
        "model": "Air",
        "sources": sources,
        "llm_min_interval_seconds": 0,
    })

def test_local_sections_always_derive_three_topics_when_three_events_exist():
    events = [
        _event__pharma_brief_resilient(1, "regulatory", industry=9),
        _event__pharma_brief_resilient(2, "deal", capital=9),
        _event__pharma_brief_resilient(3, "competition", risk=9),
        _event__pharma_brief_resilient(4, "clinical", industry=8),
    ]
    sections = _local_sections(events)

    assert set(sections) == {"rd", "capital", "risk"}
    assert len(sections["rd"]) == 3
    assert len(sections["capital"]) == 3
    assert len(sections["risk"]) == 3

def test_local_executive_view_uses_existing_event_implications():
    events = [
        _event__pharma_brief_resilient(1, "regulatory", industry=9),
        _event__pharma_brief_resilient(2, "deal", capital=9),
        _event__pharma_brief_resilient(3, "competition", risk=9),
    ]
    view = _local_executive_view(events)

    assert view["industry"] == "产业影响1"
    assert view["business"] == "经营影响1"
    assert view["watch_3_12m"] == ["观察1", "观察2", "观察3"]

def test_synthesis_requests_compact_json_and_derives_sections_locally():
    builder = _builder__pharma_brief_resilient()
    calls = []

    def fake_llm(system, user, max_tokens, *, max_attempts=5, **kwargs):
        calls.append((system, user, max_tokens, max_attempts))
        return {
            "status": "publish",
            "hook_title": "监管与研发继续推进",
            "overview": "本周监管、研发和资本配置均有重要变化。",
            "events": [
                _event__pharma_brief_resilient(1, "regulatory", industry=9),
                _event__pharma_brief_resilient(2, "deal", capital=9),
                _event__pharma_brief_resilient(3, "competition", risk=9),
            ],
        }

    builder._llm = fake_llm
    result = builder._synthesize([], {})

    assert calls[0][2] == 3200
    assert '"sections"' not in calls[0][1]
    assert '"executive_view"' not in calls[0][1]
    assert len(result["sections"]["rd"]) == 3
    assert len(result["sections"]["capital"]) == 3
    assert len(result["sections"]["risk"]) == 3
    assert result["executive_view"]["watch_3_12m"] == ["观察1", "观察2", "观察3"]

def test_candidate_supplement_uses_only_high_trust_fetched_sources():
    sources = (
        "P0|regulatory|FDA|https://example.com/fda,"
        "P1|company|Pfizer|https://example.com/pfizer,"
        "P2|clinical|ClinicalTrialsGov|https://example.com/ct,"
        "P3|industry|Media|https://example.com/media"
    )
    builder = _builder__pharma_brief_resilient(sources)
    good = [
        {**source, "text": f"{source['name']} 本周发布可核验更新，涉及药物研发与监管进展。", "quality_score": 90}
        for source in builder.sources
    ]
    existing = [{
        "event_key": "existing",
        "category": "regulatory",
        "title": "已有事件",
        "fact": "已有事实",
        "source_refs": ["FDA"],
        "importance": 9,
        "black_swan_hint": False,
    }]

    result = builder._supplement_candidates(existing, good, minimum=3)
    refs = {ref for item in result for ref in (item.get("source_refs") or [])}

    assert len(result) >= 3
    assert "FDA" in refs
    assert "Pfizer" in refs
    assert "ClinicalTrialsGov" in refs
    assert "Media" not in refs
    assert any(item.get("fallback") for item in result)

def test_skip_run_returns_success_and_writes_skip_manifest(tmp_path):
    builder = _builder__pharma_brief_resilient()
    builder.out = tmp_path / "2026-09-14"
    fetched = [{
        **builder.sources[0],
        "ok": True,
        "quality_score": 90,
    }]

    result = builder._skip_run(
        started=0.0,
        fetched=fetched,
        good=fetched,
        candidates=[],
        reason="可靠候选事件不足",
    )

    assert result["success"] is True
    assert result["artifacts"]["status"] == "skip"
    manifest = (builder.out / "manifest.json").read_text(encoding="utf-8")
    assert '"status": "skip"' in manifest
    assert "可靠候选事件不足" in manifest

def test_run_retries_once_when_first_synthesis_underproduces_events(tmp_path):
    sources = (
        "P0|regulatory|FDA|https://example.com/fda,"
        "P1|industry|STAT|https://example.com/stat,"
        "P2|clinical|ClinicalTrialsGov|https://example.com/ct,"
        "P2|regulatory|EMA|https://example.com/ema"
    )
    builder = _builder__pharma_brief_resilient(sources)
    builder.out = tmp_path / "2026-09-14"

    fetched = [
        {**source, "ok": True, "content_hash": f"h{idx}", "quality_score": 90}
        for idx, source in enumerate(builder.sources, 1)
    ]
    candidates = [
        {
            "event_key": f"candidate-{idx}",
            "category": category,
            "title": f"候选{idx}",
            "fact": f"候选事实{idx}",
            "source_refs": [builder.sources[idx - 1]["name"]],
        }
        for idx, category in enumerate(("regulatory", "clinical", "deal"), 1)
    ]
    first_events = [_event__pharma_brief_resilient(1, "regulatory"), _event__pharma_brief_resilient(2, "clinical")]
    recovered_events = first_events + [_event__pharma_brief_resilient(3, "deal")]
    retries = []
    writes = []

    builder._fetch = lambda spec: fetched[builder.sources.index(spec)]
    builder._batches = lambda good: [good]
    builder._extract_candidates_resilient = lambda batch: candidates
    builder._supplement_candidates = lambda items, good, minimum=3: candidates
    builder._select_deep_candidates = lambda items: candidates
    builder._load_history = lambda: {}
    builder._synthesize = lambda items, previous: {
        "status": "skip",
        "hook_title": "第一次综合",
        "overview": "第一次仅形成两个事件。",
        "events": first_events,
    }

    def retry(items, previous, first_final):
        retries.append((items, previous, first_final))
        return {
            "status": "skip",
            "hook_title": "收敛完成",
            "overview": "二次收敛形成三个事件。",
            "events": recovered_events,
        }

    builder._retry_synthesis = retry
    builder._normalize_events = lambda raw, previous: list(raw or [])
    builder._editorial_header = lambda final: None
    builder._write_outputs = lambda final, events, signal, fetched_rows, candidate_rows, deep_rows, status: writes.append((final, events, status))
    builder._render = lambda pages, signal, critical: []
    builder._build_pages = lambda final, events, signal: []

    result = builder.run()

    assert len(retries) == 1
    assert result["artifacts"]["status"] == "publish"
    assert result["artifacts"]["event_count"] == 3
    assert writes[-1][0]["status"] == "publish"
    assert writes[-1][2] == "publish"
    assert len(writes[-1][1]) == 3

# ==========================================================================
# from test_pharma_brief_runtime.py
# ==========================================================================

def _runner__pharma_brief_runtime(tmp_path):
    return execute__pharma_brief_runtime({
        "api_key": "key",
        "base_url": "https://api.example.com/v1",
        "model": "Pro",
        "sources": "P0|regulatory|FDA|https://example.com/fda",
        "output_dir": str(tmp_path),
        "llm_min_interval_seconds": 0,
    })

def test_runtime_adds_one_json_only_recovery_call(tmp_path, monkeypatch):
    calls = []

    def fake_llm(self, system, user, max_tokens, *, max_attempts=5):
        calls.append((system, user, max_attempts))
        if len(calls) == 1:
            raise ValueError("LLM_RESPONSE_ERROR: model output does not contain JSON")
        return {"status": "publish", "events": []}

    monkeypatch.setattr(resilient.execute, "_llm", fake_llm, raising=True)
    runner = _runner__pharma_brief_runtime(tmp_path)

    result = runner._llm("system", "user", 1000, max_attempts=2)

    assert result["status"] == "publish"
    assert len(calls) == 2
    assert calls[0][2] == 2
    assert calls[1][2] == 1
    assert "格式纠偏重试" in calls[1][0]
    assert "严格按上述结构重新输出完整JSON" in calls[1][1]

def test_runtime_gives_final_synthesis_a_bounded_5xx_recovery_window(tmp_path, monkeypatch):
    calls = []
    sleeps = []

    def fake_llm(self, system, user, max_tokens, *, max_attempts=5):
        calls.append(max_attempts)
        if len(calls) == 1:
            response = requests.Response()
            response.status_code = 502
            raise requests.HTTPError("502 Bad Gateway", response=response)
        return {"status": "publish", "events": [{"id": "E1"}, {"id": "E2"}, {"id": "E3"}]}

    monkeypatch.setattr(resilient.execute, "_llm", fake_llm, raising=True)
    monkeypatch.setattr("bricks.pharma_brief_runtime.time.sleep", lambda seconds: sleeps.append(seconds))
    runner = _runner__pharma_brief_runtime(tmp_path)

    result = runner._llm("system", "user", 1000, max_attempts=4, _gateway_recovery=True)

    assert result["status"] == "publish"
    assert calls == [4, 5]
    assert sleeps == [8.0]

def test_runtime_does_not_slow_candidate_extraction_on_5xx(tmp_path, monkeypatch):
    calls = []

    def fake_llm(self, system, user, max_tokens, *, max_attempts=5):
        calls.append(max_attempts)
        response = requests.Response()
        response.status_code = 503
        raise requests.HTTPError("503 Service Unavailable", response=response)

    monkeypatch.setattr(resilient.execute, "_llm", fake_llm, raising=True)
    runner = _runner__pharma_brief_runtime(tmp_path)

    try:
        runner._llm("system", "user", 1000, max_attempts=2)
    except requests.HTTPError:
        pass
    else:
        raise AssertionError("candidate extraction 5xx must propagate to the existing source fallback path")

    assert calls == [2]

def test_runtime_repairs_missing_skip_reason(tmp_path, monkeypatch):
    out = tmp_path / "2026-09-14"
    out.mkdir(parents=True)
    manifest_path = out / "manifest.json"
    manifest_path.write_text(
        json.dumps({
            "status": "skip",
            "content": {"events": []},
        }, ensure_ascii=False),
        encoding="utf-8",
    )

    def fake_run(self):
        return {
            "success": True,
            "message": "skip",
            "artifacts": {
                "output_dir": str(out),
                "status": "skip",
                "candidate_event_count": 3,
                "event_count": 1,
            },
        }

    monkeypatch.setattr(resilient.execute, "run", fake_run, raising=True)
    result = _runner__pharma_brief_runtime(tmp_path).run()

    updated = json.loads(manifest_path.read_text(encoding="utf-8"))
    reason = updated["content"]["skip_reason"]
    assert "Pro判断本期可靠事件不足" in reason
    assert "候选3" in reason
    assert "最终1" in reason
    assert result["artifacts"]["skip_reason"] == reason

# ==========================================================================
# from test_pharma_brief_semantic_decision.py
# ==========================================================================

POLICY = {
    "roles": {
        "authoritative": {"rank": 4, "single_source_confidence_cap": 10, "multi_source_confidence_cap": 10},
        "structured": {"rank": 3, "single_source_confidence_cap": 7, "multi_source_confidence_cap": 8},
        "professional": {"rank": 2, "single_source_confidence_cap": 6, "multi_source_confidence_cap": 7},
        "lead": {"rank": 1, "single_source_confidence_cap": 5, "multi_source_confidence_cap": 5},
    },
    "conflict_confidence_cap": 6,
    "empty_confidence_cap": 4,
}

def _runner__pharma_brief_semantic_decision(*sources):
    runner = object.__new__(SourceRuntime)
    runner.evidence_policy = POLICY
    runner.source_map = {
        name: {
            "source_id": name,
            "name": name,
            "role": role,
            "source_quality": "high",
            "kind": "industry",
            "url": f"https://example.com/{name}",
        }
        for name, role in sources
    }
    return runner

def _event__pharma_brief_semantic_decision(refs, *, confidence=10, black_swan=False):
    return {
        "id": "E01",
        "event_key": "demo|asset|event",
        "category": "competition",
        "title": "重大行业变化",
        "fact": "发生重大安全事件并触发全球召回",
        "why_it_matters": "影响范围较大",
        "source_refs": refs,
        "evidence_conflict": False,
        "black_swan": black_swan,
        "scores": {
            "strategic_impact": 9,
            "industry_impact": 9,
            "capital_impact": 8,
            "execution_risk": 9,
            "confidence": confidence,
            "scope": 9,
            "novelty": 8,
        },
    }

def test_single_professional_cannot_escalate_above_watch():
    runner = _runner__pharma_brief_semantic_decision(("STAT", "professional"))
    event = runner._normalize_events([_event__pharma_brief_semantic_decision(["STAT"])], {})[0]
    assert event["scores"]["confidence"] == 6
    assert event["signal"] != "disruption"
    assert event["alert_level"] == "WATCH"

def test_two_independent_professional_sources_may_alert_but_not_critical():
    runner = _runner__pharma_brief_semantic_decision(("STAT", "professional"), ("Endpoints", "professional"))
    event = runner._normalize_events([_event__pharma_brief_semantic_decision(["STAT", "Endpoints"], black_swan=True)], {})[0]
    assert event["scores"]["confidence"] == 7
    assert event["signal"] == "disruption"
    assert event["alert_level"] == "ALERT"
    assert event["black_swan"] is False

def test_lead_only_evidence_is_always_watch_even_with_high_business_scores():
    runner = _runner__pharma_brief_semantic_decision(("Lead", "lead"))
    event = runner._normalize_events([_event__pharma_brief_semantic_decision(["Lead"])], {})[0]
    assert event["scores"]["confidence"] == 5
    assert event["alert_level"] == "WATCH"

def test_authoritative_black_swan_can_be_critical():
    runner = _runner__pharma_brief_semantic_decision(("FDA", "authoritative"))
    event = runner._normalize_events([_event__pharma_brief_semantic_decision(["FDA"], black_swan=True)], {})[0]
    assert event["scores"]["confidence"] == 10
    assert event["black_swan"] is True
    assert event["alert_level"] == "CRITICAL"
    assert event["evidence_policy"]["best_role"] == "authoritative"

# ==========================================================================
# from test_pharma_brief_visual.py
# ==========================================================================

def _event__pharma_brief_visual(idx: int, category: str, title: str, summary: str) -> dict:
    return {
        "id": f"E{idx}",
        "event_key": f"event-{idx}",
        "category": category,
        "title": title,
        "fact": summary,
        "why_it_matters": summary,
        "industry_implication": summary,
        "company_implication": summary,
        "capital_implication": summary,
        "next_watch": ["关注后续监管与商业化进展"],
        "source_refs": ["FDA"],
        "evidence": [],
        "independent_sources": 1,
        "evidence_conflict": False,
        "scores": {
            "strategic_impact": 8,
            "industry_impact": 8,
            "capital_impact": 7,
            "execution_risk": 5,
            "confidence": 8,
            "scope": 7,
            "novelty": 7,
            "overall_score": 7.8,
        },
        "signal": "neutral",
        "black_swan": False,
        "alert_level": "WATCH",
        "change": "new",
        "status": "developing",
    }

def _builder__pharma_brief_visual() -> PharmaBriefVisual:
    return PharmaBriefVisual({
        "api_key": "key",
        "base_url": "https://api.example.com/v1",
        "model": "Air",
        "sources": "P0|regulatory|FDA|https://example.com/fda",
        "llm_min_interval_seconds": 0,
        "layout_type": _LAYOUT_TYPE,
        "visual_style": _VISUAL_STYLE,
        "visual_tone": _VISUAL_TONE,
    })

def test_extract_metric_prefers_truthful_visible_number():
    assert _extract_metric("儿童减重40.4%", "其他说明") == "40.4%"
    assert _extract_metric("交易金额 $10.6B", "") == "$10.6B"
    assert _extract_metric("III期研究达到主要终点", "") == "III期"

def test_week_label_uses_iso_week_without_redundant_date_range():
    assert _week_label("2026-09-13", "2026-09-13") == "2026年 · 第37周"

def test_topic_card_uses_notebook_note_structure_without_internal_metadata():
    card = _topic_card({
        "title": "司美格鲁肽儿童减重数据公布",
        "summary": "STEP Young研究显示体重指标改善40.4%，儿童肥胖治疗关注度上升。",
        "watch": "FDA/EMA是否扩大儿童适应症",
    }, 1)
    assert '<section class="note">' in card
    assert "40.4%" in card
    assert "<b>1</b>" in card
    assert "关注 ·" in card
    assert "topic-card" not in card
    assert "note-rank" not in card
    assert "信源" not in card
    assert "overall_score" not in card
    assert "WATCH" not in card

def test_cover_uses_shared_card_visual_and_weekly_metadata():
    rendered = _page_html__pharma_brief_visual(
        date="2026-09-13",
        week_start="2026-09-07",
        week_end="2026-09-13",
        page_no=1,
        section="本周概览",
        title="批准提速，资本分化",
        dek="本周全球制药行业出现多项关键变化。",
        body_html='<div class="notes"></div>',
        signal="mixed",
        total_pages="05",
    )
    assert _LAYOUT_TYPE == LAYOUT_CARD
    assert _VISUAL_STYLE == STYLE_NOTEBOOK
    assert _VISUAL_TONE == TONE_PROFESSIONAL
    assert 'data-layout-type="card"' in rendered
    assert 'data-visual-style="notebook"' in rendered
    assert 'data-visual-tone="professional"' in rendered
    assert '<span class="brand">PharmaBrief</span>' in rendered
    assert '<span class="tagline">制药手账 · 看研发，也看产业</span>' in rendered
    assert rendered.count("制药手账 · 看研发，也看产业") == 1
    assert "本周简报" in rendered
    assert "MarketBrief" not in rendered

    assert "width:1080px;height:1440px" in rendered
    assert "body:before{content:none}" in rendered
    assert "main{position:relative;margin:0;width:1080px;height:1440px" in rendered
    assert "padding:72px 80px 96px 136px" in rendered
    assert "border:0;border-radius:0;box-shadow:none" in rendered
    assert "left:28px" in rendered
    assert "18px 60px repeat-y" in rendered
    assert "margin:28px 28px 28px 42px" not in rendered
    assert "width:1010px" not in rendered
    assert "height:1384px" not in rendered
    assert "h1{position:relative;z-index:1;font-size:72px" in rendered

    assert "基于公开信息整理 · 保持独立判断，关注事实变化" in rendered
    assert "仅供研究参考，不构成投资或经营建议" in rendered
    assert "2026年 · 第37周" in rendered
    assert "2026.09.13 · 晚刊" not in rendered
    assert "2026-09-07" not in rendered
    assert "page-counter" not in rendered
    assert "GLOBAL PHARMA WEEKLY" not in rendered
    assert "STRATEGIC RADAR" not in rendered
    assert "PHARMA<br>RADAR" not in rendered

def test_content_page_keeps_pharma_section_on_shared_style():
    rendered = _page_html__pharma_brief_visual(
        date="2026-09-13",
        week_start="2026-09-07",
        week_end="2026-09-13",
        page_no=2,
        section="监管研发",
        title="监管研发动态",
        dek="梳理监管与研发变化。",
        body_html='<div class="notes"></div>',
        signal="neutral",
        total_pages="05",
    )
    assert "监管研发" in rendered
    assert '<span class="tagline">制药手账 · 看研发，也看产业</span>' in rendered
    assert "2026年 · 第37周" in rendered
    assert "MarketBrief" not in rendered

def test_visual_layout_remains_five_cards_and_three_topics_per_content_page():
    events = [
        _event__pharma_brief_visual(1, "regulatory", "FDA批准新适应症", "监管变化影响注册节奏。"),
        _event__pharma_brief_visual(2, "clinical", "III期研究公布40.4%改善", "临床结果改变竞争预期。"),
        _event__pharma_brief_visual(3, "technology", "ADC技术出现新进展", "技术平台继续扩展。"),
        _event__pharma_brief_visual(4, "deal", "药企完成$10.6B并购", "资本继续向确定性资产集中。"),
        _event__pharma_brief_visual(5, "capital", "研发资产完成融资", "融资反映资源配置变化。"),
        _event__pharma_brief_visual(6, "competition", "核心产品竞争加剧", "市场格局出现变化。"),
    ]
    final = {
        "hook_title": "批准提速，资本分化",
        "overview": "监管、研发与资本配置同步变化。",
        "events": events,
        "sections": {
            "rd": [
                {"title": f"研发话题{i}", "summary": "研发摘要", "watch": "研发关注"}
                for i in range(1, 4)
            ],
            "capital": [
                {"title": f"资本话题{i}", "summary": "资本摘要", "watch": "资本关注"}
                for i in range(1, 4)
            ],
            "risk": [
                {"title": f"竞争话题{i}", "summary": "竞争摘要", "watch": "竞争关注"}
                for i in range(1, 4)
            ],
        },
        "executive_view": {
            "industry": "产业集中度继续变化。",
            "business": "企业需要重新审视资源配置。",
            "watch_3_12m": ["监管变化", "临床读出", "交易落地"],
        },
    }
    pages = _builder__pharma_brief_visual()._build_pages(final, events, "mixed")
    assert len(pages) == 5
    assert pages[0]["body"].count('<section class="note">') == 3
    assert pages[1]["body"].count('<section class="note">') == 3
    assert pages[2]["body"].count('<section class="note">') == 3
    assert pages[3]["body"].count('<section class="note">') == 3
    assert pages[4]["body"].count('<section class="note">') == 3

def test_pharmabrief_task_with_visual_layer_passes_validator():
    validate_task(Path("projects/PharmaBrief/task.json"))

# ==========================================================================
# from test_pharma_brief_weekly.py
# ==========================================================================

def _event__pharma_brief_weekly(idx: int, category: str) -> dict:
    return {
        "id": f"E{idx}",
        "event_key": f"event-{idx}",
        "category": category,
        "title": f"事件{idx}",
        "fact": f"事件{idx}的可核验事实。",
        "why_it_matters": f"事件{idx}可能影响相关研发和商业决策。",
        "industry_implication": "可能改变同类产品竞争节奏。",
        "company_implication": "企业需要重新评估研发与资源配置。",
        "capital_implication": "可能影响市场对相关资产的估值预期。",
        "next_watch": ["关注后续监管或临床进展"],
        "source_refs": ["FDA"],
        "evidence": [],
        "independent_sources": 1,
        "evidence_conflict": False,
        "scores": {
            "strategic_impact": 8,
            "industry_impact": 8,
            "capital_impact": 7,
            "execution_risk": idx % 10 or 1,
            "confidence": 8,
            "scope": 7,
            "novelty": 7,
            "overall_score": 8.0 - idx / 20,
        },
        "signal": "neutral",
        "black_swan": False,
        "alert_level": "WATCH",
        "change": "new",
        "status": "developing",
    }

def _builder__pharma_brief_weekly() -> PharmaBriefWeekly:
    return PharmaBriefWeekly({
        "api_key": "key",
        "base_url": "https://api.example.com/v1",
        "model": "Pro",
        "sources": "P0|regulatory|FDA|https://example.com/fda",
        "llm_min_interval_seconds": 0,
    })

def _final_with_sections() -> dict:
    def topic(n: int) -> dict:
        return {
            "title": f"话题{n}",
            "summary": f"这是话题{n}的核心影响说明。",
            "watch": f"关注话题{n}后续变化",
            "source_refs": ["FDA"],
        }
    return {
        "hook_title": "批准提速，竞争加剧",
        "overview": "本周监管、研发和资本市场出现多项值得持续观察的变化。",
        "sections": {
            "rd": [topic(1), topic(2), topic(3)],
            "capital": [topic(4), topic(5), topic(6)],
            "risk": [topic(7), topic(8), topic(9)],
        },
        "executive_view": {
            "industry": "产业竞争节奏正在发生变化。",
            "business": "企业需要重新评估研发、注册和资源配置。",
            "watch_3_12m": ["监管决定", "关键临床结果", "资产交易进展"],
        },
    }

def test_weekly_layout_is_five_cards_with_three_topics_each():
    events = [
        _event__pharma_brief_weekly(1, "regulatory"),
        _event__pharma_brief_weekly(2, "clinical"),
        _event__pharma_brief_weekly(3, "technology"),
        _event__pharma_brief_weekly(4, "deal"),
        _event__pharma_brief_weekly(5, "capital"),
        _event__pharma_brief_weekly(6, "pricing"),
        _event__pharma_brief_weekly(7, "competition"),
        _event__pharma_brief_weekly(8, "manufacturing"),
    ]
    pages = _builder__pharma_brief_weekly()._build_pages(_final_with_sections(), events, "mixed")

    assert len(pages) == 5
    assert pages[0]["body"].count("本周三大焦点") == 1
    assert pages[0]["body"].count("border-top:1px solid #EAECF0") == 3
    assert pages[1]["body"].count('<section class="event">') == 3
    assert pages[2]["body"].count('<section class="event">') == 3
    assert pages[3]["body"].count('<section class="event">') == 3
    assert pages[4]["body"].count('class="box"') == 3
    assert [page["title"] for page in pages[1:]] == [
        "监管研发动态",
        "资本交易动态",
        "竞争格局变化",
        "产业经营展望",
    ]
    assert all(len(page["title"]) == 6 for page in pages[1:])
    assert [page["section"] for page in pages] == [
        "本周概览",
        "监管研发",
        "资本交易",
        "竞争格局",
        "影响展望",
    ]
    assert all(len(page["section"]) == 4 for page in pages)
    assert "产业影响" in pages[4]["body"]
    assert "经营影响" in pages[4]["body"]
    assert "后续观察" in pages[4]["body"]

def test_reader_card_removes_internal_metadata():
    block = _event_block(_event__pharma_brief_weekly(1, "regulatory"), 1)

    assert "关注 ·" in block
    assert "新增" not in block
    assert "1 个信源" not in block
    assert "WATCH" not in block
    assert "下一步观察" not in block
    assert "8.0" not in block

def test_page_signal_only_appears_on_cover():
    cover = _page_html__pharma_brief_weekly(
        date="2026-09-13",
        week_start="2026-09-07",
        week_end="2026-09-13",
        page_no=1,
        section="本周概览",
        title="批准提速，竞争加剧",
        dek="概览",
        body_html="<div></div>",
        signal="mixed",
        total_pages="05",
    )
    inner = _page_html__pharma_brief_weekly(
        date="2026-09-13",
        week_start="2026-09-07",
        week_end="2026-09-13",
        page_no=2,
        section="监管研发",
        title="监管研发动态",
        dek="概览",
        body_html="<div></div>",
        signal="mixed",
        total_pages="05",
    )

    assert ">分化</div>" in cover
    assert '<div class="signal">' not in inner
    assert "全球制药战略情报 · 周报" in cover

def test_reader_text_uses_known_chinese_names():
    final = {
        "hook_title": "Novo Nordisk and Novartis update",
        "overview": "Novo Nordisk semaglutide and Takeda R&D updates.",
        "events": [],
        "sections": {},
        "executive_view": {},
    }
    result = _sanitize_final(final)
    assert "诺和诺德" in result["hook_title"]
    assert "诺华" in result["hook_title"]
    assert "司美格鲁肽" in result["overview"]
    assert "武田制药" in result["overview"]

def test_english_residue_detector_allows_domain_abbreviations():
    assert _english_heavy("FDA/EMA 是否批准 GLP-1 儿童适应症") is False
    assert _english_heavy("FDA/EMA pediatric label expansion decision and real-world safety data") is True

def test_quality_gate_detects_english_and_investment_direction_language():
    english = {
        "hook_title": "Semaglutide aids kids",
        "overview": "Strong pediatric obesity efficacy opens a new growth avenue for GLP-1 therapies.",
        "events": [],
        "sections": {},
        "executive_view": {},
    }
    assert "reader-facing English residue" in _quality_issues(english)

    investment = {
        "hook_title": "本周行业变化",
        "overview": "相关数据表明股价可能上涨。",
        "events": [],
        "sections": {},
        "executive_view": {},
    }
    assert "investment-direction language" in _quality_issues(investment)

def test_merge_reader_fields_preserves_internal_metadata():
    original = {
        "hook_title": "English title",
        "events": [{
            "id": "E01",
            "event_key": "x|y|z",
            "category": "clinical",
            "title": "English event",
            "scores": {"confidence": 8},
            "source_refs": ["FDA"],
            "black_swan": False,
        }],
    }
    revised = {
        "hook_title": "中文标题",
        "events": [{
            "id": "CHANGED",
            "event_key": "changed",
            "title": "中文事件",
            "scores": {"confidence": 1},
            "source_refs": ["Fake"],
        }],
    }
    merged = _merge_reader_fields(original, revised)
    assert merged["hook_title"] == "中文标题"
    assert merged["events"][0]["title"] == "中文事件"
    assert merged["events"][0]["event_key"] == "x|y|z"
    assert merged["events"][0]["scores"] == {"confidence": 8}
    assert merged["events"][0]["source_refs"] == ["FDA"]

def test_safe_clip_never_leaves_raw_broken_english_word():
    text = "This is a very long sentence about pharmaceutical development and regulation"
    clipped = _clip_text(text, 28)
    assert clipped.endswith("…")
    assert "developm…" not in clipped

def test_avoids_audience_directed_or_ambiguous_labels():
    events = [_event__pharma_brief_weekly(1, "regulatory"), _event__pharma_brief_weekly(2, "deal"), _event__pharma_brief_weekly(3, "competition")]
    pages = _builder__pharma_brief_weekly()._build_pages(_final_with_sections(), events, "disruption")
    text = " ".join(page["section"] + page["title"] + page["dek"] + page["body"] for page in pages)

    assert "周度判断" not in text
    assert "管理层关注" not in text
    assert "管理层需要关注的三件事" not in text
    assert "老板真正需要看的三件事" not in text
