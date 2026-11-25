#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DASHBOARD_CSRF_TOKEN } from './server/security.mjs';
import { resolveRepoRoot } from './applier.mjs';
import {
  acquireSingleInstanceLock,
  releaseSingleInstanceLock,
  runForceUnlockCli,
  updateSingleInstanceLockPort
} from './lib/runtime-lock.mjs';
import { resolveCockpitConfig, resolveConfigDir } from './lib/policy-loader.mjs';
import {
  isProcessAlive,
  createSnapshot as createSnapshotBase
} from './server/state-reader.mjs';
import {
  renderIndexHtml as renderIndexHtmlBase,
  handleStaticRequest
} from './server/static-server.mjs';
import { handleModelsRoutes } from './server/routes-models.mjs';
import { handleTasksRoutes } from './server/routes-tasks.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');

const CONFIG_DIR = resolveConfigDir();
const COCKPIT_CONFIG = resolveCockpitConfig({ configDir: CONFIG_DIR });
const PORT = COCKPIT_CONFIG.port;
const HOST = COCKPIT_CONFIG.host;

const UI_FILE = path.resolve(TEAM_DIR, 'ui', 'index.html');
const UI_DIR = path.resolve(TEAM_DIR, 'ui');
const TEAM_CONFIG_FILE = path.resolve(CONFIG_DIR, 'team.yaml');
const POLICY_CONFIG_FILE = path.resolve(CONFIG_DIR, 'policy.yaml');
const REPO_ROOT = resolveRepoRoot(null, { configDir: CONFIG_DIR, teamDir: TEAM_DIR });
const STATE_DIR = process.env.AGENT_TEAM_STATE_DIR
  ? path.resolve(process.env.AGENT_TEAM_STATE_DIR)
  : path.resolve(TEAM_DIR, 'state');
const TASKS_DIR = process.env.AGENT_TEAM_TASKS_DIR
  ? path.resolve(process.env.AGENT_TEAM_TASKS_DIR)
  : path.resolve(TEAM_DIR, 'tasks');
const TASKS_ACTIVE_DIR = path.resolve(TASKS_DIR, 'active');
const TASKS_ARCHIVE_DIR = path.resolve(TASKS_DIR, 'archive');
const LOCK_FILE = process.env.ORCHESTRATOR_LOCK_FILE
  ? path.resolve(process.env.ORCHESTRATOR_LOCK_FILE)
  : path.resolve(TEAM_DIR, '.orchestrator.lock');
const COCKPIT_LOCK_FILE = process.env.COCKPIT_LOCK_FILE
  ? path.resolve(process.env.COCKPIT_LOCK_FILE)
  : path.resolve(TEAM_DIR, '.cockpit.lock');
const LIVE_STATUS_FILE = path.resolve(STATE_DIR, 'live-status.json');
const TASK_STATE_FILE = path.resolve(STATE_DIR, 'task-state.json');
const RUNS_DIR = path.resolve(STATE_DIR, 'runs');
const SESSIONS_DIR = path.resolve(STATE_DIR, 'sessions');

const snapshotPaths = {
  CONFIG_DIR,
  REPO_ROOT,
  LOCK_FILE,
  COCKPIT_LOCK_FILE,
  LIVE_STATUS_FILE,
  TASK_STATE_FILE,
  TASKS_ACTIVE_DIR,
  TASKS_ARCHIVE_DIR,
  RUNS_DIR,
  SESSIONS_DIR,
  TEAM_DIR
};

// Re-exports for test compatibility (test-cockpit.mjs)
export { DASHBOARD_CSRF_TOKEN, isProcessAlive };

export async function createSnapshot() {
  return createSnapshotBase(snapshotPaths);
}

export function renderIndexHtml() {
  return renderIndexHtmlBase(UI_FILE, UI_DIR);
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  // 1. Static Assets & HTML Index
  if (handleStaticRequest(req, res, url, UI_DIR, UI_FILE)) {
    return;
  }

  // 2. Models & Team Config APIs
  const handledModel = await handleModelsRoutes(req, res, url, {
    TEAM_CONFIG_FILE,
    POLICY_CONFIG_FILE,
    REPO_ROOT
  });
  if (handledModel) return;

  // 3. Tasks, Goals & Sessions APIs
  const handledTask = await handleTasksRoutes(req, res, url, {
    SESSIONS_DIR,
    TASKS_ACTIVE_DIR,
    LOCK_FILE,
    TEAM_DIR,
    snapshotPaths
  });
  if (handledTask) return;

  // 4. Fallback 404
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

// Generous timeouts for multi-turn AI reasoning & codebase surveys
server.requestTimeout = 600000; // 10 minutes
server.headersTimeout = 610000;
server.keepAliveTimeout = 65000;

export function startServer(port = PORT, host = HOST) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export async function runCockpit(options = {}) {
  const resolvedCfg = (options.configDir || options.policyConfig)
    ? resolveCockpitConfig({
        configDir: options.configDir || CONFIG_DIR,
        policyConfig: options.policyConfig,
        port: options.port,
        host: options.host
      })
    : COCKPIT_CONFIG;
  const port = options.port ?? resolvedCfg.port;
  const host = options.host ?? resolvedCfg.host;
  const lockFile = options.lockFile ? path.resolve(options.lockFile) : COCKPIT_LOCK_FILE;

  const lockRes = acquireSingleInstanceLock(lockFile, {
    role: 'cockpit',
    port
  });
  if (!lockRes.ok) {
    console.error(lockRes.message);
    process.exit(1);
  }

  const ownedInstanceId = lockRes.lock.instance_id;
  let released = false;
  const cleanupLock = () => {
    if (released) return;
    released = true;
    releaseSingleInstanceLock(lockFile, { instanceId: ownedInstanceId });
  };

  try {
    await startServer(port, host);
  } catch (err) {
    cleanupLock();
    console.error(`[Cockpit] Failed to bind http://${host}:${port} (${err.code || err.message}).`);
    process.exit(1);
  }

  const actualPort = server.address()?.port ?? port;
  if (actualPort !== port) {
    updateSingleInstanceLockPort(lockFile, actualPort, { instanceId: ownedInstanceId });
  }

  const gracefulShutdown = () => {
    try { server.close(); } catch {}
    cleanupLock();
    process.exit(0);
  };

  process.once('exit', cleanupLock);
  process.once('SIGINT', gracefulShutdown);
  process.once('SIGTERM', gracefulShutdown);

  console.log(`\n=================================================`);
  console.log(`🚀 AGENT-TEAM INTERACTIVE COCKPIT & LIVE MONITOR`);
  console.log(`📡 URL: http://${host}:${actualPort}`);
  console.log(`🔒 Lock: ${lockFile} (PID: ${process.pid})`);
  console.log(`🛡️  CSRF Protection: ENABLED (Zero-Trust)`);
  console.log(`🛑 Press Ctrl+C to stop`);
  console.log(`=================================================\n`);
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const cliArgs = process.argv.slice(2);
  if (cliArgs.includes('--force-unlock')) {
    runForceUnlockCli({
      role: 'cockpit',
      lockFilePath: COCKPIT_LOCK_FILE,
      argv: cliArgs
    }).then((res) => process.exit(res.code));
  } else {
    runCockpit();
  }
}
