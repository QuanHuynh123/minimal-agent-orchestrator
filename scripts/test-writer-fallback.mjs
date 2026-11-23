#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as riskPolicy from './lib/risk-policy.mjs';
import { recordTaskStep } from './lib/task-persistence.mjs';

console.log('Testing Item 2: Fallback triggers, no fallback on validation failure, steps[] telemetry, anti-self-review...\n');

assert.equal(
  typeof riskPolicy.resolveWriterSelection,
  'function',
  'risk-policy.mjs must export resolveWriterSelection'
);

const teamCfg = {
  roles: {
    writer: {
      enabled: true,
      model: 'deepseek-v4.1',
      default_model: 'deepseek-v4.1',
      models: ['deepseek-v4.1', 'ag/claude-opus-5-5-medium', 'ag/gemini-3.8-flash-medium'],
      fallback_model: 'ag/claude-opus-5-5-medium'
    },
    reviewer: {
      enabled: true,
      model: 'ag/claude-opus-5-5-medium'
    }
  }
};

// 1a. Normal primary selection
const selPrimary = riskPolicy.resolveWriterSelection({ task_id: 'T-1', scope: ['core/a.py'] }, teamCfg);
assert.equal(selPrimary.ok, true);
assert.equal(selPrimary.selected_by, 'primary');
assert.equal(selPrimary.requested_model, 'deepseek-v4.1');
assert.equal(selPrimary.actual_model, 'deepseek-v4.1');
assert.ok(selPrimary.reason);

// 1b. Preflight failed -> fallback
const selPreflight = riskPolicy.resolveWriterSelection(
  { task_id: 'T-2', scope: ['core/a.py'] },
  teamCfg,
  { preflightFailedModels: new Set(['deepseek-v4.1']) }
);
assert.equal(selPreflight.ok, true);
assert.equal(selPreflight.selected_by, 'fallback');
assert.equal(selPreflight.requested_model, 'deepseek-v4.1');
assert.equal(selPreflight.actual_model, 'ag/claude-opus-5-5-medium');
assert.match(selPreflight.reason, /preflight/i);

// 1c. Model disabled in config -> fallback
const teamDisabled = structuredClone(teamCfg);
teamDisabled.roles.writer.disabled_models = [{ id: 'deepseek-v4.1', disabled: true }];
const selDisabled = riskPolicy.resolveWriterSelection({ task_id: 'T-3', scope: ['core/a.py'] }, teamDisabled);
assert.equal(selDisabled.ok, true);
assert.equal(selDisabled.selected_by, 'fallback');
assert.equal(selDisabled.requested_model, 'deepseek-v4.1');
assert.equal(selDisabled.actual_model, 'ag/claude-opus-5-5-medium');
assert.match(selDisabled.reason, /disabled/i);

// 1d. Circuit breaker -> fallback
const selCB = riskPolicy.resolveWriterSelection(
  { task_id: 'T-4', scope: ['core/a.py'] },
  teamCfg,
  { isCircuitBrokenFn: (m) => m === 'deepseek-v4.1' }
);
assert.equal(selCB.ok, true);
assert.equal(selCB.selected_by, 'fallback');
assert.equal(selCB.requested_model, 'deepseek-v4.1');
assert.equal(selCB.actual_model, 'ag/claude-opus-5-5-medium');
assert.match(selCB.reason, /circuit/i);

// 1e. Provider error during dispatch -> fallback
assert.equal(
  typeof riskPolicy.resolveRuntimeWriterFallback,
  'function',
  'risk-policy.mjs must export resolveRuntimeWriterFallback'
);
const selProvErr = riskPolicy.resolveRuntimeWriterFallback({
  selection: selPrimary,
  providerError: 'HTTP 502 Bad Gateway',
  teamConfig: teamCfg
});
assert.equal(selProvErr.ok, true);
assert.equal(selProvErr.selected_by, 'fallback');
assert.equal(selProvErr.requested_model, 'deepseek-v4.1');
assert.equal(selProvErr.actual_model, 'ag/claude-opus-5-5-medium');
assert.match(selProvErr.reason, /provider|502/i);

// 2. Validation failure MUST NOT trigger fallback
const selAfterValFail = riskPolicy.resolveWriterSelection(
  { task_id: 'T-5', scope: ['core/a.py'], last_error: 'fast_checks failed: AssertionError', last_failure_stage: 'validate' },
  teamCfg,
  { failureStage: 'validate' }
);
assert.equal(selAfterValFail.selected_by, 'primary', 'Validation failure must NOT switch to fallback');
assert.equal(selAfterValFail.actual_model, 'deepseek-v4.1');
const valFallbackAttempt = riskPolicy.resolveRuntimeWriterFallback({
  selection: selPrimary,
  failureStage: 'validate',
  providerError: null,
  teamConfig: teamCfg
});
assert.equal(valFallbackAttempt.ok, false, 'resolveRuntimeWriterFallback must refuse fallback on validation failure');

// 3. steps[] records selected_by, requested_model, actual_model, reason
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-wf-step-'));
try {
  const taskObj = { task_id: 'T-STEP-1', mode: 'standard', steps: [] };
  const entry = recordTaskStep(
    taskObj,
    {
      step: '2.1',
      attempt: 1,
      role: 'writer',
      action: 'apply_patch',
      selected_by: 'fallback',
      requested_model: 'deepseek-v4.1',
      actual_model: 'ag/claude-opus-5-5-medium',
      reason: 'circuit_breaker: HTTP 404',
      fallback_activated: true,
      fallback_reason: 'circuit_breaker: HTTP 404'
    },
    { teamDir: tmpDir, skipJsonl: true }
  );
  assert.equal(entry.selected_by, 'fallback');
  assert.equal(entry.requested_model, 'deepseek-v4.1');
  assert.equal(entry.actual_model, 'ag/claude-opus-5-5-medium');
  assert.equal(entry.reason, 'circuit_breaker: HTTP 404');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// 4. Anti-Self-Review invariant when fallback model == Reviewer (even if force_ai_review is true)
const highTask = { task_id: 'T-REV-1', mode: 'standard', risk_level: 'high', scope: ['core/a.py'] };
assert.equal(
  riskPolicy.shouldRunReviewerGate(highTask, { approval_gates: { require_code_review: true, review_min_risk_level: 'high' } }, teamCfg.roles, 'deepseek-v4.1'),
  true
);
assert.equal(
  riskPolicy.shouldRunReviewerGate(highTask, { approval_gates: { require_code_review: true, review_min_risk_level: 'high' } }, teamCfg.roles, 'ag/claude-opus-5-5-medium'),
  false,
  'Anti-self-review must skip reviewer when fallback writer == reviewer'
);
assert.equal(
  riskPolicy.shouldRunReviewerGate({ ...highTask, force_ai_review: true }, { approval_gates: { require_code_review: true, review_min_risk_level: 'high' } }, teamCfg.roles, 'ag/claude-opus-5-5-medium'),
  false,
  'Anti-self-review must still skip self-review even with force_ai_review=true'
);

console.log('✓ Item 2 tests PASSED!');
