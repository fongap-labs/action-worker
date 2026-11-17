#!/usr/bin/env python3
"""Normalize ephemeral hosted-runner home paths in generated CycloneDX SBOM."""
import json
import os
from pathlib import Path
import sys

def normalize(value):
    if isinstance(value, str):
        return value.replace(os.environ["HOME"], "/build-runner") if os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("HOME") else value
    if isinstance(value, list):
        return [normalize(item) for item in value]
    if isinstance(value, dict):
        return {key: normalize(item) for key, item in value.items()}
    return value

def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: normalize-release-sbom.py <cyclonedx-json>")
    path = Path(sys.argv[1])
    document = json.loads(path.read_text(encoding="utf-8"))
    if document.get("bomFormat") != "CycloneDX" or not isinstance(document.get("specVersion"), str):
        raise SystemExit("invalid CycloneDX SBOM")
    normalized = normalize(document)
    path.write_text(json.dumps(normalized, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print("Normalized generated CycloneDX SBOM runner-home paths.")

if __name__ == "__main__":
    main()
