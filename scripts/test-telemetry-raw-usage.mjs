#!/usr/bin/env node
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { callModelEndpoint, normalizeUsage } from '../runtime/provider-gateway.mjs';
import { runAgent } from '../runtime/index.mjs';
import { call9Router } from './lib/client-9router.mjs';
import { recordTaskStep } from './lib/task-persistence.mjs';

function createMockFetch(handler) {
  return async (url, init = {}) => {
    const parsed = init.body ? JSON.parse(String(init.body)) : {};
    const out = await handler(url, parsed);
    return new Response(out.body, {
      status: out.status || 200,
      headers: out.headers || { 'Content-Type': 'application/json' }
    });
  };
}

async function runTests() {
  console.log('Testing Raw Usage Preservation, requested/actual Model & Null-vs-Zero cached_tokens in calls.jsonl...\n');

  const tmpTeamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-raw-usage-team-'));
  const tmpRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-raw-usage-repo-'));
  fs.mkdirSync(path.join(tmpRepoDir, 'core'), { recursive: true });
  fs.writeFileSync(path.join(tmpRepoDir, 'core', 'sample.py'), 'x = 1\n', 'utf8');

  let scenario = 'no_cache_json';
  let multiTurnIdx = 0;

  const mockBaseUrl = 'http://127.0.0.1:20128/v1';
  const mockFetch = createMockFetch(async (_url, parsed) => {
    if (scenario === 'no_cache_json') {
      return {
        status: 200,
        body: JSON.stringify({
          id: 'chatcmpl-1',
          model: 'vendor/actual-fallback-model',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: '{"passed": true, "issues": []}' },
            finish_reason: 'stop'
          }],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 30,
            total_tokens: 150,
            provider_extra: { tier: 'standard', keep_me: true }
          }
        })
      };
    }

    if (scenario === 'anthropic_sse_cache') {
      const sseRawUsage = {
        input_tokens: 200,
        cache_creation_input_tokens: 1500,
        cache_read_input_tokens: 800,
        output_tokens: 45,
        server_trace_id: 'tr_sse_99'
      };
      const sseBody = [
        `data: ${JSON.stringify({
          model: 'ag/claude-sonnet-5-5-actual',
          choices: [{ delta: { content: 'done sse' }, finish_reason: null }]
        })}`,
        '',
        `data: ${JSON.stringify({
          model: 'ag/claude-sonnet-5-5-actual',
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: sseRawUsage
        })}`,
        '',
        'data: [DONE]',
        ''
      ].join('\n');
      return {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: sseBody
      };
    }

    if (scenario === 'explicit_zero_cache') {
      return {
        status: 200,
        body: JSON.stringify({
          id: 'chatcmpl-zero',
          model: parsed.model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'zero cache ok' },
            finish_reason: 'stop'
          }],
          usage: {
            prompt_tokens: 250,
            completion_tokens: 25,
            total_tokens: 275,
            prompt_tokens_details: { cached_tokens: 0, text_tokens: 250 }
          }
        })
      };
    }

    multiTurnIdx++;
    if (multiTurnIdx === 1) {
      return {
        status: 200,
        body: JSON.stringify({
          id: 'chatcmpl-mt-1',
          model: 'ag/gemini-actual-mt',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'call_mt_1',
                type: 'function',
                function: { name: 'list_files', arguments: JSON.stringify({ directory: 'core' }) }
              }]
            },
            finish_reason: 'tool_calls'
          }],
          usage: { prompt_tokens: 300, completion_tokens: 20, custom_turn: 1 }
        })
      };
    }
    return {
      status: 200,
      body: JSON.stringify({
        id: 'chatcmpl-mt-2',
        model: 'ag/gemini-actual-mt',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '{"tasks":[]}' },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 450, completion_tokens: 15, custom_turn: 2 }
      })
    };
  });

  try {
    // 1. Existing numeric compatibility of normalizeUsage PLUS explicit reported_cached_tokens === null
    const noCacheNorm = normalizeUsage({ prompt_tokens: 100, completion_tokens: 50, provider_custom: 7 });
    assert.strictEqual(noCacheNorm.cached_tokens, 0, 'normalizeUsage numeric cached_tokens remains 0 for math');
    assert.strictEqual(noCacheNorm.cache_reported, false, 'normalizeUsage must mark cache_reported=false when absent');
    assert.strictEqual(noCacheNorm.reported_cached_tokens, null, 'normalizeUsage must set reported_cached_tokens=null when absent');

    const zeroCacheNorm = normalizeUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens: 50 });
    assert.strictEqual(zeroCacheNorm.cache_reported, true);
    assert.strictEqual(zeroCacheNorm.reported_cached_tokens, 0);

    // 2. callModelEndpoint (JSON, no cache field, actual model != requested model) -> calls.jsonl
    scenario = 'no_cache_json';
    const gwRes = await callModelEndpoint({
      baseUrl: mockBaseUrl,
      apiKey: 'sk-test-123456',
      model: 'vendor/requested-model',
      messages: [{ role: 'user', content: 'hello' }],
      timeoutMs: 5000,
      fetchFn: mockFetch
    });
    assert.strictEqual(gwRes.ok, true, gwRes.error || 'gwRes failed');
    assert.strictEqual(gwRes.requested_model, 'vendor/requested-model');
    assert.strictEqual(gwRes.actual_model, 'vendor/actual-fallback-model');
    assert.deepStrictEqual(gwRes.raw_usage, {
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
      provider_extra: { tier: 'standard', keep_me: true }
    }, 'callModelEndpoint must preserve verbatim raw_usage with all provider fields');

    const task = { task_id: 'T-RAW-USAGE-1', steps: [] };
    recordTaskStep(task, {
      step: '1.1',
      attempt: 1,
      role: 'writer',
      action: 'apply_patch',
      requested_model: gwRes.requested_model,
      actual_model: gwRes.actual_model,
      model: gwRes.actual_model,
      endpoint: gwRes.endpoint,
      prompt_tokens: gwRes.usage.prompt_tokens,
      cached_tokens: gwRes.usage.reported_cached_tokens,
      completion_tokens: gwRes.usage.completion_tokens,
      reasoning_tokens: gwRes.usage.reasoning_tokens,
      raw_usage: gwRes.raw_usage,
      duration_ms: 10,
      status: 'ok'
    }, { teamDir: tmpTeamDir });

    // Also test safety: even if caller accidentally passes cached_tokens: 0 alongside raw_usage without cache fields, calls.jsonl must store null!
    recordTaskStep(task, {
      step: '1.2',
      attempt: 1,
      role: 'writer',
      action: 'apply_patch',
      requested_model: 'req/m',
      actual_model: 'act/m',
      prompt_tokens: 120,
      cached_tokens: 0,
      completion_tokens: 30,
      raw_usage: { prompt_tokens: 120, completion_tokens: 30, no_cache_flag: 'raw' },
      duration_ms: 10,
      status: 'ok'
    }, { teamDir: tmpTeamDir });

    // 3. SSE streaming + Anthropic cache fields verbatim
    scenario = 'anthropic_sse_cache';
    const sseRes = await callModelEndpoint({
      baseUrl: mockBaseUrl,
      apiKey: 'sk-test-123456',
      model: 'ag/claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'hello sse' }],
      timeoutMs: 5000,
      fetchFn: mockFetch
    });
    assert.strictEqual(sseRes.ok, true, sseRes.error || 'sseRes failed');
    assert.strictEqual(sseRes.requested_model, 'ag/claude-sonnet-5-5');
    assert.strictEqual(sseRes.actual_model, 'ag/claude-sonnet-5-5-actual');
    assert.deepStrictEqual(sseRes.raw_usage, {
      input_tokens: 200,
      cache_creation_input_tokens: 1500,
      cache_read_input_tokens: 800,
      output_tokens: 45,
      server_trace_id: 'tr_sse_99'
    });
    recordTaskStep(task, {
      step: '2.1',
      attempt: 1,
      role: 'designer',
      action: 'draft_spec',
      requested_model: sseRes.requested_model,
      actual_model: sseRes.actual_model,
      prompt_tokens: sseRes.usage.prompt_tokens,
      cached_tokens: sseRes.usage.reported_cached_tokens,
      completion_tokens: sseRes.usage.completion_tokens,
      raw_usage: sseRes.raw_usage,
      duration_ms: 15,
      status: 'ok'
    }, { teamDir: tmpTeamDir });

    // 4. Provider explicitly reports cached_tokens: 0
    scenario = 'explicit_zero_cache';
    const zeroRes = await callModelEndpoint({
      baseUrl: mockBaseUrl,
      apiKey: 'sk-test-123456',
      model: 'ag/gemini-3.8-flash-medium',
      messages: [{ role: 'user', content: 'zero cache' }],
      timeoutMs: 5000,
      fetchFn: mockFetch
    });
    assert.strictEqual(zeroRes.usage.reported_cached_tokens, 0);
    recordTaskStep(task, {
      step: '3.1',
      attempt: 1,
      role: 'writer',
      action: 'apply_patch',
      requested_model: zeroRes.requested_model,
      actual_model: zeroRes.actual_model,
      prompt_tokens: zeroRes.usage.prompt_tokens,
      cached_tokens: zeroRes.usage.reported_cached_tokens,
      completion_tokens: zeroRes.usage.completion_tokens,
      raw_usage: zeroRes.raw_usage,
      duration_ms: 12,
      status: 'ok'
    }, { teamDir: tmpTeamDir });

    // 5. call9Router preserves raw_usage & requested/actual model
    scenario = 'no_cache_json';
    const c9Res = await call9Router(
      'vendor/req-9r',
      'system prompt',
      'user msg',
      1024,
      null,
      0.1,
      {
        strictModelMatch: false,
        fetchFn: mockFetch,
        teamConfig: { providers: { local_9router: { base_url: mockBaseUrl } } }
      }
    );
    assert.strictEqual(c9Res.ok, true, c9Res.error || 'call9Router failed');
    assert.strictEqual(c9Res.requested_model, 'vendor/req-9r');
    assert.strictEqual(c9Res.actual_model, 'vendor/actual-fallback-model');
    assert.deepStrictEqual(c9Res.raw_usage, {
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
      provider_extra: { tier: 'standard', keep_me: true }
    });
    assert.strictEqual(c9Res.usage.reported_cached_tokens, null);

    // 6. runAgent multi-turn preserves turn raw_usage & sets reported_cached_tokens = null when unreported
    scenario = 'multi_turn_no_cache';
    const agentRes = await runAgent({
      role: 'router',
      prompt: 'Inspect core',
      sessionId: `raw-usage-mt-${Date.now()}`,
      maxTurns: 3,
      modelOverride: 'ag/gemini-requested-mt',
      baseUrlOverride: mockBaseUrl,
      apiKeyOverride: 'sk-test-123456',
      sessionsDir: path.join(tmpTeamDir, 'sessions'),
      fetchFn: mockFetch,
      repoRoot: tmpRepoDir
    });
    assert.strictEqual(agentRes.ok, true, agentRes.error || 'runAgent failed');
    assert.strictEqual(agentRes.requested_model, 'ag/gemini-requested-mt');
    assert.strictEqual(agentRes.actual_model, 'ag/gemini-actual-mt');
    assert.strictEqual(agentRes.usage.reported_cached_tokens, null);
    assert.strictEqual(agentRes.turn_usages.length, 2);
    assert.deepStrictEqual(agentRes.turn_usages[0].raw_usage, { prompt_tokens: 300, completion_tokens: 20, custom_turn: 1 });
    assert.deepStrictEqual(agentRes.turn_usages[1].raw_usage, { prompt_tokens: 450, completion_tokens: 15, custom_turn: 2 });

    // Read calls.jsonl and verify every written row
    const jsonlPath = path.join(tmpTeamDir, 'state', 'telemetry', 'calls.jsonl');
    assert.ok(fs.existsSync(jsonlPath), 'calls.jsonl must exist');
    const rows = fs.readFileSync(jsonlPath, 'utf8').trim().split(/\r?\n/).map(l => JSON.parse(l));
    assert.strictEqual(rows.length, 4);

    assert.strictEqual(rows[0].cached_tokens, null, 'calls.jsonl row 0 must have cached_tokens === null when provider omits cache');
    assert.strictEqual(rows[0].requested_model, 'vendor/requested-model');
    assert.strictEqual(rows[0].actual_model, 'vendor/actual-fallback-model');
    assert.strictEqual(rows[0].raw_usage.provider_extra.tier, 'standard');

    assert.strictEqual(rows[1].cached_tokens, null, 'calls.jsonl row 1 must override numeric 0 to null when raw_usage omitted cache');
    assert.strictEqual(rows[1].raw_usage.no_cache_flag, 'raw');

    assert.strictEqual(rows[2].cached_tokens, 800);
    assert.strictEqual(rows[2].raw_usage.cache_creation_input_tokens, 1500);
    assert.strictEqual(rows[2].raw_usage.server_trace_id, 'tr_sse_99');

    assert.strictEqual(rows[3].cached_tokens, 0, 'calls.jsonl row 3 must keep 0 when provider explicitly reported cached_tokens: 0');

    // Verify orchestrator forwards raw_usage into recordTaskStep
    const orchSrc = fs.readFileSync(path.resolve(__dirname, 'orchestrator.mjs'), 'utf8');
    assert.ok(orchSrc.includes('raw_usage:'), 'orchestrator.mjs must pass raw_usage into recordTaskStep');
    assert.ok(orchSrc.includes('reported_cached_tokens'), 'orchestrator.mjs must forward reported_cached_tokens instead of coercing to 0');

    // 7. Batch 166 Item A: ag/* default stream:true + final-chunk usage + degraded non-stream + Gemini adjusted usage
    const capturedAgRequests = [];
    const agStreamFetch = async (_url, init = {}) => {
      const req = JSON.parse(String(init.body));
      capturedAgRequests.push(req);

      if (req.stream === true) {
        const c1 = JSON.stringify({
          id: 'ag-sse-1',
          model: req.model.includes('claude') ? 'claude-sonnet-5-5-high' : 'gemini-3.8-flash-n',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }]
        });
        const c2 = JSON.stringify({
          id: 'ag-sse-1',
          model: req.model.includes('claude') ? 'claude-sonnet-5-5-high' : 'gemini-3.8-flash-n',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: null
        });
        const c3 = JSON.stringify({
          id: 'ag-sse-1',
          model: req.model.includes('claude') ? 'claude-sonnet-5-5-high' : 'gemini-3.8-flash-n',
          choices: [],
          usage: req.model.includes('claude')
            ? { prompt_tokens: 5186, completion_tokens: 5, total_tokens: 5191, prompt_tokens_details: { cached_tokens: 3167 } }
            : { prompt_tokens: 3777, completion_tokens: 24, total_tokens: 3801, completion_tokens_details: { reasoning_tokens: 23 } }
        });
        return new Response(`data: ${c1}\n\ndata: ${c2}\n\ndata: ${c3}\n\ndata: [DONE]\n\n`, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        });
      }

      // Forced stream: false path
      return new Response(JSON.stringify({
        id: 'ag-json-degraded',
        model: req.model.includes('claude') ? 'claude-sonnet-5-5-high' : 'gemini-3.8-flash-n',
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: req.model.includes('claude')
          ? { prompt_tokens: 5188, completion_tokens: 4, total_tokens: 5192 }
          : { prompt_tokens: 3794, completion_tokens: 2, total_tokens: 3796, completion_tokens_details: { reasoning_tokens: 24 } }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    // 7a: Default stream:true for ag/claude-sonnet-5-5 (explicit unconfirmed vs 0.5.119)
    const agClaudeStream = await callModelEndpoint({
      baseUrl: mockBaseUrl,
      apiKey: 'sk-test-123456',
      model: 'ag/claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'stream default check' }],
      nineRouterVersion: null,
      timeoutMs: 5000,
      fetchFn: agStreamFetch
    });
    assert.strictEqual(agClaudeStream.ok, true, agClaudeStream.error);
    assert.strictEqual(capturedAgRequests[0].stream, true, 'ag/* must default to stream: true');
    assert.deepStrictEqual(capturedAgRequests[0].stream_options, { include_usage: true });
    assert.strictEqual(agClaudeStream.usage.usage_quality, 'full');
    assert.strictEqual(agClaudeStream.usage.reported_cached_tokens, 3167);
    assert.strictEqual(agClaudeStream.usage.cached_tokens, 3167);
    assert.strictEqual(agClaudeStream.usage.usage_adjusted, false);

    // 7b: Default stream:true for ag/gemini-3.8-flash-medium
    const agGeminiStream = await callModelEndpoint({
      baseUrl: mockBaseUrl,
      apiKey: 'sk-test-123456',
      model: 'ag/gemini-3.8-flash-medium',
      messages: [{ role: 'user', content: 'gemini stream default check' }],
      nineRouterVersion: null,
      timeoutMs: 5000,
      fetchFn: agStreamFetch
    });
    assert.strictEqual(agGeminiStream.ok, true, agGeminiStream.error);
    assert.strictEqual(capturedAgRequests[1].stream, true);
    assert.deepStrictEqual(capturedAgRequests[1].stream_options, { include_usage: true });
    assert.strictEqual(agGeminiStream.usage.usage_quality, 'full');
    assert.strictEqual(agGeminiStream.usage.prompt_tokens, 3777);
    assert.strictEqual(agGeminiStream.usage.usage_adjusted, false);

    // 7c: Forced non-stream (stream: false) on ag/claude-sonnet-5-5 -> degraded, cached_tokens=null
    const agClaudeNonStream = await callModelEndpoint({
      baseUrl: mockBaseUrl,
      apiKey: 'sk-test-123456',
      model: 'ag/claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'forced nonstream claude' }],
      stream: false,
      nineRouterVersion: null,
      timeoutMs: 5000,
      fetchFn: agStreamFetch
    });
    assert.strictEqual(capturedAgRequests[2].stream, false);
    assert.strictEqual(capturedAgRequests[2].stream_options, undefined);
    assert.strictEqual(agClaudeNonStream.usage.usage_quality, 'degraded');
    assert.strictEqual(agClaudeNonStream.usage.cached_tokens, null);
    assert.strictEqual(agClaudeNonStream.usage.reported_cached_tokens, null);
    assert.strictEqual(agClaudeNonStream.usage.usage_adjusted, false);

    // 7d: Forced non-stream (stream: false) on ag/gemini-3.8-flash-medium -> degraded, cached_tokens=null, raw + prompt_tokens_adjusted + usage_adjusted=true
    const agGeminiNonStream = await callModelEndpoint({
      baseUrl: mockBaseUrl,
      apiKey: 'sk-test-123456',
      model: 'ag/gemini-3.8-flash-medium',
      messages: [{ role: 'user', content: 'forced nonstream gemini' }],
      stream: false,
      nineRouterVersion: null,
      timeoutMs: 5000,
      fetchFn: agStreamFetch
    });
    assert.strictEqual(capturedAgRequests[3].stream, false);
    assert.strictEqual(agGeminiNonStream.usage.usage_quality, 'degraded');
    assert.strictEqual(agGeminiNonStream.usage.cached_tokens, null);
    assert.strictEqual(agGeminiNonStream.usage.reported_cached_tokens, null);
    assert.strictEqual(agGeminiNonStream.usage.prompt_tokens, 3794, 'raw prompt_tokens must be preserved');
    assert.strictEqual(agGeminiNonStream.usage.prompt_tokens_adjusted, 3770, 'prompt_tokens_adjusted must subtract reasoning_tokens (3794 - 24 = 3770)');
    assert.strictEqual(agGeminiNonStream.usage.usage_adjusted, true);

    recordTaskStep(task, {
      step: '4.1',
      attempt: 1,
      role: 'writer',
      action: 'apply_patch',
      requested_model: agGeminiNonStream.requested_model,
      actual_model: agGeminiNonStream.actual_model,
      prompt_tokens: agGeminiNonStream.usage.prompt_tokens,
      prompt_tokens_adjusted: agGeminiNonStream.usage.prompt_tokens_adjusted,
      usage_quality: agGeminiNonStream.usage.usage_quality,
      usage_adjusted: agGeminiNonStream.usage.usage_adjusted,
      cached_tokens: agGeminiNonStream.usage.cached_tokens,
      completion_tokens: agGeminiNonStream.usage.completion_tokens,
      reasoning_tokens: agGeminiNonStream.usage.reasoning_tokens,
      raw_usage: agGeminiNonStream.raw_usage,
      duration_ms: 15,
      status: 'ok'
    }, { teamDir: tmpTeamDir });

    const updatedRows = fs.readFileSync(jsonlPath, 'utf8').trim().split(/\r?\n/).map(l => JSON.parse(l));
    const degradedRow = updatedRows[4];
    assert.strictEqual(degradedRow.usage_quality, 'degraded');
    assert.strictEqual(degradedRow.cached_tokens, null);
    assert.strictEqual(degradedRow.prompt_tokens, 3794);
    assert.strictEqual(degradedRow.prompt_tokens_adjusted, 3770);
    assert.strictEqual(degradedRow.usage_adjusted, true);

    // 8. Batch 166 Item B: call9Router delegates ag/* to Gateway A (stream:true default + SSE + degraded fallback)
    capturedAgRequests.length = 0;
    const c9AgStream = await call9Router(
      'ag/claude-sonnet-5-5',
      'sys prompt',
      'review diff',
      2048,
      null,
      0.1,
      {
        strictModelMatch: false,
        fetchFn: agStreamFetch,
        teamConfig: { providers: { local_9router: { base_url: mockBaseUrl } } }
      }
    );
    assert.strictEqual(c9AgStream.ok, true, c9AgStream.error);
    assert.strictEqual(capturedAgRequests[0].stream, true, 'call9Router(ag/*) must send stream: true via Gateway A');
    assert.deepStrictEqual(capturedAgRequests[0].stream_options, { include_usage: true });
    assert.strictEqual(c9AgStream.usage.reported_cached_tokens, 3167);
    assert.strictEqual(c9AgStream.usage.usage_quality, 'full');

    const c9AgDegraded = await call9Router(
      'ag/gemini-3.8-flash-medium',
      'sys prompt',
      'fallback write',
      4096,
      null,
      0.1,
      {
        stream: false,
        nineRouterVersion: null,
        strictModelMatch: false,
        fetchFn: agStreamFetch,
        teamConfig: { providers: { local_9router: { base_url: mockBaseUrl } } }
      }
    );
    assert.strictEqual(c9AgDegraded.ok, true, c9AgDegraded.error);
    assert.strictEqual(capturedAgRequests[1].stream, false);
    assert.strictEqual(c9AgDegraded.usage.usage_quality, 'degraded');
    assert.strictEqual(c9AgDegraded.usage.cached_tokens, null);
    assert.strictEqual(c9AgDegraded.usage.prompt_tokens, 3794);
    assert.strictEqual(c9AgDegraded.usage.prompt_tokens_adjusted, 3770);
    assert.strictEqual(c9AgDegraded.usage.usage_adjusted, true);

    // 9. Batch 168 Item 1: 9Router +2000 buffer deduction ONLY for ag/* + confirmed version ('0.5.119')
    const probeNorm = normalizeUsage(
      { prompt_tokens: 2020, completion_tokens: 1, total_tokens: 2021 },
      { model: 'ag/claude-sonnet-5-5', nineRouterVersion: '0.5.119', streamed: true }
    );
    assert.strictEqual(probeNorm.prompt_tokens_raw, 2020);
    assert.strictEqual(probeNorm.prompt_tokens_adjusted, 20);
    assert.strictEqual(probeNorm.usage_adjusted_buffer, 2000);
    assert.strictEqual(probeNorm.fresh_tokens, 20);
    assert.strictEqual(probeNorm.total_tokens_adjusted, 21);

    const bufferedCached = normalizeUsage(
      { prompt_tokens: 11581, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 4801 } },
      { model: 'ag/claude-sonnet-5-5', nineRouterVersion: '0.5.119', streamed: true }
    );
    assert.strictEqual(bufferedCached.prompt_tokens_raw, 11581);
    assert.strictEqual(bufferedCached.prompt_tokens_adjusted, 9581);
    assert.strictEqual(bufferedCached.usage_adjusted_buffer, 2000);
    assert.strictEqual(bufferedCached.fresh_tokens, 4780);

    const bufferedGeminiDegraded = normalizeUsage(
      { prompt_tokens: 3794, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 24 } },
      { model: 'ag/gemini-3.8-flash-medium', nineRouterVersion: '0.5.119', nonStreamDegraded: true }
    );
    assert.strictEqual(bufferedGeminiDegraded.prompt_tokens_raw, 3794);
    assert.strictEqual(bufferedGeminiDegraded.usage_adjusted_buffer, 2000);
    assert.strictEqual(bufferedGeminiDegraded.usage_adjusted, true);
    assert.strictEqual(bufferedGeminiDegraded.prompt_tokens_adjusted, 1770);

    const nonAgSameVer = normalizeUsage(
      { prompt_tokens: 2031, completion_tokens: 1 },
      { model: 'deepseek-ai/deepseek-v4.1-flash-1017', nineRouterVersion: '0.5.119', streamed: true }
    );
    assert.strictEqual(nonAgSameVer.usage_adjusted_buffer, 0);
    assert.strictEqual(nonAgSameVer.prompt_tokens_adjusted, 2031);

    const unconfirmedVer = normalizeUsage(
      { prompt_tokens: 2020, completion_tokens: 1 },
      { model: 'ag/claude-sonnet-5-5', nineRouterVersion: '0.9.999', streamed: true }
    );
    assert.strictEqual(unconfirmedVer.usage_adjusted_buffer, 0);
    assert.strictEqual(unconfirmedVer.prompt_tokens_adjusted, 2020);

    // Step-level recordTaskStep & runtime budget brake must use adjusted tokens
    const adjTask = { task_id: 'T-ADJ-1', steps: [] };
    const adjStep = recordTaskStep(adjTask, {
      step: '1.1',
      attempt: 1,
      role: 'writer',
      action: 'apply_patch',
      requested_model: 'ag/claude-sonnet-5-5',
      actual_model: 'claude-sonnet-5-5-high',
      prompt_tokens: probeNorm.prompt_tokens,
      prompt_tokens_raw: probeNorm.prompt_tokens_raw,
      prompt_tokens_adjusted: probeNorm.prompt_tokens_adjusted,
      usage_adjusted_buffer: probeNorm.usage_adjusted_buffer,
      fresh_tokens: probeNorm.fresh_tokens,
      completion_tokens: 5,
      duration_ms: 100,
      status: 'ok'
    }, { teamDir: tmpTeamDir });
    assert.strictEqual(adjStep.prompt_tokens_raw, 2020);
    assert.strictEqual(adjStep.prompt_tokens_adjusted, 20);
    assert.strictEqual(adjStep.usage_adjusted_buffer, 2000);
    assert.strictEqual(adjTask.tokens_used, 25, 'Task tokens_used budget counter must sum adjusted tokens (20 + 5 = 25)');

    // Step-level runAgent Pre-Call Token Brake must check total_tokens_adjusted (not +2000 raw buffer)
    let agentTurnCount = 0;
    const stepBudgetRes = await runAgent({
      role: 'writer',
      modelOverride: 'ag/claude-sonnet-5-5',
      prompt: 'Adjust check',
      maxTurns: 2,
      maxTokenBudget: 2400,
      nineRouterVersion: '0.5.119',
      repoRoot: tmpRepoDir,
      sessionsDir: path.join(tmpTeamDir, 'sessions-adj'),
      baseUrlOverride: mockBaseUrl,
      apiKeyOverride: 'sk-test-123456',
      fetchFn: async (_url, init = {}) => {
        agentTurnCount++;
        const p = JSON.parse(String(init.body));
        const tc = agentTurnCount === 1
          ? [{ index: 0, id: 'c_adj_1', type: 'function', function: { name: 'list_files', arguments: '{"path":"core"}' } }]
          : undefined;
        const c1 = JSON.stringify({
          id: `adj-${agentTurnCount}`,
          model: 'claude-sonnet-5-5-high',
          choices: [{ index: 0, delta: tc ? { role: 'assistant', tool_calls: tc } : { role: 'assistant', content: 'done' }, finish_reason: null }]
        });
        const c2 = JSON.stringify({
          id: `adj-${agentTurnCount}`,
          model: 'claude-sonnet-5-5-high',
          choices: [{ index: 0, delta: {}, finish_reason: tc ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 2500, completion_tokens: 50, total_tokens: 2550 }
        });
        return new Response(`data: ${c1}\n\ndata: ${c2}\n\ndata: [DONE]\n\n`, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' }
        });
      }
    });
    assert.strictEqual(stepBudgetRes.ok, true);
    assert.strictEqual(agentTurnCount, 2, 'Adjusted Turn 1 cost (550 <= 2400) must allow Turn 2 instead of falsely tripping on raw 2550');
    assert.strictEqual(stepBudgetRes.usage.prompt_tokens_adjusted, 1000);
    assert.strictEqual(stepBudgetRes.usage.usage_adjusted_buffer, 4000);

    // Verify routes-models.mjs uses callModelEndpoint instead of hardcoded stream: false ping
    const routesModelsSrc = fs.readFileSync(path.resolve(__dirname, 'server', 'routes-models.mjs'), 'utf8');
    assert.ok(routesModelsSrc.includes('callModelEndpoint'), 'routes-models.mjs /api/test-model must delegate to Gateway A (callModelEndpoint)');
    assert.ok(orchSrc.includes('usage_quality'), 'orchestrator.mjs must forward usage_quality into recordTaskStep');

    console.log('\n======================================================');
    console.log('ALL RAW USAGE & NULL CACHE TELEMETRY TESTS PASSED!');
    console.log('======================================================');
  } finally {
    fs.rmSync(tmpTeamDir, { recursive: true, force: true });
    fs.rmSync(tmpRepoDir, { recursive: true, force: true });
  }
}

runTests().catch(err => {
  console.error('Raw usage telemetry test failed:', err);
  process.exit(1);
});
