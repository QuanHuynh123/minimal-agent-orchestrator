#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  analyzeTaskDemand,
  resolveWriterHubWorkflow
} from './lib/risk-policy.mjs';
import * as gitGuard from './git-guard.mjs';
import { transitionTaskState } from './lib/task-persistence.mjs';
import { writeMorningReportFile } from './lib/queue-state.mjs';

const GENERIC_TEAM = {
  roles: {
    router: { enabled: true, model: 'mock/cheap-router', default_model: 'mock/cheap-router' },
    writer: { enabled: true, model: 'mock/primary-writer', default_model: 'mock/primary-writer' },
    designer: { enabled: true, model: 'mock/ui-designer', default_model: 'mock/ui-designer' },
    reviewer: { enabled: true, model: 'mock/strong-reviewer', default_model: 'mock/strong-reviewer' }
  }
};

function initTempGitRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-fe-branch-gate-'));
  execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'pipe' });

  fs.mkdirSync(path.join(repoDir, 'ui_web'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'core'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'ui_web', 'app.html'), '<div>old ui</div>\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, 'core', 'service.py'), 'def run():\n\treturn 1\n', 'utf8');
  execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoDir, stdio: 'pipe' });
  return repoDir;
}

async function runTests() {
  console.log('Testing Item 2: Frontend Branch Confirmation Gate & Strict Designer/TechSpec Rules...\n');

  // 1. Part A — Frontend Scope Branch Commit + Wait Confirmation Before Merge (Both Branches!)
  assert.equal(typeof gitGuard.resolveGitCommitStrategy, 'function', 'git-guard must export resolveGitCommitStrategy');
  assert.equal(typeof gitGuard.commitToBranch, 'function', 'git-guard must export commitToBranch');
  assert.equal(typeof gitGuard.mergeConfirmedBranch, 'function', 'git-guard must export mergeConfirmedBranch');
  assert.equal(typeof gitGuard.finalizeTaskCommitWithFrontendGate, 'function', 'git-guard must export finalizeTaskCommitWithFrontendGate');

  const tmpRepo = initTempGitRepo();
  try {
    const baseHeadBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpRepo, encoding: 'utf8' }).trim();

    // Branch 1: Task modifies frontendScope -> must commit onto a task branch, leave master untouched, require confirmation to merge
    fs.writeFileSync(path.join(tmpRepo, 'ui_web', 'app.html'), '<div>updated ui</div>\n', 'utf8');
    const feTask = {
      task_id: 'T-GEN-FE-GATE',
      title: 'Update app UI',
      goal: 'Update app markup cleanly',
      scope: ['ui_web/app.html']
    };
    const feRes = gitGuard.finalizeTaskCommitWithFrontendGate({
      task: feTask,
      actualModifiedFiles: ['ui_web/app.html'],
      commitPrefix: '[AI-Task]',
      finalSuccessStatus: 'done',
      cwd: tmpRepo
    });

    assert.equal(feRes.ok, true, `Frontend branch commit must succeed: ${feRes.error}`);
    assert.equal(feRes.awaitingConfirmation, true, 'Frontend changes must await user confirmation');
    assert.equal(feRes.finalSuccessStatus, 'awaiting_confirmation');
    assert.ok(feRes.branch && feRes.branch.startsWith('ai-task/'), `Expected branch ai-task/*, got ${feRes.branch}`);
    assert.equal(feTask.requires_user_confirmation, true);
    assert.equal(feTask.pending_branch, feRes.branch);
    assert.ok(String(feTask.merge_command || '').includes(feRes.branch));

    // Verify awaiting_confirmation records modified_files, clears stale retry error & blocker_reason, and surfaces files in morning-report.md
    feTask.last_error = 'stale attempt-1 error';
    feTask.steps = [{ step: '2.1', attempt: 1, edit_lines_outside_window: 12 }];
    const feState = { version: '2.1', active_tasks: [], completed_tasks: [], blocked_tasks: [], metrics: {} };
    const feStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-fe-report-'));
    const feActiveDir = path.join(feStateDir, 'active');
    const feArchiveDir = path.join(feStateDir, 'archive');
    const feReportPath = path.join(feStateDir, 'morning-report.md');
    try {
      fs.mkdirSync(feActiveDir, { recursive: true });
      fs.mkdirSync(feArchiveDir, { recursive: true });
      transitionTaskState(feTask, feState, feRes.finalSuccessStatus, {
        actualModifiedFiles: ['ui_web/app.html'],
        validationPassed: true,
        retries: 1,
        maxRetries: 3,
        activeTaskPath: path.join(feActiveDir, 'fe-task.yaml'),
        archiveTaskPath: path.join(feArchiveDir, 'fe-task.yaml')
      });
      assert.equal(feTask.last_report.final_status, 'awaiting_confirmation');
      assert.deepEqual(
        feTask.last_report.modified_files,
        ['ui_web/app.html'],
        `awaiting_confirmation last_report.modified_files must NOT be empty, got: ${JSON.stringify(feTask.last_report.modified_files)}`
      );
      assert.equal(
        feTask.last_report.blocker_reason,
        null,
        `awaiting_confirmation must have blocker_reason=null, got: ${feTask.last_report.blocker_reason}`
      );
      assert.equal(feTask.last_report.edit_lines_outside_window, 12);
      assert.equal(feTask.last_error, undefined, 'awaiting_confirmation must clear stale retry last_error');
      assert.equal(feTask.pending_branch, feRes.branch, 'awaiting_confirmation must keep pending_branch');
      assert.equal(feTask.requires_user_confirmation, true, 'awaiting_confirmation must keep requires_user_confirmation');

      writeMorningReportFile(feState, {
        tasksActiveDir: feActiveDir,
        tasksArchiveDir: feArchiveDir,
        reportFile: feReportPath
      });
      const feReportMd = fs.readFileSync(feReportPath, 'utf8');
      assert.ok(
        feReportMd.includes('## Awaiting Confirmation Tasks') && feReportMd.includes('ui_web/app.html'),
        `morning-report.md must list modified files for awaiting_confirmation tasks, got:\n${feReportMd}`
      );
    } finally {
      fs.rmSync(feStateDir, { recursive: true, force: true });
    }

    // Verify HEAD on master stayed unchanged until user confirms merge
    const currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: tmpRepo, encoding: 'utf8' }).trim();
    const headNow = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpRepo, encoding: 'utf8' }).trim();
    assert.equal(currentBranch, 'master', 'Repo must return to base branch master without merging yet');
    assert.equal(headNow, baseHeadBefore, 'master HEAD must NOT advance before human confirmation');
    assert.equal(fs.readFileSync(path.join(tmpRepo, 'ui_web', 'app.html'), 'utf8').replace(/\r\n/g, '\n'), '<div>old ui</div>\n');

    // Merge refused without explicit confirmation
    const unconfirmedMerge = gitGuard.mergeConfirmedBranch(feRes.branch, { baseBranch: 'master', confirmed: false, cwd: tmpRepo });
    assert.equal(unconfirmedMerge.ok, false, 'Merging without confirmed=true must be blocked');
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmpRepo, encoding: 'utf8' }).trim(), baseHeadBefore);

    // Merge succeeds ONLY after explicit confirmation=true
    const confirmedMerge = gitGuard.mergeConfirmedBranch(feRes.branch, { baseBranch: 'master', confirmed: true, cwd: tmpRepo });
    assert.equal(confirmedMerge.ok, true, `Confirmed merge must succeed: ${confirmedMerge.error}`);
    assert.equal(fs.readFileSync(path.join(tmpRepo, 'ui_web', 'app.html'), 'utf8').replace(/\r\n/g, '\n'), '<div>updated ui</div>\n');

    // Branch 2: Backend-only change (NO frontendScope) -> commits directly onto current branch (done), NO confirmation gate
    fs.writeFileSync(path.join(tmpRepo, 'core', 'service.py'), 'def run():\n\treturn 2\n', 'utf8');
    const beTask = {
      task_id: 'T-GEN-BE-DIRECT',
      title: 'Update core service',
      goal: 'Return 2 in service.py',
      scope: ['core/service.py']
    };
    const beRes = gitGuard.finalizeTaskCommitWithFrontendGate({
      task: beTask,
      actualModifiedFiles: ['core/service.py'],
      commitPrefix: '[AI-Task]',
      finalSuccessStatus: 'done',
      cwd: tmpRepo
    });
    assert.equal(beRes.ok, true);
    assert.equal(beRes.awaitingConfirmation, false, 'Backend-only change must commit directly without confirmation gate');
    assert.equal(beRes.finalSuccessStatus, 'done');
    assert.ok(!beTask.requires_user_confirmation);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }

  // 1b. Scenario (a): Working tree has uncommitted changes outside targetFiles when finalize runs
  // Desired: preserve ALL uncommitted changes intact, do NOT create/merge branch wrongly, clear blocked message
  const dirtyRepo = initTempGitRepo();
  try {
    const baseHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dirtyRepo, encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(dirtyRepo, 'ui_web', 'app.html'), '<div>task edit</div>\n', 'utf8');
    fs.writeFileSync(path.join(dirtyRepo, 'core', 'service.py'), 'def run():\n\treturn 999\n', 'utf8');
    fs.writeFileSync(path.join(dirtyRepo, 'wip_notes.txt'), 'keep my local notes\n', 'utf8');

    const dirtyTask = {
      task_id: 'T-GEN-DIRTY-TREE',
      title: 'Update app UI cleanly',
      goal: 'Modify ui_web/app.html while user has unrelated edits',
      scope: ['ui_web/app.html']
    };
    const dirtyRes = gitGuard.finalizeTaskCommitWithFrontendGate({
      task: dirtyTask,
      actualModifiedFiles: ['ui_web/app.html'],
      commitPrefix: '[AI-Task]',
      finalSuccessStatus: 'done',
      cwd: dirtyRepo
    });

    assert.equal(dirtyRes.ok, false, 'Finalize MUST block when working tree has uncommitted changes outside targetFiles');
    assert.equal(dirtyRes.blocked, true, 'Dirty-tree finalize failure must mark blocked=true');
    assert.equal(dirtyRes.awaitingConfirmation, false, 'Blocked finalize must not enter awaitingConfirmation');
    assert.match(String(dirtyRes.error || ''), /uncommitted/i, `Expected clear uncommitted-changes error, got: ${dirtyRes.error}`);
    assert.ok(!dirtyTask.requires_user_confirmation, 'Must not mark requires_user_confirmation on blocked finalize');

    // No task branch created, master unchanged, AND all local changes preserved intact on disk
    const branches = execFileSync('git', ['branch', '--list', 'ai-task/*'], { cwd: dirtyRepo, encoding: 'utf8' }).trim();
    assert.equal(branches, '', 'No ai-task/* branch may be created when finalize blocks on dirty tree');
    assert.equal(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dirtyRepo, encoding: 'utf8' }).trim(), 'master');
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dirtyRepo, encoding: 'utf8' }).trim(), baseHead);
    assert.equal(fs.readFileSync(path.join(dirtyRepo, 'ui_web', 'app.html'), 'utf8').replace(/\r\n/g, '\n'), '<div>task edit</div>\n', 'Target file edit must be preserved');
    assert.equal(fs.readFileSync(path.join(dirtyRepo, 'core', 'service.py'), 'utf8').replace(/\r\n/g, '\n'), 'def run():\n\treturn 999\n', 'Unrelated tracked modification must be preserved');
    assert.equal(fs.readFileSync(path.join(dirtyRepo, 'wip_notes.txt'), 'utf8').replace(/\r\n/g, '\n'), 'keep my local notes\n', 'Untracked WIP file must be preserved');
  } finally {
    fs.rmSync(dirtyRepo, { recursive: true, force: true });
  }

  // 1c. Scenario (b): User is currently checked out on ai-task/<id> when mergeConfirmedBranch runs
  // Desired: refuse self-merge, preserve state without switching/losing edits or merging master, clear message
  const onBranchRepo = initTempGitRepo();
  try {
    const masterBefore = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: onBranchRepo, encoding: 'utf8' }).trim();
    fs.writeFileSync(path.join(onBranchRepo, 'ui_web', 'app.html'), '<div>branch work</div>\n', 'utf8');
    const feTaskB = {
      task_id: 'T-GEN-ON-BRANCH',
      title: 'Update app UI',
      goal: 'Branch commit test',
      scope: ['ui_web/app.html']
    };
    const branchRes = gitGuard.finalizeTaskCommitWithFrontendGate({
      task: feTaskB,
      actualModifiedFiles: ['ui_web/app.html'],
      commitPrefix: '[AI-Task]',
      finalSuccessStatus: 'done',
      cwd: onBranchRepo
    });
    assert.equal(branchRes.ok, true, `Setup frontend branch failed: ${branchRes.error}`);
    const taskBranch = branchRes.branch;

    // User switches to ai-task/<id> (and makes a local WIP edit)
    execFileSync('git', ['checkout', '-q', taskBranch], { cwd: onBranchRepo, stdio: 'pipe' });
    fs.writeFileSync(path.join(onBranchRepo, 'core', 'service.py'), 'def run():\n\treturn 42\n', 'utf8');

    const selfMergeRes = gitGuard.mergeConfirmedBranch(taskBranch, {
      baseBranch: 'master',
      confirmed: true,
      cwd: onBranchRepo
    });
    assert.equal(selfMergeRes.ok, false, 'mergeConfirmedBranch MUST fail when user is checked out on ai-task/<id>');
    assert.equal(selfMergeRes.blocked, true, 'Should report blocked=true when currently on task branch');
    assert.equal(selfMergeRes.merged, false, 'Must report merged=false');
    assert.match(String(selfMergeRes.error || ''), /(currently checked out|uncommitted|ai-task\/T-GEN-ON-BRANCH)/i, `Expected clear error, got: ${selfMergeRes.error}`);

    // Clean worktree while still on ai-task/<id> MUST STILL block self-merge clearly!
    fs.writeFileSync(path.join(onBranchRepo, 'core', 'service.py'), 'def run():\n\treturn 1\n', 'utf8');
    const cleanSelfMerge = gitGuard.mergeConfirmedBranch(taskBranch, {
      baseBranch: 'master',
      confirmed: true,
      cwd: onBranchRepo
    });
    assert.equal(cleanSelfMerge.ok, false, 'mergeConfirmedBranch MUST block self-merge even on clean ai-task/<id>');
    assert.equal(cleanSelfMerge.blocked, true);
    assert.equal(cleanSelfMerge.merged, false);
    assert.match(String(cleanSelfMerge.error || ''), new RegExp(taskBranch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `Error must name branch ${taskBranch}: ${cleanSelfMerge.error}`);

    // Branch unchanged and master did not get merged accidentally
    assert.equal(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: onBranchRepo, encoding: 'utf8' }).trim(), taskBranch);
    assert.equal(execFileSync('git', ['rev-parse', 'master'], { cwd: onBranchRepo, encoding: 'utf8' }).trim(), masterBefore);
  } finally {
    fs.rmSync(onBranchRepo, { recursive: true, force: true });
  }

  // 2. Part B — Spec Rules: quick + low + no images -> no Designer, no TechSpec regardless of UI words
  const quickUiTweak = {
    task_id: 'T-GEN-QUICK-UI',
    title: 'Clean up toolbar layout and spacing CSS',
    goal: 'Remove unused button group and polish responsive grid layout and dark mode modal CSS in web/app.html',
    mode: 'quick',
    risk_level: 'low',
    scope: ['web/app.html', 'tests/test_dom.py']
  };
  const dQuickUi = analyzeTaskDemand(quickUiTweak);
  assert.equal(dQuickUi.mode, 'quick');
  assert.equal(dQuickUi.hasUiIntent, false, 'hasUiIntent must only apply in standard mode');
  assert.equal(dQuickUi.needsDesignSpec, false, 'quick + low + no images must NOT call Designer even with UI words');
  assert.equal(dQuickUi.needsTechSpec, false, 'quick + low + no images must NOT call TechSpec');
  assert.deepEqual(resolveWriterHubWorkflow(quickUiTweak, GENERIC_TEAM), [], 'quick + low UI cleanup must collapse to 1-step Writer');

  // Visual attachment triggers Designer even in quick + low
  const quickWithImage = {
    ...quickUiTweak,
    task_id: 'T-GEN-QUICK-IMG',
    attachments: ['screenshot.png']
  };
  const dQuickImg = analyzeTaskDemand(quickWithImage);
  assert.equal(dQuickImg.hasVisualInput, true);
  assert.equal(dQuickImg.needsDesignSpec, true, 'Attached image must request Designer');
  assert.equal(dQuickImg.needsTechSpec, false);

  // standard + remove/bugfix/refactor on UI (no new UI, no images) -> NO Designer
  for (const [kindName, goalStr] of [
    ['remove', 'Remove legacy filter panel and update CSS layout in web/app.html'],
    ['bugfix', 'Fix modal overflow and responsive layout alignment bug in web/app.html'],
    ['refactor', 'Clean up existing styles and CSS classes in web/app.html']
  ]) {
    const stdMaint = {
      task_id: `T-GEN-STD-${kindName}`,
      title: `Standard ${kindName} UI task`,
      goal: goalStr,
      kind: kindName,
      mode: 'standard',
      risk_level: 'medium',
      scope: ['web/app.html']
    };
    const dMaint = analyzeTaskDemand(stdMaint);
    assert.equal(dMaint.hasUiIntent, true, 'standard mode sets hasUiIntent when UI keywords exist');
    assert.equal(dMaint.needsDesignSpec, false, `standard + ${kindName} without new UI or image must NOT call Designer`);
  }

  // standard + new UI -> calls Designer
  const stdNewUi = {
    task_id: 'T-GEN-STD-NEW-UI',
    title: 'Create new analytics modal UI',
    goal: 'Design and add a new responsive settings modal layout and dark mode CSS in web/settings.html',
    kind: 'feature',
    mode: 'standard',
    risk_level: 'medium',
    scope: ['web/settings.html']
  };
  const dNewUi = analyzeTaskDemand(stdNewUi);
  assert.equal(dNewUi.mode, 'standard');
  assert.equal(dNewUi.hasUiIntent, true);
  assert.equal(dNewUi.needsDesignSpec, true, 'standard + new UI must call Designer');
  const wfNewUi = resolveWriterHubWorkflow(stdNewUi, GENERIC_TEAM);
  assert.equal(wfNewUi[0]?.role, 'designer', 'standard + new UI workflow starts with Designer draft_spec');

  console.log('✓ All Item 2 frontend branch confirmation gate & strict spec tests passed.');
}

runTests().catch(err => {
  console.error('Item 2 test failed:', err);
  process.exit(1);
});
