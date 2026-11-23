#!/usr/bin/env node
/**
 * TDD Suite for Batch 170 Item 4:
 *  - Final synthesis turn in runAgent KEEPS `tools` unchanged (does NOT set tools: null)
 *  - Appends a user message instructing final response / JSON without calling tools
 *  - If model STILL returns tool_calls on synthesis turn -> fails cleanly & controllably
 *    (controlled_failure: true, failure_reason: 'synthesis_unexpected_tool_call', 0 extra retries/tool executions)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAgent } from '../runtime/index.mjs';
import {
  assertBudgetBeforeCall,
  callModelEndpoint,
  estimateRequestPromptTokens,
  readInstalled9RouterVersion
} from '../runtime/provider-gateway.mjs';
import { TOOL_SCHEMAS } from '../runtime/tool-runtime.mjs';
import { decomposeGoal } from './goal-planner.mjs';
import { loadMergedTeamConfig, resolveConfigDir } from './lib/policy-loader.mjs';
import { inspectPayloadPrefixInvariance } from './lib/prefix-invariant.mjs';
import { resolveApiKey } from './lib/risk-policy.mjs';

const IS_LIVE = process.argv.includes('--live');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AGENT_TEAM_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(AGENT_TEAM_ROOT, '..');

function makeSseResponse(model, delta, finishReason, promptTokens = 2400, completionTokens = 25) {
  const c1 = {
    id: 'chatcmpl-synth-test',
    object: 'chat.completion.chunk',
    model,
    choices: [{ index: 0, delta, finish_reason: null }]
  };
  const c2 = {
    id: 'chatcmpl-synth-test',
    object: 'chat.completion.chunk',
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
  };
  const sse = `data: ${JSON.stringify(c1)}\n\ndata: ${JSON.stringify(c2)}\n\ndata: [DONE]\n\n`;
  return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'td-synth-keep-'));
  try {
    // 1) Keep tools unchanged on synthesis turn + append user no-tool instruction + return ok:true on text
    const capturedOkPayloads = [];
    let callIdx1 = 0;
    const okRes = await runAgent({
      role: 'router',
      modelOverride: 'ag/gemini-3.8-flash-medium',
      prompt: 'Inspect agent-team/package.json briefly.',
      sessionId: 'synth-keep-ok',
      scope: ['agent-team/package.json'],
      maxTurns: 1,
      sessionsDir: path.join(tmpRoot, 'sess-1'),
      repoRoot: REPO_ROOT,
      baseUrlOverride: 'http://127.0.0.1:20199/v1',
      apiKeyOverride: 'mock-key',
      fetchFn: async (_url, init = {}) => {
        const payload = JSON.parse(String(init.body || '{}'));
        capturedOkPayloads.push(payload);
        callIdx1++;
        if (callIdx1 === 1) {
          return makeSseResponse(
            'gemini-3.8-flash-n',
            {
              role: 'assistant',
              tool_calls: [{
                index: 0,
                id: 'call_list_1',
                type: 'function',
                function: { name: 'list_files', arguments: '{"dir":"agent-team"}' }
              }]
            },
            'tool_calls'
          );
        }
        return makeSseResponse(
          'gemini-3.8-flash-n',
          { role: 'assistant', content: 'Final answer without calling tools.' },
          'stop'
        );
      }
    });

    assert.equal(okRes.ok, true, `Expected runAgent to succeed when synthesis returns text, got: ${JSON.stringify(okRes)}`);
    assert.equal(capturedOkPayloads.length, 2, 'Expected 1 tool turn + 1 synthesis turn');
    const [pTurn1, pSynth] = capturedOkPayloads;
    assert.ok(Array.isArray(pTurn1.tools) && pTurn1.tools.length > 0, 'Turn 1 must send tools');
    assert.deepStrictEqual(
      pSynth.tools,
      pTurn1.tools,
      'Synthesis turn MUST keep identical tools array (must NOT drop tools to null)'
    );

    const lastUserMsg = pSynth.messages[pSynth.messages.length - 1];
    assert.equal(lastUserMsg.role, 'user', 'Synthesis turn must append a user instruction message');
    assert.match(
      lastUserMsg.content.toLowerCase(),
      /(no tools|not call any tools|without calling tools|do not (call|attempt) any tool)/,
      `Synthesis user message must instruct not calling tools, got: ${lastUserMsg.content}`
    );

    const inv = inspectPayloadPrefixInvariance(capturedOkPayloads);
    assert.equal(
      inv.breaks.filter(b => b.kind === 'tools_dropped').length,
      0,
      `Must have 0 tools_dropped prefix breaks on synthesis turn, got: ${JSON.stringify(inv.breaks)}`
    );

    assert.equal(okRes.cache_lost, false, 'Normal synthesis without tools:null fallback must report cache_lost=false');

    // 2) Batch 171 Item 3 Branch A: Synthesis returns tool_calls -> retry ONCE with tools:null (records cache_lost=true) -> succeeds!
    const capturedRetryOkPayloads = [];
    let callRetryOk = 0;
    const retryOkRes = await runAgent({
      role: 'writer',
      modelOverride: 'ag/gemini-3.8-flash-medium',
      prompt: 'Read agent-team/package.json',
      sessionId: 'synth-retry-ok',
      scope: ['agent-team/package.json'],
      maxTurns: 1,
      sessionsDir: path.join(tmpRoot, 'sess-retry-ok'),
      repoRoot: REPO_ROOT,
      baseUrlOverride: 'http://127.0.0.1:20199/v1',
      apiKeyOverride: 'mock-key',
      fetchFn: async (_url, init = {}) => {
        const payload = JSON.parse(String(init.body || '{}'));
        capturedRetryOkPayloads.push(payload);
        callRetryOk++;
        if (callRetryOk <= 2) {
          return makeSseResponse(
            'gemini-3.8-flash-n',
            {
              role: 'assistant',
              content: '',
              tool_calls: [{
                index: 0,
                id: `call_ok_leak_${callRetryOk}`,
                type: 'function',
                function: { name: callRetryOk === 1 ? 'list_files' : 'read_file', arguments: '{"dir":"agent-team"}' }
              }]
            },
            'tool_calls',
            2600,
            19
          );
        }
        return makeSseResponse(
          'gemini-3.8-flash-n',
          { role: 'assistant', content: 'Recovered final answer after tools:null retry.' },
          'stop',
          2650,
          28
        );
      }
    });

    assert.equal(capturedRetryOkPayloads.length, 3, 'Expected Turn 1 + synthesis(tools) + 1 retry(tools:null)');
    assert.ok(Array.isArray(capturedRetryOkPayloads[1].tools) && capturedRetryOkPayloads[1].tools.length > 0, 'Synthesis turn 1 must keep tools');
    assert.equal(capturedRetryOkPayloads[2].tools, undefined, 'Fallback retry must omit tools (tools: null)');
    assert.equal(retryOkRes.ok, true, `Expected recovery to succeed, got: ${retryOkRes.error}`);
    assert.equal(retryOkRes.cache_lost, true, 'Successful tools:null retry must record cache_lost=true');
    assert.equal(retryOkRes.content, 'Recovered final answer after tools:null retry.');
    assert.equal(retryOkRes.turn_usages?.length, 3);
    assert.equal(retryOkRes.turn_usages[2]?.cache_lost, true);

    // 3) Batch 171 Item 3 Branch B: Synthesis returns tool_calls AND 1x tools:null retry ALSO fails -> controlled_failure
    const capturedFailPayloads = [];
    let callIdx2 = 0;
    const failRes = await runAgent({
      role: 'writer',
      modelOverride: 'ag/gemini-3.8-flash-medium',
      prompt: 'Read agent-team/package.json',
      sessionId: 'synth-keep-toolleak',
      scope: ['agent-team/package.json'],
      maxTurns: 1,
      sessionsDir: path.join(tmpRoot, 'sess-2'),
      repoRoot: REPO_ROOT,
      baseUrlOverride: 'http://127.0.0.1:20199/v1',
      apiKeyOverride: 'mock-key',
      fetchFn: async (_url, init = {}) => {
        const payload = JSON.parse(String(init.body || '{}'));
        capturedFailPayloads.push(payload);
        callIdx2++;
        if (callIdx2 === 1) {
          return makeSseResponse(
            'gemini-3.8-flash-n',
            {
              role: 'assistant',
              tool_calls: [{
                index: 0,
                id: 'call_read_1',
                type: 'function',
                function: { name: 'list_files', arguments: '{"dir":"agent-team"}' }
              }]
            },
            'tool_calls'
          );
        }
        // Synthesis AND tools:null fallback STILL emit tool_calls!
        return makeSseResponse(
          'gemini-3.8-flash-n',
          {
            role: 'assistant',
            content: '',
            tool_calls: [{
              index: 0,
              id: `call_synth_leak_${callIdx2}`,
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"agent-team/package.json"}' }
            }]
          },
          'tool_calls',
          2600,
          19
        );
      }
    });

    assert.equal(capturedFailPayloads.length, 3, 'Must try exactly once with tools:null (3 calls total) before controlled failure');
    assert.equal(capturedFailPayloads[2].tools, undefined, 'Retry call must pass tools: null');
    assert.equal(failRes.ok, false, 'Controlled failure must return ok: false when tools:null retry still fails');
    assert.equal(failRes.controlled_failure, true);
    assert.equal(failRes.failure_reason, 'synthesis_unexpected_tool_call');
    assert.equal(failRes.nonRetryable, true);
    assert.equal(failRes.cache_lost, true);
    assert.deepStrictEqual(failRes.unexpected_tool_calls, ['read_file']);
    assert.match(String(failRes.error || ''), /synthesis|tool call/i);
    assert.equal(failRes.turn_usages?.length, 3, 'Turn 1, synthesis, and tools:null retry usages must all be recorded');

    // 4) decomposeGoal propagates synthesis controlled failure + cache_lost cleanly without infinite retry
    let gpCalls = 0;
    const gpRes = await decomposeGoal(
      'Refactor module zzz_unlikely_keyword_xyz_999',
      {
        dryRun: true,
        oneTurnMode: false,
        maxTurns: 1,
        repoRoot: REPO_ROOT,
        sessionsDir: path.join(tmpRoot, 'sess-gp'),
        baseUrlOverride: 'http://127.0.0.1:20199/v1',
        apiKeyOverride: 'mock-key',
        fetchFn: async () => {
          gpCalls++;
          return makeSseResponse(
            'gemini-3.8-flash-n',
            {
              role: 'assistant',
              tool_calls: [{
                index: 0,
                id: `gp_tc_${gpCalls}`,
                type: 'function',
                function: { name: 'list_files', arguments: '{"dir":"core"}' }
              }]
            },
            'tool_calls'
          );
        }
      }
    );
    assert.equal(gpCalls, 3, 'Expected Turn 1 + synthesis(tools) + 1 fallback(tools:null) and immediate controlled abort');
    assert.equal(gpRes.ok, false);
    assert.equal(gpRes.controlled_failure, true);
    assert.equal(gpRes.failure_reason, 'synthesis_unexpected_tool_call');
    assert.equal(gpRes.cache_lost, true);

    console.log('ALL SYNTHESIS TOOLS-KEEP & 1X TOOLS:NULL FALLBACK TESTS PASSED (4/4)');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function runLiveSynthesisProbe() {
  const teamCfg = loadMergedTeamConfig({ configDir: resolveConfigDir() });
  const endpoint = teamCfg?.providers?.ninerouter?.base_url || 'http://127.0.0.1:20128/v1';
  const apiKey = resolveApiKey(teamCfg);
  const nineRouterVer = readInstalled9RouterVersion().version || null;
  const modelsResp = await fetch(`${endpoint.replace(/\/+$/, '')}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(3000)
  });
  if (!modelsResp.ok) {
    throw new Error(`9Router healthcheck failed at ${endpoint}/models: HTTP ${modelsResp.status}`);
  }

  const probeTools = [TOOL_SCHEMAS.list_files];
  const probeMessages = [
    { role: 'system', content: 'You are concise. Follow user instructions strictly.' },
    { role: 'user', content: 'List files in core and report status.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_synth_live_1',
        type: 'function',
        function: { name: 'list_files', arguments: '{"dir":"core"}' }
      }]
    },
    {
      role: 'tool',
      tool_call_id: 'call_synth_live_1',
      content: JSON.stringify({ files: ['core/downloader.py', 'core/eraser.py'] })
    },
    {
      role: 'user',
      content: 'All tool investigations are complete. Based on what you observed from the tools, immediately respond with just OK. Do not call any tools.'
    }
  ];

  const maxOutput = 64;
  const estPrompt = estimateRequestPromptTokens({ messages: probeMessages, tools: probeTools });
  const worstCasePerReq = estPrompt + maxOutput;
  const claudeCap = 40000;

  console.log('\n[Batch 170 Item 4 Live Pre-Run Worst-Case Budget]');
  console.log(` - Gemini (ag/gemini-3.8-flash-medium): 1 req × (estPrompt=${estPrompt} + maxOutput=${maxOutput}) = ${worstCasePerReq} worst-case tokens (0 Claude cap impact)`);
  console.log(` - Claude (ag/claude-sonnet-5-5):      1 req × (estPrompt=${estPrompt} + maxOutput=${maxOutput}) = ${worstCasePerReq} worst-case tokens (cap=${claudeCap})`);
  assertBudgetBeforeCall({
    used: 0,
    estimatedPrompt: estPrompt,
    maxOutput,
    limit: claudeCap,
    budgetKind: 'batch170_claude_cap'
  });

  const targets = [
    { label: 'Gemini', model: 'ag/gemini-3.8-flash-medium' },
    { label: 'Claude', model: 'ag/claude-sonnet-5-5' }
  ];

  const liveResults = [];
  for (const tgt of targets) {
    const res = await callModelEndpoint({
      baseUrl: endpoint,
      apiKey,
      model: tgt.model,
      messages: probeMessages,
      tools: probeTools,
      maxTokens: maxOutput,
      maxThinkingTokens: 0,
      stream: true,
      timeoutMs: 45000,
      nineRouterVersion: nineRouterVer
    });
    const toolCallsCount = Array.isArray(res.tool_calls) ? res.tool_calls.length : 0;
    const row = {
      label: tgt.label,
      requested_model: tgt.model,
      actual_model: res.actual_model || res.model_used || null,
      ok: res.ok,
      finish_reason: res.finish_reason || null,
      tools_kept: probeTools.length,
      tool_calls_returned: toolCallsCount,
      would_trigger_controlled_failure: toolCallsCount > 0,
      prompt_tokens_raw: res.usage?.prompt_tokens_raw ?? res.usage?.prompt_tokens ?? null,
      prompt_tokens_adjusted: res.usage?.prompt_tokens_adjusted ?? res.usage?.prompt_tokens ?? null,
      fresh_tokens: res.usage?.fresh_tokens ?? res.usage?.uncached_input_tokens ?? null,
      cached_tokens: res.usage?.cached_tokens ?? null,
      completion_tokens: res.usage?.completion_tokens ?? null,
      content_preview: String(res.content || '').slice(0, 80),
      error: res.error || null
    };
    liveResults.push(row);
    console.log(`[Live Synthesis ${tgt.label}]`, JSON.stringify(row));
    assert.equal(res.ok, true, `${tgt.label} live request failed: ${res.error}`);
  }
  return liveResults;
}

main()
  .then(async () => {
    if (IS_LIVE) {
      await runLiveSynthesisProbe();
    }
  })
  .catch(err => {
    console.error('[FAIL]', err);
    process.exit(1);
  });
