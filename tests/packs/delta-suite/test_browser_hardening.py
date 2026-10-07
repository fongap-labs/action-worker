"""Browser route default-deny and guarded-proxy hardening (audit DS-001, DS-002)."""

from __future__ import annotations

import base64
import socket
import socketserver
import threading
import time

import pytest

from advanced.browser import playwright_provider
from advanced.browser.guarded_proxy import GuardedBrowserProxy
from advanced.browser.playwright_provider import _BrowserController


class _Route:
    def __init__(self) -> None:
        self.outcome = ""

    def continue_(self) -> None:
        self.outcome = "continue"

    def abort(self, reason: str = "") -> None:
        self.outcome = f"abort:{reason}"


class _Request:
    def __init__(self, url: str, resource_type: str = "document") -> None:
        self.url = url
        self.resource_type = resource_type


def _route_outcome(monkeypatch, url: str, resource_type: str = "document") -> str:
    monkeypatch.setattr(playwright_provider, "browser_url_refusal", lambda _url: None)
    route = _Route()
    _BrowserController()._route_request(route, _Request(url, resource_type))
    return route.outcome


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "file:///C:/Windows/win.ini",
        "ftp://example.test/pub",
        "chrome://settings",
        "view-source:https://example.test/",
        "chrome-extension://abc/page.html",
        "javascript:alert(1)",
        "data:text/html,<script>1</script>",
        "data:application/javascript,alert(1)",
        "ws://example.test/",
        "about:srcdoc",
        "",
    ],
)
def test_other_protocols_are_aborted(monkeypatch, url) -> None:
    assert _route_outcome(monkeypatch, url) == "abort:blockedbyclient"


@pytest.mark.parametrize(
    "url",
    [
        "https://example.test/",
        "http://example.test/a?b=1",
        "about:blank",
        "blob:https://example.test/6f1c",
        "data:image/png;base64,iVBORw0KGgo=",
        "data:image/jpeg;base64,/9j/4AAQ",
    ],
)
def test_web_pages_blobs_images_and_blank_are_allowed(monkeypatch, url) -> None:
    assert _route_outcome(monkeypatch, url) == "continue"


def test_svg_data_urls_are_images_only(monkeypatch) -> None:
    svg = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'/>"
    assert _route_outcome(monkeypatch, svg, "image") == "continue"
    assert _route_outcome(monkeypatch, svg, "document") == "abort:blockedbyclient"


def test_foundation_url_refusal_still_blocks_web_urls(monkeypatch) -> None:
    monkeypatch.setattr(playwright_provider, "browser_url_refusal", lambda _url: "private address")
    route = _Route()
    _BrowserController()._route_request(route, _Request("http://10.0.0.1/"))
    assert route.outcome == "abort:blockedbyclient"


# --- proxy ---------------------------------------------------------------------------------------


class _HTTPHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = self.request.recv(4096)
            if not chunk:
                return
            data += chunk
        self.request.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")


def _basic(credentials: tuple[str, str]) -> str:
    token = base64.b64encode(f"{credentials[0]}:{credentials[1]}".encode()).decode("ascii")
    return f"Proxy-Authorization: Basic {token}\r\n"


def _address(proxy: GuardedBrowserProxy) -> tuple[str, int]:
    host, port = proxy.server_url.removeprefix("http://").split(":")
    return host, int(port)


def _exchange(proxy: GuardedBrowserProxy, request: str) -> bytes:
    with socket.create_connection(_address(proxy), timeout=5) as client:
        client.sendall(request.encode("ascii"))
        response = b""
        while True:
            chunk = client.recv(4096)
            if not chunk:
                break
            response += chunk
            if b"\r\n\r\n" in response and response.startswith(b"HTTP/1.1 4"):
                break
        return response


@pytest.fixture
def upstream():
    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _HTTPHandler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server
    server.shutdown()
    server.server_close()
    thread.join(timeout=2)


def test_credentials_are_random_per_proxy() -> None:
    first = GuardedBrowserProxy(resolver=lambda _u: "127.0.0.1")
    second = GuardedBrowserProxy(resolver=lambda _u: "127.0.0.1")
    assert first.credentials != second.credentials
    assert len(first.credentials[1]) >= 32


def test_requests_without_valid_credentials_get_407_and_never_resolve(upstream) -> None:
    resolved: list[str] = []
    proxy = GuardedBrowserProxy(resolver=lambda url: resolved.append(url) or "127.0.0.1")
    port = upstream.server_address[1]
    request = f"GET http://example.test:{port}/ HTTP/1.1\r\nHost: example.test:{port}\r\n"
    try:
        proxy.start()
        missing = _exchange(proxy, request + "\r\n")
        wrong = _exchange(proxy, request + _basic(("delta", "not-the-password")) + "\r\n")
        wrong_scheme = _exchange(proxy, request + "Proxy-Authorization: Bearer abc\r\n\r\n")
        garbage = _exchange(proxy, request + "Proxy-Authorization: Basic !!!notbase64\r\n\r\n")
        connect = _exchange(proxy, f"CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n")
        for response in (missing, wrong, wrong_scheme, garbage, connect):
            assert b" 407 " in response.split(b"\r\n", 1)[0]
            assert b"Proxy-Authenticate: Basic" in response
        assert resolved == []
    finally:
        proxy.stop()


def test_valid_credentials_forward_normally(upstream) -> None:
    proxy = GuardedBrowserProxy(resolver=lambda _url: "127.0.0.1")
    port = upstream.server_address[1]
    try:
        proxy.start()
        response = _exchange(
            proxy,
            f"GET http://example.test:{port}/ HTTP/1.1\r\nHost: example.test:{port}\r\n"
            + _basic(proxy.credentials)
            + "Connection: close\r\n\r\n",
        )
        assert b"200 OK" in response
        assert response.endswith(b"ok")
    finally:
        proxy.stop()


@pytest.mark.parametrize("port", [25, 22, 3306, 6379, 5432, 1])
def test_connect_to_a_non_web_port_is_refused_before_resolving(port) -> None:
    resolved: list[str] = []
    proxy = GuardedBrowserProxy(resolver=lambda url: resolved.append(url) or "127.0.0.1")
    try:
        proxy.start()
        response = _exchange(
            proxy,
            f"CONNECT example.com:{port} HTTP/1.1\r\nHost: example.com:{port}\r\n" + _basic(proxy.credentials) + "\r\n",
        )
        assert b" 403 " in response.split(b"\r\n", 1)[0]
        assert resolved == []
    finally:
        proxy.stop()


@pytest.mark.parametrize("port", [80, 443, 8080, 8443])
def test_connect_to_the_default_web_ports_reaches_the_resolver(port) -> None:
    resolved: list[str] = []

    def refuse(url: str) -> str:
        resolved.append(url)
        raise PermissionError("not for this test")

    proxy = GuardedBrowserProxy(resolver=refuse)
    try:
        proxy.start()
        _exchange(
            proxy,
            f"CONNECT example.com:{port} HTTP/1.1\r\nHost: example.com:{port}\r\n" + _basic(proxy.credentials) + "\r\n",
        )
        assert resolved == [f"https://example.com:{port}/"]
    finally:
        proxy.stop()


def test_extra_ports_are_an_explicit_opt_in(monkeypatch) -> None:
    monkeypatch.setenv("DELTA_BROWSER_EXTRA_CONNECT_PORTS", "9443, nonsense, 70000")
    proxy = GuardedBrowserProxy(resolver=lambda _u: "127.0.0.1")
    assert 9443 in proxy._connect_ports
    assert 70000 not in proxy._connect_ports
    assert {80, 443, 8080, 8443} <= proxy._connect_ports
    monkeypatch.delenv("DELTA_BROWSER_EXTRA_CONNECT_PORTS")
    assert 9443 not in GuardedBrowserProxy(resolver=lambda _u: "127.0.0.1")._connect_ports


def test_idle_connections_are_released_and_the_cap_answers_503() -> None:
    proxy = GuardedBrowserProxy(
        resolver=lambda _u: "127.0.0.1",
        idle_timeout=4.0,
        max_connections=64,
    )
    sockets: list[socket.socket] = []
    try:
        proxy.start()
        for _ in range(200):
            sockets.append(socket.create_connection(_address(proxy), timeout=10))
        time.sleep(1.0)

        busy = 0
        for client in sockets:
            client.settimeout(0.1)
            try:
                if client.recv(4096).startswith(b"HTTP/1.1 503"):
                    busy += 1
            except (TimeoutError, OSError):
                pass
        assert busy >= 100, f"only {busy} of 200 connections were refused as busy"

        # After the idle timeout every held connection has been closed by the proxy.
        time.sleep(4.5)
        closed = 0
        for client in sockets:
            client.settimeout(0.5)
            try:
                if client.recv(4096) == b"":
                    closed += 1
            except (TimeoutError, OSError):
                pass
        assert closed >= 190, f"only {closed} of 200 idle connections were released"

        # ... and the proxy serves again.
        response = _exchange(proxy, "GET http://example.test/ HTTP/1.1\r\nHost: example.test\r\n\r\n")
        assert b" 407 " in response.split(b"\r\n", 1)[0]
    finally:
        for client in sockets:
            client.close()
        proxy.stop()
