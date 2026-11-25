import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decomposeGoal } from './goal-planner.mjs';
import { runRouterDryRunLoopBenchmark } from './measure-router-loop.mjs';
import {
  estimatePrefixBreakSavings,
  measureWriterBucketReplayCache
} from './measure-writer-cache.mjs';
import {
  analyzeTurn1PayloadHashes,
  assertPrefixInvariant,
  inspectPayloadPrefixInvariance
} from './lib/prefix-invariant.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AGENT_TEAM_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(AGENT_TEAM_ROOT, '..');
const STRICT_MODE = process.argv.includes('--strict');

function makeJsonFetchResponse(bodyObj) {
  return new Response(JSON.stringify(bodyObj), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function makeSseFetchResponse(deltaPayload) {
  const chunk1 = {
    id: 'chatcmpl-dryrun',
    object: 'chat.completion.chunk',
    model: 'mock/router-model',
    choices: [{ index: 0, delta: deltaPayload, finish_reason: null }]
  };
  const chunk2 = {
    id: 'chatcmpl-dryrun',
    object: 'chat.completion.chunk',
    model: 'mock/router-model',
    choices: [{ index: 0, delta: {}, finish_reason: deltaPayload.tool_calls ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 24, total_tokens: 144 }
  };
  const sseText =
    `data: ${JSON.stringify(chunk1)}\n\n` +
    `data: ${JSON.stringify(chunk2)}\n\n` +
    `data: [DONE]\n\n`;
  return new Response(sseText, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  });
}

function buildCompletionResponse(payload, { content, toolCalls }) {
  if (payload.stream) {
    const delta = { role: 'assistant', content };
    if (toolCalls) {
      delta.tool_calls = toolCalls.map((tc, index) => ({
        index,
        id: tc.id,
        type: 'function',
        function: tc.function
      }));
    }
    return makeSseFetchResponse(delta);
  }
  return makeJsonFetchResponse({
    id: 'chatcmpl-dryrun',
    object: 'chat.completion',
    model: payload.model || 'mock/router-model',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content,
        ...(toolCalls ? { tool_calls: toolCalls } : {})
      },
      finish_reason: toolCalls ? 'tool_calls' : 'stop'
    }],
    usage: { prompt_tokens: 120, completion_tokens: 24, total_tokens: 144 }
  });
}

async function runUnitChecks() {
  // 1) Monotonic append-only prefix with identical tools must pass byte-for-byte
  const cleanPayloads = [
    {
      model: 'mock/m1',
      tools: [{ type: 'function', function: { name: 'list_files', parameters: {} } }],
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'goal' }
      ]
    },
    {
      model: 'mock/m1',
      tools: [{ type: 'function', function: { name: 'list_files', parameters: {} } }],
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'goal' },
        { role: 'assistant', content: '<think>keep</think>', tool_calls: [{ id: 'c1' }] },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' }
      ]
    }
  ];
  const cleanRes = inspectPayloadPrefixInvariance(cleanPayloads);
  assert.equal(cleanRes.ok, true, 'Append-only turn prefix must pass');
  assert.equal(cleanRes.breaks.length, 0);
  assertPrefixInvariant(cleanPayloads, 'clean-unit');

  // 2) Byte mutation on prior message (<think> stripped) must fail and locate exact message index
  const strippedPayloads = [
    cleanPayloads[1],
    {
      model: 'mock/m1',
      tools: cleanPayloads[1].tools,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'goal' },
        { role: 'assistant', content: '[...]', tool_calls: [{ id: 'c1' }] },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' },
        { role: 'assistant', content: '<think>new</think>' }
      ]
    }
  ];
  const strippedRes = inspectPayloadPrefixInvariance(strippedPayloads);
  assert.equal(strippedRes.ok, false);
  assert.equal(strippedRes.breaks.length, 1);
  assert.equal(strippedRes.breaks[0].from_turn, 1);
  assert.equal(strippedRes.breaks[0].to_turn, 2);
  assert.equal(strippedRes.breaks[0].message_index, 2);
  assert.equal(strippedRes.breaks[0].kind, 'inline_thinking_stripped');
  assert.throws(() => assertPrefixInvariant(strippedPayloads, 'stripped-unit'));

  // 3) Dropping tools between turns must fail and flag tools_dropped
  const droppedToolsPayloads = [
    cleanPayloads[1],
    {
      model: 'mock/m1',
      tools: null,
      messages: [
        ...cleanPayloads[1].messages,
        { role: 'assistant', content: 'final' }
      ]
    }
  ];
  const droppedRes = inspectPayloadPrefixInvariance(droppedToolsPayloads);
  assert.equal(droppedRes.ok, false);
  assert.equal(droppedRes.breaks[0].kind, 'tools_dropped');
  assert.equal(droppedRes.breaks[0].from_turn, 1);
  assert.equal(droppedRes.breaks[0].to_turn, 2);
  console.log('[OK] Unit checks passed for inspectPayloadPrefixInvariance');
}

async function runRouterDryRunProbe() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prefix-invariant-'));
  const sessionsDir = path.join(tmpRoot, 'sessions');
  const capturedPayloads = [];
  let turnCounter = 0;

  const fakeFetch = async (url, init = {}) => {
    turnCounter += 1;
    const rawBody = typeof init.body === 'string' ? init.body : '';
    const payload = JSON.parse(rawBody);
    capturedPayloads.push({
      turnIndex: turnCounter,
      url: String(url),
      rawBody,
      payload
    });

    if (turnCounter <= 5) {
      return buildCompletionResponse(payload, {
        content: `<think>Turn ${turnCounter} reasoning trace inside think tag.</think>\nCalling read-only tool.`,
        toolCalls: [{
          id: `call_dry_${turnCounter}`,
          type: 'function',
          function: {
            name: 'list_files',
            arguments: JSON.stringify({ path: 'agent-team/config' })
          }
        }]
      });
    }

    const planJson = JSON.stringify({
      tasks: [{
        title: 'Dry-run prefix audit task',
        goal: 'Inspect Router dry-run prompt prefix behavior without edits',
        mode: 'quick',
        risk_level: 'low',
        scope: ['agent-team/scripts/goal-planner.mjs'],
        acceptance_criteria: ['Report prefix invariance breaks accurately']
      }]
    });
    return buildCompletionResponse(payload, {
      content: `<think>Turn ${turnCounter} synthesis reasoning.</think>\n${planJson}`
    });
  };

  const tmpRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'td-prefix-repo-'));
  fs.mkdirSync(path.join(tmpRepoRoot, 'agent-team', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(tmpRepoRoot, 'ui_web'), { recursive: true });
  fs.mkdirSync(path.join(tmpRepoRoot, 'core'), { recursive: true });
  fs.mkdirSync(path.join(tmpRepoRoot, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(tmpRepoRoot, 'agent-team', 'scripts', 'goal-planner.mjs'), '// stub fixture\nexport function plan() { return true; }\n', 'utf8');
  fs.writeFileSync(path.join(tmpRepoRoot, 'ui_web', 'index.html'), '<div id="eraser-presets"></div><div id="eraser-mode-pills"></div>\n', 'utf8');
  fs.writeFileSync(path.join(tmpRepoRoot, 'core', 'video_studio.py'), '# core Video Studio helper\ndef video_studio():\n\treturn "Video Studio"\n', 'utf8');
  fs.writeFileSync(path.join(tmpRepoRoot, 'tests', 'test_dom_contract.py'), 'def test_ok():\n\tassert True\n', 'utf8');
  fs.writeFileSync(path.join(tmpRepoRoot, 'tests', 'test_video_studio.py'), 'def test_studio():\n\tassert True\n', 'utf8');

  try {
    const planRes = await decomposeGoal(
      'Inspect goal-planner prefix stability across router tool calls',
      {
        dryRun: true,
        oneTurnMode: false,
        repoRoot: tmpRepoRoot,
        sessionsDir,
        baseUrlOverride: 'http://127.0.0.1:20199/v1',
        apiKeyOverride: 'mock-key',
        fetchFn: fakeFetch
      }
    );

    assert.equal(planRes.ok, true, `Expected dry-run decomposeGoal to succeed, got: ${planRes.error}`);
    assert.equal(capturedPayloads.length, 6, `Expected 5 tool turns + 1 synthesis turn = 6 calls, got ${capturedPayloads.length}`);

    const report = inspectPayloadPrefixInvariance(capturedPayloads);
    console.log('\n[Router Dry-Run Prefix Invariance Report]');
    console.log(`Total outbound requests: ${report.total_turns}`);
    console.log(`Prefix invariant ok: ${report.ok}`);
    for (const b of report.breaks) {
      console.log(
        ` - Break Turn ${b.from_turn} -> ${b.to_turn} | kind=${b.kind}` +
        (b.message_index !== undefined ? ` | message_index=${b.message_index}` : '') +
        ` | cause=${b.likely_source} | detail=${b.detail}`
      );
    }

    if (STRICT_MODE) {
      assertPrefixInvariant(capturedPayloads, 'router-dry-run');
    } else {
      assert.equal(
        report.ok,
        false,
        'Expected current unfixed Router loop to fail prefix invariance until stripOldInlineThinking and synthesis tools are addressed'
      );

      // Turn 1 -> 2 has only 1 prior assistant message, so stripOldInlineThinking(messages, 1) keeps it intact
      const t1To2Breaks = report.breaks.filter(b => b.from_turn === 1 && b.to_turn === 2);
      assert.equal(t1To2Breaks.length, 0, 'Turn 1 -> 2 must remain byte-identical before 2nd assistant turn exists');

      // Turn 2 -> 3 triggers stripOldInlineThinking on Turn 1 assistant message (index 2)
      const firstStripBreak = report.breaks.find(
        b => b.from_turn === 2 && b.to_turn === 3 && b.kind === 'inline_thinking_stripped'
      );
      assert.ok(
        firstStripBreak,
        `Expected inline_thinking_stripped at Turn 2 -> 3, got breaks: ${JSON.stringify(report.breaks)}`
      );
      assert.equal(firstStripBreak.message_index, 2);

      // Final synthesis turn (Turn 5 -> 6) MUST keep identical tools (Batch 170 Item 4)
      const synthesisToolsBreak = report.breaks.find(
        b => b.from_turn === 5 && b.to_turn === 6 && b.kind === 'tools_dropped'
      );
      assert.equal(
        synthesisToolsBreak,
        undefined,
        `Synthesis Turn 5 -> 6 must NOT drop tools, got breaks: ${JSON.stringify(report.breaks)}`
      );
      assert.deepStrictEqual(
        capturedPayloads[5].tools,
        capturedPayloads[0].tools,
        'Turn 6 synthesis payload must retain exact same tools array as Turn 1'
      );
    }

    // Batch 166 Item D: decomposeGoal must forward explicit stream: true even for non-ag/* router models
    capturedPayloads.length = 0;
    turnCounter = 0;
    const streamPlanRes = await decomposeGoal(
      'Dọn dẹp Preset Pills và Fix overflow ở Eraser Mode Pills trong ui_web/index.html',
      {
        dryRun: true,
        oneTurnMode: false,
        stream: true,
        repoRoot: tmpRepoRoot,
        sessionsDir: path.join(tmpRoot, 'sessions-stream'),
        baseUrlOverride: 'http://127.0.0.1:20199/v1',
        apiKeyOverride: 'mock-key',
        fetchFn: fakeFetch
      }
    );
    assert.equal(streamPlanRes.ok, true);
    assert.ok(capturedPayloads.length >= 2);
    assert.ok(
      capturedPayloads.every(p => p.payload.stream === true && p.payload.stream_options?.include_usage === true),
      `Expected every decomposeGoal({ stream: true }) outbound request to send stream:true & include_usage:true, got streams=${JSON.stringify(capturedPayloads.map(p => p.payload.stream))}`
    );

    // Smoke check runRouterDryRunLoopBenchmark x3
    const loopReport = await runRouterDryRunLoopBenchmark({
      repetitions: 3,
      repoRoot: tmpRepoRoot,
      sessionsDir: path.join(tmpRoot, 'sessions-loop'),
      baseUrlOverride: 'http://127.0.0.1:20199/v1',
      apiKeyOverride: 'mock-key',
      fetchFn: async (_url, init = {}) => {
        const payload = JSON.parse(String(init.body));
        const planJson = JSON.stringify({
          tasks: [{
            title: 'Mock loop task',
            goal: 'Verify 3x dryRun router loop runner',
            mode: 'quick',
            risk_level: 'low',
            scope: ['ui_web/index.html'],
            acceptance_criteria: ['OK']
          }]
        });
        return buildCompletionResponse(payload, { content: planJson });
      }
    });
    assert.equal(loopReport.repetitions, 3);
    assert.equal(loopReport.runs.length, 3);
    assert.ok(loopReport.runs.every(r => r.ok && r.turns.length >= 1 && r.turns[0].cached_tokens === null));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpRepoRoot, { recursive: true, force: true });
  }
}

async function runTurn1DiagnosisTests() {
  // 1) Synthetic legacy Turn-1 payloads (hermetic committed sample): identify volatile sections appearing before static sections
  const legacyTurn1MsgA = [
    'USER GOAL: Fix bug alpha in core/a.py',
    'ALLOWED DIRECTORIES:\n["core/"]',
    'AVAILABLE SQUAD MODELS:\n["ag/gemini-3.8-flash-medium"]',
    'AVAILABLE WORKSPACE FILES:\n["core/a.py"]',
    'CODEBASE SKELETON & SYMBOL MAP:\ndef fn_a(): pass',
    'INSTRUCTION:\nReturn JSON tasks.'
  ].join('\n\n');
  const legacyTurn1MsgB = [
    'USER GOAL: Fix bug beta in ui_web/index.html',
    'ALLOWED DIRECTORIES:\n["core/"]',
    'AVAILABLE SQUAD MODELS:\n["ag/gemini-3.8-flash-medium"]',
    'AVAILABLE WORKSPACE FILES:\n["core/a.py"]',
    'CODEBASE SKELETON & SYMBOL MAP:\ndef fn_a(): pass',
    'INSTRUCTION:\nReturn JSON tasks.'
  ].join('\n\n');
  const recAnalysis = analyzeTurn1PayloadHashes(
    { model: 'ag/gemini-3.8-flash-medium', messages: [{ role: 'user', content: legacyTurn1MsgA }] },
    { model: 'ag/gemini-3.8-flash-medium', messages: [{ role: 'user', content: legacyTurn1MsgB }] }
  );
  assert.ok(Array.isArray(recAnalysis.parts) && recAnalysis.parts.length >= 2);
  assert.ok(recAnalysis.user_subsections.length >= 3);
  assert.ok(
    recAnalysis.volatile_before_static.length > 0,
    'Legacy Turn-1 payload layout must flag volatile sections preceding static sections'
  );

  // 2) Two consecutive dry-run Turn-1 captures with DIFFERENT goals must place ALL static subsections
  //    strictly before ALL volatile/goal-specific subsections (volatile_before_static === [])
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'turn1-hash-diag-'));
  const tmpRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'turn1-repo-diag-'));
  fs.mkdirSync(path.join(tmpRepoRoot, 'ui_web'), { recursive: true });
  fs.mkdirSync(path.join(tmpRepoRoot, 'core'), { recursive: true });
  fs.mkdirSync(path.join(tmpRepoRoot, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(tmpRepoRoot, 'ui_web', 'index.html'), '<div id="eraser-presets"></div><div id="eraser-mode-pills"></div>\n', 'utf8');
  fs.writeFileSync(path.join(tmpRepoRoot, 'core', 'video_studio.py'), '# core Video Studio helper\ndef video_studio():\n\treturn "Video Studio"\n', 'utf8');
  fs.writeFileSync(path.join(tmpRepoRoot, 'tests', 'test_dom_contract.py'), 'def test_dom():\n\tassert True\n', 'utf8');
  fs.writeFileSync(path.join(tmpRepoRoot, 'tests', 'test_video_studio.py'), 'def test_vs():\n\tassert True\n', 'utf8');
  try {
    const captureTurn1 = async (goalText, tag) => {
      let firstPayload = null;
      const res = await decomposeGoal(goalText, {
        dryRun: true,
        stream: true,
        repoRoot: tmpRepoRoot,
        sessionsDir: path.join(tmpRoot, tag),
        baseUrlOverride: 'http://127.0.0.1:20199/v1',
        apiKeyOverride: 'mock-key',
        fetchFn: async (_url, init = {}) => {
          const payload = JSON.parse(String(init.body || '{}'));
          if (!firstPayload) firstPayload = payload;
          const planJson = JSON.stringify({
            tasks: [{
              title: `Dry-run ${tag}`,
              goal: goalText,
              mode: 'quick',
              risk_level: 'low',
              scope: ['ui_web/index.html'],
              acceptance_criteria: ['OK 1', 'OK 2']
            }]
          });
          return buildCompletionResponse(payload, { content: planJson });
        }
      });
      assert.equal(res.ok, true, `Expected dryRun Turn 1 capture to succeed: ${res.error}`);
      return firstPayload;
    };

    const pSame1 = await captureTurn1(
      'Dọn dẹp cụm #eraser-presets và sửa overflow #eraser-mode-pills trong ui_web/index.html',
      'same-1'
    );
    const pSame2 = await captureTurn1(
      'Dọn dẹp cụm #eraser-presets và sửa overflow #eraser-mode-pills trong ui_web/index.html',
      'same-2'
    );
    const sameDiag = analyzeTurn1PayloadHashes(pSame1, pSame2);
    assert.equal(sameDiag.differing_parts.length, 0, `Same-goal Turn-1 runs must be 100% hash-identical, diffs=${JSON.stringify(sameDiag.differing_parts)}`);
    assert.equal(sameDiag.volatile_before_static.length, 0);

    const pGoalA = pSame1;
    const pGoalB = await captureTurn1(
      'Kiểm tra lõi Video Studio trong core/video_studio.py và cập nhật tests/test_video_studio.py',
      'goal-b'
    );
    const crossDiag = analyzeTurn1PayloadHashes(pGoalA, pGoalB);
    assert.equal(crossDiag.system_hash_equal, true, 'system hash must match across consecutive runs');
    assert.equal(crossDiag.tools_hash_equal, true, 'tools hash must match across consecutive runs');
    assert.equal(crossDiag.messages[0].equal, true, 'messages[0] (system) must match across consecutive runs');

    const skeletonSub = crossDiag.user_subsections.find(s => s.label === 'CODEBASE SKELETON & SYMBOL MAP');
    assert.ok(skeletonSub, 'Turn-1 user prompt must contain CODEBASE SKELETON & SYMBOL MAP subsection');
    assert.equal(
      skeletonSub.equal,
      true,
      'Global CODEBASE SKELETON in Router Turn 1 must be goal-independent so static prefix stays invariant across goals'
    );
    assert.equal(
      crossDiag.volatile_before_static.length,
      0,
      `No volatile section may appear before static sections, got: ${JSON.stringify(crossDiag.volatile_before_static)}`
    );

    const staticOrder = crossDiag.user_subsections.map(s => `${s.equal ? 'STATIC' : 'VOLATILE'}:${s.label}`);
    console.log(`[OK] Turn-1 prefix hash diagnosis passed (${staticOrder.join(' -> ')})`);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpRepoRoot, { recursive: true, force: true });
  }
}

async function runWriterBucketCacheReplayTests() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-cache-replay-'));
  const tmpRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-cache-repo-'));
  fs.mkdirSync(path.join(tmpRepoRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(tmpRepoRoot, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(tmpRepoRoot, 'src', 'cache_store.py'), 'class CacheStore:\n\tpass\n', 'utf8');
  fs.writeFileSync(path.join(tmpRepoRoot, 'src', 'worker.py'), 'from src.cache_store import CacheStore\n', 'utf8');
  fs.writeFileSync(path.join(tmpRepoRoot, 'tests', 'test_cache_store.py'), Array.from({ length: 50 }, (_, i) => `def test_cache_${i}():\n\tassert True`).join('\n') + '\n', 'utf8');
  try {
    let callIdx = 0;
    const mockGeminiFetch = async (_url, init = {}) => {
      callIdx += 1;
      const payload = JSON.parse(String(init.body || '{}'));
      assert.equal(payload.model, 'ag/gemini-3.8-flash-medium', 'Writer replay must use Gemini Flash when specified');

      if (callIdx === 1) {
        return buildCompletionResponse(payload, {
          content: '<think>Check test_cache_store.py first.</think>\nCalling read_file.',
          toolCalls: [{
            id: 'call_w_1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: 'tests/test_cache_store.py', start_line: 1, end_line: 40 })
            }
          }]
        });
      }
      if (callIdx === 2) {
        return buildCompletionResponse(payload, {
          content: '<think>Now check CacheStore callers in src/worker.py.</think>\nCalling search_code.',
          toolCalls: [{
            id: 'call_w_2',
            type: 'function',
            function: {
              name: 'search_code',
              arguments: JSON.stringify({ pattern: 'CacheStore', dir: 'src' })
            }
          }]
        });
      }

      if (callIdx === 3) {
        return buildCompletionResponse(payload, {
          content: '<think>Verify src/cache_store.py symbol references.</think>\nCalling get_repo_map.',
          toolCalls: [{
            id: 'call_w_3',
            type: 'function',
            function: {
              name: 'get_repo_map',
              arguments: JSON.stringify({ scope: ['src/cache_store.py'] })
            }
          }]
        });
      }

      return makeSseFetchResponse({
        role: 'assistant',
        content: 'FILE: src/cache_store.py\n<<<<<<< SEARCH\npass\n=======\npass\n>>>>>>> REPLACE'
      });
    };

    const report = await measureWriterBucketReplayCache({
      repoRoot: tmpRepoRoot,
      sessionsDir: tmpRoot,
      modelOverride: 'ag/gemini-3.8-flash-medium',
      maxTurns: 3,
      nineRouterVersion: '0.5.119',
      fetchFn: mockGeminiFetch
    });

    assert.equal(report.ok, true, `Expected mock writer bucket replay ok, got: ${report.error}`);
    assert.equal(report.model, 'ag/gemini-3.8-flash-medium');
    assert.ok(report.estimated_turn1_tokens <= 8000, `Turn 1 prompt must stay <= 8k tokens, got ${report.estimated_turn1_tokens}`);
    assert.equal(report.captured_turns, 4, `Expected 3 tool turns + 1 synthesis turn = 4 calls, got ${report.captured_turns}`);
    assert.equal(report.turns.length, 4);
    const expectedBuf0 = report.turns[0].prompt_tokens_raw >= 2000 ? 2000 : 0;
    assert.equal(report.turns[0].usage_adjusted_buffer, expectedBuf0, 'Buffer adjustment must match ag/* >=2000 rule');
    assert.equal(report.prefix_invariance.ok, false, 'Unfixed Writer loop must expose prefix invariance breaks');
    assert.ok(
      report.prefix_invariance.breaks.some(b => b.kind === 'inline_thinking_stripped'),
      'Expected inline_thinking_stripped break in multi-turn Writer replay'
    );
    assert.ok(
      !report.prefix_invariance.breaks.some(b => b.kind === 'tools_dropped'),
      'Expected ZERO tools_dropped breaks on Writer synthesis turn after Batch 170 Item 4'
    );
    assert.ok(report.savings_estimate && report.savings_estimate.broken_turns_count >= 1);
    assert.ok(report.savings_estimate.estimated_tokens_saveable_per_run > 0);
    assert.equal(typeof estimatePrefixBreakSavings, 'function');
    console.log(`[OK] Writer bucket cache & prefix break offline replay passed (breaks=${report.prefix_invariance.breaks.length}, saveable~${report.savings_estimate.estimated_tokens_saveable_per_run} tok)`);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpRepoRoot, { recursive: true, force: true });
  }
}

async function main() {
  await runUnitChecks();
  await runRouterDryRunProbe();
  await runTurn1DiagnosisTests();
  await runWriterBucketCacheReplayTests();
  console.log('[PASS] test-prefix-invariant');
}

main().catch(err => {
  console.error('[FAIL] test-prefix-invariant:', err);
  process.exit(1);
});
