---
name: release-verify
description: Verify release source identity, CI evidence, manifest, assets, checksums, licensing, publication, and rollback behavior.
---

# Release Verify

Use before or after publishing a release.

## 1. Verify source identity

Confirm:
- source repository;
- immutable source SHA;
- expected branch/tag relationship;
- required CI evidence for that SHA.

Do not publish from an ambiguous moving ref when policy requires an immutable commit.

## 2. Verify release contract

Validate:
- release key;
- semantic version;
- tag format;
- release name/notes;
- prerelease flag;
- target repository;
- license metadata.

## 3. Verify assets

For every asset:
- expected name exists;
- size is non-zero when applicable;
- SHA256 matches manifest;
- no unexpected assets are silently substituted.

## 4. Verify publication

After upload:
- fetch published metadata again;
- re-download assets when the release process requires it;
- re-check SHA256;
- verify tag and release point to the intended source/version.

Publication success is not sufficient evidence of artifact integrity.

## 5. Failure handling

If a release attempt partially created state, follow the repository's rollback contract. Do not leave an apparently valid tag/release pointing at incomplete assets.

## 6. Cross-repository releases

When source and distribution repositories differ, verify both sides of the contract. Source repositories build and attest artifacts; the central release authority validates and publishes them; distribution repositories do not become the source of program logic.
