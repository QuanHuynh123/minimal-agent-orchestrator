#!/usr/bin/env node
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transitionTaskState } from './lib/task-persistence.mjs';
import * as orchestrator from './orchestrator.mjs';

const SAMPLE_DIFF = [
  'diff --git a/ui_bridge/js_api.py b/ui_bridge/js_api.py',
  '--- a/ui_bridge/js_api.py',
  '+++ b/ui_bridge/js_api.py',
  '@@ -10,3 +10,6 @@ class JsApi:',
  ' \tdef existing(self):',
  ' \t\treturn True',
  '+\tdef get_supported_publish_privacies(self):',
  '+\t\treturn {"ok": True, "privacies": ["private", "unlisted", "public"]}',
  ''
].join('\n');

async function runTests() {
  assert.strictEqual(
    typeof orchestrator.extractFirstBalancedJsonObject,
    'function',
    'orchestrator.mjs must export extractFirstBalancedJsonObject'
  );
  assert.strictEqual(
    typeof orchestrator.runReviewerGate,
    'function',
    'orchestrator.mjs must export runReviewerGate'
  );
  assert.strictEqual(
    typeof orchestrator.resolveReviewStageOutcome,
    'function',
    'orchestrator.mjs must export resolveReviewStageOutcome'
  );

  // 1. Valid JSON followed by trailing prose containing {...} (Pilot Task 2 regression)
  const pilotStyleResponse = [
    '{',
    '  "passed": true,',
    '  "rubric_scores": {',
    '    "correctness": true,',
    '    "safety": true,',
    '    "scope_adherence": true,',
    '    "testability": true',
    '  },',
    '  "issues": []',
    '}',
    "Lưu ý: phương thức trả về {'ok': True, 'privacies': ['private', 'unlisted', 'public']} hợp lệ."
  ].join('\n');

  const extractedPilot = orchestrator.extractFirstBalancedJsonObject(pilotStyleResponse);
  assert.ok(extractedPilot, 'Must extract first balanced JSON object even with trailing { ... }');
  const parsedPilot = JSON.parse(extractedPilot);
  assert.strictEqual(parsedPilot.passed, true);

  const task = {
    task_id: 'T-REVIEW-GATE-TEST',
    goal: 'Add get_supported_publish_privacies',
    constraints: ['Use TAB indentation'],
    acceptance_criteria: ['Returns ordered privacy list'],
    error_history: []
  };

  const gateValidTrailing = await orchestrator.runReviewerGate(task, ['ui_bridge/js_api.py'], [], 'deepseek-v4.1-flash', {
    getDiff: () => SAMPLE_DIFF,
    callModel: async () => ({
      ok: true,
      content: pilotStyleResponse,
      actual_model: 'claude-sonnet-5-5',
      usage: { prompt_tokens: 1200, completion_tokens: 80 }
    })
  });
  assert.strictEqual(gateValidTrailing.ok, true, `Expected parsed review pass, got: ${gateValidTrailing.error}`);
  assert.strictEqual(gateValidTrailing.reviewResult?.passed, true);
  assert.ok(!gateValidTrailing.review_unavailable);

  // 2. JSON inside ```json ... ``` fence + braces inside string literal + trailing {noise}
  const fencedResponse = [
    'Đánh giá nhanh:',
    '```json',
    '{',
    '  "passed": false,',
    '  "rubric_scores": { "correctness": false, "safety": true, "scope_adherence": true, "testability": true },',
    '  "issues": ["Missing {key} check in dict handler"]',
    '}',
    '```',
    'Gợi ý thêm: trả về {"ok": False} nếu lỗi.'
  ].join('\n');

  const gateFenced = await orchestrator.runReviewerGate(task, ['ui_bridge/js_api.py'], [], 'deepseek-v4.1-flash', {
    getDiff: () => SAMPLE_DIFF,
    callModel: async () => ({
      ok: true,
      content: fencedResponse,
      actual_model: 'claude-sonnet-5-5',
      usage: { prompt_tokens: 1200, completion_tokens: 90 }
    })
  });
  assert.strictEqual(gateFenced.ok, false);
  assert.ok(!gateFenced.review_unavailable, 'Valid rejected JSON must not trigger review_unavailable');
  assert.strictEqual(gateFenced.reviewResult?.passed, false);
  assert.strictEqual(gateFenced.reviewResult?.issues?.[0], 'Missing {key} check in dict handler');

  // 3. Completely malformed JSON -> review_unavailable, NO infinite fix loop, saves patch, rolls back worktree
  const brokenResponse = '```json\n{\n  "passed": true,\n  "issues": [broken\n```\nCannot finish formatting';
  const gateBroken = await orchestrator.runReviewerGate(task, ['ui_bridge/js_api.py'], [], 'deepseek-v4.1-flash', {
    getDiff: () => SAMPLE_DIFF,
    callModel: async () => ({
      ok: true,
      content: brokenResponse,
      actual_model: 'claude-sonnet-5-5',
      usage: { prompt_tokens: 1200, completion_tokens: 45 }
    })
  });
  assert.strictEqual(gateBroken.ok, false);
  assert.strictEqual(gateBroken.failure_class, 'review_unavailable');
  assert.strictEqual(gateBroken.review_unavailable, true);
  assert.strictEqual(gateBroken.diffText, SAMPLE_DIFF);

  const tmpTeamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-rev-gate-'));
  try {
    let rolledBackTargets = null;
    let stageFailureCalled = false;
    const outcome = orchestrator.resolveReviewStageOutcome({
      task,
      revRes: gateBroken,
      attemptNum: 1,
      rollbackTargets: ['ui_bridge/js_api.py'],
      rollbackFn: (targets) => {
        rolledBackTargets = targets;
        return { ok: true };
      },
      onRejectedReview: () => {
        stageFailureCalled = true;
        return { shouldBreak: false };
      },
      teamDir: tmpTeamDir
    });

    assert.strictEqual(stageFailureCalled, false, 'Malformed Reviewer JSON must NOT enter handleStageFailure / Infinite fix loop');
    assert.strictEqual(outcome.action, 'break_blocked');
    assert.strictEqual(outcome.validationPassed, true, 'Code that already passed Validation must remain validationPassed=true');
    assert.strictEqual(task.status, 'blocked');
    assert.strictEqual(task.failure_class, 'review_unavailable');
    assert.ok(!String(outcome.blockReason || '').includes('Infinite fix loop'), 'Must not blame Infinite fix loop');
    assert.deepStrictEqual(rolledBackTargets, ['ui_bridge/js_api.py'], 'Worktree must be rolled back');

    const expectedPatchDir = path.join(tmpTeamDir, 'state', 'runs', 'T-REVIEW-GATE-TEST');
    assert.ok(fs.existsSync(expectedPatchDir), 'Run directory for task must be created');
    const savedFiles = fs.readdirSync(expectedPatchDir).filter(f => f.endsWith('.patch'));
    assert.ok(savedFiles.length >= 1, `Expected saved .patch file in ${expectedPatchDir}`);
    const patchContent = fs.readFileSync(path.join(expectedPatchDir, savedFiles[0]), 'utf8');
    assert.ok(patchContent.includes('def get_supported_publish_privacies'), 'Saved patch file must preserve full diff');

    const state = { active_tasks: [], completed_tasks: [], blocked_tasks: [], metrics: {} };
    transitionTaskState(task, state, 'blocked', {
      actualModifiedFiles: ['ui_bridge/js_api.py'],
      validationPassed: outcome.validationPassed,
      retries: 0,
      blockReason: outcome.blockReason
    });
    assert.strictEqual(task.last_report.failure_class, 'review_unavailable');
    assert.strictEqual(task.last_report.validation_passed, true);
    assert.match(task.last_report.next_action, /manual review/i);

    console.log('ALL REVIEWER GATE TESTS PASSED (3/3)');
  } finally {
    fs.rmSync(tmpTeamDir, { recursive: true, force: true });
  }
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
