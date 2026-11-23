#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
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
    buckets[0].estimated_output_tokens < 16384 * 0.6,
    `Merged backend bucket output (${buckets[0].estimated_output_tokens}) must stay < 60% of 16384`
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
  assert.match(buckets[0].bucket_grouping_reason, /< ?60%|merged|companion/i);
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

// 4. Orchestrator records bucket_grouping_reason into steps[]
const orchSrc = fs.readFileSync(path.join(__dirname, 'orchestrator.mjs'), 'utf8');
assert.match(orchSrc, /bucket_grouping_reason/, 'orchestrator.mjs must record bucket_grouping_reason telemetry in steps[]');

console.log('test-bucket-merge-by-output-budget.mjs: ALL PASSED');
