#!/usr/bin/env node
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function initTempGitRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-wt-batch-test-'));
  execFileSync('git', ['init', '-q'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'pipe' });

  fs.writeFileSync(path.join(repoDir, 'probe.mjs'), 'console.log("PASS_MARKER");\n', 'utf8');
  execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-q', '-m', 'commit pass'], { cwd: repoDir, stdio: 'pipe' });
  const passSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

  const longScript = [
    'const start = "BEGIN_STDOUT_SENTINEL_" + "A".repeat(12000);',
    'const middle = "MID_STDOUT_SENTINEL_" + "B".repeat(12000);',
    'const end = "END_STDOUT_SENTINEL";',
    'console.log(start + "\\n" + middle + "\\n" + end);',
    'console.error("BEGIN_STDERR_" + "E".repeat(5000) + "_END_STDERR");',
    'process.exit(1);'
  ].join('\n');
  fs.writeFileSync(path.join(repoDir, 'probe.mjs'), longScript, 'utf8');
  execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-q', '-m', 'commit fail long output'], { cwd: repoDir, stdio: 'pipe' });
  const failSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

  return { repoDir, passSha, failSha };
}

function initSuiteTempGitRepo() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-wt-suite-test-'));
  execFileSync('git', ['init', '-q'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'pipe' });

  const pkgDir = path.join(repoDir, 'agent-team', 'scripts');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'test-first-fail.mjs'), 'console.error("FAIL_FIRST"); process.exit(1);\n', 'utf8');
  fs.writeFileSync(path.join(pkgDir, 'test-middle-pass.mjs'), 'console.log("PASS_MIDDLE");\n', 'utf8');
  fs.writeFileSync(path.join(pkgDir, 'test-third-fail.mjs'), 'console.error("FAIL_THIRD"); process.exit(2);\n', 'utf8');
  fs.writeFileSync(path.join(pkgDir, 'test-cockpit-probe.mjs'), 'console.log("COCKPIT_PROBE_MARKER");\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, 'agent-team', 'package.json'), JSON.stringify({
    name: 'suite-probe',
    type: 'module',
    scripts: {
      'test:offline': 'node scripts/test-first-fail.mjs && node scripts/test-middle-pass.mjs && node scripts/test-third-fail.mjs',
      'test': 'node scripts/test-first-fail.mjs && node scripts/test-middle-pass.mjs && node scripts/test-third-fail.mjs && node scripts/test-cockpit-probe.mjs'
    }
  }, null, 2), 'utf8');
  execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-q', '-m', 'suite commit'], { cwd: repoDir, stdio: 'pipe' });
  const suiteSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
  return { repoDir, suiteSha };
}

async function runTests() {
  console.log('Testing Worktree Batch Verifier & Full Untruncated Log Persistence...\n');
  const mod = await import('./verify-worktrees.mjs');
  assert.strictEqual(typeof mod.runWorktreeBatchVerification, 'function', 'verify-worktrees.mjs must export runWorktreeBatchVerification');
  assert.strictEqual(typeof mod.parseCliArgs, 'function', 'verify-worktrees.mjs must export parseCliArgs');

  const parsedSkipMulti = mod.parseCliArgs(['--commits', 'abc,def', '--skip', 'test-a,test-b', '--skip', 'test-c.mjs']);
  assert.deepStrictEqual(parsedSkipMulti.skip, ['test-a', 'test-b', 'test-c.mjs']);
  const parsedWithCockpit = mod.parseCliArgs(['--commits', 'HEAD', '--with-cockpit']);
  assert.strictEqual(parsedWithCockpit.withCockpit, true, 'parseCliArgs must parse --with-cockpit');

  const { repoDir, passSha, failSha } = initTempGitRepo();
  const logDir = path.join(os.tmpdir(), `td-wt-logs-test-${Date.now()}`);
  try {
    const res = await mod.runWorktreeBatchVerification({
      repoRoot: repoDir,
      commits: [
        { sha: passSha, subject: 'commit pass' },
        { sha: failSha, subject: 'commit fail long output' }
      ],
      command: process.execPath,
      args: ['probe.mjs'],
      cwdSubdir: '.',
      logDir,
      junctionNodeModules: false,
      timeoutMs: 15000
    });

    assert.strictEqual(res.passed, 1, `Expected 1 pass, got ${res.passed}`);
    assert.strictEqual(res.failed, 1, `Expected 1 fail, got ${res.failed}`);
    assert.strictEqual(res.results.length, 2);

    const passEntry = res.results[0];
    const failEntry = res.results[1];
    assert.strictEqual(passEntry.ok, true);
    assert.strictEqual(failEntry.ok, false);

    assert.ok(fs.existsSync(passEntry.logFile), 'Pass commit must save full log file');
    assert.ok(fs.existsSync(failEntry.logFile), 'Fail commit must save full log file');
    assert.ok(fs.existsSync(res.summaryLogFile), 'Summary log file must exist');
    assert.ok(fs.existsSync(res.summaryJsonFile), 'Summary json file must exist');

    const failLogContent = fs.readFileSync(failEntry.logFile, 'utf8');
    assert.ok(failLogContent.length > 29000, `Expected full untruncated log >29KB, got ${failLogContent.length} bytes`);
    assert.ok(failLogContent.includes('BEGIN_STDOUT_SENTINEL_'), 'Missing start of stdout');
    assert.ok(failLogContent.includes('MID_STDOUT_SENTINEL_'), 'Missing middle of stdout');
    assert.ok(failLogContent.includes('END_STDOUT_SENTINEL'), 'Missing end of stdout');
    assert.ok(failLogContent.includes('BEGIN_STDERR_'), 'Missing start of stderr');
    assert.ok(failLogContent.includes('_END_STDERR'), 'Missing end of stderr');

    // Suite mode: must continue running ALL tests after first failure and report EVERY failed test
    const suiteFx = initSuiteTempGitRepo();
    const suiteLogDir = path.join(os.tmpdir(), `td-wt-suite-logs-${Date.now()}`);
    try {
      const continueRes = await mod.runWorktreeBatchVerification({
        repoRoot: suiteFx.repoDir,
        commits: [{ sha: suiteFx.suiteSha, subject: 'suite commit' }],
        logDir: suiteLogDir,
        junctionNodeModules: false,
        timeoutMs: 15000
      });
      assert.strictEqual(continueRes.failed, 1);
      const entry = continueRes.results[0];
      assert.deepStrictEqual(
        entry.failed_tests,
        ['test-first-fail', 'test-third-fail'],
        `Must run entire suite after first failure and report every failure, got: ${JSON.stringify(entry.failed_tests)}`
      );
      assert.deepStrictEqual(entry.passed_tests, ['test-middle-pass']);
      const fullLog = fs.readFileSync(entry.logFile, 'utf8');
      assert.ok(fullLog.includes('FAIL_FIRST') && fullLog.includes('PASS_MIDDLE') && fullLog.includes('FAIL_THIRD'));

      // --skip removes failing tests -> suite passes and records skipped_tests
      const skipLogDir = path.join(os.tmpdir(), `td-wt-skip-logs-${Date.now()}`);
      try {
        const skipRes = await mod.runWorktreeBatchVerification({
          repoRoot: suiteFx.repoDir,
          commits: [{ sha: suiteFx.suiteSha, subject: 'suite commit' }],
          skip: ['test-first-fail', 'test-third-fail.mjs'],
          logDir: skipLogDir,
          junctionNodeModules: false,
          timeoutMs: 15000
        });
        assert.strictEqual(skipRes.passed, 1, `Skipping failing tests must pass, got: ${JSON.stringify(skipRes.results[0])}`);
        assert.deepStrictEqual(skipRes.results[0].skipped_tests, ['test-first-fail', 'test-third-fail']);
        assert.deepStrictEqual(skipRes.results[0].passed_tests, ['test-middle-pass']);
        const defaultLog = fs.readFileSync(skipRes.results[0].logFile, 'utf8');
        assert.ok(!defaultLog.includes('COCKPIT_PROBE_MARKER'), 'Default test:offline mode must NOT execute test-cockpit-probe');
      } finally {
        fs.rmSync(skipLogDir, { recursive: true, force: true });
      }

      // --with-cockpit runs full "test" suite including cockpit step
      const cockpitLogDir = path.join(os.tmpdir(), `td-wt-cockpit-logs-${Date.now()}`);
      try {
        const cockpitRes = await mod.runWorktreeBatchVerification({
          repoRoot: suiteFx.repoDir,
          commits: [{ sha: suiteFx.suiteSha, subject: 'suite commit' }],
          skip: ['test-first-fail', 'test-third-fail'],
          withCockpit: true,
          logDir: cockpitLogDir,
          junctionNodeModules: false,
          timeoutMs: 15000
        });
        assert.strictEqual(cockpitRes.passed, 1, `withCockpit suite must pass when failures skipped: ${JSON.stringify(cockpitRes.results[0])}`);
        assert.deepStrictEqual(cockpitRes.results[0].passed_tests, ['test-middle-pass', 'test-cockpit-probe']);
        const cockpitLog = fs.readFileSync(cockpitRes.results[0].logFile, 'utf8');
        assert.ok(cockpitLog.includes('COCKPIT_PROBE_MARKER'), '--with-cockpit must execute test-cockpit step');
      } finally {
        fs.rmSync(cockpitLogDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(suiteFx.repoDir, { recursive: true, force: true });
      fs.rmSync(suiteLogDir, { recursive: true, force: true });
    }

    const wtList = execFileSync('git', ['worktree', 'list'], { cwd: repoDir, encoding: 'utf8' }).trim().split(/\r?\n/);
    assert.strictEqual(wtList.length, 1, `Worktrees must be cleaned up, found: ${wtList}`);

    console.log('✓ Full untruncated stdout/stderr logs verified on pass & fail worktrees.');
    console.log('=================================================');
    console.log('ALL WORKTREE BATCH LOGGING TESTS PASSED!');
    console.log('=================================================');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(logDir, { recursive: true, force: true });
  }
}

runTests().catch(err => {
  console.error('Worktree batch test failed:', err);
  process.exit(1);
});
