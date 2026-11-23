#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildWriterRetryInstruction, formatValidationErrorForRetry } from './lib/context-builders.mjs';
import * as taskPersistence from './lib/task-persistence.mjs';
import { capturePreRollbackValidationFailure } from './orchestrator.mjs';

function makeTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-retry-rollback-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

function writeAndCommit(dir, files, msg) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', msg], { cwd: dir, stdio: 'ignore' });
}

assert.equal(
  typeof taskPersistence.saveAttemptPatchDiff,
  'function',
  'task-persistence.mjs must export saveAttemptPatchDiff()'
);
assert.equal(
  typeof capturePreRollbackValidationFailure,
  'function',
  'orchestrator.mjs must export capturePreRollbackValidationFailure()'
);

const repo = makeTempGitRepo();
const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-retry-team-'));

try {
  writeAndCommit(repo, {
    'core/history.py': 'def load_history():\n\treturn []\n',
    'ui_bridge/api.py': [
      'class JsApi:',
      '\tdef open_file_location(self, file_path: str):',
      '\t\treturn {"ok": False, "error": "missing"}'
    ].join('\n') + '\n',
    'tests/test_bridge.py': [
      'import unittest',
      'from ui_bridge.api import JsApi',
      '',
      'class BridgeTests(unittest.TestCase):',
      '\tdef test_existing_ok(self):',
      '\t\tself.assertTrue(True)'
    ].join('\n') + '\n'
  }, 'initial');

  // Simulate Attempt 1 un-committed edits BEFORE rollback:
  // 1) core/history.py edited
  fs.writeFileSync(
    path.join(repo, 'core/history.py'),
    'def load_history():\n\treturn []\n\ndef remove_history(item_id):\n\treturn False\n',
    'utf8'
  );
  // 2) ui_bridge/api.py edited
  fs.writeFileSync(
    path.join(repo, 'ui_bridge/api.py'),
    [
      'class JsApi:',
      '\tdef open_file_location(self, file_path: str):',
      '\t\tparent = "/tmp"',
      '\t\t# Always returns True on fallback parent folder',
      '\t\treturn {"ok": True, "path": parent}'
    ].join('\n') + '\n',
    'utf8'
  );
  // 3) New failing test added to tests/test_bridge.py (which rollback() will wipe off disk!)
  const newTestFnSource = [
    '\tdef test_open_file_location_missing_parent(self):',
    '\t\t"""Added in Attempt 1 and will be wiped by rollback."""',
    '\t\tapi = JsApi()',
    '\t\tres = api.open_file_location("totally-missing-file.mp4")',
    '\t\tself.assertFalse(res["ok"])',
    '\t\tself.assertIn("error", res)'
  ].join('\n');
  fs.writeFileSync(
    path.join(repo, 'tests/test_bridge.py'),
    [
      'import unittest',
      'from ui_bridge.api import JsApi',
      '',
      'class BridgeTests(unittest.TestCase):',
      '\tdef test_existing_ok(self):',
      '\t\tself.assertTrue(True)',
      '',
      newTestFnSource
    ].join('\n') + '\n',
    'utf8'
  );

  const absTestPath = path.join(repo, 'tests', 'test_bridge.py');
  const absApiPath = path.join(repo, 'ui_bridge', 'api.py');
  const noiseOk = Array.from({ length: 40 }, (_, i) => `test_ok_${i} (tests.test_bridge.BridgeTests.test_ok_${i}) ... ok`).join('\n');
  const rawErrOutput = [
    noiseOk,
    '======================================================================',
    'FAIL: test_open_file_location_missing_parent (tests.test_bridge.BridgeTests.test_open_file_location_missing_parent)',
    'Added in Attempt 1 and will be wiped by rollback.',
    '----------------------------------------------------------------------',
    'Traceback (most recent call last):',
    `  File "${absTestPath}", line 12, in test_open_file_location_missing_parent`,
    '    self.assertFalse(res["ok"])',
    `  File "${absApiPath}", line 5, in open_file_location`,
    '    return {"ok": True, "path": parent}',
    'AssertionError: True is not false',
    '',
    '----------------------------------------------------------------------',
    'Ran 306 tests in 25.100s',
    '',
    'FAILED (failures=1)'
  ].join('\n');

  const task = {
    task_id: 'T-RETRY-ROLLBACK-1',
    scope: ['core/history.py', 'ui_bridge/api.py', 'tests/test_bridge.py'],
    error_history: [],
    last_error: null
  };

  let rollbackCalled = false;
  const captured = capturePreRollbackValidationFailure({
    task,
    attemptNum: 1,
    errSummary: rawErrOutput,
    targets: task.scope,
    repoRoot: repo,
    teamDir,
    rollbackFn: (targets) => {
      rollbackCalled = true;
      execFileSync('git', ['checkout', 'HEAD', '--', ...targets], { cwd: repo, stdio: 'ignore' });
    }
  });

  assert.equal(rollbackCalled, true, 'capturePreRollbackValidationFailure must execute rollback');
  const postRollbackTestDisk = fs.readFileSync(absTestPath, 'utf8');
  assert.equal(
    postRollbackTestDisk.includes('test_open_file_location_missing_parent'),
    false,
    'Precondition: rollback must remove newly added failing test from disk'
  );

  // 1) attempt-1.patch saved under <teamDir>/state/runs/<task_id>/attempt-1.patch BEFORE rollback
  const expectedPatchPath = path.join(teamDir, 'state', 'runs', task.task_id, 'attempt-1.patch');
  assert.equal(fs.existsSync(expectedPatchPath), true, 'Must save attempt-1.patch before rollback');
  const patchText = fs.readFileSync(expectedPatchPath, 'utf8');
  assert.match(patchText, /remove_history/);
  assert.match(patchText, /test_open_file_location_missing_parent/);

  // 2) task.last_error contains failing test body, AssertionError, and project traceback frame even after rollback wiped disk
  assert.ok(task.last_error && task.last_error.length <= 3200, `Expected bounded task.last_error, got ${task.last_error?.length}`);
  assert.match(task.last_error, /test_open_file_location_missing_parent/);
  assert.match(task.last_error, /AssertionError: True is not false/);
  assert.match(task.last_error, /self\.assertFalse\(res\["ok"\]\)/, 'Must preserve exact failing test body from before rollback');
  assert.match(task.last_error, /totally-missing-file\.mp4/, 'Must preserve setup/arguments inside failing test body');
  assert.match(task.last_error, /ui_bridge\/api\.py:5\b/, 'Must preserve project traceback frame file:line');

  // 3) Format directly via formatValidationErrorForRetry & inject into retry prompt for multiple buckets
  for (const stepScope of [['core/history.py'], ['ui_bridge/api.py'], ['tests/test_bridge.py']]) {
    const retryPromptLine = buildWriterRetryInstruction(task.last_error, stepScope);
    assert.match(retryPromptLine, /PREVIOUS ATTEMPT FAILED WITH ERROR:/);
    assert.match(retryPromptLine, /self\.assertFalse\(res\["ok"\]\)/, `Bucket ${stepScope[0]} must receive failing test body on retry`);
    assert.match(retryPromptLine, /AssertionError: True is not false/);
  }

  assert.equal(captured.patchPath, expectedPatchPath);
  console.log('test-retry-error-context-before-rollback.mjs: ALL PASSED');
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(teamDir, { recursive: true, force: true });
}
