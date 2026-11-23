#!/usr/bin/env node
/**
 * TDD Suite for Batch 169 Item 5:
 *  - callModelEndpoint accepts `toolChoice` and forwards `payload.tool_choice = "none"` alongside `tools`
 *  - probeToolChoiceNone sends tools + tool_choice: "none" with tool-inducing prompt and detects whether tool_calls still occur
 */

import assert from 'node:assert/strict';
import { callModelEndpoint } from '../runtime/provider-gateway.mjs';
import { TOOL_SCHEMAS } from '../runtime/tool-runtime.mjs';
import { probeToolChoiceNone } from './probe-tool-choice.mjs';

function makeSseChoice(model, delta, finishReason = 'stop') {
  return new Response(
    `data: ${JSON.stringify({
      id: 'tc-1',
      object: 'chat.completion.chunk',
      model,
      choices: [{ index: 0, delta, finish_reason: null }]
    })}\n\n` +
    `data: ${JSON.stringify({
      id: 'tc-1',
      object: 'chat.completion.chunk',
      model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 2300, completion_tokens: 18, total_tokens: 2318 }
    })}\n\n` +
    `data: [DONE]\n\n`,
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  );
}

async function main() {
  // 1) Forward tool_choice: "none" when explicitly requested on callModelEndpoint
  let capturedPayload = null;
  const resForwarded = await callModelEndpoint({
    baseUrl: 'http://127.0.0.1:20199/v1',
    apiKey: 'mock',
    model: 'ag/gemini-3.8-flash-medium',
    tools: [TOOL_SCHEMAS.list_files],
    toolChoice: 'none',
    messages: [{ role: 'user', content: 'Inspect core/' }],
    fetchFn: async (_url, init) => {
      capturedPayload = JSON.parse(String(init.body || '{}'));
      return makeSseChoice('gemini-3.8-flash-n', { role: 'assistant', content: 'OK no tools' }, 'stop');
    }
  });
  assert.equal(resForwarded.ok, true);
  assert.ok(Array.isArray(capturedPayload.tools) && capturedPayload.tools.length === 1);
  assert.equal(capturedPayload.tool_choice, 'none', 'callModelEndpoint must forward tool_choice: "none"');

  // 2) probeToolChoiceNone reports tool_choice_none_respected=true when no tool calls returned
  const okProbe = await probeToolChoiceNone({
    model: 'ag/gemini-3.8-flash-medium',
    baseUrl: 'http://127.0.0.1:20199/v1',
    apiKey: 'mock',
    nineRouterVersion: '0.5.119',
    fetchFn: async (_url, init) => {
      const p = JSON.parse(String(init.body || '{}'));
      assert.equal(p.tool_choice, 'none');
      return makeSseChoice('gemini-3.8-flash-n', { role: 'assistant', content: 'Cannot call tools.' }, 'stop');
    }
  });
  assert.equal(okProbe.ok, true);
  assert.equal(okProbe.tool_choice_sent, 'none');
  assert.equal(okProbe.tool_calls_count, 0);
  assert.equal(okProbe.tool_choice_none_respected, true);

  // 3) probeToolChoiceNone flags failure if upstream returns tool_calls anyway (i.e. 9Router dropped tool_choice)
  const leakedProbe = await probeToolChoiceNone({
    model: 'ag/gemini-3.8-flash-medium',
    baseUrl: 'http://127.0.0.1:20199/v1',
    apiKey: 'mock',
    nineRouterVersion: '0.5.119',
    fetchFn: async () => makeSseChoice(
      'gemini-3.8-flash-n',
      {
        role: 'assistant',
        tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'list_files', arguments: '{"dir":"core"}' } }]
      },
      'tool_calls'
    )
  });
  assert.equal(leakedProbe.ok, true);
  assert.equal(leakedProbe.tool_calls_count, 1);
  assert.equal(leakedProbe.tool_choice_none_respected, false);

  console.log('[OK] tool_choice="none" forwarding & probe detection passed');
}

main().catch(err => {
  console.error('[FAIL]', err);
  process.exit(1);
});
