#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as validatorMod from './validator.mjs';
import { recordTaskStep } from './lib/task-persistence.mjs';
import { writeMorningReportFile } from './lib/queue-state.mjs';

function makeTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-vacuous-test-'));
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

function writeFilesAndCommit(dir, files, msg) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', msg], { cwd: dir, stdio: 'ignore' });
}

assert.equal(
  typeof validatorMod.detectVacuousNewTestsOnParent,
  'function',
  'validator.mjs must export detectVacuousNewTestsOnParent()'
);
const { detectVacuousNewTestsOnParent } = validatorMod;

const repo = makeTempGitRepo();
const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-vacuous-report-'));

try {
  writeFilesAndCommit(repo, {
    'src/math.mjs': 'export function add(a, b) {\n  return a + b;\n}\n',
    'tests/math.test.mjs': [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import * as math from '../src/math.mjs';",
      '',
      "test('test_existing_add', () => {",
      '  assert.equal(math.add(1, 2), 3);',
      '});'
    ].join('\n') + '\n'
  }, 'parent commit');

  // Branch A: new test fails on parent (missing math.mul) -> no vacuous_test warning
  fs.writeFileSync(path.join(repo, 'src/math.mjs'), [
    'export function add(a, b) {',
    '  return a + b;',
    '}',
    'export function mul(a, b) {',
    '  return a * b;',
    '}'
  ].join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(repo, 'tests/math.test.mjs'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import * as math from '../src/math.mjs';",
    '',
    "test('test_existing_add', () => {",
    '  assert.equal(math.add(1, 2), 3);',
    '});',
    '',
    "test('test_new_mul_feature', () => {",
    '  assert.equal(math.mul(3, 4), 12);',
    '});'
  ].join('\n') + '\n', 'utf8');

  const diffFailOnParent = execFileSync('git', ['diff', '-U3'], { cwd: repo, encoding: 'utf8' });
  const resFailOnParent = detectVacuousNewTestsOnParent(
    diffFailOnParent,
    { kind: 'feature' },
    { repoRoot: repo, parentRef: 'HEAD' }
  );
  assert.equal(resFailOnParent.ok, true);
  assert.equal(resFailOnParent.skipped, false);
  assert.equal(resFailOnParent.vacuousTests.length, 0, 'Test that fails on parent must NOT emit vacuous_test');
  assert.equal(resFailOnParent.warnings.length, 0);

  // Branch B: new test passes on parent (vacuous) -> emits vacuous_test warning (warn-only), records into steps[] & morning-report.md
  fs.writeFileSync(path.join(repo, 'tests/math.test.mjs'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import * as math from '../src/math.mjs';",
    '',
    "test('test_existing_add', () => {",
    '  assert.equal(math.add(1, 2), 3);',
    '});',
    '',
    "test('test_always_passes_vacuous', () => {",
    '  assert.equal(math.add(2, 2), 4);',
    '});'
  ].join('\n') + '\n', 'utf8');

  const diffPassOnParent = execFileSync('git', ['diff', '-U3'], { cwd: repo, encoding: 'utf8' });
  const resPassOnParent = detectVacuousNewTestsOnParent(
    diffPassOnParent,
    { kind: 'bugfix' },
    { repoRoot: repo, parentRef: 'HEAD' }
  );
  assert.equal(resPassOnParent.ok, true, 'vacuous_test check must be warn-only (ok=true)');
  assert.equal(resPassOnParent.skipped, false);
  assert.equal(resPassOnParent.vacuousTests.length, 1, 'Test passing on parent must record 1 vacuous_test');
  assert.equal(resPassOnParent.vacuousTests[0].code, 'vacuous_test');
  assert.equal(resPassOnParent.vacuousTests[0].test_name, 'test_always_passes_vacuous');
  assert.equal(resPassOnParent.vacuousTests[0].file, 'tests/math.test.mjs');

  // kind=refactor skips this check
  const resRefactor = detectVacuousNewTestsOnParent(
    diffPassOnParent,
    { kind: 'refactor' },
    { repoRoot: repo, parentRef: 'HEAD' }
  );
  assert.equal(resRefactor.skipped, true);

  // Verify steps[] + morning-report.md recording
  const fakeTask = {
    task_id: 'T-VACUOUS-1',
    title: 'Sample bugfix task',
    kind: 'bugfix',
    mode: 'quick',
    status: 'done',
    steps: [],
    vacuous_tests: resPassOnParent.vacuousTests
  };
  const stepEntry = recordTaskStep(fakeTask, {
    step: '3.5',
    attempt: 1,
    role: 'validator',
    action: 'vacuous_test_check',
    requested_model: '0-token',
    actual_model: '0-token',
    model: '0-token',
    status: 'warning',
    warnings: resPassOnParent.vacuousTests,
    vacuous_tests: resPassOnParent.vacuousTests,
    duration_ms: 5
  }, { teamDir: reportDir, skipJsonl: true });

  assert.ok(Array.isArray(stepEntry.vacuous_tests) && stepEntry.vacuous_tests.length === 1);
  assert.equal(stepEntry.vacuous_tests[0].code, 'vacuous_test');
  assert.equal(stepEntry.vacuous_tests[0].test_name, 'test_always_passes_vacuous');

  const reportPath = path.join(reportDir, 'morning-report.md');
  writeMorningReportFile(
    { queue: [], completed_tasks: [fakeTask], blocked_tasks: [], active_tasks: [] },
    { reportFile: reportPath, teamDir: reportDir }
  );
  const reportText = fs.readFileSync(reportPath, 'utf8');
  assert.match(reportText, /vacuous_test/);
  assert.match(reportText, /test_always_passes_vacuous/);
  assert.match(reportText, /tests\/math\.test\.mjs/);

  // Branch C: Classify parent failure kinds (AssertionError = strong behavior vs AttributeError/ImportError = surface signature vs TypeError)
  assert.equal(typeof validatorMod.classifyParentTestFailureKind, 'function', 'validator.mjs must export classifyParentTestFailureKind');
  assert.equal(validatorMod.classifyParentTestFailureKind('Traceback...\nAssertionError: False is not true'), 'AssertionError');
  assert.equal(validatorMod.classifyParentTestFailureKind("AssertionError [ERR_ASSERTION]: Expected values to be strictly equal"), 'AssertionError');
  assert.equal(validatorMod.classifyParentTestFailureKind("AttributeError: 'JsApi' object has no attribute 'open_file_location'"), 'AttributeError');
  assert.equal(validatorMod.classifyParentTestFailureKind("ImportError: cannot import name 'delete_history_entry' from 'core.history'"), 'ImportError');
  assert.equal(validatorMod.classifyParentTestFailureKind("ModuleNotFoundError: No module named 'core.missing'"), 'ImportError');
  assert.equal(validatorMod.classifyParentTestFailureKind('TypeError: math.mul is not a function'), 'TypeError');
  assert.equal(validatorMod.classifyParentTestFailureKind('RuntimeError: unexpected failure'), 'Other');

  // Assert Branch A (JS math.mul is not a function) recorded TypeError in return metadata
  assert.equal(resFailOnParent.parent_failure_kind, 'TypeError');
  assert.ok(Array.isArray(resFailOnParent.parentTestResults) && resFailOnParent.parentTestResults.length === 1);
  assert.equal(resFailOnParent.parentTestResults[0].parent_failure_kind, 'TypeError');

  // Branch D: Strong behavior check (AssertionError on parent)
  fs.writeFileSync(path.join(repo, 'src/math.mjs'), [
    'export function add(a, b) {',
    '  return a + b + 10;',
    '}'
  ].join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(repo, 'tests/math.test.mjs'), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import * as math from '../src/math.mjs';",
    '',
    "test('test_existing_add', () => {",
    '  assert.equal(math.add(1, 2), 3);',
    '});',
    '',
    "test('test_add_behavior_mismatch', () => {",
    '  assert.equal(math.add(2, 3), 15);',
    '});'
  ].join('\n') + '\n', 'utf8');
  const diffAssertFail = execFileSync('git', ['diff', '-U3'], { cwd: repo, encoding: 'utf8' });
  const resAssertFail = detectVacuousNewTestsOnParent(
    diffAssertFail,
    { kind: 'bugfix' },
    { repoRoot: repo, parentRef: 'HEAD' }
  );
  assert.equal(resAssertFail.vacuousTests.length, 0);
  assert.equal(resAssertFail.parent_failure_kind, 'AssertionError');
  assert.equal(resAssertFail.parentTestResults[0].parent_failure_kind, 'AssertionError');
  assert.equal(resAssertFail.parentTestResults[0].verification_strength, 'strong_behavior_check');

  // Branch E: Surface signature check (AttributeError / ImportError simulated via runTestOnParent hook, plus steps[] persistence)
  const resAttrFail = detectVacuousNewTestsOnParent(
    diffAssertFail,
    { kind: 'feature' },
    {
      repoRoot: repo,
      parentRef: 'HEAD',
      runTestOnParent: () => ({
        passed: false,
        runner: 'unittest',
        output: "AttributeError: 'JsApi' object has no attribute 'delete_history_item'"
      })
    }
  );
  assert.equal(resAttrFail.parent_failure_kind, 'AttributeError');
  assert.equal(resAttrFail.parentTestResults[0].parent_failure_kind, 'AttributeError');
  assert.equal(resAttrFail.parentTestResults[0].verification_strength, 'surface_signature_check');

  const stepWithKind = recordTaskStep(fakeTask, {
    step: '3.5',
    attempt: 1,
    role: 'validator',
    action: 'vacuous_test_check',
    requested_model: '0-token',
    actual_model: '0-token',
    model: '0-token',
    status: 'ok',
    parent_failure_kind: resAttrFail.parent_failure_kind,
    parent_test_results: resAttrFail.parentTestResults,
    duration_ms: 4
  }, { teamDir: reportDir, skipJsonl: true });
  assert.equal(stepWithKind.parent_failure_kind, 'AttributeError');
  assert.equal(stepWithKind.parent_test_results[0].verification_strength, 'surface_signature_check');

  console.log('test-vacuous-new-tests.mjs: ALL PASSED');
} finally {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(reportDir, { recursive: true, force: true });
}
