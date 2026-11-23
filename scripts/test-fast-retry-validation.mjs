#!/usr/bin/env node
import assert from 'node:assert/strict';

import * as baselinePolicy from './lib/baseline-policy.mjs';
import { createPhaseTimingsTracker } from './lib/task-persistence.mjs';
import { computeCanonicalQueueState } from './lib/queue-state.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const policyCfg = {
  policy: {
    validation: {
      max_baseline_failures: 3,
      fast_checks: [
        { name: 'tab_indentation_check', run: '.\\.venv\\Scripts\\python.exe -m unittest tests/test_indentation.py', timeout_sec: 15 }
      ],
      suite_checks: [
        { name: 'unit_test_suite', run: '.\\.venv\\Scripts\\python.exe -m unittest discover -s tests -v', timeout_sec: 180 }
      ]
    }
  }
};

// Verify new exports exist
assert.equal(typeof baselinePolicy.extractFailingTestTargetsForRetry, 'function', 'Must export extractFailingTestTargetsForRetry');
assert.equal(typeof baselinePolicy.runFastRetryTargetedValidation, 'function', 'Must export runFastRetryTargetedValidation');
assert.equal(typeof baselinePolicy.runSuiteValidationWithFastRetryFirst, 'function', 'Must export runSuiteValidationWithFastRetryFirst');

// 1. Extract failing test targets from unittest FAIL/ERROR output (ignoring __check__ / indentation scanners)
const sampleErr = [
  '======================================================================',
  'FAIL: test_open_file_location_missing_file_reports_error (tests.test_ui_bridge.MediaPathResolutionTests.test_open_file_location_missing_file_reports_error)',
  '----------------------------------------------------------------------',
  'Traceback (most recent call last):',
  '  File "tests/test_ui_bridge.py", line 962, in test_open_file_location_missing_file_reports_error',
  '    self.assertFalse(res["ok"])',
  'AssertionError: True is not false',
  'Ran 309 tests in 25.4s',
  'FAILED (failures=1)'
].join('\n');

const extractedIds = baselinePolicy.extractFailingTestTargetsForRetry(sampleErr, [
  { ok: false, checkName: 'unit_test_suite', command: '.\\.venv\\Scripts\\python.exe -m unittest discover -s tests -v', errorCombined: sampleErr }
]);
assert.deepEqual(extractedIds, ['tests.test_ui_bridge.MediaPathResolutionTests.test_open_file_location_missing_file_reports_error']);

// 2. Retry (retries=1) where targeted check STILL FAILS -> MUST short-circuit WITHOUT running full suite_checks or verification_commands!
{
  const executedCommands = [];
  const recordedSteps = [];
  const tracker = createPhaseTimingsTracker();
  let tick = 1000;
  const nowFn = () => {
    tick += 120;
    return tick;
  };

  const task = {
    task_id: 'T-FAST-RETRY-FAIL',
    mode: 'standard',
    scope: ['ui_bridge/js_api.py', 'tests/test_ui_bridge.py'],
    verification_commands: ['.\\venv\\Scripts\\python.exe -m unittest tests/test_core.py'],
    previous_failing_tests: [...extractedIds],
    steps: []
  };

  let suiteCalled = false;
  const resFail = await baselinePolicy.runSuiteValidationWithFastRetryFirst({
    task,
    retries: 1,
    policyConfig: policyCfg,
    baselineResult: { baseline_failures: [], flaky_baseline_failures: [], baseline_fingerprint: null },
    diffText: '',
    modifiedFiles: ['ui_bridge/js_api.py', 'tests/test_ui_bridge.py'],
    phaseTracker: tracker,
    recordStepFn: (st) => recordedSteps.push(st),
    runCheckFn: async (check) => {
      executedCommands.push(check.run);
      return {
        ok: false,
        stage: 'fast_retry',
        checkName: check.name,
        command: check.run,
        exitCode: 1,
        errorCombined: sampleErr,
        errorHash: 'errhash_fast_retry'
      };
    },
    validateStageChecksFn: async () => {
      suiteCalled = true;
      return { ok: true, skipped: false, checks: [] };
    },
    nowFn
  });

  assert.equal(suiteCalled, false, 'Full suite_checks MUST NOT execute when fast-retry targeted test fails');
  assert.equal(executedCommands.length, 1, 'Should run ONLY targeted command (no dependent verification_commands after fail-fast)');
  assert.match(
    executedCommands[0],
    /-m unittest -v tests\.test_ui_bridge\.MediaPathResolutionTests\.test_open_file_location_missing_file_reports_error/,
    `Expected targeted unittest command, got: ${executedCommands[0]}`
  );
  assert.equal(resFail.shortCircuited, true);
  assert.equal(resFail.baselineEval.outcome, 'retry_writer');
  assert.ok(task.fast_retry_validation_ms > 0, 'Must record task.fast_retry_validation_ms');
  assert.ok(tracker.snapshot().fast_retry_validation_ms > 0, 'Must record phase_timings.fast_retry_validation_ms');
  assert.ok(recordedSteps.some(s => s.action === 'fast_retry_targeted_validation' && s.fast_retry_validation_ms > 0 && s.status === 'failed_fast_retry'));
}

// 3. Retry (retries=1) where targeted check PASSES -> MUST proceed to full suite_checks & verification_commands and record fast_retry_validation_ms
{
  const executedCommands = [];
  const recordedSteps = [];
  const tracker = createPhaseTimingsTracker();
  let tick = 5000;
  const nowFn = () => {
    tick += 85;
    return tick;
  };

  const task = {
    task_id: 'T-FAST-RETRY-PASS',
    mode: 'standard',
    scope: ['ui_bridge/js_api.py', 'tests/test_ui_bridge.py'],
    verification_commands: ['.\\venv\\Scripts\\python.exe -m unittest tests/test_core.py'],
    previous_failing_tests: [...extractedIds],
    steps: []
  };

  let suiteCalled = false;
  const resPass = await baselinePolicy.runSuiteValidationWithFastRetryFirst({
    task,
    retries: 1,
    policyConfig: policyCfg,
    baselineResult: { baseline_failures: [], flaky_baseline_failures: [], baseline_fingerprint: null },
    diffText: '',
    modifiedFiles: ['ui_bridge/js_api.py', 'tests/test_ui_bridge.py'],
    phaseTracker: tracker,
    recordStepFn: (st) => recordedSteps.push(st),
    runCheckFn: async (check) => {
      executedCommands.push(check.run);
      return {
        ok: true,
        stage: check.stage || 'suite_checks',
        checkName: check.name,
        command: check.run,
        exitCode: 0
      };
    },
    validateStageChecksFn: async (stageName) => {
      assert.equal(stageName, 'suite_checks');
      suiteCalled = true;
      return {
        ok: true,
        skipped: false,
        stage: 'suite_checks',
        checks: [{ ok: true, stage: 'suite_checks', checkName: 'unit_test_suite', command: policyCfg.policy.validation.suite_checks[0].run, exitCode: 0 }]
      };
    },
    nowFn
  });

  assert.equal(suiteCalled, true, 'Full suite_checks MUST execute after targeted check passes');
  assert.equal(executedCommands.length, 2, 'Expected targeted check first, then verification_command after full suite starts');
  assert.match(executedCommands[0], /tests\.test_ui_bridge\.MediaPathResolutionTests\.test_open_file_location_missing_file_reports_error/);
  assert.equal(executedCommands[1], '.\\venv\\Scripts\\python.exe -m unittest tests/test_core.py');
  assert.equal(resPass.shortCircuited, false);
  assert.equal(resPass.baselineEval.outcome, 'done');
  assert.ok(task.fast_retry_validation_ms > 0);
  assert.ok(tracker.snapshot().fast_retry_validation_ms > 0);
  assert.ok(recordedSteps.some(s => s.action === 'fast_retry_targeted_validation' && s.status === 'ok' && s.fast_retry_validation_ms > 0));
}

// 4. First attempt (retries=0) must NOT run targeted fast-retry step
{
  let targetedRuns = 0;
  let suiteCalled = false;
  const resAttempt1 = await baselinePolicy.runSuiteValidationWithFastRetryFirst({
    task: { task_id: 'T-ATT1', previous_failing_tests: [...extractedIds] },
    retries: 0,
    policyConfig: policyCfg,
    baselineResult: { baseline_failures: [], flaky_baseline_failures: [], baseline_fingerprint: null },
    runCheckFn: async () => {
      targetedRuns++;
      return { ok: true };
    },
    validateStageChecksFn: async () => {
      suiteCalled = true;
      return { ok: true, skipped: false, checks: [{ ok: true, stage: 'suite_checks', checkName: 'unit_test_suite' }] };
    }
  });
  assert.equal(targetedRuns, 0, 'Attempt 1 (retries=0) must skip fast-retry targeted step');
  assert.equal(suiteCalled, true);
  assert.equal(resAttempt1.fastRetryResult.attempted, false);
}

// 5. queue-state phase_timings normalization preserves fast_retry_validation_ms
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-fast-retry-qs-'));
  try {
    const activeDir = path.join(tmpDir, 'active');
    const archiveDir = path.join(tmpDir, 'archive');
    fs.mkdirSync(activeDir, { recursive: true });
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(activeDir, 'T-FR-QS.yaml'), 'task_id: T-FR-QS\nstatus: blocked\n', 'utf8');
    const canonical = computeCanonicalQueueState({
      tasksActiveDir: activeDir,
      tasksArchiveDir: archiveDir,
      taskState: {
        blocked_tasks: [
          {
            task_id: 'T-FR-QS',
            status: 'blocked',
            phase_timings: { preflight_ms: 10, baseline_ms: 20, writer_ms: [], validate_ms: 500, fast_retry_validation_ms: 240, commit_ms: 0 }
          }
        ],
        completed_tasks: [],
        active_tasks: []
      }
    });
    assert.equal(canonical.blocked[0].phase_timings.fast_retry_validation_ms, 240);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function resolveRealPython() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const venvPy = path.resolve(scriptDir, '../../.venv/Scripts/python.exe');
  const candidates = [venvPy, 'python', 'python3'];
  for (const cmd of candidates) {
    if (cmd === venvPy && !fs.existsSync(cmd)) continue;
    const probe = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 5000 });
    const out = `${probe.stdout || ''} ${probe.stderr || ''}`.trim();
    if (probe.status === 0 && /^Python\s+3\./i.test(out)) return cmd;
  }
  throw new Error('No real Python 3 interpreter found for real-unittest fast_retry tests');
}

function runRealPythonUnittestCheck(realPy, check, cwd) {
  const m = String(check.run || '').match(/-m\s+unittest\s+(.+)$/);
  assert.ok(m, `Expected -m unittest command, got: ${check.run}`);
  const unittestArgs = m[1].trim().split(/\s+/);
  const proc = spawnSync(realPy, ['-m', 'unittest', ...unittestArgs], {
    cwd,
    encoding: 'utf8',
    timeout: 15000
  });
  const combined = `${proc.stdout || ''}\n${proc.stderr || ''}`.trim();
  return {
    ok: proc.status === 0,
    stage: check.stage || 'suite_checks',
    checkName: check.name,
    command: check.run,
    exitCode: proc.status ?? 1,
    errorCombined: combined,
    errorHash: `real_${proc.status ?? 1}_${combined.length}`
  };
}

const realPython = resolveRealPython();
const realPyPolicyCfg = {
  policy: {
    validation: {
      max_baseline_failures: 3,
      fast_checks: [],
      suite_checks: [
        { name: 'unit_test_suite', run: 'python -m unittest discover -s tests -v', timeout_sec: 180 }
      ]
    }
  }
};

// 6. Real Python unittest Case A (Renamed test on retry):
//    Real `python -m unittest` produces `_FailedTest` + `AttributeError` when target test was renamed.
//    Must NOT short-circuit rollback; must fallback to verification_commands module (which passes) + suite_checks.
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-fast-retry-real-renamed-'));
  try {
    const testsDir = path.join(tmpDir, 'tests');
    fs.mkdirSync(testsDir, { recursive: true });
    fs.writeFileSync(path.join(testsDir, '__init__.py'), '', 'utf8');
    fs.writeFileSync(
      path.join(testsDir, 'test_renamed_mod.py'),
      [
        'import unittest',
        '',
        'class KeyCardExtractionTests(unittest.TestCase):',
        '\tdef test_extract_key_card_new_name(self):',
        '\t\tself.assertEqual(1 + 1, 2)',
        ''
      ].join('\n'),
      'utf8'
    );

    const executedChecks = [];
    const recordedSteps = [];
    const tracker = createPhaseTimingsTracker();
    const task = {
      task_id: 'T-FAST-RETRY-REAL-RENAMED',
      mode: 'standard',
      scope: ['core/analysis.py', 'tests/test_renamed_mod.py'],
      verification_commands: ['python -m unittest -v tests.test_renamed_mod'],
      previous_failing_tests: ['tests.test_renamed_mod.KeyCardExtractionTests.test_extract_key_card_old_name'],
      steps: []
    };

    let suiteCalled = false;
    const resRenamed = await baselinePolicy.runSuiteValidationWithFastRetryFirst({
      task,
      retries: 1,
      policyConfig: realPyPolicyCfg,
      baselineResult: { baseline_failures: [], flaky_baseline_failures: [], baseline_fingerprint: null },
      diffText: '',
      modifiedFiles: ['core/analysis.py', 'tests/test_renamed_mod.py'],
      phaseTracker: tracker,
      recordStepFn: (st) => recordedSteps.push(st),
      runCheckFn: async (check) => {
        const res = runRealPythonUnittestCheck(realPython, check, tmpDir);
        executedChecks.push({ stage: check.stage, run: check.run, ok: res.ok, errorCombined: res.errorCombined });
        return res;
      },
      validateStageChecksFn: async () => {
        suiteCalled = true;
        const discoverRes = runRealPythonUnittestCheck(
          realPython,
          { name: 'unit_test_suite', run: 'python -m unittest discover -s tests -v', stage: 'suite_checks' },
          tmpDir
        );
        return { ok: discoverRes.ok, skipped: false, stage: 'suite_checks', checks: [discoverRes] };
      }
    });

    assert.match(
      executedChecks[0].errorCombined,
      /unittest\.loader\._FailedTest/,
      'Precondition: real python -m unittest must emit unittest.loader._FailedTest for renamed test'
    );
    assert.match(
      executedChecks[0].errorCombined,
      /AttributeError:.*has no attribute 'test_extract_key_card_old_name'/,
      'Precondition: real python -m unittest must emit AttributeError for missing test name'
    );
    assert.equal(resRenamed.shortCircuited, false, 'Renamed test target (_FailedTest/AttributeError) must NOT short-circuit rollback');
    assert.equal(resRenamed.fastRetryResult.renamedFallback, true, 'Must set renamedFallback=true');
    assert.ok(
      typeof resRenamed.fastRetryResult.fast_retry_fallback_reason === 'string' && resRenamed.fastRetryResult.fast_retry_fallback_reason.length > 0,
      'Must record non-empty fast_retry_fallback_reason on fastRetryResult'
    );
    assert.equal(task.fast_retry_fallback_reason, resRenamed.fastRetryResult.fast_retry_fallback_reason, 'Must persist fast_retry_fallback_reason on task state');
    assert.ok(
      executedChecks.some(c => c.run === 'python -m unittest -v tests.test_renamed_mod' && c.ok === true),
      'Must fall back to running real verification_commands module and pass'
    );
    assert.equal(suiteCalled, true, 'Must proceed to full suite after verification_commands passes');
    assert.equal(resRenamed.baselineEval.outcome, 'done', 'Attempt with passing renamed tests must succeed');
    assert.ok(
      recordedSteps.some(s => s.action === 'fast_retry_targeted_validation' && s.fast_retry_fallback_reason),
      'Step 3.0 telemetry must include fast_retry_fallback_reason'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// 7. Real Python unittest Case B (Control — real AssertionError failure mixed with renamed target):
//    Real `python -m unittest` runs both a missing test and a real failing test -> MUST still short-circuit fail.
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-fast-retry-real-fail-'));
  try {
    const testsDir = path.join(tmpDir, 'tests');
    fs.mkdirSync(testsDir, { recursive: true });
    fs.writeFileSync(path.join(testsDir, '__init__.py'), '', 'utf8');
    fs.writeFileSync(
      path.join(testsDir, 'test_real_fail_mod.py'),
      [
        'import unittest',
        '',
        'class KeyCardApiTests(unittest.TestCase):',
        '\tdef test_still_broken(self):',
        '\t\tself.assertTrue(False)',
        ''
      ].join('\n'),
      'utf8'
    );

    const executedChecks = [];
    let suiteCalled = false;
    const task = {
      task_id: 'T-FAST-RETRY-REAL-FAIL',
      mode: 'standard',
      scope: ['ui_bridge/js_api.py', 'tests/test_real_fail_mod.py'],
      verification_commands: ['python -m unittest -v tests.test_real_fail_mod'],
      previous_failing_tests: [
        'tests.test_real_fail_mod.KeyCardApiTests.test_old_renamed',
        'tests.test_real_fail_mod.KeyCardApiTests.test_still_broken'
      ],
      steps: []
    };

    const resRealFail = await baselinePolicy.runSuiteValidationWithFastRetryFirst({
      task,
      retries: 1,
      policyConfig: realPyPolicyCfg,
      baselineResult: { baseline_failures: [], flaky_baseline_failures: [], baseline_fingerprint: null },
      diffText: '',
      modifiedFiles: ['ui_bridge/js_api.py', 'tests/test_real_fail_mod.py'],
      runCheckFn: async (check) => {
        const res = runRealPythonUnittestCheck(realPython, check, tmpDir);
        executedChecks.push(res);
        return res;
      },
      validateStageChecksFn: async () => {
        suiteCalled = true;
        return { ok: true, skipped: false, checks: [] };
      }
    });

    assert.match(executedChecks[0].errorCombined, /AssertionError/, 'Precondition: real unittest output must include AssertionError');
    assert.equal(resRealFail.shortCircuited, true, 'Real test failure must STILL short-circuit fail');
    assert.equal(suiteCalled, false, 'Full suite must NOT run when real test failure occurs');
    assert.equal(resRealFail.baselineEval.outcome, 'retry_writer');
    assert.ok(!resRealFail.fastRetryResult.renamedFallback, 'Must NOT mark real failure as renamedFallback');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// 8. Real Python unittest Case C (SyntaxError breaks test module import):
//    Real `python -m unittest` fails to import broken module with real SyntaxError ->
//    MUST fail validation (`retry_writer`), NEVER swallow SyntaxError, and NEVER run full suite green.
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-fast-retry-real-syntax-'));
  try {
    const testsDir = path.join(tmpDir, 'tests');
    fs.mkdirSync(testsDir, { recursive: true });
    fs.writeFileSync(path.join(testsDir, '__init__.py'), '', 'utf8');
    fs.writeFileSync(
      path.join(testsDir, 'test_syntax_mod.py'),
      [
        'import unittest',
        '',
        'def broken(:',
        '\tpass',
        ''
      ].join('\n'),
      'utf8'
    );

    const executedChecks = [];
    let suiteCalled = false;
    const task = {
      task_id: 'T-FAST-RETRY-REAL-SYNTAX',
      mode: 'standard',
      scope: ['core/analysis.py', 'tests/test_syntax_mod.py'],
      verification_commands: ['python -m unittest -v tests.test_syntax_mod'],
      previous_failing_tests: ['tests.test_syntax_mod.KeyCardExtractionTests.test_broken_syntax'],
      steps: []
    };

    const resSyntax = await baselinePolicy.runSuiteValidationWithFastRetryFirst({
      task,
      retries: 1,
      policyConfig: realPyPolicyCfg,
      baselineResult: { baseline_failures: [], flaky_baseline_failures: [], baseline_fingerprint: null },
      diffText: '',
      modifiedFiles: ['core/analysis.py', 'tests/test_syntax_mod.py'],
      runCheckFn: async (check) => {
        const res = runRealPythonUnittestCheck(realPython, check, tmpDir);
        executedChecks.push({ stage: check.stage, run: check.run, ok: res.ok, errorCombined: res.errorCombined });
        return res;
      },
      validateStageChecksFn: async () => {
        suiteCalled = true;
        return { ok: true, skipped: false, checks: [] };
      }
    });

    assert.equal(resSyntax.baselineEval.outcome, 'retry_writer', 'SyntaxError in module MUST fail validation (never swallowed)');
    assert.equal(suiteCalled, false, 'SyntaxError must fail before green full suite');
    assert.match(
      String(resSyntax.suiteVal?.errorCombined || resSyntax.enrichedSuiteChecks?.map(c => c.errorCombined).join('\n') || ''),
      /SyntaxError/,
      'Real SyntaxError from python -m unittest must be preserved in validation error output'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

console.log('test-fast-retry-validation.mjs: ALL PASSED');
