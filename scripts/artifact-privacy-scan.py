#!/usr/bin/env python3
"""Offline privacy scan for release assets; never prints filenames or matching values."""

import argparse
import io
import json
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
        return rules
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
    def __init__(self, rules, strict_opaque):
        self.rules = rules
        self.strict_opaque = strict_opaque
        self.counts = {}
        self.origin_counts = {}
        self.checked_files = 0
        self.archives = 0
        self.opaque_files = 0
        self.expanded_bytes = 0

    def check_text(self, text, origin):
        for name, expression in self.rules:
            if expression.search(text):
                self.counts[name] = self.counts.get(name, 0) + 1
                key = (*origin, name)
                self.origin_counts[key] = self.origin_counts.get(key, 0) + 1

    def check_name(self, name, origin):
        normalized = name.replace("\\", "/")
        path = PurePosixPath(normalized)
        if (
            normalized.startswith("/")
            or re.match(r"^[A-Za-z]:", normalized)
            or ".." in path.parts
            or not normalized
        ):
            raise PrivacyScanError("unsafe-archive-path")
        self.check_text(normalized, origin)

    def scan_stream(self, stream, origin):
        self.checked_files += 1
        if self.checked_files > MAX_FILES:
            raise PrivacyScanError("file-budget-exceeded")
        tail = ""
        while True:
            block = stream.read(CHUNK_BYTES)
            if not block:
                break
            self.expanded_bytes += len(block)
            if self.expanded_bytes > MAX_EXPANDED_BYTES:
                raise PrivacyScanError("expanded-size-budget-exceeded")
            text = tail + block.decode("utf-8", errors="replace")
            self.check_text(text, origin)
            tail = text[-OVERLAP_BYTES:]

    def inspect(self, name, stream, depth, inherited="other"):
        origin = finding_origin(name, inherited)
        self.check_name(name, origin)
        lower = name.lower()
        if lower.endswith(ARCHIVE_SUFFIXES):
            if depth >= MAX_ARCHIVE_DEPTH:
                raise PrivacyScanError("nested-archive-depth-exceeded")
            if depth == 0:
                # Root release archives are already seekable files; do not load them into memory.
                self.scan_archive(lower, stream, depth + 1, origin[0])
            else:
                raw = stream.read(MAX_NESTED_ARCHIVE_BYTES + 1)
                if len(raw) > MAX_NESTED_ARCHIVE_BYTES:
                    raise PrivacyScanError("nested-archive-size-exceeded")
                self.expanded_bytes += len(raw)
                if self.expanded_bytes > MAX_EXPANDED_BYTES:
                    raise PrivacyScanError("expanded-size-budget-exceeded")
                self.scan_archive(lower, io.BytesIO(raw), depth + 1, origin[0])
        else:
            if lower.endswith(OPAQUE_SUFFIXES):
                self.opaque_files += 1
                if self.strict_opaque:
                    raise PrivacyScanError("opaque-asset-not-verifiable")
            self.scan_stream(stream, origin)

    def scan_archive(self, name, stream, depth, inherited):
        self.archives += 1
        seen = set()
        if name.endswith((".zip", ".jar")):
            try:
                with zipfile.ZipFile(stream) as archive:
                    for member in archive.infolist():
                        if member.is_dir():
                            continue
                        if member.filename.casefold() in seen:
                            raise PrivacyScanError("duplicate-archive-entry")
                        seen.add(member.filename.casefold())
                        mode = (member.external_attr >> 16) & 0xFFFF
                        if stat.S_ISLNK(mode) or (member.flag_bits & 1):
                            raise PrivacyScanError("unsafe-archive-entry")
                        with archive.open(member) as opened:
                            self.inspect(member.filename, opened, depth, inherited)
            except (zipfile.BadZipFile, RuntimeError, EOFError) as error:
                raise PrivacyScanError("unreadable-zip-archive") from error
        else:
            try:
                with tarfile.open(fileobj=stream, mode="r:*") as archive:
                    regular_members = {}
                    for member in archive:
                        if member.isdir():
                            self.check_name(member.name, finding_origin(member.name, inherited))
                            continue
                        if member.name.casefold() in seen:
                            raise PrivacyScanError("duplicate-archive-entry")
                        seen.add(member.name.casefold())
                        source = member
                        if member.islnk():
                            self.check_name(member.linkname, finding_origin(member.linkname, inherited))
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
                            self.inspect(member.name, opened, depth, inherited)
                        if member.isfile():
                            regular_members[member.name] = member
            except (tarfile.TarError, EOFError) as error:
                raise PrivacyScanError("unreadable-tar-archive") from error


def scan_directory(directory, policy_path, strict_opaque):
    if not directory.is_dir() or directory.is_symlink():
        raise PrivacyScanError("invalid-asset-directory")
    scanner = Scanner(load_patterns(policy_path), strict_opaque)
    for path in directory.rglob("*"):
        if path.is_symlink():
            raise PrivacyScanError("symlinked-release-asset")
        if path.is_dir():
            continue
        if not path.is_file():
            raise PrivacyScanError("non-regular-release-asset")
        name = path.relative_to(directory).as_posix()
        with path.open("rb") as stream:
            scanner.inspect(name, stream, 0)
    return scanner


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    parser.add_argument("policy", type=Path)
    parser.add_argument("--strict-opaque", action="store_true")
    args = parser.parse_args()
    try:
        scanner = scan_directory(args.directory, args.policy, args.strict_opaque)
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
