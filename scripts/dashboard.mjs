#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DASHBOARD_CSRF_TOKEN } from './server/security.mjs';
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

const PORT = parseInt(process.env.DASHBOARD_PORT || '4310', 10);
const HOST = '127.0.0.1';

const UI_FILE = path.resolve(TEAM_DIR, 'ui', 'index.html');
const UI_DIR = path.resolve(TEAM_DIR, 'ui');
const CONFIG_DIR = path.resolve(TEAM_DIR, 'config');
const TEAM_CONFIG_FILE = path.resolve(CONFIG_DIR, 'team.yaml');
const POLICY_CONFIG_FILE = path.resolve(CONFIG_DIR, 'policy.yaml');
const REPO_ROOT = path.resolve(TEAM_DIR, '..');
const STATE_DIR = path.resolve(TEAM_DIR, 'state');
const TASKS_ACTIVE_DIR = path.resolve(TEAM_DIR, 'tasks', 'active');
const TASKS_ARCHIVE_DIR = path.resolve(TEAM_DIR, 'tasks', 'archive');
const LOCK_FILE = path.resolve(TEAM_DIR, '.orchestrator.lock');
const LIVE_STATUS_FILE = path.resolve(STATE_DIR, 'live-status.json');
const TASK_STATE_FILE = path.resolve(STATE_DIR, 'task-state.json');
const RUNS_DIR = path.resolve(STATE_DIR, 'runs');
const SESSIONS_DIR = path.resolve(STATE_DIR, 'sessions');

const snapshotPaths = {
  CONFIG_DIR,
  LOCK_FILE,
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

export function startServer(port = PORT, host = HOST) {
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve(server);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  startServer(PORT, HOST).then(() => {
    console.log(`\n=================================================`);
    console.log(`🚀 AGENT-TEAM INTERACTIVE COCKPIT & LIVE MONITOR`);
    console.log(`📡 URL: http://${HOST}:${PORT}`);
    console.log(`🛡️  CSRF Protection: ENABLED (Zero-Trust)`);
    console.log(`🛑 Press Ctrl+C to stop`);
    console.log(`=================================================\n`);
  });
}
