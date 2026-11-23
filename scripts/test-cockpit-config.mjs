#!/usr/bin/env node
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');
const DASHBOARD_SCRIPT = path.resolve(__dirname, 'dashboard.mjs');
const ORCHESTRATOR_SCRIPT = path.resolve(__dirname, 'orchestrator.mjs');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 8000, intervalMs = 40, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await predicate();
    if (val) return val;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

function createTempFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'td-cockpit-cfg-'));
  const configDir = path.join(root, 'config');
  const stateDir = path.join(root, 'state');
  const tasksDir = path.join(root, 'tasks');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(tasksDir, 'active'), { recursive: true });
  fs.mkdirSync(path.join(tasksDir, 'archive'), { recursive: true });

  fs.writeFileSync(path.join(configDir, 'policy.yaml'), [
    'policy:',
    '  version: "3.1.0"',
    '  project_id: "cockpit-cfg-test"',
    '  language: "python"',
    '  scope_control:',
    '    allowed_dirs:',
    '      - "tests/"',
    '  cockpit:',
    '    host: "127.0.0.1"',
    '    port: 4391',
    '  git_hygiene:',
    '    require_clean_worktree_before_start: false'
  ].join('\n'), 'utf8');

  fs.writeFileSync(path.join(configDir, 'policy.local.yaml'), [
    'policy:',
    '  cockpit:',
    '    port: 0'
  ].join('\n'), 'utf8');

  fs.writeFileSync(path.join(configDir, 'team.yaml'), [
    'providers:',
    '  local_9router:',
    '    base_url: "http://127.0.0.1:20128/v1"',
    '    default_key: "sk-test"',
    'roles:',
    '  writer:',
    '    model: "test-model"'
  ].join('\n'), 'utf8');

  return {
    root,
    configDir,
    stateDir,
    tasksDir,
    cockpitLock: path.join(root, '.cockpit.lock'),
    orchestratorLock: path.join(root, '.orchestrator.lock')
  };
}

function runProcessWait(scriptPath, args = [], env = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: path.resolve(TEAM_DIR, '..'),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr?.on('data', d => { stderr += d.toString('utf8'); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`Timed out ${path.basename(scriptPath)}`));
    }, timeoutMs);
    child.on('exit', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function runTests() {
  console.log('Testing Cockpit Configured Port & No-Duplicate-Runner Guard (Commit 2)...\n');
  const fx = createTempFixture();
  const bgChildren = [];

  try {
    // 1. resolveCockpitConfig must read policy.yaml + policy.local.yaml override (fail on invalid port)
    console.log('1. Testing resolveCockpitConfig merge & validation...');
    const policyLoader = await import('./lib/policy-loader.mjs');
    assert.strictEqual(typeof policyLoader.resolveCockpitConfig, 'function', 'policy-loader.mjs must export resolveCockpitConfig');
    const cleanEnv = { ...process.env };
    delete cleanEnv.DASHBOARD_PORT;
    delete cleanEnv.DASHBOARD_HOST;
    const cfg = policyLoader.resolveCockpitConfig({ configDir: fx.configDir, env: cleanEnv });
    assert.strictEqual(cfg.port, 0, 'policy.local.yaml cockpit.port=0 must override policy.yaml');
    assert.strictEqual(cfg.host, '127.0.0.1');
    assert.strictEqual(cfg.url, 'http://127.0.0.1:0');

    assert.throws(() => policyLoader.resolveCockpitConfig({
      configDir: fx.configDir,
      env: { ...cleanEnv, DASHBOARD_PORT: '99999' }
    }), /port/i, 'Invalid port must be rejected cleanly');
    console.log('✓ resolveCockpitConfig merge & validation verified.');

    // 2. Dashboard CLI without DASHBOARD_PORT binds configured ephemeral port 0 (not hardcoded 4310/4395)
    console.log('2. Testing Cockpit process reads ephemeral port 0 from config (not hardcoded 4310/4395)...');
    const dashEnv = {
      ...cleanEnv,
      AGENT_TEAM_CONFIG_DIR: fx.configDir,
      AGENT_TEAM_STATE_DIR: fx.stateDir,
      AGENT_TEAM_TASKS_DIR: fx.tasksDir,
      ORCHESTRATOR_LOCK_FILE: fx.orchestratorLock,
      COCKPIT_LOCK_FILE: fx.cockpitLock
    };
    const dashChild = spawn(process.execPath, [DASHBOARD_SCRIPT], {
      cwd: path.resolve(TEAM_DIR, '..'),
      env: dashEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    bgChildren.push(dashChild);
    let dashOut = '';
    dashChild.stdout?.on('data', d => { dashOut += d.toString('utf8'); });
    dashChild.stderr?.on('data', d => { dashOut += d.toString('utf8'); });

    const lock = await waitFor(() => {
      if (!fs.existsSync(fx.cockpitLock)) return null;
      try {
        const parsed = JSON.parse(fs.readFileSync(fx.cockpitLock, 'utf8'));
        return Number.isInteger(parsed?.port) && parsed.port > 0 ? parsed : null;
      } catch {
        return null;
      }
    }, 6000, 40, 'cockpit listening on OS-assigned ephemeral port > 0');
    assert.ok(lock.port > 0 && lock.port !== 4391 && lock.port !== 4310, `Unexpected lock.port=${lock.port}`);
    await waitFor(() => dashOut.includes(`http://127.0.0.1:${lock.port}`), 3000, 40, `cockpit startup banner on ${lock.port}`);
    assert.ok(!dashOut.includes(':4310'), `Cockpit must NOT print hardcoded :4310 when configured port=0. Got:\n${dashOut}`);

    dashChild.kill();
    await waitFor(() => dashChild.exitCode !== null, 3000, 30, 'cockpit shutdown').catch(() => {});

    // 3. Orchestrator empty queue banner prints configured port (DASHBOARD_PORT override + policy.local port 0, never hardcoded 4310)
    const orchOutRes = await runProcessWait(
      ORCHESTRATOR_SCRIPT,
      ['run'],
      { ...dashEnv, DASHBOARD_PORT: String(lock.port) },
      6000
    );
    assert.strictEqual(orchOutRes.code, 0);
    assert.ok(orchOutRes.stdout.includes(`127.0.0.1:${lock.port}`), `Orchestrator must print configured URL 127.0.0.1:${lock.port}. Got:\n${orchOutRes.stdout}`);
    assert.ok(!orchOutRes.stdout.includes(':4310'), `Orchestrator must not print hardcoded :4310 when configured ${lock.port}`);
    console.log('✓ Cockpit & Orchestrator configured ephemeral port behavior verified.');

    // 4. ensureOrchestratorRunning NEVER auto-launches a second runner under concurrent calls or active liveStatus
    console.log('3. Testing ensureOrchestratorRunning prevents second runner launch...');
    const routesTasks = await import('./server/routes-tasks.mjs');
    assert.strictEqual(typeof routesTasks.ensureOrchestratorRunning, 'function', 'routes-tasks.mjs must export ensureOrchestratorRunning');

    const launchLogPath = path.join(fx.root, 'runner-launches.log');
    const fakeRunnerScript = path.join(fx.root, 'fake-runner.mjs');
    fs.writeFileSync(fakeRunnerScript, [
      `import fs from 'node:fs';`,
      `fs.appendFileSync(${JSON.stringify(launchLogPath)}, String(process.pid) + '\\n', 'utf8');`,
      `setTimeout(() => process.exit(0), 1200);`
    ].join('\n'), 'utf8');

    const isolatedLock = path.join(fx.root, '.runner-guard.lock');
    const isolatedLive = path.join(fx.root, 'runner-live-status.json');

    // Concurrent calls BEFORE fake runner writes any lock file: must launch at most 1 runner!
    const launch1 = routesTasks.ensureOrchestratorRunning({
      lockFile: isolatedLock,
      liveStatusFile: isolatedLive,
      orchestratorScript: fakeRunnerScript,
      teamDir: fx.root
    });
    const launch2 = routesTasks.ensureOrchestratorRunning({
      lockFile: isolatedLock,
      liveStatusFile: isolatedLive,
      orchestratorScript: fakeRunnerScript,
      teamDir: fx.root
    });
    assert.strictEqual(launch1.alreadyRunning, false, 'First launch should start runner #1');
    assert.strictEqual(launch2.alreadyRunning, true, 'Second concurrent call must NOT start runner #2');
    assert.strictEqual(launch2.pid, launch1.pid, 'Second call must report existing runner #1 PID');

    await waitFor(() => fs.existsSync(launchLogPath), 4000, 40, 'fake runner startup log');
    await sleep(300);
    const launchedPids = fs.readFileSync(launchLogPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    assert.strictEqual(launchedPids.length, 1, `Expected exactly 1 spawned runner, got ${launchedPids.length}: ${launchedPids}`);

    // Even after boot window clears, active liveStatus PID (even if lock file is missing) blocks spawning runner #2
    const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 2500);'], { stdio: 'ignore' });
    bgChildren.push(sleeper);
    const liveGuardLock = path.join(fx.root, '.live-guard.lock');
    const liveGuardFile = path.join(fx.root, 'live-guard.json');
    fs.writeFileSync(liveGuardFile, JSON.stringify({ active: true, pid: sleeper.pid }), 'utf8');
    const launch3 = routesTasks.ensureOrchestratorRunning({
      lockFile: liveGuardLock,
      liveStatusFile: liveGuardFile,
      orchestratorScript: fakeRunnerScript,
      teamDir: fx.root
    });
    assert.strictEqual(launch3.alreadyRunning, true, 'Live active runner in live-status must block launching runner #2');
    assert.strictEqual(launch3.pid, sleeper.pid);
    sleeper.kill();
    console.log('✓ No-second-runner auto-launch guard verified.');

    console.log('\n=================================================');
    console.log('ALL COCKPIT CONFIG & NO-2ND-RUNNER TESTS PASSED!');
    console.log('=================================================');
  } finally {
    for (const c of bgChildren) {
      if (c.exitCode === null) {
        try { c.kill(); } catch {}
      }
    }
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
}

runTests().catch(err => {
  console.error('Cockpit config / no-2nd-runner test failed:', err);
  process.exit(1);
});
