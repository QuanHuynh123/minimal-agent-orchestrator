#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeDynamicTaskTokenBudget,
  partitionScopeByDomain,
  splitPatchStepsByOutputBudget
} from './lib/risk-policy.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function writeSyntheticRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-bucket-merge-'));
  for (const [rel, sizeBytes] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '# ' + 'x'.repeat(Math.max(10, sizeBytes - 2)), 'utf8');
  }
  return dir;
}

// 1. Medium same-domain Backend files (core/history.py 1.6KB + ui_bridge/js_api.py 18KB) + large Frontend + Test:
// Must MERGE core/history.py + ui_bridge/js_api.py into ONE backend bucket (< 60% of 16,384 max_tokens),
// keep Frontend ui_web/index.html separate with bridge AST handoff, and keep tests/test_ui_bridge.py separate.
const repoMedium = writeSyntheticRepo({
  'core/history.py': 1623,
  'ui_bridge/js_api.py': 18 * 1024,
  'ui_web/index.html': 120 * 1024,
  'tests/test_ui_bridge.py': 31 * 1024
});
try {
  const scope = ['core/history.py', 'ui_bridge/js_api.py', 'ui_web/index.html', 'tests/test_ui_bridge.py'];
  const part = partitionScopeByDomain(scope);
  const rawSteps = [
    {
      step: 2,
      role: 'writer',
      model: 'deepseek-v4.1-flash',
      domain: 'fullstack',
      action: 'apply_patch',
      sub_scope: scope
    }
  ];

  const buckets = splitPatchStepsByOutputBudget(rawSteps, repoMedium, {
    maxBucketBytes: 55 * 1024,
    maxOutputTokens: 16384
  });

  // Assert Backend bucket merged BOTH core/history.py and ui_bridge/js_api.py!
  assert.equal(buckets.length, 3, `Expected 3 buckets (merged backend, frontend, test), got ${buckets.length}: ${JSON.stringify(buckets.map(b => b.sub_scope))}`);
  assert.deepEqual(
    buckets[0].sub_scope,
    ['core/history.py', 'ui_bridge/js_api.py'],
    'Backend files under 60% output ceiling must merge instead of splitting 1 file = 1 bucket'
  );
  assert.deepEqual(buckets[1].sub_scope, ['ui_web/index.html']);
  assert.deepEqual(
    buckets[1].inject_updated_repo_map_from,
    ['core/history.py', 'ui_bridge/js_api.py'],
    'Frontend bucket must receive live AST bridge signatures from merged backend bucket'
  );
  assert.deepEqual(buckets[2].sub_scope, ['tests/test_ui_bridge.py']);

  // Every bucket must record bucket_grouping_reason, estimated_output_tokens, and output_token_limit
  for (const b of buckets) {
    assert.ok(typeof b.bucket_grouping_reason === 'string' && b.bucket_grouping_reason.length > 0, 'Missing bucket_grouping_reason');
    assert.ok(Number.isFinite(b.estimated_output_tokens) && b.estimated_output_tokens > 0, 'Missing estimated_output_tokens');
    assert.equal(b.output_token_limit, 16384);
  }
  assert.ok(
    buckets[0].estimated_output_tokens < 16384 * 0.45,
    `Merged backend bucket output (${buckets[0].estimated_output_tokens}) must stay < 45% of 16384`
  );
  assert.deepEqual(part.backendScope, ['core/history.py', 'ui_bridge/js_api.py']);
} finally {
  fs.rmSync(repoMedium, { recursive: true, force: true });
}

// 2. Real Run #2 proportions: core/history.py (1.6KB tiny companion) + ui_bridge/js_api.py (72KB) + tests/test_ui_bridge.py (31KB)
// Must NOT waste an entire AI round-trip just for a 51-line 1.6KB file when combined output estimate is < 60% of 16,384.
const repoRealProportions = writeSyntheticRepo({
  'core/history.py': 1623,
  'ui_bridge/js_api.py': 71911,
  'tests/test_ui_bridge.py': 31385
});
try {
  const rawSteps = [
    {
      step: 2,
      role: 'writer',
      model: 'deepseek-v4.1-flash',
      domain: 'backend',
      action: 'apply_patch',
      sub_scope: ['core/history.py', 'ui_bridge/js_api.py']
    },
    {
      step: 3,
      role: 'writer',
      model: 'gemini-3.8-flash-medium',
      domain: 'frontend',
      action: 'apply_patch',
      sub_scope: ['tests/test_ui_bridge.py'],
      inject_updated_repo_map_from: ['core/history.py', 'ui_bridge/js_api.py']
    }
  ];

  const buckets = splitPatchStepsByOutputBudget(rawSteps, repoRealProportions, {
    maxBucketBytes: 55 * 1024,
    maxOutputTokens: 16384
  });
  assert.equal(buckets.length, 2, `Tiny companion (1.6KB) + js_api.py (72KB) must merge into 1 backend bucket + 1 test bucket, got ${buckets.length}: ${JSON.stringify(buckets.map(b => b.sub_scope))}`);
  assert.deepEqual(buckets[0].sub_scope, ['core/history.py', 'ui_bridge/js_api.py']);
  assert.match(buckets[0].bucket_grouping_reason, /< ?45%|merged|companion/i);
  assert.deepEqual(buckets[1].sub_scope, ['tests/test_ui_bridge.py']);
} finally {
  fs.rmSync(repoRealProportions, { recursive: true, force: true });
}

// 3. Large multi-file backend (> 60% output ceiling / multiple large >35KB files) STILL splits cleanly
const repoHeavy = writeSyntheticRepo({
  'core/eraser.py': 58 * 1024,
  'ui_bridge/js_api.py': 78 * 1024,
  'tests/test_eraser.py': 40 * 1024
});
try {
  const heavyBuckets = splitPatchStepsByOutputBudget([
    {
      step: 2,
      role: 'writer',
      model: 'deepseek-v4.1-flash',
      domain: 'backend',
      action: 'apply_patch',
      sub_scope: ['core/eraser.py', 'ui_bridge/js_api.py', 'tests/test_eraser.py']
    }
  ], repoHeavy, { maxBucketBytes: 55 * 1024, maxOutputTokens: 16384 });
  assert.equal(heavyBuckets.length, 3, 'Two >35KB large files + test file must still split into 3 buckets');
  assert.deepEqual(heavyBuckets[0].sub_scope, ['core/eraser.py']);
  assert.deepEqual(heavyBuckets[1].sub_scope, ['ui_bridge/js_api.py']);
  assert.deepEqual(heavyBuckets[2].sub_scope, ['tests/test_eraser.py']);
  assert.ok(heavyBuckets.every(b => typeof b.bucket_grouping_reason === 'string' && b.bucket_grouping_reason.length > 0));
} finally {
  fs.rmSync(repoHeavy, { recursive: true, force: true });
}

// 4. 3-file ~51KB task (8105-A2b proportions: 15KB + 21KB + 15KB) must split into 2 buckets under 0.45 threshold
const repoThreeFiles51k = writeSyntheticRepo({
  'core/key_cards.py': 15 * 1024,
  'core/analysis.py': 21 * 1024,
  'tests/test_competitor_analysis.py': 15 * 1024
});
try {
  const split51k = splitPatchStepsByOutputBudget([
    {
      step: 2,
      role: 'writer',
      model: 'deepseek-v4.1-flash',
      domain: 'backend',
      action: 'apply_patch',
      sub_scope: ['core/key_cards.py', 'core/analysis.py', 'tests/test_competitor_analysis.py']
    }
  ], repoThreeFiles51k, { maxBucketBytes: 55 * 1024, maxOutputTokens: 16384 });
  assert.equal(
    split51k.length,
    2,
    `3-file 51KB task must split into 2 buckets under 0.45 ceiling, got ${split51k.length}: ${JSON.stringify(split51k.map(b => b.sub_scope))}`
  );
  assert.deepEqual(split51k[0].sub_scope, ['core/key_cards.py', 'core/analysis.py']);
  assert.deepEqual(split51k[1].sub_scope, ['tests/test_competitor_analysis.py']);

  // 4b. Cross-module check: splitPatchStepsByOutputBudget -> computeDynamicTaskTokenBudget raises 480k -> 640k
  const baseProdPolicy = {
    policy: {
      approval_gates: { require_code_review: true },
      retry_and_escalation: {
        base_token_budget_per_agent: 150000,
        token_budget_per_task: 300000
      }
    }
  };
  const mediumTask = {
    task_id: 'T-BUDGET-SPLIT',
    mode: 'standard',
    risk_level: 'medium',
    scope: ['core/key_cards.py', 'core/analysis.py', 'tests/test_competitor_analysis.py']
  };
  const preSplitWorkflow = [
    { step: 1, action: 'draft_spec' },
    { step: 2, action: 'apply_patch', sub_scope: mediumTask.scope }
  ];
  const postSplitWorkflow = [
    ...preSplitWorkflow.filter(s => s.action !== 'apply_patch'),
    ...split51k
  ];
  const preSplitBudget = computeDynamicTaskTokenBudget(mediumTask, preSplitWorkflow, baseProdPolicy);
  const postSplitBudget = computeDynamicTaskTokenBudget(mediumTask, postSplitWorkflow, baseProdPolicy);
  assert.equal(preSplitBudget, 480000, `1 bucket (medium) must have ceiling 480,000, got ${preSplitBudget}`);
  assert.equal(postSplitBudget, 640000, `2 buckets (medium) after split must raise ceiling to 640,000, got ${postSplitBudget}`);

  // Many buckets must be hard-capped at 1,200,000 safety ceiling
  const manyBucketsWorkflow = [
    { step: 1, action: 'draft_spec' },
    ...Array.from({ length: 10 }, (_, idx) => ({ step: idx + 2, action: 'apply_patch' }))
  ];
  const cappedMedium = computeDynamicTaskTokenBudget(mediumTask, manyBucketsWorkflow, baseProdPolicy);
  const cappedHigh = computeDynamicTaskTokenBudget({ ...mediumTask, risk_level: 'high' }, manyBucketsWorkflow, baseProdPolicy);
  assert.equal(cappedMedium, 1200000, `Many buckets (medium) must cap at 1,200,000, got ${cappedMedium}`);
  assert.equal(cappedHigh, 1200000, `Many buckets (high) must cap at 1,200,000, got ${cappedHigh}`);

  // Explicit policy.retry_and_escalation.max_token_budget_per_task must override defaultMaxCeiling
  const overridePolicy = {
    policy: {
      approval_gates: { require_code_review: true },
      retry_and_escalation: {
        base_token_budget_per_agent: 150000,
        token_budget_per_task: 300000,
        max_token_budget_per_task: 520000
      }
    }
  };
  assert.equal(
    computeDynamicTaskTokenBudget(mediumTask, postSplitWorkflow, overridePolicy),
    520000,
    'Explicit max_token_budget_per_task in policy must override defaultMaxCeiling'
  );
} finally {
  fs.rmSync(repoThreeFiles51k, { recursive: true, force: true });
}

// 5. Orchestrator records bucket_grouping_reason, failed_truncated, failed_provider & recomputes dynamicTaskBudget after split
const orchSrc = fs.readFileSync(path.join(__dirname, 'orchestrator.mjs'), 'utf8');
assert.match(orchSrc, /bucket_grouping_reason/, 'orchestrator.mjs must record bucket_grouping_reason telemetry in steps[]');
assert.match(orchSrc, /status:\s*'failed_truncated'/, 'orchestrator.mjs must record failed_truncated step telemetry before breaking on finish_reason=length');
assert.match(orchSrc, /status:\s*'failed_provider'/, 'orchestrator.mjs must record failed_provider step telemetry before breaking on !writerRes.ok');
assert.match(orchSrc, /let dynamicTaskBudget\s*=/, 'orchestrator.mjs must declare dynamicTaskBudget as let for post-split recomputation');
assert.match(orchSrc, /Dynamic token budget raised after bucket split/, 'orchestrator.mjs must recompute and log dynamicTaskBudget after splitPatchStepsByOutputBudget');

console.log('test-bucket-merge-by-output-budget.mjs: ALL PASSED');
