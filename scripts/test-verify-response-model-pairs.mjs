#!/usr/bin/env node
/**
 * Verifies strict verifyResponseModel matching (Item 1 - Third Cleanup):
 * - No arbitrary substring `.includes()` matching
 * - Strips only standard reasoning/effort suffixes (-high, -medium, -low, -minimal, -thinking)
 * - Uses `policy.execution_guardrails.model_aliases` (from policy.yaml / options)
 * - Emits `warning: "model_alias_mismatch"` when unmatched
 */
import assert from 'node:assert/strict';

import { mergePolicyWithDefaults, verifyResponseModel } from './lib/risk-policy.mjs';
import { loadMergedPolicy } from './lib/policy-loader.mjs';
import { call9Router } from './lib/client-9router.mjs';

async function main() {
  // 0. Default strict_model_match and model_aliases (empty in code defaults, configured in policy.yaml)
  const baseDefaults = mergePolicyWithDefaults({});
  assert.equal(baseDefaults.execution_guardrails.strict_model_match, true);
  assert.deepEqual(
    baseDefaults.execution_guardrails.model_aliases,
    {},
    'DEFAULT_POLICY_CONFIG must keep model_aliases empty without hardcoded model IDs'
  );

  const livePolicy = loadMergedPolicy();
  assert.equal(livePolicy.policy.execution_guardrails.strict_model_match, true);
  assert.equal(
    livePolicy.policy.execution_guardrails.model_aliases?.['ag/gemini-3.8-flash-medium'],
    'gemini-3.8-flash-n',
    'policy.yaml must configure model_aliases for ag/gemini-3.8-flash-medium'
  );

  // 1. Exact & reasoning-effort suffix pair matches
  const exactRes = verifyResponseModel(
    'Deepseek V4.1 Flash/deepseek-ai/deepseek-v4.1-flash-1017',
    'deepseek-ai/deepseek-v4.1-flash-1017'
  );
  assert.equal(exactRes.match, true);

  const claudeSuffixRes = verifyResponseModel('ag/claude-sonnet-5-5', 'claude-sonnet-5-5-high');
  assert.equal(claudeSuffixRes.match, true, `Expected reasoning suffix match for claude-sonnet-5-5 vs -high: ${JSON.stringify(claudeSuffixRes)}`);

  // 2. Alias pair from policy model_aliases matches when configured, warns model_alias_mismatch when absent
  const geminiAliasHit = verifyResponseModel('ag/gemini-3.8-flash-medium', 'gemini-3.8-flash-n', {
    policyConfig: livePolicy
  });
  assert.equal(geminiAliasHit.match, true, `Configured model_aliases must match ag/gemini-3.8-flash-medium -> gemini-3.8-flash-n: ${JSON.stringify(geminiAliasHit)}`);

  const customAliasHit = verifyResponseModel('vendor/model-alpha-medium', 'upstream-alpha-v1', {
    modelAliases: { 'vendor/model-alpha-medium': 'upstream-alpha-v1' }
  });
  assert.equal(customAliasHit.match, true, 'Custom modelAliases table must match configured alias pair');

  const geminiAliasMissWithoutTable = verifyResponseModel('ag/gemini-3.8-flash-medium', 'gemini-3.8-flash-n', {
    modelAliases: {}
  });
  assert.equal(geminiAliasMissWithoutTable.match, false, 'Unconfigured alias pair must NOT silently match without table entry');
  assert.equal(geminiAliasMissWithoutTable.warning, 'model_alias_mismatch');
  assert.match(geminiAliasMissWithoutTable.reason, /model_alias_mismatch/);

  // 3. Previously false-positive substring pairs MUST be rejected cleanly with model_alias_mismatch
  const flashVsLite = verifyResponseModel('ag/gemini-3.8-flash', 'gemini-3.8-flash-lite', {
    policyConfig: livePolicy
  });
  assert.equal(flashVsLite.match, false, 'gemini-3.8-flash must NOT falsely match gemini-3.8-flash-lite');
  assert.equal(flashVsLite.warning, 'model_alias_mismatch');

  const claude5Vs55 = verifyResponseModel('ag/claude-sonnet-5', 'claude-sonnet-5-5', {
    policyConfig: livePolicy
  });
  assert.equal(claude5Vs55.match, false, 'claude-sonnet-5 must NOT falsely match claude-sonnet-5-5');
  assert.equal(claude5Vs55.warning, 'model_alias_mismatch');

  // 4. call9Router propagates model_aliases and rejects unmapped false-positive pairs when strictModelMatch is active
  const callOk = await call9Router('ag/gemini-3.8-flash-medium', 'sys', 'usr', 64, null, 0, {
    policyConfig: livePolicy,
    fetchFn: async () => new Response(
      JSON.stringify({
        id: 'ok-alias',
        model: 'gemini-3.8-flash-n',
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  });
  assert.equal(callOk.ok, true);
  assert.equal(callOk.modelMatched, true);

  const callRejected = await call9Router('ag/gemini-3.8-flash', 'sys', 'usr', 64, null, 0, {
    policyConfig: livePolicy,
    fetchFn: async () => new Response(
      JSON.stringify({
        id: 'bad-lite',
        model: 'gemini-3.8-flash-lite',
        choices: [{ index: 0, message: { role: 'assistant', content: 'LITE' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  });
  assert.equal(callRejected.ok, false, 'strictModelMatch must reject gemini-3.8-flash -> gemini-3.8-flash-lite');
  assert.match(String(callRejected.error || ''), /model_alias_mismatch/i);

  console.log('[PASS] test-verify-response-model-pairs');
}

main().catch(err => {
  console.error('[FAIL] test-verify-response-model-pairs:', err);
  process.exit(1);
});
