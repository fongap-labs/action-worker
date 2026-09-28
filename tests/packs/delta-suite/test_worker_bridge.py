from __future__ import annotations

import json
from pathlib import Path

from delta_worker_sdk import (
    CapabilityBoundary,
    CapabilityGrants,
    CapabilityJob,
    WorkerContext,
)

import advanced.worker as connector_worker
from advanced.worker_bridge import (
    EXTENSION_ID,
    EXTENSIONS_DIRNAME,
    GrantSecretStore,
    MANIFEST_VERSION,
    connector_tool_names,
    install_worker_manifest,
    tool_for_job,
    worker_manifest,
)
from advanced.connectors.catalog_manifest import catalog_manifest



def _worker_context(
    *,
    capability_id: str = "delta-suite.connector.github_search",
    arguments: dict[str, object] | None = None,
) -> WorkerContext:
    job = CapabilityJob(
        abi_version=2,
        capability_id=capability_id,
        job_id="job-suite-1",
        arguments=arguments or {},
        grants=CapabilityGrants(secrets=["github.token"]),
        boundary=CapabilityBoundary(secrets=["github.token"]),
    )
    return WorkerContext(
        job=job,
        secret_values={
            "github.token": "secret-token",
            "not.granted": "must-not-leak",
        },
        progress_sender=lambda progress: None,
        cancel_checker=lambda: False,
    )


def test_connector_worker_uses_sdk_capability_contract(monkeypatch) -> None:
    observed: dict[str, object] = {}

    def tool_for_job(name: str, granted: dict[str, str]):
        observed["name"] = name
        observed["granted"] = dict(granted)

        def tool(**arguments):
            observed["arguments"] = dict(arguments)
            return {"ok": True}

        return tool

    monkeypatch.setattr(connector_worker, "tool_for_job", tool_for_job)
    result = connector_worker._handler_for_tool("github_search")(
        _worker_context(arguments={"query": "delta"})
    )

    assert result.state == "completed"
    assert result.result == {"ok": True}
    assert observed == {
        "name": "github_search",
        "granted": {"github.token": "secret-token"},
        "arguments": {"query": "delta"},
    }


def test_connector_worker_fails_closed_on_capability_mismatch() -> None:
    result = connector_worker._handler_for_tool("github_search")(
        _worker_context(capability_id="delta-suite.connector.gmail_search_messages")
    )

    assert result.state == "failed"
    assert result.diagnostics is not None
    assert result.diagnostics.error_code == "capability_mismatch"


def test_connector_worker_returns_typed_tool_error(monkeypatch) -> None:
    def tool_for_job(name: str, granted: dict[str, str]):
        def tool(**arguments):
            raise RuntimeError("boom")

        return tool

    monkeypatch.setattr(connector_worker, "tool_for_job", tool_for_job)
    result = connector_worker._handler_for_tool("github_search")(_worker_context())

    assert result.state == "failed"
    assert result.diagnostics is not None
    assert result.diagnostics.error_code == "tool_exception"
    assert result.diagnostics.error_message == "RuntimeError: boom"

def test_grant_secret_store_is_memory_only() -> None:
    store = GrantSecretStore(
        {
            "github.token": "secret-token",
            "github.base_url": "https://api.github.com",
        }
    )
    assert store.get("github:default") == {
        "token": "secret-token",
        "base_url": "https://api.github.com",
    }
    store.put("github:default", {"token": "rotated", "account_id": "default"})
    assert store.get("github:default") == {"token": "rotated", "account_id": "default"}
    assert store.resolve({"token": "rotated"}) == {"token": "rotated"}
    status = store.status()
    assert status == [
        {
            "profile": "github:default",
            "type": None,
            "account": "default",
            "expired": False,
        }
    ]


def test_grant_secret_store_rejects_retired_colon_syntax() -> None:
    store = GrantSecretStore(
        {
            "github.token": "canonical",
            "github:base_url": "retired",
        }
    )
    assert store.get("github:default") == {"token": "canonical"}


def test_worker_manifest_contains_connector_workers() -> None:
    manifest = worker_manifest()
    assert manifest["version"] == MANIFEST_VERSION
    assert manifest["source"] == "delta-suite"

    workers = manifest["workers"]
    names = {item["tool_name"] for item in workers}
    assert {
        "gmail_search_messages",
        "gcal_list_events",
        "hubspot_search",
        "notion_search",
        "github_search",
    } <= names
    assert {
        "browser_open_url",
        "browser_snapshot",
        "browser_click",
        "browser_close",
        "browser_state",
        "browser_screenshot_state",
    } <= names
    assert not any(name.startswith("email_") for name in names)
    assert not any(name.startswith("slack_") for name in names)
    assert not any(name.startswith("telegram_") for name in names)

    for item in workers:
        assert Path(item["program"]).is_absolute()
        if item["tool_name"].startswith("browser_"):
            assert item["arguments"][:2] == ["-m", "advanced.browser.worker"]
        else:
            assert item["arguments"][:2] == ["-m", "advanced.worker"]
        if item["tool_name"].startswith("browser_"):
            assert item["capability_id"] == f"delta-suite.browser.{item['tool_name']}"
            assert item["persistent"] is True
            assert item["process_key"] == "browser"
        else:
            assert item["capability_id"] == f"delta-suite.connector.{item['tool_name']}"
        assert item["grants"]["exec"] is False
        assert isinstance(item["grants"]["secrets"], list)


def test_install_worker_manifest(tmp_path: Path) -> None:
    path = install_worker_manifest(tmp_path)
    assert path == tmp_path / EXTENSIONS_DIRNAME / EXTENSION_ID / "capability-workers.json"
    stored = json.loads(path.read_text(encoding="utf-8"))
    assert stored["version"] == MANIFEST_VERSION
    assert stored["workers"]


def test_tool_resolution_does_not_read_file_backed_secret_store() -> None:
    tool = tool_for_job("github_search", {})
    assert tool is not None
    assert tool.__name__ == "github_search"


def test_connector_catalog_matches_worker_inventory() -> None:
    tool_map = connector_tool_names()
    catalog = catalog_manifest()
    rows = {row["name"]: row for row in catalog["connectors"]}

    assert "slack" not in rows
    assert "telegram" not in rows
    assert rows["gmail"]["ui"]["detail"] == "generic"
    assert rows["google_calendar"]["ui"]["detail"] == "generic"
    assert rows["hubspot"]["ui"]["detail"] == "generic"
    assert rows["github"]["ui"]["detail"] == "generic"

    for connector, names in tool_map.items():
        if connector in rows:
            assert rows[connector]["tools"] == names
