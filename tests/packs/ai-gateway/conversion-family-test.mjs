// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Fongap Labs
//
// Merged suite. Each section below was a standalone suite and keeps its own scope:
//   - conversion-result-test.mjs
//   - conversion-boundary-test.mjs
//   - google-subscription-wire-test.mjs

import { createOpenAIChatStreamFromAnthropic as chatStream } from '#target/src/conversion/anthropic-stream-to-openai-chat.ts';
import { convertAnthropicToOpenAIRequest as anthropic } from '#target/src/conversion/anthropic-to-openai.ts';
import { convertOpenAIChatRequestToAnthropic as chat } from '#target/src/conversion/openai-chat-request-to-anthropic.ts';
import { SYNTHETIC_STRUCTURED_OUTPUT_TOOL, convertAnthropicToOpenAIResult, convertOpenAIChatToAnthropicResult, selectStructuredOutputStrategy } from '#target/src/conversion/result.ts';
import { createAnthropicStreamFromOpenAI as anthropicStream } from '#target/src/conversion/stream-converter.ts';
import { ConversionError } from '#target/src/conversion/validation.ts';
import { GEMINI_CLI_USER_AGENT, GEMINI_CODE_ASSIST_ENDPOINT, codeAssistObjectToOpenAIChat, createOpenAIChatStreamFromCodeAssist, openAIChatToCodeAssistEnvelope } from '#target/src/subscription/google-wire.ts';
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
    const result = convertAnthropicToOpenAIResult({
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
    const result = convertAnthropicToOpenAIResult({
      model: 'Code-Max',
      max_tokens: 128,
      tools: [{
        name: 'Read',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      }],
      messages: [{
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { path: 'README.md' } }],
      }],
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
    const result = convertAnthropicToOpenAIResult({
      model: 'Code-Max',
      max_tokens: 256,
      thinking: { type: 'enabled', budget_tokens: 128 },
      context_management: { edits: [] },
      output_config: { effort: 'high' },
      tools: [{
        name: privateToolName,
        input_schema: { type: 'object' },
        strict: true,
      }],
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
      'thinking_control', 'context_management', 'effort_control', 'tool_hints',
      'parallel_tool_control', 'mid_conversation_system', 'thinking_history',
    ]) assert.ok(features.has(feature), `missing diagnostic feature ${feature}`);
    const diagnosticJson = JSON.stringify(result.diagnostics);
    assert.equal(diagnosticJson.includes(privatePrompt), false);
    assert.equal(diagnosticJson.includes(privateToolName), false);
    assert.equal(diagnosticJson.includes('private reasoning'), false);
  }

  // Strategy order is explicit and conservative. Tool is not considered usable
  // until both request-side support and a response-side unwrap adapter are known.
  assert.equal(selectStructuredOutputStrategy({}), 'prompt');
  assert.equal(selectStructuredOutputStrategy({ syntheticToolOutput: true }), 'prompt');
  assert.equal(selectStructuredOutputStrategy({
    syntheticToolOutput: true,
    syntheticToolResultAdapter: true,
  }), 'tool');
  assert.equal(selectStructuredOutputStrategy({
    nativeJsonSchema: true,
    syntheticToolOutput: true,
    syntheticToolResultAdapter: true,
  }), 'native');

  // Anthropic structured output keeps the v1.3.1 prompt path for an unknown
  // OpenAI-compatible target.
  {
    const result = convertAnthropicToOpenAIResult({
      model: 'Code-Max',
      max_tokens: 256,
      output_config: { format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: 'answer' }],
    });
    assert.equal(result.fidelity, 'degraded');
    assert.equal(result.structuredOutput.strategy, 'prompt');
    assert.equal(result.diagnostics.some((d) =>
      d.feature === 'structured_output' && d.action === 'emulated' && d.strategy === 'prompt'), true);
    assert.equal(result.body.messages[0].role, 'system');
    assert.match(result.body.messages[0].content, /return only valid JSON/i);
    assert.ok(result.body.messages[0].content.includes(JSON.stringify(schema)));
    assert.equal(Object.hasOwn(result.body, 'response_format'), false);
  }

  // A caller with positive native capability evidence can request native OpenAI
  // JSON Schema without also retaining the prompt emulation.
  {
    const result = convertAnthropicToOpenAIResult({
      model: 'Code-Max',
      max_tokens: 256,
      output_config: { format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: 'answer' }],
    }, { structuredOutput: { nativeJsonSchema: true } });
    assert.equal(result.fidelity, 'portable');
    assert.equal(result.structuredOutput.strategy, 'native');
    assert.equal(result.body.response_format.type, 'json_schema');
    assert.deepEqual(result.body.response_format.json_schema.schema, schema);
    assert.equal(result.body.messages.some((m) =>
      typeof m.content === 'string' && /return only valid JSON/i.test(m.content)), false);
  }

  // Synthetic-tool strategy is modeled but requires the response adapter proof.
  // It is also never forced over an existing client tool contract.
  {
    const toolResult = convertAnthropicToOpenAIResult({
      model: 'Code-Max',
      max_tokens: 256,
      output_config: { format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: 'answer' }],
    }, {
      structuredOutput: {
        syntheticToolOutput: true,
        syntheticToolResultAdapter: true,
      },
    });
    assert.equal(toolResult.structuredOutput.strategy, 'tool');
    assert.equal(toolResult.fidelity, 'degraded');
    assert.equal(toolResult.body.tools[0].function.name, SYNTHETIC_STRUCTURED_OUTPUT_TOOL);
    assert.equal(toolResult.body.tool_choice.function.name, SYNTHETIC_STRUCTURED_OUTPUT_TOOL);

    const conflict = convertAnthropicToOpenAIResult({
      model: 'Code-Max',
      max_tokens: 256,
      output_config: { format: { type: 'json_schema', schema } },
      tools: [{ name: 'Read', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'answer' }],
    }, {
      structuredOutput: {
        syntheticToolOutput: true,
        syntheticToolResultAdapter: true,
      },
    });
    assert.equal(conflict.structuredOutput.strategy, 'prompt');
    assert.equal(conflict.body.tools.some((t) => t.function?.name === SYNTHETIC_STRUCTURED_OUTPUT_TOOL), false);
  }

  // OpenAI -> Anthropic keeps the existing 1024 default observable as semantic
  // degradation rather than silently hiding the default policy.
  {
    const result = convertOpenAIChatToAnthropicResult({
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
    const result = convertOpenAIChatToAnthropicResult({
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

  // Positive capability evidence enables native Anthropic output_config.format.
  {
    const result = convertOpenAIChatToAnthropicResult({
      model: 'gpt-compatible',
      max_tokens: 256,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer', schema, strict: true },
      },
      messages: [{ role: 'user', content: 'answer' }],
    }, { structuredOutput: { nativeJsonSchema: true } });
    assert.equal(result.fidelity, 'portable');
    assert.equal(result.structuredOutput.strategy, 'native');
    assert.deepEqual(result.body.output_config, { format: { type: 'json_schema', schema } });
    assert.equal(result.body.system, undefined);
  }

  // strict:false must not be silently strengthened by a native Anthropic schema.
  {
    const result = convertOpenAIChatToAnthropicResult({
      model: 'gpt-compatible',
      max_tokens: 256,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer', schema, strict: false },
      },
      messages: [{ role: 'user', content: 'answer' }],
    }, { structuredOutput: { nativeJsonSchema: true } });
    assert.equal(result.structuredOutput.strategy, 'prompt');
    assert.equal(result.fidelity, 'degraded');
  }

  assert.throws(
    () => convertOpenAIChatToAnthropicResult({
      model: 'gpt-compatible',
      max_tokens: 256,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer', schema: 'invalid' },
      },
      messages: [{ role: 'user', content: 'answer' }],
    }),
    (error) => error instanceof ConversionError
      && /response_format\.json_schema\.schema must be an object/.test(error.message),
  );

  // Schema data is allowed in the converted outbound request but never in the
  // diagnostics channel that fallback.ts logs.
  {
    const privateSchema = {
      type: 'object',
      properties: { PRIVATE_SCHEMA_FIELD_DO_NOT_LOG: { type: 'string' } },
    };
    const result = convertAnthropicToOpenAIResult({
      model: 'Code-Max',
      max_tokens: 256,
      output_config: { format: { type: 'json_schema', schema: privateSchema } },
      messages: [{ role: 'user', content: 'PRIVATE_BODY_DO_NOT_LOG' }],
    });
    const diagnosticJson = JSON.stringify(result.diagnostics);
    assert.equal(diagnosticJson.includes('PRIVATE_SCHEMA_FIELD_DO_NOT_LOG'), false);
    assert.equal(diagnosticJson.includes('PRIVATE_BODY_DO_NOT_LOG'), false);
  }

  console.log('conversion result / fidelity / structured-output strategy contract passed');
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
    for (const [field, value] of [['reasoning', { effort: 'high' }], ['unknown_option', true]]) {
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
    assert.throws(() => chat({ model: 'm', messages: [message], metadata: { user_id: 'x' } }), /conversion_not_supported/);
  });
  test('Messages accepts metadata (safe drop) instead of blocking fallback', () => {
    const out = anthropic({ model: 'm', max_tokens: 20, metadata: { user_id: 'x' }, messages: [message] });
    assert.equal(out.model, 'm');
    assert.equal(out.messages[0].role, 'user');
    assert.equal(out.metadata, undefined, 'metadata is dropped, not forwarded');
  });
  test('Chat rejects non-equivalent sampling, strict tools, and invalid JSON arguments', () => {
    assert.throws(() => chat({ model: 'm', messages: [message], temperature: 1.5 }), /conversion_not_supported/);
    assert.throws(() => chat({ model: 'm', messages: [message], tools: [{ type: 'function', function: { name: 'f', strict: true } }] }), /conversion_not_supported/);
    for (const argumentsValue of ['{broken', '[]', 'null', '1']) {
      assert.throws(() => chat({ model: 'm', messages: [{ role: 'assistant', tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: argumentsValue } }] }] }), /conversion_not_supported/);
    }
  });
  test('Messages preserves text after tool_use and emits parallel tool results at top level', () => {
    const out = anthropic({ model: 'm', messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'before' }, { type: 'tool_use', id: 'c', name: 'f', input: {} }, { type: 'text', text: 'after' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: 'one' }, { type: 'tool_result', tool_use_id: 'd', content: 'two' }] },
    ] });
    assert.equal(out.messages[0].content, 'beforeafter');
    assert.deepEqual(out.messages.slice(1).map(x => [x.role, x.tool_call_id, x.content]), [['tool', 'c', 'one'], ['tool', 'd', 'two']]);
  });

  const encode = event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`;
  const source = events => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(events.map(encode).join(''))); c.close(); } });
  const read = stream => new Response(stream).text();
  const eventsFrom = text => text.split('\n').filter(x => x.startsWith('data: {')).map(x => JSON.parse(x.slice(6)));
  const textBlock = (index, text) => [
    { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index },
  ];
  const toolBlock = index => [
    { type: 'content_block_start', index, content_block: { type: 'tool_use', id: 'call', name: 'f', input: {} } },
    { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{"x":1}' } },
    { type: 'content_block_stop', index },
  ];
  const stop = reason => [{ type: 'message_delta', delta: { stop_reason: reason }, usage: { input_tokens: 2, output_tokens: 3 } }, { type: 'message_stop' }];

  test('Chat tool index starts at zero after text and usage does not duplicate finish', async () => {
    const text = await read(chatStream(source([...textBlock(0, 'a'), ...toolBlock(1), ...stop('tool_use'), ...stop('tool_use')])));
    const events = eventsFrom(text);
    assert.deepEqual(events.flatMap(e => e.choices ?? []).flatMap(c => c.delta?.tool_calls ?? []).map(t => t.index), [0, 0]);
    assert.equal(events.filter(e => e.choices?.[0]?.finish_reason).length, 1);
    assert.deepEqual(events.find(e => e.usage).choices, []);
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
      await assert.rejects(read(convert(source([...initial, { type: 'error', error: { message: 'private upstream detail' } }, terminal]))), /Upstream stream error/);
    });
    test(`${name} client cancellation reaches a pending upstream read`, async () => {
      let cancelled = false;
      const upstream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(initial.map(encode).join(''))); }, cancel() { cancelled = true; } });
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
// google-subscription-wire-test.mjs
// ==========================================================================
try {
  // SPDX-License-Identifier: MIT
  // Copyright (c) 2026 Fongap Labs
  //
  // Pure unit tests for the Google Code Assist subscription wire conversion
  // (src/subscription/google-wire.ts): request envelope building, non-streaming
  // object conversion, and streaming SSE conversion. These exercise the
  // converter in isolation; the end-to-end dispatch path is covered by
  // tests/oauth-subscription-test.mjs.




  let passed = 0;
  let failed = 0;
  function test(name, fn) {
    return Promise.resolve()
      .then(() => fn())
      .then(() => { passed++; console.log(`ok - ${name}`); })
      .catch((e) => { failed++; console.error(`FAIL: ${name}`); console.error(e?.stack || e); process.exitCode = 1; });
  }

  function envelope(body) {
    return openAIChatToCodeAssistEnvelope(body);
  }

  function sse(...events) {
    return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  }

  async function readStream(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let out = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    return out;
  }

  // ---- Request envelope -------------------------------------------------------

  await test('basic chat builds contents + model + no system', () => {
    const r = envelope({ model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }] });
    assert.ok(r);
    assert.equal(r.envelope.model, 'gemini-2.5-pro');
    assert.deepEqual(r.envelope.request.contents, [{ role: 'user', parts: [{ text: 'hi' }] }]);
    assert.equal(r.envelope.request.systemInstruction, undefined);
    assert.equal(r.streaming, false);
  });

  await test('system + developer messages collect into systemInstruction', () => {
    const r = envelope({
      model: 'm', messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hello' },
        { role: 'developer', content: [{ type: 'text', text: 'extra' }] },
      ],
    });
    assert.deepEqual(r.envelope.request.systemInstruction, { parts: [{ text: 'be brief' }, { text: 'extra' }] });
  });

  await test('assistant tool_calls map to functionCall parts and register id->name', () => {
    const r = envelope({
      model: 'm', messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"sf"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '{"temp": 60}' },
      ],
    });
    const contents = r.envelope.request.contents;
    assert.equal(contents[1].role, 'model');
    assert.deepEqual(contents[1].parts, [{ functionCall: { name: 'get_weather', args: { city: 'sf' } } }]);
    assert.equal(contents[2].role, 'user');
    assert.equal(contents[2].parts[0].functionResponse.name, 'get_weather');
    assert.deepEqual(contents[2].parts[0].functionResponse.response, { temp: 60 });
  });

  await test('tool response with non-JSON content is wrapped as {output}', () => {
    const r = envelope({
      model: 'm', messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fn', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'plain text result' },
      ],
    });
    assert.deepEqual(r.envelope.request.contents[2].parts[0].functionResponse.response, { output: 'plain text result' });
  });

  await test('tools + tool_choice map to functionDeclarations and toolConfig', () => {
    const r = envelope({
      model: 'm',
      messages: [{ role: 'user', content: 'use a tool' }],
      tools: [{ type: 'function', function: { name: 'search', description: 'd', parameters: { type: 'object' } } }],
      tool_choice: { type: 'function', function: { name: 'search' } },
    });
    assert.deepEqual(r.envelope.request.tools, [{ functionDeclarations: [{ name: 'search', description: 'd', parameters: { type: 'object' } }] }]);
    assert.deepEqual(r.envelope.request.toolConfig, { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['search'] } });
  });

  await test('generation config maps OpenAI fields to Gemini names', () => {
    const r = envelope({
      model: 'm', messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 128, temperature: 0.7, top_p: 0.9, stop: ['x', 'y'], seed: 42,
      response_format: { type: 'json_object' },
    });
    assert.deepEqual(r.envelope.request.generationConfig, {
      maxOutputTokens: 128, temperature: 0.7, topP: 0.9, stopSequences: ['x', 'y'], seed: 42,
      responseMimeType: 'application/json',
    });
  });

  await test('stream flag selects streaming endpoint semantics', () => {
    assert.equal(envelope({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }).streaming, true);
    assert.equal(envelope({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }).streaming, false);
  });

  await test('image data-url part becomes inlineData', () => {
    const r = envelope({
      model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0K' } }] }],
    });
    assert.deepEqual(r.envelope.request.contents[0].parts[1], { inlineData: { mimeType: 'image/png', data: 'iVBORw0K' } });
  });

  await test('refusal: no messages -> null', () => {
    assert.equal(envelope({ model: 'm' }), null);
  });

  await test('refusal: unsupported user part type -> null', () => {
    assert.equal(envelope({ model: 'm', messages: [{ role: 'user', content: [{ type: 'audio', audio: 'x' }] }] }), null);
  });

  await test('refusal: tool message without preceding tool_call id -> null', () => {
    assert.equal(envelope({ model: 'm', messages: [{ role: 'tool', tool_call_id: 'ghost', content: '{}' }] }), null);
  });

  await test('refusal: malformed tool_call arguments -> null', () => {
    assert.equal(envelope({
      model: 'm', messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fn', arguments: '{bad json' } }] },
      ],
    }), null);
  });

  await test('refusal: non-function tool type -> null', () => {
    assert.equal(envelope({
      model: 'm', messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'web_search', web_search: {} }],
    }), null);
  });

  // ---- Non-streaming object conversion ---------------------------------------

  await test('object: text response maps to chat completion + usage', () => {
    const data = {
      candidates: [{ content: { parts: [{ text: 'Hello there' }], role: 'model' }, finishReason: 'STOP', index: 0 }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 5, totalTokenCount: 8, cachedContentTokenCount: 1 },
      modelVersion: 'gemini-2.5-pro',
    };
    const out = codeAssistObjectToOpenAIChat(data);
    assert.equal(out.object, 'chat.completion');
    assert.equal(out.choices[0].message.content, 'Hello there');
    assert.equal(out.choices[0].finish_reason, 'stop');
    assert.deepEqual(out.usage, { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8, prompt_tokens_details: { cached_tokens: 1 } });
    assert.equal(out.model, 'gemini-2.5-pro');
  });

  await test('object: function call maps to tool_calls', () => {
    const out = codeAssistObjectToOpenAIChat({
      candidates: [{ content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'sf' } } }], role: 'model' }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
    });
    assert.equal(out.choices[0].message.content, null);
    assert.equal(out.choices[0].message.tool_calls[0].function.name, 'get_weather');
    assert.equal(out.choices[0].message.tool_calls[0].function.arguments, '{"city":"sf"}');
    assert.equal(out.choices[0].message.tool_calls[0].type, 'function');
  });

  await test('object: MAX_TOKENS -> length, SAFETY -> content_filter', () => {
    assert.equal(codeAssistObjectToOpenAIChat({ candidates: [{ content: { parts: [{ text: 'cut' }], role: 'model' }, finishReason: 'MAX_TOKENS' }] }).choices[0].finish_reason, 'length');
    assert.equal(codeAssistObjectToOpenAIChat({ candidates: [{ content: { parts: [{ text: 'blocked' }], role: 'model' }, finishReason: 'SAFETY' }] }).choices[0].finish_reason, 'content_filter');
  });

  await test('object: no candidates / no meaningful output -> null', () => {
    assert.equal(codeAssistObjectToOpenAIChat({ candidates: [] }), null);
    assert.equal(codeAssistObjectToOpenAIChat({ candidates: [{ content: { parts: [], role: 'model' }, finishReason: 'STOP' }] }), null);
    assert.equal(codeAssistObjectToOpenAIChat('not an object'), null);
  });

  // ---- Streaming conversion ---------------------------------------------------

  await test('stream: text deltas + finish + usage + [DONE]', async () => {
    const input = new Response(sse(
      { candidates: [{ content: { parts: [{ text: 'Hel' }], role: 'model' }, index: 0 }] },
      { candidates: [{ content: { parts: [{ text: 'lo' }], role: 'model' }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 } },
    )).body;
    const out = await readStream(createOpenAIChatStreamFromCodeAssist(input, { messageId: 'm', model: 'gemini-2.5-pro' }));
    const chunks = out.split('\n\n').filter(Boolean).map((c) => c.replace(/^data: /, ''));
    assert.ok(chunks[0].includes('"delta":{"role":"assistant"}'), 'role header first');
    assert.ok(chunks.some((c) => c.includes('"delta":{"content":"Hel"}')), 'first text delta');
    assert.ok(chunks.some((c) => c.includes('"delta":{"content":"lo"}')), 'second text delta');
    assert.ok(chunks.some((c) => c.includes('"finish_reason":"stop"')), 'finish chunk');
    assert.ok(chunks.some((c) => c.includes('"usage"') && c.includes('"total_tokens":3')), 'usage chunk');
    assert.equal(chunks[chunks.length - 1], '[DONE]', '[DONE] terminal');
  });

  await test('stream: function call delta carries id/name/arguments', async () => {
    const input = new Response(sse(
      { candidates: [{ content: { parts: [{ functionCall: { name: 'get_weather', args: { city: 'sf' } } }], role: 'model' }, finishReason: 'STOP' }] },
    )).body;
    const out = await readStream(createOpenAIChatStreamFromCodeAssist(input, { messageId: 'm', model: 'm' }));
    const toolChunk = out.split('\n\n').map((c) => c.replace(/^data: /, '')).find((c) => c.includes('tool_calls'));
    assert.ok(toolChunk, 'tool_call delta present');
    const parsed = JSON.parse(toolChunk);
    assert.equal(parsed.choices[0].delta.tool_calls[0].function.name, 'get_weather');
    assert.equal(parsed.choices[0].delta.tool_calls[0].function.arguments, '{"city":"sf"}');
    assert.equal(parsed.choices[0].delta.tool_calls[0].type, 'function');
  });

  await test('stream: clean upstream end finalizes even without finishReason', async () => {
    const input = new Response(sse({ candidates: [{ content: { parts: [{ text: 'partial' }], role: 'model' } }] })).body;
    const out = await readStream(createOpenAIChatStreamFromCodeAssist(input, { messageId: 'm', model: 'm' }));
    assert.ok(out.includes('"finish_reason":"stop"'), 'defaults to stop on close');
    assert.ok(out.endsWith('data: [DONE]\n\n'), '[DONE] emitted on clean close');
  });

  await test('stream: no-text response ends with finish stop and [DONE] (guard-safe empty)', async () => {
    const input = new Response(sse({ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] })).body;
    const out = await readStream(createOpenAIChatStreamFromCodeAssist(input, { messageId: 'm', model: 'm' }));
    assert.ok(out.includes('"finish_reason":"content_filter"'));
    assert.ok(out.endsWith('data: [DONE]\n\n'));
  });

  await test('constants expose the built-in endpoint and CLI user agent', () => {
    assert.equal(GEMINI_CODE_ASSIST_ENDPOINT, 'https://cloudcode-pa.googleapis.com');
    assert.ok(GEMINI_CLI_USER_AGENT.startsWith('GeminiCLI/'));
  });

  console.log(`\nGoogle subscription wire tests: ${passed} passed, ${failed} failed.`);
  console.log('ok - file:google-subscription-wire');
} catch (error) {
  console.error('not ok - google-subscription-wire-test.mjs failed');
  console.error(error?.stack || error);
  process.exitCode = 1;
}
