#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as gitGuard from './git-guard.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(TEAM_DIR, '..');

function runGitCheckIgnore(cwd, relPath) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', relPath], { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function runTests() {
  console.log('Testing Item 1: .gitignore coverage for runtime state artifacts & clean frontend branch gate...\n');

  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'td-gitignore-state-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'master'], { cwd: tmpRepo, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpRepo, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tmpRepo, stdio: 'pipe' });

    // Copy real .gitignore files from REPO_ROOT to test exact project ignore rules
    fs.copyFileSync(path.join(REPO_ROOT, '.gitignore'), path.join(tmpRepo, '.gitignore'));
    fs.mkdirSync(path.join(tmpRepo, 'agent-team', 'state', 'sessions'), { recursive: true });
    fs.copyFileSync(path.join(TEAM_DIR, '.gitignore'), path.join(tmpRepo, 'agent-team', '.gitignore'));

    // Tracked files that must remain tracked
    fs.mkdirSync(path.join(tmpRepo, 'ui_web'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'ui_web', 'app.html'), '<div>v1</div>\n', 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'agent-team', 'state', 'sessions', '.gitkeep'), '', 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'agent-team', 'state', 'task-state.schema.json'), '{}\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: tmpRepo, stdio: 'pipe' });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: tmpRepo, stdio: 'pipe' });

    // 1. Verify runtime state artifacts are covered by .gitignore
    const runtimeSamples = [
      ['agent-team', 'state', 'baseline-cache.json'],
      ['agent-team', 'state', 'telemetry', 'calls.jsonl'],
      ['agent-team', 'state', 'telemetry', 'agent_team_events.jsonl'],
      ['agent-team', 'state', 'reports', 'run-report.md'],
      ['agent-team', 'state', 'runs', 'T-SIM-1', 'attempt-1.txt'],
      ['agent-team', 'state', 'task-state.json'],
      ['agent-team', 'state', 'live-status.json'],
      ['agent-team', 'state', 'morning-report.md'],
      ['agent-team', 'state', 'sessions', 'sess-1.json'],
      ['agent-team', 'state', 'runtime.lock']
    ];
    for (const segs of runtimeSamples) {
      const full = path.join(tmpRepo, ...segs);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, 'simulated-runtime-state\n', 'utf8');
      const posixRel = segs.join('/');
      assert.equal(
        runGitCheckIgnore(tmpRepo, posixRel),
        true,
        `Runtime state path "${posixRel}" MUST be ignored by .gitignore`
      );
    }

    // Tracked schema & .gitkeep must NOT be ignored
    assert.equal(runGitCheckIgnore(tmpRepo, 'agent-team/state/task-state.schema.json'), false);
    assert.equal(runGitCheckIgnore(tmpRepo, 'agent-team/state/sessions/.gitkeep'), false);

    // 2. Simulated runtime state files must NOT trigger uncommitted_changes_outside_targets in commitToBranch
    fs.writeFileSync(path.join(tmpRepo, 'ui_web', 'app.html'), '<div>v2</div>\n', 'utf8');
    const feTask = {
      task_id: 'T-SIM-GITIGNORE',
      title: 'Update UI',
      goal: 'Clean update',
      scope: ['ui_web/app.html']
    };
    const gateRes = gitGuard.finalizeTaskCommitWithFrontendGate({
      task: feTask,
      actualModifiedFiles: ['ui_web/app.html'],
      commitPrefix: '[AI-Task]',
      finalSuccessStatus: 'done',
      cwd: tmpRepo
    });

    assert.equal(gateRes.ok, true, `Ignored runtime state files must NOT block commitToBranch: ${gateRes.error}`);
    assert.equal(gateRes.awaitingConfirmation, true);

    // 3. After finalized branch commit (and keeping simulated ignored runtime state files on disk),
    // git status --porcelain MUST be completely empty!
    const porcelainAfterCommit = execFileSync('git', ['status', '--porcelain'], { cwd: tmpRepo, encoding: 'utf8' }).trim();
    assert.equal(
      porcelainAfterCommit,
      '',
      `git status --porcelain must be empty when only runtime state files remain, got:\n${porcelainAfterCommit}`
    );

    // Merge branch back and verify git status --porcelain remains completely empty
    const mergeRes = gitGuard.mergeConfirmedBranch(gateRes.branch, {
      baseBranch: 'master',
      confirmed: true,
      cwd: tmpRepo
    });
    assert.equal(mergeRes.ok, true, `Confirmed merge failed: ${mergeRes.error}`);
    const porcelainAfterMerge = execFileSync('git', ['status', '--porcelain'], { cwd: tmpRepo, encoding: 'utf8' }).trim();
    assert.equal(porcelainAfterMerge, '', 'git status --porcelain must remain empty after merge');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }

  console.log('✓ All Item 1 .gitignore runtime state & clean worktree gate tests passed.');
}

runTests().catch(err => {
  console.error('Item 1 gitignore test failed:', err);
  process.exit(1);
});
