"""Merged suite. Sections keep their original order:
  - test_todo_tool.py: todo_write's wire contract.
  - test_shell.py: P3 gate tests — persistent shell executor.
"""

from __future__ import annotations

from integrations.connectors.tool_defs import (
    ConnectorToolDef,
    approval_for_tool,
    clear_tool_defs,
    connector_for_tool,
    get_tool_def,
    register_runtime_tool,
    register_tool_def,
    target_arg_for,
)
from integrations.tools.todo import _TODO_SCHEMA, TodoList, todo_tools
import sys
import time
import pytest
from integrations.tools import ToolRegistry
from integrations.tools.shell import LocalExecutor, _parse_cwd, _parse_exit_code, shell_tools


# ==========================================================================
# from test_tool_catalog_contract.py
# ==========================================================================

def setup_function():
    clear_tool_defs()

def teardown_function():
    clear_tool_defs()

def test_unknown_tool_keeps_conservative_default():
    assert approval_for_tool("unknown", is_default_approval=True) is True
    assert approval_for_tool("unknown", is_default_approval=False) is False
    assert connector_for_tool("unknown") is None

def test_runtime_metadata_registers_read_and_write_effects():
    register_runtime_tool(
        "example_read",
        capabilities=["example", "read"],
        description="Read example data.",
    )
    register_runtime_tool(
        "example_write",
        capabilities=["example", "write"],
        description="Change example data.",
    )

    assert connector_for_tool("example_read") == "example"
    assert approval_for_tool("example_read", is_default_approval=True) is False
    assert approval_for_tool("example_write", is_default_approval=False) is True

def test_curated_extension_metadata_wins_over_runtime_fallback():
    register_tool_def(
        ConnectorToolDef(
            connector="example",
            name="example_send",
            label="Send example",
            kind="write",
            description="Curated provider description.",
            target_arg="recipient",
        )
    )
    register_runtime_tool(
        "example_send",
        capabilities=["example", "read"],
        description="Runtime fallback must not downgrade this tool.",
    )

    tool = get_tool_def("example_send")
    assert tool is not None
    assert tool.kind == "write"
    assert tool.label == "Send example"
    assert target_arg_for("example_send") == "recipient"
    assert approval_for_tool("example_send", is_default_approval=False) is True

def test_read_tool_cannot_declare_standing_rule_target():
    try:
        register_tool_def(
            ConnectorToolDef(
                connector="example",
                name="unsafe_read",
                label="Unsafe",
                kind="read",
                description="",
                target_arg="target",
            )
        )
    except ValueError as exc:
        assert "read tools cannot declare" in str(exc)
    else:
        raise AssertionError("read target declaration must be rejected")

# ==========================================================================
# from test_todo_tool.py
# ==========================================================================

def _write(**kwargs):
    todo = TodoList()
    (spec,) = todo_tools(todo)
    return spec(**kwargs), todo

def test_schema_param_is_todos_not_items():
    props = _TODO_SCHEMA["function"]["parameters"]["properties"]
    assert "todos" in props
    assert "items" not in props  # regression guard: see module docstring
    assert _TODO_SCHEMA["function"]["parameters"]["required"] == ["todos"]

def test_todos_key_writes_the_list():
    result, todo = _write(todos=[{"content": "a", "status": "in_progress"}])
    assert todo.items == [{"content": "a", "status": "in_progress"}]
    assert result == {"count": 1, "todos": [{"content": "a", "status": "in_progress"}]}

def test_legacy_items_key_still_executes():
    result, todo = _write(items=[{"content": "b", "status": "done"}])
    assert todo.items == [{"content": "b", "status": "done"}]
    assert result["count"] == 1

# ==========================================================================
# from test_shell.py
# ==========================================================================

_WIN = sys.platform == "win32"

SET_ENV = "$env:GREETING='hello_world'" if _WIN else "export GREETING=hello_world"

ECHO_ENV = "echo $env:GREETING" if _WIN else "echo $GREETING"

EXIT_OK = "cmd /c exit 0" if _WIN else "true"

EXIT_FAIL = "cmd /c exit 1" if _WIN else "false"

SLEEP_5 = "Start-Sleep -Seconds 5" if _WIN else "sleep 5"

PRINT_1000 = (
    'foreach ($i in 1..1000) { "line$i" }'
    if _WIN
    else "for i in $(seq 1 1000); do echo line$i; done"
)

def test_marker_parsers_accept_prefixed_windows_output():
    marker = "__DELTA_DONE_test__"
    line = f"\x1b[?1h{marker} 0 C:\\work\\sub\r\n"
    assert _parse_exit_code(line, marker) == 0
    assert _parse_cwd(line, marker) == "C:\\work\\sub"

@pytest.fixture
def executor(tmp_path):
    ex = LocalExecutor(cwd=tmp_path, default_timeout=10)
    yield ex
    ex.close()

def test_cwd_persists_across_calls(executor, tmp_path):
    (tmp_path / "sub").mkdir()
    changed = executor.run("cd sub")
    assert changed["exit_code"] == 0
    result = executor.run("pwd")
    assert result["exit_code"] == 0
    assert "sub" in result["output"]
    assert executor.cwd.endswith("sub")

def test_env_persists_across_calls(executor):
    executor.run(SET_ENV)
    result = executor.run(ECHO_ENV)
    assert "hello_world" in result["output"]

def test_exit_code_captured(executor):
    assert executor.run(EXIT_OK)["exit_code"] == 0
    assert executor.run(EXIT_FAIL)["exit_code"] == 1

def test_timeout_kills_command(executor):
    start = time.monotonic()
    result = executor.run(SLEEP_5, timeout=1)
    elapsed = time.monotonic() - start
    assert result["timed_out"] is True
    assert elapsed < 4.0  # did not block for the full sleep
    # session survives the timeout — still usable (POSIX keeps the shell; Windows respawns)
    assert executor.run("echo alive")["output"].strip().endswith("alive")

def test_large_output_truncated_keeps_tail(tmp_path):
    ex = LocalExecutor(cwd=tmp_path, max_output_chars=200, default_timeout=10)
    try:
        result = ex.run(PRINT_1000)
        assert result["truncated"] is True
        assert len(result["output"]) <= 200
        # the END survives (where test/build verdicts live), the head is dropped
        assert "line1000" in result["output"]
        assert "line1\n" not in result["output"]
    finally:
        ex.close()

def test_shell_tool_integration(executor, tmp_path):
    reg = ToolRegistry()
    reg.register_all(shell_tools(executor))
    assert {"run_shell", "shell_task_output", "shell_task_kill"} <= set(reg.names())

    spec = reg.get("run_shell")
    assert spec.metadata.requires_approval is True
    # polling/killing the agent's own background tasks doesn't need approval
    assert reg.get("shell_task_output").metadata.requires_approval is False
    assert reg.get("shell_task_kill").metadata.requires_approval is False

    out = reg.execute("run_shell", {"command": "echo hi"})
    assert "hi" in out["output"]

def test_run_shell_accepts_description_and_clamped_timeout(executor):
    reg = ToolRegistry()
    reg.register_all(shell_tools(executor))
    # `description` rides along for approval prompts/audit; it must not break execution.
    out = reg.execute(
        "run_shell",
        {"command": "echo ok", "description": "Say ok", "timeout_seconds": 99999},
    )
    assert out["exit_code"] == 0 and "ok" in out["output"]

ECHO_THEN_SLEEP = (
    "Write-Output started; Start-Sleep -Seconds 30"
    if _WIN
    else "echo started; sleep 30"
)

QUICK_ECHO = "Write-Output quick_done" if _WIN else "echo quick_done"

def _poll_output(reg, task_id, *, until_status=None, deadline=10.0):
    """Poll shell_task_output, accumulating output until a status is reached."""
    acc = ""
    end = time.monotonic() + deadline
    while time.monotonic() < end:
        res = reg.execute("shell_task_output", {"task_id": task_id})
        acc += res["output"]
        if until_status is None or res["status"] == until_status:
            if until_status is None and not acc:
                time.sleep(0.1)
                continue
            return acc, res
        time.sleep(0.1)
    return acc, res

def test_background_task_runs_and_exits(executor):
    reg = ToolRegistry()
    reg.register_all(shell_tools(executor))
    started = reg.execute(
        "run_shell", {"command": QUICK_ECHO, "should_run_background": True}
    )
    assert started["status"] == "running" and started["task_id"]

    acc, res = _poll_output(reg, started["task_id"], until_status="exited")
    assert res["status"] == "exited"
    assert res["exit_code"] == 0
    assert "quick_done" in acc

    # output reads are incremental: a second read returns nothing new
    again = reg.execute("shell_task_output", {"task_id": started["task_id"]})
    assert again["output"] == ""

def test_background_task_kill(executor):
    reg = ToolRegistry()
    reg.register_all(shell_tools(executor))
    started = reg.execute(
        "run_shell", {"command": ECHO_THEN_SLEEP, "should_run_background": True}
    )
    acc, _ = _poll_output(reg, started["task_id"])
    assert "started" in acc  # it's alive and producing output

    killed = reg.execute("shell_task_kill", {"task_id": started["task_id"]})
    assert killed["status"] == "killed"

    res = reg.execute("shell_task_output", {"task_id": started["task_id"]})
    assert res["status"] == "exited"

def test_background_unknown_task_errors(executor):
    reg = ToolRegistry()
    reg.register_all(shell_tools(executor))
    assert (
        "unknown task"
        in reg.execute("shell_task_output", {"task_id": "bg-99"})["error"]
    )
    assert (
        "unknown task" in reg.execute("shell_task_kill", {"task_id": "bg-99"})["error"]
    )

def _wait_until_started(reg, task_id, deadline=10.0):
    acc, _ = _poll_output(reg, task_id, deadline=deadline)
    assert "started" in acc

def _wait_exited(reg, task_id, deadline=10.0):
    end = time.monotonic() + deadline
    while time.monotonic() < end:
        res = reg.execute("shell_task_output", {"task_id": task_id})
        if res["status"] == "exited":
            return res
        time.sleep(0.1)
    raise AssertionError(f"task {task_id} did not exit")

def test_background_spawn_reports_pid_and_detach(executor):
    reg = ToolRegistry()
    reg.register_all(shell_tools(executor))
    managed = reg.execute(
        "run_shell", {"command": QUICK_ECHO, "should_run_background": True}
    )
    assert isinstance(managed["pid"], int) and managed["pid"] > 0
    assert managed["detach"] is False
    detached = reg.execute(
        "run_shell",
        {"command": QUICK_ECHO, "should_run_background": True, "should_detach": True},
    )
    assert isinstance(detached["pid"], int) and detached["pid"] > 0
    assert detached["detach"] is True

def test_process_events_reported_to_sink(executor):
    """Spawn + kill facts flow to the attached sink — the hook the manager uses to
    land them in the run ledger (docs/run-ledger-adr.md §2b)."""
    events = []
    executor.process_event_sink = events.append
    reg = ToolRegistry()
    reg.register_all(shell_tools(executor))
    started = reg.execute(
        "run_shell", {"command": ECHO_THEN_SLEEP, "should_run_background": True}
    )
    _wait_until_started(reg, started["task_id"])
    reg.execute("shell_task_kill", {"task_id": started["task_id"]})

    spawned = [e for e in events if e["event"] == "process.spawned"]
    killed = [e for e in events if e["event"] == "process.killed"]
    assert spawned and killed
    assert spawned[0]["task_id"] == started["task_id"]
    assert spawned[0]["pid"] == started["pid"]
    assert spawned[0]["detach"] is False
    assert killed[0]["task_id"] == started["task_id"]

def test_process_sink_errors_never_break_execution(executor):
    def broken(_event):
        raise RuntimeError("bookkeeping exploded")

    executor.process_event_sink = broken
    reg = ToolRegistry()
    reg.register_all(shell_tools(executor))
    started = reg.execute(
        "run_shell", {"command": QUICK_ECHO, "should_run_background": True}
    )
    assert started["status"] == "running"

def test_managed_task_killed_on_shutdown(tmp_path):
    ex = LocalExecutor(cwd=tmp_path, default_timeout=10)
    try:
        reg = ToolRegistry()
        reg.register_all(shell_tools(ex))
        started = reg.execute(
            "run_shell", {"command": ECHO_THEN_SLEEP, "should_run_background": True}
        )
        _wait_until_started(reg, started["task_id"])
        # Session/app teardown: the default (managed) task must die with it.
        ex.shutdown()
        res = _wait_exited(reg, started["task_id"])
        assert res["exit_code"] not in (None, 0)
    finally:
        ex.close()

def test_detached_task_survives_shutdown(tmp_path):
    ex = LocalExecutor(cwd=tmp_path, default_timeout=10)
    try:
        reg = ToolRegistry()
        reg.register_all(shell_tools(ex))
        started = reg.execute(
            "run_shell",
            {"command": ECHO_THEN_SLEEP, "should_run_background": True, "should_detach": True},
        )
        _wait_until_started(reg, started["task_id"])
        ex.shutdown()
        time.sleep(0.5)  # give a wrong kill (if any) time to land
        res = reg.execute("shell_task_output", {"task_id": started["task_id"]})
        assert res["status"] == "running"  # still alive after teardown
        # cleanup: stop it explicitly via the normal kill path
        killed = reg.execute("shell_task_kill", {"task_id": started["task_id"]})
        assert killed["status"] == "killed"
    finally:
        ex.close()

# ==========================================================================
# from test_extension_api.py
# ==========================================================================

def test_public_extension_api_imports() -> None:
    from delta_extension_api import CredentialStore, SecretSource, SecretStore
    from delta_extension_api.browser import (
        BrowserAutomationProvider,
        browser_tool_schema,
        register_browser_provider,
    )
    from delta_extension_api.connectors import (
        ConnectorDescriptor,
        ConnectorToolDef,
        Field,
        ValidationResult,
        register_descriptors,
        register_tool_defs,
        register_tool_factory,
    )
    from delta_extension_api.messaging import (
        BasePlatformAdapter,
        ConnectorSettings,
        MessagingProvider,
        SendResult,
        SessionSource,
        TeamAuth,
        register_messaging_provider,
    )
    from delta_extension_api.tooling import (
        attach_connector_tool,
        resolve_limit,
        extract_html_text,
        execute_http_request,
        get_time_ms,
        build_tool_schema,
    )

    assert SecretStore is CredentialStore
    assert SecretSource is not None
    assert BrowserAutomationProvider is not None
    assert callable(browser_tool_schema)
    assert callable(register_browser_provider)
    assert ConnectorDescriptor is not None
    assert ConnectorToolDef is not None
    assert Field is not None
    assert ValidationResult is not None
    assert callable(register_descriptors)
    assert callable(register_tool_defs)
    assert callable(register_tool_factory)
    assert BasePlatformAdapter is not None
    assert ConnectorSettings is not None
    assert MessagingProvider is not None
    assert SendResult is not None
    assert SessionSource is not None
    assert TeamAuth is not None
    assert callable(register_messaging_provider)
    assert callable(attach_connector_tool)
    assert resolve_limit(100, ceiling=20) == 20
    assert extract_html_text("<p>Hello</p>") == "Hello"
    assert callable(execute_http_request)
    assert isinstance(get_time_ms(), int)
    assert build_tool_schema("x", "x", {}, [])["function"]["name"] == "x"
