#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  captureProcessSocketSnapshot,
  evaluateEnobufsQualification,
  evaluateExternalSocketPressure,
  isEnobufsFailure,
  isHumanOwnerName,
  parseNetstatOutputByProcess
} from './lib/enobufs-diagnostics.mjs';
import { evaluateTaskOutcomeWithBaseline, runBaselinePreflight, formatFlakyBaselineReport } from './lib/baseline-policy.mjs';
import { loadMergedPolicy } from './lib/policy-loader.mjs';
import { runSingleValidationCheck } from './validator.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = fs.existsSync(path.join(TEAM_DIR, '.git')) ? TEAM_DIR : path.resolve(TEAM_DIR, '..');

function makeFp() {
  return {
    python_path: 'C:\\venv\\Scripts\\python.exe',
    is_admin: false,
    loopback_bindable: true,
    pip_freeze_hash: 'pip-enobufs-test',
    platform: 'win32',
    node_version: process.version,
    onnxruntime: { installed: true, import_ok: true, version: '1.24.4', providers: ['CPUExecutionProvider'], error: null },
    onnx_models: [],
    checked_at: '2026-11-16T00:00:00.000Z'
  };
}

async function runTests() {
  // 1) Verify policy.yaml explicitly registers ENOBUFS under flaky_baseline_failures with owner & due_at
  const loadedPolicy = loadMergedPolicy();
  const existingSuites = loadedPolicy.policy?.validation?.suite_checks || [];
  const policyConfig = existingSuites.length > 0
    ? loadedPolicy
    : {
        ...loadedPolicy,
        policy: {
          ...loadedPolicy.policy,
          validation: {
            ...loadedPolicy.policy.validation,
            suite_checks: [{ name: 'unit_test_suite', run: 'node -e "process.exit(0)"', timeout_sec: 30 }]
          }
        }
      };
  const configuredFlaky = policyConfig.validation?.flaky_baseline_failures || policyConfig.policy?.validation?.flaky_baseline_failures || [];
  const enobufsRule = configuredFlaky.find(entry => /enobufs/i.test(`${entry.id || ''} ${entry.error_pattern || ''} ${entry.test_id || ''}`));
  assert.ok(enobufsRule, 'policy.yaml validation.flaky_baseline_failures must include an ENOBUFS rule');
  assert.ok(typeof enobufsRule.owner === 'string' && enobufsRule.owner.trim().length > 0, 'ENOBUFS rule must have owner');
  assert.ok(typeof enobufsRule.due_at === 'string' && enobufsRule.due_at.trim().length > 0, 'ENOBUFS rule must have due_at');

  // 2) Verify runBaselinePreflight propagates configured ENOBUFS flaky watch entry (even on green runs & runtime ENOBUFS hit)
  const fp = makeFp();
  const cleanBaseline = await runBaselinePreflight({
    policyConfig,
    repoRoot: REPO_ROOT,
    headSha: 'enobufs-test-clean',
    collectFingerprintFn: async () => fp,
    runCheckFn: async (check) => ({
      ok: true,
      checkName: check.name,
      stage: check.stage,
      command: check.run,
      exitCode: 0,
      errorCombined: '',
      env_fingerprint: fp
    })
  });
  const enobufsWatch = cleanBaseline.flaky_baseline_failures.find(f => /enobufs/i.test(JSON.stringify(f)));
  assert.ok(enobufsWatch, 'runBaselinePreflight must surface ENOBUFS entry in flaky_baseline_failures');
  assert.equal(enobufsWatch.owner, enobufsRule.owner);
  assert.equal(enobufsWatch.due_at, enobufsRule.due_at);
  assert.ok(formatFlakyBaselineReport(cleanBaseline.flaky_baseline_failures).includes(enobufsRule.owner));

  // Runtime ENOBUFS once out of 3 rounds gets enriched with policy owner/due_at and socket snapshot
  let runtimeCalls = 0;
  const mockSnap = {
    ok: true,
    source: 'Get-NetTCPConnection',
    total_connections: 120,
    by_process: [{ pid: 4321, process_name: 'node', total_sockets: 95, states: { TIME_WAIT: 90, ESTABLISHED: 5 } }]
  };
  const runtimeFlaky = await runBaselinePreflight({
    policyConfig,
    repoRoot: REPO_ROOT,
    headSha: 'enobufs-test-runtime',
    collectFingerprintFn: async () => fp,
    runCheckFn: async (check) => {
      if (check.name !== 'unit_test_suite') {
        return { ok: true, checkName: check.name, stage: check.stage, command: check.run, exitCode: 0, errorCombined: '', env_fingerprint: fp };
      }
      runtimeCalls += 1;
      if (runtimeCalls === 1) {
        return {
          ok: false,
          checkName: check.name,
          stage: check.stage,
          command: check.run,
          exitCode: 1,
          errorCombined: 'Error: spawn node.exe ENOBUFS',
          socket_diagnostics: mockSnap,
          env_fingerprint: fp
        };
      }
      return { ok: true, checkName: check.name, stage: check.stage, command: check.run, exitCode: 0, errorCombined: '', env_fingerprint: fp };
    }
  });
  assert.equal(runtimeFlaky.ok, true);
  assert.equal(runtimeFlaky.baseline_failures.length, 0);
  const enobufsRuntimeEntry = runtimeFlaky.flaky_baseline_failures.find(f => f.check_name === 'unit_test_suite');
  assert.ok(enobufsRuntimeEntry, 'Runtime ENOBUFS failure must be matched in flaky_baseline_failures');
  assert.equal(enobufsRuntimeEntry.owner, enobufsRule.owner);
  assert.equal(enobufsRuntimeEntry.due_at, enobufsRule.due_at);
  assert.equal(enobufsRuntimeEntry.socket_diagnostics.total_connections, 120);

  // 3) Verify detector & parser helpers
  assert.equal(isEnobufsFailure('spawnSync python ENOBUFS'), true);
  assert.equal(isEnobufsFailure('connect ENOBUFS 127.0.0.1:20128'), true);
  assert.equal(isEnobufsFailure('', { code: 'ENOBUFS' }), true);
  assert.equal(isEnobufsFailure('AssertionError: 1 != 2'), false);

  const netstatSample = [
    'Active Connections',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    127.0.0.1:50001        127.0.0.1:20128        TIME_WAIT       4321',
    '  TCP    127.0.0.1:50002        127.0.0.1:20128        TIME_WAIT       4321',
    '  TCP    127.0.0.1:20128        0.0.0.0:0              LISTENING       9001'
  ].join('\n');
  const grouped = parseNetstatOutputByProcess(netstatSample, new Map([[4321, 'node'], [9001, 'python']]));
  assert.equal(grouped.total_connections, 3);
  assert.equal(grouped.by_process[0].pid, 4321);
  assert.equal(grouped.by_process[0].process_name, 'node');
  assert.equal(grouped.by_process[0].total_sockets, 2);
  assert.equal(grouped.by_process[0].states.TIME_WAIT, 2);

  // 4) Verify runSingleValidationCheck auto-captures per-process sockets ONLY on ENOBUFS failures
  let captureCount = 0;
  const fakeCapture = async () => {
    captureCount += 1;
    return {
      ok: true,
      source: 'Get-NetTCPConnection',
      captured_at: '2026-11-16T00:00:00.000Z',
      total_connections: 12,
      by_process: [{ pid: 777, process_name: 'node', total_sockets: 12, states: { TIME_WAIT: 10, ESTABLISHED: 2 } }]
    };
  };

  const enobufsCheckRes = await runSingleValidationCheck(
    { name: 'enobufs_sim_check', run: 'node -e "console.error(\'Error: connect ENOBUFS\'); process.exit(1)"', timeout_sec: 10 },
    'suite_checks',
    policyConfig,
    fp,
    10000,
    { captureSocketSnapshotFn: fakeCapture }
  );
  assert.equal(enobufsCheckRes.ok, false);
  assert.equal(captureCount, 1, 'ENOBUFS failure must trigger socket capture exactly once');
  assert.ok(enobufsCheckRes.socket_diagnostics, 'socket_diagnostics must be attached to ENOBUFS failure result');
  assert.equal(enobufsCheckRes.socket_diagnostics.by_process[0].pid, 777);

  // Non-ENOBUFS failure must NOT invoke socket capture
  const normalFailRes = await runSingleValidationCheck(
    { name: 'normal_fail_check', run: 'node -e "console.error(\'AssertionError: fail\'); process.exit(1)"', timeout_sec: 10 },
    'suite_checks',
    policyConfig,
    fp,
    10000,
    { captureSocketSnapshotFn: fakeCapture }
  );
  assert.equal(normalFailRes.ok, false);
  assert.equal(captureCount, 1, 'Non-ENOBUFS failure must NOT trigger socket capture');
  assert.equal(normalFailRes.socket_diagnostics, undefined);

  // 5) Batch 166 Item E: Strict ENOBUFS rule tests
  // 5a: Policy owner must be a human person name (not infra-windows / team-* / triage-needed)
  assert.equal(isHumanOwnerName('Alex Rivera'), true);
  assert.equal(isHumanOwnerName('infra-windows'), false);
  assert.equal(isHumanOwnerName('triage-needed'), false);
  assert.equal(isHumanOwnerName(enobufsRule.owner), true, `ENOBUFS rule owner must be a person name, got "${enobufsRule.owner}"`);

  // 5b: External socket threshold excludes test PIDs
  const highTestPidOnlySnap = {
    ok: true,
    source: 'Get-NetTCPConnection',
    total_connections: 180,
    by_process: [
      { pid: process.pid, process_name: 'node', total_sockets: 160, states: { TIME_WAIT: 160 } },
      { pid: 4321, process_name: 'chrome', total_sockets: 15, states: { ESTABLISHED: 15 } }
    ]
  };
  const noExternalPressure = evaluateExternalSocketPressure(highTestPidOnlySnap, { threshold: 50, testPids: [process.pid] });
  assert.equal(noExternalPressure.exceeds_threshold, false);

  const highExternalPressure = evaluateExternalSocketPressure(mockSnap, { threshold: 50, testPids: [process.pid] });
  assert.equal(highExternalPressure.exceeds_threshold, true);
  assert.equal(highExternalPressure.culprit_process.pid, 4321);

  // 5c: ENOBUFS 1/3 with isolated retry PASS, BUT external sockets <= threshold -> BLOCKED (NOT flaky!)
  let lowSockCalls = 0;
  const blockedNoExtRes = await runBaselinePreflight({
    policyConfig,
    repoRoot: REPO_ROOT,
    headSha: 'enobufs-test-no-ext-pressure',
    collectFingerprintFn: async () => fp,
    runCheckFn: async (check) => {
      if (check.name !== 'unit_test_suite') {
        return { ok: true, checkName: check.name, stage: check.stage, command: check.run, exitCode: 0, errorCombined: '', env_fingerprint: fp };
      }
      lowSockCalls += 1;
      if (lowSockCalls === 1) {
        return {
          ok: false,
          checkName: check.name,
          stage: check.stage,
          command: check.run,
          exitCode: 1,
          errorCombined: 'Error: connect ENOBUFS 127.0.0.1:20128',
          socket_diagnostics: highTestPidOnlySnap,
          env_fingerprint: fp
        };
      }
      return { ok: true, checkName: check.name, stage: check.stage, command: check.run, exitCode: 0, errorCombined: '', env_fingerprint: fp };
    }
  });
  assert.equal(blockedNoExtRes.ok, false, 'ENOBUFS without external non-test socket pressure must NOT pass as flaky');
  assert.equal(blockedNoExtRes.blocked, true);
  assert.equal(blockedNoExtRes.reason, 'enobufs_no_external_socket_pressure');

  // 5d: ENOBUFS 3 consecutive failures (Rounds 1, 2, 3 all ENOBUFS) even WITH external pressure -> BLOCKED!
  const blocked3xRes = await runBaselinePreflight({
    policyConfig,
    repoRoot: REPO_ROOT,
    headSha: 'enobufs-test-3x-consecutive',
    collectFingerprintFn: async () => fp,
    runCheckFn: async (check) => {
      if (check.name !== 'unit_test_suite') {
        return { ok: true, checkName: check.name, stage: check.stage, command: check.run, exitCode: 0, errorCombined: '', env_fingerprint: fp };
      }
      return {
        ok: false,
        checkName: check.name,
        stage: check.stage,
        command: check.run,
        exitCode: 1,
        errorCombined: 'Error: spawn node.exe ENOBUFS',
        socket_diagnostics: mockSnap,
        env_fingerprint: fp
      };
    }
  });
  assert.equal(blocked3xRes.ok, false, '3 consecutive ENOBUFS failures must block, not pass as flaky');
  assert.equal(blocked3xRes.blocked, true);
  assert.equal(blocked3xRes.reason, 'enobufs_consecutive_blocked');

  // 5e: Post-patch evaluateTaskOutcomeWithBaseline: 3 consecutive ENOBUFS -> blocked
  const post3xBlocked = evaluateTaskOutcomeWithBaseline({
    task: { task_id: 'T-ENOBUFS-3', mode: 'quick', risk_level: 'low', scope: ['ui_web/index.html'], consecutive_enobufs: 2 },
    checkResults: [{
      ok: false,
      checkName: 'unit_test_suite',
      stage: 'suite_checks',
      command: '.\\.venv\\Scripts\\python.exe -m unittest discover -s tests -v',
      errorCombined: 'Error: connect ENOBUFS 127.0.0.1:20128',
      socket_diagnostics: mockSnap,
      env_fingerprint: fp
    }],
    baselineResult: { ok: true, baseline_fingerprint: fp, baseline_failures: [], flaky_baseline_failures: [] },
    policyConfig,
    repoRoot: REPO_ROOT
  });
  assert.equal(post3xBlocked.outcome, 'blocked');
  assert.equal(post3xBlocked.reason, 'enobufs_consecutive_blocked');
  assert.equal(post3xBlocked.canRetry, false);

  const qualOk = evaluateEnobufsQualification({
    isolatedRetryPassed: true,
    socketDiagnostics: mockSnap,
    threshold: 50,
    testPids: [process.pid],
    consecutiveCount: 1
  });
  assert.equal(qualOk.eligible_flaky, true);

  // Also smoke test real captureProcessSocketSnapshot runs bounded without crashing
  const liveSnap = await captureProcessSocketSnapshot({ timeoutMs: 5000 });
  assert.equal(typeof liveSnap.ok, 'boolean');
  assert.ok(Array.isArray(liveSnap.by_process));

  console.log('[PASS] test-enobufs-diagnostics');
}

runTests().catch(err => {
  console.error('[FAIL] test-enobufs-diagnostics:', err);
  process.exit(1);
});
