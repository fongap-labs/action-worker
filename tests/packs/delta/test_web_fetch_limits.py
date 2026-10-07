"""`web_fetch` reads at most a bounded amount, for a bounded time, however the server behaves (audit DL-004)."""

from __future__ import annotations

import gzip
import socket
import time

import httpx
import pytest

from integrations.web import fetch as fetch_module
from integrations.web import guard

PUBLIC = "93.184.216.34"


@pytest.fixture(autouse=True)
def public_resolution(monkeypatch):
    monkeypatch.setattr(
        guard.socket, "getaddrinfo", lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (PUBLIC, 443))]
    )


def run_fetch(monkeypatch, handler, url="https://example.com/page", **kwargs):
    """Call web_fetch with every HTTP request answered by `handler` instead of the network."""
    real_client = httpx.Client
    monkeypatch.setattr(httpx, "Client", lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
    return fetch_module.build_fetch_tool()(url, **kwargs)


def test_an_endless_body_is_cut_at_the_byte_limit(monkeypatch):
    produced = {"bytes": 0}
    chunk = b"a" * 65536

    def endless():
        while True:
            produced["bytes"] += len(chunk)
            yield chunk

    result = run_fetch(
        monkeypatch, lambda req: httpx.Response(200, headers={"content-type": "text/plain"}, content=endless())
    )
    assert result["truncated"] is True
    assert len(result["text"]) == 20000
    # Nothing was read beyond the limit, plus the chunk in flight.
    assert produced["bytes"] <= fetch_module._MAX_BYTES + 2 * len(chunk)


def test_a_compression_bomb_is_bounded_after_decompression(monkeypatch):
    bomb = gzip.compress(b"0" * (80 * 1024 * 1024))
    assert len(bomb) < 200_000  # tiny on the wire
    seen = {"decoded": 0}
    original = fetch_module._read_capped

    def counting(resp, max_bytes, deadline):
        data, cut = original(resp, max_bytes, deadline)
        seen["decoded"] = len(data)
        return data, cut

    monkeypatch.setattr(fetch_module, "_read_capped", counting)
    result = run_fetch(
        monkeypatch,
        lambda req: httpx.Response(200, headers={"content-type": "text/plain", "content-encoding": "gzip"}, content=bomb),
    )
    assert result["truncated"] is True
    assert seen["decoded"] == fetch_module._MAX_BYTES


def test_a_slow_body_is_cut_at_the_deadline(monkeypatch):
    monkeypatch.setattr(fetch_module, "_DEADLINE_SECONDS", 0.2)

    def drip():
        while True:
            time.sleep(0.05)
            yield b"x" * 100

    started = time.monotonic()
    result = run_fetch(monkeypatch, lambda req: httpx.Response(200, headers={"content-type": "text/plain"}, content=drip()))
    assert result["truncated"] is True
    assert time.monotonic() - started < 5
    assert 0 < len(result["text"]) < 20000


def test_a_page_that_fits_is_returned_whole_and_not_truncated(monkeypatch):
    html = b"<html><head><title>t</title></head><body><p>Hello</p><script>evil()</script><p>World</p></body></html>"
    result = run_fetch(monkeypatch, lambda req: httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"}, content=html))
    assert result == {
        "url": "https://example.com/page",
        "content_type": "text/html; charset=utf-8",
        "truncated": False,
        "text": "Hello\nWorld",
    }


def test_the_character_cap_still_applies_below_the_byte_limit(monkeypatch):
    result = run_fetch(
        monkeypatch, lambda req: httpx.Response(200, headers={"content-type": "text/plain"}, content=b"y" * 5000), max_chars=100
    )
    assert result["truncated"] is True and len(result["text"]) == 100


def test_the_charset_header_decides_the_decoding(monkeypatch):
    body = "héllo wörld".encode("latin-1")
    result = run_fetch(monkeypatch, lambda req: httpx.Response(200, headers={"content-type": "text/plain; charset=latin-1"}, content=body))
    assert result["text"] == "héllo wörld"


def test_http_errors_are_reported_without_reading_the_body(monkeypatch):
    result = run_fetch(monkeypatch, lambda req: httpx.Response(500, content=b"x" * 1000))
    assert "fetch failed" in result["error"]


def test_a_redirect_is_followed_with_the_body_of_the_last_hop_only(monkeypatch):
    def handler(request):
        if request.url.path == "/start":
            return httpx.Response(302, headers={"location": "/final"})
        return httpx.Response(200, headers={"content-type": "text/plain"}, content=b"final body")

    result = run_fetch(monkeypatch, handler, url="https://example.com/start")
    assert result["text"] == "final body"
    assert result["url"] == "https://example.com/final"


def test_a_redirect_into_loopback_is_still_refused_and_never_requested(monkeypatch):
    requested = []

    def handler(request):
        requested.append(str(request.url))
        return httpx.Response(302, headers={"location": "http://127.0.0.1:11434/api/tags"})

    result = run_fetch(monkeypatch, handler, url="https://example.com/start")
    assert "loopback" in result["error"]
    assert requested == [f"https://{PUBLIC}/start"]


def test_stream_checked_pins_each_hop_to_its_vetted_address(monkeypatch):
    seen = []

    def handler(request):
        seen.append((str(request.url), request.headers["host"]))
        return httpx.Response(200, content=b"ok")

    with httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=False) as client:
        with guard.stream_checked(client, "https://example.com/docs") as resp:
            assert resp.read() == b"ok"
            assert resp.extensions["logical_url"] == "https://example.com/docs"
    assert seen == [(f"https://{PUBLIC}/docs", "example.com")]


def test_stream_checked_bounds_the_redirect_chain(monkeypatch):
    with httpx.Client(
        transport=httpx.MockTransport(lambda r: httpx.Response(302, headers={"location": "https://example.com/loop"})),
        follow_redirects=False,
    ) as client:
        with pytest.raises(RuntimeError, match="too many redirects"):
            with guard.stream_checked(client, "https://example.com/loop"):
                pass
