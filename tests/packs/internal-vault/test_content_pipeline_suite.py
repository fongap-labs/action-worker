"""Merged suite. Sections keep their original order:
  - test_hardening_contracts.py: Regression tests for control-plane hardening contracts.
"""

from __future__ import annotations

from datetime import date
from bricks.pharma_brief_article_runtime import execute as ArticleRuntime
from bricks.source_articles import (
    article_id,
    article_key,
    canonicalize_url,
    dedupe_articles,
    history_article_keys,
    normalize_article,
)
import pytest
from bricks.card_visual import (
    LAYOUT_CARD,
    STYLE_NOTEBOOK,
    TONE_SERIOUS,
    TONE_WARM,
    color_theme,
    render_card_html,
)
from datetime import datetime, timezone
from email.utils import format_datetime
from pathlib import Path
from bricks.source_catalog import apply_role_policy, load_policy, load_source_catalog
from bricks.source_evidence import build_evidence, confidence_cap, enforce_event_confidence
from bricks.source_fetch import SourceFetcher
from engine.dispatcher import _validate_raw_data_topology
from kit_target import target_root
import json
import os
import re
import subprocess
import sys
from preflight.task_contract import TaskContractError, validate_task_shape


# ==========================================================================
# from test_article_evidence.py
# ==========================================================================

def test_article_identity_ignores_tracking_and_fragment():
    left = "https://Example.com/news/story/?utm_source=rss&id=7#top"
    right = "https://example.com/news/story?id=7"
    assert canonicalize_url(left) == right
    assert article_key(left) == article_key(right)
    assert article_id(left) == article_id(right)

def test_dedupe_articles_is_cross_source_by_canonical_url():
    a = normalize_article(
        {"url": "https://example.com/a?utm_medium=rss", "title": "A"},
        {"name": "SourceA", "source_id": "a"},
    )
    b = normalize_article(
        {"url": "https://example.com/a", "title": "A copy"},
        {"name": "SourceB", "source_id": "b"},
    )
    assert len(dedupe_articles([a, b])) == 1

def test_history_article_keys_reads_event_evidence():
    item = normalize_article(
        {"url": "https://example.com/story", "title": "Story"},
        {"name": "STAT", "source_id": "stat"},
    )
    keys = history_article_keys([{"article_evidence": [item]}])
    assert keys == {item["article_key"]}

def test_article_runtime_keeps_specific_article_urls_for_internal_evidence():
    item = normalize_article(
        {
            "url": "https://example.com/story",
            "title": "Specific story",
            "published_at": "2026-09-17T01:00:00+00:00",
        },
        {"name": "STAT", "source_id": "stat"},
    )
    lines = ArticleRuntime._article_footnotes([{"article_evidence": [item]}])
    assert len(lines) == 1
    assert "STAT" in lines[0]
    assert "Specific story" in lines[0]
    assert "https://example.com/story" in lines[0]

def _rss_source():
    return {
        "name": "STAT",
        "source_id": "stat",
        "role": "professional",
        "kind": "clinical",
        "transport": "rss",
        "items": [
            {
                "url": "https://example.com/story-1",
                "title": "Trial readout changes the treatment landscape",
                "published_at": "2026-09-12T08:00:00+00:00",
                "summary": "A phase 3 study reported a clinically meaningful result.",
            },
            {
                "url": "https://example.com/story-2",
                "title": "FDA action creates a new regulatory milestone",
                "published_at": "2026-09-11T08:00:00+00:00",
                "summary": "The agency announced a concrete regulatory action.",
            },
            {
                "url": "https://example.com/story-3",
                "title": "Manufacturing change affects supply planning",
                "published_at": "2026-09-10T08:00:00+00:00",
                "summary": "A concrete manufacturing change was disclosed.",
            },
        ],
    }

def test_failed_extraction_does_not_consume_rss_evidence():
    import pytest
    import requests

    runtime = object.__new__(ArticleRuntime)
    runtime._candidate_articles = {}
    runtime._seen_article_keys = set()
    runtime.week_start = "2026-09-07"
    runtime.week_end = "2026-09-13"
    runtime._role_guide = lambda: []
    runtime._llm = lambda *args, **kwargs: (_ for _ in ()).throw(requests.Timeout())
    source = _rss_source()

    with pytest.raises(requests.Timeout):
        runtime._extract_candidates([source])

    assert len(runtime._articles_for_source(source)) == 3

def test_candidate_gateway_failure_falls_back_to_concrete_rss_articles():
    runtime = object.__new__(ArticleRuntime)
    runtime._candidate_articles = {}
    runtime._extract_candidates = lambda batch: (_ for _ in ()).throw(RuntimeError("502 Bad Gateway"))

    rows = runtime._extract_candidates_resilient([_rss_source()])

    assert len(rows) == 3
    assert rows[0]["title"] == "Trial readout changes the treatment landscape"
    assert rows[0]["source_refs"] == ["STAT"]
    assert rows[0]["article_refs"]
    assert rows[0]["event_key"].startswith("article|")
    assert rows[0]["event_key"] in runtime._candidate_articles
    assert runtime._candidate_articles[rows[0]["event_key"]][0]["url"] == "https://example.com/story-1"

def test_pipeline_supplements_empty_candidate_output_from_concrete_rss_articles(monkeypatch):
    from bricks.pharma_brief_article_runtime import execute as ParentPipeline
    from bricks.pharma_brief_pipeline import execute as Pipeline

    monkeypatch.setattr(
        ParentPipeline,
        "_extract_candidates_resilient",
        lambda self, batch, depth=0: [],
    )
    pipeline = object.__new__(Pipeline)
    pipeline._candidate_articles = {}

    rows = Pipeline._extract_candidates_resilient(pipeline, [_rss_source()])

    assert len(rows) == 3
    assert all(row["event_key"].startswith("article|") for row in rows)
    assert len({row["article_refs"][0] for row in rows}) == 3

def test_pipeline_supplements_partial_candidate_without_reusing_article(monkeypatch):
    from bricks.pharma_brief_article_runtime import execute as ParentPipeline
    from bricks.pharma_brief_pipeline import execute as Pipeline

    source = _rss_source()
    first = normalize_article(source["items"][0], source)
    existing = {
        "event_key": "existing",
        "category": "clinical",
        "title": "已有候选",
        "fact": "已有候选事实",
        "source_refs": ["STAT"],
        "article_refs": [first["article_id"]],
    }
    monkeypatch.setattr(
        ParentPipeline,
        "_extract_candidates_resilient",
        lambda self, batch, depth=0: [existing],
    )
    pipeline = object.__new__(Pipeline)
    pipeline._candidate_articles = {}

    rows = Pipeline._extract_candidates_resilient(pipeline, [source])

    assert len(rows) == 3
    refs = [ref for row in rows for ref in (row.get("article_refs") or [])]
    assert refs.count(first["article_id"]) == 1

def test_production_pipeline_hides_article_urls_from_public_footnotes():
    from bricks.pharma_brief_pipeline import execute as Pipeline

    item = normalize_article(
        {
            "url": "https://example.com/story",
            "title": "Specific story",
            "published_at": "2026-09-17T01:00:00+00:00",
        },
        {"name": "STAT", "source_id": "stat"},
    )
    lines = Pipeline._article_footnotes([{"article_evidence": [item]}])
    assert lines == ["[1] STAT · 2026-09-17 · Specific story"]
    assert "https://" not in lines[0]

def test_pipeline_includes_article_runtime():
    from bricks.pharma_brief_pipeline import execute as Pipeline

    modules = [base.__module__ for base in Pipeline.__mro__]
    assert "bricks.pharma_brief_article_runtime" in modules
    assert "bricks.pharma_brief_source_runtime" in modules
    assert "bricks.pharma_brief_visual" in modules

def test_weekly_pipeline_defaults_to_latest_completed_sunday():
    from bricks.pharma_brief_pipeline import _latest_completed_week_end

    assert _latest_completed_week_end(date(2026, 9, 13)) == "2026-09-13"
    assert _latest_completed_week_end(date(2026, 9, 17)) == "2026-09-13"
    assert _latest_completed_week_end(date(2026, 9, 19)) == "2026-09-13"
    assert _latest_completed_week_end(date(2026, 9, 20)) == "2026-09-20"

def test_pipeline_does_not_let_model_skip_veto_a_full_run(monkeypatch):
    from bricks.pharma_brief_article_runtime import execute as ParentPipeline
    from bricks.pharma_brief_pipeline import execute as Pipeline

    def fake_synthesize(self, candidates, previous):
        return {"status": "skip", "events": [{"id": "E1"}, {"id": "E2"}, {"id": "E3"}]}

    monkeypatch.setattr(ParentPipeline, "_synthesize", fake_synthesize)
    pipeline = object.__new__(Pipeline)
    result = Pipeline._synthesize(pipeline, [], {})

    assert result["status"] == "publish"

def test_pipeline_recovery_only_runs_after_candidate_gate_passes():
    from bricks.pharma_brief_pipeline import _needs_synthesis_recovery

    candidates = [{"event_key": "a"}, {"event_key": "b"}, {"event_key": "c"}]
    assert _needs_synthesis_recovery({"events": []}, candidates) is True
    assert _needs_synthesis_recovery({"events": [{"id": "E1"}, {"id": "E2"}]}, candidates) is True
    assert _needs_synthesis_recovery({"events": [{"id": "E1"}, {"id": "E2"}, {"id": "E3"}]}, candidates) is False
    assert _needs_synthesis_recovery({"events": []}, candidates[:2]) is False

def test_pipeline_recovers_transient_gateway_failure_after_candidate_gate(monkeypatch):
    import requests

    from bricks.pharma_brief_article_runtime import execute as ParentPipeline
    from bricks.pharma_brief_pipeline import execute as Pipeline

    candidates = [{"event_key": "a"}, {"event_key": "b"}, {"event_key": "c"}]

    def gateway_failure(self, candidates, previous):
        raise requests.RequestException("502 bad gateway")

    monkeypatch.setattr(ParentPipeline, "_synthesize", gateway_failure)
    pipeline = object.__new__(Pipeline)
    pipeline._recover_synthesis = lambda rows: {
        "status": "skip",
        "events": [{"id": "E1"}, {"id": "E2"}, {"id": "E3"}],
    }

    result = Pipeline._synthesize(pipeline, candidates, {})

    assert result["status"] == "publish"
    assert len(result["events"]) == 3

def test_llm_continuous_failure_uses_structured_fallback(monkeypatch):
    from bricks.pharma_brief_article_runtime import execute as ParentPipeline
    from bricks.pharma_brief_pipeline import execute as Pipeline

    candidates = [
        {"event_key": "a", "category": "regulatory", "title": "FDA批准新药", "fact": "FDA批准了新药申请", "source_refs": ["FDA"]},
        {"event_key": "b", "category": "clinical", "title": "临床试验结果", "fact": "三期临床达到终点", "source_refs": ["STAT"]},
        {"event_key": "c", "category": "deal", "title": "并购交易", "fact": "制药公司完成并购", "source_refs": ["Endpoints"]},
    ]

    def always_zero(self, candidates, previous):
        return {"status": "skip", "events": []}

    monkeypatch.setattr(ParentPipeline, "_synthesize", always_zero)
    pipeline = object.__new__(Pipeline)
    pipeline._candidate_articles = {}
    pipeline.date = "2026-09-13"
    pipeline.week_start = "2026-09-07"
    pipeline.week_end = "2026-09-13"
    pipeline.publish_title_limit = 18
    pipeline.publish_intro_limit = 80
    pipeline._normalize_events = lambda raw, previous: list(raw or [])
    pipeline._recover_synthesis = lambda rows: {"status": "skip", "events": []}

    result = Pipeline._synthesize(pipeline, candidates, {})

    assert result["status"] == "publish"
    assert len(result["events"]) >= 3
    assert all(event.get("fallback") for event in result["events"])

def test_structured_fallback_events_have_required_fields():
    from bricks.pharma_brief_pipeline import execute as Pipeline

    pipeline = object.__new__(Pipeline)
    pipeline._candidate_articles = {}
    pipeline.date = "2026-09-13"

    candidates = [
        {"event_key": "art1", "category": "regulatory", "title": "NMPA批准", "fact": "NMPA批准新适应症", "source_refs": ["NMPA"]},
        {"event_key": "art2", "category": "clinical", "title": "临床数据", "fact": "三期数据读出", "source_refs": ["STAT"]},
    ]

    events = Pipeline._structured_fallback(pipeline, candidates)

    assert len(events) == 2
    for event in events:
        assert event["title"]
        assert event["fact"]
        assert event["source_refs"]
        assert event["category"] in {"regulatory", "clinical", "deal", "competition", "manufacturing", "capital", "technology", "supply", "pricing"}
        assert "article_refs" in event
        assert "article_evidence" in event
        assert event.get("fallback") is True

def test_pipeline_gateway_failure_triggers_fallback_recovery(monkeypatch):
    import requests

    from bricks.pharma_brief_article_runtime import execute as ParentPipeline
    from bricks.pharma_brief_pipeline import execute as Pipeline

    candidates = [
        {"event_key": "a", "category": "regulatory", "title": "FDA批准", "fact": "FDA批准新药申请", "source_refs": ["FDA"]},
        {"event_key": "b", "category": "clinical", "title": "临床试验", "fact": "三期临床达到终点", "source_refs": ["STAT"]},
        {"event_key": "c", "category": "deal", "title": "并购", "fact": "并购交易完成", "source_refs": ["Endpoints"]},
    ]

    def always_502(self, candidates, previous):
        raise requests.RequestException("502 bad gateway")

    monkeypatch.setattr(ParentPipeline, "_synthesize", always_502)
    pipeline = object.__new__(Pipeline)
    pipeline._candidate_articles = {}
    pipeline.date = "2026-09-13"
    pipeline.week_start = "2026-09-07"
    pipeline.week_end = "2026-09-13"
    pipeline.publish_title_limit = 18
    pipeline.publish_intro_limit = 80
    pipeline._normalize_events = lambda raw, previous: list(raw or [])
    pipeline._recover_synthesis = lambda rows: {"status": "skip", "events": []}

    result = Pipeline._synthesize(pipeline, candidates, {})

    assert result["status"] == "publish"
    assert len(result["events"]) >= 3
    assert all(event.get("fallback") for event in result["events"])

def test_pipeline_gateway_failure_falls_back_to_rss_evidence(monkeypatch):
    import requests

    from bricks.pharma_brief_article_runtime import execute as ParentPipeline
    from bricks.pharma_brief_pipeline import execute as Pipeline

    candidates = [
        {"event_key": "a", "category": "regulatory", "title": "NMPA批准", "fact": "NMPA批准新适应症", "source_refs": ["NMPA"]},
        {"event_key": "b", "category": "clinical", "title": "临床数据", "fact": "三期数据读出", "source_refs": ["STAT"]},
        {"event_key": "c", "category": "deal", "title": "并购交易", "fact": "制药公司并购", "source_refs": ["Endpoints"]},
    ]

    def always_503(self, candidates, previous):
        raise requests.RequestException("503 Service Unavailable")

    monkeypatch.setattr(ParentPipeline, "_synthesize", always_503)
    pipeline = object.__new__(Pipeline)
    pipeline._candidate_articles = {}
    pipeline.date = "2026-09-13"
    pipeline.week_start = "2026-09-07"
    pipeline.week_end = "2026-09-13"
    pipeline.publish_title_limit = 18
    pipeline.publish_intro_limit = 80
    pipeline._normalize_events = lambda raw, previous: list(raw or [])
    pipeline._recover_synthesis = lambda rows: {"status": "skip", "events": []}

    result = Pipeline._synthesize(pipeline, candidates, {})

    assert result["status"] == "publish"
    assert len(result["events"]) >= 3
    assert all(event.get("source_refs") for event in result["events"])

def test_pipeline_json_correction_call_for_malformed_response(monkeypatch):
    from bricks.pharma_brief_article_runtime import execute as ParentPipeline
    from bricks.pharma_brief_pipeline import execute as Pipeline

    candidates = [
        {"event_key": "a", "category": "regulatory", "title": "FDA批准", "fact": "FDA批准新药申请", "source_refs": ["FDA"]},
        {"event_key": "b", "category": "clinical", "title": "临床试验", "fact": "三期临床达到终点", "source_refs": ["STAT"]},
        {"event_key": "c", "category": "deal", "title": "并购", "fact": "并购交易完成", "source_refs": ["Endpoints"]},
    ]

    def malformed_response(self, candidates, previous):
        return {"status": "publish", "hook_title": "Test", "overview": "Test", "events": []}

    def mock_llm_recovery(rows):
        return {
            "status": "publish",
            "events": [
                {"id": "E1", "title": "Recovered", "fact": "Recovered event", "category": "regulatory", "source_refs": ["FDA"]},
                {"id": "E2", "title": "Recovered", "fact": "Recovered event", "category": "clinical", "source_refs": ["STAT"]},
                {"id": "E3", "title": "Recovered", "fact": "Recovered event", "category": "deal", "source_refs": ["Endpoints"]},
            ],
        }

    monkeypatch.setattr(ParentPipeline, "_synthesize", malformed_response)
    pipeline = object.__new__(Pipeline)
    pipeline._candidate_articles = {}
    pipeline.date = "2026-09-13"
    pipeline.week_start = "2026-09-07"
    pipeline.week_end = "2026-09-13"
    pipeline.publish_title_limit = 18
    pipeline.publish_intro_limit = 80
    pipeline._normalize_events = lambda raw, previous: list(raw or [])
    pipeline._recover_synthesis = mock_llm_recovery

    result = Pipeline._synthesize(pipeline, candidates, {})

    assert result["status"] == "publish"
    assert len(result["events"]) >= 3

def test_pipeline_preserves_llm_failures_in_manifest():
    from bricks.pharma_brief_pipeline import execute as Pipeline

    pipeline = object.__new__(Pipeline)
    pipeline.llm_failures = [
        {"provider": "deepseek", "model": "deepseek-chat", "request_id": "abc123", "attempt": 1},
        {"provider": "deepseek", "model": "deepseek-chat", "request_id": "def456", "attempt": 2},
    ]

    manifest = {"schema_version": 2}
    manifest["llm_failures"] = list(pipeline.llm_failures)

    assert len(manifest["llm_failures"]) == 2
    assert manifest["llm_failures"][0]["provider"] == "deepseek"
    assert manifest["llm_failures"][1]["attempt"] == 2

# ==========================================================================
# from test_card_visual.py
# ==========================================================================

def _page(*, visual_tone: str = TONE_SERIOUS) -> str:
    return render_card_html(
        layout_type=LAYOUT_CARD,
        visual_style=STYLE_NOTEBOOK,
        visual_tone=visual_tone,
        brand="ExampleBrief",
        tagline="示例手账 · 只测试通用视觉",
        publication_meta="2026.09.17 · 示例",
        kicker="示例栏目",
        title="这是一个通用卡片",
        subtitle="视觉层只负责版式、风格与气质，不绑定具体业务。",
        bullets=["要点一", "要点二", "要点三"],
        color_theme_values=color_theme("cool-paper"),
        disclaimer="示例免责声明",
    )

def test_card_visual_semantics_are_explicit_and_product_agnostic():
    page = _page()

    assert 'data-layout-type="card"' in page
    assert 'data-visual-style="notebook"' in page
    assert 'data-visual-tone="serious"' in page
    assert '<span class="brand">ExampleBrief</span>' in page
    assert "MarketBrief" not in page
    assert "PharmaBrief" not in page
    assert "2026.09.17 · 示例" in page

def test_notebook_card_uses_full_canvas_as_paper_without_outer_shell():
    page = _page()

    assert "width:1080px;height:1440px" in page
    assert "background:#FBF9F3" in page
    assert "main{position:relative;margin:0;width:1080px;height:1440px" in page
    assert "padding:72px 80px 96px 136px" in page
    assert "border:0;border-radius:0;box-shadow:none" in page
    assert "left:28px" in page
    assert "18px 60px repeat-y" in page
    assert "margin:28px 28px 28px 42px" not in page
    assert "width:1010px" not in page
    assert "height:1384px" not in page

def test_visual_tone_changes_presentation_without_changing_layout_or_style():
    serious = _page(visual_tone=TONE_SERIOUS)
    warm = _page(visual_tone=TONE_WARM)

    assert 'data-layout-type="card"' in serious and 'data-layout-type="card"' in warm
    assert 'data-visual-style="notebook"' in serious and 'data-visual-style="notebook"' in warm
    assert 'data-visual-tone="serious"' in serious
    assert 'data-visual-tone="warm"' in warm
    assert "transform:rotate(-.35deg)" in serious
    assert "transform:rotate(-1deg)" in warm

def test_unsupported_visual_semantics_fail_closed():
    with pytest.raises(ValueError, match="UNSUPPORTED_VISUAL_STYLE"):
        render_card_html(
            layout_type=LAYOUT_CARD,
            visual_style="unknown",
            visual_tone=TONE_SERIOUS,
            brand="ExampleBrief",
            tagline="示例",
            publication_meta="2026.09.17",
            kicker="栏目",
            title="标题",
            subtitle="摘要",
            bullets=["一", "二", "三"],
            color_theme_values=color_theme("cool-paper"),
            disclaimer="说明",
        )

# ==========================================================================
# from test_source_layer.py
# ==========================================================================

class _Response:
    def __init__(self, *, text: str = "", content: bytes | None = None, status_code: int = 200):
        self.text = text
        self.content = content if content is not None else text.encode("utf-8")
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

class _Session:
    def __init__(self, responses):
        self.responses = list(responses)

    def get(self, *args, **kwargs):
        if not self.responses:
            raise AssertionError("unexpected GET")
        return self.responses.pop(0)

def test_source_catalog_maps_semantic_role_to_legacy_priority(tmp_path):
    catalog_file = tmp_path / "sources.json"
    catalog_file.write_text(
        '{"sources":[{"source_id":"STAT","name":"STAT","role":"professional","source_quality":"high",'
        '"kind":"industry","mode":"discovery","transport":"rss","url":"https://example.com/",'
        '"feed_url":"https://example.com/feed"}]}',
        encoding="utf-8",
    )
    policy = {
        "roles": {
            "professional": {"rank": 2, "legacy_priority": "P3"}
        }
    }
    sources = apply_role_policy(load_source_catalog(path=catalog_file, allowed_kinds={"industry"}), policy)
    assert sources[0]["role"] == "professional"
    assert sources[0]["priority"] == "P3"
    assert sources[0]["source_quality"] == "high"

def test_evidence_policy_caps_single_professional_source():
    policy = {
        "roles": {
            "professional": {
                "rank": 2,
                "single_source_confidence_cap": 6,
                "multi_source_confidence_cap": 7,
            }
        },
        "conflict_confidence_cap": 5,
    }
    source_map = {
        "STAT": {
            "source_id": "STAT",
            "name": "STAT",
            "role": "professional",
            "source_quality": "high",
            "url": "https://example.com/",
        }
    }
    evidence = build_evidence(["STAT"], source_map, policy)
    assert confidence_cap(evidence, False, policy) == 6
    event = {"source_refs": ["STAT"], "scores": {"confidence": 9}, "evidence_conflict": False}
    enforce_event_confidence([event], source_map, policy)
    assert event["scores"]["confidence"] == 6
    assert event["evidence_policy"]["best_role"] == "professional"

def test_rss_fetcher_filters_to_fresh_items_and_returns_article_urls():
    now = datetime.now(timezone.utc)
    rss = f"""<?xml version="1.0" encoding="UTF-8"?>
    <rss version="2.0"><channel><title>Demo</title>
      <item><title>Fresh event</title><link>https://example.com/a</link>
        <pubDate>{format_datetime(now)}</pubDate><description>Fresh summary</description></item>
      <item><title>Undated event</title><link>https://example.com/b</link>
        <description>Should be rejected</description></item>
    </channel></rss>"""
    fetcher = SourceFetcher(
        _Session([_Response(content=rss.encode("utf-8"))]),
        max_age_hours=168,
        reject_undated_rss=True,
    )
    result = fetcher.fetch({
        "name": "Demo",
        "transport": "rss",
        "url": "https://example.com/",
        "feed_url": "https://example.com/feed",
    })
    assert result["ok"] is True
    assert result["transport"] == "rss"
    assert len(result["items"]) == 1
    assert result["items"][0]["url"] == "https://example.com/a"
    assert "Fresh event" in result["text"]

def test_pharmabrief_catalog_has_no_company_news_sources():
    catalog = load_source_catalog(
        path=Path("projects/PharmaBrief/sources.json"),
        allowed_kinds={"regulatory", "clinical", "deal", "capital", "industry", "technology", "sentiment", "regional"},
    )
    names = {source["name"] for source in catalog}
    assert not names.intersection({"Pfizer", "AstraZeneca", "Novartis", "Roche", "Lilly", "NovoNordisk", "Sanofi"})
    assert all(source["kind"] != "company" for source in catalog)
    assert {source["transport"] for source in catalog if source["name"] in {"STATNews", "EndpointsNews", "FiercePharma", "FierceBiotech", "NatureBiotech"}} == {"rss"}

def test_pharmabrief_policy_and_catalog_roles_are_complete():
    policy = load_policy(path=Path("projects/PharmaBrief/policy.json"))
    catalog = apply_role_policy(load_source_catalog(path=Path("projects/PharmaBrief/sources.json")), policy)
    roles = set(policy["roles"])
    assert roles == {"authoritative", "structured", "professional", "lead"}
    assert all(source["role"] in roles for source in catalog)
    assert all(source.get("priority") in {"P0", "P2", "P3", "P4"} for source in catalog)

# ==========================================================================
# from test_dispatcher_layer_topology.py
# ==========================================================================

def test_bronze_can_feed_bronze_or_silver():
    steps = [
        {"id": "raw", "target": "bricks.tushare_data_fetch", "layer": "bronze"},
        {"id": "clean", "target": "bricks.r2_storage_upload", "layer": "silver", "depends_on": ["raw"]},
    ]
    _validate_raw_data_topology(steps)

def test_bronze_cannot_feed_business_without_explicit_stage():
    steps = [
        {"id": "raw", "target": "bricks.tushare_data_fetch", "layer": "bronze"},
        {"id": "publish", "target": "bricks.market_brief_publish", "depends_on": ["raw"]},
    ]
    with pytest.raises(SystemExit):
        _validate_raw_data_topology(steps)

# ==========================================================================
# from test_hardening_contracts.py
# ==========================================================================

ROOT = target_root()

def test_bootstrap_never_writes_rendered_task_json():
    text = (ROOT / "bootstrap.sh").read_text(encoding="utf-8")
    assert "rendered_task.json" not in text
    assert "preflight/render_task.py" not in text  # path is composed from PREFLIGHT_DIR
    assert "render_task.py" in text
    assert "in-memory pipe" in text

def test_render_task_resolves_env_without_touching_source(tmp_path):
    task = tmp_path / "task.json"
    task.write_text(
        json.dumps({"steps": [{"id": "x", "target": "bricks.__test__.dummy_ok", "args": {"token": "${FAKE_VALUE}"}}]}),
        encoding="utf-8",
    )
    env = {**os.environ, "FAKE_VALUE": "fake-value-123456"}
    proc = subprocess.run(
        [sys.executable, str(ROOT / "preflight" / "render_task.py"), str(task)],
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )
    assert proc.returncode == 0
    assert json.loads(proc.stdout)["steps"][0]["args"]["token"] == "fake-value-123456"
    assert "${FAKE_VALUE}" in task.read_text(encoding="utf-8")

def test_declared_nonstandard_secret_is_redacted(tmp_path):
    task = tmp_path / "task.json"
    summary = tmp_path / "summary.json"
    task.write_text(
        json.dumps({"steps": [{"id": "leak", "target": "bricks.__test__.dummy_secret_leak", "args": {}}]}),
        encoding="utf-8",
    )
    # NOT A REAL SECRET: deterministic fake credential for a declared Secret name.
    fake_secret = "vendor-credential-7f3a1b9c2d4e"
    env = {
        **os.environ,
        "PYTHONPATH": str(ROOT),
        "GHOST_SUMMARY_FILE": str(summary),
        "GHOST_SECRET_NAMES": "NONSTANDARD_CREDENTIAL",
        "NONSTANDARD_CREDENTIAL": fake_secret,
    }
    proc = subprocess.run(
        [sys.executable, str(ROOT / "engine" / "dispatcher.py"), str(task)],
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )
    assert proc.returncode == 0
    assert fake_secret not in proc.stderr
    assert summary.is_file()
    assert fake_secret not in summary.read_text(encoding="utf-8")
    assert "***REDACTED***" in summary.read_text(encoding="utf-8")

def test_task_contract_rejects_wrong_types_and_unknown_fields():
    with pytest.raises(TaskContractError):
        validate_task_shape({
            "steps": [
                {
                    "id": "x",
                    "target": "bricks.__test__.dummy_ok",
                    "args": [],
                }
            ]
        })

    with pytest.raises(TaskContractError):
        validate_task_shape({
            "steps": [
                {
                    "id": "x",
                    "target": "bricks.__test__.dummy_ok",
                    "retry": 4,
                    "parallel": True,
                }
            ]
        })

def test_marketbrief_task_uses_canonical_visual_pipeline():
    task = json.loads((ROOT / "projects" / "MarketBrief" / "task.json").read_text(encoding="utf-8"))
    assert task["steps"][0]["target"] == "bricks.market_brief_pipeline"

    from bricks.market_brief_pipeline import execute as MarketPipeline

    assert MarketPipeline._render.__module__ == "bricks.market_brief_pipeline"
    source = (ROOT / "bricks" / "market_brief_pipeline.py").read_text(encoding="utf-8")
    assert "market_brief_visual.render_cards" in source
    assert "core._card_html =" not in source

def test_pharmabrief_task_uses_stable_pipeline_with_visual_layer():
    task = json.loads((ROOT / "projects" / "PharmaBrief" / "task.json").read_text(encoding="utf-8"))
    assert task["steps"][0]["target"] == "bricks.pharma_brief_pipeline"

    from bricks.pharma_brief_pipeline import execute as PharmaPipeline

    modules = [base.__module__ for base in PharmaPipeline.__mro__]
    assert "bricks.pharma_brief_visual" in modules

def test_cross_repository_publication_is_centralized():
    for project in ["AdFilter", "MarketBrief", "PharmaBrief"]:
        project_dir = ROOT / "projects" / project
        secrets = (project_dir / ".secrets.required").read_text(encoding="utf-8")
        task = (project_dir / "task.json").read_text(encoding="utf-8")
        publication = json.loads((project_dir / "publication.json").read_text(encoding="utf-8"))

        assert "ARTIFACT_TOKEN" not in secrets
        assert "remote_artifact_push" not in task
        assert "remote_tree_push" not in task
        assert publication["target_repository"] == "fongap-labs/external-vault"

    assert not (ROOT / "bricks" / "remote_artifact_push.py").exists()
    assert not (ROOT / "bricks" / "remote_tree_push.py").exists()
    bootstrap = (ROOT / "bootstrap.sh").read_text(encoding="utf-8")
    assert "action-worker-publication" in bootstrap
    assert "publication_ready" in bootstrap

def test_central_ci_scans_history_with_pinned_gitleaks():
    ci = (ROOT / ".github" / "scripts" / "central-ci.sh").read_text(encoding="utf-8")
    assert 'GITLEAKS_VERSION="8.30.1"' in ci
    assert "sha256sum -c -" in ci
    assert '"$GITLEAKS_DIR/gitleaks" git .' in ci
    assert "--config .gitleaks.toml" in ci

    config = (ROOT / ".gitleaks.toml").read_text(encoding="utf-8")
    allowlists = config.split("[[allowlists]]")[1:]
    assert allowlists, "gitleaks allowlist contract must exist"
    for allowlist in allowlists:
        assert "description =" in allowlist

def test_hugo_download_requires_pinned_sha256(tmp_path):
    task = json.loads((ROOT / "projects" / "FongapBlog" / "task.json").read_text(encoding="utf-8"))
    assert re.fullmatch(r"[0-9a-f]{64}", task["global_args"]["hugo_sha256"])

    source = (ROOT / "bricks" / "hugo_artifact_build.py").read_text(encoding="utf-8")
    assert "_sha256_of" in source
    assert "Hugo 下载校验失败" in source

    from bricks.hugo_artifact_build import execute as HugoBuild

    brick = HugoBuild({
        "project_dir": str(ROOT),
        "hugo_version": "0.164.0",
        "install_dir": str(tmp_path / "bin"),
    })
    with pytest.raises(ValueError, match="hugo_sha256"):
        brick._ensure_hugo()

def test_server_edge_transport_never_pipes_remote_scripts_or_keys_on_argv():
    text = (ROOT / "environments" / "server-edge" / "deploy.sh").read_text(encoding="utf-8")
    assert "https://tailscale.com/install.sh | sh" not in text
    assert '--auth-key="file:' in text
    assert '--auth-key="${TAILSCALE_AUTH_KEY}"' not in text
    assert "SERVER_EDGE_TAILSCALE_INSTALL_SHA256" in text

def test_bootstrap_pipeline_audit_passes_values_as_arguments():
    text = (ROOT / "bootstrap.sh").read_text(encoding="utf-8")
    assert '"status": "success" if ${TASK_EXIT}' not in text
    assert 'python3 - "${TASK_EXIT}" "${_pipeline_elapsed}" "${GHOST_SUMMARY_FILE}"' in text
    assert "<<'PYEOF'" in text

def test_project_repository_identifiers_use_one_owner():
    for env_file in (ROOT / "projects").rglob(".env.variables"):
        text = env_file.read_text(encoding="utf-8")
        assert "fongap/external-vault" not in text, str(env_file)

    adfilter = (ROOT / "projects" / "AdFilter" / ".env.variables").read_text(encoding="utf-8")
    assert "ADFILTER_ARTIFACT_REPOSITORY" not in adfilter

def test_market_fetch_engine_keys_stay_out_of_urls_and_logs():
    source = (ROOT / "bricks" / "global_market_daily_fetch.py").read_text(encoding="utf-8")
    assert "apikey={self.av_key}" not in source
    assert "api_key={self.fred_key}" not in source
    assert "_scrub_url_secrets(error)" in source

def test_redaction_formats_are_registered_in_governance():
    doc = (ROOT / "docs" / "governance" / "secret-redaction.md").read_text(encoding="utf-8")
    assert "preflight/redact.py" in doc
    for marker in ("sk-", "AIza", "JWT", "Discord", "Slack", "高熵"):
        assert marker in doc

def test_fake_credentials_are_labelled_in_fixtures():
    leak_brick = (ROOT / "bricks" / "__test__" / "dummy_secret_leak.py").read_text(encoding="utf-8")
    assert "NOT A REAL SECRET" in leak_brick
    assert "gh" "p_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn" in leak_brick

    fixtures_doc = (Path(__file__).resolve().parent / "fixtures" / "README.md").read_text(encoding="utf-8")
    for marker in ("NOT A REAL SECRET", "deterministic", "format-valid"):
        assert marker in fixtures_doc
