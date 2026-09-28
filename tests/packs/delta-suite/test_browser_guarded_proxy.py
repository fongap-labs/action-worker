from __future__ import annotations

import socket
import socketserver
import threading

from advanced.browser.guarded_proxy import (
    GuardedBrowserProxy,
    _connect_target,
    _http_target,
)


class _HTTPHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        data = b""
        while b"\r\n\r\n" not in data:
            chunk = self.request.recv(4096)
            if not chunk:
                return
            data += chunk
        self.server.last_request = data
        self.request.sendall(
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
        )


class _EchoHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        data = self.request.recv(4096)
        if data:
            self.request.sendall(data)


def _start_server(handler):
    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def _stop_server(server, thread) -> None:
    server.shutdown()
    server.server_close()
    thread.join(timeout=2)


def test_proxy_target_parsing_preserves_logical_host() -> None:
    logical, host, port, path = _http_target(
        "http://example.test:8080/a?q=1",
        [("Host", "example.test:8080")],
    )
    assert logical == "http://example.test:8080/a?q=1"
    assert host == "example.test"
    assert port == 8080
    assert path == "/a?q=1"

    host, port, logical = _connect_target("example.test:8443")
    assert host == "example.test"
    assert port == 8443
    assert logical == "https://example.test:8443/"


def test_http_proxy_connects_to_resolver_address_not_hostname() -> None:
    upstream, upstream_thread = _start_server(_HTTPHandler)
    seen: list[str] = []
    proxy = GuardedBrowserProxy(
        resolver=lambda url: seen.append(url) or "127.0.0.1"
    )
    try:
        proxy.start()
        proxy_host, proxy_port = proxy.server_url.removeprefix("http://").split(":")
        with socket.create_connection((proxy_host, int(proxy_port)), timeout=5) as client:
            target_port = upstream.server_address[1]
            client.sendall(
                (
                    f"GET http://example.test:{target_port}/x HTTP/1.1\r\n"
                    f"Host: example.test:{target_port}\r\n"
                    "Connection: close\r\n\r\n"
                ).encode("ascii")
            )
            response = b""
            while True:
                chunk = client.recv(4096)
                if not chunk:
                    break
                response += chunk
        assert b"200 OK" in response
        assert seen == [f"http://example.test:{target_port}/x"]
        assert upstream.last_request.startswith(b"GET /x HTTP/1.1\r\n")
    finally:
        proxy.stop()
        _stop_server(upstream, upstream_thread)


def test_connect_tunnel_uses_vetted_address() -> None:
    upstream, upstream_thread = _start_server(_EchoHandler)
    seen: list[str] = []
    proxy = GuardedBrowserProxy(
        resolver=lambda url: seen.append(url) or "127.0.0.1"
    )
    try:
        proxy.start()
        proxy_host, proxy_port = proxy.server_url.removeprefix("http://").split(":")
        with socket.create_connection((proxy_host, int(proxy_port)), timeout=5) as client:
            target_port = upstream.server_address[1]
            client.sendall(
                (
                    f"CONNECT example.test:{target_port} HTTP/1.1\r\n"
                    f"Host: example.test:{target_port}\r\n\r\n"
                ).encode("ascii")
            )
            response = client.recv(4096)
            assert b"200 Connection Established" in response
            client.sendall(b"ping")
            assert client.recv(4) == b"ping"
        assert seen == [f"https://example.test:{target_port}/"]
    finally:
        proxy.stop()
        _stop_server(upstream, upstream_thread)


def test_policy_refusal_returns_403_without_connecting() -> None:
    def blocked(_url: str) -> str:
        raise PermissionError("loopback")

    proxy = GuardedBrowserProxy(resolver=blocked)
    try:
        proxy.start()
        proxy_host, proxy_port = proxy.server_url.removeprefix("http://").split(":")
        with socket.create_connection((proxy_host, int(proxy_port)), timeout=5) as client:
            client.sendall(
                b"CONNECT internal.example:443 HTTP/1.1\r\n"
                b"Host: internal.example:443\r\n\r\n"
            )
            response = client.recv(4096)
        assert b"403 Proxy Error" in response
    finally:
        proxy.stop()
