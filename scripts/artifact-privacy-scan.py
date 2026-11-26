#!/usr/bin/env python3
"""Offline release privacy scan; public output never includes paths or matching values."""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tarfile
import zipfile

CHUNK_BYTES = 65536
OVERLAP_BYTES = 8192
MAX_FILES = 40000
MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024
MAX_NESTED_ARCHIVE_BYTES = 128 * 1024 * 1024
MAX_ARCHIVE_DEPTH = 4
MAX_DIAGNOSTIC_ROWS = 20000
ARCHIVE_SUFFIXES = (".zip", ".jar", ".tgz", ".tar.gz", ".tar", ".tar.xz", ".tar.bz2")
OPAQUE_SUFFIXES = (".dmg", ".appimage", ".exe", ".dll", ".so", ".dylib", ".msi", ".pkg")


class PrivacyScanError(Exception):
    pass


def load_patterns(policy_path: Path):
    try:
        policy = json.loads(policy_path.read_text(encoding="utf-8"))
        if policy.get("schema_version") != 3:
            raise ValueError("invalid schema")
        privacy = policy["privacy_patterns"]
        secrets = policy["secret_patterns"]
        if not privacy or not isinstance(privacy, list) or not isinstance(secrets, list):
            raise ValueError("missing rules")
        rules = []
        for section, prefix in ((privacy, "privacy-"), (secrets, "")):
            for item in section:
                name = item["name"]
                expression = item["pattern"]
                if not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", name):
                    raise ValueError("bad rule id")
                rules.append((prefix + name, re.compile(expression)))
        allowlist = policy.get("artifact_context_allowlist", [])
        if not isinstance(allowlist, list):
            raise ValueError("bad artifact context allowlist")
        contexts = {}
        rule_names = {name for name, _ in rules}
        for item in allowlist:
            if (
                not isinstance(item, dict)
                or item.get("rule") not in rule_names
                or not isinstance(item.get("source"), str)
                or not item["source"].strip()
                or not isinstance(item.get("distribution_sha256"), str)
                or not re.fullmatch(r"[0-9a-f]{64}", item["distribution_sha256"])
                or not isinstance(item.get("reason"), str)
                or not item["reason"].strip()
                or not isinstance(item.get("context_sha256"), list)
                or not item["context_sha256"]
                or any(
                    not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest)
                    for digest in item["context_sha256"]
                )
            ):
                raise ValueError("bad artifact context allowance")
            contexts.setdefault(item["rule"], set()).update(item["context_sha256"])
        return rules, contexts
    except (OSError, ValueError, KeyError, TypeError, re.error) as error:
        raise PrivacyScanError("invalid-policy") from error


def finding_origin(name, inherited="other"):
    """Return fixed labels only; never include user-controlled path components."""
    path = PurePosixPath(name.replace("\\", "/").lower())
    parts = path.parts
    filename = path.name
    if "site-packages" in parts:
        area = "python-packages"
    elif "python" in parts and ("lib" in parts or "dlls" in parts):
        area = "python-runtime"
    elif "pnpm" in parts:
        area = "package-manager"
    elif "node_modules" in parts:
        area = "node-dependencies"
    elif "app.asar.unpacked" in parts:
        area = "electron-unpacked"
    elif filename.endswith(".asar"):
        area = "electron-asar"
    elif "runtime" in parts:
        area = "bundled-runtime"
    else:
        area = inherited
    if filename.endswith(".map"):
        kind = "source-map"
    elif filename.endswith((".pdb", ".debug", ".dwarf")):
        kind = "debug-symbols"
    elif filename.startswith(("license", "licence", "notice", "third_party", "third-party", "copying")):
        kind = "license-notice"
    elif any(part.endswith((".dist-info", ".egg-info")) for part in parts) or filename in (
        "package.json", "metadata", "pkg-info", "record", "authors", "authors.txt"
    ):
        kind = "package-metadata"
    elif any(part in ("test", "tests", "fixtures", "testdata", "__tests__") for part in parts):
        kind = "test-fixture"
    elif filename.endswith(".asar"):
        kind = "asar"
    elif filename.endswith(ARCHIVE_SUFFIXES):
        kind = "archive"
    elif filename.endswith(OPAQUE_SUFFIXES + (".node", ".pyd", ".pyc", ".bin", ".dat")):
        kind = "binary"
    elif filename.endswith((".js", ".mjs", ".cjs", ".ts", ".py", ".ps1", ".cmd", ".sh")):
        kind = "code"
    elif filename.endswith((".txt", ".md", ".rst", ".html", ".json", ".xml", ".yaml", ".yml")):
        kind = "text"
    else:
        kind = "other"
    return area, kind


class Scanner:
    def __init__(self, rules, strict_opaque, diagnostics=False, local_paths=False, contexts=None):
        self.rules = rules
        self.contexts = contexts or {}
        self.strict_opaque = strict_opaque
        self.counts = {}
        self.origin_counts = {}
        self.checked_files = 0
        self.archives = 0
        self.opaque_files = 0
        self.expanded_bytes = 0
        self.diagnostics = diagnostics
        self.local_paths = local_paths
        self.details = {}
        self.is_details_truncated = False
        self.object_count = 0

    def record_detail(self, locator, origin, rule, source, window, names):
        if not self.diagnostics:
            return
        key = (locator, rule, source)
        if key in self.details:
            row = self.details[key]
            row["windows"] += 1
            row["last_window"] = window
            return
        if len(self.details) >= MAX_DIAGNOSTIC_ROWS:
            self.is_details_truncated = True
            return
        row = {
            "locator": locator,
            "area": origin[0],
            "kind": origin[1],
            "rule": rule,
            "source": source,
            "first_window": window,
            "last_window": window,
            "windows": 1,
        }
        if self.local_paths:
            row["relative_archive_chain"] = names
        self.details[key] = row

    def check_text(self, text, origin, locator, source, window, names, final_window=True):
        for name, expression in self.rules:
            matches = list(expression.finditer(text))
            if not matches:
                continue
            # Do not decide on matches whose trailing context may continue in the next stream
            # window. The overlap guarantees they will be checked again with complete context.
            if not final_window:
                matches = [match for match in matches if match.end() <= len(text) - 64]
            if not matches:
                continue
            if source == "content" and name in self.contexts:
                unapproved = False
                for match in matches:
                    start = max(0, match.start() - 64)
                    end = min(len(text), match.end() + 64)
                    context = text[start:end].encode("utf-8")
                    if hashlib.sha256(context).hexdigest() not in self.contexts[name]:
                        unapproved = True
                        break
                if not unapproved:
                    continue
            self.counts[name] = self.counts.get(name, 0) + 1
            key = (*origin, name)
            self.origin_counts[key] = self.origin_counts.get(key, 0) + 1
            self.record_detail(locator, origin, name, source, window, names)

    def check_name(self, name, origin, locator, names, source="name"):
        normalized = name.replace("\\", "/")
        path = PurePosixPath(normalized)
        if (
            normalized.startswith("/")
            or re.match(r"^[A-Za-z]:", normalized)
            or ".." in path.parts
            or not normalized
        ):
            raise PrivacyScanError("unsafe-archive-path")
        self.check_text(normalized, origin, locator, source, 0, names)

    def scan_stream(self, stream, origin, locator, names):
        self.checked_files += 1
        if self.checked_files > MAX_FILES:
            raise PrivacyScanError("file-budget-exceeded")
        tail = ""
        window = 0
        block = stream.read(CHUNK_BYTES)
        while block:
            self.expanded_bytes += len(block)
            if self.expanded_bytes > MAX_EXPANDED_BYTES:
                raise PrivacyScanError("expanded-size-budget-exceeded")
            next_block = stream.read(CHUNK_BYTES)
            text = tail + block.decode("utf-8", errors="replace")
            window += 1
            self.check_text(text, origin, locator, "content", window, names, not next_block)
            tail = text[-OVERLAP_BYTES:]
            block = next_block

    def inspect(self, name, stream, depth, inherited="other", locator="1", parents=()):
        origin = finding_origin(name, inherited)
        names = (*parents, name) if self.local_paths else ()
        self.check_name(name, origin, locator, names)
        lower = name.lower()
        if lower.endswith(ARCHIVE_SUFFIXES):
            if depth >= MAX_ARCHIVE_DEPTH:
                raise PrivacyScanError("nested-archive-depth-exceeded")
            if depth == 0:
                # Root release archives are already seekable files; do not load them into memory.
                self.scan_archive(lower, stream, depth + 1, origin[0], locator, names)
            else:
                raw = stream.read(MAX_NESTED_ARCHIVE_BYTES + 1)
                if len(raw) > MAX_NESTED_ARCHIVE_BYTES:
                    raise PrivacyScanError("nested-archive-size-exceeded")
                self.expanded_bytes += len(raw)
                if self.expanded_bytes > MAX_EXPANDED_BYTES:
                    raise PrivacyScanError("expanded-size-budget-exceeded")
                self.scan_archive(lower, io.BytesIO(raw), depth + 1, origin[0], locator, names)
        else:
            if lower.endswith(OPAQUE_SUFFIXES):
                self.opaque_files += 1
                self.record_detail(locator, origin, "opaque-unverified", "object", 0, names)
                if self.strict_opaque:
                    raise PrivacyScanError("opaque-asset-not-verifiable")
            self.scan_stream(stream, origin, locator, names)

    def scan_archive(self, name, stream, depth, inherited, locator, parents):
        self.archives += 1
        seen = set()
        if name.endswith((".zip", ".jar")):
            try:
                with zipfile.ZipFile(stream) as archive:
                    for index, member in enumerate(archive.infolist(), 1):
                        child = f"{locator}.{index}"
                        if member.is_dir():
                            continue
                        if member.filename.casefold() in seen:
                            raise PrivacyScanError("duplicate-archive-entry")
                        seen.add(member.filename.casefold())
                        mode = (member.external_attr >> 16) & 0xFFFF
                        if stat.S_ISLNK(mode) or (member.flag_bits & 1):
                            raise PrivacyScanError("unsafe-archive-entry")
                        with archive.open(member) as opened:
                            self.inspect(member.filename, opened, depth, inherited, child, parents)
            except (zipfile.BadZipFile, RuntimeError, EOFError) as error:
                raise PrivacyScanError("unreadable-zip-archive") from error
        else:
            try:
                with tarfile.open(fileobj=stream, mode="r:*") as archive:
                    regular_members = {}
                    for index, member in enumerate(archive, 1):
                        child = f"{locator}.{index}"
                        names = (*parents, member.name) if self.local_paths else ()
                        if member.isdir():
                            self.check_name(member.name, finding_origin(member.name, inherited), child, names)
                            continue
                        if member.name.casefold() in seen:
                            raise PrivacyScanError("duplicate-archive-entry")
                        seen.add(member.name.casefold())
                        source = member
                        if member.islnk():
                            self.check_name(member.linkname, finding_origin(member.linkname, inherited), child, names, "link-target")
                            # TAR hard links can alias data already present in the same archive.
                            # Read that exact regular member, never resolve or extract a link.
                            if member.size != 0 or member.linkname not in regular_members:
                                raise PrivacyScanError("unsafe-archive-hardlink")
                            source = regular_members[member.linkname]
                        elif not member.isfile():
                            raise PrivacyScanError("unsafe-archive-entry")
                        opened = archive.extractfile(source)
                        if opened is None:
                            raise PrivacyScanError("unreadable-archive-entry")
                        with opened:
                            self.inspect(member.name, opened, depth, inherited, child, parents)
                        if member.isfile():
                            regular_members[member.name] = member
            except (tarfile.TarError, EOFError) as error:
                raise PrivacyScanError("unreadable-tar-archive") from error


def scan_directory(directory, policy_path, strict_opaque, diagnostics=False, local_paths=False):
    if not directory.is_dir() or directory.is_symlink():
        raise PrivacyScanError("invalid-asset-directory")
    rules, contexts = load_patterns(policy_path)
    scanner = Scanner(rules, strict_opaque, diagnostics, local_paths, contexts)
    for path in sorted(directory.rglob("*"), key=lambda item: item.relative_to(directory).as_posix()):
        if path.is_symlink():
            raise PrivacyScanError("symlinked-release-asset")
        if path.is_dir():
            continue
        if not path.is_file():
            raise PrivacyScanError("non-regular-release-asset")
        name = path.relative_to(directory).as_posix()
        with path.open("rb") as stream:
            scanner.object_count += 1
            scanner.inspect(name, stream, 0, locator=str(scanner.object_count))
    return scanner


def write_local_report(path, directory, scanner):
    # Local-only: never put path-bearing reports into a release directory or CI artifacts.
    if os.environ.get("CI") or os.environ.get("GITHUB_ACTIONS"):
        raise PrivacyScanError("local-report-forbidden-in-ci")
    if path.resolve().is_relative_to(directory.resolve()):
        raise PrivacyScanError("local-report-inside-release")
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump({
                "schema_version": 1,
                "truncated": scanner.is_details_truncated,
                "details": list(scanner.details.values()),
            }, output, ensure_ascii=True)
            output.write("\n")
    except OSError as error:
        raise PrivacyScanError("local-report-write-failed") from error


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument("policy", type=Path)
    parser.add_argument("--strict-opaque", action="store_true")
    parser.add_argument("--diagnostics", action="store_true")
    parser.add_argument("--local-report", type=Path, help="Offline only: exclusive private path mapping outside release directory")
    args = parser.parse_args()
    try:
        if args.local_report and (os.environ.get("CI") or os.environ.get("GITHUB_ACTIONS")):
            raise PrivacyScanError("local-report-forbidden-in-ci")
        scanner = scan_directory(args.directory, args.policy, args.strict_opaque,
                                 args.diagnostics or args.local_report is not None,
                                 args.local_report is not None)
        if args.local_report:
            write_local_report(args.local_report, args.directory, scanner)
    except PrivacyScanError as error:
        print("::error::Release privacy scan could not verify assets [" + str(error) + "].", file=sys.stderr)
        return 1
    except (OSError, ValueError):
        print("::error::Release privacy scan failed; asset details suppressed.", file=sys.stderr)
        return 1
    for name, count in sorted(scanner.counts.items()):
        print("::error::Release privacy finding [" + name + "]: " + str(count), file=sys.stderr)
    for (area, kind, name), count in sorted(scanner.origin_counts.items()):
        print(f"Release privacy origin [{area}/{kind}/{name}]: {count}", file=sys.stderr)
    if args.diagnostics:
        for detail in scanner.details.values():
            public = {key: value for key, value in detail.items() if key != "relative_archive_chain"}
            print("Release privacy locator " + json.dumps(public, sort_keys=True), file=sys.stderr)
        if scanner.is_details_truncated:
            print("Release privacy diagnostics truncated; blocking findings remain unchanged.", file=sys.stderr)
    print(json.dumps({
        "schema_version": 1,
        "files_scanned": scanner.checked_files,
        "archives_scanned": scanner.archives,
        "opaque_unverified": scanner.opaque_files,
        "privacy_findings": sum(scanner.counts.values()),
    }))
    return 1 if scanner.counts else 0


if __name__ == "__main__":
    sys.exit(main())
