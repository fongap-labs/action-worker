"""Trusted contract for the Delta first-party plugin shared library.

Until Delta adopts the workspace package, legacy target revisions skip the
package-specific assertions. Once adopted, the executable source contract
runs against the exact checked-out Delta target root.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from kit_target import target_root


PLUGIN_ROOT = target_root() / "packages" / "plugin" / "shared"


def _plugin_root() -> Path:
    if not PLUGIN_ROOT.is_dir():
        pytest.skip("Delta first-party shared package has not yet been introduced")
    return PLUGIN_ROOT


def test_shared_package_is_private_and_lockfile_consistent() -> None:
    root = _plugin_root()
    manifest = json.loads((root / "package.json").read_text(encoding="utf-8"))
    assert manifest["name"] == "@fongap-labs/delta-plugin-shared"
    assert manifest["private"] is True
    assert manifest["scripts"]["build"] == "tsc -p tsconfig.json"
    assert manifest["exports"]["."]["default"] == "./lib/index.js"
    lock = (target_root() / "pnpm-lock.yaml").read_text(encoding="utf-8")
    _, separator, remaining = lock.partition("\\n  packages/plugin/shared:")
    assert separator, "shared plugin package must have a frozen-lockfile importer"
    importer = remaining.split("\\n  packages/", maxsplit=1)[0]
    dependencies = manifest.get("dependencies", {})
    if dependencies.get("@deepseek-ai/dsh-tools") == "workspace:*":
        assert "\\n    dependencies:\\n" in importer
        assert (
            "\\n      '@deepseek-ai/dsh-tools':\\n"
            "        specifier: workspace:*\\n"
            "        version: link:../../core/tools\\n"
        ) in importer
    else:
        assert importer.startswith(" {}\\n"), "previous shared package has an empty importer"


def test_shared_host_access_is_fail_closed_and_helpers_are_bounded() -> None:
    root = _plugin_root()
    script = """
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = process.argv[1];
const load = name => import(pathToFileURL(join(dir, 'src', name)).href);
const host = await load('plugin-host-access.ts');
const config = await load('plugin-config-validation.ts');
const effect = await load('plugin-effect-lifecycle.ts');
const error = await load('plugin-error-redaction.ts');
const paths = await load('plugin-path-resolution.ts');

assert.throws(
  () => host.requirePluginHostService({}, 'subprocess', 'spawn'),
  host.MissingPluginHostServiceError,
);
assert.throws(
  () => host.requirePluginHostService({ subprocess: {} }, 'subprocess', 'spawn'),
  host.MissingPluginHostServiceError,
);
const service = { spawn() { return 1 } };
assert.equal(
  host.requirePluginHostService({ subprocess: service }, 'subprocess', 'spawn'),
  service,
);
assert.equal(config.requirePluginString('  good  ', 'endpoint'), 'good');
assert.throws(() => config.requirePluginString(' ', 'endpoint'), TypeError);
assert.equal(config.optionalPluginBoolean(undefined, 'enabled', false), false);
assert.throws(() => config.optionalPluginBoolean('false', 'enabled', false), TypeError);
let disposed = false;
effect.registerPluginEffect(
  { effect(register) { const dispose = register(); dispose(); } },
  () => () => { disposed = true; },
);
assert.equal(disposed, true);
assert.equal(
  error.redactPluginMessage('Bearer value123 secret=hidden', ['hidden']),
  'Bearer [REDACTED] secret=[REDACTED]',
);
assert.equal(error.describePluginError(new Error('private message')), 'Error');
const unsafe = new Error('private'); unsafe.name = 'private identifier';
assert.equal(error.describePluginError(unsafe), 'Error');
assert.equal(paths.isPathInside('/tmp/delta', 'work/item'), true);
assert.equal(paths.isPathInside('/tmp/delta', '../outside'), false);
assert.throws(() => paths.resolveInside('/tmp/delta', '../outside'), RangeError);
"""
    run = subprocess.run(
        ["node", "--experimental-strip-types", "--input-type=module", "-e", script, str(root)],
        cwd=target_root(),
        capture_output=True,
        text=True,
        timeout=45,
        check=False,
    )
    assert run.returncode == 0, (
        f"Delta plugin shared contract failed: stdout={run.stdout[-1000:]} stderr={run.stderr[-2000:]}"
    )


def test_host_only_subprocess_never_falls_back_to_local_node() -> None:
    root = _plugin_root()
    helper = root / "src" / "plugin-subprocess.ts"
    if not helper.is_file():
        pytest.skip("Host-only subprocess helper is introduced with the Delta Code migration")
    assert "node:child_process" not in helper.read_text(encoding="utf-8")
    script = """
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const p = await import(pathToFileURL(join(process.argv[1], 'src', 'plugin-subprocess.ts')).href);
await assert.rejects(p.runCommand({}, { command: 'git', args: ['status'], hostOnly: false }),
  /host subprocess service unavailable/);
await assert.rejects(p.runCommand({ subprocess: {} }, { command: 'git' }),
  /host subprocess service unavailable/);
const seen = [];
const host = { subprocess: { spawn(spec) {
  seen.push(spec);
  return { done: Promise.resolve({ exitCode: 0, signal: null }),
    collected: { stdout: { readFrom() { return { text: 'clean', lossy: false }; } } } };
} } };
const result = await p.runCommand(host, { command: 'git', args: ['status'], cwd: '/tmp' });
assert.equal(result.source, 'host');
assert.equal(result.exitCode, 0);
assert.equal(result.stdout, 'clean');
assert.deepEqual(seen[0].argv, ['git', 'status']);
assert.equal(seen[0].cwd, '/tmp');
"""
    run = subprocess.run(
        ["node", "--experimental-strip-types", "--input-type=module", "-e", script, str(root)],
        cwd=target_root(), capture_output=True, text=True, timeout=45, check=False,
    )
    assert run.returncode == 0, (
        f"Host-only subprocess contract failed: stdout={run.stdout[-1000:]} stderr={run.stderr[-2000:]}"
    )
