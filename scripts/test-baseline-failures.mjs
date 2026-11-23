#!/usr/bin/env node
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(TEAM_DIR, '..');

function makeEnvFingerprint(overrides = {}) {
  return {
    python_path: 'D:\\tool-download\\.venv\\Scripts\\python.exe',
    is_admin: false,
    loopback_bindable: true,
    pip_freeze_hash: 'pip-hash-v1',
    platform: 'win32',
    node_version: process.version,
    onnxruntime: {
      installed: true,
      import_ok: true,
      version: '1.24.4',
      providers: ['CPUExecutionProvider', 'DmlExecutionProvider'],
      error: null
    },
    onnx_models: [
      { name: 'lama_fp32.onnx', path: 'C:\\models\\lama_fp32.onnx', exists: true, size_bytes: 1024, sha256: 'sha-lama-1' }
    ],
    checked_at: '2026-11-16T00:00:00.000Z',
    ...overrides
  };
}

function findRealPython({ candidates = ['python', 'python3'], execFn = execFileSync, env } = {}) {
  for (const candidate of candidates) {
    try {
      const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000 };
      if (env) opts.env = env;
      const out = execFn(candidate, ['--version'], opts);
      const versionText = typeof out === 'string'
        ? out.trim()
        : `${out?.stdout || ''} ${out?.stderr || ''}`.trim();
      if (/^Python\s+\d+\.\d+/i.test(versionText)) {
        return { command: candidate, version: versionText };
      }
    } catch {}
  }
  return null;
}

function runPythonIndentationSmokeCheck({ repoRoot, tmpRepo, extractFn, execFn = execFileSync, log = console.log, env } = {}) {
  const indentationTestPath = path.join(repoRoot, 'tests', 'test_indentation.py');
  if (!fs.existsSync(indentationTestPath)) {
    log('[SKIP] Real Python indentation smoke check skipped: tests/test_indentation.py not found.');
    return { executed: false, skipped: true, reason: 'missing_test_file', parsed: [] };
  }
  const realPython = findRealPython({ execFn, env });
  if (!realPython) {
    log('[SKIP] Real Python indentation smoke check skipped: no real Python interpreter available on PATH.');
    return { executed: false, skipped: true, reason: 'python_not_found', parsed: [] };
  }
  const targetTestFile = path.join(tmpRepo, 'tests', 'test_indentation.py');
  if (!fs.existsSync(targetTestFile)) {
    fs.copyFileSync(indentationTestPath, targetTestFile);
  }
  const badPyPath = path.join(tmpRepo, 'core', 'space_bad.py');
  fs.writeFileSync(badPyPath, 'def bad():\n    return 0\n', 'utf8');
  let realPyOut = '';
  try {
    const opts = { cwd: tmpRepo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 };
    if (env) opts.env = env;
    execFn(realPython.command, ['-m', 'unittest', 'tests/test_indentation.py'], opts);
  } catch (pyErr) {
    if (pyErr?.code === 'ENOENT' || /Python was not found/i.test(`${pyErr?.stderr || ''} ${pyErr?.message || ''}`)) {
      log(`[SKIP] Real Python indentation smoke check skipped: Python unavailable (${pyErr.code || pyErr.message}).`);
      return { executed: false, skipped: true, reason: 'python_unavailable', parsed: [] };
    }
    realPyOut = `${pyErr?.stdout || ''}\n${pyErr?.stderr || ''}`;
  } finally {
    try { if (fs.existsSync(badPyPath)) fs.unlinkSync(badPyPath); } catch {}
  }
  const parsed = extractFn({
    checkName: 'tab_indentation_check',
    command: `${realPython.command} -m unittest tests/test_indentation.py`,
    ok: false,
    exitCode: 1,
    errorCombined: realPyOut
  });
  return { executed: true, skipped: false, python: realPython.command, version: realPython.version, parsed };
}

function createTempPythonRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-baseline-test-'));
  execFileSync('git', ['init', '-q'], { cwd: repoDir, stdio: 'pipe' });
  fs.mkdirSync(path.join(repoDir, 'core'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'tests'), { recursive: true });

  fs.writeFileSync(path.join(repoDir, 'core', 'shared_helper.py'), 'def help_me():\n\treturn 1\n', 'utf8');
  fs.writeFileSync(
    path.join(repoDir, 'core', 'pipeline.py'),
    'from core.shared_helper import help_me\n\ndef run_step():\n\treturn help_me()\n',
    'utf8'
  );
  fs.writeFileSync(path.join(repoDir, 'core', 'eraser.py'), 'def erase():\n\treturn True\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, 'core', 'unrelated.py'), 'def other():\n\treturn 0\n', 'utf8');

  fs.writeFileSync(
    path.join(repoDir, 'tests', 'test_eraser.py'),
    'import unittest\n\nclass TestEraser(unittest.TestCase):\n\tdef test_ok(self):\n\t\tself.assertTrue(True)\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(repoDir, 'tests', 'test_custom_flow.py'),
    'import unittest\nfrom core.pipeline import run_step\n\nclass TestCustomFlow(unittest.TestCase):\n\tdef test_flow(self):\n\t\tself.assertEqual(run_step(), 1)\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(repoDir, 'tests', 'test_unrelated.py'),
    'import unittest\nfrom core.unrelated import other\n\nclass TestOther(unittest.TestCase):\n\tdef test_broken(self):\n\t\tself.assertEqual(other(), 999)\n',
    'utf8'
  );
  return repoDir;
}

async function runTests() {
  console.log('Testing Baseline Failures, Flaky Tracking, Cache, Scope Mapping & 5-Gate Policy (TDD)...\n');

  const mod = await import('./lib/baseline-policy.mjs');
  const {
    DEFAULT_MAX_BASELINE_FAILURES,
    computeBaselineDepsHash,
    extractCheckFailureIdentities,
    mapFailureToScope,
    runBaselinePreflight,
    evaluateTaskOutcomeWithBaseline,
    formatFlakyBaselineReport
  } = mod;

  const { computeScopeHash, transitionTaskState, sanitizeTaskState } = await import('./lib/task-persistence.mjs');
  const { mergePolicyWithDefaults, DEFAULT_POLICY_CONFIG } = await import('./lib/risk-policy.mjs');
  const { computeCanonicalQueueState } = await import('./lib/queue-state.mjs');

  assert.strictEqual(DEFAULT_MAX_BASELINE_FAILURES, 3, 'Default max_baseline_failures must be 3');
  assert.strictEqual(DEFAULT_POLICY_CONFIG.validation.max_baseline_failures, 3);
  const mergedDefault = mergePolicyWithDefaults({ policy: { project_id: 'x', scope_control: { allowed_dirs: ['core/'] } } });
  assert.strictEqual(mergedDefault.validation.max_baseline_failures, 3);

  const tmpRepo = createTempPythonRepo();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-baseline-cache-'));

  try {
    // -------------------------------------------------------------------------
    // 1. Repo-wide scanner per-file subTest parsing & comparison (never coarse test_id / error_hash)
    // -------------------------------------------------------------------------
    console.log('1. Testing repo-wide subTest-per-file extraction & scope separation...');
    const subTestOutput = [
      'FAIL: test_production_and_bridge_files_use_tab_indentation (tests.test_indentation.IndentationTests.test_production_and_bridge_files_use_tab_indentation) (file=\'core/unrelated.py\')',
      '----------------------------------------------------------------------',
      'Traceback (most recent call last):',
      '  File "D:\\tool-download\\tests\\test_indentation.py", line 78, in test_production_and_bridge_files_use_tab_indentation',
      '    self.fail("Found 2 space-indented lines")',
      'AssertionError: Found 2 space-indented lines',
      '',
      'FAIL: test_production_and_bridge_files_use_tab_indentation (tests.test_indentation.IndentationTests.test_production_and_bridge_files_use_tab_indentation) (file=\'core/eraser.py\')',
      'AssertionError: Found 1 space-indented line'
    ].join('\n');

    const subTestFailures = extractCheckFailureIdentities({
      checkName: 'tab_indentation_check',
      command: '.\\.venv\\Scripts\\python.exe -m unittest tests/test_indentation.py',
      ok: false,
      exitCode: 1,
      errorCombined: subTestOutput
    });
    assert.strictEqual(subTestFailures.length, 2, `Expected 2 per-file subTest failures, got ${subTestFailures.length}`);
    assert.strictEqual(subTestFailures[0].check_name, 'tab_indentation_check');
    assert.strictEqual(subTestFailures[0].target_file, 'core/unrelated.py');
    assert.strictEqual(subTestFailures[1].target_file, 'core/eraser.py');
    assert.notStrictEqual(subTestFailures[0].test_id, subTestFailures[1].test_id, 'Different files must have distinct test_ids');
    assert.ok(!('error_hash' in subTestFailures[0]) || subTestFailures[0].failure_key === `${subTestFailures[0].check_name}::${subTestFailures[0].test_id}`);

    // Real Python unittest subTest output smoke check against tests/test_indentation.py (via PATH python, never gitignored .venv)
    const testIndentationSrc = path.join(REPO_ROOT, 'tests', 'test_indentation.py');
    if (fs.existsSync(testIndentationSrc)) {
      fs.copyFileSync(testIndentationSrc, path.join(tmpRepo, 'tests', 'test_indentation.py'));
    }

    // Branch 1: Missing / non-real Python must skip clearly with [SKIP] log and NOT fail
    const skipLogs = [];
      const missingPyRes = runPythonIndentationSmokeCheck({
        repoRoot: REPO_ROOT,
        tmpRepo,
        extractFn: extractCheckFailureIdentities,
        execFn: () => { const err = new Error('spawnSync python ENOENT'); err.code = 'ENOENT'; throw err; },
        log: msg => skipLogs.push(String(msg))
      });
      assert.strictEqual(missingPyRes.skipped, true, 'Missing Python branch must return skipped: true');
      assert.strictEqual(missingPyRes.executed, false, 'Missing Python branch must not execute unittest');
      assert.ok(
        skipLogs.some(line => /\[SKIP\]/i.test(line) && /Python/i.test(line)),
        `Missing Python branch must emit clear [SKIP] message. Got: ${JSON.stringify(skipLogs)}`
      );

      // Simulate Windows Store alias / broken Python shim exiting non-zero without Python version banner
      const storeStubLogs = [];
      const storeStubRes = runPythonIndentationSmokeCheck({
        repoRoot: REPO_ROOT,
        tmpRepo,
        extractFn: extractCheckFailureIdentities,
        execFn: (_cmd, args) => {
          if (args[0] === '--version') {
            const err = new Error('Python was not found; run without arguments to install from Microsoft Store');
            err.status = 9009;
            err.stderr = 'Python was not found';
            throw err;
          }
          throw new Error('Unexpected call on store stub');
        },
        log: msg => storeStubLogs.push(String(msg))
      });
      assert.strictEqual(storeStubRes.skipped, true, 'Store stub Python must be treated as missing and skipped');
      assert.ok(storeStubLogs.some(line => /\[SKIP\]/i.test(line)), 'Store stub skip must emit clear [SKIP] message');

      // Simulate zero-exit non-Python shim returning unexpected version text
      const nonPyLogs = [];
      const nonPyRes = runPythonIndentationSmokeCheck({
        repoRoot: REPO_ROOT,
        tmpRepo,
        extractFn: extractCheckFailureIdentities,
        execFn: (_cmd, args) => (args[0] === '--version' ? 'custom-wrapper 1.0\n' : ''),
        log: msg => nonPyLogs.push(String(msg))
      });
      assert.strictEqual(nonPyRes.skipped, true, 'Non-Python --version banner must be skipped cleanly');
      assert.ok(nonPyLogs.some(line => /\[SKIP\]/i.test(line)), 'Non-Python banner skip must emit clear [SKIP] message');

    // Branch 2a: Deterministic Python-present branch (always verifies unittest failure extraction even on hosts without Python)
    const mockPyLogs = [];
    const fakePyRes = runPythonIndentationSmokeCheck({
      repoRoot: REPO_ROOT,
      tmpRepo,
      extractFn: extractCheckFailureIdentities,
      execFn: (_cmd, args) => {
        if (args[0] === '--version') return 'Python 3.12.4\n';
        if (args[0] === '-m' && args[1] === 'unittest') {
          const err = new Error('unittest failed');
          err.status = 1;
          err.stderr = [
            '======================================================================',
            "FAIL: test_production_and_bridge_files_use_tab_indentation (tests.test_indentation.IndentationTests.test_production_and_bridge_files_use_tab_indentation) (file='core/space_bad.py')",
            '----------------------------------------------------------------------',
            'AssertionError: Found 1 space-indented line',
            '',
            'Ran 1 test in 0.010s',
            'FAILED (failures=1)'
          ].join('\n');
          throw err;
        }
        throw new Error(`Unexpected fake python args: ${args.join(' ')}`);
      },
      log: msg => mockPyLogs.push(String(msg))
    });
    assert.strictEqual(fakePyRes.skipped, false, 'Valid Python branch must execute unittest smoke check');
    assert.strictEqual(fakePyRes.executed, true);
    assert.ok(fakePyRes.parsed.some(item => item.target_file === 'core/space_bad.py'));

    // Branch 2b: Host Python check — runs real unittest when real Python exists on PATH, skips clearly otherwise
    const hostLogs = [];
    const hostPyRes = runPythonIndentationSmokeCheck({
      repoRoot: REPO_ROOT,
      tmpRepo,
      extractFn: extractCheckFailureIdentities,
      execFn: execFileSync,
      log: msg => hostLogs.push(String(msg))
    });
    if (hostPyRes.skipped) {
      assert.ok(
        hostLogs.some(line => /\[SKIP\]/i.test(line) && /Python/i.test(line)),
        `Host skip without Python must log clear [SKIP] notice. Got: ${JSON.stringify(hostLogs)}`
      );
      console.log(`  ${hostLogs.find(line => /\[SKIP\]/i.test(line))}`);
    } else {
      assert.strictEqual(hostPyRes.executed, true);
      assert.ok(hostPyRes.parsed.some(item => item.target_file === 'core/space_bad.py'));
    }
    console.log('✓ Repo-wide subTest-per-file extraction & Python-missing skip branches verified.');

    // -------------------------------------------------------------------------
    // 2. Baseline 1 full + 2x retry-red-only + Flaky (1-2/3) with owner & due_at
    // -------------------------------------------------------------------------
    console.log('2. Testing 1+2 baseline collection, flaky 1-2/3 classification & (HEAD sha, env_fingerprint) cache...');
    const callLog = [];
    const suiteChecks = [
      { name: 'fast_clean', stage: 'fast_checks', run: 'echo ok' },
      { name: 'tab_indentation_check', stage: 'fast_checks', run: '.\\.venv\\Scripts\\python.exe -m unittest tests/test_indentation.py' },
      { name: 'unit_test_suite', stage: 'suite_checks', run: '.\\.venv\\Scripts\\python.exe -m unittest discover -s tests -v' }
    ];

    const fpBase = makeEnvFingerprint({ checked_at: '2026-11-16T00:01:00.000Z' });
    let runCallIdx = 0;
    const mockRunner = async (check, ctx) => {
      callLog.push({ round: ctx.round, checkName: check.name, targetTestIds: ctx.targetTestIds || null });
      if (check.name === 'fast_clean') {
        return { ok: true, checkName: check.name, stage: check.stage, command: check.run, exitCode: 0, errorCombined: '', env_fingerprint: fpBase };
      }
      if (check.name === 'tab_indentation_check') {
        // Red 3/3 times on core/unrelated.py (persistent baseline failure)
        return {
          ok: false,
          checkName: check.name,
          stage: check.stage,
          command: check.run,
          exitCode: 1,
          errorCombined: "FAIL: test_production_and_bridge_files_use_tab_indentation (tests.test_indentation.IndentationTests.test_production_and_bridge_files_use_tab_indentation) (file='core/unrelated.py')\nAssertionError: Found 1 space-indented line",
          env_fingerprint: fpBase
        };
      }
      if (check.name === 'unit_test_suite') {
        runCallIdx++;
        // Round 1: 2 red tests (test_broken + test_flaky); Round 2: test_broken + test_flaky; Round 3: ONLY test_broken (so test_flaky is 2/3, test_broken is 3/3!)
        const lines = [
          'FAIL: test_broken (tests.test_unrelated.TestOther.test_broken)',
          'AssertionError: persistent'
        ];
        if (runCallIdx <= 2) {
          lines.push(
            'FAIL: test_flaky_once (tests.test_eraser.TestEraser.test_flaky_once)',
            'AssertionError: flaky 2/3'
          );
        }
        return {
          ok: false,
          checkName: check.name,
          stage: check.stage,
          command: check.run,
          exitCode: 1,
          errorCombined: lines.join('\n'),
          env_fingerprint: fpBase
        };
      }
      return { ok: true, checkName: check.name, stage: check.stage, exitCode: 0, errorCombined: '', env_fingerprint: fpBase };
    };

    const cacheFile = path.join(cacheDir, 'baseline-cache.json');
    const policyWithOwners = {
      policy: {
        repo_root: tmpRepo,
        validation: {
          max_baseline_failures: 3,
          fast_checks: suiteChecks.filter(c => c.stage === 'fast_checks'),
          suite_checks: suiteChecks.filter(c => c.stage === 'suite_checks'),
          known_failures: [
            { check_name: 'tab_indentation_check', test_id_contains: 'core/unrelated.py', owner: 'qa-bot', due_at: '2026-12-10' },
            { check_name: 'unit_test_suite', test_id_contains: 'test_broken', owner: 'alice', due_at: '2026-12-15' },
            { check_name: 'unit_test_suite', test_id_contains: 'test_flaky_once', owner: 'bob', due_at: '2026-12-01' }
          ]
        }
      }
    };

    const baseRes1 = await runBaselinePreflight({
      policyConfig: policyWithOwners,
      repoRoot: tmpRepo,
      headSha: 'abc111',
      cacheFile,
      collectFingerprintFn: async () => fpBase,
      runCheckFn: mockRunner
    });

    assert.strictEqual(baseRes1.ok, true);
    assert.strictEqual(baseRes1.cacheHit, false);
    assert.strictEqual(baseRes1.blocked, false);
    // Verify fast_clean ran ONLY in round 1 (NOT re-run in rounds 2 & 3!)
    const round2Checks = callLog.filter(c => c.round === 2).map(c => c.checkName);
    const round3Checks = callLog.filter(c => c.round === 3).map(c => c.checkName);
    assert.ok(!round2Checks.includes('fast_clean'), 'Passing check must NOT be re-run in round 2');
    assert.ok(!round3Checks.includes('fast_clean'), 'Passing check must NOT be re-run in round 3');
    assert.strictEqual(baseRes1.baseline_failures.length, 2, `Expected 2 persistent (3/3) baseline failures, got ${JSON.stringify(baseRes1.baseline_failures)}`);
    assert.strictEqual(baseRes1.flaky_baseline_failures.length, 1, `Expected 1 flaky (2/3) failure, got ${JSON.stringify(baseRes1.flaky_baseline_failures)}`);
    assert.strictEqual(baseRes1.flaky_baseline_failures[0].fail_count, 2);
    assert.strictEqual(baseRes1.flaky_baseline_failures[0].total_runs, 3);
    assert.strictEqual(baseRes1.flaky_baseline_failures[0].owner, 'bob');
    assert.strictEqual(baseRes1.flaky_baseline_failures[0].due_at, '2026-12-01');

    const flakyReportText = formatFlakyBaselineReport(baseRes1.flaky_baseline_failures);
    assert.ok(flakyReportText.includes('test_flaky_once') && flakyReportText.includes('bob') && flakyReportText.includes('2026-12-01'));

    // Cache HIT when HEAD sha & env_fingerprint match (ONLY checked_at differs!)
    const prevCallCount = callLog.length;
    const fpSameDifferentTime = makeEnvFingerprint({ checked_at: '2099-05-05T05:05:05.000Z' });
    const baseResCached = await runBaselinePreflight({
      policyConfig: policyWithOwners,
      repoRoot: tmpRepo,
      headSha: 'abc111',
      cacheFile,
      collectFingerprintFn: async () => fpSameDifferentTime,
      runCheckFn: mockRunner
    });
    assert.strictEqual(baseResCached.cacheHit, true, 'Matching (HEAD sha, env_fingerprint except checked_at) MUST hit baseline cache');
    assert.strictEqual(callLog.length, prevCallCount, 'Cache hit must not execute any validation commands');
    assert.strictEqual(baseResCached.flaky_baseline_failures.length, 1, 'Cached baseline must preserve flaky_baseline_failures for per-task reporting');

    // Cache HIT when HEAD sha changes OR docs/agent-team meta changes, while dependency contents & env_fingerprint stay identical
    assert.strictEqual(typeof computeBaselineDepsHash, 'function', 'baseline-policy must export computeBaselineDepsHash');
    fs.mkdirSync(path.join(tmpRepo, 'agent-team'), { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, 'ui_web'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'ui_web', 'index.html'), '<div id="kept"></div>\n', 'utf8');

    const baseResAfterDocEdit = await runBaselinePreflight({
      policyConfig: policyWithOwners,
      repoRoot: tmpRepo,
      headSha: 'abc111',
      cacheFile,
      collectFingerprintFn: async () => fpSameDifferentTime,
      runCheckFn: mockRunner
    });
    // Note: baseRes1 didn't have ui_web/index.html yet so adding ui_web/index.html triggers 1 miss,
    // after which changing HEAD sha or docs/agent-team MUST stay cached!
    assert.strictEqual(typeof baseResAfterDocEdit.deps_hash, 'string', 'runBaselinePreflight must return deps_hash');
    assert.ok(baseResAfterDocEdit.deps_hash.length === 64, 'deps_hash must be a SHA-256 hex digest');

    const baseResWarm = await runBaselinePreflight({
      policyConfig: policyWithOwners,
      repoRoot: tmpRepo,
      headSha: 'abc111',
      cacheFile,
      collectFingerprintFn: async () => fpSameDifferentTime,
      runCheckFn: mockRunner
    });
    assert.strictEqual(baseResWarm.cacheHit, true);

    fs.writeFileSync(path.join(tmpRepo, 'agent-team', 'DECISIONS.md'), '# Updated decision\n', 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'docs', 'STATE.md'), '# Updated state\n', 'utf8');
    const callsBeforeMetaAndHeadChange = callLog.length;
    const baseResNewHead = await runBaselinePreflight({
      policyConfig: policyWithOwners,
      repoRoot: tmpRepo,
      headSha: 'def222',
      cacheFile,
      collectFingerprintFn: async () => fpSameDifferentTime,
      runCheckFn: mockRunner
    });
    assert.strictEqual(baseResNewHead.cacheHit, true, 'Changed HEAD sha or docs/agent-team files alone MUST HIT dependency-hash cache');
    assert.strictEqual(callLog.length, callsBeforeMetaAndHeadChange, 'Cache hit on new HEAD must execute 0 validation commands');
    assert.strictEqual(baseResNewHead.deps_hash, baseResWarm.deps_hash);

    // Cache MISS when a transitive dependency (core/shared_helper.py) changes even with SAME HEAD sha (dirty worktree!)
    fs.writeFileSync(path.join(tmpRepo, 'core', 'shared_helper.py'), 'def help_me():\n\treturn 2\n', 'utf8');
    const baseResDirtyPy = await runBaselinePreflight({
      policyConfig: policyWithOwners,
      repoRoot: tmpRepo,
      headSha: 'def222',
      cacheFile,
      collectFingerprintFn: async () => fpSameDifferentTime,
      runCheckFn: async (check) => ({ ok: true, checkName: check.name, stage: check.stage, exitCode: 0, errorCombined: '', env_fingerprint: fpSameDifferentTime })
    });
    assert.strictEqual(baseResDirtyPy.cacheHit, false, 'Modifying transitive source core/shared_helper.py MUST miss baseline cache even on same HEAD');
    assert.notStrictEqual(baseResDirtyPy.deps_hash, baseResWarm.deps_hash);

    // Cache MISS when a test file (tests/test_eraser.py) or frontend UI file (ui_web/index.html) changes
    fs.writeFileSync(path.join(tmpRepo, 'ui_web', 'index.html'), '<div id="changed"></div>\n', 'utf8');
    const baseResDirtyUi = await runBaselinePreflight({
      policyConfig: policyWithOwners,
      repoRoot: tmpRepo,
      headSha: 'def222',
      cacheFile,
      collectFingerprintFn: async () => fpSameDifferentTime,
      runCheckFn: async (check) => ({ ok: true, checkName: check.name, stage: check.stage, exitCode: 0, errorCombined: '', env_fingerprint: fpSameDifferentTime })
    });
    assert.strictEqual(baseResDirtyUi.cacheHit, false, 'Modifying ui_web/index.html MUST miss baseline cache (DOM contract coverage)');

    // Cache MISS on changed env_fingerprint (pip_freeze_hash)
    const fpDiffEnv = makeEnvFingerprint({ pip_freeze_hash: 'pip-hash-mutated' });
    const baseResNewEnv = await runBaselinePreflight({
      policyConfig: policyWithOwners,
      repoRoot: tmpRepo,
      headSha: 'def222',
      cacheFile,
      collectFingerprintFn: async () => fpDiffEnv,
      runCheckFn: async (check) => ({ ok: true, checkName: check.name, stage: check.stage, exitCode: 0, errorCombined: '', env_fingerprint: fpDiffEnv })
    });
    assert.strictEqual(baseResNewEnv.cacheHit, false, 'Changed env_fingerprint MUST miss baseline cache');
    assert.strictEqual(mergedDefault.task_modes?.quick?.max_runtime_sec, 180, 'quick max_runtime_sec must remain locked at 180s');
    console.log('✓ 1+2 baseline retry, flaky 1-2/3 owner/due_at, and (deps_hash, env_fingerprint) cache verified.');

    // -------------------------------------------------------------------------
    // 3. Flaky 1/3 edge case + Environment Mismatch fail-closed + Max baseline limit
    // -------------------------------------------------------------------------
    console.log('3. Testing flaky 1/3, environment_mismatch fail-closed & max_baseline_failures=3 limit...');
    let oneThirdCounter = 0;
    const flaky1of3Res = await runBaselinePreflight({
      policyConfig: { policy: { repo_root: tmpRepo, validation: { fast_checks: [{ name: 'only_flaky', run: 'x' }], suite_checks: [] } } },
      repoRoot: tmpRepo,
      headSha: 'flaky13',
      collectFingerprintFn: async () => fpBase,
      runCheckFn: async (check) => {
        oneThirdCounter++;
        return {
          ok: oneThirdCounter > 1,
          checkName: check.name,
          stage: 'fast_checks',
          exitCode: oneThirdCounter === 1 ? 1 : 0,
          errorCombined: oneThirdCounter === 1 ? 'FAIL: test_one_third (tests.test_eraser.TestEraser.test_one_third)\nAssertionError: once' : '',
          env_fingerprint: fpBase
        };
      }
    });
    assert.strictEqual(flaky1of3Res.baseline_failures.length, 0);
    assert.strictEqual(flaky1of3Res.flaky_baseline_failures.length, 1);
    assert.strictEqual(flaky1of3Res.flaky_baseline_failures[0].fail_count, 1);
    assert.ok(flaky1of3Res.flaky_baseline_failures[0].owner && flaky1of3Res.flaky_baseline_failures[0].due_at);

    // environment_mismatch inside baseline runs MUST fail-closed
    let retryMismatchIdx = 0;
    const envMismatchBaseline = await runBaselinePreflight({
      policyConfig: { policy: { repo_root: tmpRepo, validation: { fast_checks: [{ name: 'chk', run: 'x' }], suite_checks: [] } } },
      repoRoot: tmpRepo,
      headSha: 'mismatch-sha',
      collectFingerprintFn: async () => fpBase,
      runCheckFn: async (check) => {
        retryMismatchIdx++;
        return {
          ok: false,
          checkName: check.name,
          stage: 'fast_checks',
          exitCode: 1,
          errorCombined: 'FAIL: test_broken (tests.test_unrelated.TestOther.test_broken)',
          env_fingerprint: retryMismatchIdx === 1 ? fpBase : fpDiffEnv
        };
      }
    });
    assert.strictEqual(envMismatchBaseline.blocked, true);
    assert.strictEqual(envMismatchBaseline.reason, 'environment_mismatch');

    // max_baseline_failures > 3 blocks ALL tasks immediately
    const fourBaselineFailures = [1, 2, 3, 4].map(n => ({
      check_name: 'unit_test_suite',
      test_id: `tests.test_unrelated.TestOther.test_fail_${n}`,
      test_file: 'tests/test_unrelated.py'
    }));
    const limitRes = await runBaselinePreflight({
      policyConfig: { policy: { repo_root: tmpRepo, validation: { fast_checks: [{ name: 'unit_test_suite', run: 'x' }], suite_checks: [] } } },
      repoRoot: tmpRepo,
      headSha: 'limit4',
      collectFingerprintFn: async () => fpBase,
      runCheckFn: async (check) => ({
        ok: false,
        checkName: check.name,
        stage: 'fast_checks',
        exitCode: 1,
        errorCombined: fourBaselineFailures.map(f => `FAIL: test_fail (${f.test_id})\nAssertionError: x`).join('\n'),
        env_fingerprint: fpBase
      })
    });
    assert.strictEqual(limitRes.blocked, true, 'More than max_baseline_failures=3 MUST block all tasks');
    assert.strictEqual(limitRes.reason, 'baseline_limit_exceeded');
    console.log('✓ Flaky 1/3, environment_mismatch fail-closed & max_baseline_failures=3 verified.');

    // -------------------------------------------------------------------------
    // 4. Static import graph + naming convention + missing mapping failsafe
    // -------------------------------------------------------------------------
    console.log('4. Testing test <-> scope mapping (naming, transitive import graph, missing mapping failsafe)...');
    // Transitive import: test_custom_flow.py -> core/pipeline.py -> core/shared_helper.py
    const mapTransitive = mapFailureToScope({
      check_name: 'unit_test_suite',
      test_id: 'tests.test_custom_flow.TestCustomFlow.test_flow'
    }, ['core/shared_helper.py'], tmpRepo);
    assert.strictEqual(mapTransitive.in_scope, true, 'Transitive static import must map test_custom_flow -> core/shared_helper.py as in-scope');

    // Naming convention: test_eraser -> core/eraser.py
    const mapNaming = mapFailureToScope({
      check_name: 'unit_test_suite',
      test_id: 'tests.test_eraser.TestEraser.test_ok'
    }, ['core/eraser.py'], tmpRepo);
    assert.strictEqual(mapNaming.in_scope, true);

    // Out-of-scope mapped test: test_unrelated -> core/unrelated.py while task.scope = ['core/eraser.py']
    const mapOutOfScope = mapFailureToScope({
      check_name: 'unit_test_suite',
      test_id: 'tests.test_unrelated.TestOther.test_broken'
    }, ['core/eraser.py'], tmpRepo);
    assert.strictEqual(mapOutOfScope.in_scope, false, 'Mapped unrelated test should be out-of-scope');

    // Missing mapping: unknown check / missing test file -> fail-safe in_scope = true!
    const mapUnmapped = mapFailureToScope({
      check_name: 'opaque_linter',
      test_id: '__check__'
    }, ['core/eraser.py'], tmpRepo);
    assert.strictEqual(mapUnmapped.in_scope, true, 'Missing test<->scope mapping MUST default to in_scope=true');
    assert.strictEqual(mapUnmapped.mapping_status, 'unmapped_in_scope');
    console.log('✓ Static import graph, naming convention & missing-mapping fail-safe verified.');

    // -------------------------------------------------------------------------
    // 5. All 5 conditions of done_with_known_failures & blocked: preexisting_failure (0 retries)
    // -------------------------------------------------------------------------
    console.log('5. Testing all 5 conditions of done_with_known_failures & blocked: preexisting_failure...');
    const outOfScopeBaseline = {
      ok: true,
      blocked: false,
      baseline_fingerprint: fpBase,
      baseline_failures: [
        {
          check_name: 'unit_test_suite',
          test_id: 'tests.test_unrelated.TestOther.test_broken',
          failure_key: 'unit_test_suite::tests.test_unrelated.TestOther.test_broken',
          test_file: 'tests/test_unrelated.py',
          owner: 'alice',
          due_at: '2026-12-15'
        },
        {
          check_name: 'tab_indentation_check',
          test_id: 'tests.test_indentation.IndentationTests.test_production_and_bridge_files_use_tab_indentation [file=core/unrelated.py]',
          failure_key: 'tab_indentation_check::tests.test_indentation.IndentationTests.test_production_and_bridge_files_use_tab_indentation [file=core/unrelated.py]',
          test_file: 'tests/test_indentation.py',
          target_file: 'core/unrelated.py',
          owner: 'qa-bot',
          due_at: '2026-12-10'
        }
      ],
      flaky_baseline_failures: [
        { check_name: 'unit_test_suite', test_id: 'tests.test_eraser.TestEraser.test_flaky_once', fail_count: 2, total_runs: 3, owner: 'bob', due_at: '2026-12-01' }
      ]
    };

    const redOutOfScopeCheckResult = [
      {
        ok: true,
        checkName: 'fast_clean',
        stage: 'fast_checks',
        env_fingerprint: fpBase
      },
      {
        ok: false,
        checkName: 'unit_test_suite',
        stage: 'suite_checks',
        exitCode: 1,
        errorCombined: 'FAIL: test_broken (tests.test_unrelated.TestOther.test_broken)\nAssertionError: persistent',
        env_fingerprint: fpBase
      }
    ];

    const baseTaskLow = {
      task_id: 'T-KNOWN-OK',
      risk_level: 'low',
      scope: ['core/eraser.py'],
      known_failures: [{ check_name: 'unit_test_suite', test_id: 'tests.test_unrelated.TestOther.test_broken', owner: 'alice', due_at: '2026-12-15' }]
    };
    const eraserDiff = 'diff --git a/core/eraser.py b/core/eraser.py\n--- a/core/eraser.py\n+++ b/core/eraser.py\n@@ -1 +1 @@\n-def erase():\n+def erase():\n';

    // Happy path (low risk, all 5 gates pass) -> done_with_known_failures!
    const gatePassLow = evaluateTaskOutcomeWithBaseline({
      task: baseTaskLow,
      checkResults: redOutOfScopeCheckResult,
      baselineResult: outOfScopeBaseline,
      diffText: eraserDiff,
      modifiedFiles: ['core/eraser.py'],
      policyConfig: policyWithOwners,
      repoRoot: tmpRepo
    });
    assert.strictEqual(gatePassLow.outcome, 'done_with_known_failures', `Expected done_with_known_failures, got: ${JSON.stringify(gatePassLow)}`);
    assert.strictEqual(gatePassLow.final_status, 'done_with_known_failures');
    assert.strictEqual(gatePassLow.known_failures.length, 1);
    assert.strictEqual(gatePassLow.known_failures[0].owner, 'alice');
    assert.strictEqual(gatePassLow.flaky_baseline_failures.length, 1);

    // Condition 1 FAIL: scope-mapped check fails (test_eraser fails even though unrelated might fail too) -> retry_writer!
    const cond1Fail = evaluateTaskOutcomeWithBaseline({
      task: baseTaskLow,
      checkResults: [{
        ok: false,
        checkName: 'unit_test_suite',
        stage: 'suite_checks',
        exitCode: 1,
        errorCombined: 'FAIL: test_broken (tests.test_unrelated.TestOther.test_broken)\nAssertionError: x\nFAIL: test_ok (tests.test_eraser.TestEraser.test_ok)\nAssertionError: broke scope',
        env_fingerprint: fpBase
      }],
      baselineResult: outOfScopeBaseline,
      diffText: eraserDiff,
      modifiedFiles: ['core/eraser.py'],
      policyConfig: policyWithOwners,
      repoRoot: tmpRepo
    });
    assert.strictEqual(cond1Fail.outcome, 'retry_writer', 'Condition 1 failure (scope-mapped test failed) must retry Writer');
    assert.strictEqual(cond1Fail.canRetry, true);

    // Also Condition 1 + Repo-wide subTest FAIL: tab_indentation_check fails on core/eraser.py (in scope) while core/unrelated.py was baseline -> retry_writer!
    const cond1SubTestInScope = evaluateTaskOutcomeWithBaseline({
      task: baseTaskLow,
      checkResults: [{
        ok: false,
        checkName: 'tab_indentation_check',
        stage: 'fast_checks',
        exitCode: 1,
        errorCombined: "FAIL: test_production_and_bridge_files_use_tab_indentation (tests.test_indentation.IndentationTests.test_production_and_bridge_files_use_tab_indentation) (file='core/eraser.py')\nAssertionError: space",
        env_fingerprint: fpBase
      }],
      baselineResult: outOfScopeBaseline,
      diffText: eraserDiff,
      modifiedFiles: ['core/eraser.py'],
      policyConfig: policyWithOwners,
      repoRoot: tmpRepo
    });
    assert.strictEqual(cond1SubTestInScope.outcome, 'retry_writer', 'Repo-wide subTest on in-scope file MUST NOT be treated as preexisting');

    // Condition 2 FAIL: red set is NOT a subset of baseline_failures (flaky or new out-of-scope test failed) -> retry_writer!
    const cond2Fail = evaluateTaskOutcomeWithBaseline({
      task: baseTaskLow,
      checkResults: [{
        ok: false,
        checkName: 'unit_test_suite',
        stage: 'suite_checks',
        exitCode: 1,
        errorCombined: 'FAIL: test_flaky_once (tests.test_eraser.TestEraser.test_flaky_once)\nAssertionError: flaky failed',
        env_fingerprint: fpBase
      }],
      baselineResult: outOfScopeBaseline,
      diffText: eraserDiff,
      modifiedFiles: ['core/eraser.py'],
      policyConfig: policyWithOwners,
      repoRoot: tmpRepo
    });
    assert.strictEqual(cond2Fail.outcome, 'retry_writer', 'Condition 2 failure (red not subset of 3/3 baseline_failures) must NOT become known failure');

    // Condition 3 FAIL: diff touches executable failing test file (tests/test_unrelated.py) -> blocked: preexisting_failure (0 retries!)
    const dirtyTestDiff = `${eraserDiff}diff --git a/tests/test_unrelated.py b/tests/test_unrelated.py\n--- a/tests/test_unrelated.py\n+++ b/tests/test_unrelated.py\n@@ -1 +1 @@\n-pass\n+# touched\n`;
    const cond3Fail = evaluateTaskOutcomeWithBaseline({
      task: baseTaskLow,
      checkResults: redOutOfScopeCheckResult,
      baselineResult: outOfScopeBaseline,
      diffText: dirtyTestDiff,
      modifiedFiles: ['core/eraser.py', 'tests/test_unrelated.py'],
      policyConfig: policyWithOwners,
      repoRoot: tmpRepo
    });
    assert.strictEqual(cond3Fail.outcome, 'blocked', 'Condition 3 failure (diff touches failing test file) MUST block');
    assert.strictEqual(cond3Fail.reason, 'preexisting_failure');
    assert.strictEqual(cond3Fail.canRetry, false, 'preexisting_failure must stop Writer retry immediately');

    // Condition 4 FAIL: risk >= medium WITHOUT human approval -> blocked: preexisting_failure (0 retries!)
    const taskMedNoApproval = { ...baseTaskLow, task_id: 'T-MED-UNAPPROVED', risk_level: 'medium' };
    const cond4Fail = evaluateTaskOutcomeWithBaseline({
      task: taskMedNoApproval,
      checkResults: redOutOfScopeCheckResult,
      baselineResult: outOfScopeBaseline,
      diffText: eraserDiff,
      modifiedFiles: ['core/eraser.py'],
      policyConfig: policyWithOwners,
      repoRoot: tmpRepo
    });
    assert.strictEqual(cond4Fail.outcome, 'blocked', 'Condition 4: risk>=medium without human approval MUST block as preexisting_failure');
    assert.strictEqual(cond4Fail.reason, 'preexisting_failure');
    assert.strictEqual(cond4Fail.canRetry, false);

    // Condition 4 PASS: risk >= medium WITH valid human approval -> done_with_known_failures!
    const taskMedApproved = {
      ...taskMedNoApproval,
      approval: { by: 'human', scope_hash: computeScopeHash(taskMedNoApproval.scope) }
    };
    const cond4Pass = evaluateTaskOutcomeWithBaseline({
      task: taskMedApproved,
      checkResults: redOutOfScopeCheckResult,
      baselineResult: outOfScopeBaseline,
      diffText: eraserDiff,
      modifiedFiles: ['core/eraser.py'],
      policyConfig: policyWithOwners,
      repoRoot: tmpRepo
    });
    assert.strictEqual(cond4Pass.outcome, 'done_with_known_failures', 'Condition 4 with human approval MUST allow done_with_known_failures');

    // Condition 5 FAIL: known_failures missing owner or due_at -> blocked: preexisting_failure (0 retries!)
    const taskNoOwner = { task_id: 'T-NO-OWNER', risk_level: 'low', scope: ['core/eraser.py'] };
    const policyNoOwner = { policy: { repo_root: tmpRepo, validation: { max_baseline_failures: 3 } } };
    const cond5Fail = evaluateTaskOutcomeWithBaseline({
      task: taskNoOwner,
      checkResults: redOutOfScopeCheckResult,
      baselineResult: {
        ...outOfScopeBaseline,
        baseline_failures: [{
          check_name: 'unit_test_suite',
          test_id: 'tests.test_unrelated.TestOther.test_broken',
          failure_key: 'unit_test_suite::tests.test_unrelated.TestOther.test_broken',
          test_file: 'tests/test_unrelated.py'
        }]
      },
      diffText: eraserDiff,
      modifiedFiles: ['core/eraser.py'],
      policyConfig: policyNoOwner,
      repoRoot: tmpRepo
    });
    assert.strictEqual(cond5Fail.outcome, 'blocked', 'Condition 5: missing owner/due_at MUST block as preexisting_failure');
    assert.strictEqual(cond5Fail.reason, 'preexisting_failure');
    assert.strictEqual(cond5Fail.canRetry, false);

    // Environment mismatch post-fix MUST ALWAYS fail-closed even when subset matches
    const envMismatchPost = evaluateTaskOutcomeWithBaseline({
      task: baseTaskLow,
      checkResults: redOutOfScopeCheckResult.map(c => ({ ...c, env_fingerprint: fpDiffEnv })),
      baselineResult: outOfScopeBaseline,
      diffText: eraserDiff,
      modifiedFiles: ['core/eraser.py'],
      policyConfig: policyWithOwners,
      repoRoot: tmpRepo
    });
    assert.strictEqual(envMismatchPost.outcome, 'blocked');
    assert.strictEqual(envMismatchPost.reason, 'environment_mismatch');
    assert.strictEqual(envMismatchPost.canRetry, false);

    // -------------------------------------------------------------------------
    // 6. State persistence & canonical queue handling of done_with_known_failures
    // -------------------------------------------------------------------------
    console.log('6. Testing done_with_known_failures state persistence & canonical queue state...');
    const tmpTeam = fs.mkdtempSync(path.join(os.tmpdir(), 'td-baseline-state-'));
    try {
      const activeDir = path.join(tmpTeam, 'tasks', 'active');
      const archiveDir = path.join(tmpTeam, 'tasks', 'archive');
      fs.mkdirSync(activeDir, { recursive: true });
      fs.mkdirSync(archiveDir, { recursive: true });
      const activeTaskPath = path.join(activeDir, 'T-KNOWN-OK.yaml');
      const archiveTaskPath = path.join(archiveDir, 'T-KNOWN-OK.yaml');
      fs.writeFileSync(activeTaskPath, 'task_id: T-KNOWN-OK\nstatus: ready\nscope:\n  - core/eraser.py\n', 'utf8');

      const st = { active_tasks: [], completed_tasks: [], blocked_tasks: [], metrics: {} };
      const taskObj = { ...baseTaskLow, known_failures: gatePassLow.known_failures };
      transitionTaskState(taskObj, st, 'done_with_known_failures', {
        actualModifiedFiles: ['core/eraser.py'],
        validationPassed: true,
        retries: 0,
        activeTaskPath,
        archiveTaskPath
      });
      assert.strictEqual(st.completed_tasks.length, 1);
      assert.strictEqual(st.completed_tasks[0].status, 'done_with_known_failures');
      assert.strictEqual(st.blocked_tasks.length, 0);
      assert.strictEqual(sanitizeTaskState(st).completed_tasks[0].status, 'done_with_known_failures');
      const q = computeCanonicalQueueState({ tasksActiveDir: activeDir, tasksArchiveDir: archiveDir, taskState: st });
      assert.strictEqual(q.counts.completed, 1);
      assert.strictEqual(q.completed[0].status, 'done_with_known_failures');
    } finally {
      fs.rmSync(tmpTeam, { recursive: true, force: true });
    }

    // -------------------------------------------------------------------------
    // 7. Orchestrator integration check (wired helpers, 0-retry on preexisting_failure, max_baseline_failures)
    // -------------------------------------------------------------------------
    const readOrchestratorCombinedSource = (scriptsDir) => {
      const subDir = path.join(scriptsDir, 'orchestrator');
      const subFiles = fs.existsSync(subDir)
        ? fs.readdirSync(subDir).filter(f => f.endsWith('.mjs')).sort().map(f => path.join(subDir, f))
        : [];
      return [path.join(scriptsDir, 'orchestrator.mjs'), ...subFiles]
        .map(p => fs.readFileSync(p, 'utf8'))
        .join('\n');
    };
    const orchSrc = readOrchestratorCombinedSource(__dirname);
    assert.ok(orchSrc.includes('runBaselinePreflight'), 'orchestrator.mjs must run runBaselinePreflight');
    assert.ok(orchSrc.includes('evaluateTaskOutcomeWithBaseline'), 'orchestrator.mjs must evaluate task outcome with baseline');
    assert.ok(orchSrc.includes('done_with_known_failures'), 'orchestrator.mjs must handle done_with_known_failures');
    assert.ok(orchSrc.includes('preexisting_failure'), 'orchestrator.mjs must stop retry loop on preexisting_failure');

    // -------------------------------------------------------------------------
    // 8. Baseline clock isolation from task max_runtime_sec (keep quick=180)
    // -------------------------------------------------------------------------
    console.log('8. Testing baseline runtime isolation from task max_runtime_sec...');
    const baselineMod = await import('./lib/baseline-policy.mjs');
    assert.strictEqual(typeof baselineMod.resolveBaselineMaxRuntimeSec, 'function', 'baseline-policy must export resolveBaselineMaxRuntimeSec');
    assert.strictEqual(typeof baselineMod.evaluateTaskExecutionRuntime, 'function', 'baseline-policy must export evaluateTaskExecutionRuntime');

    assert.strictEqual(baselineMod.resolveBaselineMaxRuntimeSec({}), 300);
    assert.strictEqual(baselineMod.resolveBaselineMaxRuntimeSec({ policy: { validation: { max_baseline_runtime_sec: 240 } } }), 240);

    // Baseline took 140s + Writer execution took 80s = 220s wall clock, STILL <= 180s task max_runtime_sec!
    const execStart = 1_000_000;
    const withinBudget = baselineMod.evaluateTaskExecutionRuntime({
      executionStartMs: execStart,
      nowMs: execStart + 80_000,
      maxRuntimeSec: 180,
      baselineDurationMs: 140_000
    });
    assert.strictEqual(withinBudget.exceeded, false, 'Baseline duration (140s) MUST NOT consume task max_runtime_sec (180s)');
    assert.strictEqual(withinBudget.execution_elapsed_sec, 80);
    assert.strictEqual(withinBudget.baseline_elapsed_sec, 140);

    // Execution alone taking 185s > 180s MUST still trip exceeded=true
    const overExecBudget = baselineMod.evaluateTaskExecutionRuntime({
      executionStartMs: execStart,
      nowMs: execStart + 185_000,
      maxRuntimeSec: 180,
      baselineDurationMs: 10_000
    });
    assert.strictEqual(overExecBudget.exceeded, true, 'Task execution > 180s must still trigger exceeded=true');

    // Separate baseline timeout guard inside runBaselinePreflight
    let fakeClock = 10_000;
    const baselineTimeoutRes = await runBaselinePreflight({
      policyConfig: {
        policy: {
          validation: {
            max_baseline_runtime_sec: 1,
            fast_checks: [{ name: 'slow_check_1', run: 'echo s1' }, { name: 'slow_check_2', run: 'echo s2' }],
            suite_checks: []
          }
        }
      },
      repoRoot: tmpRepo,
      task: { scope: ['core/eraser.py'] },
      headSha: 'timeout-sha-1',
      nowFn: () => fakeClock,
      collectFingerprintFn: async () => fpBase,
      runCheckFn: async (check) => {
        fakeClock += 1500;
        return { ok: true, checkName: check.name, stage: check.stage, command: check.run, exitCode: 0, errorCombined: '', env_fingerprint: fpBase };
      }
    });
    assert.strictEqual(baselineTimeoutRes.blocked, true, 'runBaselinePreflight exceeding its own max_baseline_runtime_sec must fail with baseline_timeout');
    assert.strictEqual(baselineTimeoutRes.reason, 'baseline_timeout');

    // Confirm policy.yaml sets task_modes.quick.max_runtime_sec to 600 (D-020) and orchestrator wires evaluateTaskExecutionRuntime
    const policyYamlText = fs.readFileSync(path.resolve(TEAM_DIR, 'config', 'policy.yaml'), 'utf8');
    assert.match(policyYamlText, /quick:\s*\r?\n(?:[ \t]+[^\r\n]*\r?\n)*?[ \t]+max_runtime_sec:\s*600\b/, 'policy.yaml quick.max_runtime_sec must be 600 (D-020)');
    assert.ok(orchSrc.includes('evaluateTaskExecutionRuntime'), 'orchestrator.mjs must use evaluateTaskExecutionRuntime excluding baseline');
    assert.ok(orchSrc.includes('baseline_timeout'), 'orchestrator.mjs must handle separate baseline_timeout');

    // -------------------------------------------------------------------------
    // 9. Guarantee Post-Patch Validator NEVER uses Baseline Cache even on Cache HIT
    // -------------------------------------------------------------------------
    console.log('9. Verifying post-patch validator runs 100% live checks even when baseline cache hits...');
    const { validateStageChecks, runSingleValidationCheck } = await import('./validator.mjs');
    const validatorSrc = fs.readFileSync(path.resolve(__dirname, 'validator.mjs'), 'utf8');
    assert.equal(validatorSrc.includes('baseline-cache'), false, 'validator.mjs must NEVER read baseline-cache.json');
    assert.equal(validatorSrc.includes('deps_hash'), false, 'validator.mjs must NEVER bypass execution using deps_hash');
    assert.equal(validatorSrc.includes('runBaselinePreflight'), false, 'validator.mjs must remain decoupled from baseline preflight cache');

    const postPatchRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'td-postpatch-nocache-'));
    const postPatchCache = path.join(cacheDir, 'postpatch-baseline-cache.json');
    try {
      fs.mkdirSync(path.join(postPatchRepo, 'core'), { recursive: true });
      fs.mkdirSync(path.join(postPatchRepo, 'tests'), { recursive: true });
      fs.writeFileSync(path.join(postPatchRepo, 'core', 'feature.js'), 'export const value = 1;\n', 'utf8');
      fs.writeFileSync(path.join(postPatchRepo, 'tests', 'test_feature.mjs'), [
        "import fs from 'node:fs';",
        "const txt = fs.readFileSync('core/feature.js', 'utf8');",
        "fs.appendFileSync('tests/invocations.log', 'ran\\n', 'utf8');",
        "if (!txt.includes('value = 1')) {",
        "  console.error('FAIL: test_feature_contract (tests.test_feature.FeatureTests.test_feature_contract)\\nAssertionError: value missing');",
        '  process.exit(1);',
        '}'
      ].join('\n'), 'utf8');

      const postPatchPolicy = {
        policy: {
          repo_root: postPatchRepo,
          scope_control: { allowed_dirs: ['core/', 'tests/'] },
          validation: {
            max_baseline_failures: 3,
            fast_checks: [{ name: 'fast_feature', run: 'node tests/test_feature.mjs' }],
            suite_checks: [{ name: 'suite_feature', run: 'node tests/test_feature.mjs' }]
          }
        }
      };

      let preflightExecCount = 0;
      const runCleanPreflight = async (check) => {
        preflightExecCount++;
        return { ok: true, checkName: check.name, stage: check.stage, command: check.run, exitCode: 0, errorCombined: '', env_fingerprint: fpBase };
      };
      const coldBaseline = await runBaselinePreflight({
        policyConfig: postPatchPolicy,
        repoRoot: postPatchRepo,
        cacheFile: postPatchCache,
        headSha: 'postpatch-sha-1',
        collectFingerprintFn: async () => fpBase,
        runCheckFn: runCleanPreflight
      });
      assert.strictEqual(coldBaseline.cacheHit, false);
      assert.strictEqual(preflightExecCount, 2);

      const hitBaseline = await runBaselinePreflight({
        policyConfig: postPatchPolicy,
        repoRoot: postPatchRepo,
        cacheFile: postPatchCache,
        headSha: 'postpatch-sha-2',
        collectFingerprintFn: async () => fpBase,
        runCheckFn: runCleanPreflight
      });
      assert.strictEqual(hitBaseline.cacheHit, true, 'Second baseline preflight MUST hit deps_hash cache');
      assert.strictEqual(preflightExecCount, 2, 'Baseline cache HIT must skip preflight re-execution');

      // Simulate Writer applying a buggy patch AFTER baseline preflight hit cache
      fs.writeFileSync(path.join(postPatchRepo, 'core', 'feature.js'), 'export const value = 999;\n', 'utf8');
      assert.strictEqual(fs.existsSync(path.join(postPatchRepo, 'tests', 'invocations.log')), false);

      const postFast = await validateStageChecks('fast_checks', postPatchPolicy, { envFingerprint: fpBase, collectAll: true });
      const postSuite = await validateStageChecks('suite_checks', postPatchPolicy, { envFingerprint: fpBase, collectAll: true });
      const postExtra = await runSingleValidationCheck(
        { name: 'dependent_test_verification', run: 'node tests/test_feature.mjs', timeout_sec: 15 },
        'suite_checks',
        postPatchPolicy,
        fpBase
      );

      assert.strictEqual(postFast.ok, false, 'Post-patch fast_checks MUST run live and catch new regression despite baseline cache HIT');
      assert.strictEqual(postSuite.ok, false, 'Post-patch suite_checks MUST run live and catch new regression despite baseline cache HIT');
      assert.strictEqual(postExtra.ok, false, 'Post-patch verification_commands MUST run live and catch new regression despite baseline cache HIT');

      const ranCount = fs.readFileSync(path.join(postPatchRepo, 'tests', 'invocations.log'), 'utf8').trim().split(/\r?\n/).length;
      assert.strictEqual(ranCount, 3, 'All 3 post-patch validation commands (fast, suite, dependent verification) MUST execute');

      const postEval = evaluateTaskOutcomeWithBaseline({
        task: { scope: ['core/feature.js'] },
        checkResults: [...(postFast.checks || []), ...(postSuite.checks || []), postExtra],
        baselineResult: hitBaseline,
        modifiedFiles: ['core/feature.js'],
        policyConfig: postPatchPolicy,
        repoRoot: postPatchRepo
      });
      assert.strictEqual(postEval.outcome, 'retry_writer', 'New post-patch failure with cache-hit clean baseline MUST trigger retry_writer');
    } finally {
      fs.rmSync(postPatchRepo, { recursive: true, force: true });
    }

    console.log('✓ Post-patch validation guaranteed un-cached & catches new regressions even on baseline cache HIT.');

    console.log('\n=================================================');
    console.log('ALL BASELINE FAILURES & PREEXISTING POLICY TESTS PASSED!');
    console.log('=================================================');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

runTests().catch(err => {
  console.error('Baseline failures test failed:', err);
  process.exit(1);
});
