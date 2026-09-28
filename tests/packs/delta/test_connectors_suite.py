"""Merged suite. Sections keep their original order:
  - test_email_tools.py: Email (IMAP/SMTP) connector tools — fakes only, no network, no real mailbox.
  - test_messaging_operation_contract.py: Contract checks for provider-owned messaging operations.
  - test_send_file.py: Foundation send_file contract: provider dispatch plus local path containment.
  - test_send_target_resolution.py: Connector approval, baseline and messaging target contract tests.
"""

from __future__ import annotations

from kit_target import target_root
from pathlib import Path
from integrations.connectors.catalog_copy import (
    access_for,
    about_for,
    clear_catalog_copy,
    register_catalog_copy,
)
from integrations.connectors.descriptors import (
    ConnectorDescriptor,
    Field,
    clear_descriptors,
    get_descriptor,
    list_descriptors,
    register_descriptor,
)
import pytest
from integrations.connectors.config import ConnectorSettings
from integrations.connectors.gateway import Gateway
from integrations.connectors import tool_defs
from integrations.connectors import browser_automation as browser
from email.message import EmailMessage
from integrations.connectors.email_tools import (
    build_search_criteria,
    decode_mime_header,
    extract_text_body,
    make_email_tools,
    resolve_servers,
)
from core.roots import RootDir
from packages.credential_store import CredentialStore as SecretStore
import importlib.util
from integrations.connectors.messaging_providers import (
    MessagingProvider,
    clear_messaging_providers,
    messaging_operation,
    register_messaging_provider,
)
from integrations.connectors.base import SendResult
from integrations.connectors.messaging_providers import (
    MessagingProvider,
    clear_messaging_providers,
    register_messaging_provider,
)
from integrations.connectors.tools import build_send_file
from integrations.connectors.tool_defs import TOOL_DEFS, approval_for_tool
from integrations.connectors.tools import build_send_message
import asyncio
import integrations.managed as managed


# ==========================================================================
# from test_connector_api_boundary.py
# ==========================================================================

ROOT = target_root()

API = ROOT / "apps" / "desktop" / "src" / "api.ts"

DESKTOP = ROOT / "apps" / "desktop" / "src"

def test_connector_api_owns_only_generic_account_shape() -> None:
    text = API.read_text(encoding="utf-8")

    assert "export interface AccountRow" in text
    assert "accounts?: AccountRow[]" in text

    connector_start = text.index("export interface Connector {")
    connector_end = text.index("\n}\n", connector_start)
    connector = text[connector_start:connector_end]

    for legacy_type in (
        "SlackWorkspace",
        "SlackMember",
        "SlackChannelEntry",
        "SlackStatus",
        "GithubInstallation",
        "GithubStatus",
        "HubSpotPortal",
        "GmailAccount",
        "GmailFilters",
    ):
        assert legacy_type not in text

    for legacy_field in (
        "workspaces?:",
        "portals?:",
        "installations?:",
        "filters?:",
        "hidden_fields?:",
    ):
        assert legacy_field not in connector

    for legacy_wrapper in (
        "getSlackDirectory",
        "getSlackChannels",
        "addSlackApprovalOwner",
        "removeSlackApprovalOwner",
        "disconnectSlackWorkspace",
        "disconnectGmailAccount",
        "setGmailDefaultAccount",
        "disconnectGcalAccount",
        "setGcalDefaultAccount",
        "setGmailFilters",
        "getGithubStatus",
        "disconnectGithubInstallation",
        "disconnectHubSpotPortal",
        "setHubSpotDefaultPortal",
        "setHubSpotHiddenFields",
        "getSlackStatus",
    ):
        assert legacy_wrapper not in text

def test_connector_consumers_narrow_capability_payloads_locally() -> None:
    subscriptions = (DESKTOP / "components" / "SubscriptionsChip.tsx").read_text(encoding="utf-8")
    inbox = (DESKTOP / "components" / "InboxConfigure.tsx").read_text(encoding="utf-8")
    listing = (
        DESKTOP / "features" / "connectors" / "components" / "ConnectorsList.tsx"
    ).read_text(encoding="utf-8")

    assert "getSlackChannels" not in subscriptions
    assert "workspaceChannels" in subscriptions
    assert 'ui?.detail === "workspace_chat"' in subscriptions

    assert "slack?.workspaces" not in inbox
    assert 'ui?.detail === "workspace_chat"' in inbox

    assert "c.portals" not in listing
    assert 'ui?.detail === "crm_portals_privacy"' in listing

# ==========================================================================
# from test_connector_catalog_contract.py
# ==========================================================================

def setup_function():
    clear_descriptors()
    clear_catalog_copy()

def teardown_function__connector_catalog_contract():
    clear_descriptors()
    clear_catalog_copy()

def test_foundation_catalog_is_provider_driven():
    assert list_descriptors() == []
    assert about_for("vendor-x") == ""
    assert access_for("vendor-x")

def test_extension_can_register_descriptor_and_copy():
    descriptor = ConnectorDescriptor(
        name="example",
        title="Example",
        icon="E",
        blurb="Example extension connector.",
        auth="token",
        two_way=False,
        fields=[Field("token", "Token", secret=True)],
        instructions=["Provide a token."],
    )
    register_descriptor(descriptor)
    register_catalog_copy(
        "example",
        about="Example provider copy.",
        access=["Reads data exposed by the example provider."],
    )

    assert get_descriptor("example") is descriptor
    assert list_descriptors() == [descriptor]
    assert about_for("example") == "Example provider copy."
    assert access_for("example") == ["Reads data exposed by the example provider."]

def test_duplicate_registration_requires_explicit_replace():
    first = ConnectorDescriptor("example", "One", "E", "", "none", False, [], [])
    second = ConnectorDescriptor("example", "Two", "E", "", "none", False, [], [])
    register_descriptor(first)

    try:
        register_descriptor(second)
    except ValueError as exc:
        assert "already registered" in str(exc)
    else:
        raise AssertionError("duplicate descriptor registration must fail")

    register_descriptor(second, should_replace=True)
    assert get_descriptor("example") is second

def test_catalog_copy_replace_is_explicit():
    register_catalog_copy("example", about="one", access=["one"])
    try:
        register_catalog_copy("example", about="two", access=["two"])
    except ValueError as exc:
        assert "already registered" in str(exc)
    else:
        raise AssertionError("duplicate catalog registration must fail")

    register_catalog_copy("example", about="two", access=["two"], should_replace=True)
    assert about_for("example") == "two"
    assert access_for("example") == ["two"]

# ==========================================================================
# from test_connector_secret_source.py
# ==========================================================================

def test_gateway_requires_injected_secret_source_when_loading_settings() -> None:
    with pytest.raises(
        ValueError,
        match="secrets is required when connector settings are not supplied",
    ):
        Gateway()

def test_gateway_allows_explicit_settings_without_secret_source() -> None:
    gateway = Gateway(
        settings={
            "fake": ConnectorSettings(
                platform="fake",
                enabled=True,
                allow_all=True,
            )
        }
    )

    assert gateway.secrets is None
    assert gateway.settings["fake"].enabled is True

def test_legacy_secret_backed_tool_enablement_authority_is_removed() -> None:
    for name in (
        "load_tool_settings",
        "patch_tool_settings",
        "tool_enabled",
        "active_tool_defs",
        "tool_dicts",
    ):
        assert not hasattr(tool_defs, name)

# ==========================================================================
# from test_browser_provider_contract.py
# ==========================================================================

def teardown_function__browser_provider_contract() -> None:
    browser.clear_browser_provider()

def test_foundation_has_no_builtin_interactive_browser_provider() -> None:
    browser.clear_browser_provider()

    assert browser.build_browser_tools() == []
    state = browser.browser_state()
    assert state["available"] is False
    assert state["status"] == "unavailable"
    assert browser.browser_close_session()["ok"] is True

def test_extension_provider_registers_without_owning_policy() -> None:
    browser.clear_browser_provider()

    def sample_tool() -> dict[str, bool]:
        return {"ok": True}

    sample_tool.__name__ = "browser_sample"

    provider = browser.BrowserAutomationProvider(
        name="test-provider",
        make_tools=lambda: [sample_tool],
        state=lambda: {"open": True, "status": "open"},
        screenshot=lambda: {"ok": True},
        close=lambda: {"ok": True},
    )

    browser.register_browser_provider(provider)

    assert browser.browser_automation_provider() is provider
    assert browser.build_browser_tools() == [sample_tool]
    assert browser.browser_state()["provider"] == "test-provider"
    assert browser.browser_take_screenshot()["ok"] is True
    assert browser.browser_close_session()["ok"] is True

def test_provider_registration_is_single_owner_by_default() -> None:
    browser.clear_browser_provider()
    provider = browser.BrowserAutomationProvider(
        name="one",
        make_tools=list,
        state=dict,
        screenshot=dict,
        close=dict,
    )
    browser.register_browser_provider(provider)

    replacement = browser.BrowserAutomationProvider(
        name="two",
        make_tools=list,
        state=dict,
        screenshot=dict,
        close=dict,
    )

    try:
        browser.register_browser_provider(replacement)
    except RuntimeError:
        pass
    else:
        raise AssertionError("provider replacement must require explicit should_replace=True")

    browser.register_browser_provider(replacement, should_replace=True)
    assert browser.browser_automation_provider() is replacement

# ==========================================================================
# from test_email_tools.py
# ==========================================================================

class FakeIMAP:
    """Records commands; serves canned messages keyed by uid."""

    def __init__(self, messages: dict[str, EmailMessage] | None = None):
        self.messages = messages or {}
        self.commands: list[tuple] = []
        self.logged_in = None
        self.selected = None

    def login(self, user, password):
        self.logged_in = (user, password)
        return "OK", [b"Logged in"]

    def select(self, folder, readonly=False):
        self.commands.append(("select", folder, readonly))
        self.selected = folder
        return "OK", [b"42"]

    def list(self):
        return "OK", [
            b'(\\HasNoChildren) "/" "INBOX"',
            b'(\\HasNoChildren) "/" "[Gmail]/Sent Mail"',
            b'(\\Noselect \\HasChildren) "/" "[Gmail]"',
        ]

    def status(self, folder, what):
        return "OK", [folder.encode() + b" (MESSAGES 7)"]

    def uid(self, command, *args):
        self.commands.append(("uid", command) + args)
        if command == "SEARCH":
            uids = b" ".join(uid.encode() for uid in sorted(self.messages, key=int))
            return "OK", [uids]
        if command == "FETCH":
            uid, spec = args[0], args[1]
            uid = uid.decode() if isinstance(uid, bytes) else uid
            msg = self.messages.get(uid)
            if msg is None:
                return "OK", [None]
            raw = msg.as_bytes()
            if "HEADER.FIELDS" in spec:
                wanted = spec.split("(")[2].rstrip(")]")
                fields = []
                for name in wanted.split():
                    value = msg.get(name)
                    if value:
                        fields.append(f"{name}: {value}".encode())
                raw = b"\r\n".join(fields) + b"\r\n\r\n"
            meta = f"1 (UID {uid} FLAGS (\\Seen)".encode()
            if "BODYSTRUCTURE" in spec:
                meta += b' BODYSTRUCTURE ("ATTACHMENT" ("FILENAME" "x"))'
            return "OK", [(meta, raw), b")"]
        raise AssertionError(f"unexpected uid command {command}")

    def logout(self):
        return "BYE", []

class FakeSMTP:
    def __init__(self):
        self.logged_in = None
        self.sent: list[EmailMessage] = []

    def login(self, user, password):
        self.logged_in = (user, password)

    def send_message(self, msg):
        self.sent.append(msg)

    def quit(self):
        pass

def _connected_secrets(tmp_path, **extra) -> SecretStore:
    secrets = SecretStore(tmp_path / "secrets.json")
    secrets.put(
        "email:default",
        {"address": "user@gmail.com", "app_password": "abcd efgh", **extra},
    )
    return secrets

def _tools(secrets, *, imap=None, smtp=None, roots=None):
    by_name = {}
    for tool in make_email_tools(
        secrets,
        roots=roots,
        imap_factory=lambda h, p: imap if imap is not None else FakeIMAP(),
        smtp_factory=lambda h, p: smtp if smtp is not None else FakeSMTP(),
    ):
        by_name[tool.__name__] = tool
    return by_name

def _multipart_message() -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = "Ana <ana@example.com>"
    msg["To"] = "user@gmail.com"
    msg["Subject"] = "Quarterly report"
    msg["Date"] = "Mon, 09 Jun 2026 10:00:00 +0000"
    msg["Message-ID"] = "<orig-123@example.com>"
    msg.set_content("Plain body here.")
    msg.add_alternative("<p>HTML body</p>", subtype="html")
    msg.add_attachment(
        b"%PDF-fake", maintype="application", subtype="pdf", filename="report.pdf"
    )
    return msg

def test_resolve_servers_gmail_preset():
    servers, err = resolve_servers({"address": "x@gmail.com", "app_password": "p"})
    assert err == ""
    assert servers.imap_host == "imap.gmail.com" and servers.imap_port == 993
    assert servers.smtp_host == "smtp.gmail.com" and servers.smtp_port == 587

def test_resolve_servers_advanced_fields_override_preset():
    servers, _ = resolve_servers(
        {
            "address": "x@gmail.com",
            "imap_host": "mail.corp.io",
            "imap_port": "1993",
            "smtp_host": "smtp.corp.io",
            "smtp_port": "465",
        }
    )
    assert (servers.imap_host, servers.imap_port) == ("mail.corp.io", 1993)
    assert (servers.smtp_host, servers.smtp_port) == ("smtp.corp.io", 465)

def test_resolve_servers_unknown_domain_needs_hosts():
    servers, err = resolve_servers({"address": "x@unknown.example"})
    assert servers is None
    assert "IMAP and SMTP host" in err

def test_criteria_default_is_all():
    criteria, err = build_search_criteria()
    assert criteria == b"ALL" and err == ""

def test_criteria_quoting_dates_and_unseen():
    criteria, _ = build_search_criteria(
        from_address='a "b" c@x.io',
        subject="hi",
        since="2026-01-05",
        before="2026-02-01",
        is_unread_only=True,
    )
    text = criteria.decode()
    assert 'FROM "a \\"b\\" c@x.io"' in text
    assert 'SUBJECT "hi"' in text
    assert "SINCE 05-Jan-2026" in text and "BEFORE 01-Feb-2026" in text
    assert text.endswith("UNSEEN")

def test_criteria_bad_date_is_rejected():
    criteria, err = build_search_criteria(since="last week")
    assert criteria is None and "YYYY-MM-DD" in err

def test_criteria_non_ascii_gets_utf8_charset():
    criteria, _ = build_search_criteria(subject="日本語")
    assert criteria.startswith(b"CHARSET UTF-8 ")
    assert "日本語".encode("utf-8") in criteria

def test_decode_mime_header_rfc2047():
    assert decode_mime_header("=?utf-8?b?44GT44KT44Gr44Gh44Gv?=") == "こんにちは"
    assert decode_mime_header("plain") == "plain"
    assert decode_mime_header(None) == ""

def test_extract_text_body_prefers_plain():
    assert extract_text_body(_multipart_message()).strip() == "Plain body here."

def test_extract_text_body_html_fallback_and_truncation():
    msg = EmailMessage()
    msg.set_content("<p>Hello <b>world</b></p>", subtype="html")
    assert extract_text_body(msg) == "Hello world"
    long = EmailMessage()
    long.set_content("x" * 30_000)
    assert extract_text_body(long).endswith("…[truncated]")
    assert len(extract_text_body(long)) < 30_000

def test_tools_error_when_not_connected(tmp_path):
    tools = _tools(SecretStore(tmp_path / "secrets.json"))
    for name in ("email_list_folders", "email_search", "email_read"):
        result = tools[name](**({"uid": "1"} if name == "email_read" else {}))
        assert "not connected" in result["error"]

def test_list_folders_skips_noselect(tmp_path):
    imap = FakeIMAP()
    tools = _tools(_connected_secrets(tmp_path), imap=imap)
    result = tools["email_list_folders"]()
    names = [f["name"] for f in result["folders"]]
    assert names == ["INBOX", "[Gmail]/Sent Mail"]
    assert all(f["messages"] == 7 for f in result["folders"])
    assert imap.logged_in == ("user@gmail.com", "abcd efgh")

def test_search_returns_newest_first_envelopes(tmp_path):
    imap = FakeIMAP({"1": _multipart_message(), "2": _multipart_message()})
    tools = _tools(_connected_secrets(tmp_path), imap=imap)
    result = tools["email_search"](subject="report", max_results=5)
    assert result["ok"] and result["total_matches"] == 2
    assert [m["uid"] for m in result["messages"]] == ["2", "1"]
    first = result["messages"][0]
    assert first["subject"] == "Quarterly report"
    assert first["has_attachments"] is True
    assert all(sel[2] is True for sel in imap.commands if sel[0] == "select")

def test_read_returns_body_and_attachment_list(tmp_path):
    imap = FakeIMAP({"7": _multipart_message()})
    tools = _tools(_connected_secrets(tmp_path), imap=imap)
    result = tools["email_read"](uid="7")
    assert result["body"].strip() == "Plain body here."
    assert result["attachments"] == [
        {"filename": "report.pdf", "content_type": "application/pdf", "size": 9}
    ]

def test_download_attachment_saves_into_scratch_only(tmp_path):
    imap = FakeIMAP({"7": _multipart_message()})
    secrets = _connected_secrets(tmp_path)
    scratch = tmp_path / "scratch"
    scratch.mkdir()

    no_roots = _tools(secrets, imap=imap)
    assert (
        "no writable"
        in no_roots["email_download_attachment"](uid="7", filename="report.pdf")[
            "error"
        ]
    )

    imap2 = FakeIMAP({"7": _multipart_message()})
    tools = _tools(secrets, imap=imap2, roots=[RootDir(path=scratch, writable=True)])
    result = tools["email_download_attachment"](uid="7", filename="report.pdf")
    assert result["ok"]
    saved = scratch / "report.pdf"
    assert saved.read_bytes() == b"%PDF-fake"
    assert result["path"] == str(saved)

    missing = tools["email_download_attachment"](uid="7", filename="nope.pdf")
    assert "no attachment named" in missing["error"]

def test_send_sets_identity_and_requires_no_imap(tmp_path):
    smtp = FakeSMTP()
    secrets = _connected_secrets(tmp_path, display_name="Rohit")
    tools = _tools(secrets, smtp=smtp)
    result = tools["email_send"](to="ana@example.com", subject="Hi", body="Hello")
    assert result["ok"]
    sent = smtp.sent[0]
    assert sent["From"] == "Rohit <user@gmail.com>"
    assert sent["To"] == "ana@example.com"
    assert sent["Message-ID"].endswith("@gmail.com>")
    assert smtp.logged_in == ("user@gmail.com", "abcd efgh")

def test_send_reply_threads_and_reuses_subject(tmp_path):
    imap = FakeIMAP({"7": _multipart_message()})
    smtp = FakeSMTP()
    tools = _tools(_connected_secrets(tmp_path), imap=imap, smtp=smtp)
    result = tools["email_send"](
        to="ana@example.com", subject="", body="re!", reply_to_uid="7"
    )
    assert result["ok"] and result["subject"] == "Re: Quarterly report"
    sent = smtp.sent[0]
    assert sent["In-Reply-To"] == "<orig-123@example.com>"
    assert "<orig-123@example.com>" in sent["References"]
    assert sent["Subject"] == "Re: Quarterly report"

def test_send_attachment_must_live_inside_roots(tmp_path):
    smtp = FakeSMTP()
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    (scratch / "ok.txt").write_text("fine")
    outside = tmp_path / "outside.txt"
    outside.write_text("nope")
    tools = _tools(
        _connected_secrets(tmp_path),
        smtp=smtp,
        roots=[RootDir(path=scratch, writable=True)],
    )
    denied = tools["email_send"](
        to="a@b.c", subject="s", body="b", attachments=[str(outside)]
    )
    assert "outside the session" in denied["error"] and not smtp.sent

    ok = tools["email_send"](
        to="a@b.c", subject="s", body="b", attachments=[str(scratch / "ok.txt")]
    )
    assert ok["ok"]
    assert [p.get_filename() for p in smtp.sent[0].iter_attachments()] == ["ok.txt"]

def test_approval_gating(tmp_path):
    tools = _tools(_connected_secrets(tmp_path))
    gated = {
        name: fn.__delta_tool_metadata__.requires_approval
        for name, fn in tools.items()
    }
    assert gated == {
        "email_list_folders": False,
        "email_search": False,
        "email_read": False,
        "email_download_attachment": True,
        "email_send": True,
    }

def test_email_tool_catalog_registration():
    """Tool/effect metadata stays in Foundation until the later tool-catalog seam.

    Vendor connector descriptors are now extension-provided and are covered by
    test_connector_catalog_contract.py rather than this implementation test.
    """
    from integrations.connectors.tool_defs import TOOLS_BY_CONNECTOR, connector_for_tool

    assert {t.name for t in TOOLS_BY_CONNECTOR["email"]} == {
        "email_list_folders",
        "email_search",
        "email_read",
        "email_download_attachment",
        "email_send",
    }
    assert connector_for_tool("email_send") == "email"

def test_build_connector_tools_includes_email(tmp_path):
    from integrations.connectors.connector_tools import build_connector_tools

    secrets = _connected_secrets(tmp_path)
    tools = build_connector_tools(
        secrets,
        enabled_connectors={"email"},
        enabled_tools={"email_search", "email_send"},
    )
    assert {t.__name__ for t in tools} == {"email_search", "email_send"}

# ==========================================================================
# from test_messaging_operation_contract.py
# ==========================================================================

def _send(_store, _chat_id: str, _text: str, _thread_id: str | None):
    return None

def test_vendor_address_implementation_is_not_in_foundation() -> None:
    assert importlib.util.find_spec("integrations.connectors.slack_addr") is None

def test_provider_operation_can_supply_address_parsing() -> None:
    clear_messaging_providers()
    try:
        register_messaging_provider(
            MessagingProvider(
                platform="test_chat",
                send=_send,
                operations={"split_address": lambda value: ("workspace", value)},
            )
        )
        split_address = messaging_operation("test_chat", "split_address")
        assert split_address is not None
        assert split_address("channel") == ("workspace", "channel")
    finally:
        clear_messaging_providers()

# ==========================================================================
# from test_send_file.py
# ==========================================================================

@pytest.fixture(autouse=True)
def _clean_provider_registry():
    clear_messaging_providers()
    yield
    clear_messaging_providers()

def _store(tmp_path) -> SecretStore:
    return SecretStore(tmp_path / "secrets.json")

def _register_file_provider(record: list, *, platform: str = "fake") -> None:
    def send(_secrets, _chat_id, _text, _thread_id):
        return SendResult(True, message_id="M1")

    def send_file(
        _secrets, chat_id, thread_id, filename, data, title, comment
    ):
        record.append(
            {
                "chat_id": chat_id,
                "thread_id": thread_id,
                "filename": filename,
                "data": data,
                "title": title,
                "comment": comment,
            }
        )
        return SendResult(True, message_id="F123")

    register_messaging_provider(
        MessagingProvider(platform=platform, send=send, send_file=send_file)
    )

def test_send_file_success_within_workspace(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "report.pdf").write_bytes(b"%PDF-fake")
    record: list = []
    _register_file_provider(record)
    tool = build_send_file(_store(tmp_path), workspace=ws)

    out = tool("fake:C9:1700.1", "report.pdf", comment="here you go")
    assert out == {
        "ok": True,
        "file_id": "F123",
        "target": "fake:C9:1700.1",
        "filename": "report.pdf",
    }
    sent = record[0]
    assert sent["chat_id"] == "C9" and sent["thread_id"] == "1700.1"
    assert sent["data"] == b"%PDF-fake" and sent["comment"] == "here you go"

def test_send_file_rejects_paths_outside_roots(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    outside = tmp_path / "elsewhere.txt"
    outside.write_text("secret")
    _register_file_provider([])
    tool = build_send_file(_store(tmp_path), workspace=ws)

    assert "error" in tool("fake:C9", str(outside))
    assert "error" in tool("fake:C9", "../elsewhere.txt")

def test_send_file_roots_extend_the_reachable_set(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    shared = tmp_path / "shared"
    shared.mkdir()
    (shared / "data.csv").write_text("a,b\n1,2\n")
    record: list = []
    _register_file_provider(record)
    tool = build_send_file(
        _store(tmp_path), workspace=ws, roots=[RootDir(path=shared)]
    )
    out = tool("fake:C9", str(shared / "data.csv"))
    assert out["ok"] and record[0]["filename"] == "data.csv"

def test_send_file_requires_provider_file_capability(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "a.txt").write_text("x")

    def send(_secrets, _chat_id, _text, _thread_id):
        return SendResult(True, message_id="M1")

    register_messaging_provider(MessagingProvider(platform="textonly", send=send))
    tool = build_send_file(_store(tmp_path), workspace=ws)
    assert "not supported" in tool("textonly:C9", "a.txt")["error"]
    assert "unknown messaging platform" in tool("missing:C9", "a.txt")["error"]

def test_send_file_screenshot_is_html_only_and_renames_to_png(tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "dash.html").write_text("<h1>hi</h1>")
    (ws / "notes.md").write_text("# hi")
    record: list = []
    _register_file_provider(record)
    tool = build_send_file(
        _store(tmp_path),
        workspace=ws,
        render_html=lambda p: b"PNG-bytes-for-" + Path(p).name.encode(),
    )

    assert (
        "only applies to .html"
        in tool("fake:C9", "notes.md", should_render_image=True)["error"]
    )
    out = tool("fake:C9", "dash.html", should_render_image=True)
    assert out["ok"] and out["filename"] == "dash.png"
    assert record[-1]["data"] == b"PNG-bytes-for-dash.html"

# ==========================================================================
# from test_send_target_resolution.py
# ==========================================================================

def test_registry_kinds_are_exhaustive_and_drive_approval():
    for d in TOOL_DEFS:
        assert d.kind in ("read", "write"), f"{d.name} has kind {d.kind!r}"
        assert approval_for_tool(d.name) is (d.kind != "read")
    assert approval_for_tool("mcp_mystery_tool", is_default_approval=True) is True
    assert approval_for_tool("mcp_mystery_tool", is_default_approval=False) is False

def test_standalone_foundation_exposes_only_baseline_tools(tmp_path):
    from integrations.connectors.connector_tools import build_connector_tools

    tools = {
        t.__name__: t
        for t in build_connector_tools(SecretStore(tmp_path / "secrets.json"))
    }
    assert {
        "email_list_folders",
        "email_search",
        "email_read",
        "email_download_attachment",
        "email_send",
        "browser_read_url",
    } <= set(tools)
    assert tools["email_search"].__delta_tool_metadata__.requires_approval is False
    assert tools["email_send"].__delta_tool_metadata__.requires_approval is True
    assert tools["browser_read_url"].__delta_tool_metadata__.requires_approval is True
    assert "gmail_search_messages" not in tools
    assert "hubspot_search" not in tools
    assert "github_search" not in tools
    assert "github_clone" not in tools
    assert "github_pull" not in tools

def test_browser_automation_requires_explicit_effect_metadata():
    from integrations.connectors.browser_automation import (
        attach_browser_tool,
        browser_tool_schema,
    )

    def tool(name: str, kind: str):
        def fn():
            return {"ok": True}

        fn.__name__ = name
        return attach_browser_tool(
            fn,
            browser_tool_schema(name, name, {}, []),
            is_approval_required=True,
            capabilities=["browser", kind],
        )

    tools = {
        "browser_snapshot": tool("browser_snapshot", "read"),
        "browser_open_url": tool("browser_open_url", "write"),
        "browser_click": tool("browser_click", "write"),
        "browser_type": tool("browser_type", "write"),
    }
    assert tools["browser_snapshot"].__delta_tool_metadata__.requires_approval is False
    assert tools["browser_open_url"].__delta_tool_metadata__.requires_approval is True
    assert tools["browser_click"].__delta_tool_metadata__.requires_approval is True
    assert tools["browser_type"].__delta_tool_metadata__.requires_approval is True

def test_messaging_provider_owns_human_friendly_target_resolution(tmp_path):
    clear_messaging_providers()
    record: list[dict] = []

    def send(_secrets, chat_id, text, thread_id):
        record.append({"chat_id": chat_id, "text": text, "thread_id": thread_id})
        return SendResult(True, message_id="1")

    def parse_bare(_secrets, raw):
        return ("ROOM1", None) if raw == "#team" else None

    register_messaging_provider(
        MessagingProvider(platform="fake", send=send, parse_bare_target=parse_bare)
    )
    try:
        tool = build_send_message(SecretStore(tmp_path / "secrets.json"))
        assert tool("#team", "Hi")["ok"] is True
        assert record == [{"chat_id": "ROOM1", "text": "Hi", "thread_id": None}]
    finally:
        clear_messaging_providers()

def test_explicit_target_dispatches_without_vendor_logic(tmp_path):
    clear_messaging_providers()
    record: list[tuple[str, str | None]] = []

    def send(_secrets, chat_id, _text, thread_id):
        record.append((chat_id, thread_id))
        return SendResult(True, message_id="2")

    register_messaging_provider(MessagingProvider(platform="fake", send=send))
    try:
        tool = build_send_message(SecretStore(tmp_path / "secrets.json"))
        assert tool("fake:ROOM2:thread-3", "Hi")["ok"] is True
        assert record == [("ROOM2", "thread-3")]
        assert "unknown messaging platform" in tool("missing:ROOM", "Hi")["error"]
    finally:
        clear_messaging_providers()

# ==========================================================================
# from test_managed_capability_contract.py
# ==========================================================================

def test_managed_foundation_exports_are_vendor_agnostic() -> None:
    exported = set(managed.__all__)

    assert {
        "ManagedConfig",
        "ManagedUnavailableError",
        "OAuthBroker",
        "NullOAuthBroker",
        "RelayTransport",
        "NullRelayTransport",
        "ExternalIdentity",
        "ExternalIdentityProvider",
        "NullIdentityProvider",
    } <= exported
    assert not any("github" in name.lower() for name in exported)

def test_retired_github_managed_modules_are_absent() -> None:
    assert importlib.util.find_spec("integrations.managed.github_app") is None
    assert importlib.util.find_spec("integrations.connectors.github_installs") is None

def test_managed_null_defaults_are_offline_safe() -> None:
    config = managed.ManagedConfig()
    assert config.enabled is False
    assert config.base_url == ""
    assert config.device_token == ""
    assert config.relay_ws_url == ""

    async def exercise() -> None:
        oauth = managed.NullOAuthBroker()
        begin = await oauth.begin("example")
        assert begin["ok"] is False

        relay = managed.NullRelayTransport()
        await relay.open()
        assert await relay.recv() is None
        await relay.close()

    asyncio.run(exercise())
