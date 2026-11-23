#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as riskPolicy from './lib/risk-policy.mjs';
import { finalizeTaskCommitWithFrontendGate, resolveGitCommitStrategy } from './git-guard.mjs';
import * as orchestratorMod from './orchestrator.mjs';

assert.equal(typeof riskPolicy.detectDestructiveDiffCalls, 'function', 'risk-policy.mjs must export detectDestructiveDiffCalls');
assert.equal(typeof riskPolicy.evaluatePostPatchDiffRisk, 'function', 'risk-policy.mjs must export evaluatePostPatchDiffRisk');
assert.equal(typeof orchestratorMod.applyPostPatchDiffRiskFloor, 'function', 'orchestrator.mjs must export applyPostPatchDiffRiskFloor');

function makeUnifiedDiff(filePath, addedLines = [], removedLines = []) {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    '@@ -1,3 +1,5 @@',
    ...removedLines.map(l => `-${l}`),
    ...addedLines.map(l => `+${l}`),
    ''
  ].join('\n');
}

// 1. Every physical delete call variant raises effective post-patch risk >= high
const deleteCases = [
  ['src/cleanup.py', ['\tos.remove(target_path)']],
  ['src/cleanup.py', ['\tos.unlink(target_path)']],
  ['src/cleanup.py', ['\tshutil.rmtree(cache_dir)']],
  ['src/cleanup.py', ['\tPath(target).unlink(missing_ok=True)']],
  ['src/cleanup.py', ['\tcache_file.unlink()']],
  ['src/cleanup.py', ['\tos.rmdir(empty_dir)']],
  ['src/cleanup.py', ['\tsend2trash(str(target))']],
  ['src/cleanup.js', ['  fs.unlink(target, cb);']],
  ['src/cleanup.js', ['  fs.unlinkSync(target);']],
  ['src/cleanup.js', ['  await fs.promises.unlink(target);']],
  ['src/cleanup.js', ['  fs.rmSync(tmpDir, { recursive: true, force: true });']],
  ['src/cleanup.js', ['  await fs.promises.rm(tmpDir, { recursive: true });']],
  ['src/cleanup.js', ['  fs.rmdirSync(oldDir);']]
];

for (const [file, lines] of deleteCases) {
  const diff = makeUnifiedDiff(file, lines);
  const hits = riskPolicy.detectDestructiveDiffCalls(diff);
  assert.ok(hits.length >= 1, `Expected destructive call match for ${file}: ${lines[0]}`);
  const evalLow = riskPolicy.evaluatePostPatchDiffRisk(
    { task_id: 'T-GEN-DEL', risk_level: 'low', scope: [file] },
    diff
  );
  assert.equal(evalLow.pre_patch_risk_level, 'low');
  assert.equal(evalLow.post_patch_risk_level, 'high', `Expected high floor for ${lines[0]}`);
  assert.equal(evalLow.escalated_to_high, true);
}

// 2. Normal diff without physical delete calls + comments/removed lines mentioning delete keep original risk
{
  const normalDiff = makeUnifiedDiff(
    'src/formatter.py',
    [
      'def normalize_label(val: str) -> str:',
      '\t# Note: do not call os.remove or fs.unlink here',
      '\treturn str(val or "").strip()'
    ],
    ['\tos.remove(legacy_path)']
  );
  const hits = riskPolicy.detectDestructiveDiffCalls(normalDiff);
  assert.equal(hits.length, 0, 'Removed lines and comments must NOT count as added delete calls');
  const evalLow = riskPolicy.evaluatePostPatchDiffRisk(
    { task_id: 'T-GEN-SAFE', risk_level: 'low', scope: ['src/formatter.py'] },
    normalDiff
  );
  assert.equal(evalLow.post_patch_risk_level, 'low');
  assert.equal(evalLow.escalated_to_high, false);

  const evalMed = riskPolicy.evaluatePostPatchDiffRisk(
    { task_id: 'T-GEN-MED', risk_level: 'medium', scope: ['src/formatter.py'] },
    normalDiff
  );
  assert.equal(evalMed.post_patch_risk_level, 'medium');
  assert.equal(evalMed.escalated_to_high, false);
}

// 3. Critical task stays critical (post_patch_risk_level >= high, not downgraded)
{
  const delDiff = makeUnifiedDiff('infra/purge.py', ['\tshutil.rmtree(work_dir)']);
  const evalCrit = riskPolicy.evaluatePostPatchDiffRisk(
    { task_id: 'T-GEN-CRIT', risk_level: 'critical', scope: ['infra/purge.py'] },
    delDiff
  );
  assert.equal(evalCrit.post_patch_risk_level, 'critical');
  assert.equal(evalCrit.escalated_to_high, false);
}

// 4. Escalation behavior before Reviewer / Git Commit without rolling back passing patch:
// (a) When distinct Reviewer exists, escalation forces Reviewer Gate ON even in quick mode
{
  const taskEscalated = {
    task_id: 'T-ESC-REV',
    mode: 'quick',
    risk_level: 'low',
    scope: ['src/storage.js']
  };
  const policy = {
    task_modes: { quick: { skip_router_and_reviewer: true } },
    approval_gates: { require_code_review: true, review_min_risk_level: 'high' }
  };
  const roles = {
    writer: { model: 'writer-m' },
    reviewer: { model: 'reviewer-m' }
  };
  assert.equal(riskPolicy.shouldRunReviewerGate(taskEscalated, policy, roles, ['writer-m']), false, 'Pre-patch quick/low normally skips Reviewer');

  const delDiff = makeUnifiedDiff('src/storage.js', ['  fs.unlinkSync(stalePath);']);
  const floorOutcome = orchestratorMod.applyPostPatchDiffRiskFloor({
    task: taskEscalated,
    diffText: delDiff,
    policy,
    roles,
    usedWriterModels: ['writer-m']
  });
  assert.equal(floorOutcome.escalated_to_high, true);
  assert.equal(taskEscalated.post_patch_risk_level, 'high');
  assert.equal(taskEscalated.risk_level, 'high');
  assert.equal(floorOutcome.reviewerRequired, true);
  assert.equal(riskPolicy.shouldRunReviewerGate(taskEscalated, policy, roles, ['writer-m']), true, 'Escalated diff MUST trigger Reviewer gate');
}

// (b) When Reviewer cannot run (same model / disabled), escalates to awaiting_confirmation branch gate instead of direct commit or rollback
{
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'td-diff-risk-git-'));
  try {
    fs.mkdirSync(path.join(tmpRepo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'src/cleaner.js'), 'export const clean = () => {};\n', 'utf8');
    execFileSync('git', ['init', '-b', 'master'], { cwd: tmpRepo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpRepo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tmpRepo, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: tmpRepo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpRepo, stdio: 'ignore' });

    fs.writeFileSync(
      path.join(tmpRepo, 'src/cleaner.js'),
      'import fs from "node:fs";\nexport const clean = (p) => fs.unlinkSync(p);\n',
      'utf8'
    );
    const diff = execFileSync('git', ['diff', '-U3'], { cwd: tmpRepo, encoding: 'utf8' });

    const taskSelfRev = {
      task_id: 'T-ESC-CONFIRM',
      title: 'Add cleaner unlink',
      mode: 'quick',
      risk_level: 'low',
      scope: ['src/cleaner.js']
    };
    const policy = {
      policy: {
        approval_gates: { require_code_review: true, review_min_risk_level: 'high' },
        git_hygiene: { confirm_frontend_branch_before_merge: true }
      }
    };
    const rolesSameModel = {
      writer: { model: 'shared-m' },
      reviewer: { model: 'shared-m' }
    };

    const floorOutcome = orchestratorMod.applyPostPatchDiffRiskFloor({
      task: taskSelfRev,
      diffText: diff,
      policy: policy.policy,
      roles: rolesSameModel,
      usedWriterModels: ['shared-m']
    });
    assert.equal(floorOutcome.escalated_to_high, true);
    assert.equal(floorOutcome.reviewerRequired, false);
    assert.equal(floorOutcome.requiresConfirmation, true);

    const strategy = resolveGitCommitStrategy(['src/cleaner.js'], taskSelfRev, policy);
    assert.equal(strategy.mode, 'branch_confirm', 'Unreviewed escalated delete patch must require confirmation branch');

    const commitRes = finalizeTaskCommitWithFrontendGate({
      task: taskSelfRev,
      actualModifiedFiles: ['src/cleaner.js'],
      policyConfig: policy,
      cwd: tmpRepo
    });
    assert.equal(commitRes.ok, true);
    assert.equal(commitRes.awaitingConfirmation, true);
    assert.equal(commitRes.finalSuccessStatus, 'awaiting_confirmation');
    assert.ok(taskSelfRev.pending_branch?.startsWith('ai-task/T-ESC-CONFIRM'));
    const curBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpRepo, encoding: 'utf8' }).trim();
    assert.equal(curBranch, 'master');
    const committedOnBranch = execFileSync('git', ['show', `${taskSelfRev.pending_branch}:src/cleaner.js`], { cwd: tmpRepo, encoding: 'utf8' });
    assert.match(committedOnBranch, /fs\.unlinkSync/, 'Passing patch must NOT be rolled back');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
}

console.log('test-post-patch-diff-risk.mjs: ALL PASSED');
