from __future__ import annotations
from kit_target import target_root

from pathlib import Path
from types import SimpleNamespace

from delta_worker_sdk import (
    CAPABILITY_ABI_VERSION,
    CapabilityBoundary,
    CapabilityGrants,
    CapabilityJob,
    CapabilityResult,
    WorkerContext,
)

import advanced.browser.worker as browser_worker
from advanced.browser.worker import _guard_filesystem, _path_is_allowed
from advanced.browser.worker_bridge import browser_inventory


def _browser_job(
    *,
    capability_id: str = "delta-suite.browser.browser_snapshot",
    session_id: str | None = None,
    workspace: str | None = None,
    read_roots: list[str] | None = None,
    write_roots: list[str] | None = None,
    arguments: dict[str, object] | None = None,
) -> CapabilityJob:
    return CapabilityJob(
        abi_version=CAPABILITY_ABI_VERSION,
        capability_id=capability_id,
        job_id="browser-job-1",
        session_id=session_id,
        workspace=workspace,
        arguments=arguments or {},
        grants=CapabilityGrants(),
        boundary=CapabilityBoundary(
            read_roots=read_roots or [],
            write_roots=write_roots or [],
        ),
    )


def _browser_context(job: CapabilityJob) -> WorkerContext:
    return WorkerContext(
        job=job,
        secret_values={},
        progress_sender=lambda progress: None,
        cancel_checker=lambda: False,
    )


def test_browser_inventory_uses_one_persistent_process_group() -> None:
    rows = browser_inventory()
    names = {row["tool_name"] for row in rows}
    assert {
        "browser_open_url",
        "browser_snapshot",
        "browser_click",
        "browser_type",
        "browser_screenshot",
        "browser_close",
        "browser_state",
        "browser_screenshot_state",
    } <= names
    assert all(row["persistent"] is True for row in rows)
    assert {row["process_key"] for row in rows} == {"browser"}
    assert {
        row["tool_name"]
        for row in rows
        if row["metadata"].get("model_visible") is False
    } == {"browser_state", "browser_screenshot_state"}


def test_browser_file_paths_are_confined_to_job_grants(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("no", encoding="utf-8")
    inside = workspace / "inside.txt"
    inside.write_text("ok", encoding="utf-8")

    assert _path_is_allowed(str(inside), [workspace.resolve()])
    assert not _path_is_allowed(str(outside), [workspace.resolve()])

    job = _browser_job(
        workspace=str(workspace),
        read_roots=[str(workspace)],
        write_roots=[str(workspace)],
    )
    assert _guard_filesystem(job, "browser_upload_file", {"path": str(inside)}) is None
    assert _guard_filesystem(job, "browser_upload_file", {"path": str(outside)}) is not None

    screenshot_args: dict[str, object] = {}
    assert _guard_filesystem(job, "browser_screenshot", screenshot_args) is None
    assert str(screenshot_args["path"]).startswith(str(workspace))
    assert _guard_filesystem(
        job, "browser_screenshot", {"path": str(tmp_path / "outside.png")}
    ) is not None


def test_browser_session_change_resets_context(monkeypatch) -> None:
    closed: list[bool] = []
    provider = SimpleNamespace(close=lambda: closed.append(True) or {"ok": True})
    monkeypatch.setattr(browser_worker, "PROVIDER", provider)
    monkeypatch.setattr(browser_worker, "_ACTIVE_SESSION_ID", None)

    browser_worker._ensure_session(_browser_job(session_id="session-a"))
    browser_worker._ensure_session(_browser_job(session_id="session-a"))
    assert closed == []

    browser_worker._ensure_session(_browser_job(session_id="session-b"))
    assert closed == [True]


def test_browser_execute_returns_sdk_result() -> None:
    job = _browser_job(arguments={"max_chars": 100})
    result = browser_worker._execute(
        _browser_context(job),
        {"browser_snapshot": lambda **arguments: {"text": "ok", **arguments}},
    )

    assert isinstance(result, CapabilityResult)
    assert result.state == "completed"
    assert result.result == {"text": "ok", "max_chars": 100}
    assert result.abi_version == CAPABILITY_ABI_VERSION


def test_browser_execute_fails_closed_on_non_browser_capability() -> None:
    job = _browser_job(capability_id="delta-suite.connector.github_search")
    result = browser_worker._execute(_browser_context(job), {})

    assert result.state == "failed"
    assert result.diagnostics is not None
    assert result.diagnostics.error_code == "capability_mismatch"


def test_browser_main_delegates_persistent_framing_to_sdk(monkeypatch) -> None:
    captured: dict[str, object] = {}

    monkeypatch.setattr(
        browser_worker,
        "_tool_map",
        lambda: {"browser_snapshot": lambda **arguments: arguments},
    )

    def run(handler):
        captured["handler"] = handler
        return 7

    monkeypatch.setattr(browser_worker, "run_persistent_worker", run)

    assert browser_worker.main() == 7
    assert callable(captured["handler"])


def test_browser_worker_does_not_reimplement_protocol_framing() -> None:
    source = (
        target_root()
        / "advanced"
        / "browser"
        / "worker.py"
    ).read_text(encoding="utf-8")

    assert "sys.stdin.readline" not in source
    assert "json.loads" not in source
    assert "run_persistent_worker" in source


def test_browser_provider_forces_chromium_through_guarded_proxy() -> None:
    source = (
        target_root()
        / "advanced"
        / "browser"
        / "playwright_provider.py"
    ).read_text(encoding="utf-8")
    assert "GuardedBrowserProxy()" in source
    # Newer providers also pass the per-session proxy credentials; older ones only the server.
    assert 'proxy={"server": proxy_url}' in source or (
        '"server": proxy_url,' in source
        and '"username": self._proxy.credentials[0],' in source
        and '"password": self._proxy.credentials[1],' in source
    )
    assert '"--proxy-bypass-list=<-loopback>"' in source
    assert '"--disable-quic"' in source
    assert '"--force-webrtc-ip-handling-policy=disable_non_proxied_udp"' in source
