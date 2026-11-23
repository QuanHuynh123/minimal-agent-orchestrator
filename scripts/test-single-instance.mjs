#!/usr/bin/env node
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  acquireShortReclaimGuard,
  acquireSingleInstanceLock,
  isProcessAlive,
  releaseShortReclaimGuard,
  releaseSingleInstanceLock,
  updateSingleInstanceLockPort
} from './lib/runtime-lock.mjs';
import {
  captureProcessSocketSnapshot,
  formatSocketSnapshotSummary,
  isEnobufsFailure
} from './lib/enobufs-diagnostics.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');
const ORCHESTRATOR_SCRIPT = path.resolve(__dirname, 'orchestrator.mjs');
const DASHBOARD_SCRIPT = path.resolve(__dirname, 'dashboard.mjs');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 8000, intervalMs = 50, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await predicate();
    if (val) return val;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

function runProcessWait(scriptPath, args = [], env = {}, timeoutMs = 8000, stdinText = null) {
  return new Promise((resolve, reject) => {
    const useStdinPipe = typeof stdinText === 'string';
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: path.resolve(TEAM_DIR, '..'),
      env: { ...process.env, ...env },
      stdio: [useStdinPipe ? 'pipe' : 'ignore', 'pipe', 'pipe']
    });
    if (useStdinPipe && child.stdin) {
      child.stdin.write(stdinText);
      child.stdin.end();
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr?.on('data', d => { stderr += d.toString('utf8'); });

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`Child ${path.basename(scriptPath)} timed out after ${timeoutMs}ms\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
    }, timeoutMs);

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, pid: child.pid });
    });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function spawnBgProcess(scriptPath, args = [], env = {}) {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd: path.resolve(TEAM_DIR, '..'),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', d => { stdout += d.toString('utf8'); });
  child.stderr?.on('data', d => { stderr += d.toString('utf8'); });
  return {
    child,
    getStdout: () => stdout,
    getStderr: () => stderr,
    stop: async () => {
      if (child.exitCode === null) {
        try { child.kill(); } catch {}
        await waitFor(() => child.exitCode !== null, 3000, 30, 'process exit').catch(() => {
          try { child.kill('SIGKILL'); } catch {}
        });
      }
    }
  };
}

function createIsolatedRuntimeFixtures(routerPort = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'td-single-lock-'));
  const configDir = path.join(root, 'config');
  const stateDir = path.join(root, 'state');
  const tasksDir = path.join(root, 'tasks');
  const activeDir = path.join(tasksDir, 'active');
  const archiveDir = path.join(tasksDir, 'archive');

  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(activeDir, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });

  fs.writeFileSync(path.join(configDir, 'policy.yaml'), [
    'policy:',
    '  version: "3.1.0"',
    '  project_id: "lock-test-workspace"',
    '  language: "python"',
    '  scope_control:',
    '    allowed_dirs:',
    '      - "tests/"',
    '  execution_guardrails:',
    '    healthcheck_timeout_sec: 5',
    '    network_connect_timeout_sec: 2',
    '  git_hygiene:',
    '    require_clean_worktree_before_start: false',
    '  validation:',
    '    fast_checks: []',
    '    suite_checks: []'
  ].join('\n'), 'utf8');

  fs.writeFileSync(path.join(configDir, 'team.yaml'), [
    'providers:',
    '  local_9router:',
    `    base_url: "http://127.0.0.1:${routerPort}/v1"`,
    '    default_key: "sk-test-lock"',
    'roles:',
    '  writer:',
    '    model: "test-writer-model"'
  ].join('\n'), 'utf8');

  return {
    root,
    configDir,
    stateDir,
    tasksDir,
    activeDir,
    archiveDir,
    orchestratorLock: path.join(root, '.orchestrator.lock'),
    cockpitLock: path.join(root, '.cockpit.lock')
  };
}

async function runTests() {
  console.log('Testing Single-Instance Atomic Locks for Orchestrator & Cockpit...\n');

  // Slow local HTTP server so Orchestrator Instance #1 stays legitimately alive in healthcheck while holding its lock
  const slowServer = http.createServer((req, res) => {
    setTimeout(() => {
      if (!res.writableEnded) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test-writer-model' }] }));
      }
    }, 3500);
  });
  await new Promise(resolve => slowServer.listen(0, '127.0.0.1', resolve));
  const slowRouterPort = slowServer.address().port;

  const fx = createIsolatedRuntimeFixtures(slowRouterPort);
  const bgHandles = [];

  try {
    // Prepare 1 task in activeDir so Orchestrator Instance #1 enters preflight healthcheck (holding lock for ~3.5s)
    const sampleTaskPath = path.join(fx.activeDir, 'T-lock-check-1.yaml');
    fs.writeFileSync(sampleTaskPath, [
      'task_id: T-lock-check-1',
      'title: Dummy hold task',
      'status: draft_review',
      'scope:',
      '  - tests/dummy.py'
    ].join('\n'), 'utf8');

    const sentinelStatePath = path.join(fx.stateDir, 'task-state.json');
    const sentinelLivePath = path.join(fx.stateDir, 'live-status.json');
    const sentinelReportPath = path.join(fx.stateDir, 'morning-report.md');
    fs.writeFileSync(sentinelStatePath, JSON.stringify({ sentinel: 'state-v1', completed_tasks: [], blocked_tasks: [], active_tasks: [], metrics: {} }), 'utf8');
    fs.writeFileSync(sentinelReportPath, '# Sentinel Report\n', 'utf8');

    const commonEnv = {
      AGENT_TEAM_CONFIG_DIR: fx.configDir,
      AGENT_TEAM_STATE_DIR: fx.stateDir,
      AGENT_TEAM_TASKS_DIR: fx.tasksDir,
      ORCHESTRATOR_LOCK_FILE: fx.orchestratorLock,
      COCKPIT_LOCK_FILE: fx.cockpitLock
    };

    // ---------------------------------------------------------
    // 1. Two Orchestrator instances: #2 exits non-zero, prints holder PID/port, never touches state files
    // ---------------------------------------------------------
    console.log('1. Testing two concurrent Orchestrator instances...');
    const orch1 = spawnBgProcess(ORCHESTRATOR_SCRIPT, ['run'], commonEnv);
    bgHandles.push(orch1);

    const orchLockData = await waitFor(() => {
      if (!fs.existsSync(fx.orchestratorLock)) return null;
      try {
        const parsed = JSON.parse(fs.readFileSync(fx.orchestratorLock, 'utf8'));
        return parsed?.pid ? parsed : null;
      } catch {
        return null;
      }
    }, 6000, 40, 'orchestrator #1 lock file creation');

    assert.strictEqual(orchLockData.pid, orch1.child.pid, 'Lock must store Orchestrator #1 PID');
    assert.ok('port' in orchLockData, 'Lock payload must explicitly contain port field');
    assert.ok(orchLockData.started_at, 'Lock payload must contain started_at timestamp');

    // Wait until Instance #1 has written its initial live-status.json before starting #2
    await waitFor(() => fs.existsSync(sentinelLivePath), 4000, 40, 'orchestrator #1 initial live-status');
    await sleep(60);

    const beforeStateRaw = fs.readFileSync(sentinelStatePath, 'utf8');
    const beforeStateMtime = fs.statSync(sentinelStatePath).mtimeMs;
    const beforeLiveRaw = fs.readFileSync(sentinelLivePath, 'utf8');
    const beforeLiveMtime = fs.statSync(sentinelLivePath).mtimeMs;
    const beforeReportRaw = fs.readFileSync(sentinelReportPath, 'utf8');
    const beforeReportMtime = fs.statSync(sentinelReportPath).mtimeMs;

    const orch2Res = await runProcessWait(ORCHESTRATOR_SCRIPT, ['run'], commonEnv, 5000);
    assert.notStrictEqual(orch2Res.code, 0, 'Second Orchestrator instance must exit with non-zero error code');
    const orch2Combined = `${orch2Res.stdout}\n${orch2Res.stderr}`;
    assert.ok(
      orch2Combined.includes(String(orch1.child.pid)),
      `Second Orchestrator refusal message must mention holding PID (${orch1.child.pid}). Got:\n${orch2Combined}`
    );
    assert.match(
      orch2Combined,
      /port|cổng/i,
      `Second Orchestrator refusal message must explicitly report port status. Got:\n${orch2Combined}`
    );

    // Verify Instance #1 lock still intact & state files untouched by Instance #2
    const lockAfterOrch2 = JSON.parse(fs.readFileSync(fx.orchestratorLock, 'utf8'));
    assert.strictEqual(lockAfterOrch2.pid, orch1.child.pid, 'Rejected instance #2 must not overwrite or delete lock #1');
    assert.strictEqual(fs.readFileSync(sentinelStatePath, 'utf8'), beforeStateRaw, 'Instance #2 must not modify task-state.json');
    assert.strictEqual(fs.statSync(sentinelStatePath).mtimeMs, beforeStateMtime, 'Instance #2 must not touch task-state.json mtime');
    assert.strictEqual(fs.readFileSync(sentinelLivePath, 'utf8'), beforeLiveRaw, 'Instance #2 must not modify live-status.json');
    assert.strictEqual(fs.statSync(sentinelLivePath).mtimeMs, beforeLiveMtime, 'Instance #2 must not touch live-status.json mtime');
    assert.strictEqual(fs.readFileSync(sentinelReportPath, 'utf8'), beforeReportRaw, 'Instance #2 must not modify morning-report.md');
    assert.strictEqual(fs.statSync(sentinelReportPath).mtimeMs, beforeReportMtime, 'Instance #2 must not touch morning-report.md mtime');

    await orch1.stop();
    if (fs.existsSync(fx.orchestratorLock)) fs.unlinkSync(fx.orchestratorLock);
    console.log('✓ Two Orchestrator instances guard verified.');

    // ---------------------------------------------------------
    // 2. Dead PID stale lock replacement (Orchestrator)
    // ---------------------------------------------------------
    console.log('2. Testing dead-PID stale lock replacement for Orchestrator...');
    fs.writeFileSync(fx.orchestratorLock, JSON.stringify({
      pid: 99999999,
      port: null,
      started_at: '2026-01-01T00:00:00.000Z',
      role: 'orchestrator'
    }), 'utf8');
    // Empty active dir so reclaimed Orchestrator exits cleanly 0
    fs.unlinkSync(sampleTaskPath);
    const orchReclaimRes = await runProcessWait(ORCHESTRATOR_SCRIPT, ['run'], commonEnv, 6000);
    assert.strictEqual(orchReclaimRes.code, 0, `Orchestrator should reclaim dead PID lock and exit 0. Got stderr:\n${orchReclaimRes.stderr}`);
    assert.ok(!fs.existsSync(fx.orchestratorLock), 'Reclaimed Orchestrator lock should be released cleanly on normal exit');
    console.log('✓ Dead-PID stale lock replacement verified for Orchestrator.');

    // ---------------------------------------------------------
    // 3. Two Cockpit instances: #2 exits non-zero, prints holder PID & port, dead-PID lock replaced
    // ---------------------------------------------------------
    console.log('3. Testing two concurrent Cockpit instances...');
    const cockpit1 = spawnBgProcess(DASHBOARD_SCRIPT, [], { ...commonEnv, DASHBOARD_PORT: '0' });
    bgHandles.push(cockpit1);

    const cockpitLockData = await waitFor(() => {
      if (!fs.existsSync(fx.cockpitLock)) return null;
      try {
        const parsed = JSON.parse(fs.readFileSync(fx.cockpitLock, 'utf8'));
        return parsed?.pid && Number(parsed?.port) > 0 ? parsed : null;
      } catch {
        return null;
      }
    }, 6000, 40, 'cockpit #1 lock file with bound port');

    assert.strictEqual(cockpitLockData.pid, cockpit1.child.pid, 'Cockpit lock must hold Instance #1 PID');
    assert.ok(Number.isInteger(cockpitLockData.port) && cockpitLockData.port > 0, 'Cockpit lock must contain valid bound port');
    assert.ok(cockpitLockData.started_at, 'Cockpit lock must contain started_at');

    const cBeforeStateMtime = fs.statSync(sentinelStatePath).mtimeMs;
    const cBeforeReportMtime = fs.statSync(sentinelReportPath).mtimeMs;

    const cockpit2Res = await runProcessWait(DASHBOARD_SCRIPT, [], { ...commonEnv, DASHBOARD_PORT: '0' }, 5000);
    assert.notStrictEqual(cockpit2Res.code, 0, 'Second Cockpit instance must exit with non-zero error code');
    const cockpit2Combined = `${cockpit2Res.stdout}\n${cockpit2Res.stderr}`;
    assert.ok(
      cockpit2Combined.includes(String(cockpit1.child.pid)),
      `Second Cockpit refusal must mention holding PID (${cockpit1.child.pid}). Got:\n${cockpit2Combined}`
    );
    assert.ok(
      cockpit2Combined.includes(String(cockpitLockData.port)),
      `Second Cockpit refusal must mention holding port (${cockpitLockData.port}). Got:\n${cockpit2Combined}`
    );
    assert.strictEqual(fs.statSync(sentinelStatePath).mtimeMs, cBeforeStateMtime, 'Second Cockpit must not touch task-state.json');
    assert.strictEqual(fs.statSync(sentinelReportPath).mtimeMs, cBeforeReportMtime, 'Second Cockpit must not touch morning-report.md');

    const cockpitLockStill1 = JSON.parse(fs.readFileSync(fx.cockpitLock, 'utf8'));
    assert.strictEqual(cockpitLockStill1.pid, cockpit1.child.pid, 'Rejected Cockpit #2 must not disturb lock #1');

    await cockpit1.stop();
    if (fs.existsSync(fx.cockpitLock)) fs.unlinkSync(fx.cockpitLock);

    // Dead-PID stale lock replacement for Cockpit
    fs.writeFileSync(fx.cockpitLock, JSON.stringify({
      pid: 99999999,
      port: 4399,
      started_at: '2026-01-01T00:00:00.000Z',
      role: 'cockpit'
    }), 'utf8');
    const cockpit3 = spawnBgProcess(DASHBOARD_SCRIPT, [], { ...commonEnv, DASHBOARD_PORT: '0' });
    bgHandles.push(cockpit3);
    const reclaimedCockpitLock = await waitFor(() => {
      if (!fs.existsSync(fx.cockpitLock)) return null;
      try {
        const parsed = JSON.parse(fs.readFileSync(fx.cockpitLock, 'utf8'));
        return parsed?.pid === cockpit3.child.pid && Number(parsed?.port) > 0 ? parsed : null;
      } catch {
        return null;
      }
    }, 6000, 40, 'cockpit #3 reclaiming dead PID lock');
    assert.strictEqual(reclaimedCockpitLock.pid, cockpit3.child.pid);
    await cockpit3.stop();

    console.log('✓ Two Cockpit instances guard & dead-PID replacement verified.');

    // ---------------------------------------------------------
    // 4. Parallel atomic race across 5 simultaneous processes (fresh & dead-PID)
    // ---------------------------------------------------------
    console.log('4. Testing 5-process simultaneous atomic lock race...');
    const raceLockPath = path.join(fx.root, 'race.lock');
    const raceScript = path.join(fx.root, 'race-contender.mjs');
    const runtimeLockUrl = new URL('./lib/runtime-lock.mjs', import.meta.url).href;
    fs.writeFileSync(raceScript, [
      `import { acquireSingleInstanceLock, releaseSingleInstanceLock } from ${JSON.stringify(runtimeLockUrl)};`,
      `const lockFile = process.argv[2];`,
      `const res = acquireSingleInstanceLock(lockFile, { role: 'cockpit', port: 4399 });`,
      `if (!res.ok) {`,
      `  console.error(res.message);`,
      `  process.exit(1);`,
      `}`,
      `setTimeout(() => {`,
      `  releaseSingleInstanceLock(lockFile, { instanceId: res.lock.instance_id });`,
      `  process.exit(0);`,
      `}, 900);`
    ].join('\n'), 'utf8');

    // Race A: 5 simultaneous starters on clean directory
    const raceA = await Promise.all(
      Array.from({ length: 5 }, () => runProcessWait(raceScript, [raceLockPath], {}, 6000))
    );
    const winnersA = raceA.filter(r => r.code === 0);
    const losersA = raceA.filter(r => r.code !== 0);
    assert.strictEqual(winnersA.length, 1, `Exactly 1 contender must win fresh race, got ${winnersA.length}`);
    assert.strictEqual(losersA.length, 4, `Exactly 4 contenders must fail cleanly, got ${losersA.length}`);
    for (const loser of losersA) {
      assert.ok(loser.stderr.includes('4399'), `Loser stderr must mention holding port 4399: ${loser.stderr}`);
    }

    // Race B: 5 simultaneous starters reclaiming a dead-PID stale lock
    fs.writeFileSync(raceLockPath, JSON.stringify({
      pid: 99999999,
      port: 4388,
      started_at: '2026-01-01T00:00:00.000Z',
      role: 'cockpit'
    }), 'utf8');
    const raceB = await Promise.all(
      Array.from({ length: 5 }, () => runProcessWait(raceScript, [raceLockPath], {}, 6000))
    );
    const winnersB = raceB.filter(r => r.code === 0);
    const losersB = raceB.filter(r => r.code !== 0);
    assert.strictEqual(winnersB.length, 1, `Exactly 1 contender must win dead-PID reclaim race, got ${winnersB.length}`);
    assert.strictEqual(losersB.length, 4, `Exactly 4 contenders must reject in reclaim race, got ${losersB.length}`);
    console.log('✓ 5-process simultaneous atomic lock race & dead-PID reclaim verified.');

    // =========================================================================
    // TEST 5: EPERM from signal 0 treats process as alive & never replaces lock
    // =========================================================================
    const epermKill = () => {
      const err = new Error('operation not permitted');
      err.code = 'EPERM';
      throw err;
    };
    const esrchKill = () => {
      const err = new Error('no such process');
      err.code = 'ESRCH';
      throw err;
    };
    assert.strictEqual(isProcessAlive(54321, { kill: epermKill }), true, 'isProcessAlive must return true on EPERM');
    assert.strictEqual(isProcessAlive(54321, { kill: esrchKill }), false, 'isProcessAlive must return false on ESRCH');

    const epermLockPath = path.join(fx.root, 'eperm.lock');
    fs.writeFileSync(epermLockPath, JSON.stringify({
      pid: 54321,
      port: 4311,
      started_at: '2026-01-01T00:00:00.000Z',
      process_started_at: '2026-01-01T00:00:00.000Z',
      process_start_ms: Date.parse('2026-01-01T00:00:00.000Z'),
      role: 'cockpit',
      instance_id: 'eperm-owner'
    }), 'utf8');
    const epermRes = acquireSingleInstanceLock(epermLockPath, {
      role: 'cockpit',
      port: 4312,
      killFn: epermKill,
      getProcessStartTime: () => null
    });
    assert.strictEqual(epermRes.ok, false, 'EPERM alive process lock must NOT be replaced');
    assert.strictEqual(epermRes.reason, 'already_running');
    const epermDisk = JSON.parse(fs.readFileSync(epermLockPath, 'utf8'));
    assert.strictEqual(epermDisk.pid, 54321, 'EPERM lock on disk must stay intact with pid 54321');
    console.log('✓ isProcessAlive EPERM protection & lock non-replacement verified.');

    // =========================================================================
    // TEST 6: Process creation timestamp stored & PID reuse lock reclaimed
    // =========================================================================
    const reuseLockPath = path.join(fx.root, 'pid-reuse.lock');
    const ownRes = acquireSingleInstanceLock(reuseLockPath, { role: 'cockpit', port: 4321 });
    assert.strictEqual(ownRes.ok, true, 'Fresh lock with process start timestamp must succeed');
    assert.ok(typeof ownRes.lock.process_started_at === 'string' && !Number.isNaN(Date.parse(ownRes.lock.process_started_at)),
      `Lock must store valid ISO process_started_at, got: ${JSON.stringify(ownRes.lock)}`);
    assert.ok(Number.isFinite(ownRes.lock.process_start_ms) && ownRes.lock.process_start_ms > 0,
      `Lock must store positive process_start_ms, got: ${JSON.stringify(ownRes.lock)}`);
    const ownDisk = JSON.parse(fs.readFileSync(reuseLockPath, 'utf8'));
    assert.strictEqual(ownDisk.process_started_at, ownRes.lock.process_started_at);
    releaseSingleInstanceLock(reuseLockPath, { instanceId: ownRes.lock.instance_id });

    const sleeperScript = path.join(fx.root, 'sleeper.mjs');
    fs.writeFileSync(sleeperScript, 'setTimeout(() => {}, 15000);', 'utf8');
    const sleeper = spawnBgProcess(sleeperScript, [], {});
    bgHandles.push(sleeper);

    // Wait briefly so sleeper OS StartTime is established
    await sleep(250);
    const oldStartMs = Date.now() - 60000;
    const reusedLockPayload = {
      pid: sleeper.child.pid,
      port: 4322,
      started_at: new Date(oldStartMs).toISOString(),
      process_started_at: new Date(oldStartMs).toISOString(),
      process_start_ms: oldStartMs,
      role: 'cockpit',
      instance_id: 'old-dead-owner-whose-pid-was-reused'
    };

    // Fail-safe guard: when OS start time cannot be read (e.g. AccessDenied), live PID must NOT be stolen
    fs.writeFileSync(reuseLockPath, JSON.stringify(reusedLockPayload), 'utf8');
    const unknownStartRes = acquireSingleInstanceLock(reuseLockPath, {
      role: 'cockpit',
      port: 4323,
      getProcessStartTime: () => null
    });
    assert.strictEqual(unknownStartRes.ok, false, 'Must not steal live PID lock when start time lookup fails');

    // Real OS PID-reuse detection: live sleeper started AFTER oldStartMs -> must reclaim lock
    const reuseRes = acquireSingleInstanceLock(reuseLockPath, { role: 'cockpit', port: 4323 });
    assert.strictEqual(reuseRes.ok, true, `Stale lock whose PID (${sleeper.child.pid}) was reused by newer process must be reclaimed: ${JSON.stringify(reuseRes)}`);
    assert.strictEqual(reuseRes.replacedStalePid, sleeper.child.pid);
    assert.strictEqual(reuseRes.lock.pid, process.pid);
    assert.strictEqual(reuseRes.lock.port, 4323);
    releaseSingleInstanceLock(reuseLockPath, { instanceId: reuseRes.lock.instance_id });
    console.log('✓ Process creation timestamp & PID-reuse stale lock reclaim verified.');

    // =========================================================================
    // TEST 7: updateSingleInstanceLockPort retries transient Windows EPERM/EBUSY rename
    // =========================================================================
    const retryPortLockPath = path.join(fx.root, 'port-retry.lock');
    const portLock = acquireSingleInstanceLock(retryPortLockPath, { role: 'cockpit', port: 0 });
    assert.strictEqual(portLock.ok, true);
    let injectedRenameFaults = 0;
    const updatedPortOk = updateSingleInstanceLockPort(retryPortLockPath, 4567, {
      instanceId: portLock.lock.instance_id,
      renameSync: (src, dest) => {
        if (injectedRenameFaults < 2) {
          injectedRenameFaults++;
          const err = new Error('transient rename lock');
          err.code = injectedRenameFaults === 1 ? 'EPERM' : 'EBUSY';
          throw err;
        }
        fs.renameSync(src, dest);
      }
    });
    assert.strictEqual(updatedPortOk, true, 'updateSingleInstanceLockPort must retry transient EPERM/EBUSY rename errors');
    assert.strictEqual(injectedRenameFaults, 2);
    const updatedDiskLock = JSON.parse(fs.readFileSync(retryPortLockPath, 'utf8'));
    assert.strictEqual(updatedDiskLock.port, 4567, 'Lock file on disk must reflect bound port 4567 after rename retries');
    releaseSingleInstanceLock(retryPortLockPath, { instanceId: portLock.lock.instance_id });
    console.log('✓ updateSingleInstanceLockPort EPERM/EBUSY rename retry verified.');

    // =========================================================================
    // TEST 8: .reclaim guard excludes strictly by live owner (never elapsed ageMs)
    // =========================================================================
    assert.strictEqual(typeof acquireShortReclaimGuard, 'function', 'runtime-lock must export acquireShortReclaimGuard');
    const reclaimTestPath = path.join(fx.root, 'owner-only.lock.reclaim');
    const liveReclaimStartMs = Date.now() - 120000;
    fs.writeFileSync(reclaimTestPath, JSON.stringify({
      pid: 65432,
      instance_id: 'live-reclaim-holder',
      started_at: new Date(liveReclaimStartMs).toISOString(),
      process_started_at: new Date(liveReclaimStartMs).toISOString(),
      process_start_ms: liveReclaimStartMs
    }), 'utf8');
    // Backdate mtime by 60 seconds (> old 5000ms threshold) while owner PID is STILL alive with matching start time
    const oldMtime = new Date(Date.now() - 60000);
    fs.utimesSync(reclaimTestPath, oldMtime, oldMtime);

    const agedLiveAttempt = acquireShortReclaimGuard(reclaimTestPath, 180, {
      killFn: () => {},
      getProcessStartTime: () => liveReclaimStartMs
    });
    assert.strictEqual(agedLiveAttempt, false, '.reclaim held by alive owner must NOT be evicted even when aged > 5s');
    const reclaimStillHeld = JSON.parse(fs.readFileSync(reclaimTestPath, 'utf8'));
    assert.strictEqual(reclaimStillHeld.instance_id, 'live-reclaim-holder', 'Alive .reclaim file must stay untouched');

    // Fresh mtime (0ms old) held by dead PID MUST be reclaimed immediately
    const deadNow = new Date();
    fs.writeFileSync(reclaimTestPath, JSON.stringify({
      pid: 99999999,
      instance_id: 'dead-reclaim-holder',
      started_at: deadNow.toISOString(),
      process_started_at: deadNow.toISOString(),
      process_start_ms: deadNow.getTime()
    }), 'utf8');
    const deadImmediateAttempt = acquireShortReclaimGuard(reclaimTestPath, 200);
    assert.strictEqual(deadImmediateAttempt, true, 'Dead owner .reclaim must be reclaimed immediately regardless of mtime age');
    const newReclaimOwner = JSON.parse(fs.readFileSync(reclaimTestPath, 'utf8'));
    assert.strictEqual(newReclaimOwner.pid, process.pid);
    releaseShortReclaimGuard(reclaimTestPath, { pid: process.pid, instanceId: newReclaimOwner.instance_id });
    assert.strictEqual(fs.existsSync(reclaimTestPath), false, 'releaseShortReclaimGuard must remove owned .reclaim');
    console.log('✓ .reclaim owner-liveness exclusion (no elapsed-time eviction) verified.');

    // =========================================================================
    // TEST 9: Fail-closed clear message when process start time cannot be read
    // =========================================================================
    const failClosedPath = path.join(fx.root, 'fail-closed-start.lock');
    const fcStartedAt = new Date(Date.now() - 10000).toISOString();
    fs.writeFileSync(failClosedPath, JSON.stringify({
      pid: 55512,
      port: 4399,
      started_at: fcStartedAt,
      process_started_at: fcStartedAt,
      process_start_ms: Date.now() - 10000,
      role: 'orchestrator',
      instance_id: 'fc-holder-1'
    }), 'utf8');
    const failClosedAttempt = acquireSingleInstanceLock(failClosedPath, {
      role: 'orchestrator',
      killFn: () => {},
      getProcessStartTime: () => null
    });
    assert.strictEqual(failClosedAttempt.ok, false, 'Unreadable start time on live PID MUST fail closed');
    assert.strictEqual(failClosedAttempt.reason, 'already_running');
    assert.strictEqual(failClosedAttempt.startTimeUnavailable, true, 'Result must report startTimeUnavailable: true');
    assert.ok(
      failClosedAttempt.message.toLowerCase().includes('fail-closed'),
      `Fail-closed message must explain fail-closed stance, got: ${failClosedAttempt.message}`
    );
    assert.ok(
      failClosedAttempt.message.toLowerCase().includes('start time'),
      `Fail-closed message must mention unreadable start time, got: ${failClosedAttempt.message}`
    );
    assert.ok(
      failClosedAttempt.message.includes('--force-unlock'),
      `Fail-closed message must suggest manual --force-unlock, got: ${failClosedAttempt.message}`
    );
    assert.strictEqual(JSON.parse(fs.readFileSync(failClosedPath, 'utf8')).instance_id, 'fc-holder-1');
    console.log('✓ Fail-closed start-time-unreadable message & --force-unlock hint verified.');

    // =========================================================================
    // TEST 10: --force-unlock requires explicit confirmation (Orchestrator & Cockpit)
    // =========================================================================
    fs.writeFileSync(fx.orchestratorLock, JSON.stringify({
      pid: 99999998,
      port: null,
      started_at: new Date(Date.now() - 5000).toISOString(),
      role: 'orchestrator',
      instance_id: 'force-unlock-orch-test'
    }), 'utf8');
    fs.writeFileSync(`${fx.orchestratorLock}.reclaim`, JSON.stringify({
      pid: 99999998,
      instance_id: 'force-unlock-orch-reclaim'
    }), 'utf8');

    const orchForceNoConfirm = await runProcessWait(ORCHESTRATOR_SCRIPT, ['--force-unlock'], commonEnv, 8000);
    assert.notStrictEqual(orchForceNoConfirm.code, 0, 'orchestrator --force-unlock without confirmation MUST exit non-zero');
    assert.strictEqual(fs.existsSync(fx.orchestratorLock), true, 'Unconfirmed --force-unlock must NOT delete orchestrator lock');
    assert.strictEqual(fs.existsSync(`${fx.orchestratorLock}.reclaim`), true, 'Unconfirmed --force-unlock must NOT delete .reclaim');

    const orchForceDeclined = await runProcessWait(ORCHESTRATOR_SCRIPT, ['--force-unlock'], commonEnv, 8000, 'no\n');
    assert.notStrictEqual(orchForceDeclined.code, 0, 'orchestrator --force-unlock declined via "no" MUST exit non-zero');
    assert.strictEqual(fs.existsSync(fx.orchestratorLock), true);

    const orchForceConfirmed = await runProcessWait(ORCHESTRATOR_SCRIPT, ['--force-unlock'], commonEnv, 8000, 'UNLOCK\n');
    assert.strictEqual(orchForceConfirmed.code, 0, `Confirmed orchestrator --force-unlock must succeed: ${orchForceConfirmed.stderr}`);
    assert.ok(
      (orchForceConfirmed.stdout + orchForceConfirmed.stderr).includes('99999998'),
      'Confirmed --force-unlock must print removed holder PID'
    );
    assert.strictEqual(fs.existsSync(fx.orchestratorLock), false, 'Confirmed --force-unlock must remove orchestrator lock');
    assert.strictEqual(fs.existsSync(`${fx.orchestratorLock}.reclaim`), false, 'Confirmed --force-unlock must remove .reclaim');

    fs.writeFileSync(fx.cockpitLock, JSON.stringify({
      pid: 99999997,
      port: 4329,
      started_at: new Date(Date.now() - 5000).toISOString(),
      role: 'cockpit',
      instance_id: 'force-unlock-cockpit-test'
    }), 'utf8');
    fs.writeFileSync(`${fx.cockpitLock}.reclaim`, JSON.stringify({
      pid: 99999997,
      instance_id: 'force-unlock-cockpit-reclaim'
    }), 'utf8');

    const cockpitForceNoConfirm = await runProcessWait(DASHBOARD_SCRIPT, ['--force-unlock'], commonEnv, 8000);
    assert.notStrictEqual(cockpitForceNoConfirm.code, 0, 'dashboard --force-unlock without confirmation MUST exit non-zero');
    assert.strictEqual(fs.existsSync(fx.cockpitLock), true);

    const cockpitForceYes = await runProcessWait(DASHBOARD_SCRIPT, ['--force-unlock', '--yes'], commonEnv, 8000);
    assert.strictEqual(cockpitForceYes.code, 0, `dashboard --force-unlock --yes must succeed: ${cockpitForceYes.stderr}`);
    const cockpitUnlockOut = cockpitForceYes.stdout + cockpitForceYes.stderr;
    assert.ok(cockpitUnlockOut.includes('99999997') && cockpitUnlockOut.includes('4329'), 'Cockpit unlock must display PID and Port');
    assert.strictEqual(fs.existsSync(fx.cockpitLock), false, 'Cockpit --force-unlock --yes must remove lock');
    assert.strictEqual(fs.existsSync(`${fx.cockpitLock}.reclaim`), false, 'Cockpit --force-unlock --yes must remove .reclaim');
    console.log('✓ Manual --force-unlock with confirmation (Orchestrator & Cockpit) verified.');

    // =========================================================================
    // TEST 11: .reclaim atomic temp+linkSync (or mkdir+rename fallback, zero 2-step wx) & corruptGraceMs
    // =========================================================================
    const atomicReclaimPath = path.join(fx.root, 'atomic-guard.lock.reclaim');
    let linkCalls = 0;
    let tempHadCompleteJsonBeforeLink = false;
    const atomicAcquired = acquireShortReclaimGuard(atomicReclaimPath, 500, {
      openSync: () => {
        throw new Error('Must NOT fall back to 2-step openSync(wx)+writeSync');
      },
      linkSync: (src, dst) => {
        linkCalls++;
        const tmpRaw = fs.readFileSync(src, 'utf8');
        const tmpParsed = JSON.parse(tmpRaw);
        assert.strictEqual(tmpParsed.pid, process.pid);
        assert.ok(tmpParsed.instance_id, 'Temp guard file must already contain instance_id before link/rename');
        tempHadCompleteJsonBeforeLink = true;
        if (linkCalls === 1) {
          const e = new Error('Simulated transient EPERM on linkSync');
          e.code = 'EPERM';
          throw e;
        }
        try {
          fs.linkSync(src, dst);
        } catch (linkErr) {
          // Inside sandbox where CreateHardLink is disallowed, mimic the OS EPERM/EXDEV so mkdir+rename fallback runs
          throw linkErr;
        }
      }
    });
    assert.strictEqual(atomicAcquired, true, 'acquireShortReclaimGuard must publish complete .reclaim atomically');
    assert.ok(linkCalls >= 2, 'Must retry linkSync on transient EPERM instead of skipping straight to openSync(wx)');
    assert.strictEqual(tempHadCompleteJsonBeforeLink, true);
    const publishedGuard = JSON.parse(fs.readFileSync(atomicReclaimPath, 'utf8'));
    assert.strictEqual(publishedGuard.pid, process.pid);
    releaseShortReclaimGuard(atomicReclaimPath, { pid: process.pid, instanceId: publishedGuard.instance_id });

    // Explicit EXDEV -> mkdir+rename single-step fallback also publishes complete file without 2-step wx
    const fallbackReclaimPath = path.join(fx.root, 'atomic-fallback.lock.reclaim');
    let renameSawCompleteSrc = false;
    const fallbackAcquired = acquireShortReclaimGuard(fallbackReclaimPath, 500, {
      openSync: () => {
        throw new Error('Must NOT call 2-step openSync(wx) on EXDEV fallback');
      },
      linkSync: () => {
        const e = new Error('Cross-device hardlink unsupported');
        e.code = 'EXDEV';
        throw e;
      },
      renameSync: (src, dst) => {
        const parsed = JSON.parse(fs.readFileSync(src, 'utf8'));
        assert.strictEqual(parsed.pid, process.pid);
        renameSawCompleteSrc = true;
        fs.renameSync(src, dst);
      }
    });
    assert.strictEqual(fallbackAcquired, true, 'EXDEV/EPERM fallback via mkdir+rename must succeed atomically');
    assert.strictEqual(renameSawCompleteSrc, true, 'renameSync source file must already hold full JSON');
    const fbGuard = JSON.parse(fs.readFileSync(fallbackReclaimPath, 'utf8'));
    releaseShortReclaimGuard(fallbackReclaimPath, { pid: process.pid, instanceId: fbGuard.instance_id });

    // Verify corruptGraceMs ONLY applies to genuinely corrupt/crashed 0-byte files once aged >= corruptGraceMs
    const corruptGuardPath = path.join(fx.root, 'corrupt-crash.lock.reclaim');
    fs.writeFileSync(corruptGuardPath, '', 'utf8');
    const freshCorruptAttempt = acquireShortReclaimGuard(corruptGuardPath, 80, { corruptGraceMs: 5000 });
    assert.strictEqual(freshCorruptAttempt, false, 'Fresh 0-byte corrupt stub must wait corruptGraceMs before cleanup');
    const agedStubTime = new Date(Date.now() - 300);
    fs.utimesSync(corruptGuardPath, agedStubTime, agedStubTime);
    const agedCorruptAttempt = acquireShortReclaimGuard(corruptGuardPath, 200, { corruptGraceMs: 100 });
    assert.strictEqual(agedCorruptAttempt, true, 'Crashed 0-byte stub past corruptGraceMs must be reclaimed');
    const reclaimedStub = JSON.parse(fs.readFileSync(corruptGuardPath, 'utf8'));
    assert.strictEqual(reclaimedStub.pid, process.pid);
    releaseShortReclaimGuard(corruptGuardPath, { pid: process.pid, instanceId: reclaimedStub.instance_id });
    console.log('✓ Atomic temp+linkSync .reclaim creation & crash-only corruptGraceMs verified.');

    console.log('\n=================================================');
    console.log('ALL SINGLE-INSTANCE LOCK TESTS PASSED!');
    console.log('=================================================');
  } finally {
    for (const h of bgHandles) {
      await h.stop();
    }
    slowServer.close();
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
}

runTests().catch(async err => {
  console.error('Single-instance lock test failed:', err);
  if (isEnobufsFailure(err?.stack || err?.message, err)) {
    const snap = await captureProcessSocketSnapshot();
    console.error(`[ENOBUFS] Per-process socket snapshot: ${formatSocketSnapshotSummary(snap)}`);
    console.error(JSON.stringify(snap, null, 2));
  }
  process.exit(1);
});
