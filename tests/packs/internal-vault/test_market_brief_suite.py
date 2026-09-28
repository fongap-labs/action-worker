"""Merged suite. Sections keep their original order:
  - test_market_brief.py
  - test_market_brief_public_copy.py
  - test_market_brief_publish.py
  - test_market_brief_publish_meta.py
  - test_market_brief_resilient.py
  - test_market_brief_runtime.py
  - test_market_brief_source_api.py
  - test_market_brief_sources.py
  - test_market_brief_stream.py
  - test_market_brief_title_limit.py
  - test_market_brief_visual.py
"""

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
import pytest
import requests
from bricks.brief_publish_meta import load_publish_config
from bricks.market_brief_build import (
    _TextParser,
    _extract_json,
    _normalize_editorial_header,
    _parse_sources,
    _resolve_edition,
    _visual_theme,
    execute as MarketBriefBuilder,
)
from preflight.validate_task import validate_task
from bricks.market_brief_build import _THEMES, _sanitize_public_value
from bricks.market_brief_editorial import _CARD_KICKERS, _public_card_html
from bricks.market_brief_publish import execute as execute__market_brief_publish
from bricks.market_brief_publish_meta import _publish_meta, execute as execute__market_brief_publish_meta
from datetime import date as Date
from bricks.market_brief_resilient import (
    _analysis_rows,
    _article_from_cards,
    _compact_analyses,
    _fallback_title,
    _local_fallback,
    _skip_result,
    _structured_local_analysis,
    execute as execute__market_brief_resilient,
)
from bricks.market_brief_runtime import (
    _clean_fallback_title,
    _is_a_share_row,
    _is_global_row,
    _repair_local_fallback_copy,
    _semantic_topic,
    execute as execute__market_brief_runtime,
)
from bricks.market_brief_sources import MarketBriefFetcher
from bricks.market_brief_build import execute as MarketBriefBuilder
from bricks.market_brief_editorial import execute as EditorialMarketBriefBuilder
from bricks.market_brief_build import _normalize_editorial_header
from bricks.card_visual import LAYOUT_CARD, STYLE_NOTEBOOK, TONE_SERIOUS, color_theme
from bricks.market_brief_visual import (
    LAYOUT_TYPE,
    VISUAL_STYLE,
    VISUAL_TONE,
    card_html,
)


# ==========================================================================
# from test_market_brief.py
# ==========================================================================

_PUBLISH_CONFIG__market_brief = load_publish_config(Path("projects/MarketBrief/publish.json"))

def test_parse_sources_named_and_plain():
    items = _parse_sources("eastmoney|https://example.com/a,https://example.com/b", "community")
    assert items[0]["name"] == "eastmoney"
    assert items[0]["kind"] == "community"
    assert items[1]["name"] == "community-2"

def test_text_parser_drops_script_and_duplicates():
    parser = _TextParser()
    parser.feed("<script>secret()</script><p>热点 A</p><p>热点 A</p><div>研报 B</div>")
    assert "secret" not in parser.output()
    assert parser.output().count("热点 A") == 1
    assert "研报 B" in parser.output()

def test_extract_json_accepts_fence():
    assert _extract_json('```json\n{"status":"publish"}\n```')["status"] == "publish"

def test_resolve_edition_uses_beijing_dayparts():
    tz = timezone(timedelta(hours=8))
    assert _resolve_edition(None, datetime(2026, 9, 13, 8, 30, tzinfo=tz)) == "am"
    assert _resolve_edition(None, datetime(2026, 9, 13, 20, 30, tzinfo=tz)) == "pm"
    assert _resolve_edition("am", datetime(2026, 9, 13, 20, 30, tzinfo=tz)) == "am"
    with pytest.raises(ValueError, match="edition"):
        _resolve_edition("night", datetime(2026, 9, 13, 20, 30, tzinfo=tz))

def test_visual_theme_follows_market_tone():
    tone, optimistic = _visual_theme({"tone": "optimistic"})
    assert tone == "optimistic"
    assert optimistic["marker"]
    tone, neutral = _visual_theme({"tone": "unknown"})
    assert tone == "neutral"
    assert neutral["paper"]

def test_editorial_header_clamps_overview_and_has_fallbacks():
    final = {
        "headline": "主标题",
        "overview": "概" * 180,
        "article": {"summary": "摘要"},
    }
    hook_title, overview = _normalize_editorial_header(
        final,
        title_limit=int(_PUBLISH_CONFIG__market_brief["title_limit"]),
        intro_limit=int(_PUBLISH_CONFIG__market_brief["intro_limit"]),
    )
    assert hook_title == "主标题"
    assert len(overview) == int(_PUBLISH_CONFIG__market_brief["intro_limit"])
    assert final["hook_title"] == hook_title
    assert final["overview"] == overview

def _builder__market_brief(sources="demo|https://example.com", **extra):
    args = {
        "api_key": "gateway-key",
        "base_url": "https://api.example.com/v1",
        "model": "MarketBrief",
        "community_sources": sources,
        "token_budget": 50000,
        "max_calls": 16,
    }
    args.update(extra)
    return MarketBriefBuilder(args)

def test_builder_archives_by_date_and_edition(tmp_path):
    builder = _builder__market_brief(output_dir=str(tmp_path), date="2026-09-13", edition="pm")
    assert builder.date == "2026-09-13"
    assert builder.edition == "pm"
    assert builder.out == tmp_path / "2026-09-13" / "pm"

class StreamResponse:
    status_code = 200
    headers = {"content-type": "text/event-stream"}

    def __init__(self, chunks):
        self.chunks = chunks
        self.closed = False

    def raise_for_status(self):
        return None

    def close(self):
        self.closed = True

    def iter_lines(self, decode_unicode=False):
        for chunk in self.chunks:
            yield chunk

def _valid_stream(status="publish"):
    return StreamResponse(
        [
            ("data: " + json.dumps({"choices": [{"delta": {"content": json.dumps({"status": status})}}]})).encode("utf-8"),
            b"",
            b'data: {"choices":[],"usage":{"total_tokens":42}}',
            b"",
            b"data: [DONE]",
            b"",
        ]
    )

def test_builder_constructs_chat_endpoint_from_gateway_base_url():
    builder = _builder__market_brief()
    assert builder.base_url == "https://api.example.com/v1"
    assert builder.url == "https://api.example.com/v1/chat/completions"
    assert builder.model == "MarketBrief"

def test_marketbrief_task_passes_real_validator():
    validate_task(Path("projects/MarketBrief/task.json"))

def test_llm_uses_streaming_and_reassembles_json(monkeypatch):
    builder = _builder__market_brief()
    captured = {}

    def post(*args, **kwargs):
        captured.update(kwargs)
        return _valid_stream()

    monkeypatch.setattr(builder.session, "post", post)

    result = builder._llm("system", "user", 100)

    assert result["status"] == "publish"
    assert captured["json"]["stream"] is True
    assert captured["stream"] is True
    assert captured["headers"]["Accept"] == "text/event-stream"
    assert builder.tokens == 42

def test_llm_retries_empty_stream_then_succeeds(monkeypatch):
    builder = _builder__market_brief()
    attempts = []
    responses = [
        StreamResponse([b'data: {"choices":[]}', b"", b"data: [DONE]", b""]),
        StreamResponse([b'data: {"choices":[]}', b"", b"data: [DONE]", b""]),
        _valid_stream(),
    ]

    def post(*args, **kwargs):
        attempts.append(1)
        return responses.pop(0)

    monkeypatch.setattr(builder.session, "post", post)
    monkeypatch.setattr("bricks.market_brief_build.time.sleep", lambda _: None)

    result = builder._llm("system", "user", 100)

    assert result["status"] == "publish"
    assert len(attempts) == 3
    assert builder.calls == 1

def test_llm_retries_invalid_final_json_then_succeeds(monkeypatch):
    builder = _builder__market_brief()
    attempts = []
    responses = [
        StreamResponse([b'data: {"choices":[{"delta":{"content":"{broken"}}]}', b"", b"data: [DONE]", b""]),
        _valid_stream(),
    ]

    def post(*args, **kwargs):
        attempts.append(1)
        return responses.pop(0)

    monkeypatch.setattr(builder.session, "post", post)
    monkeypatch.setattr("bricks.market_brief_build.time.sleep", lambda _: None)

    result = builder._llm("system", "user", 100)

    assert result["status"] == "publish"
    assert len(attempts) == 2

def test_llm_transient_failure_stops_after_five_total_attempts(monkeypatch):
    builder = _builder__market_brief()
    attempts = []

    class Response:
        status_code = 503
        headers = {}

        def raise_for_status(self):
            raise requests.HTTPError("503")

        def close(self):
            return None

    def post(*args, **kwargs):
        attempts.append(1)
        return Response()

    monkeypatch.setattr(builder.session, "post", post)
    monkeypatch.setattr("bricks.market_brief_build.time.sleep", lambda _: None)

    with pytest.raises(requests.HTTPError):
        builder._llm("system", "user", 100)

    assert len(attempts) == 5

def test_llm_gateway_terminal_504_is_not_retried(monkeypatch):
    builder = _builder__market_brief()
    attempts = []

    class Response:
        status_code = 504
        headers = {"x-should-retry": "false"}

        def raise_for_status(self):
            raise requests.HTTPError("504")

        def close(self):
            return None

    def post(*args, **kwargs):
        attempts.append(1)
        return Response()

    monkeypatch.setattr(builder.session, "post", post)

    with pytest.raises(requests.HTTPError):
        builder._llm("system", "user", 100)

    assert len(attempts) == 1

def test_llm_plain_504_stops_after_five_total_attempts(monkeypatch):
    builder = _builder__market_brief()
    attempts = []

    class Response:
        status_code = 504
        headers = {}

        def raise_for_status(self):
            raise requests.HTTPError("504")

        def close(self):
            return None

    def post(*args, **kwargs):
        attempts.append(1)
        return Response()

    monkeypatch.setattr(builder.session, "post", post)
    monkeypatch.setattr("bricks.market_brief_build.time.sleep", lambda _: None)

    with pytest.raises(requests.HTTPError):
        builder._llm("system", "user", 100)

    assert len(attempts) == 5

def test_run_skips_one_failed_source_analysis(monkeypatch, tmp_path):
    sources = ",".join(f"s{i}|https://example.com/{i}" for i in range(4))
    builder = _builder__market_brief(sources, date="2026-09-13", edition="pm")
    builder.out = tmp_path

    monkeypatch.setattr(builder, "_fetch", lambda spec: {**spec, "ok": True, "chars": 1000, "text": "x" * 1000, "elapsed_sec": 0.1})

    def analyze(source):
        if source["name"] == "s2":
            raise requests.HTTPError("504")
        return {"name": source["name"], "kind": source["kind"], "url": source["url"], "summary": "ok", "topics": [], "warnings": []}

    monkeypatch.setattr(builder, "_analyze", analyze)
    monkeypatch.setattr(
        builder,
        "_final",
        lambda analyses: {
            "status": "skip",
            "headline": "市场出现结构性分歧",
            "overview": "今天的核心是结构分化与风险重估。",
            "article": {},
            "cards": [],
            "analysis_count": len(analyses),
        },
    )

    result = builder.run()

    assert result["success"] is True
    assert result["artifacts"]["source_count"] == 3
    assert result["artifacts"]["hook_title"] == "市场出现结构性分歧"
    assert result["artifacts"]["overview"] == "今天的核心是结构分化与风险重估。"
    manifest = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["date"] == "2026-09-13"
    assert manifest["edition"] == "pm"
    assert manifest["hook_title"] == "市场出现结构性分歧"
    assert len(manifest["overview"]) <= int(_PUBLISH_CONFIG__market_brief["intro_limit"])
    assert "example.com" not in (tmp_path / "manifest.json").read_text(encoding="utf-8")
    brief = (tmp_path / "brief.md").read_text(encoding="utf-8")
    assert brief.startswith("# 市场出现结构性分歧\n\n> 今天的核心是结构分化与风险重估。")
    assert "基于公开信息" in brief

def test_run_requires_three_successful_analyses(monkeypatch):
    sources = ",".join(f"s{i}|https://example.com/{i}" for i in range(3))
    builder = _builder__market_brief(sources)

    monkeypatch.setattr(builder, "_fetch", lambda spec: {**spec, "ok": True, "chars": 1000, "text": "x" * 1000, "elapsed_sec": 0.1})

    def analyze(source):
        if source["name"] == "s2":
            raise requests.HTTPError("504")
        return {"name": source["name"], "kind": source["kind"], "url": source["url"], "summary": "ok", "topics": [], "warnings": []}

    monkeypatch.setattr(builder, "_analyze", analyze)

    with pytest.raises(RuntimeError, match="INSUFFICIENT_ANALYSES"):
        builder.run()

# ==========================================================================
# from test_market_brief_public_copy.py
# ==========================================================================

def test_public_copy_removes_named_research_attribution():
    data = {
        "body": "中银证券指出风险仍在，东吴证券认为结构性机会延续。",
        "cards": [{"title": "公开信息", "bullets": ["某主题"]}],
    }

    clean = _sanitize_public_value(data)

    assert "中银证券" not in clean["body"]
    assert "东吴证券" not in clean["body"]
    assert clean["body"].count("公开研究信息") == 2

def test_card_uses_public_facing_journal_copy_without_internal_id():
    html = _public_card_html(
        {"kicker": "ignored", "title": "市场观察", "subtitle": "结构与情绪", "bullets": ["一", "二", "三"]},
        "2026-09-13",
        "pm",
        1,
        _THEMES["divergent"],
    )

    assert "2026-09-13-pm-01" not in html
    assert '<span class="brand">MarketBrief</span>' in html
    assert '<span class="tagline">市场手账 · 抓重点，也看分歧</span>' in html
    assert html.count("市场手账 · 抓重点，也看分歧") == 1
    assert '<div class="ribbon">' not in html
    assert "2026.09.13 · 晚刊" in html
    assert "今日简报" in html
    assert "基于公开信息整理" in html

def test_editorial_contract_is_fixed_to_six_cards():
    assert _CARD_KICKERS == (
        "今日简报",
        "全球市场",
        "市场概览",
        "热点追踪",
        "事实分歧",
        "风险提示",
    )

# ==========================================================================
# from test_market_brief_publish.py
# ==========================================================================

def _runner(tmp_path):
    return execute__market_brief_publish({"source_dir": str(tmp_path)})

def test_publish_guard_treats_skip_as_successful_noop(tmp_path):
    edition = tmp_path / "2026-09-14" / "am"
    edition.mkdir(parents=True)
    (edition / "manifest.json").write_text(
        json.dumps({
            "status": "skip",
            "overview": "本期暂缓发布",
            "content": {
                "skip_reason": "有效来源不足",
                "editor_note": "不发布弱内容",
            },
        }, ensure_ascii=False),
        encoding="utf-8",
    )
    result = _runner(tmp_path).run()
    assert result["success"] is True
    assert result["artifacts"]["status"] == "skip"
    assert result["artifacts"]["publication_ready"] is False
    assert result["artifacts"]["reason"] == "有效来源不足"

def test_publish_guard_rejects_missing_manifest(tmp_path):
    with pytest.raises(RuntimeError, match="manifest.json not found"):
        _runner(tmp_path).run()

def test_publish_guard_rejects_unknown_status(tmp_path):
    edition = tmp_path / "2026-09-14" / "am"
    edition.mkdir(parents=True)
    (edition / "manifest.json").write_text(json.dumps({"status": "unknown"}), encoding="utf-8")
    with pytest.raises(RuntimeError, match="MARKETBRIEF_NO_PUBLICATION.*unexpected status"):
        _runner(tmp_path).run()

def test_publish_guard_marks_publish_manifest_ready(tmp_path):
    edition = tmp_path / "2026-09-14" / "am"
    edition.mkdir(parents=True)
    (edition / "manifest.json").write_text(json.dumps({"status": "publish"}), encoding="utf-8")
    result = _runner(tmp_path).run()
    assert result["success"] is True
    assert result["artifacts"]["status"] == "publish"
    assert result["artifacts"]["publication_ready"] is True

# ==========================================================================
# from test_market_brief_publish_meta.py
# ==========================================================================

def _write_manifest(out: Path, *, status: str = "publish", overview: str | None = None) -> None:
    out.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": 2,
        "project": "MarketBrief",
        "date": out.parent.name,
        "edition": out.name,
        "status": status,
        "hook_title": "市场结构分化继续升温",
        "overview": overview or "AI算力与半导体方向活跃，资金在科技与周期之间重新定价，指数平稳但内部差异扩大。",
        "content": {
            "status": status,
            "hook_title": "市场结构分化继续升温",
            "overview": overview or "AI算力与半导体方向活跃，资金在科技与周期之间重新定价，指数平稳但内部差异扩大。",
            "topics": [
                {"title": "AI算力", "why_now": "算力链出现新的交易线索"},
                {"title": "半导体", "why_now": "行业内部轮动加快"},
            ],
        },
    }
    if status == "skip":
        payload["content"]["skip_reason"] = "有效信息不足"
    (out / "manifest.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

def test_market_publish_meta_contract_clips_intro_to_120_and_has_five_tags():
    manifest = {
        "hook_title": "标" * 30,
        "overview": "AI算力和半导体" + "概" * 180,
        "content": {"topics": [{"title": "AI算力"}, {"title": "半导体"}]},
    }
    meta = _publish_meta(manifest)
    assert len(meta["title"]) == 20
    assert len(meta["intro"]) == 120
    assert len(meta["tags"]) == 5
    assert len(set(meta["tags"])) == 5
    assert "AI算力" in meta["tags"]
    assert "半导体" in meta["tags"]

def test_market_publish_meta_writes_publish_md_and_manifest(tmp_path):
    out = tmp_path / "2026-09-17" / "am"
    _write_manifest(out)

    result = execute__market_brief_publish_meta({"output_dir": str(tmp_path), "date": "2026-09-17", "edition": "am"}).run()

    assert result["success"] is True
    assert result["artifacts"]["status"] == "publish"
    publish = (out / "publish.md").read_text(encoding="utf-8")
    assert "**标题**：市场结构分化继续升温" in publish
    assert "**引言**：" in publish
    assert "**话题标签**：" in publish

    tag_line = next(line for line in publish.splitlines() if line.startswith("**话题标签**："))
    assert tag_line.count("#") == 5

    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["publish"]["title"] == "市场结构分化继续升温"
    assert len(manifest["publish"]["intro"]) <= 120
    assert len(manifest["publish"]["tags"]) == 5
    assert len(set(manifest["publish"]["tags"])) == 5

def test_market_publish_meta_uses_latest_generated_edition(tmp_path):
    older = tmp_path / "2026-09-16" / "pm"
    latest = tmp_path / "2026-09-17" / "am"
    _write_manifest(older)
    _write_manifest(latest)

    result = execute__market_brief_publish_meta({"output_dir": str(tmp_path)}).run()

    assert result["artifacts"]["date"] == "2026-09-17"
    assert result["artifacts"]["edition"] == "am"
    assert (latest / "publish.md").is_file()

def test_market_publish_meta_removes_stale_publish_for_skip(tmp_path):
    out = tmp_path / "2026-09-17" / "pm"
    _write_manifest(out, status="skip")
    (out / "publish.md").write_text("stale", encoding="utf-8")

    result = execute__market_brief_publish_meta({"output_dir": str(tmp_path), "date": "2026-09-17", "edition": "pm"}).run()

    assert result["artifacts"]["status"] == "skip"
    assert not (out / "publish.md").exists()
    manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
    assert "publish" not in manifest

def test_marketbrief_task_generates_publish_copy_before_publish_guard():
    task = json.loads(Path("projects/MarketBrief/task.json").read_text(encoding="utf-8"))
    steps = {step["id"]: step for step in task["steps"]}
    assert steps["write_publish_metadata"]["target"] == "bricks.market_brief_publish_meta"
    assert steps["write_publish_metadata"]["depends_on"] == ["market_brief_build"]
    assert steps["publish_market_brief"]["depends_on"] == ["write_publish_metadata"]

# ==========================================================================
# from test_market_brief_resilient.py
# ==========================================================================

def _builder__market_brief_resilient():
    return execute__market_brief_resilient({
        "api_key": "gateway-key",
        "base_url": "https://api.example.com/v1",
        "model": "Air",
        "community_sources": "demo|https://example.com",
        "token_budget": 50000,
        "max_calls": 16,
        "evidence_max_age_days": 14,
        "structured_local_analysis": True,
    })

def _analyses():
    return [
        {
            "kind": "official",
            "summary": "两市公开披露信息保持正常更新。",
            "topics": [
                {
                    "topic": "A股成交结构",
                    "signal": "两市成交活跃度仍是判断市场强弱的重要事实变量。",
                    "stance": "事实",
                    "importance": 9,
                    "evidence_date": "2026-09-14",
                    "freshness": "current",
                }
            ],
            "warnings": ["部分盘面数据仍需等待交易时段确认"],
        },
        {
            "kind": "research",
            "summary": "研究观点集中在科技成长与流动性预期。",
            "topics": [
                {
                    "topic": "科技成长",
                    "signal": "研究观点认为科技成长仍是近期高关注方向，但内部轮动较快。",
                    "stance": "中性",
                    "importance": 10,
                    "evidence_date": "2026-09-13",
                    "freshness": "current",
                },
                {
                    "topic": "美债利率",
                    "signal": "海外利率变化仍可能影响成长资产估值。",
                    "stance": "谨慎",
                    "importance": 8,
                    "evidence_date": "2026-09-13",
                    "freshness": "current",
                },
            ],
            "warnings": ["研究观点不等于已发生的市场事实"],
        },
        {
            "kind": "community",
            "summary": "市场讨论热度集中在算力与半导体方向。",
            "topics": [
                {
                    "topic": "算力与半导体",
                    "signal": "社区讨论热度较高，但对持续性存在明显分歧。",
                    "stance": "分歧",
                    "importance": 8,
                    "evidence_date": "2026-09-14",
                    "freshness": "current",
                }
            ],
            "warnings": ["社区热度不能直接代表资金方向"],
        },
        {
            "kind": "research",
            "summary": "隔夜海外市场关注美股和美元变化。",
            "topics": [
                {
                    "topic": "美股与美元",
                    "signal": "隔夜美股与美元变化是早盘外部观察变量。",
                    "stance": "中性",
                    "importance": 7,
                    "evidence_date": "2026-09-13",
                    "freshness": "current",
                }
            ],
            "warnings": [],
        },
    ]

def test_structured_strategy_source_is_parsed_without_llm():
    source = {
        "name": "eastmoney-strategy",
        "kind": "research",
        "url": "https://data.example/report",
        "fetcher": "eastmoney-strategy",
        "transport": "api",
        "text": (
            "2026-09-14 | 秋季策略：关注流动性与科技成长 | 某研究机构 | 策略\n"
            "2026-09-13 | 市场观察：风险偏好与成交结构 | 某研究机构 | 策略\n"
            "2024-07-01 | 旧策略报告 | 某研究机构 | 策略"
        ),
    }

    result = _structured_local_analysis(source, Date(2026, 9, 14), 14)

    assert result is not None
    assert result["analysis_mode"] == "structured_local"
    assert len(result["topics"]) == 2
    assert all(topic["freshness"] == "current" for topic in result["topics"])
    assert all("2024" not in topic["signal"] for topic in result["topics"])

def test_builder_bypasses_llm_for_structured_api_source():
    builder = _builder__market_brief_resilient()
    builder.date = "2026-09-14"
    called = {"value": False}

    def fail_if_called(*args, **kwargs):
        called["value"] = True
        raise AssertionError("LLM should not be called for structured API data")

    builder._llm = fail_if_called
    source = {
        "name": "cninfo",
        "kind": "official",
        "url": "https://www.cninfo.com.cn/",
        "fetcher": "cninfo-official",
        "transport": "api",
        "text": "2026-09-14 | 000001 示例公司 | 关于股份回购进展的公告 | https://example.com/a.pdf",
    }

    result = builder._analyze(source)

    assert called["value"] is False
    assert result["analysis_mode"] == "structured_local"
    assert result["topics"][0]["stance"] == "事实"

def test_stock_recommendation_rows_are_not_used_as_local_research_evidence():
    source = {
        "name": "eastmoney-report",
        "kind": "research",
        "url": "https://data.example/report",
        "fetcher": "eastmoney-report",
        "transport": "api",
        "text": (
            "2026-09-14 | 某公司首次覆盖给予买入评级 | 某机构 | 公司研报\n"
            "2026-09-14 | 电子行业景气度跟踪 | 某机构 | 行业观察"
        ),
    }

    result = _structured_local_analysis(source, Date(2026, 9, 14), 14)

    assert result is not None
    assert len(result["topics"]) == 1
    assert "买入" not in result["topics"][0]["signal"]

def test_compact_analyses_limits_topics_and_fields():
    analyses = [{
        "kind": "community",
        "summary": "市场情绪偏谨慎",
        "topics": [
            {"topic": f"主题{i}", "signal": f"信号{i}", "stance": "中性", "importance": i}
            for i in range(1, 7)
        ],
        "warnings": ["限制1", "限制2", "限制3"],
    }]
    compact = _compact_analyses(analyses)
    assert len(compact) == 1
    assert len(compact[0]["topics"]) == 4
    assert compact[0]["topics"][0]["importance"] == 6
    assert len(compact[0]["warnings"]) == 2

def test_final_requests_only_compact_public_contract():
    builder = _builder__market_brief_resilient()
    calls = []

    def fake_llm(system, user, max_tokens):
        calls.append((system, user, max_tokens))
        return {
            "status": "publish",
            "hook_title": "市场主线继续分化",
            "overview": "本期关注海外变化、A股结构与主要风险。",
            "market_sentiment": {
                "tone": "divergent",
                "emotion_score": 50,
                "risk_level": 60,
                "dispersion_level": 70,
                "confidence_level": 70,
            },
            "cards": [
                {"title": f"卡片{i}", "subtitle": "说明", "bullets": ["要点1", "要点2", "要点3"]}
                for i in range(1, 7)
            ],
        }

    builder._llm = fake_llm
    result = builder._final([])

    assert calls[0][2] == 2400
    assert '"article"' not in calls[0][1]
    assert '"topics"' not in calls[0][1].split("仅输出：", 1)[1]
    assert len(result["cards"]) == 6
    assert result["article"]["title"] == "市场主线继续分化"
    assert "## 卡片2" in result["article"]["body_markdown"]

def test_final_uses_local_source_analysis_when_final_synthesis_fails():
    builder = _builder__market_brief_resilient()
    builder.date = "2026-09-14"

    def failing_llm(system, user, max_tokens):
        raise RuntimeError("504 upstream timeout")

    builder._llm = failing_llm
    result = builder._final(_analyses())

    assert result["status"] == "publish"
    assert result["fallback"]["used"] is True
    assert result["fallback"]["analysis_count"] == 4
    assert result["fallback"]["mode"] == "fresh_local_source_analysis"
    assert len(result["cards"]) == 6
    assert result["cards"][1]["bullets"]
    assert result["cards"][2]["bullets"]
    assert result["article"]["body_markdown"]
    assert "504 upstream timeout" in result["editor_note"]

def test_stale_dated_topics_are_removed_before_local_fallback():
    analyses = _analyses() + [{
        "kind": "community",
        "summary": "旧社区热帖",
        "topics": [{
            "topic": "旧热点",
            "signal": "2024年7月的社区热帖再次被页面展示。",
            "stance": "偏多",
            "importance": 10,
            "evidence_date": "2024-07-01",
            "freshness": "stale",
        }],
        "warnings": ["热帖时间跨度从2023年7月至2024年7月"],
    }]

    rows, warnings = _analysis_rows(analyses, Date(2026, 9, 14), 14)

    assert all("2024" not in row["signal"] for row in rows)
    assert all(row["topic"] != "旧热点" for row in rows)
    assert any("时效" in warning or "过期" in warning for warning in warnings)

def test_fallback_title_is_complete_and_within_limit():
    rows = [
        {"topic": "AI算力与半导体产业链", "kind": "research", "importance": 10},
        {"topic": "美联储利率政策预期", "kind": "research", "importance": 9},
    ]
    title = _fallback_title(rows)
    assert len(title) <= 20
    assert title.endswith(("成焦点", "成为市场焦点"))

def test_local_fallback_skips_only_when_evidence_is_genuinely_insufficient():
    result = _local_fallback(
        [{"kind": "community", "summary": "只有一条线索", "topics": [], "warnings": []}],
        "504 upstream timeout",
        "am",
        "2026-09-14",
        14,
    )

    assert result["status"] == "skip"
    assert result["hook_title"] == "本期暂缓发布"
    assert result["market_sentiment"]["confidence_level"] == 0

def test_article_is_derived_locally_from_cards():
    cards = [
        {"title": f"卡片{i}", "subtitle": f"说明{i}", "bullets": [f"要点{i}-1", f"要点{i}-2"]}
        for i in range(1, 7)
    ]
    article = _article_from_cards("标题", "概述", cards)
    assert article["title"] == "标题"
    assert article["summary"] == "概述"
    assert "## 卡片2" in article["body_markdown"]
    assert "不构成任何投资建议" in article["disclaimer"]

def test_skip_result_is_complete_but_not_a_publishable_edition():
    result = _skip_result("insufficient evidence")
    assert result["status"] == "skip"
    assert len(result["cards"]) == 6
    assert result["article"]["body_markdown"]

# ==========================================================================
# from test_market_brief_runtime.py
# ==========================================================================

_PUBLISH_CONFIG__market_brief_runtime = load_publish_config("projects/MarketBrief/publish.json")

_TITLE_LIMIT = int(_PUBLISH_CONFIG__market_brief_runtime["title_limit"])

_INTRO_LIMIT = int(_PUBLISH_CONFIG__market_brief_runtime["intro_limit"])

def _builder__market_brief_runtime(tmp_path):
    builder = execute__market_brief_runtime({
        "api_key": "key",
        "base_url": "https://api.example.com/v1",
        "model": "SenseNova",
        "sources": "official|official-source|https://example.com/official,"
                   "research|research-source|https://example.com/research,"
                   "community|community-source|https://example.com/community",
        "output_dir": str(tmp_path),
        "date": "2026-09-14",
        "edition": "am",
        "publish_config_file": "projects/MarketBrief/publish.json",
    })
    return builder

def test_semantic_topic_removes_report_wrapper_without_raw_truncation():
    assert _semantic_topic("FICC周报：关注下周美联储动向") == "下周美联储动向"
    assert _semantic_topic("大周期行业周报（9月第2周）：地缘冲突推升油价") == "地缘冲突推升油价"

def test_fallback_title_is_complete_for_real_report_style_topics():
    title, topics = _clean_fallback_title([
        {"topic": "FICC周报：关注下周美联储动向"},
        {"topic": "大周期行业周报（9月第2周）：地缘冲突推升油价"},
    ], _TITLE_LIMIT)

    assert title == "下周美联储动向、地缘冲突推升油价成焦点"
    assert len(title) <= _TITLE_LIMIT
    assert not title.endswith(("：", "，", "、"))
    assert topics == ["下周美联储动向", "地缘冲突推升油价"]

def test_generic_meeting_label_is_not_used_as_fallback_headline():
    title, topics = _clean_fallback_title([
        {"topic": "晨会纪要", "signal": "晨会纪要"},
        {"topic": "FICC周报：关注下周美联储动向"},
    ], _TITLE_LIMIT)

    assert "晨会纪要" not in title
    assert topics == ["下周美联储动向"]

def test_us_price_index_is_global_not_a_share():
    us_cpi = {
        "topic": "美国消费者价格指数(CPI)发布",
        "signal": "BLS发布最新消费者价格指数数据",
    }
    a_share = {
        "topic": "A股成交结构",
        "signal": "两市成交额与资金流是当前主要结构变量",
    }

    assert _is_global_row(us_cpi) is True
    assert _is_a_share_row(us_cpi) is False
    assert _is_global_row(a_share) is False
    assert _is_a_share_row(a_share) is True

def test_local_fallback_repairs_title_overview_cover_and_article():
    analyses = [
        {
            "kind": "research",
            "summary": "美联储与油价是本周外部变量",
            "topics": [
                {"topic": "FICC周报：关注下周美联储动向", "signal": "关注下周美联储动向", "importance": 9, "freshness": "current", "evidence_date": "2026-09-14"},
                {"topic": "大周期行业周报（9月第2周）：地缘冲突推升油价", "signal": "地缘冲突推升油价", "importance": 8, "freshness": "current", "evidence_date": "2026-09-14"},
            ],
            "warnings": [],
        }
    ]
    final = {
        "status": "publish",
        "hook_title": "FICC周报：关、大周期行业周报：成焦点",
        "overview": "坏标题对应的旧概览",
        "cards": [{"kicker": "今日简报", "title": "坏标题", "subtitle": "坏概览", "bullets": []}],
        "article": {"title": "坏标题", "summary": "坏概览", "body_markdown": "正文"},
        "fallback": {"used": True, "analysis_count": 5},
    }

    repaired = _repair_local_fallback_copy(
        final,
        analyses,
        run_date="2026-09-14",
        edition="am",
        max_age_days=14,
        title_limit=_TITLE_LIMIT,
        intro_limit=_INTRO_LIMIT,
    )

    assert repaired["hook_title"] == "下周美联储动向、地缘冲突推升油价成焦点"
    assert repaired["cards"][0]["title"] == repaired["hook_title"]
    assert repaired["article"]["title"] == repaired["hook_title"]
    assert len(repaired["overview"]) <= _INTRO_LIMIT
    assert "FICC周报：关" not in repaired["overview"]
    assert "下周美联储动向" in repaired["overview"]

def test_local_fallback_routes_official_macro_and_a_share_separately():
    analyses = [
        {
            "kind": "official",
            "summary": "BLS发布最新数据",
            "topics": [
                {"topic": "美国消费者价格指数(CPI)发布", "signal": "BLS发布最新CPI数据", "importance": 9, "freshness": "current", "evidence_date": "2026-09-14"},
            ],
            "warnings": [],
        },
        {
            "kind": "official",
            "summary": "A股结构数据",
            "topics": [
                {"topic": "A股成交结构", "signal": "两市成交额与资金流仍是主要观察变量", "importance": 8, "freshness": "current", "evidence_date": "2026-09-14"},
            ],
            "warnings": [],
        },
        {
            "kind": "research",
            "summary": "市场研究",
            "topics": [
                {"topic": "FICC周报：关注下周美联储动向", "signal": "关注下周美联储动向", "importance": 7, "freshness": "current", "evidence_date": "2026-09-14"},
            ],
            "warnings": [],
        },
    ]
    final = {
        "status": "publish",
        "hook_title": "旧标题",
        "overview": "旧概览",
        "cards": [
            {"kicker": "今日简报", "title": "旧标题", "subtitle": "旧概览", "bullets": []},
            {"kicker": "全球市场", "title": "今晚外部变量", "subtitle": "说明", "bullets": []},
            {"kicker": "市场概览", "title": "A股结构与资金", "subtitle": "说明", "bullets": []},
            {"kicker": "热点追踪", "title": "主线与事件交叉验证", "subtitle": "说明", "bullets": []},
            {"kicker": "事实分歧", "title": "事实、观点与情绪分开看", "subtitle": "说明", "bullets": []},
            {"kicker": "风险提示", "title": "后续变量仍需确认", "subtitle": "说明", "bullets": []},
        ],
        "article": {},
        "fallback": {"used": True, "analysis_count": 3},
    }

    repaired = _repair_local_fallback_copy(
        final,
        analyses,
        run_date="2026-09-14",
        edition="pm",
        max_age_days=14,
        title_limit=_TITLE_LIMIT,
        intro_limit=_INTRO_LIMIT,
    )

    global_text = " ".join(repaired["cards"][1]["bullets"])
    a_share_text = " ".join(repaired["cards"][2]["bullets"])
    assert "CPI" in global_text
    assert "CPI" not in a_share_text
    assert "两市成交额" in a_share_text
    assert "CPI" not in repaired["cards"][3]["bullets"]

def test_skip_run_writes_reasoned_manifest_and_stays_green(tmp_path):
    builder = _builder__market_brief_runtime(tmp_path)

    result = builder._skip_run(started=0.0, reason="INSUFFICIENT_ANALYSES: valid source analyses 2, need at least 3")

    assert result["success"] is True
    assert result["artifacts"]["status"] == "skip"
    assert result["artifacts"]["rendered"] == []
    manifest = json.loads((builder.out / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["status"] == "skip"
    assert "INSUFFICIENT_ANALYSES" in manifest["content"]["skip_reason"]
    assert len(manifest["overview"]) <= _INTRO_LIMIT

def test_runtime_repairs_missing_skip_reason(tmp_path):
    builder = _builder__market_brief_runtime(tmp_path)
    builder.out.mkdir(parents=True)
    (builder.out / "manifest.json").write_text(
        json.dumps({
            "status": "skip",
            "overview": "本期暂缓发布",
            "content": {"editor_note": "没有足够交叉验证"},
        }, ensure_ascii=False),
        encoding="utf-8",
    )
    result = {
        "success": True,
        "artifacts": {
            "output_dir": str(builder.out),
            "status": "skip",
        },
    }

    builder._ensure_skip_reason(result)

    manifest = json.loads((builder.out / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["content"]["skip_reason"] == "没有足够交叉验证"
    assert result["artifacts"]["skip_reason"] == "没有足够交叉验证"

def test_runtime_converts_expected_evidence_failure_to_skip(tmp_path, monkeypatch):
    builder = _builder__market_brief_runtime(tmp_path)

    def fail_run(self):
        raise RuntimeError("EMPTY_RESULT: all source fetches failed or content duplicated")

    monkeypatch.setattr("bricks.market_brief_resilient.execute.run", fail_run)
    result = builder.run()

    assert result["success"] is True
    assert result["artifacts"]["status"] == "skip"
    assert (builder.out / "manifest.json").is_file()

def test_runtime_does_not_hide_render_or_config_errors(tmp_path, monkeypatch):
    builder = _builder__market_brief_runtime(tmp_path)

    def fail_run(self):
        raise RuntimeError("RENDER_ERROR: chromium failed")

    monkeypatch.setattr("bricks.market_brief_resilient.execute.run", fail_run)

    with pytest.raises(RuntimeError, match="RENDER_ERROR"):
        builder.run()

# ==========================================================================
# from test_market_brief_source_api.py
# ==========================================================================

class FakeResponse__market_brief_source_api:
    def __init__(self, *, payload=None, text="", status_code=200):
        self._payload = payload
        self.text = text
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(str(self.status_code))

    def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload

class FakeSession__market_brief_source_api:
    def __init__(self):
        self.get_calls = []
        self.post_calls = []
        self.get_handler = None
        self.post_handler = None

    def get(self, url, **kwargs):
        self.get_calls.append((url, kwargs))
        return self.get_handler(url, kwargs)

    def post(self, url, **kwargs):
        self.post_calls.append((url, kwargs))
        return self.post_handler(url, kwargs)

def _report_payload(title="算力产业链景气度继续提升"):
    return {
        "data": [
            {
                "title": title,
                "publishDate": "2026-09-12 00:00:00.000",
                "orgSName": "测试证券",
                "stockName": "示例公司",
                "industryName": "计算机",
                "emRatingName": "增持",
                "researcher": "研究员甲",
                "infoCode": "ABC123",
            },
            {
                "title": "行业需求跟踪与投资线索",
                "publishDate": "2026-09-11 00:00:00.000",
                "orgSName": "示例研究",
                "industryName": "电子",
                "infoCode": "DEF456",
            },
        ]
    }

def test_eastmoney_report_prefers_public_json_api():
    session = FakeSession__market_brief_source_api()

    def get_handler(url, kwargs):
        assert url == "https://reportapi.eastmoney.com/report/list"
        assert kwargs["params"]["qType"] == "0"
        return FakeResponse__market_brief_source_api(payload=_report_payload())

    session.get_handler = get_handler
    fetcher = MarketBriefFetcher(session, timeout=10, max_chars=6000)
    result = fetcher.fetch(
        {"name": "eastmoney-report", "url": "https://data.eastmoney.com/report/", "kind": "research"}
    )

    assert result["ok"] is True
    assert result["transport"] == "api"
    assert result["fetch_url"] == "https://reportapi.eastmoney.com/report/list"
    assert "算力产业链景气度继续提升" in result["text"]
    assert "测试证券" in result["text"]
    assert "H3_ABC123_1.pdf" in result["text"]

def test_eastmoney_report_type_mapping():
    for name, url, expected in (
        ("eastmoney-industry", "https://data.eastmoney.com/report/industry.jshtml", "1"),
        ("eastmoney-strategy", "https://data.eastmoney.com/report/strategyreport.jshtml", "2"),
    ):
        session = FakeSession__market_brief_source_api()

        def get_handler(request_url, kwargs, expected=expected):
            assert request_url == "https://reportapi.eastmoney.com/report/list"
            assert kwargs["params"]["qType"] == expected
            return FakeResponse__market_brief_source_api(payload=_report_payload())

        session.get_handler = get_handler
        fetcher = MarketBriefFetcher(session, timeout=10, max_chars=6000)
        result = fetcher.fetch({"name": name, "url": url, "kind": "research"})
        assert result["ok"] is True
        assert result["transport"] == "api"

def test_cninfo_prefers_announcement_api():
    session = FakeSession__market_brief_source_api()

    def post_handler(url, kwargs):
        assert url == "https://www.cninfo.com.cn/new/hisAnnouncement/query"
        assert kwargs["data"]["pageSize"] == "30"
        return FakeResponse__market_brief_source_api(
            payload={
                "announcements": [
                    {
                        "announcementTitle": "<em>关于重大合同进展的公告</em>",
                        "secCode": "000001",
                        "secName": "示例股份",
                        "announcementTime": 1789142400000,
                        "adjunctUrl": "finalpage/2026-09-12/test.PDF",
                    },
                    {
                        "announcementTitle": "董事会决议公告",
                        "secCode": "600000",
                        "secName": "示例银行",
                        "announcementTime": 1789142400000,
                        "adjunctUrl": "finalpage/2026-09-12/test2.PDF",
                    },
                ]
            }
        )

    session.post_handler = post_handler
    fetcher = MarketBriefFetcher(session, timeout=10, max_chars=6000)
    result = fetcher.fetch(
        {"name": "cninfo", "url": "https://www.cninfo.com.cn/new/index", "kind": "official"}
    )

    assert result["ok"] is True
    assert result["transport"] == "api"
    assert "关于重大合同进展的公告" in result["text"]
    assert "<em>" not in result["text"]
    assert "https://static.cninfo.com.cn/finalpage/" in result["text"]

def test_structured_failure_falls_back_to_html():
    session = FakeSession__market_brief_source_api()
    html = "<html><body><h2>研报中心</h2>" + "".join(
        f"<p>研报{i}：公开市场研究信息与观点摘要。</p>" for i in range(20)
    ) + "</body></html>"

    def get_handler(url, kwargs):
        if url == "https://reportapi.eastmoney.com/report/list":
            return FakeResponse__market_brief_source_api(status_code=503)
        return FakeResponse__market_brief_source_api(text=html)

    session.get_handler = get_handler
    fetcher = MarketBriefFetcher(session, timeout=10, max_chars=6000)
    result = fetcher.fetch(
        {"name": "eastmoney-report", "url": "https://data.eastmoney.com/report/", "kind": "research"}
    )

    assert result["ok"] is True
    assert result["transport"] == "html"
    assert "structured: 503" in result["fallback_reason"]

# ==========================================================================
# from test_market_brief_sources.py
# ==========================================================================

class FakeResponse__market_brief_sources:
    def __init__(self, text: str, status_code: int = 200):
        self.text = text
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(str(self.status_code))

class FakeSession__market_brief_sources:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        response = self.responses[url]
        return response() if callable(response) else response

def _long_html(title: str, prefix: str = "内容") -> str:
    rows = "".join(f"<p>{prefix}{i}：这是用于测试的公开市场信息，包含足够正文字符。</p>" for i in range(20))
    return f"<html><body><div>首页 登录 下载APP</div><h2>{title}</h2>{rows}</body></html>"

def test_eastmoney_hot_uses_site_profile_and_focuses_content():
    url = "https://hfmgb.eastmoney.com/"
    session = FakeSession__market_brief_sources({url: FakeResponse__market_brief_sources(_long_html("热门个股", "股票"))})
    fetcher = MarketBriefFetcher(session, timeout=10, max_chars=6000)

    result = fetcher.fetch({"name": "eastmoney-hot", "url": url, "kind": "community"})

    assert result["ok"] is True
    assert result["fetcher"] == "eastmoney-hot"
    assert result["text"].startswith("热门个股")
    assert "首页 登录 下载APP" not in result["text"]
    assert result["quality_score"] > 0
    assert len(result["content_hash"]) == 64

def test_xueqiu_block_page_falls_back_to_public_hot_page():
    primary = "https://xueqiu.com/hot/stock"
    fallback = "https://ai.xueqiu.com/hot/stock"
    blocked = FakeResponse__market_brief_sources("<html><body><h1>安全验证</h1><p>请完成安全验证后继续访问。</p></body></html>")
    good = FakeResponse__market_brief_sources(_long_html("发现热门股票", "热股"))
    session = FakeSession__market_brief_sources({primary: blocked, fallback: good})
    fetcher = MarketBriefFetcher(session, timeout=10, max_chars=6000)

    result = fetcher.fetch({"name": "xueqiu-hot", "url": primary, "kind": "community"})

    assert result["ok"] is True
    assert result["fetcher"] == "xueqiu-hot"
    assert result["fetch_url"] == fallback
    assert [call[0] for call in session.calls] == [primary, fallback]

def test_fetcher_caches_same_url_within_run():
    url = "https://www.cninfo.com.cn/new/index"
    session = FakeSession__market_brief_sources({url: FakeResponse__market_brief_sources(_long_html("最新公告", "公告"))})
    fetcher = MarketBriefFetcher(session, timeout=10, max_chars=6000)
    spec = {"name": "cninfo", "url": url, "kind": "official"}

    first = fetcher.fetch(spec)
    second = fetcher.fetch(spec)

    assert first["ok"] is True
    assert second["ok"] is True
    assert second["cache_hit"] is True
    assert len(session.calls) == 1

def test_blocked_generic_page_is_marked_failed():
    url = "https://example.com/data"
    session = FakeSession__market_brief_sources({url: FakeResponse__market_brief_sources("<html><body>Access Denied 验证码</body></html>")})
    fetcher = MarketBriefFetcher(session, timeout=10, max_chars=6000)

    result = fetcher.fetch({"name": "demo", "url": url, "kind": "community"})

    assert result["ok"] is False
    assert result["fetcher"] == "generic"

def test_builder_skips_duplicate_content_before_llm(monkeypatch, tmp_path):
    sources = ",".join(f"s{i}|https://example.com/{i}" for i in range(4))
    builder = MarketBriefBuilder(
        {
            "api_key": "gateway-key",
            "base_url": "https://api.example.com/v1",
            "model": "MarketBrief",
            "community_sources": sources,
            "token_budget": 50000,
            "max_calls": 16,
        }
    )
    builder.out = tmp_path
    hashes = {"s0": "same", "s1": "same", "s2": "two", "s3": "three"}

    monkeypatch.setattr(
        builder,
        "_fetch",
        lambda spec: {
            **spec,
            "ok": True,
            "chars": 1000,
            "text": "x" * 1000,
            "content_hash": hashes[spec["name"]],
            "elapsed_sec": 0.1,
        },
    )
    monkeypatch.setattr(
        builder,
        "_analyze",
        lambda source: {
            "name": source["name"],
            "kind": source["kind"],
            "url": source["url"],
            "summary": "ok",
            "topics": [],
            "warnings": [],
        },
    )
    monkeypatch.setattr(builder, "_final", lambda analyses: {"status": "skip", "article": {}, "cards": []})

    result = builder.run()

    assert result["success"] is True
    assert result["artifacts"]["source_count"] == 3

# ==========================================================================
# from test_market_brief_stream.py
# ==========================================================================

def _builder__market_brief_stream():
    return MarketBriefBuilder(
        {
            "api_key": "gateway-key",
            "base_url": "https://api.example.com/v1",
            "model": "MarketBrief",
            "community_sources": "demo|https://example.com",
            "token_budget": 50000,
            "max_calls": 16,
        }
    )

def _editorial_builder():
    return EditorialMarketBriefBuilder(
        {
            "api_key": "gateway-key",
            "base_url": "https://api.example.com/v1",
            "model": "MarketBrief",
            "community_sources": "demo|https://example.com",
            "token_budget": 50000,
            "max_calls": 16,
        }
    )

def test_stream_parser_reassembles_split_sse_json():
    builder = _builder__market_brief_stream()

    class Response:
        def iter_lines(self, decode_unicode=False):
            yield 'data: {"choices":[{"delta":{"content":"{\\"status\\":'
            yield 'data: \\"publish\\"}"}}]}'
            yield ''
            yield 'data: {"choices":[],"usage":{"total_tokens":42}}'
            yield ''
            yield 'data: [DONE]'
            yield ''

    content, used = builder._read_stream(Response())

    assert json.loads(content)["status"] == "publish"
    assert used == 42

def test_stream_parser_accepts_events_without_blank_separator():
    builder = _builder__market_brief_stream()

    class Response:
        def iter_lines(self, decode_unicode=False):
            yield 'data: {"choices":[{"delta":{"content":"{\\"status\\":"}}]}'
            yield 'data: {"choices":[{"delta":{"content":"\\"publish\\"}"}}]}'
            yield 'data: [DONE]'

    content, used = builder._read_stream(Response())

    assert json.loads(content)["status"] == "publish"
    assert used == 0

def test_stream_parser_decodes_utf8_bytes_explicitly():
    builder = _builder__market_brief_stream()

    class Response:
        def iter_lines(self, decode_unicode=False):
            assert decode_unicode is False
            yield 'data: {"choices":[{"delta":{"content":"{\\"headline\\":\\"市场观察\\"}"}}]}'.encode("utf-8")
            yield b""
            yield b"data: [DONE]"
            yield b""

    content, used = builder._read_stream(Response())

    assert json.loads(content)["headline"] == "市场观察"
    assert used == 0

def test_stream_parser_keeps_incomplete_event_across_blank_line():
    builder = _builder__market_brief_stream()

    class Response:
        def iter_lines(self, decode_unicode=False):
            yield b'data: {"choices":[{"delta":{"content":"{\\"status\\":'
            yield b""
            yield b'data: \\"publish\\"}"}}]}'
            yield b""
            yield b"data: [DONE]"
            yield b""

    content, used = builder._read_stream(Response())

    assert json.loads(content)["status"] == "publish"
    assert used == 0

def test_editorial_llm_falls_back_to_buffered_after_empty_stream(monkeypatch):
    builder = _editorial_builder()
    monkeypatch.setattr("bricks.market_brief_editorial.time.sleep", lambda _: None)

    class Response:
        def __init__(self, *, content_type, payload=None, stream_lines=None):
            self.status_code = 200
            self.headers = {"content-type": content_type}
            self._payload = payload
            self._stream_lines = stream_lines or []
            self.closed = False

        def iter_lines(self, decode_unicode=False):
            yield from self._stream_lines

        def json(self):
            return self._payload

        def raise_for_status(self):
            return None

        def close(self):
            self.closed = True

    responses = [
        Response(content_type="text/event-stream", stream_lines=[b"data: [DONE]", b""]),
        Response(
            content_type="application/json",
            payload={
                "choices": [{"message": {"content": "{\"status\":\"publish\"}"}}],
                "usage": {"total_tokens": 21},
            },
        ),
    ]

    class Session:
        def __init__(self):
            self.stream_modes = []

        def post(self, *args, **kwargs):
            self.stream_modes.append(kwargs["stream"])
            return responses.pop(0)

    session = Session()
    builder.session = session

    data = builder._llm("system", "user", 100)

    assert data["status"] == "publish"
    assert session.stream_modes == [True, False]
    assert builder.calls == 1
    assert builder.tokens == 21

# ==========================================================================
# from test_market_brief_title_limit.py
# ==========================================================================

_PUBLISH_CONFIG__market_brief_title_limit = load_publish_config(Path("projects/MarketBrief/publish.json"))

def test_hook_title_is_capped_at_configured_limit():
    final = {
        "hook_title": "这是一条必须控制在配置范围以内同时保持吸引力的市场标题",
        "overview": "概述",
    }

    hook_title, overview = _normalize_editorial_header(
        final,
        title_limit=int(_PUBLISH_CONFIG__market_brief_title_limit["title_limit"]),
        intro_limit=int(_PUBLISH_CONFIG__market_brief_title_limit["intro_limit"]),
    )

    assert len(hook_title) == int(_PUBLISH_CONFIG__market_brief_title_limit["title_limit"])
    assert hook_title == final["hook_title"]
    assert overview == "概述"

# ==========================================================================
# from test_market_brief_visual.py
# ==========================================================================

def _page(edition: str) -> str:
    return card_html(
        {
            "kicker": "今日简报",
            "title": "测试标题",
            "subtitle": "测试概述",
            "bullets": ["要点一", "要点二", "要点三"],
        },
        "2026-09-17",
        edition,
        1,
        color_theme("cool-paper"),
    )

def test_fixed_header_hierarchy_and_semantic_visual_identity():
    page = _page("pm")

    assert LAYOUT_TYPE == LAYOUT_CARD
    assert VISUAL_STYLE == STYLE_NOTEBOOK
    assert VISUAL_TONE == TONE_SERIOUS
    assert '<span class="brand">MarketBrief</span>' in page
    assert '<span class="tagline">市场手账 · 抓重点，也看分歧</span>' in page
    assert page.count("市场手账 · 抓重点，也看分歧") == 1
    assert "MarketBrief · 晚刊" not in page
    assert 'data-layout-type="card"' in page
    assert 'data-visual-style="notebook"' in page
    assert 'data-visual-tone="serious"' in page

def test_footer_keeps_compact_date_and_edition_metadata():
    am = _page("am")
    pm = _page("pm")

    assert "仅供信息参考，不构成投资建议" in am
    assert "仅供信息参考，不构成投资建议" in pm
    assert "2026.09.17 · 早刊" in am
    assert "2026.09.17 · 晚刊" in pm
    assert "2026-09-17 · 早刊" not in am

def test_mobile_portrait_paper_contract():
    page = _page("am")

    assert "width:1080px;height:1440px" in page
    assert "body:before{content:none}" in page
    assert "main{position:relative;margin:0;width:1080px;height:1440px" in page
    assert "padding:72px 80px 96px 136px" in page
    assert "border:0;border-radius:0;box-shadow:none" in page
    assert "left:28px" in page
    assert "18px 60px repeat-y" in page
    assert ".note{position:relative;min-height:132px" in page
    assert "footer{position:absolute;z-index:1;left:136px;right:80px;bottom:54px" in page
    assert "margin:28px 28px 28px 42px" not in page
