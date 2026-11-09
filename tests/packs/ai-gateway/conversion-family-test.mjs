// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Merged suite. Each section below was a standalone suite and keeps its own scope:
//   - conversion-result-test.mjs
//   - conversion-boundary-test.mjs
//   - google-subscription-wire-test.mjs

import { convertRequest, convertResult, convertStream } from './conversion-matrix-adapters.mjs';

// Call-shaped aliases for the matrix adapters, kept for the table-driven cases below.
const chat = (body) => convertRequest('openai_chat', 'anthropic', body);
const anthropic = (body) => convertRequest('anthropic', 'openai_chat', body);
const chatStream = (source) => convertStream('anthropic', 'openai_chat', source);
const anthropicStream = (source) => convertStream('openai_chat', 'anthropic', source);
import { ConversionError } from '#target/src/conversion/validation.ts';
import { getProviderAdapter } from '#target/src/providers/registry.ts';
import { loadGatewayConfig } from '#target/src/config/nodes.ts';
import { targetRoot } from '#kit/target.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

// ==========================================================================
// conversion-result-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs





  const schema = {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false,
  };

  // Plain text can cross the existing Chat <-> Messages bridge without a
  // material semantic downgrade.
  {
    const result = convertResult('anthropic', 'openai_chat', {
      model: 'Code-Max',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'hello' }],
    });
    assert.equal(result.fidelity, 'exact');
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.structuredOutput, undefined);
    assert.equal(result.body.messages[0].content, 'hello');
  }

  // Portable function-tool mapping is visible but is not classified as loss.
  {
    const result = convertResult('anthropic', 'openai_chat', {
      model: 'Code-Max',
      max_tokens: 128,
      tools: [
        {
          name: 'Read',
          input_schema: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'README.md' } }],
        },
      ],
    });
    assert.equal(result.fidelity, 'portable');
    assert.ok(result.diagnostics.some((d) => d.feature === 'function_tools' && d.action === 'mapped'));
    assert.ok(result.diagnostics.some((d) => d.feature === 'tool_calls' && d.action === 'mapped'));
  }

  // Claude Code controls/history that generic Chat cannot represent are
  // classified explicitly. Diagnostic values must remain fixed categories.
  {
    const privatePrompt = 'PRIVATE_PROMPT_MUST_NOT_APPEAR_IN_DIAGNOSTICS';
    const privateToolName = 'PRIVATE_TOOL_NAME_MUST_NOT_APPEAR_IN_DIAGNOSTICS';
    const result = convertResult('anthropic', 'openai_chat', {
      model: 'Code-Max',
      max_tokens: 256,
      thinking: { type: 'enabled', budget_tokens: 128 },
      context_management: { edits: [] },
      output_config: { effort: 'high' },
      tools: [
        {
          name: privateToolName,
          input_schema: { type: 'object' },
          strict: true,
        },
      ],
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      messages: [
        { role: 'user', content: privatePrompt },
        { role: 'system', content: 'updated instructions' },
        {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'private reasoning', signature: 'sig' }],
        },
      ],
    });
    assert.equal(result.fidelity, 'degraded');
    const features = new Set(result.diagnostics.map((d) => d.feature));
    for (const feature of [
      'thinking_control',
      'context_management',
      'effort_control',
      'tool_hints',
      'parallel_tool_control',
      'mid_conversation_system',
      'thinking_history',
    ])
      assert.ok(features.has(feature), `missing diagnostic feature ${feature}`);
    const diagnosticJson = JSON.stringify(result.diagnostics);
    assert.equal(diagnosticJson.includes(privatePrompt), false);
    assert.equal(diagnosticJson.includes(privateToolName), false);
    assert.equal(diagnosticJson.includes('private reasoning'), false);
  }

  // Anthropic structured output keeps the v1.3.1 prompt path for an unknown
  // OpenAI-compatible target.
  {
    const result = convertResult('anthropic', 'openai_chat', {
      model: 'Code-Max',
      max_tokens: 256,
      output_config: { format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: 'answer' }],
    });
    assert.equal(result.fidelity, 'degraded');
    assert.equal(result.structuredOutput.strategy, 'prompt');
    assert.equal(
      result.diagnostics.some((d) => d.feature === 'structured_output' && d.action === 'emulated' && d.strategy === 'prompt'),
      true,
    );
    assert.equal(result.body.messages[0].role, 'system');
    assert.match(result.body.messages[0].content, /return only valid JSON/i);
    assert.ok(result.body.messages[0].content.includes(JSON.stringify(schema)));
    assert.equal(Object.hasOwn(result.body, 'response_format'), false);
  }

  // OpenAI -> Anthropic keeps the existing 1024 default observable as semantic
  // degradation rather than silently hiding the default policy.
  {
    const result = convertResult('openai_chat', 'anthropic', {
      model: 'gpt-compatible',
      messages: [{ role: 'user', content: 'hello' }],
    });
    assert.equal(result.fidelity, 'degraded');
    assert.equal(result.body.max_tokens, 1024);
    assert.ok(result.diagnostics.some((d) => d.feature === 'max_tokens' && d.action === 'defaulted'));
  }

  // OpenAI response_format is now accepted by the result wrapper. Unknown
  // Anthropic-compatible targets use prompt emulation, preserving portability.
  {
    const result = convertResult('openai_chat', 'anthropic', {
      model: 'gpt-compatible',
      max_tokens: 256,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer', schema, strict: true },
      },
      messages: [{ role: 'user', content: 'answer' }],
    });
    assert.equal(result.fidelity, 'degraded');
    assert.equal(result.structuredOutput.strategy, 'prompt');
    assert.equal(typeof result.body.system, 'string');
    assert.match(result.body.system, /return only valid JSON/i);
    assert.ok(result.body.system.includes(JSON.stringify(schema)));
    assert.equal(Object.hasOwn(result.body, 'output_config'), false);
  }

  // strict:false must not be silently strengthened by a native Anthropic schema.
  {
    const result = convertResult('openai_chat', 'anthropic', 
      {
        model: 'gpt-compatible',
        max_tokens: 256,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'answer', schema, strict: false },
        },
        messages: [{ role: 'user', content: 'answer' }],
      },
    );
    assert.equal(result.structuredOutput.strategy, 'prompt');
    assert.equal(result.fidelity, 'degraded');
  }

  assert.throws(
    () =>
      convertResult('openai_chat', 'anthropic', {
        model: 'gpt-compatible',
        max_tokens: 256,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'answer', schema: 'invalid' },
        },
        messages: [{ role: 'user', content: 'answer' }],
      }),
    (error) => error instanceof ConversionError && /response_format\.json_schema\.schema must be an object/.test(error.message),
  );

  // Schema data is allowed in the converted outbound request but never in the
  // diagnostics channel that fallback.ts logs.
  {
    const privateSchema = {
      type: 'object',
      properties: { PRIVATE_SCHEMA_FIELD_DO_NOT_LOG: { type: 'string' } },
    };
    const result = convertResult('anthropic', 'openai_chat', {
      model: 'Code-Max',
      max_tokens: 256,
      output_config: { format: { type: 'json_schema', schema: privateSchema } },
      messages: [{ role: 'user', content: 'PRIVATE_BODY_DO_NOT_LOG' }],
    });
    const diagnosticJson = JSON.stringify(result.diagnostics);
    assert.equal(diagnosticJson.includes('PRIVATE_SCHEMA_FIELD_DO_NOT_LOG'), false);
    assert.equal(diagnosticJson.includes('PRIVATE_BODY_DO_NOT_LOG'), false);
  }

  console.log('conversion result / fidelity contract passed');
  console.log('ok - file:conversion-result');
} catch (error) {
  console.error('not ok - conversion-result-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// conversion-boundary-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs







  const message = { role: 'user', content: 'hello' };
  for (const [name, convert, base] of [
    ['Chat', chat, { model: 'm', messages: [message] }],
    ['Messages', anthropic, { model: 'm', max_tokens: 20, messages: [message] }],
  ]) {
    for (const [field, value] of [
      ['reasoning', { effort: 'high' }],
      ['unknown_option', true],
    ]) {
      test(`${name} rejects unsupported ${field} instead of dropping semantics`, () => {
        assert.throws(() => convert({ ...base, [field]: value }), /conversion_not_supported/);
      });
    }
  }
  // `metadata` is an Anthropic attribution field with no OpenAI-equivalent
  // semantic. The OpenAI client converter (Chat) rejects it because
  // it is not part of their request schema. The Anthropic -> OpenAI Messages
  // converter must ACCEPT it and safely drop it, because a legal Anthropic
  // request carrying metadata must still be able to fall back to OpenAI.
  test('Chat rejects unsupported metadata instead of dropping semantics', () => {
    assert.throws(() => convertRequest('openai_chat', 'anthropic', { model: 'm', messages: [message], metadata: { user_id: 'x' } }), /conversion_not_supported/);
  });
  test('Messages accepts metadata (safe drop) instead of blocking fallback', () => {
    const out = convertRequest('anthropic', 'openai_chat', { model: 'm', max_tokens: 20, metadata: { user_id: 'x' }, messages: [message] });
    assert.equal(out.model, 'm');
    assert.equal(out.messages[0].role, 'user');
    assert.equal(out.metadata, undefined, 'metadata is dropped, not forwarded');
  });
  test('Chat rejects non-equivalent sampling, strict tools, and invalid JSON arguments', () => {
    assert.throws(() => convertRequest('openai_chat', 'anthropic', { model: 'm', messages: [message], temperature: 1.5 }), /conversion_not_supported/);
    assert.throws(
      () => convertRequest('openai_chat', 'anthropic', { model: 'm', messages: [message], tools: [{ type: 'function', function: { name: 'f', strict: true } }] }),
      /conversion_not_supported/,
    );
    for (const argumentsValue of ['{broken', '[]', 'null', '1']) {
      assert.throws(
        () =>
          convertRequest('openai_chat', 'anthropic', {
            model: 'm',
            messages: [{ role: 'assistant', tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: argumentsValue } }] }],
          }),
        /conversion_not_supported/,
      );
    }
  });
  test('Messages preserves text after tool_use and emits parallel tool results at top level', () => {
    const out = convertRequest('anthropic', 'openai_chat', {
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'before' },
            { type: 'tool_use', id: 'c', name: 'f', input: {} },
            { type: 'text', text: 'after' },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'c', content: 'one' },
            { type: 'tool_result', tool_use_id: 'd', content: 'two' },
          ],
        },
      ],
    });
    assert.equal(out.messages[0].content, 'beforeafter');
    assert.deepEqual(
      out.messages.slice(1).map((x) => [x.role, x.tool_call_id, x.content]),
      [
        ['tool', 'c', 'one'],
        ['tool', 'd', 'two'],
      ],
    );
  });

  const encode = (event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`;
  const source = (events) =>
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(events.map(encode).join('')));
        c.close();
      },
    });
  const read = (stream) => new Response(stream).text();
  const eventsFrom = (text) =>
    text
      .split('\n')
      .filter((x) => x.startsWith('data: {'))
      .map((x) => JSON.parse(x.slice(6)));
  const textBlock = (index, text) => [
    { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index },
  ];
  const toolBlock = (index) => [
    { type: 'content_block_start', index, content_block: { type: 'tool_use', id: 'call', name: 'f', input: {} } },
    { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{"x":1}' } },
    { type: 'content_block_stop', index },
  ];
  const stop = (reason) => [
    { type: 'message_delta', delta: { stop_reason: reason }, usage: { input_tokens: 2, output_tokens: 3 } },
    { type: 'message_stop' },
  ];

  test('Chat tool index starts at zero after text and usage does not duplicate finish', async () => {
    const text = await read(convertStream('anthropic', 'openai_chat', source([...textBlock(0, 'a'), ...toolBlock(1), ...stop('tool_use'), ...stop('tool_use')])));
    const events = eventsFrom(text);
    assert.deepEqual(
      events
        .flatMap((e) => e.choices ?? [])
        .flatMap((c) => c.delta?.tool_calls ?? [])
        .map((t) => t.index),
      [0, 0],
    );
    assert.equal(events.filter((e) => e.choices?.[0]?.finish_reason).length, 1);
    assert.deepEqual(events.find((e) => e.usage).choices, []);
    assert.equal(text.match(/\[DONE\]/g).length, 1);
  });

  for (const [name, convert, initial, terminal] of [
    ['Chat', chatStream, textBlock(0, 'a'), { type: 'message_stop' }],
    ['Messages', anthropicStream, [{ choices: [{ delta: { content: 'a' } }] }], '[DONE]'],
  ]) {
    test(`${name} rejects truncated and malformed streams`, async () => {
      await assert.rejects(read(convert(source(initial))), /interrupted/);
      await assert.rejects(read(convert(source([...initial, 'not-json', terminal]))), /Malformed/);
    });
    test(`${name} upstream error cannot be followed by success`, async () => {
      await assert.rejects(
        read(convert(source([...initial, { type: 'error', error: { message: 'private upstream detail' } }, terminal]))),
        /Upstream stream error/,
      );
    });
    test(`${name} client cancellation reaches a pending upstream read`, async () => {
      let cancelled = false;
      const upstream = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(initial.map(encode).join('')));
        },
        cancel() {
          cancelled = true;
        },
      });
      const reader = convert(upstream).getReader();
      await reader.read();
      await reader.cancel('client cancelled');
      assert.equal(cancelled, true);
    });
  }
  console.log('ok - file:conversion-boundary');
} catch (error) {
  console.error('not ok - conversion-boundary-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}

// ==========================================================================
// google-static-token-wire-test.mjs (replaces retired Code Assist subscription)
// ==========================================================================
try {
  // The proprietary Google Code Assist OAuth translator was intentionally
  // removed. Ordinary Google API Token capacity must retain its declared
  // OpenAI-compatible protocol and cannot claim subscriber wire semantics.
  const adapter = getProviderAdapter('google');
  assert.deepEqual(adapter.wire, { protocol: 'openai', surfaces: ['chat_completions'] });
  assert.equal(adapter.subscription, undefined, 'Code Assist subscription adapter must not return');
  assert.equal(adapter.oauth, undefined, 'member OAuth defaults must not return');
  assert.equal(adapter.subscriptionEndpoint, undefined);

  const retired = join(targetRoot, 'src/subscription/google-wire.ts');
  assert.equal(existsSync(retired), false, 'retired Code Assist wire must not be restored');

  const staticEnv = {
    AIG_ACCESS_KEY_AIR: 'test-client-key',
    AIG_TIER2_NODES_01: JSON.stringify([{
      id: 'google-static',
      provider: 'google',
      base_url: 'https://google.example.invalid/v1',
      models: { 'Code-Pro': 'gemini-upstream' },
    }]),
  };
  const normal = loadGatewayConfig(staticEnv);
  assert.equal(normal.status, 'ready');
  assert.equal(normal.tiers[2][0].protocol, 'openai');
  assert.deepEqual(normal.tiers[2][0].surfaces, ['chat_completions']);
  assert.equal(normal.tiers[2][0].credential, '', 'public Gateway must not receive Google API Token');

  const oldOAuth = loadGatewayConfig({
    ...staticEnv,
    AIG_TIER2_NODES_01: JSON.stringify([{
      id: 'google-member',
      provider: 'google',
      models: { 'Code-Pro': 'gemini-upstream' },
      auth: 'oauth',
    }]),
  });
  assert.equal(oldOAuth.status, 'invalid', 'Google member OAuth may not masquerade as API Token');
  assert.equal(oldOAuth.nodesUsable, 0);

  console.log('ok - file:google-static-token-wire');
} catch (error) {
  console.error('not ok - google-static-token-wire-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}
