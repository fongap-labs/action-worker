"""Merged suite. Sections keep their original order:
  - test_market_china_contract.py
  - test_market_china_preflight.py
  - test_market_source_config.py
  - test_tushare_sync_behavior.py
  - test_r2_upload_behavior.py
"""

from __future__ import annotations

from kit_target import target_root
import ast
import json
from pathlib import Path
from engine.dispatcher import _validate_raw_data_topology
from preflight.validate_task import validate_task
import pytest
from bricks.market_brief_build import _parse_source_catalog, execute as MarketBriefBuilder
from datetime import datetime, timezone
import pandas as pd
from botocore.exceptions import ClientError
from bricks.tushare_sync_finalize import execute as FinalizeTushare
from bricks.tushare_sync_engine import TushareIntegrityError, TushareSyncBase
from bricks.r2_storage_upload import execute as UploadR2


# ==========================================================================
# from test_market_china_contract.py
# ==========================================================================

ROOT = target_root()

TASK_FILE = ROOT / "projects" / "MarketChina" / "task.json"

BRICK_FILE = ROOT / "bricks" / "tushare_data_fetch.py"

SDK_FILE = ROOT / "bricks" / "tushare_sync_engine.py"

UPLOAD_FILE = ROOT / "bricks" / "r2_storage_upload.py"

SUPPORTED_MODES = {
    "snapshot",
    "date_incremental",
    "range_incremental",
    "symbol_incremental",
}

def _load_task() -> dict:
    return json.loads(TASK_FILE.read_text(encoding="utf-8"))

def _by_id() -> dict[str, dict]:
    return {step["id"]: step for step in _load_task()["steps"]}

def test_generic_tushare_brick_matches_dispatcher_contract():
    tree = ast.parse(BRICK_FILE.read_text(encoding="utf-8"))
    execute = next(
        node
        for node in tree.body
        if isinstance(node, ast.ClassDef) and node.name == "execute"
    )
    init = next(
        node
        for node in execute.body
        if isinstance(node, ast.FunctionDef) and node.name == "__init__"
    )
    run = next(
        node
        for node in execute.body
        if isinstance(node, ast.FunctionDef) and node.name == "run"
    )

    assert [arg.arg for arg in init.args.args] == ["self", "args"]
    assert run is not None

def test_market_china_fetches_are_explicit_bronze_nodes():
    task = _load_task()
    fetch_steps = [
        step for step in task["steps"] if step["id"].startswith("fetch_tushare_")
    ]

    assert fetch_steps
    assert {step["target"] for step in fetch_steps} == {
        "bricks.tushare_data_fetch"
    }
    for step in fetch_steps:
        args = step.get("args", {})
        assert args.get("api_name"), step["id"]
        assert args.get("table_name"), step["id"]
        assert args.get("sync_mode") in SUPPORTED_MODES, step["id"]
        assert args.get("dataset_uri") == "l1_bronze/tushare", step["id"]

def test_upload_and_finalizer_stay_inside_bronze_topology():
    task = _load_task()
    fetch_ids = {
        step["id"]
        for step in task["steps"]
        if step["id"].startswith("fetch_tushare_")
    }
    by_id = _by_id()
    upload = by_id["sync_tushare_stock_data"]
    finalizer = by_id["tushare_sync_finalize"]

    assert upload["target"] == "bricks.r2_storage_upload"
    assert set(upload["depends_on"]) == fetch_ids
    assert finalizer["target"] == "bricks.tushare_sync_finalize"
    assert finalizer["depends_on"] == ["sync_tushare_stock_data"]

def test_stock_universe_supports_historical_backfill():
    stock_basic = _by_id()["fetch_tushare_stock_basic"]["args"]
    statuses = {
        item["list_status"] for item in stock_basic["query_variants"]
    }

    assert {"L", "D", "P"} <= statuses
    assert stock_basic["snapshot_history"] is True
    assert stock_basic["primary_key"] == ["ts_code"]
    assert stock_basic["min_row_ratio"] > 0

def test_required_market_series_have_identity_and_shrink_guards():
    by_id = _by_id()
    required = {
        "fetch_tushare_stock_daily",
        "fetch_tushare_stock_adjfactor",
        "fetch_tushare_stock_dailybasic",
        "fetch_tushare_stock_factor",
        "fetch_tushare_etf_factor",
        "fetch_tushare_index_factor",
        "fetch_tushare_moneyflow_hs",
        "fetch_tushare_margin_detail",
    }

    for step_id in required:
        args = by_id[step_id]["args"]
        assert args["sync_mode"] == "date_incremental"
        assert args["allow_empty"] is False
        assert {"ts_code", "trade_date"} <= set(args["required_columns"])
        assert args["primary_key"] == ["ts_code", "trade_date"]
        assert 0 < args["min_row_ratio"] <= 1
        assert 0 < args["recheck_items"] < args["batch_size"]

def test_late_publishing_sources_have_independent_readiness():
    by_id = _by_id()

    assert by_id["fetch_tushare_stock_daily"]["args"]["ready_hour"] >= 17
    assert by_id["fetch_tushare_stock_dailybasic"]["args"]["ready_hour"] >= 18
    assert by_id["fetch_tushare_moneyflow_hs"]["args"]["ready_hour"] >= 20
    assert by_id["fetch_tushare_stock_toplist"]["args"]["ready_hour"] >= 21

    margin = by_id["fetch_tushare_margin_detail"]["args"]
    assert margin["lag_days"] == 1
    assert margin["ready_hour"] >= 9

def test_events_are_rechecked_instead_of_completed_forever():
    by_id = _by_id()

    dividend = by_id["fetch_tushare_stock_dividend"]["args"]
    forecast = by_id["fetch_tushare_fina_forecast"]["args"]
    for args in (dividend, forecast):
        assert args["sync_mode"] == "date_incremental"
        assert args["date_param"] == "ann_date"
        assert args["calendar_mode"] == "natural"
        assert {"ts_code", "ann_date"} <= set(args["required_columns"])
        assert 0 < args["recheck_items"] < args["batch_size"]

    for step_id in (
        "fetch_tushare_fina_indicator",
        "fetch_tushare_fina_express",
    ):
        args = by_id[step_id]["args"]
        assert args["sync_mode"] == "symbol_incremental"
        assert args["refresh_after_days"] <= 14
        assert args["batch_size"] >= 400
        assert args["paginate"] is False
        assert args["time_budget_seconds"] >= 300

def test_range_sync_declares_result_date_identity():
    by_id = _by_id()
    expected_columns = {
        "fetch_tushare_moneyflow_hsgt": "trade_date",
        "fetch_tushare_margin_summary": "trade_date",
        "fetch_tushare_stock_holdertrade": "ann_date",
        "fetch_tushare_stock_holdernumber": "ann_date",
        "fetch_tushare_stock_sharefloat": "float_date",
    }

    for step_id, column in expected_columns.items():
        args = by_id[step_id]["args"]
        assert args["sync_mode"] == "range_incremental"
        assert args["result_date_column"] == column
        assert column in args["required_columns"]
        assert 0 < args["recheck_items"] < args["batch_size"]

    assert (
        by_id["fetch_tushare_stock_sharefloat"]["args"][
            "range_end_offset_days"
        ]
        >= 365
    )

def test_global_budget_and_deep_recheck_are_bounded():
    global_args = _load_task()["global_args"]
    assert 0 < global_args["time_budget_seconds"] <= 90
    assert global_args["deep_recheck_items"] >= 1

def test_sdk_is_fail_closed_and_reconciliation_aware():
    source = SDK_FILE.read_text(encoding="utf-8")

    assert "TushareIntegrityError" in source
    assert "TushareTimeBudgetError" in source
    assert "ClientError" in source
    assert "checked_at" in source
    assert "row_count" in source
    assert "object_key" in source
    assert "sha256" in source
    assert "_validate_response" in source
    assert "_validate_shrink" in source
    assert "_oldest_checked" in source
    assert "offset += len(page)" in source
    assert "batch_{batch_id}.parquet" not in source
    assert 'f"{safe_name}={safe_value}/data.parquet"' in source
    assert "except Exception:\n            return pd.DataFrame()" not in source

def test_remote_checkpoint_is_uploaded_after_data():
    source = UPLOAD_FILE.read_text(encoding="utf-8")

    data_call = source.index('_upload_group(data_files, "data")')
    checkpoint_call = source.index(
        '_upload_group(checkpoint_files, "checkpoint")'
    )
    assert data_call < checkpoint_call

# ==========================================================================
# from test_market_china_preflight.py
# ==========================================================================

def test_market_china_passes_real_task_validator():
    validate_task(TASK_FILE)

def test_market_china_passes_real_bronze_topology_guard():
    task = json.loads(TASK_FILE.read_text(encoding="utf-8"))
    _validate_raw_data_topology(task["steps"])

def test_every_market_china_data_step_keeps_explicit_bronze_semantics():
    task = json.loads(TASK_FILE.read_text(encoding="utf-8"))
    data_steps = [
        step
        for step in task["steps"]
        if step["id"].startswith("fetch_tushare_")
        or step["id"] in {"sync_tushare_stock_data", "tushare_sync_finalize"}
    ]

    assert data_steps
    for step in data_steps:
        assert step.get("layer") == "bronze", step["id"]

# ==========================================================================
# from test_market_source_config.py
# ==========================================================================

def test_parse_source_catalog_preserves_kind_name_and_url():
    value = (
        "community|community-a|https://example.com/a,"
        "research|research-b|https://example.com/b,"
        "official|official-c|https://example.com/c"
    )
    sources = _parse_source_catalog(value)

    assert [item["kind"] for item in sources] == ["community", "research", "official"]
    assert [item["name"] for item in sources] == ["community-a", "research-b", "official-c"]
    assert sources[2]["url"] == "https://example.com/c"

def test_parse_source_catalog_rejects_invalid_kind():
    with pytest.raises(ValueError, match="SOURCE_CONFIG_ERROR"):
        _parse_source_catalog("unknown|demo|https://example.com")

def test_parse_source_catalog_rejects_invalid_shape():
    with pytest.raises(ValueError, match="kind\\|name\\|url"):
        _parse_source_catalog("demo|https://example.com")

def test_builder_prefers_unified_source_catalog():
    builder = MarketBriefBuilder(
        {
            "api_key": "gateway-key",
            "base_url": "https://api.example.com/v1",
            "model": "MarketBrief",
            "sources": (
                "community|community-a|https://example.com/a,"
                "research|research-b|https://example.com/b,"
                "official|official-c|https://example.com/c"
            ),
            "community_sources": "legacy|https://legacy.example.com",
            "max_sources": 8,
            "token_budget": 50000,
            "max_calls": 16,
        }
    )

    assert len(builder.sources) == 3
    assert {item["kind"] for item in builder.sources} == {"community", "research", "official"}
    assert all("legacy.example.com" not in item["url"] for item in builder.sources)

def test_project_catalog_is_official_first_and_capped_at_twelve():
    env_path = Path("projects/MarketBrief/.env.variables")
    values = {}
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key] = value.strip().strip('"')

    sources = _parse_source_catalog(values["MARKETBRIEF_SOURCES"])
    counts = {kind: sum(item["kind"] == kind for item in sources) for kind in ("community", "research", "official")}
    names = {item["name"] for item in sources}

    assert len(sources) == 12
    assert counts == {"community": 2, "research": 3, "official": 7}
    assert values["MARKETBRIEF_MAX_SOURCES"] == "12"
    assert {
        "cninfo",
        "nbs-latest",
        "pbc-policy",
        "csrc-news",
        "fed-news",
        "bls-news",
        "treasury-yield",
    } <= names
    assert "10jqka-community" not in names
    assert "eastmoney-report" not in names

# ==========================================================================
# from test_tushare_sync_behavior.py
# ==========================================================================

def _engine(tmp_path, monkeypatch, **overrides) -> TushareSyncBase:
    monkeypatch.setenv("GHOST_WORKSPACE", str(tmp_path))
    args = {
        "api_name": "daily",
        "table_name": "daily",
        "sync_mode": "date_incremental",
        "dataset_uri": "l1_bronze/tushare",
        "date_param": "trade_date",
        "calendar_mode": "natural",
        "start_date": "20260901",
        "batch_size": 4,
        "recheck_items": 1,
        "deep_recheck_items": 1,
        "page_size": 5,
        "max_pages": 10,
        "batch_sleep": 0,
        "time_budget_seconds": 30,
        "required_columns": ["ts_code", "trade_date"],
        "primary_key": ["ts_code", "trade_date"],
        "tushare_token": "test-token",
    }
    args.update(overrides)
    engine = TushareSyncBase(args)
    engine._start_deadline()
    return engine

def test_pagination_advances_by_actual_rows_and_probes_until_empty(tmp_path, monkeypatch):
    engine = _engine(tmp_path, monkeypatch)
    calls: list[int] = []

    class FakePro:
        def query(self, _api_name, **kwargs):
            offset = kwargs["offset"]
            calls.append(offset)
            if offset == 0:
                return pd.DataFrame(
                    {
                        "ts_code": ["000001.SZ", "000002.SZ", "000003.SZ"],
                        "trade_date": ["20260909"] * 3,
                    }
                )
            if offset == 3:
                return pd.DataFrame(
                    {
                        "ts_code": ["000004.SZ", "000005.SZ"],
                        "trade_date": ["20260909"] * 2,
                    }
                )
            return pd.DataFrame()

    result = engine._fetch(FakePro(), {"trade_date": "20260909"})

    assert len(result) == 5
    assert calls == [0, 3, 5]

def test_repeated_page_is_integrity_failure_not_fake_completion(tmp_path, monkeypatch):
    engine = _engine(tmp_path, monkeypatch)
    page = pd.DataFrame(
        {
            "ts_code": ["000001.SZ", "000002.SZ"],
            "trade_date": ["20260909", "20260909"],
        }
    )

    class FakePro:
        def query(self, _api_name, **_kwargs):
            return page.copy()

    with pytest.raises(TushareIntegrityError, match="did not advance offset"):
        engine._fetch(FakePro(), {"trade_date": "20260909"})

def test_wrong_partition_date_is_rejected(tmp_path, monkeypatch):
    engine = _engine(tmp_path, monkeypatch, paginate=False)
    bad = pd.DataFrame(
        {"ts_code": ["000001.SZ"], "trade_date": ["20260908"]}
    )

    with pytest.raises(TushareIntegrityError, match="response date does not match request"):
        engine._validate_response(bad, {"trade_date": "20260909"})

def test_range_response_cannot_escape_requested_window(tmp_path, monkeypatch):
    engine = _engine(
        tmp_path,
        monkeypatch,
        api_name="share_float",
        table_name="share_float",
        sync_mode="range_incremental",
        result_date_column="float_date",
        required_columns=["ts_code", "float_date"],
        primary_key=[],
    )
    bad = pd.DataFrame(
        {"ts_code": ["000001.SZ"], "float_date": ["20270101"]}
    )

    with pytest.raises(TushareIntegrityError, match="response outside requested range"):
        engine._validate_response(
            bad, {"start_date": "20260901", "end_date": "20261231"}
        )

def test_large_row_count_shrink_is_rejected(tmp_path, monkeypatch):
    engine = _engine(tmp_path, monkeypatch, min_row_ratio=0.90)
    state = pd.DataFrame(
        {
            "trade_date": ["20260909"],
            "checked_at": [datetime.now(timezone.utc).isoformat()],
            "row_count": [100],
            "object_key": ["daily/trade_date=20260909/data.parquet"],
            "sha256": ["abc"],
        }
    )
    engine._atomic_parquet(state, engine._sync_log_path())

    with pytest.raises(TushareIntegrityError, match="anomalous shrinkage"):
        engine._validate_shrink("trade_date", "20260909", 80)

    engine._validate_shrink("trade_date", "20260909", 95)

def test_r2_access_denied_is_not_treated_as_missing(tmp_path, monkeypatch):
    engine = _engine(tmp_path, monkeypatch)

    class FakeR2:
        def get_object(self, **_kwargs):
            raise ClientError(
                {
                    "Error": {"Code": "AccessDenied", "Message": "denied"},
                    "ResponseMetadata": {"HTTPStatusCode": 403},
                },
                "GetObject",
            )

    monkeypatch.setattr(engine, "_r2_client", lambda: FakeR2())

    with pytest.raises(RuntimeError, match="failed to read R2 object"):
        engine._read_remote_parquet("state.parquet")

def test_only_r2_no_such_key_can_become_empty_state(tmp_path, monkeypatch):
    engine = _engine(tmp_path, monkeypatch)

    class FakeR2:
        def get_object(self, **_kwargs):
            raise ClientError(
                {
                    "Error": {"Code": "NoSuchKey", "Message": "missing"},
                    "ResponseMetadata": {"HTTPStatusCode": 404},
                },
                "GetObject",
            )

    monkeypatch.setattr(engine, "_r2_client", lambda: FakeR2())
    assert engine._read_remote_parquet("missing.parquet").empty

def test_planner_keeps_recent_recheck_missing_backfill_and_deep_probe(tmp_path, monkeypatch):
    engine = _engine(tmp_path, monkeypatch)
    state = pd.DataFrame(
        {
            "trade_date": ["20260901", "20260902", "20260903", "20260904", "20260905"],
            "checked_at": [
                "2026-09-01T00:00:00+00:00",
                "2026-09-02T00:00:00+00:00",
                "2026-09-03T00:00:00+00:00",
                "2026-09-04T00:00:00+00:00",
                "2026-09-05T00:00:00+00:00",
            ],
            "row_count": [10, 10, 10, 10, 10],
            "object_key": [""] * 5,
            "sha256": [""] * 5,
        }
    )
    engine._atomic_parquet(state, engine._sync_log_path())

    plan = engine._plan_date_items(
        ["20260901", "20260902", "20260903", "20260904", "20260905", "20260906"]
    )

    assert plan == ["20260905", "20260906", "20260901"]

def test_partial_marker_fails_only_after_upload_phase(tmp_path, monkeypatch):
    monkeypatch.setenv("GHOST_WORKSPACE", str(tmp_path))
    finalizer = FinalizeTushare({})
    assert finalizer.run()["success"] is True

    (tmp_path / ".tushare-partial").write_text(
        "2026-09-10T00:00:00Z\tdaily\tintegrity\tbad rows\n",
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="TUSHARE_PARTIAL"):
        FinalizeTushare({}).run()

# ==========================================================================
# from test_r2_upload_behavior.py
# ==========================================================================

def _uploader(tmp_path, monkeypatch):
    monkeypatch.setenv("GHOST_WORKSPACE", str(tmp_path))
    root = tmp_path / "l1_bronze" / "tushare"
    data = root / "daily" / "trade_date=20260909" / "data.parquet"
    checkpoint = root / "daily" / "_sync_log.parquet"
    data.parent.mkdir(parents=True, exist_ok=True)
    checkpoint.parent.mkdir(parents=True, exist_ok=True)
    data.write_bytes(b"data")
    checkpoint.write_bytes(b"checkpoint")

    uploader = UploadR2(
        {
            "cf_account_id": "account",
            "cf_access_key": "access",
            "cf_secret_key": "secret",
            "cf_bucket_name": "bucket",
            "dataset_uri": "l1_bronze/tushare",
            "max_workers": 1,
        }
    )
    return uploader

def test_checkpoint_is_never_uploaded_after_data_failure(tmp_path, monkeypatch):
    uploader = _uploader(tmp_path, monkeypatch)
    calls: list[str] = []

    class FakeS3:
        def upload_file(self, _filename, _bucket, key, Config=None):
            calls.append(key)
            if key.endswith("data.parquet"):
                raise RuntimeError("simulated data upload failure")

    monkeypatch.setattr("bricks.r2_storage_upload.boto3.client", lambda *a, **k: FakeS3())
    monkeypatch.setattr("bricks.r2_storage_upload.time.sleep", lambda _seconds: None)

    with pytest.raises(ValueError, match="data phase"):
        uploader.run()

    assert calls
    assert not any(key.endswith("_sync_log.parquet") for key in calls)

def test_checkpoint_upload_occurs_only_after_successful_data_group(tmp_path, monkeypatch):
    uploader = _uploader(tmp_path, monkeypatch)
    calls: list[str] = []

    class FakeS3:
        def upload_file(self, _filename, _bucket, key, Config=None):
            calls.append(key)

    monkeypatch.setattr("bricks.r2_storage_upload.boto3.client", lambda *a, **k: FakeS3())

    result = uploader.run()

    assert result["success"] is True
    data_index = next(i for i, key in enumerate(calls) if key.endswith("data.parquet"))
    checkpoint_index = next(
        i for i, key in enumerate(calls) if key.endswith("_sync_log.parquet")
    )
    assert data_index < checkpoint_index
