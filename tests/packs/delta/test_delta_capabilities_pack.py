"""Run Delta capability regression tests against the pinned source checkout."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from kit_target import target_root


PACK_ROOT = Path(__file__).resolve().parent

PRODUCT_INTEGRATION_TESTS = {
    "product-integration/delta-worktree-profile.spec.ts": "packages/bundle/base/tests/delta-worktree.spec.ts",
    "product-integration/worktree-chat.spec.tsx": "packages/client/ui-chat/tests/delta-worktree-locale.client.spec.tsx",
    "product-integration/worktree-command.spec.ts": "packages/client/ui-commands/tests/delta-worktree-locale.client.spec.ts",
    "product-integration/worktree-session.spec.ts": "packages/session/working-directory/tests/delta-worktree.integration.spec.ts",
}


def test_delta_capability_contract() -> None:
    target = target_root()
    environment = os.environ.copy()
    environment["CENTRAL_TEST_TARGET_ROOT"] = str(target)
    tests = sorted(PACK_ROOT.glob("*-test.mjs"))
    result = subprocess.run(
        ["node", "--experimental-strip-types", "--test", *(str(path) for path in tests)],
        cwd=target,
        env=environment,
        check=False,
        text=True,
        capture_output=True,
    )
    assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"


def test_delta_worktree_and_forge_product_integration() -> None:
    """Run trusted central-owned integration specs against the installed Delta checkout."""
    target = target_root()
    staged: list[Path] = []
    try:
        for source_relative, target_relative in PRODUCT_INTEGRATION_TESTS.items():
            source = PACK_ROOT / source_relative
            destination = target / target_relative
            if destination.exists():
                raise AssertionError(f"Refusing to overwrite a product path: {target_relative}")
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
            staged.append(destination)

        vitest = target / "node_modules" / "vitest" / "vitest.mjs"
        if not vitest.is_file():
            raise AssertionError("Delta's frozen install did not provide the Vitest runner")
        result = subprocess.run(
            [
                "node",
                str(vitest),
                "run",
                "--config",
                "vitest.config.ts",
                *(path.relative_to(target).as_posix() for path in staged),
            ],
            cwd=target,
            check=False,
            text=True,
            capture_output=True,
            timeout=240,
        )
        assert result.returncode == 0, f"{result.stdout}\n{result.stderr}"
    finally:
        for path in reversed(staged):
            path.unlink(missing_ok=True)
