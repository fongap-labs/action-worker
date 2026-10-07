"""Address guard: URLs that parsers read differently, and IPv4 addresses hidden inside IPv6 (audit DL-007)."""

from __future__ import annotations

import ipaddress
import socket

import pytest

from integrations.web import guard


@pytest.fixture()
def no_dns(monkeypatch):
    """A refused URL must be refused before any name lookup."""

    def boom(*args, **kwargs):
        raise AssertionError("the guard resolved a name it should have refused outright")

    monkeypatch.setattr(guard.socket, "getaddrinfo", boom)


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1\\@example.com/",
        "http://127.0.0.1\\.example.com/",
        "http://user:pw@example.com/",
        "http://user@example.com/",
        "https://example.com@127.0.0.1/",
        "http://:pw@example.com/",
        "http://example.com\\@127.0.0.1/",
    ],
)
def test_credentials_and_backslashes_in_the_host_part_are_refused_before_any_lookup(url, no_dns):
    reason = guard.check_url(url)
    assert reason and ("credentials" in reason or "backslash" in reason)


def test_a_path_or_query_with_an_at_sign_is_not_a_credential(monkeypatch):
    monkeypatch.setattr(guard.socket, "getaddrinfo", lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))])
    assert guard.check_url("https://example.com/users/@name?email=a@b.example") is None


def test_the_pinned_request_carries_no_userinfo(monkeypatch):
    request_url, headers, _ = guard._pinned("https://example.com/x", "93.184.216.34")
    assert request_url == "https://93.184.216.34/x" and headers == {"Host": "example.com"}


@pytest.mark.parametrize(
    "address,carried",
    [
        ("::ffff:127.0.0.1", "127.0.0.1"),
        ("64:ff9b::7f00:1", "127.0.0.1"),
        ("64:ff9b::a9fe:a9fe", "169.254.169.254"),
        ("2002:7f00:1::", "127.0.0.1"),
        ("2002:0a00:0001::", "10.0.0.1"),
        ("2001:0:4136:e378:8000:63bf:80ff:fffe", "127.0.0.1"),
    ],
)
def test_ipv4_addresses_carried_inside_ipv6_are_recovered(address, carried):
    assert ipaddress.IPv4Address(carried) in guard._embedded_ipv4(ipaddress.IPv6Address(address))


@pytest.mark.parametrize(
    "url",
    [
        "http://[::ffff:127.0.0.1]/",
        "http://[::ffff:7f00:1]/",
        "http://[64:ff9b::7f00:1]/",
        "http://[64:ff9b::a9fe:a9fe]/",
        "http://[2002:7f00:1::]/",
        "http://[2002:c0a8:101::]/",
        "http://[2001:0:4136:e378:8000:63bf:80ff:fffe]/",
    ],
)
def test_literals_that_reach_a_blocked_ipv4_address_are_refused(url, no_dns):
    assert guard.check_url(url)


def test_the_embedded_address_is_judged_even_when_the_interpreter_tables_do_not_flag_the_ipv6_address(monkeypatch):
    # The carried address alone is enough: pretend the IPv6 range itself looks harmless.
    monkeypatch.setattr(ipaddress.IPv6Address, "is_private", property(lambda self: False))
    monkeypatch.setattr(ipaddress.IPv6Address, "is_reserved", property(lambda self: False))
    reason = guard._blocked_reason(ipaddress.IPv6Address("64:ff9b::7f00:1"))
    assert reason and "carried inside an IPv6 address" in reason
    assert guard._blocked_reason(ipaddress.IPv6Address("2002:7f00:1::"))


@pytest.mark.parametrize("answer", ["::ffff:127.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::", "2001:0:4136:e378:8000:63bf:80ff:fffe"])
def test_a_name_that_resolves_to_a_carried_blocked_address_is_refused(monkeypatch, answer):
    monkeypatch.setattr(
        guard.socket, "getaddrinfo", lambda *a, **k: [(socket.AF_INET6, socket.SOCK_STREAM, 6, "", (answer, 443, 0, 0))]
    )
    assert guard.check_url("https://tricky.example.com/")


def test_ordinary_public_addresses_are_unaffected(monkeypatch):
    assert guard.check_url("https://93.184.216.34/") is None
    monkeypatch.setattr(
        guard.socket, "getaddrinfo",
        lambda *a, **k: [(socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("2606:2800:220:1:248:1893:25c8:1946", 443, 0, 0))],
    )
    assert guard.check_url("https://example.com/") is None
    assert guard._embedded_ipv4(ipaddress.IPv6Address("2606:2800:220:1:248:1893:25c8:1946")) == []
