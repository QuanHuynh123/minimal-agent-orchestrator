#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as queueState from './lib/queue-state.mjs';

console.log('Testing Item 6: Read-only first-attempt validator pass rate report by (model, domain) with sample counts...\n');

assert.equal(
  typeof queueState.computeFirstAttemptValidationStats,
  'function',
  'queue-state.mjs must export computeFirstAttemptValidationStats'
);

const sampleTasks = [
  // Model A, backend, passed attempt 1
  {
    task_id: 'T-1',
    mode: 'quick',
    status: 'done',
    retries: 0,
    scope: ['core/a.py'],
    last_report: { final_status: 'done', validation_passed: true, retries_used: 0 },
    steps: [
      { attempt: 1, role: 'writer', action: 'apply_patch', actual_model: 'deepseek-v4.1', scope: ['core/a.py'], validation_status: 'passed' }
    ]
  },
  // Model A, backend, failed attempt 1 then passed on retry 2 -> NOT first-attempt pass!
  {
    task_id: 'T-2',
    mode: 'standard',
    status: 'done',
    retries: 1,
    scope: ['core/b.py'],
    last_report: { final_status: 'done', validation_passed: true, retries_used: 1 },
    steps: [
      { attempt: 1, role: 'writer', action: 'apply_patch', actual_model: 'deepseek-v4.1', scope: ['core/b.py'], validation_status: 'failed' },
      { attempt: 2, role: 'writer', action: 'apply_patch', actual_model: 'deepseek-v4.1', scope: ['core/b.py'], validation_status: 'passed' }
    ]
  },
  // Model A, frontend, passed attempt 1
  {
    task_id: 'T-3',
    mode: 'standard',
    status: 'done',
    retries: 0,
    scope: ['ui_web/index.html'],
    last_report: { final_status: 'done', validation_passed: true, retries_used: 0 },
    steps: [
      { attempt: 1, role: 'writer', action: 'apply_patch', actual_model: 'deepseek-v4.1', scope: ['ui_web/index.html'], validation_status: 'passed' }
    ]
  },
  // Model B, backend, blocked
  {
    task_id: 'T-4',
    mode: 'quick',
    status: 'blocked',
    retries: 2,
    scope: ['core/c.py'],
    last_report: { final_status: 'blocked', validation_passed: false, retries_used: 2 },
    steps: [
      { attempt: 1, role: 'writer', action: 'apply_patch', actual_model: 'ag/gemini-3.8-flash-medium', scope: ['core/c.py'], validation_status: 'failed' }
    ]
  },
  // Consult task -> excluded from validator pass stats
  {
    task_id: 'T-5',
    mode: 'consult',
    status: 'done',
    retries: 0,
    scope: [],
    steps: [{ attempt: 1, role: 'designer', action: 'consult', actual_model: 'ag/claude-sonnet-5-5' }]
  }
];

const stats = queueState.computeFirstAttemptValidationStats(sampleTasks);
assert.equal(stats.length, 3, 'Expected 3 (model, domain) buckets');

const dsBe = stats.find(r => r.model === 'deepseek-v4.1' && r.domain === 'backend');
assert.ok(dsBe, 'Expected (deepseek-v4.1, backend) bucket');
assert.equal(dsBe.samples, 2);
assert.equal(dsBe.first_attempt_passed, 1);
assert.equal(dsBe.pass_rate, 0.5);

const dsFe = stats.find(r => r.model === 'deepseek-v4.1' && r.domain === 'frontend');
assert.ok(dsFe, 'Expected (deepseek-v4.1, frontend) bucket');
assert.equal(dsFe.samples, 1);
assert.equal(dsFe.first_attempt_passed, 1);
assert.equal(dsFe.pass_rate, 1);

const gemBe = stats.find(r => r.model === 'ag/gemini-3.8-flash-medium' && r.domain === 'backend');
assert.ok(gemBe, 'Expected (ag/gemini-3.8-flash-medium, backend) bucket');
assert.equal(gemBe.samples, 1);
assert.equal(gemBe.first_attempt_passed, 0);
assert.equal(gemBe.pass_rate, 0);

// Verify writeMorningReportFile renders section with model, domain, pass rate, and sample count (without touching routing)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-val-stats-'));
try {
  const activeDir = path.join(tmpDir, 'tasks', 'active');
  const archiveDir = path.join(tmpDir, 'tasks', 'archive');
  const reportFile = path.join(tmpDir, 'state', 'morning-report.md');
  fs.mkdirSync(activeDir, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(
    path.join(activeDir, 'T-4.yaml'),
    [
      'task:',
      '  task_id: "T-4"',
      '  mode: "quick"',
      '  status: "blocked"',
      '  retries: 2',
      '  scope: ["core/c.py"]',
      '  steps:',
      '    - attempt: 1',
      '      role: "writer"',
      '      action: "apply_patch"',
      '      actual_model: "ag/gemini-3.8-flash-medium"',
      '      scope: ["core/c.py"]',
      '      validation_status: "failed"'
    ].join('\n'),
    'utf8'
  );

  const state = {
    active_tasks: [],
    completed_tasks: sampleTasks.filter(t => t.status === 'done'),
    blocked_tasks: sampleTasks.filter(t => t.status === 'blocked'),
    metrics: { total_input_tokens: 1000, total_output_tokens: 200, total_cost_est_usd: 0.01 }
  };

  queueState.writeMorningReportFile(state, {
    tasksActiveDir: activeDir,
    tasksArchiveDir: archiveDir,
    reportFile
  });

  const md = fs.readFileSync(reportFile, 'utf8');
  assert.match(md, /First-Attempt Validator Pass Rate/i);
  assert.ok(md.includes('deepseek-v4.1'));
  assert.ok(md.includes('backend'));
  assert.ok(md.includes('50.0%'));
  assert.ok(md.includes('| 1 / 2 | 2 | 50.0% |') || md.includes('2') && md.includes('50.0%'));
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('✓ Item 6 tests PASSED!');
