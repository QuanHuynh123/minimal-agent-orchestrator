import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CACHE_BENCHMARK_MODELS,
  buildDeterministicCachePrompt,
  buildControlledCachePrompts,
  buildRouterSizedCachePrompts,
  measureModelCachePair,
  measureControlledCacheSequence,
  measureMinimalTokenRequest,
  probe9RouterUsageCounter,
  runCacheBenchmark,
  runControlledCacheExperiment,
  runRepeatedRouterCacheExperiment
} from './lib/cache-benchmark.mjs';
import { readInstalled9RouterVersion } from './lib/client-9router.mjs';

const TEAM_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeMockResponse(bodyObj) {
  return new Response(JSON.stringify(bodyObj), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function testIdenticalRequestAndTelemetryPreservation() {
  assert.deepEqual(
    DEFAULT_CACHE_BENCHMARK_MODELS,
    ['ag/claude-sonnet-5-5', 'ag/gemini-3.8-flash-medium']
  );

  const { systemPrompt, userMessage } = buildDeterministicCachePrompt();
  assert.ok(systemPrompt.length >= 4000, `Expected >=4000 char cacheable prefix, got ${systemPrompt.length}`);
  assert.ok(userMessage.length > 0);

  const capturedBodiesByModel = new Map();
  let callNum = 0;

  const fakeFetch = async (_url, init = {}) => {
    callNum += 1;
    const reqBody = JSON.parse(init.body);
    const reqModel = reqBody.model;
    const list = capturedBodiesByModel.get(reqModel) || [];
    list.push(init.body);
    capturedBodiesByModel.set(reqModel, list);

    const turnIdx = list.length;
    if (reqModel === 'ag/claude-sonnet-5-5') {
      // Simulate Claude ephemeral cache breakpoint + turn 1 write / turn 2 hit
      return makeMockResponse({
        id: `mock-${callNum}`,
        model: 'claude-sonnet-4-5-20250929',
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: turnIdx === 1
          ? { prompt_tokens: 1500, completion_tokens: 4, cache_creation_input_tokens: 1500, cache_read_input_tokens: 0 }
          : { prompt_tokens: 1500, completion_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 1500 }
      });
    }

    // Simulate Gemini omitting explicit cache telemetry
    return makeMockResponse({
      id: `mock-${callNum}`,
      model: 'gemini-3.8-flash-medium',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1480, completion_tokens: 3, total_tokens: 1483 }
    });
  };

  const singleRes = await measureModelCachePair('ag/claude-sonnet-5-5', {
    fetchFn: fakeFetch,
    teamConfig: { providers: { local_9router: { base_url: 'http://127.0.0.1:20128/v1', api_key: 'mock' } } }
  });
  assert.equal(singleRes.ok, true);
  assert.equal(singleRes.identical_request_payload, true);
  assert.equal(singleRes.turns.length, 2);
  assert.equal(singleRes.turns[0].requested_model, 'ag/claude-sonnet-5-5');
  assert.equal(singleRes.turns[0].actual_model, 'claude-sonnet-4-5-20250929');
  assert.equal(singleRes.turns[0].raw_usage.cache_creation_input_tokens, 1500);
  assert.equal(singleRes.turns[1].raw_usage.cache_read_input_tokens, 1500);
  assert.equal(singleRes.turns[1].reported_cached_tokens, 1500);

  // Full suite run resets counts cleanly via fresh array
  capturedBodiesByModel.clear();
  const suiteRes = await runCacheBenchmark({
    fetchFn: fakeFetch,
    teamConfig: { providers: { local_9router: { base_url: 'http://127.0.0.1:20128/v1', api_key: 'mock' } } }
  });
  assert.equal(suiteRes.results.length, 2);
  const claudePair = suiteRes.results[0];
  const geminiPair = suiteRes.results[1];

  assert.equal(claudePair.requested_model, 'ag/claude-sonnet-5-5');
  assert.equal(claudePair.identical_request_payload, true);
  assert.equal(geminiPair.requested_model, 'ag/gemini-3.8-flash-medium');
  assert.equal(geminiPair.identical_request_payload, true);
  assert.equal(geminiPair.turns[0].actual_model, 'gemini-3.8-flash-medium');
  assert.equal(geminiPair.turns[0].reported_cached_tokens, null, 'Unreported cache must remain null, not 0');
  assert.equal(geminiPair.turns[1].reported_cached_tokens, null);
  assert.equal(typeof geminiPair.turns[0].latency_ms, 'number');
  assert.equal(typeof geminiPair.turns[1].latency_ms, 'number');

  // Verify Claude received identical serialized bodies on Turn 1 & Turn 2, including cache_control
  const claudeBodies = capturedBodiesByModel.get('ag/claude-sonnet-5-5');
  assert.equal(claudeBodies.length, 2);
  assert.equal(claudeBodies[0], claudeBodies[1]);
  assert.ok(claudeBodies[0].includes('ephemeral'));

  const geminiBodies = capturedBodiesByModel.get('ag/gemini-3.8-flash-medium');
  assert.equal(geminiBodies.length, 2);
  assert.equal(geminiBodies[0], geminiBodies[1]);

  console.log('[OK] identical request & telemetry preservation passed');
}

async function testSseMultiLineResponseFallback() {
  const sseFetch = async () => {
    const chunk1 = JSON.stringify({
      id: 'sse-1',
      model: 'claude-sonnet-4-5-20250929',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }]
    });
    const chunk2 = JSON.stringify({
      id: 'sse-1',
      model: 'claude-sonnet-4-5-20250929',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 1520,
        completion_tokens: 2,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 1500
      }
    });
    const body = `data: ${chunk1}\n\ndata: ${chunk2}\n\ndata: [DONE]\n\n`;
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    });
  };

  const res = await measureModelCachePair('ag/claude-sonnet-5-5', {
    fetchFn: sseFetch,
    teamConfig: { providers: { local_9router: { base_url: 'http://127.0.0.1:20128/v1', api_key: 'mock' } } }
  });
  assert.equal(res.ok, true, `Expected SSE fallback parse to succeed, got errors: ${JSON.stringify(res.turns)}`);
  assert.equal(res.turns[0].actual_model, 'claude-sonnet-4-5-20250929');
  assert.equal(res.turns[0].raw_usage.cache_read_input_tokens, 1500);
  assert.equal(res.turns[0].reported_cached_tokens, 1500);
  assert.equal(res.turns[0].response_preview, 'OK');
  console.log('[OK] SSE multi-line response fallback passed');
}

async function testControlledSequenceAndStreamingExperiment() {
  const pair = buildControlledCachePrompts('unit-nonce-1');
  assert.notEqual(pair.A.systemPrompt, pair.B.systemPrompt);
  assert.notEqual(pair.A.systemPrompt[0], pair.B.systemPrompt[0], 'A and B must differ starting at byte 0');
  assert.equal(
    Buffer.byteLength(pair.A.systemPrompt, 'utf8'),
    Buffer.byteLength(pair.B.systemPrompt, 'utf8'),
    'A and B prefixes must have identical UTF-8 byte lengths'
  );
  assert.ok(pair.A.systemPrompt.length >= 4000);

  const recordedRequests = [];
  const sseFetch = async (url, init = {}) => {
    if (String(url).includes('/api/usage/stats')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const req = JSON.parse(init.body);
    recordedRequests.push({ url, rawBody: init.body, req });
    const isStream = req.stream === true;
    const isClaude = String(req.model).includes('claude');
    const sysText = Array.isArray(req.messages[0].content)
      ? req.messages[0].content.map(c => c.text).join('')
      : req.messages[0].content;
    const isB = sysText.startsWith('BRAVO');

    if (isStream && isClaude) {
      // Simulate Anthropic-style SSE forwarded with message_start + message_delta usage
      const ev1 = JSON.stringify({
        type: 'message_start',
        message: {
          model: 'claude-sonnet-4-5-20250929',
          usage: {
            input_tokens: isB ? 1500 : 12,
            cache_creation_input_tokens: isB ? 1500 : 0,
            cache_read_input_tokens: isB ? 0 : 1488
          }
        }
      });
      const ev2 = JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'OK' }
      });
      const ev3 = JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 2 }
      });
      return new Response(
        `data: ${ev1}\n\ndata: ${ev2}\n\ndata: ${ev3}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      );
    }

    if (isStream) {
      // Simulate OpenAI SSE stream with end-of-stream prompt_tokens_details
      const c1 = JSON.stringify({
        id: 'g-sse',
        model: 'gemini-3.8-flash-n',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }]
      });
      const c2 = JSON.stringify({
        id: 'g-sse',
        model: 'gemini-3.8-flash-n',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 3770,
          completion_tokens: 18,
          total_tokens: 3788,
          ...(isB ? {} : { prompt_tokens_details: { cached_tokens: 2500 } }),
          completion_tokens_details: { reasoning_tokens: 16 }
        }
      });
      return new Response(
        `data: ${c1}\n\ndata: ${c2}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      );
    }

    return makeMockResponse({
      id: `nonstream-${recordedRequests.length}`,
      model: isClaude ? 'claude-sonnet-4-5-20250929' : 'gemini-3.8-flash-n',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1500, completion_tokens: 2, total_tokens: 1502 }
    });
  };

  const seqRes = await measureControlledCacheSequence('ag/claude-sonnet-5-5', {
    stream: true,
    nonce: 'seq-test',
    fetchFn: sseFetch,
    teamConfig: { providers: { local_9router: { base_url: 'http://127.0.0.1:20128/v1', api_key: 'mock' } } }
  });

  assert.equal(seqRes.ok, true);
  assert.deepEqual(seqRes.sequence, ['A', 'A', 'B', 'A']);
  assert.equal(seqRes.turns.length, 4);
  assert.equal(seqRes.a_payloads_identical, true);
  assert.equal(seqRes.b_differs_from_byte_0, true);
  assert.equal(seqRes.equal_payload_bytes, true);
  assert.equal(seqRes.turns[0].label, 'A');
  assert.equal(seqRes.turns[2].label, 'B');
  assert.equal(seqRes.turns[3].label, 'A');
  assert.equal(seqRes.turns[1].raw_usage.cache_read_input_tokens, 1488);
  assert.equal(seqRes.turns[1].cache_reported, true);
  assert.equal(seqRes.turns[1].reported_cached_tokens, 1488);
  assert.equal(recordedRequests[0].req.stream, true);
  assert.deepEqual(recordedRequests[0].req.stream_options, { include_usage: true });

  const usage401 = await probe9RouterUsageCounter('http://127.0.0.1:20128/v1', { fetchFn: sseFetch });
  assert.equal(usage401.available, false);
  assert.equal(usage401.manual_read_required, true);
  assert.equal(usage401.status, 401);

  const usageOk = await probe9RouterUsageCounter('http://127.0.0.1:20128/v1', {
    fetchFn: async () => new Response(JSON.stringify({ totalCachedTokens: 4200, totalRequests: 10 }), { status: 200 })
  });
  assert.equal(usageOk.available, true);
  assert.equal(usageOk.cached_tokens, 4200);

  recordedRequests.length = 0;
  const fullExp = await runControlledCacheExperiment({
    fetchFn: sseFetch,
    nonce: 'exp-base',
    teamConfig: { providers: { local_9router: { base_url: 'http://127.0.0.1:20128/v1', api_key: 'mock' } } }
  });
  assert.equal(fullExp.passes.length, 4, 'Expected 2 models x (stream:false + stream:true) = 4 passes');
  assert.equal(fullExp.usage_counter.manual_read_required, true);
  const geminiStreamPass = fullExp.passes.find(p => p.requested_model === 'ag/gemini-3.8-flash-medium' && p.stream === true);
  assert.equal(geminiStreamPass.turns[1].reported_cached_tokens, 2500);
  assert.equal(geminiStreamPass.turns[2].cache_reported, false);
  assert.equal(geminiStreamPass.turns[2].reported_cached_tokens, null);

  console.log('[OK] controlled A,A,B,A sequence & streaming experiment passed');
}

async function testRepeatedRouterSizedCacheExperiment() {
  const routerPair = buildRouterSizedCachePrompts('router-nonce-1');
  assert.ok(routerPair.A.systemPrompt.length >= 48000, `Expected >=48k chars for >=12k tokens, got ${routerPair.A.systemPrompt.length}`);
  assert.notEqual(routerPair.A.systemPrompt[0], routerPair.B.systemPrompt[0], 'A and B must diverge from byte 0');
  assert.equal(
    Buffer.byteLength(routerPair.A.systemPrompt, 'utf8'),
    Buffer.byteLength(routerPair.B.systemPrompt, 'utf8'),
    'Router-sized A and B systemPrompt must have identical UTF-8 byte lengths'
  );
  assert.equal(
    Buffer.byteLength(routerPair.A.userMessage, 'utf8'),
    Buffer.byteLength(routerPair.B.userMessage, 'utf8')
  );
  assert.ok(Array.isArray(routerPair.A.tools) && routerPair.A.tools.length >= 3, 'Must include Router tool schemas');
  assert.equal(
    Buffer.byteLength(JSON.stringify(routerPair.A.tools), 'utf8'),
    Buffer.byteLength(JSON.stringify(routerPair.B.tools), 'utf8')
  );

  const requests = [];
  const claudeHitRatiosByTurn = [0, 0.72, 0.75, 0, 0.25, 0.78];
  const mockFetch = async (_url, init = {}) => {
    const req = JSON.parse(String(init.body));
    requests.push(req);
    const isClaude = req.model.includes('claude');
    const stepIdx = (requests.length - 1) % 6;
    const promptTokens = 14500;
    const hitRatio = isClaude ? claudeHitRatiosByTurn[stepIdx] : 0;
    const cached = isClaude && hitRatio > 0 ? Math.round(promptTokens * hitRatio) : null;

    const c1 = JSON.stringify({
      id: `rep-${requests.length}`,
      model: isClaude ? 'claude-sonnet-5-5-high' : 'gemini-3.8-flash-n',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }]
    });
    const c2 = JSON.stringify({
      id: `rep-${requests.length}`,
      model: isClaude ? 'claude-sonnet-5-5-high' : 'gemini-3.8-flash-n',
      choices: [],
      usage: isClaude
        ? {
            prompt_tokens: promptTokens,
            completion_tokens: 8,
            total_tokens: promptTokens + 8,
            ...(cached !== null ? { prompt_tokens_details: { cached_tokens: cached } } : {})
          }
        : {
            prompt_tokens: promptTokens,
            completion_tokens: 20,
            total_tokens: promptTokens + 20,
            completion_tokens_details: { reasoning_tokens: 18 }
          }
    });
    return new Response(`data: ${c1}\n\ndata: ${c2}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    });
  };

  const report = await runRepeatedRouterCacheExperiment({
    repetitions: 3,
    nineRouterVersion: null,
    fetchFn: mockFetch,
    nonce: 'rep-test',
    teamConfig: { providers: { local_9router: { base_url: 'http://127.0.0.1:20128/v1', api_key: 'mock' } } }
  });

  assert.equal(report.experiment, 'repeated_router_aaabaa');
  assert.deepEqual(report.sequence, ['A', 'A', 'A', 'B', 'A', 'A']);
  assert.equal(report.repetitions, 3);
  assert.equal(requests.length, 36, 'Expected 2 models * 3 repetitions * 6 turns = 36 requests');
  assert.ok(requests.every(r => r.stream === true && r.stream_options?.include_usage === true));

  const claudeSummary = report.models.find(m => m.requested_model === 'ag/claude-sonnet-5-5');
  assert.equal(claudeSummary.repetitions.length, 3);
  assert.deepEqual(claudeSummary.actual_models, ['claude-sonnet-5-5-high']);
  assert.equal(claudeSummary.turn_medians.length, 6);
  assert.equal(claudeSummary.turn_medians[0].label, 'A');
  assert.equal(claudeSummary.turn_medians[3].label, 'B');
  assert.ok(Math.abs(claudeSummary.turn_medians[1].median_cached_ratio - 0.72) < 0.001);
  assert.ok(typeof claudeSummary.turn_medians[1].median_latency_ms === 'number');

  const geminiSummary = report.models.find(m => m.requested_model === 'ag/gemini-3.8-flash-medium');
  assert.equal(geminiSummary.turn_medians[1].median_cached_ratio, null, 'Unreported cache median must stay null, not 0');
  assert.equal(geminiSummary.turn_medians[1].cache_reported_count, 0);
  assert.deepEqual(geminiSummary.actual_models, ['gemini-3.8-flash-n']);

  console.log('[OK] repeated >=12k router-sized A,A,A,B,A,A cache experiment passed');
}

async function test9RouterVersionStampedInMeasurementsAndDecisions() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-9r-ver-'));
  try {
    const mockPkgPath = path.join(tmpDir, 'package.json');
    fs.writeFileSync(mockPkgPath, JSON.stringify({ name: '9router', version: '0.5.119' }), 'utf8');
    const verInfo = readInstalled9RouterVersion({ packageJsonPath: mockPkgPath, forceRefresh: true });
    assert.equal(verInfo.found, true);
    assert.equal(verInfo.version, '0.5.119');

    const missingInfo = readInstalled9RouterVersion({ packageJsonPath: path.join(tmpDir, 'nope.json'), forceRefresh: true });
    assert.equal(missingInfo.found, false);
    assert.equal(missingInfo.version, null);

    const quickOkFetch = async () => makeMockResponse({
      model: 'claude-sonnet-5-5-high',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 1 }
    });
    const benchRes = await runCacheBenchmark({
      models: ['ag/claude-sonnet-5-5'],
      nineRouterVersion: verInfo.version,
      fetchFn: quickOkFetch,
      teamConfig: { providers: { local_9router: { base_url: 'http://127.0.0.1:20128/v1', api_key: 'mock' } } }
    });
    assert.equal(benchRes.nine_router_version, '0.5.119');

    const ctrlRes = await runControlledCacheExperiment({
      models: ['ag/claude-sonnet-5-5'],
      nineRouterVersion: verInfo.version,
      fetchFn: quickOkFetch,
      teamConfig: { providers: { local_9router: { base_url: 'http://127.0.0.1:20128/v1', api_key: 'mock' } } }
    });
    assert.equal(ctrlRes.nine_router_version, '0.5.119');

    const decisionsPath = path.resolve(TEAM_DIR, 'DECISIONS.md');
    if (fs.existsSync(decisionsPath)) {
      const decisionsText = fs.readFileSync(decisionsPath, 'utf8');
      assert.ok(decisionsText.includes('0.5.119'), 'DECISIONS.md must record 9Router version read from package.json');
    }
    console.log('[OK] 9Router version reading & measurement stamping passed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testMinimalShortGatewayProbe() {
  const seen = [];
  const shortFetch = async (_url, init = {}) => {
    const req = JSON.parse(String(init.body));
    seen.push(req);
    return new Response(
      `data: ${JSON.stringify({ id: 's1', model: 'claude-sonnet-5-5-high', choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id: 's1', model: 'claude-sonnet-5-5-high', choices: [], usage: { prompt_tokens: 2012, completion_tokens: 1, total_tokens: 2013 } })}\n\n` +
      `data: [DONE]\n\n`,
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
    );
  };

  const probe = await measureMinimalTokenRequest('ag/claude-sonnet-5-5', {
    nineRouterVersion: '0.5.119',
    fetchFn: shortFetch,
    teamConfig: { providers: { local_9router: { base_url: 'http://127.0.0.1:20128/v1', api_key: 'mock' } } }
  });
  assert.equal(probe.ok, true);
  assert.equal(probe.nine_router_version, '0.5.119');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].messages.length, 1);
  assert.equal(seen[0].max_tokens, 1);
  assert.equal(seen[0].stream, true);
  assert.equal(probe.prompt_tokens, 2012);
  assert.equal(probe.prompt_tokens_raw, 2012);
  assert.equal(probe.prompt_tokens_adjusted, 12);
  assert.equal(probe.usage_adjusted_buffer, 2000);
  assert.equal(probe.fresh_tokens, 12);
  assert.equal(probe.completion_tokens, 1);
  assert.equal(probe.total_tokens, 2013);
  assert.ok(probe.request_bytes < 250);

  // Explicit 2020 -> adjusted 20 test case
  const short2020Fetch = async () => new Response(
    `data: ${JSON.stringify({ id: 's2', model: 'claude-sonnet-5-5-high', choices: [{ index: 0, delta: { content: 'O' }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ id: 's2', model: 'claude-sonnet-5-5-high', choices: [], usage: { prompt_tokens: 2020, completion_tokens: 1, total_tokens: 2021 } })}\n\n` +
    `data: [DONE]\n\n`,
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  );
  const probe2020 = await measureMinimalTokenRequest('ag/claude-sonnet-5-5', {
    nineRouterVersion: '0.5.119',
    fetchFn: short2020Fetch,
    teamConfig: { providers: { local_9router: { base_url: 'http://127.0.0.1:20128/v1', api_key: 'mock' } } }
  });
  assert.equal(probe2020.prompt_tokens_raw, 2020);
  assert.equal(probe2020.prompt_tokens_adjusted, 20);
  assert.equal(probe2020.usage_adjusted_buffer, 2000);
  assert.equal(probe2020.fresh_tokens, 20);
  console.log('[OK] minimal short gateway probe passed');
}

async function main() {
  await testIdenticalRequestAndTelemetryPreservation();
  await testSseMultiLineResponseFallback();
  await testControlledSequenceAndStreamingExperiment();
  await testRepeatedRouterSizedCacheExperiment();
  await test9RouterVersionStampedInMeasurementsAndDecisions();
  await testMinimalShortGatewayProbe();
  console.log('[PASS] test-cache-benchmark');
}

main().catch(err => {
  console.error('[FAIL] test-cache-benchmark:', err);
  process.exit(1);
});
