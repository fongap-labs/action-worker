"""Merged suite. Sections keep their original order:
  - test_todo_tool.py: todo_write's wire contract.
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
