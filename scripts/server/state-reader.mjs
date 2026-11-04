import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { DASHBOARD_CSRF_TOKEN } from './security.mjs';

export function isProcessAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function loadYamlSafe(filePath) {
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

export async function get9RouterHealth() {
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

export function readLatestRunOutput(targetTaskId, targetLogPath, runsDir, teamDir) {
  let chosenPath = targetLogPath && fs.existsSync(targetLogPath) ? targetLogPath : null;

  if (!chosenPath && fs.existsSync(runsDir)) {
    try {
      let taskDirs = [];
      if (targetTaskId && fs.existsSync(path.resolve(runsDir, targetTaskId))) {
        taskDirs = [path.resolve(runsDir, targetTaskId)];
      } else {
        taskDirs = fs.readdirSync(runsDir)
          .map(d => path.resolve(runsDir, d))
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
      file_path: path.relative(teamDir, chosenPath).replace(/\\/g, '/'),
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

export function scanSessions(sessionsDir) {
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

export function readSessionDetails(sessionId, sessionsDir) {
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

export function scanTaskDir(dirPath) {
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

export async function createSnapshot(paths = {}) {
  const configDir = paths.CONFIG_DIR || path.resolve('agent-team/config');
  const lockFile = paths.LOCK_FILE || path.resolve('agent-team/.orchestrator.lock');
  const liveStatusFile = paths.LIVE_STATUS_FILE || path.resolve('agent-team/state/live-status.json');
  const taskStateFile = paths.TASK_STATE_FILE || path.resolve('agent-team/state/task-state.json');
  const tasksActiveDir = paths.TASKS_ACTIVE_DIR || path.resolve('agent-team/tasks/active');
  const tasksArchiveDir = paths.TASKS_ARCHIVE_DIR || path.resolve('agent-team/tasks/archive');
  const runsDir = paths.RUNS_DIR || path.resolve('agent-team/state/runs');
  const sessionsDir = paths.SESSIONS_DIR || path.resolve('agent-team/state/sessions');
  const teamDir = paths.TEAM_DIR || path.resolve('agent-team');

  // 1. Team & Project & Policy
  const teamYaml = loadYamlSafe(path.resolve(configDir, 'team.local.yaml'))
    || loadYamlSafe(path.resolve(configDir, 'team.yaml'))
    || {};
  const roles = teamYaml.roles || {};

  const policyYaml = loadYamlSafe(path.resolve(configDir, 'policy.yaml')) || {};
  const project = {
    id: 'tool-download-workspace',
    allowed_dirs: ['*']
  };
  const policy = {
    task_modes: policyYaml.policy?.task_modes || {},
    approval_gates: policyYaml.policy?.approval_gates || {}
  };

  // 2. Orchestrator Process & Lock
  let orchestratorRunning = false;
  let orchestratorLock = null;
  if (fs.existsSync(lockFile)) {
    try {
      const lockData = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
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

  if (fs.existsSync(liveStatusFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(liveStatusFile, 'utf8'));
      liveStatus = { ...liveStatus, ...parsed };
    } catch {}
  }

  if (!orchestratorRunning && liveStatus.active) {
    liveStatus.active = false;
    liveStatus.current_stage = 'idle';
  }

  // 4. Deduplicated Task Lists
  const activeMap = scanTaskDir(tasksActiveDir);
  const archiveMap = scanTaskDir(tasksArchiveDir);

  let taskState = { active_tasks: [], completed_tasks: [], blocked_tasks: [], metrics: {} };
  if (fs.existsSync(taskStateFile)) {
    try {
      taskState = JSON.parse(fs.readFileSync(taskStateFile, 'utf8'));
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
  const latestOutput = readLatestRunOutput(liveStatus.current_task_id, liveStatus.raw_log_path, runsDir, teamDir);

  // 6. Last Completed Task Summary
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
    sessions: scanSessions(sessionsDir).slice(0, 15)
  };
}
