// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Merged suite. Each section below was a standalone suite and keeps its own scope:
//   - provider-discovery-test.mjs
//   - provider-discovery-ssrf-guard-test.mjs
//   - provider-adapter-registry-test.mjs

import { targetRoot as root } from '#kit/target.mjs';
import { EVIDENCE_LEVELS, PROTOCOLS, SUPPORT_FALSE, SUPPORT_NULL, SUPPORT_TRUE, SURFACES_BY_PROTOCOL, aggregateCatalogCapabilities, checkRuntimeAgainstCatalog, diffCatalogs, formatActionSummary, formatChangesMarkdown, formatJsonReport, hasProtocolDowngrade, isEvidence, isProtocol, isSupportTriState, isSurfaceFor, loadCatalogFile, normalizeCapabilityEntry, normalizeCatalog, normalizeRuntimeView, summarizeBySeverity, summarizeWarnings, validateCapabilityEntry, validateCatalog } from '#target/scripts/provider-discovery/index.js';
import { DISCOVERY_LIMITS, enforceMaxModelCount, isDangerousHost, isSafeDiscoveryTarget, isSafeDiscoveryUrl, readBoundedResponseText, redirectTargetIsSafe } from '#target/scripts/provider-discovery/ssrf-guard.js';
import { loadGatewayConfig } from '#target/src/config/nodes.ts';
import { __resetOAuthProvidersCacheForTests, loadOAuthProviders } from '#target/src/oauth/provider-configs.ts';
import { builtinOAuthProviderConfigs, getProviderAdapter, providerWire, streamUsageEnabled } from '#target/src/providers/registry.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ==========================================================================
// provider-discovery-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  //
  // Provider Discovery test suite (v1.1).
  //
  // Pure unit tests — no network, no Worker runtime. This file is part of
  // `npm run test:required` and must never reach out to third-party APIs.
  //
  // Coverage:
  //   - Provider Capability schema (tri-state, surfaces, evidence)
  //   - Normalization (stable sort, secret-stripping, base URL canonicalization)
  //   - Diff semantics (added/removed/changed; severity mapping)
  //   - Runtime consistency (mismatch, base URL drift, no auto-mutation)
  //   - Report formatters (markdown, summary, JSON)
  //   - Security invariants (no secrets in any output path)
  //   - Boundary invariants (no coupling to runtime hot path)










  const here = path.dirname(fileURLToPath(import.meta.url));

  const cliPath = path.join(root, 'scripts', 'provider-discovery.mjs');
  const samplesDir = path.join(root, 'scripts', 'provider-discovery', 'samples');

  let passed = 0;
  function test(name, fn) {
    try {
      fn();
      passed += 1;
      console.log(`ok - ${name}`);
    } catch (e) {
      console.error(`FAIL: ${name}`);
      console.error(e && e.stack || e);
      process.exitCode = 1;
    }
  }

  // ----------------- Provider Capability schema -----------------------------

  test('OpenAI-only provider serializes correctly', () => {
    const e = validateCapabilityEntry('openai', {
      supported: true,
      base_url: 'https://api.example.com/v1',
      surfaces: ['chat_completions'],
      evidence: 'configured',
    });
    assert.equal(e.length, 0);
  });

  test('Anthropic-only provider serializes correctly', () => {
    const e = validateCapabilityEntry('anthropic', {
      supported: true,
      base_url: 'https://api.example.com',
      surfaces: ['messages'],
      evidence: 'official',
    });
    assert.equal(e.length, 0);
  });

  test('Dual-protocol provider serializes correctly', () => {
    const { catalog, warnings } = normalizeCatalog({
      schema_version: '1.1',
      providers: {
        dual: {
          openai: { supported: true, base_url: 'https://a.example/v1', surfaces: ['chat_completions', 'responses'], evidence: 'official' },
          anthropic: { supported: true, base_url: 'https://a.example', surfaces: ['messages'], evidence: 'official' },
        },
      },
    });
    assert.equal(warnings.length, 0);
    assert.equal(catalog.providers.dual.openai.surfaces.length, 2);
    assert.equal(catalog.providers.dual.anthropic.surfaces[0], 'messages');
  });

  test('OpenAI Chat supported / Responses unknown is preserved', () => {
    const { entry, warnings } = normalizeCapabilityEntry('openai', {
      supported: true,
      base_url: 'https://api.example.com/v1',
      surfaces: ['chat_completions'],
      evidence: 'configured',
    });
    assert.equal(warnings.length, 0);
    assert.equal(entry.supported, SUPPORT_TRUE);
    assert.deepEqual(entry.surfaces, ['chat_completions']);
    assert.ok(!('responses' in entry));
  });

  test('null must not be coerced to false (unknown != unsupported)', () => {
    const { entry } = normalizeCapabilityEntry('openai', {
      supported: null,
      base_url: null,
      surfaces: [],
      evidence: 'unknown',
    });
    assert.equal(entry.supported, SUPPORT_NULL);
    assert.notEqual(entry.supported, SUPPORT_FALSE);
  });

  test('Surface not listed is NOT auto-interpreted as unsupported', () => {
    const { catalog } = normalizeCatalog({
      schema_version: '1.1',
      providers: {
        ex: {
          openai: { supported: true, base_url: 'https://ex.com/v1', surfaces: ['chat_completions'], evidence: 'configured' },
          anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' },
        },
      },
    });
    const diff = diffCatalogs(catalog, catalog);
    assert.equal(diff.changed.length, 0);
    assert.ok(!('responses' in catalog.providers.ex.openai));
  });

  test('Explicit unsupported state is preserved (false, not null)', () => {
    const { entry, warnings } = normalizeCapabilityEntry('anthropic', {
      supported: false,
      base_url: null,
      surfaces: [],
      evidence: 'verified',
    });
    assert.equal(warnings.length, 0);
    assert.equal(entry.supported, SUPPORT_FALSE);
    assert.equal(entry.evidence, 'verified');
  });

  test('Evidence configured/official/verified/unknown all normalize', () => {
    for (const ev of EVIDENCE_LEVELS) {
      const { entry, warnings } = normalizeCapabilityEntry('openai', {
        supported: true,
        base_url: 'https://api.example.com/v1',
        surfaces: ['chat_completions'],
        evidence: ev,
      });
      assert.equal(warnings.length, 0);
      assert.equal(entry.evidence, ev);
    }
  });

  test('Unknown evidence coerces to "unknown" (no guess)', () => {
    const { entry, warnings } = normalizeCapabilityEntry('openai', {
      supported: true,
      base_url: 'https://api.example.com/v1',
      surfaces: ['chat_completions'],
      evidence: 'rumored',
    });
    assert.equal(entry.evidence, 'unknown');
    assert.ok(warnings.some((w) => /evidence/i.test(w)));
  });

  test('surfaces entry with supported=false must be empty', () => {
    const { entry, warnings } = normalizeCapabilityEntry('openai', {
      supported: false,
      base_url: 'https://api.example.com/v1',
      surfaces: ['chat_completions'],
      evidence: 'verified',
    });
    assert.deepEqual(entry.surfaces, []);
    assert.ok(warnings.some((w) => /cleared/i.test(w)));
  });

  // ----------------- Protocol Discovery invariants --------------------------

  test('A successful /models observation does NOT imply Responses support', () => {
    const discoveryRoot = path.join(root, 'scripts', 'provider-discovery');
    const files = fs.readdirSync(discoveryRoot).filter((f) => f.endsWith('.js'));
    const forbiddenEndpoints = [
      '/v1/chat/completions',
      '/v1/responses',
      '/v1/messages',
      'POST ',
      'speed test',
      'active probe',
      'health probe',
    ];
    for (const f of files) {
      if (f === 'README.md') continue;
      const text = fs.readFileSync(path.join(discoveryRoot, f), 'utf8');
      for (const needle of forbiddenEndpoints) {
        assert.ok(
          !text.toLowerCase().includes(needle.toLowerCase()),
          `${f} contains forbidden token "${needle}"`,
        );
      }
    }
    const cliText = fs.readFileSync(cliPath, 'utf8');
    for (const needle of forbiddenEndpoints) {
      assert.ok(
        !cliText.toLowerCase().includes(needle.toLowerCase()),
        `provider-discovery.mjs contains forbidden token "${needle}"`,
      );
    }
  });

  test('Discovery module never imports src/runtime, src/scheduler, src/transport, src/request, src/reliability, src/stream', () => {
    const discoveryRoot = path.join(root, 'scripts', 'provider-discovery');
    const files = fs.readdirSync(discoveryRoot).filter((f) => f.endsWith('.js'));
    for (const f of files) {
      const text = fs.readFileSync(path.join(discoveryRoot, f), 'utf8');
      for (const forbidden of [
        '../runtime/',
        '../scheduler/',
        '../transport/',
        '../request/',
        '../reliability/',
        '../stream/',
        '../conversion/',
        '../observability/',
        '../protocol/',
        '../dashboard/',
      ]) {
        assert.ok(
          !text.includes(forbidden),
          `${f} imports runtime-coupled path "${forbidden}"`,
        );
      }
    }
    const cliText = fs.readFileSync(cliPath, 'utf8');
    for (const forbidden of [
      '../runtime/',
      '../scheduler/',
      '../transport/',
      '../request/',
      '../reliability/',
      '../stream/',
      '../conversion/',
    ]) {
      assert.ok(
        !cliText.includes(forbidden),
        `provider-discovery.mjs imports runtime-coupled path "${forbidden}"`,
      );
    }
  });

  // ----------------- Base URL invariants ------------------------------------

  test('OpenAI and Anthropic can keep distinct base URLs', () => {
    const { catalog, warnings } = normalizeCatalog({
      schema_version: '1.1',
      providers: {
        multi: {
          openai: { supported: true, base_url: 'https://open.multi.example/v1', surfaces: ['chat_completions'], evidence: 'configured' },
          anthropic: { supported: true, base_url: 'https://anthropic.multi.example/', surfaces: ['messages'], evidence: 'configured' },
        },
      },
    });
    assert.equal(warnings.length, 0);
    assert.equal(catalog.providers.multi.openai.base_url, 'https://open.multi.example/v1');
    assert.ok(
      catalog.providers.multi.anthropic.base_url === 'https://anthropic.multi.example'
        || catalog.providers.multi.anthropic.base_url === 'https://anthropic.multi.example/',
      `expected canonical URL, got ${catalog.providers.multi.anthropic.base_url}`,
    );
  });

  test('base_url null is preserved as unknown', () => {
    const { entry } = normalizeCapabilityEntry('anthropic', {
      supported: null,
      base_url: null,
      surfaces: [],
      evidence: 'unknown',
    });
    assert.equal(entry.base_url, null);
  });

  test('Base URL must not be guessed from provider name', () => {
    const { entry, warnings } = normalizeCapabilityEntry('openai', {
      supported: true,
      surfaces: ['chat_completions'],
      evidence: 'configured',
    });
    assert.equal(entry.base_url, null);
    assert.ok(!warnings.some((w) => /guess/i.test(w)));
  });

  test('Base URL with trailing slash normalizes to canonical form', () => {
    const { entry } = normalizeCapabilityEntry('openai', {
      supported: true,
      base_url: 'https://api.example.com/v1/',
      surfaces: ['chat_completions'],
      evidence: 'configured',
    });
    assert.equal(entry.base_url, 'https://api.example.com/v1');
  });

  test('Base URL order/format changes do not produce false diff', () => {
    const a = normalizeCatalog({
      schema_version: '1.1',
      providers: {
        ex: { openai: { supported: true, base_url: 'https://api.example.com/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } },
      },
    }).catalog;
    const bRaw = {
      schema_version: '1.1',
      providers: {
        ex: { openai: { supported: true, base_url: 'https://api.example.com/v1/', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } },
      },
    };
    const b = normalizeCatalog(bRaw).catalog;
    const diff = diffCatalogs(a, b);
    assert.equal(diff.changed.length, 0);
  });

  test('Credential-bearing URLs are refused', () => {
    const { entry, warnings } = normalizeCapabilityEntry('openai', {
      supported: true,
      base_url: 'https://user:pass@api.example.com/v1',
      surfaces: ['chat_completions'],
      evidence: 'configured',
    });
    assert.equal(entry.base_url, null);
    assert.ok(warnings.some((w) => /credential/i.test(w)));
  });

  test('Credential-like token in base URL is dropped, not persisted', () => {
    const secretMarker = 'sk-' + 'a'.repeat(24);
    const { entry, warnings } = normalizeCapabilityEntry('openai', {
      supported: true,
      base_url: `https://api.example.com/v1?key=${secretMarker}`,
      surfaces: ['chat_completions'],
      evidence: 'configured',
    });
    assert.equal(entry.base_url, null);
    assert.ok(warnings.some((w) => /credential/i.test(w)));
  });

  test('http:// base URL is refused (Discovery is conservative)', () => {
    const { entry } = normalizeCapabilityEntry('openai', {
      supported: true,
      base_url: 'http://api.example.com/v1',
      surfaces: ['chat_completions'],
      evidence: 'configured',
    });
    assert.equal(entry.base_url, null);
  });

  // ----------------- Diff semantics -----------------------------------------

  test('protocol_support_changed is reported when support flips', () => {
    const before = normalizeCatalog({
      schema_version: '1.1',
      providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
    }).catalog;
    const after = normalizeCatalog({
      schema_version: '1.1',
      providers: { ex: { openai: { supported: false, base_url: null, surfaces: [], evidence: 'verified' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
    }).catalog;
    const diff = diffCatalogs(before, after);
    const protoChanges = diff.changed.filter((c) => c.kind === 'protocol_support_changed');
    assert.equal(protoChanges.length, 1);
    assert.equal(protoChanges[0].before, SUPPORT_TRUE);
    assert.equal(protoChanges[0].after, SUPPORT_FALSE);
    assert.equal(protoChanges[0].severity, 'P1');
    assert.equal(protoChanges[0].direction, 'down');
  });

  test('surface_support_changed is reported when a surface appears/disappears', () => {
    const before = normalizeCatalog({
      schema_version: '1.1',
      providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
    }).catalog;
    const after = normalizeCatalog({
      schema_version: '1.1',
      providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions', 'responses'], evidence: 'official' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
    }).catalog;
    const diff = diffCatalogs(before, after);
    const surf = diff.changed.filter((c) => c.kind === 'surface_support_changed' && c.surface === 'responses');
    assert.equal(surf.length, 1);
    assert.equal(surf[0].before, 'unknown');
    assert.equal(surf[0].after, 'supported');
    assert.equal(surf[0].severity, 'P2');
  });

  test('base_url_changed is reported when URL differs', () => {
    const before = normalizeCatalog({
      schema_version: '1.1',
      providers: { ex: { openai: { supported: true, base_url: 'https://old.example/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
    }).catalog;
    const after = normalizeCatalog({
      schema_version: '1.1',
      providers: { ex: { openai: { supported: true, base_url: 'https://new.example/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
    }).catalog;
    const diff = diffCatalogs(before, after);
    const urlChanges = diff.changed.filter((c) => c.kind === 'base_url_changed');
    assert.equal(urlChanges.length, 1);
    assert.equal(urlChanges[0].before, 'https://old.example/v1');
    assert.equal(urlChanges[0].after, 'https://new.example/v1');
    assert.equal(urlChanges[0].severity, 'P3');
  });

  test('unknown -> supported is a lower-severity change than supported -> unsupported', () => {
    const a = normalizeCatalog({
      schema_version: '1.1',
      providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
    }).catalog;
    const b = normalizeCatalog({
      schema_version: '1.1',
      providers: { ex: { openai: { supported: false, base_url: null, surfaces: [], evidence: 'verified' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
    }).catalog;
    const d1 = diffCatalogs(a, b);
    const downgrade = d1.changed.find((c) => c.kind === 'protocol_support_changed');
    assert.equal(downgrade.severity, 'P1');

    const c = normalizeCatalog({
      schema_version: '1.1',
      providers: { ex: { openai: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
    }).catalog;
    const d = normalizeCatalog({
      schema_version: '1.1',
      providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
    }).catalog;
    const d2 = diffCatalogs(c, d);
    const upgrade = d2.changed.find((c2) => c2.kind === 'protocol_support_changed');
    assert.equal(upgrade.severity, 'P2');
  });

  test('supported -> unknown is more severe than unknown -> supported', () => {
    const a = normalizeCatalog({
      schema_version: '1.1',
      providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
    }).catalog;
    const b = normalizeCatalog({
      schema_version: '1.1',
      providers: { ex: { openai: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
    }).catalog;
    const d1 = diffCatalogs(a, b);
    const downUnknown = d1.changed.find((c) => c.kind === 'protocol_support_changed');
    assert.equal(downUnknown.severity, 'P1');

    const c = normalizeCatalog({
      schema_version: '1.1',
      providers: { ex: { openai: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
    }).catalog;
    const d = normalizeCatalog({
      schema_version: '1.1',
      providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
    }).catalog;
    const d2 = diffCatalogs(c, d);
    const upUnknown = d2.changed.find((c2) => c2.kind === 'protocol_support_changed');
    assert.equal(upUnknown.severity, 'P2');

    const order = { P0: 0, P1: 1, P2: 2, P3: 3 };
    assert.ok(order[downUnknown.severity] < order[upUnknown.severity]);
  });

  test('Provider /models ordering or JSON key order does not produce CHANGED', () => {
    const a = normalizeCatalog({
      schema_version: '1.1',
      providers: {
        b: { openai: { supported: true, base_url: 'https://b/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } },
        a: { openai: { supported: true, base_url: 'https://a/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } },
      },
    }).catalog;
    const bRaw = {
      schema_version: '1.1',
      providers: {
        a: { openai: { supported: true, base_url: 'https://a/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } },
        b: { openai: { supported: true, base_url: 'https://b/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } },
      },
    };
    const b = normalizeCatalog(bRaw).catalog;
    const diff = diffCatalogs(a, b);
    assert.equal(diff.changed.length, 0);
    assert.equal(diff.added.length, 0);
    assert.equal(diff.removed.length, 0);
  });

  test('Surfaces array reorder does not produce CHANGED', () => {
    const a = normalizeCatalog({
      schema_version: '1.1',
      providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions', 'responses'], evidence: 'official' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
    }).catalog;
    const b = normalizeCatalog({
      schema_version: '1.1',
      providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['responses', 'chat_completions'], evidence: 'official' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
    }).catalog;
    const diff = diffCatalogs(a, b);
    assert.equal(diff.changed.length, 0);
  });

  test('hasProtocolDowngrade true iff supported flipped to false/null', () => {
    const before = normalizeCatalog({
      schema_version: '1.1',
      providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
    }).catalog;
    const afterDown = normalizeCatalog({
      schema_version: '1.1',
      providers: { ex: { openai: { supported: false, base_url: null, surfaces: [], evidence: 'verified' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
    }).catalog;
    assert.equal(hasProtocolDowngrade(diffCatalogs(before, afterDown)), true);
    const afterLateral = normalizeCatalog({
      schema_version: '1.1',
      providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions', 'responses'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
    }).catalog;
    assert.equal(hasProtocolDowngrade(diffCatalogs(before, afterLateral)), false);
  });

  test('summarizeBySeverity buckets counts correctly', () => {
    const before = normalizeCatalog({
      schema_version: '1.1',
      providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
    }).catalog;
    const after = normalizeCatalog({
      schema_version: '1.1',
      providers: { ex: { openai: { supported: false, base_url: 'https://ex/v2', surfaces: [], evidence: 'verified' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
    }).catalog;
    const diff = diffCatalogs(before, after);
    const sev = summarizeBySeverity(diff);
    assert.equal(sev.P1, 2);
    assert.equal(sev.P3, 1);
  });

  // ----------------- Runtime Validation --------------------------------------

  test('Runtime Node with unsupported capability yields a warning', () => {
    const catalog = normalizeCatalog({
      schema_version: '1.1',
      providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
    }).catalog;
    const runtime = normalizeRuntimeView([
      { id: 'n1', provider: 'ex', protocol: 'openai', surfaces: ['responses'], base_url: 'https://ex/v1' },
    ]);
    const warnings = checkRuntimeAgainstCatalog(runtime, catalog);
    assert.ok(warnings.length >= 1, 'expected at least one warning');
    assert.ok(warnings.some((w) => w.kind === 'runtime_surface_mismatch'));
  });

  test('Runtime Node Base URL differs yields a warning (does not claim invalid)', () => {
    const catalog = normalizeCatalog({
      schema_version: '1.1',
      providers: { ex: { openai: { supported: true, base_url: 'https://new.example/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
    }).catalog;
    const runtime = normalizeRuntimeView([
      { id: 'n1', provider: 'ex', protocol: 'openai', surfaces: ['chat_completions'], base_url: 'https://old.example/v1' },
    ]);
    const warnings = checkRuntimeAgainstCatalog(runtime, catalog);
    const drift = warnings.find((w) => w.kind === 'runtime_base_url_differs');
    assert.ok(drift);
    assert.ok(/differs/i.test(drift.detail));
    assert.ok(!/invalid/i.test(drift.detail));
    assert.ok(!/expired/i.test(drift.detail));
  });

  test('Discovery warnings do not mutate Runtime Node', () => {
    const runtime = normalizeRuntimeView([
      { id: 'n1', provider: 'ex', protocol: 'openai', surfaces: ['chat_completions'], base_url: 'https://old.example/v1' },
    ]);
    const snapshot = JSON.stringify(runtime);
    const catalog = normalizeCatalog({
      schema_version: '1.1',
      providers: { ex: { openai: { supported: true, base_url: 'https://new.example/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
    }).catalog;
    checkRuntimeAgainstCatalog(runtime, catalog);
    assert.equal(JSON.stringify(runtime), snapshot, 'runtime view must be immutable from the check');
  });

  test('Discovery does not synthesize or create Runtime Nodes', () => {
    const discoveryRoot = path.join(root, 'scripts', 'provider-discovery');
    for (const f of fs.readdirSync(discoveryRoot).filter((f) => f.endsWith('.js'))) {
      const text = fs.readFileSync(path.join(discoveryRoot, f), 'utf8');
      assert.ok(!text.includes('buildRuntimeNode'), `${f} contains buildRuntimeNode reference`);
      assert.ok(!text.includes('writeRuntimeNode'), `${f} contains writeRuntimeNode reference`);
    }
    const cliText = fs.readFileSync(cliPath, 'utf8');
    assert.ok(!cliText.includes('writeFileSync') || /--json-out|--out/.test(cliText), 'CLI write paths limited to explicit --json-out/--out');
  });

  test('count_tokens mismatch is NOT a Runtime Node conflict (Runtime schema does not declare it)', () => {
    const catalog = normalizeCatalog({
      schema_version: '1.1',
      providers: { ex: { openai: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' }, anthropic: { supported: true, base_url: 'https://ex', surfaces: ['messages', 'count_tokens'], evidence: 'official' } } },
    }).catalog;
    const runtime = normalizeRuntimeView([
      { id: 'a1', provider: 'ex', protocol: 'anthropic', surfaces: ['messages', 'count_tokens'], base_url: 'https://ex' },
    ]);
    const warnings = checkRuntimeAgainstCatalog(runtime, catalog);
    assert.ok(!warnings.some((w) => w.kind === 'runtime_surface_mismatch'));
  });

  // ----------------- Security -----------------------------------------------

  test('Secrets do not appear in changes.md output', () => {
    const secretMarker = 'sk-' + 'a'.repeat(24);
    const before = normalizeCatalog({
      schema_version: '1.1',
      providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
    }).catalog;
    const after = normalizeCatalog({
      schema_version: '1.1',
      providers: { ex: { openai: { supported: true, base_url: `https://${secretMarker}.example/v1`, surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
    }).catalog;
    const diff = diffCatalogs(before, after);
    const md = formatChangesMarkdown({ diff, catalog: after, warnings: [], generatedAt: 'test' });
    assert.ok(!md.includes(secretMarker));
  });

  test('Secrets do not appear in Action Summary output', () => {
    const catalog = normalizeCatalog({
      schema_version: '1.1',
      providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
    }).catalog;
    const summary = formatActionSummary({ diff: { added: [], removed: [], changed: [] }, warnings: [], capability: aggregateCatalogCapabilities(catalog), generatedAt: 'test' });
    assert.ok(!/Bearer/.test(summary));
    assert.ok(!/Authorization/i.test(summary));
  });

  test('Secrets do not appear in JSON artifact output', () => {
    const before = normalizeCatalog({
      schema_version: '1.1',
      providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
    }).catalog;
    const after = normalizeCatalog({
      schema_version: '1.1',
      providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
    }).catalog;
    const json = formatJsonReport({ diff: diffCatalogs(before, after), warnings: [], catalog: after, generatedAt: 'test' });
    assert.ok(!/Bearer/.test(json));
  });

  test('Authorization header is not used as evidence source', () => {
    const { warnings } = normalizeCatalog({
      schema_version: '1.1',
      providers: {
        ex: {
          openai: {
            supported: true,
            base_url: 'https://ex/v1',
            surfaces: ['chat_completions'],
            evidence: 'configured',
            authorization: 'Bearer placeholder',
          },
          anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' },
        },
      },
    });
    assert.ok(
      warnings.some((w) => /authorization/i.test(w) || /unknown field/i.test(w)),
      `expected an authorization/unknown-field warning, got: ${warnings.join('; ')}`,
    );
  });

  // ----------------- Schema predicate checks --------------------------------

  test('isSurfaceFor and isProtocol reject unknown values', () => {
    assert.equal(isProtocol('gemini'), false);
    assert.equal(isProtocol('openai'), true);
    assert.equal(isSurfaceFor('openai', 'messages'), false);
    assert.equal(isSurfaceFor('anthropic', 'messages'), true);
    assert.equal(isSurfaceFor('openai', 'count_tokens'), false);
    assert.equal(isSurfaceFor('anthropic', 'count_tokens'), true);
    assert.equal(isEvidence('configured'), true);
    assert.equal(isEvidence('rumored'), false);
    assert.equal(isSupportTriState(true), true);
    assert.equal(isSupportTriState(false), true);
    assert.equal(isSupportTriState(null), true);
    assert.equal(isSupportTriState('yes'), false);
  });

  test('validateCatalog refuses malformed shape', () => {
    const r1 = validateCatalog(null);
    assert.equal(r1.ok, false);
    const r2 = validateCatalog({ schema_version: '1.1', providers: 'nope' });
    assert.equal(r2.ok, false);
    const r3 = validateCatalog({ schema_version: '1.1', providers: { ex: { gemini: { supported: true } } } });
    assert.equal(r3.ok, false);
  });

  // ----------------- aggregateCatalogCapabilities ---------------------------

  test('aggregateCatalogCapabilities counts supported only (no inferred), supports both protocols', () => {
    const catalog = normalizeCatalog({
      schema_version: '1.1',
      providers: {
        openai_only: { openai: { supported: true, base_url: 'https://o/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } },
        anthropic_only: { openai: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' }, anthropic: { supported: true, base_url: 'https://a', surfaces: ['messages', 'count_tokens'], evidence: 'official' } },
        mixed: { openai: { supported: true, base_url: 'https://m/v1', surfaces: ['chat_completions', 'responses'], evidence: 'official' }, anthropic: { supported: true, base_url: 'https://m', surfaces: ['messages'], evidence: 'official' } },
        unknown_only: { openai: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } },
      },
    }).catalog;
    const agg = aggregateCatalogCapabilities(catalog);
    assert.equal(agg.providers_total, 4);
    assert.equal(agg.openai_chat_supported, 2);
    assert.equal(agg.openai_responses_supported, 1);
    assert.equal(agg.anthropic_messages_supported, 2);
    assert.equal(agg.anthropic_count_tokens_supported, 1);
  });

  // ----------------- samples load correctly ---------------------------------

  test('sample catalog loads + validates', () => {
    const samplePath = path.join(samplesDir, 'catalog.example.json');
    if (!fs.existsSync(samplePath)) {
      throw new Error(`sample missing: ${samplePath}`);
    }
    const { valid, loadWarnings } = loadCatalogFile(samplePath);
    assert.ok(valid, `sample catalog must validate: ${loadWarnings.join('; ')}`);
  });

  test('sample runtime view loads and normalizes', () => {
    const viewPath = path.join(samplesDir, 'runtime-view.example.json');
    if (!fs.existsSync(viewPath)) throw new Error(`sample missing: ${viewPath}`);
    const text = fs.readFileSync(viewPath, 'utf8');
    const parsed = JSON.parse(text);
    const view = normalizeRuntimeView(parsed);
    assert.equal(view.length, 3);
    for (const n of view) {
      assert.ok(n.id);
      assert.ok(['openai', 'anthropic'].includes(n.protocol));
    }
  });

  // ----------------- CLI smoke test -----------------------------------------

  test('CLI check-snapshot exits 0 for sample catalog', () => {
    const samplePath = path.join(samplesDir, 'catalog.example.json');
    if (!fs.existsSync(samplePath)) return;
    const result = spawnSync(process.execPath, [cliPath, 'check-snapshot', samplePath], { encoding: 'utf8' });
    assert.equal(result.status, 0, `cli exited non-zero: ${result.stderr}`);
    assert.ok(result.stdout.includes('Providers:'));
  });

  test('CLI summary prints protocol/surface counts for sample catalog', () => {
    const samplePath = path.join(samplesDir, 'catalog.example.json');
    if (!fs.existsSync(samplePath)) return;
    const result = spawnSync(process.execPath, [cliPath, 'summary', samplePath], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.ok(/OpenAI Chat:/.test(result.stdout));
    assert.ok(/Anthropic Messages:/.test(result.stdout));
  });

  test('CLI runtime-check exits 2 when P1 surface mismatch is present', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-test-'));
    const catPath = path.join(tmp, 'cat.json');
    const rtPath = path.join(tmp, 'rt.json');
    fs.writeFileSync(catPath, JSON.stringify({
      schema_version: '1.1',
      providers: { ex: { openai: { supported: true, base_url: 'https://ex/v1', surfaces: ['chat_completions'], evidence: 'configured' }, anthropic: { supported: null, base_url: null, surfaces: [], evidence: 'unknown' } } },
    }));
    fs.writeFileSync(rtPath, JSON.stringify([
      { id: 'n1', provider: 'ex', protocol: 'openai', surfaces: ['responses'], base_url: 'https://ex/v1' },
    ]));
    const result = spawnSync(process.execPath, [cliPath, 'runtime-check', catPath, rtPath], { encoding: 'utf8' });
    assert.equal(result.status, 2, `expected exit 2 for P1 conflict, got ${result.status}`);
    assert.ok(/runtime_surface_mismatch/.test(result.stdout));
  });

  // ----------------- Done ----------------------------------------------------

  console.log(`\nprovider-discovery tests: ${passed} passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  } else {
    console.log('All provider-discovery tests passed.');
  }
  console.log('ok - file:provider-discovery');
} catch (error) {
  console.error('not ok - provider-discovery-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// provider-discovery-ssrf-guard-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs
  //
  // SSRF Guard tests for Provider Discovery security hardening.




  let passed = 0;
  function test(name, fn) {
    try {
      fn();
      passed += 1;
      console.log(`ok - ${name}`);
    } catch (e) {
      console.error(`FAIL: ${name}`);
      console.error(e && e.stack || e);
      process.exitCode = 1;
    }
  }
  async function testAsync(name, fn) {
    try {
      await fn();
      passed += 1;
      console.log(`ok - ${name}`);
    } catch (e) {
      console.error(`FAIL: ${name}`);
      console.error(e && e.stack || e);
      process.exitCode = 1;
    }
  }

  // --- isDangerousHost ---

  test('localhost is dangerous', () => {
    assert.ok(isDangerousHost('localhost'));
    assert.ok(isDangerousHost('LOCALHOST'));
    assert.ok(isDangerousHost('localhost.localdomain'));
  });

  test('loopback IPs are dangerous', () => {
    assert.ok(isDangerousHost('127.0.0.1'));
    assert.ok(isDangerousHost('127.0.0.5'));
    assert.ok(isDangerousHost('::1'));
    assert.ok(isDangerousHost('[::1]'));
    assert.ok(isDangerousHost('::ffff:127.0.0.1'));
  });

  test('link-local IPv4 (metadata) is dangerous', () => {
    assert.ok(isDangerousHost('169.254.169.254'));
    assert.ok(isDangerousHost('169.254.0.1'));
  });

  test('private RFC1918 IPs are dangerous', () => {
    assert.ok(isDangerousHost('10.0.0.1'));
    assert.ok(isDangerousHost('192.168.1.1'));
    assert.ok(isDangerousHost('172.16.0.1'));
    assert.ok(isDangerousHost('172.31.255.254'));
    assert.ok(isDangerousHost('100.64.0.1'));
    assert.ok(isDangerousHost('100.127.255.255'));
  });

  test('link-local IPv6 is dangerous', () => {
    assert.ok(isDangerousHost('fe80::1'));
    assert.ok(isDangerousHost('fc00::1'));
    assert.ok(isDangerousHost('fd00::1'));
  });

  test('cloud metadata hostnames are dangerous', () => {
    assert.ok(isDangerousHost('metadata.google.internal'));
    assert.ok(isDangerousHost('metadata'));
  });

  test('wildcard bind addresses are dangerous', () => {
    assert.ok(isDangerousHost('0.0.0.0'));
    assert.ok(isDangerousHost('::'));
  });

  test('public safe hosts pass', () => {
    assert.ok(!isDangerousHost('api.example.com'));
    assert.ok(!isDangerousHost('1.2.3.4'));
    assert.ok(!isDangerousHost('2001:db8::1'));
  });

  // --- isSafeDiscoveryUrl ---

  test('safe HTTPS URL passes', () => {
    const r = isSafeDiscoveryUrl('https://api.example.com/v1');
    assert.ok(r.safe);
    assert.equal(r.reason, null);
  });

  test('HTTP is rejected', () => {
    const r = isSafeDiscoveryUrl('http://api.example.com/v1');
    assert.ok(!r.safe);
    assert.ok(r.reason.includes('must use https'));
  });

  test('userinfo is rejected', () => {
    const r = isSafeDiscoveryUrl('https://user:pass@api.example.com/v1');
    assert.ok(!r.safe);
    assert.ok(r.reason.includes('userinfo'));
  });

  test('SSRF targets are rejected', () => {
    for (const url of [
      'https://localhost:443',
      'https://127.0.0.1:443',
      'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.1:443',
      'https://metadata.google.internal',
    ]) {
      const r = isSafeDiscoveryUrl(url);
      assert.ok(!r.safe, `${url} should be rejected`);
      assert.ok(r.reason.includes('blocked host'));
    }
  });

  test('allowPrivate opt-in permits private IPs', () => {
    const r = isSafeDiscoveryUrl('https://10.0.0.1:443', true);
    assert.ok(r.safe);
  });

  test('invalid URL format rejected', () => {
    const r = isSafeDiscoveryUrl('not-a-url');
    assert.ok(!r.safe);
    assert.ok(r.reason.includes('invalid URL'));
  });

  // --- DNS-backed target validation ---

  await testAsync('DNS resolution to a public address passes', async () => {
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
    const r = await isSafeDiscoveryTarget('https://api.example.com/v1', false, lookup);
    assert.ok(r.safe);
  });

  await testAsync('DNS resolution to loopback is rejected', async () => {
    const lookup = async () => [{ address: '127.0.0.1', family: 4 }];
    const r = await isSafeDiscoveryTarget('https://apparently-public.example/v1', false, lookup);
    assert.ok(!r.safe);
    assert.match(r.reason, /resolved to blocked address/);
  });

  await testAsync('DNS resolution to metadata address is rejected', async () => {
    const lookup = async () => [{ address: '169.254.169.254', family: 4 }];
    const r = await isSafeDiscoveryTarget('https://apparently-public.example/v1', false, lookup);
    assert.ok(!r.safe);
  });

  await testAsync('DNS failure is fail-closed', async () => {
    const lookup = async () => { throw new Error('NXDOMAIN'); };
    const r = await isSafeDiscoveryTarget('https://missing.example/v1', false, lookup);
    assert.ok(!r.safe);
    assert.match(r.reason, /DNS resolution failed/);
  });

  await testAsync('allowPrivate bypasses DNS private-address rejection', async () => {
    let called = false;
    const lookup = async () => { called = true; return [{ address: '10.0.0.1', family: 4 }]; };
    const r = await isSafeDiscoveryTarget('https://private-provider.example/v1', true, lookup);
    assert.ok(r.safe);
    assert.equal(called, false);
  });

  // --- redirectTargetIsSafe ---

  test('redirect revalidation blocks dangerous targets', () => {
    assert.ok(!redirectTargetIsSafe('https://169.254.169.254'));
    assert.ok(!redirectTargetIsSafe('https://localhost'));
    assert.ok(!redirectTargetIsSafe('http://api.example.com'));
    assert.ok(redirectTargetIsSafe('https://api.example.com/new'));
  });

  // --- enforceMaxModelCount ---

  test('model count limit enforced', () => {
    const models = Array.from({ length: 1001 }, (_, i) => ({ id: `m${i}` }));
    assert.throws(() => enforceMaxModelCount(models, 1000), /max 1000/);
    const ok = enforceMaxModelCount(models.slice(0, 1000), 1000);
    assert.equal(ok.length, 1000);
  });

  // --- readBoundedResponseText ---

  function makeMockResponse(bodyText) {
    const encoder = new TextEncoder();
    const data = encoder.encode(bodyText);
    return {
      body: {
        getReader() {
          let first = true;
          return {
            async read() {
              if (first) {
                first = false;
                return { done: false, value: data };
              }
              return { done: true, value: undefined };
            },
            cancel() {},
          };
        },
      },
      text: async () => bodyText,
    };
  }

  await testAsync('response under limit passes', async () => {
    const res = makeMockResponse('hello');
    const text = await readBoundedResponseText(res, 1000);
    assert.equal(text, 'hello');
  });

  await testAsync('response over limit throws', async () => {
    const res = makeMockResponse('x'.repeat(1000));
    await assert.rejects(readBoundedResponseText(res, 100), /exceeds 100/);
  });

  // --- DISCOVERY_LIMITS constants ---

  test('DISCOVERY_LIMITS has expected defaults', () => {
    assert.equal(DISCOVERY_LIMITS.connectTimeoutMs, 10_000);
    assert.equal(DISCOVERY_LIMITS.responseTimeoutMs, 30_000);
    assert.equal(DISCOVERY_LIMITS.maxResponseBytes, 5 * 1024 * 1024);
    assert.equal(DISCOVERY_LIMITS.maxModelCount, 1_000);
    assert.equal(DISCOVERY_LIMITS.maxRedirects, 3);
  });

  console.log(`\nssrf-guard tests: ${passed} passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  } else {
    console.log('All ssrf-guard tests passed.');
  }
  console.log('ok - file:provider-discovery-ssrf-guard');
} catch (error) {
  console.error('not ok - provider-discovery-ssrf-guard-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// provider-adapter-registry-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs
  //
  // Provider adapter registry contracts:
  //   - registered providers resolve to their adapter (wire, quirks,
  //     OAuth defaults, subscription semantics)
  //   - unknown providers resolve to the generic OpenAI-compatible adapter
  //   - adding a plain OpenAI-compatible provider is configuration-only
  //     (no registry entry, no source change) and never regresses routing
  //   - subscription dispatchability fails closed for providers without a
  //     verified subscription backend
  //   - adapter-declared OAuth defaults feed the AIG_OAUTH_PROVIDERS merge






  let passed = 0;
  function test(name, fn) {
    try { fn(); passed++; console.log(`ok - ${name}`); }
    catch (e) { console.error(`FAIL - ${name}`); console.error(e?.stack || e); process.exitCode = 1; }
  }

  function envFor(nodes) {
    return {
      AIG_ACCESS_KEY_AIR: 'k',
      AIG_ACCESS_MODELS_AIR: '*',
      AIG_TIER1_NODES_01: JSON.stringify(nodes),
      AIG_TIER1_CREDENTIALS_01: JSON.stringify(Object.fromEntries(nodes.map((n) => [n.id, 'x']))),
    };
  }
  const rawNode = (id, provider) => ({
    id,
    provider,
    base_url: `https://${id}.example.com/v1`,
    models: { 'general-air': 'up-model' },
  });

  test('registered providers keep their exact native wire contracts', () => {
    assert.deepEqual(providerWire('openai'), { protocol: 'openai', surfaces: ['chat_completions', 'responses'] });
    assert.deepEqual(providerWire('anthropic'), { protocol: 'anthropic', surfaces: ['messages'] });
    assert.deepEqual(providerWire('google'), { protocol: 'openai', surfaces: ['chat_completions'] });
    assert.equal(getProviderAdapter('openai').id, 'openai');
    assert.equal(getProviderAdapter('anthropic').id, 'anthropic');
    assert.equal(getProviderAdapter('google').id, 'google');
  });

  test('provider names resolve case-insensitively and whitespace-tolerantly', () => {
    assert.equal(getProviderAdapter(' OpenAI ').id, 'openai');
    assert.equal(getProviderAdapter('Anthropic').id, 'anthropic');
  });

  test('unknown providers resolve to the generic OpenAI-compatible adapter', () => {
    const adapter = getProviderAdapter('xyz-provider');
    assert.equal(adapter.id, 'generic-openai');
    assert.deepEqual(adapter.wire, { protocol: 'openai', surfaces: ['chat_completions'] });
    assert.equal(adapter.streamUsage, true);
    assert.equal(adapter.subscription, undefined);
    assert.equal(adapter.oauth, undefined);
    assert.deepEqual(providerWire(''), { protocol: 'openai', surfaces: ['chat_completions'] });
  });

  test('scenario: a plain OpenAI-compatible provider is configuration-only', () => {
    const cfg = loadGatewayConfig(envFor([rawNode('xyz-01', 'xyz-provider')]));
    assert.equal(cfg.status, 'ready');
    assert.equal(cfg.nodes[0].provider, 'xyz-provider');
    assert.equal(cfg.nodes[0].protocol, 'openai');
    assert.deepEqual(cfg.nodes[0].surfaces, ['chat_completions']);
    // And it has no subscription semantics: a Tier 2 auth:"oauth" node for
    // it would fail closed at dispatch instead of half-shaping a request.
    assert.equal(getProviderAdapter('xyz-provider').subscription, undefined);
  });

  test('node config wire derivation matches the registry for every provider class', () => {
    for (const provider of ['openai', 'anthropic', 'google', 'xyz-provider']) {
      const cfg = loadGatewayConfig(envFor([rawNode(`${provider}-n`, provider)]));
      const node = cfg.nodes.find((n) => n.provider === provider);
      assert.equal(node.protocol, providerWire(provider).protocol, `${provider} protocol`);
      assert.deepEqual(node.surfaces, [...providerWire(provider).surfaces], `${provider} surfaces`);
    }
  });

  test('google shapes Code Assist subscription requests and declares a proprietary wire', () => {
    const adapter = getProviderAdapter('google').subscription;
    assert.ok(adapter, 'google must expose its subscription adapter');
    assert.ok(adapter.wire, 'google declares a proprietary subscription wire');
    assert.equal(typeof adapter.wire.streamToNative, 'function');
    assert.equal(typeof adapter.wire.objectToNative, 'function');
    const prepared = adapter.prepare({
      node: { id: 'g', tier: 'tier-2', provider: 'google', protocol: 'openai', surfaces: ['chat_completions'], baseUrl: 'https://cloudcode-pa.googleapis.com', credential: '', priority: 10, models: {}, auth: 'oauth' },
      credential: { ok: true, token: 't', accountId: null },
      request: new Request('https://gateway.example.com/v1/chat/completions', { method: 'POST' }),
      body: { model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }] },
      surface: 'chat_completions',
    });
    assert.ok(prepared, 'google shapes a valid chat request');
    assert.ok(prepared.upstreamUrl.includes('/v1internal:generateContent'), 'non-stream path');
    assert.ok(prepared.headers['user-agent'].startsWith('GeminiCLI/'), 'first-party Gemini CLI user agent');
    assert.equal(prepared.body.model, 'gemini-2.5-pro');
    assert.ok(prepared.body.request.contents);
    // Streaming request selects the streaming endpoint.
    const streamed = adapter.prepare({
      node: { id: 'g', tier: 'tier-2', provider: 'google', protocol: 'openai', surfaces: ['chat_completions'], baseUrl: 'https://cloudcode-pa.googleapis.com', credential: '', priority: 10, models: {}, auth: 'oauth' },
      credential: { ok: true, token: 't', accountId: null },
      request: new Request('https://gateway.example.com/v1/chat/completions', { method: 'POST' }),
      body: { model: 'gemini-2.5-pro', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      surface: 'chat_completions',
    });
    assert.ok(streamed.upstreamUrl.includes('/v1internal:streamGenerateContent'), 'stream path');
    assert.ok(streamed.upstreamUrl.includes('alt=sse'), 'sse query preserved');
    assert.equal(streamed.headers.accept, 'text/event-stream');
  });

  test('google subscription adapter refuses unsupported surfaces and bodies (fail-closed)', () => {
    const adapter = getProviderAdapter('google').subscription;
    const node = { id: 'g', tier: 'tier-2', provider: 'google', protocol: 'openai', surfaces: ['chat_completions'], baseUrl: 'https://cloudcode-pa.googleapis.com', credential: '', priority: 10, models: {}, auth: 'oauth' };
    const cred = { ok: true, token: 't', accountId: null };
    const request = new Request('https://gateway.example.com/v1/chat/completions', { method: 'POST' });
    // Responses surface: google Code Assist has one chat surface only.
    assert.equal(adapter.prepare({ node, credential: cred, request, body: { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, surface: 'responses' }), null);
    // Unsupported request body (no messages): fail-closed rotation.
    assert.equal(adapter.prepare({ node, credential: cred, request, body: { model: 'm' }, surface: 'chat_completions' }), null);
    // Unresolved credential: fail-closed rotation.
    assert.equal(adapter.prepare({ node, credential: { ok: false, reason: 'no_token' }, request, body: { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, surface: 'chat_completions' }), null);
  });

  test('openai and anthropic adapters keep their subscription semantics', () => {
    const codex = getProviderAdapter('openai').subscription;
    assert.ok(codex, 'openai must expose its codex subscription adapter');
    const claude = getProviderAdapter('anthropic').subscription;
    assert.ok(claude, 'anthropic must expose its claude subscription adapter');

    const codexPrepared = codex.prepare({
      node: { id: 'o', tier: 'tier-2', provider: 'openai', protocol: 'openai', surfaces: ['chat_completions', 'responses'], baseUrl: 'https://o.example.com', credential: '', priority: 10, models: {}, auth: 'oauth' },
      credential: { ok: true, token: 't', accountId: 'acct-1' },
      request: new Request('https://gateway.example.com/v1/responses', { method: 'POST' }),
      body: { model: 'm' },
      surface: 'responses',
    });
    assert.equal(codexPrepared.headers.Originator, 'codex-tui');
    assert.equal(codexPrepared.headers['chatgpt-account-id'], 'acct-1');
    assert.equal(codexPrepared.body.instructions, '');

    const claudePrepared = claude.prepare({
      node: { id: 'a', tier: 'tier-2', provider: 'anthropic', protocol: 'anthropic', surfaces: ['messages'], baseUrl: 'https://a.example.com', credential: '', priority: 10, models: {}, auth: 'oauth' },
      credential: { ok: true, token: 't', accountId: null },
      request: new Request('https://gateway.example.com/v1/messages', { method: 'POST', headers: { 'anthropic-beta': 'claude-code-20250219' } }),
      body: { model: 'm' },
      surface: 'messages',
    });
    assert.ok(claudePrepared.headers['anthropic-beta'].includes('oauth-2025-04-20'));
    assert.equal(claudePrepared.headers['x-app'], 'cli');
  });

  test('subscription adapters keep their quota-reset hint semantics', () => {
    const now = Date.now();
    const codexHint = getProviderAdapter('openai').subscription.quotaResetHint({
      status: 429,
      headers: new Headers({ 'x-codex-primary-used-window-reset': String(Math.floor(now / 1000) + 1800) }),
      body: '',
    }, now);
    assert.ok(codexHint !== null && Math.abs(codexHint - 1800 * 1000) < 5000,
      'codex window-reset header must produce a ~30m cooldown hint');

    const claudeHint = getProviderAdapter('anthropic').subscription.quotaResetHint({
      status: 429,
      headers: new Headers({ 'anthropic-ratelimit-requests-reset': '900' }),
      body: '',
    }, now);
    assert.equal(claudeHint, 900 * 1000);

    const googleRetryHint = getProviderAdapter('google').subscription.quotaResetHint({
      status: 429,
      headers: new Headers(),
      body: JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '42s' }] } }),
    }, now);
    assert.equal(googleRetryHint, 42 * 1000, 'google gRPC retryDelay produces a cooldown hint');

    const googleRetryAfterHint = getProviderAdapter('google').subscription.quotaResetHint({
      status: 429,
      headers: new Headers({ 'retry-after': '60' }),
      body: '',
    }, now);
    assert.equal(googleRetryAfterHint, 60 * 1000, 'google Retry-After header produces a cooldown hint');

    const noHint = getProviderAdapter('openai').subscription.quotaResetHint({
      status: 500, headers: new Headers(), body: '',
    }, now);
    assert.equal(noHint, null, 'quota hints only apply to rate-limit responses');
  });

  test('streamUsageEnabled keeps the operator override ladder', () => {
    const openaiNode = { provider: 'openai', protocol: 'openai', surfaces: ['chat_completions', 'responses'] };
    const anthropicNode = { provider: 'anthropic', protocol: 'anthropic', surfaces: ['messages'] };
    const genericNode = { provider: 'xyz-provider', protocol: 'openai', surfaces: ['chat_completions'] };

    assert.equal(streamUsageEnabled(openaiNode, {}), true, 'auto: openai chat streams ask for usage');
    assert.equal(streamUsageEnabled(anthropicNode, {}), false, 'auto: anthropic never asks');
    assert.equal(streamUsageEnabled(genericNode, {}), true, 'auto: generic openai-compatible asks');
    assert.equal(streamUsageEnabled(openaiNode, { AIG_USAGE_INCLUDE_MODE: 'off' }), false, 'global kill switch');
    assert.equal(streamUsageEnabled(anthropicNode, { AIG_USAGE_INCLUDE_MODE: 'on' }), true, 'global force switch');
    assert.equal(streamUsageEnabled(openaiNode, { AIG_USAGE_EXCLUDE_PROVIDERS: 'OpenAI' }), false, 'per-provider off-list');
    assert.equal(
      streamUsageEnabled({ provider: 'openai', protocol: 'openai', surfaces: ['responses'] }, {}),
      false,
      'a node whose surfaces lack chat_completions never asks',
    );
  });

  test('adapter-declared OAuth defaults feed loadOAuthProviders', () => {
    __resetOAuthProvidersCacheForTests();
    const defaults = loadOAuthProviders({});
    assert.equal(defaults.anthropic.authorizeUrl, 'https://claude.ai/oauth/authorize');
    assert.equal(defaults.anthropic.clientId, '9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    assert.equal(defaults.openai.clientId, 'app_EMoamEEZ73f0CkXaXp7hrann');
    assert.equal(defaults.openai.scope, 'openid email profile offline_access');
    assert.equal(defaults.google.clientSecret, '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');
    assert.equal(defaults.google.manualRedirectUrl, 'https://codeassist.google.com/authcode');
    assert.deepEqual(Object.keys(defaults).sort(), ['anthropic', 'google', 'openai']);
    assert.deepEqual(builtinOAuthProviderConfigs(), {
      openai: defaults.openai,
      anthropic: defaults.anthropic,
      google: defaults.google,
    });
  });

  test('built-in subscription endpoints let Tier 2 oauth nodes omit base_url', () => {
    assert.equal(getProviderAdapter('google').subscriptionEndpoint, 'https://cloudcode-pa.googleapis.com');
    assert.equal(getProviderAdapter('anthropic').subscriptionEndpoint, 'https://api.anthropic.com');
    assert.equal(getProviderAdapter('openai').subscriptionEndpoint, 'https://api.openai.com');
  });

  test('AIG_OAUTH_PROVIDERS still replaces defaults wholesale and adds custom providers', () => {
    __resetOAuthProvidersCacheForTests();
    const custom = {
      anthropic: {
        authorize_url: 'https://custom.example.com/authorize',
        token_url: 'https://custom.example.com/token',
        client_id: 'custom-client',
        scope: 'custom-scope',
      },
      'acme-sub': {
        authorize_url: 'https://acme.example.com/authorize',
        token_url: 'https://acme.example.com/token',
        client_id: 'acme-client',
        scope: 'acme-scope',
      },
    };
    const merged = loadOAuthProviders({ AIG_OAUTH_PROVIDERS: JSON.stringify(custom) });
    assert.equal(merged.anthropic.authorizeUrl, 'https://custom.example.com/authorize');
    assert.equal(merged.anthropic.clientId, 'custom-client');
    assert.equal(merged.openai.clientId, 'app_EMoamEEZ73f0CkXaXp7hrann', 'untouched providers keep their defaults');
    assert.equal(merged['acme-sub'].clientId, 'acme-client', 'operator-added providers enter the OAuth registry');
    assert.equal(getProviderAdapter('acme-sub').subscription, undefined, 'operator-added providers fail closed for subscription dispatch');
    __resetOAuthProvidersCacheForTests();
  });

  console.log(`[provider-adapter-registry-test] ${passed} checks passed`);
  console.log('ok - file:provider-adapter-registry');
} catch (error) {
  console.error('not ok - provider-adapter-registry-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}
