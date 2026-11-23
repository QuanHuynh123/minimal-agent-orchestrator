import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  analyzeGeminiPromptTokenVariance,
  diffJsonPayloads,
  inspectLocal9RouterRequestLogs
} from './lib/gemini-usage-diff.mjs';

function testExactBatch165VarianceDecomposition() {
  const explained = analyzeGeminiPromptTokenVariance([
    {
      prompt_tokens: 3794,
      completion_tokens: 2,
      total_tokens: 3796,
      completion_tokens_details: { reasoning_tokens: 24 }
    },
    {
      prompt_tokens: 3786,
      completion_tokens: 2,
      total_tokens: 3788,
      completion_tokens_details: { reasoning_tokens: 16 }
    }
  ]);

  assert.equal(explained.sample_count, 2);
  assert.equal(explained.prompt_tokens_varied, true);
  assert.equal(explained.prompt_tokens_min, 3786);
  assert.equal(explained.prompt_tokens_max, 3794);
  assert.equal(explained.base_prompt_invariant, true);
  assert.equal(explained.inferred_base_prompt_tokens, 3770);
  assert.equal(explained.explained_by_thoughts_in_prompt_tokens, true);

  // Genuine prompt-size drift must NOT be misattributed to thoughtsTokenCount
  const unexplained = analyzeGeminiPromptTokenVariance([
    { prompt_tokens: 3810, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 24 } },
    { prompt_tokens: 3786, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 16 } }
  ]);
  assert.equal(unexplained.base_prompt_invariant, false);
  assert.equal(unexplained.explained_by_thoughts_in_prompt_tokens, false);
  console.log('[OK] gemini prompt_tokens vs reasoning_tokens decomposition passed');
}

function testJsonPayloadDiffClassification() {
  const payload1 = {
    project: 'proj-1',
    model: 'gemini-3.8-flash-medium',
    userAgent: 'antigravity',
    requestId: 'agent/conv-1/1700000001000/traj-1/1',
    request: {
      systemInstruction: { parts: [{ text: 'SYSTEM_PREFIX_IDENTICAL' }] },
      contents: [{ role: 'user', parts: [{ text: 'Reply OK.' }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 32 },
      sessionId: 'sess-alpha'
    }
  };
  const payload2SamePrefix = {
    ...payload1,
    requestId: 'agent/conv-1/1700000002500/traj-1/1',
    request: {
      ...payload1.request,
      sessionId: 'sess-beta'
    }
  };

  const endDiff = diffJsonPayloads(payload1, payload2SamePrefix);
  assert.equal(endDiff.identical, false);
  assert.equal(endDiff.request_prefix_changed, false);
  assert.equal(endDiff.change_position, 'envelope_or_end');
  assert.deepEqual(endDiff.changed_paths.sort(), ['$.request.sessionId', '$.requestId'].sort());

  const payload3ChangedPrefix = {
    ...payload1,
    request: {
      ...payload1.request,
      systemInstruction: { parts: [{ text: 'MUTATED_AT_START SYSTEM_PREFIX_IDENTICAL' }] }
    }
  };
  const topDiff = diffJsonPayloads(payload1, payload3ChangedPrefix);
  assert.equal(topDiff.identical, false);
  assert.equal(topDiff.request_prefix_changed, true);
  assert.equal(topDiff.change_position, 'prefix_top');
  console.log('[OK] JSON payload diff position classification passed');
}

function testLocal9RouterLogInspection() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), '9r-log-inspect-'));
  try {
    const emptyRes = inspectLocal9RouterRequestLogs([tmpDir]);
    assert.equal(emptyRes.logs_available, false);
    assert.equal(emptyRes.upstream_payloads_found, 0);
    assert.equal(emptyRes.pair_diff, null);

    const s1 = path.join(tmpDir, 'antigravity_gemini_20261116_010000_001');
    const s2 = path.join(tmpDir, 'antigravity_gemini_20261116_010002_002');
    fs.mkdirSync(s1, { recursive: true });
    fs.mkdirSync(s2, { recursive: true });

    const baseTarget = {
      body: {
        requestId: 'agent/c/100/t/1',
        request: {
          systemInstruction: { parts: [{ text: 'PREFIX' }] },
          contents: [{ role: 'user', parts: [{ text: 'OK' }] }],
          sessionId: 's1'
        }
      }
    };
    const nextTarget = {
      body: {
        requestId: 'agent/c/200/t/1',
        request: {
          systemInstruction: { parts: [{ text: 'PREFIX' }] },
          contents: [{ role: 'user', parts: [{ text: 'OK' }] }],
          sessionId: 's1'
        }
      }
    };
    fs.writeFileSync(path.join(s1, '4_req_target.json'), JSON.stringify(baseTarget), 'utf8');
    fs.writeFileSync(path.join(s2, '4_req_target.json'), JSON.stringify(nextTarget), 'utf8');

    const populated = inspectLocal9RouterRequestLogs([tmpDir]);
    assert.equal(populated.logs_available, true);
    assert.equal(populated.upstream_payloads_found, 2);
    assert.equal(populated.pair_diff.request_prefix_changed, false);
    assert.equal(populated.pair_diff.change_position, 'envelope_or_end');
    console.log('[OK] local 9Router upstream log inspection passed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function main() {
  testExactBatch165VarianceDecomposition();
  testJsonPayloadDiffClassification();
  testLocal9RouterLogInspection();
  console.log('[PASS] test-gemini-usage-diff');
}

main();
