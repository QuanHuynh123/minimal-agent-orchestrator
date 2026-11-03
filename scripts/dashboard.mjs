#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { decomposeGoal } from './goal-planner.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');

const PORT = parseInt(process.env.DASHBOARD_PORT || '4310', 10);
const HOST = '127.0.0.1';

const UI_FILE = path.resolve(TEAM_DIR, 'ui', 'index.html');
const UI_DIR = path.resolve(TEAM_DIR, 'ui');
const CONFIG_DIR = path.resolve(TEAM_DIR, 'config');
const TEAM_CONFIG_FILE = path.resolve(CONFIG_DIR, 'team.yaml');
const STATE_DIR = path.resolve(TEAM_DIR, 'state');
const TASKS_ACTIVE_DIR = path.resolve(TEAM_DIR, 'tasks', 'active');
const TASKS_ARCHIVE_DIR = path.resolve(TEAM_DIR, 'tasks', 'archive');
const LOCK_FILE = path.resolve(TEAM_DIR, '.orchestrator.lock');
const LIVE_STATUS_FILE = path.resolve(STATE_DIR, 'live-status.json');
const TASK_STATE_FILE = path.resolve(STATE_DIR, 'task-state.json');
const RUNS_DIR = path.resolve(STATE_DIR, 'runs');
const SESSIONS_DIR = path.resolve(STATE_DIR, 'sessions');

// Zero-Trust Localhost CSRF Token generated fresh on dashboard startup
export const DASHBOARD_CSRF_TOKEN = crypto.randomUUID();

function verifyCsrfAndOrigin(req) {
  const origin = req.headers['origin'] || req.headers['referer'] || '';
  if (origin) {
    try {
      const parsedOrigin = new URL(origin);
      if (parsedOrigin.hostname !== '127.0.0.1' && parsedOrigin.hostname !== 'localhost') {
        return { ok: false, status: 403, error: 'Forbidden: Cross-Origin Request Blocked' };
      }
    } catch {
      return { ok: false, status: 403, error: 'Forbidden: Invalid Request Origin' };
    }
  }

  const token = req.headers['x-dashboard-token'];
  if (!token || token !== DASHBOARD_CSRF_TOKEN) {
    return { ok: false, status: 403, error: 'Forbidden: Missing or Invalid X-Dashboard-Token' };
  }

  return { ok: true };
}

function parseJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error(`Payload exceeds maximum limit of ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

export function isProcessAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function loadYamlSafe(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return YAML.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch {}
  return null;
}

let routerHealthCache = {
  checked_at: 0,
  ok: false,
  latency_ms: 0,
  model_count: 0,
  error: null
};
let isCheckingHealth = false;

async function get9RouterHealth() {
  const now = Date.now();
  if (now - routerHealthCache.checked_at < 10000) {
    return routerHealthCache;
  }
  if (isCheckingHealth) {
    return routerHealthCache;
  }
  isCheckingHealth = true;
  const start = Date.now();
  try {
    const res = await fetch('http://127.0.0.1:20128/v1/models', {
      method: 'GET',
      headers: { Authorization: 'Bearer sk-default' },
      signal: AbortSignal.timeout(1500)
    });
    const latency = Date.now() - start;
    if (res.ok) {
      const data = await res.json().catch(() => ({ data: [] }));
      routerHealthCache = {
        checked_at: now,
        ok: true,
        latency_ms: latency,
        model_count: Array.isArray(data.data) ? data.data.length : 0,
        error: null
      };
    } else {
      routerHealthCache = {
        checked_at: now,
        ok: false,
        latency_ms: latency,
        model_count: 0,
        error: `HTTP ${res.status}`
      };
    }
  } catch (err) {
    routerHealthCache = {
      checked_at: now,
      ok: false,
      latency_ms: Date.now() - start,
      model_count: 0,
      error: err.name === 'TimeoutError' ? 'Timeout (1.5s)' : err.message
    };
  } finally {
    isCheckingHealth = false;
  }
  return routerHealthCache;
}

function readLatestRunOutput(targetTaskId, targetLogPath) {
  let chosenPath = targetLogPath && fs.existsSync(targetLogPath) ? targetLogPath : null;

  if (!chosenPath && fs.existsSync(RUNS_DIR)) {
    try {
      let taskDirs = [];
      if (targetTaskId && fs.existsSync(path.resolve(RUNS_DIR, targetTaskId))) {
        taskDirs = [path.resolve(RUNS_DIR, targetTaskId)];
      } else {
        taskDirs = fs.readdirSync(RUNS_DIR)
          .map(d => path.resolve(RUNS_DIR, d))
          .filter(d => {
            try { return fs.statSync(d).isDirectory(); } catch { return false; }
          })
          .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      }

      if (taskDirs.length > 0) {
        const latestTaskDir = taskDirs[0];
        const attemptFiles = fs.readdirSync(latestTaskDir)
          .filter(f => f.startsWith('attempt-') && f.endsWith('.txt'))
          .map(f => path.resolve(latestTaskDir, f))
          .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

        if (attemptFiles.length > 0) {
          chosenPath = attemptFiles[0];
        }
      }
    } catch {}
  }

  if (!chosenPath || !fs.existsSync(chosenPath)) {
    return {
      file_path: null,
      attempt_number: null,
      timestamp: null,
      content: '(No writer output recorded yet)',
      model_requested: 'N/A',
      model_responded: 'N/A',
      model_used: 'N/A',
      finish_reason: 'N/A',
      prompt_tokens: null,
      completion_tokens: null,
      search_block_count: 0,
      target_files: [],
      file_size_bytes: 0,
      truncated: false
    };
  }

  try {
    const stat = fs.statSync(chosenPath);
    const MAX_OUTPUT_BYTES = 16384;
    let content = '';
    let truncated = false;

    if (stat.size <= MAX_OUTPUT_BYTES) {
      content = fs.readFileSync(chosenPath, 'utf8');
    } else {
      truncated = true;
      const fd = fs.openSync(chosenPath, 'r');
      const buf = Buffer.alloc(MAX_OUTPUT_BYTES);
      fs.readSync(fd, buf, 0, MAX_OUTPUT_BYTES, stat.size - MAX_OUTPUT_BYTES);
      fs.closeSync(fd);
      content = `[... Truncated earlier output. Showing last 16 KB of ${Math.round(stat.size / 1024)} KB ...]\n` + buf.toString('utf8');
    }

    const attemptMatch = content.match(/===\s*WRITER ATTEMPT\s+(\d+)\s*===/i);
    const tsMatch = content.match(/Timestamp:\s*([^\r\n]+)/);
    const modelReqMatch = content.match(/Model (?:Requested|Used):\s*([^\r\n]+)/);
    const modelRespMatch = content.match(/Model Responded:\s*([^\r\n]+)/);
    const finishMatch = content.match(/Finish Reason:\s*([^\r\n]+)/);
    const promptTokMatch = content.match(/Prompt Tokens:\s*(\d+)/);
    const compTokMatch = content.match(/Completion Tokens:\s*(\d+)/);

    const attemptNumber = attemptMatch ? parseInt(attemptMatch[1], 10) : null;
    const outputTimestamp = tsMatch ? tsMatch[1].trim() : null;
    const modelRequested = modelReqMatch ? modelReqMatch[1].trim() : 'unknown';
    const modelResponded = modelRespMatch ? modelRespMatch[1].trim() : 'N/A';
    const finishReason = finishMatch ? finishMatch[1].trim() : 'N/A';
    const promptTokens = promptTokMatch ? parseInt(promptTokMatch[1], 10) : null;
    const completionTokens = compTokMatch ? parseInt(compTokMatch[1], 10) : null;

    const searchBlockMatches = content.match(/^<<<<<<< SEARCH/gm);
    const searchBlockCount = searchBlockMatches ? searchBlockMatches.length : 0;

    const fileHeaderRegex = /^(?:###\s*)?FILE:\s*([^\r\n]+)/gm;
    const targetFilesSet = new Set();
    let fm;
    while ((fm = fileHeaderRegex.exec(content)) !== null) {
      const p = fm[1].trim();
      if (p) targetFilesSet.add(p);
    }

    return {
      file_path: path.relative(TEAM_DIR, chosenPath).replace(/\\/g, '/'),
      attempt_number: attemptNumber,
      timestamp: outputTimestamp,
      content,
      model_requested: modelRequested,
      model_responded: modelResponded,
      model_used: modelResponded !== 'N/A' ? modelResponded : modelRequested,
      finish_reason: finishReason,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      search_block_count: searchBlockCount,
      target_files: Array.from(targetFilesSet),
      file_size_bytes: stat.size,
      truncated
    };
  } catch {
    return {
      file_path: chosenPath,
      attempt_number: null,
      timestamp: null,
      content: '(Error reading output file)',
      model_requested: 'N/A',
      model_responded: 'N/A',
      model_used: 'N/A',
      finish_reason: 'N/A',
      prompt_tokens: null,
      completion_tokens: null,
      search_block_count: 0,
      target_files: [],
      file_size_bytes: 0,
      truncated: false
    };
  }
}

function scanSessions(sessionsDir = SESSIONS_DIR) {
  if (!fs.existsSync(sessionsDir)) return [];
  try {
    const files = fs.readdirSync(sessionsDir)
      .filter(f => f.endsWith('.json'))
      .map(f => path.resolve(sessionsDir, f));

    return files.map(filePath => {
      try {
        const stat = fs.statSync(filePath);
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const msgs = Array.isArray(raw.messages) ? raw.messages : [];
        const receipts = Array.isArray(raw.tool_receipts) ? raw.tool_receipts : [];
        return {
          session_id: raw.session_id || path.basename(filePath, '.json'),
          role: raw.role || 'unknown',
          model: raw.model || 'unknown',
          message_count: msgs.length,
          tool_receipts_count: receipts.length,
          latest_receipt: receipts.length > 0 ? receipts[receipts.length - 1] : null,
          created_at: raw.timestamps?.created_at || stat.birthtime?.toISOString() || null,
          updated_at: raw.timestamps?.updated_at || stat.mtime?.toISOString() || null,
          file_size_bytes: stat.size
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
  } catch {
    return [];
  }
}

function readSessionDetails(sessionId, sessionsDir = SESSIONS_DIR) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  const safeId = sessionId.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  const sessionPath = path.resolve(sessionsDir, `${safeId}.json`);
  if (!fs.existsSync(sessionPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  } catch {
    return null;
  }
}

function scanTaskDir(dirPath) {
  const result = new Map();
  if (!fs.existsSync(dirPath)) return result;
  try {
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
    for (const f of files) {
      const full = path.resolve(dirPath, f);
      const parsed = loadYamlSafe(full);
      if (!parsed) continue;
      const raw = (parsed.task && typeof parsed.task === 'object') ? parsed.task : parsed;
      const tid = raw.task_id || raw.id;
      if (!tid) continue;
      result.set(tid, {
        task_id: tid,
        title: raw.title || raw.goal || 'Untitled Task',
        mode: raw.mode || 'quick',
        status: raw.status || 'ready',
        risk_level: raw.risk_level || 'low',
        scope: Array.isArray(raw.scope) ? raw.scope : [],
        retries: raw.retries || 0,
        commit_hash: raw.commit_hash || null,
        created_at: raw.created_at || null,
        updated_at: raw.updated_at || null
      });
    }
  } catch {}
  return result;
}

export async function createSnapshot() {
  // 1. Team & Project & Policy (Cleanly scrub teamConfig.providers to prevent any secret exposure)
  const teamYaml = loadYamlSafe(path.resolve(CONFIG_DIR, 'team.local.yaml'))
    || loadYamlSafe(path.resolve(CONFIG_DIR, 'team.yaml'))
    || {};
  const roles = teamYaml.roles || {};

  const projectYaml = loadYamlSafe(path.resolve(CONFIG_DIR, 'project.local.yaml'))
    || loadYamlSafe(path.resolve(CONFIG_DIR, 'project.yaml'))
    || {};
  const project = {
    id: projectYaml.project?.id || 'my-workspace',
    allowed_dirs: projectYaml.project?.allowed_dirs || []
  };

  const policyYaml = loadYamlSafe(path.resolve(CONFIG_DIR, 'policy.yaml')) || {};
  const policy = {
    task_modes: policyYaml.policy?.task_modes || {},
    approval_gates: policyYaml.policy?.approval_gates || {}
  };

  // 2. Orchestrator Process & Lock
  let orchestratorRunning = false;
  let orchestratorLock = null;
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      if (lockData.pid && isProcessAlive(lockData.pid)) {
        orchestratorRunning = true;
        orchestratorLock = {
          pid: lockData.pid,
          started_at: lockData.started_at
        };
      }
    } catch {}
  }

  // 3. Live Status Telemetry
  let liveStatus = {
    active: orchestratorRunning,
    pid: orchestratorLock?.pid || null,
    current_task_id: null,
    current_task_title: '',
    current_stage: 'idle',
    stage_started_at: null,
    task_started_at: null,
    mode: null,
    risk_level: null,
    attempt: 0,
    max_retries: 3,
    scope_files: [],
    roles_status: {},
    queue_stats: { active: 0, completed: 0, blocked: 0 },
    last_error: null,
    raw_log_path: null,
    tokens: { task_input: 0, task_output: 0, session_input: 0, session_output: 0 },
    recent_logs: [],
    updated_at: null
  };

  if (fs.existsSync(LIVE_STATUS_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(LIVE_STATUS_FILE, 'utf8'));
      liveStatus = { ...liveStatus, ...parsed };
    } catch {}
  }

  // Synchronize orchestrator active state with process lock
  if (!orchestratorRunning && liveStatus.active) {
    liveStatus.active = false;
    liveStatus.current_stage = 'idle';
  }

  // 4. Deduplicated Task Lists
  const activeMap = scanTaskDir(TASKS_ACTIVE_DIR);
  const archiveMap = scanTaskDir(TASKS_ARCHIVE_DIR);

  // State file check for blocked / completed tasks
  let taskState = { active_tasks: [], completed_tasks: [], blocked_tasks: [], metrics: {} };
  if (fs.existsSync(TASK_STATE_FILE)) {
    try {
      taskState = JSON.parse(fs.readFileSync(TASK_STATE_FILE, 'utf8'));
    } catch {}
  }

  const completedMap = new Map(archiveMap);
  for (const t of (taskState.completed_tasks || [])) {
    const tid = t.task_id || t.id;
    if (tid && !completedMap.has(tid)) {
      completedMap.set(tid, {
        task_id: tid,
        title: t.title || t.goal || '',
        mode: t.mode || 'quick',
        status: 'done',
        retries: t.retries || 0,
        commit_hash: t.commit_hash || null,
        completed_at: t.completed_at || null
      });
    }
  }

  const blockedMap = new Map();
  for (const [tid, t] of activeMap) {
    if (t.status === 'blocked' && !completedMap.has(tid)) {
      blockedMap.set(tid, t);
    }
  }
  for (const t of (taskState.blocked_tasks || [])) {
    const tid = t.task_id || t.id;
    if (tid && !blockedMap.has(tid) && !completedMap.has(tid)) {
      blockedMap.set(tid, {
        task_id: tid,
        title: t.title || t.goal || '',
        mode: t.mode || 'quick',
        status: 'blocked',
        risk_level: t.risk_level || 'low',
        block_reason: t.block_reason || t.last_error || 'Blocked'
      });
    }
  }

  // Reconcile liveStatus when the task has already finished
  if (!liveStatus.active && liveStatus.current_task_id && completedMap.has(liveStatus.current_task_id)) {
    const doneTask = completedMap.get(liveStatus.current_task_id);
    liveStatus.task_final_status = 'done';
    liveStatus.task_completed_at = liveStatus.task_completed_at || doneTask.completed_at || liveStatus.updated_at || null;
    liveStatus.recovered_on_retry = (liveStatus.attempt || 1) > 1 || (doneTask.retries || 0) > 0;
    liveStatus.last_error = null;
  } else if (!liveStatus.active && liveStatus.current_task_id && blockedMap.has(liveStatus.current_task_id)) {
    liveStatus.task_final_status = 'blocked';
    liveStatus.task_completed_at = liveStatus.task_completed_at || liveStatus.updated_at || null;
  }

  const activeList = Array.from(activeMap.values()).filter(t => t.status !== 'blocked');
  const blockedList = Array.from(blockedMap.values());
  const completedList = Array.from(completedMap.values());

  // 5. Latest Writer Output File
  const latestOutput = readLatestRunOutput(liveStatus.current_task_id, liveStatus.raw_log_path);

  // 6. Last Completed Task Summary (For Idle Context Preservation)
  const lastCompletedTask = completedList.length > 0 ? completedList[completedList.length - 1] : null;

  // 7. 9Router Health Check
  const routerHealth = await get9RouterHealth();

  return {
    timestamp: new Date().toISOString(),
    csrf_token: DASHBOARD_CSRF_TOKEN,
    project,
    orchestrator: {
      running: orchestratorRunning,
      pid: orchestratorLock?.pid || null,
      started_at: orchestratorLock?.started_at || null
    },
    router_health: routerHealth,
    roles,
    policy,
    live_status: liveStatus,
    last_completed_task: lastCompletedTask,
    queue: {
      active_count: activeList.length,
      completed_count: completedList.length,
      blocked_count: blockedList.length,
      active: activeList,
      recent_completed: completedList.slice(-5).reverse(),
      blocked: blockedList
    },
    latest_output: latestOutput,
    sessions: scanSessions(SESSIONS_DIR).slice(0, 15)
  };
}

export function renderIndexHtml() {
  if (!fs.existsSync(UI_FILE)) return null;
  const raw = fs.readFileSync(UI_FILE, 'utf8');
  return raw.replace(/<!--\s*@include\s+([a-zA-Z0-9_\-\.\/]+)\s*-->/g, (match, relPath) => {
    const target = path.resolve(UI_DIR, relPath);
    if (target.startsWith(UI_DIR) && fs.existsSync(target)) {
      try {
        return fs.readFileSync(target, 'utf8');
      } catch (e) {
        return `<!-- Include Error: ${e.message} -->`;
      }
    }
    return match;
  });
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const rendered = renderIndexHtml();
    if (!rendered) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('UI index.html not found. Please ensure agent-team/ui/index.html is created.');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache'
    });
    res.end(rendered);
    return;
  }

  // Serve static assets in ui/ (css, js, svg, png)
  if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
    const safeRel = path.normalize(url.pathname).replace(/^(\.\.[\/\\])+/, '').replace(/^[/\\]+/, '');
    const targetFile = path.resolve(UI_DIR, safeRel);
    if (targetFile.startsWith(UI_DIR) && fs.existsSync(targetFile) && fs.statSync(targetFile).isFile()) {
      const ext = path.extname(targetFile).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.mjs': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.png': 'image/png'
      };
      res.writeHead(200, {
        'Content-Type': mimeTypes[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache'
      });
      fs.createReadStream(targetFile).pipe(res);
      return;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/models') {
    try {
      const start = Date.now();
      let models = [];
      let source = '9router';
      try {
        const res = await fetch('http://127.0.0.1:20128/v1/models', {
          method: 'GET',
          headers: { Authorization: 'Bearer sk-default' },
          signal: AbortSignal.timeout(3000)
        });
        if (res.ok) {
          const raw = await res.json();
          if (Array.isArray(raw.data)) {
            models = raw.data.map(m => {
              const caps = m.capabilities || {};
              return {
                id: m.id,
                name: m.id.split('/').pop() || m.id,
                owned_by: m.owned_by || '',
                capabilities: {
                  vision: Boolean(caps.vision),
                  tools: Boolean(caps.tools),
                  reasoning: Boolean(caps.reasoning || caps.thinking || caps.thinkingFormat)
                }
              };
            });
          }
        }
      } catch (fetchErr) {
        source = 'fallback_team_yaml';
      }

      // Fallback if 9router is not reachable or returned 0 models
      if (models.length === 0) {
        const teamData = loadYamlSafe(TEAM_CONFIG_FILE);
        const roles = teamData?.roles || {};
        const fallbackSet = new Set();
        for (const r of Object.values(roles)) {
          if (r?.model) fallbackSet.add(r.model);
        }
        fallbackSet.add('kr/claude-sonnet-4.5-thinking');
        fallbackSet.add('Deepseek V4.1 Flash/deepseek-ai/deepseek-v4.1-flash-1017');
        fallbackSet.add('ag/claude-opus-5-5-high');
        fallbackSet.add('ag/gemini-3.6-flash-low');

        models = Array.from(fallbackSet).map(id => ({
          id,
          name: id.split('/').pop() || id,
          owned_by: id.startsWith('kr/') ? 'kr' : (id.startsWith('ag/') ? 'ag' : 'local'),
          capabilities: {
            vision: id.includes('gemini') || id.includes('claude'),
            tools: true,
            reasoning: id.includes('thinking') || id.includes('opus') || id.includes('sonnet')
          }
        }));
      }

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({
        ok: true,
        source,
        latency_ms: Date.now() - start,
        count: models.length,
        models
      }));
    } catch (err) {
      res.writeHead(500, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/snapshot') {
    try {
      const snapshot = await createSnapshot();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify(snapshot));
    } catch (err) {
      res.writeHead(500, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    try {
      const sessions = scanSessions(SESSIONS_DIR);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ ok: true, count: sessions.length, sessions }));
    } catch (err) {
      res.writeHead(500, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/session') {
    try {
      const sessionId = url.searchParams.get('id');
      const details = readSessionDetails(sessionId, SESSIONS_DIR);
      if (!details) {
        res.writeHead(404, {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ ok: false, error: 'Session not found' }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ ok: true, session: details }));
    } catch (err) {
      res.writeHead(500, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // -----------------------------------------------------------
  // INTERACTIVE COCKPIT POST ENDPOINTS (Guarded with CSRF & Origin)
  // -----------------------------------------------------------

  if (req.method === 'POST' && url.pathname === '/api/decompose') {
    const auth = verifyCsrfAndOrigin(req);
    if (!auth.ok) {
      res.writeHead(auth.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: auth.error }));
      return;
    }

    try {
      const body = await parseJsonBody(req);
      const goal = String(body.goal || '').trim();
      if (!goal) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Goal cannot be empty' }));
        return;
      }

      console.log(`[Dashboard API] Decomposing goal with Router Agent: "${goal}"...`);
      const decompRes = await decomposeGoal(goal, { dryRun: false });
      res.writeHead(decompRes.ok ? 200 : 500, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      res.end(JSON.stringify(decompRes));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/approve-run') {
    const auth = verifyCsrfAndOrigin(req);
    if (!auth.ok) {
      res.writeHead(auth.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: auth.error }));
      return;
    }

    try {
      const body = await parseJsonBody(req);
      const targetIds = Array.isArray(body.task_ids) ? new Set(body.task_ids) : null;

      // 1. Approve tasks: convert 'draft_review' to 'ready'
      let approvedCount = 0;
      if (fs.existsSync(TASKS_ACTIVE_DIR)) {
        const files = fs.readdirSync(TASKS_ACTIVE_DIR).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
        for (const f of files) {
          const filePath = path.resolve(TASKS_ACTIVE_DIR, f);
          const parsed = loadYamlSafe(filePath);
          if (!parsed) continue;
          const raw = (parsed.task && typeof parsed.task === 'object') ? parsed.task : parsed;
          const tid = raw.task_id || raw.id;
          if (!tid) continue;

          if (raw.status === 'draft_review' && (!targetIds || targetIds.has(tid))) {
            raw.status = 'ready';
            raw.updated_at = new Date().toISOString();
            fs.writeFileSync(filePath, YAML.stringify(parsed), 'utf8');
            approvedCount++;
          }
        }
      }

      // 2. Check if Orchestrator is already running
      const lockData = fs.existsSync(LOCK_FILE) ? loadYamlSafe(LOCK_FILE) : null;
      if (lockData && isProcessAlive(lockData.pid)) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: true,
          approved_count: approvedCount,
          message: 'Tasks approved. Orchestrator is already actively running.'
        }));
        return;
      }

      // 3. Spawn Orchestrator in detached background process
      const orchestratorScript = path.resolve(__dirname, 'orchestrator.mjs');
      const child = spawn(process.execPath, [orchestratorScript, 'run'], {
        cwd: path.resolve(TEAM_DIR, '..'),
        detached: true,
        stdio: 'ignore',
        env: { ...process.env }
      });
      child.unref();

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        approved_count: approvedCount,
        message: `Approved ${approvedCount} task(s) and launched Orchestrator in background.`,
        pid: child.pid
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/stop') {
    const auth = verifyCsrfAndOrigin(req);
    if (!auth.ok) {
      res.writeHead(auth.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: auth.error }));
      return;
    }

    try {
      const lockData = fs.existsSync(LOCK_FILE) ? loadYamlSafe(LOCK_FILE) : null;
      if (!lockData || !isProcessAlive(lockData.pid)) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, message: 'Orchestrator is not running.' }));
        return;
      }

      process.kill(lockData.pid, 'SIGTERM');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, message: `Terminated Orchestrator process (PID: ${lockData.pid})` }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/test-model') {
    const auth = verifyCsrfAndOrigin(req);
    if (!auth.ok) {
      res.writeHead(auth.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: auth.error }));
      return;
    }

    try {
      const body = await parseJsonBody(req);
      const model = String(body.model || '').trim();
      if (!model) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Model identifier cannot be empty' }));
        return;
      }

      const start = Date.now();
      try {
        const pingRes = await fetch('http://127.0.0.1:20128/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer sk-default'
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
            stream: false
          }),
          signal: AbortSignal.timeout(7000)
        });

        const latency = Date.now() - start;
        const resJson = await pingRes.json().catch(() => null);

        if (pingRes.ok && resJson && !resJson.error) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            ok: true,
            latency_ms: latency,
            model,
            status: 'online',
            reply_preview: resJson.choices?.[0]?.message?.content?.slice(0, 50) || 'OK'
          }));
        } else {
          const errMsg = resJson?.error?.message || `HTTP ${pingRes.status}`;
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            ok: false,
            latency_ms: latency,
            model,
            status: 'error',
            error: errMsg
          }));
        }
      } catch (pingErr) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: false,
          latency_ms: Date.now() - start,
          model,
          status: 'error',
          error: pingErr.name === 'TimeoutError' ? 'Timeout (7.0s)' : pingErr.message
        }));
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/save-team-config') {
    const auth = verifyCsrfAndOrigin(req);
    if (!auth.ok) {
      res.writeHead(auth.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: auth.error }));
      return;
    }

    try {
      const body = await parseJsonBody(req);
      const rolesInput = body.roles;
      if (!rolesInput || typeof rolesInput !== 'object') {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid roles object' }));
        return;
      }

      if (!fs.existsSync(TEAM_CONFIG_FILE)) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'team.yaml not found' }));
        return;
      }

      const teamData = loadYamlSafe(TEAM_CONFIG_FILE) || { team: { name: 'hybrid-agent-squad' }, roles: {} };
      if (!teamData.roles) teamData.roles = {};

      let updatedCount = 0;
      for (const [roleKey, roleSpec] of Object.entries(rolesInput)) {
        if (!roleSpec || typeof roleSpec !== 'object') continue;
        const newModel = String(roleSpec.model || '').trim();
        if (!newModel) continue;

        if (teamData.roles[roleKey]) {
          teamData.roles[roleKey].model = newModel;
          if (roleSpec.display_name) {
            teamData.roles[roleKey].display_name = roleSpec.display_name;
          }
        } else {
          teamData.roles[roleKey] = {
            enabled: true,
            provider: 'local_9router',
            display_name: roleSpec.display_name || (roleKey.charAt(0).toUpperCase() + roleKey.slice(1)),
            model: newModel,
            fallback_model: null,
            temperature: 0.1
          };
        }
        updatedCount++;
      }

      fs.writeFileSync(TEAM_CONFIG_FILE, YAML.stringify(teamData), 'utf8');

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        updated_count: updatedCount,
        message: `Đã cập nhật ${updatedCount} vai trò vào config/team.yaml thành công!`
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

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
  startServer().then(() => {
    console.log(`[Dashboard] Orchestrator Live Monitor active on http://${HOST}:${PORT}`);
  });
}
