import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { hashString } from '../validator.mjs';

export function isProcessAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function acquireLock(lockFilePath) {
  if (fs.existsSync(lockFilePath)) {
    try {
      const lockData = JSON.parse(fs.readFileSync(lockFilePath, 'utf8'));
      if (lockData.pid && isProcessAlive(lockData.pid)) {
        console.warn(`[Orchestrator] Active lock file exists (PID: ${lockData.pid}, Started: ${lockData.started_at}).`);
        return false;
      }
      console.warn(`[Orchestrator] Reclaiming stale lock file from dead PID: ${lockData.pid}`);
    } catch {
      // Corrupt lock file, overwrite
    }
  }
  fs.writeFileSync(lockFilePath, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), 'utf8');
  return true;
}

export function releaseLock(lockFilePath) {
  if (fs.existsSync(lockFilePath)) {
    try {
      fs.unlinkSync(lockFilePath);
    } catch {}
  }
}

export function sanitizeTaskState(state = {}) {
  const completedMap = new Map();
  for (const t of (state.completed_tasks || [])) {
    const id = t?.task_id || t?.id;
    if (id) completedMap.set(id, t);
  }
  const completed = Array.from(completedMap.values());
  const completedIds = new Set(completedMap.keys());

  const blockedMap = new Map();
  for (const t of (state.blocked_tasks || [])) {
    const id = t?.task_id || t?.id;
    if (id && !completedIds.has(id)) {
      blockedMap.set(id, t);
    }
  }
  const blocked = Array.from(blockedMap.values());

  return {
    ...state,
    version: state.version || '2.1',
    active_tasks: Array.isArray(state.active_tasks) ? state.active_tasks : [],
    completed_tasks: completed,
    blocked_tasks: blocked,
    metrics: state.metrics || { total_input_tokens: 0, total_output_tokens: 0, total_cost_est_usd: 0 }
  };
}

/**
 * Unifies flat schema (task_id) and nested legacy format (task.id) into a canonical task object.
 */
export function normalizeTask(parsed, defaultProjectId = 'my-workspace') {
  if (!parsed || typeof parsed !== 'object') return null;
  const raw = (parsed.task && typeof parsed.task === 'object') ? { ...parsed.task } : { ...parsed };
  const canonicalId = raw.task_id || raw.id;
  if (!canonicalId || typeof canonicalId !== 'string') return null;

  raw.task_id = canonicalId.trim();
  raw.id = raw.task_id;
  raw.project_id = raw.project_id || defaultProjectId;
  raw.status = raw.status || 'ready';
  raw.owner = raw.owner || 'writer';
  raw.retries = typeof raw.retries === 'number' ? raw.retries : 0;
  raw.error_history = Array.isArray(raw.error_history) ? raw.error_history : [];
  raw.scope_expansions = Array.isArray(raw.scope_expansions) ? raw.scope_expansions : [];
  raw.created_at = raw.created_at || new Date().toISOString();
  raw.updated_at = new Date().toISOString();
  return raw;
}

export function saveTaskAtomic(taskPath, taskData) {
  const tmpPath = `${taskPath}.tmp.${Date.now()}`;
  fs.mkdirSync(path.dirname(taskPath), { recursive: true });
  taskData.updated_at = new Date().toISOString();
  const yamlContent = YAML.stringify(taskData);
  fs.writeFileSync(tmpPath, yamlContent, 'utf8');
  fs.renameSync(tmpPath, taskPath);
}

export function saveStateAtomic(stateFilePath, state) {
  const cleanState = sanitizeTaskState(state);
  state.completed_tasks = cleanState.completed_tasks;
  state.blocked_tasks = cleanState.blocked_tasks;
  const tmpPath = `${stateFilePath}.tmp.${Date.now()}`;
  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(cleanState, null, 2), 'utf8');
  fs.renameSync(tmpPath, stateFilePath);
}

export function saveWriterRawOutput(taskId, attemptNum, writerRes = {}, teamDir = path.resolve('agent-team')) {
  try {
    const safeId = String(taskId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
    const runDir = path.resolve(teamDir, 'state', 'runs', safeId);
    fs.mkdirSync(runDir, { recursive: true });
    const outPath = path.resolve(runDir, `attempt-${attemptNum}.txt`);
    const header = [
      `=== WRITER ATTEMPT ${attemptNum} ===`,
      `Timestamp: ${new Date().toISOString()}`,
      `Model Requested: ${writerRes.modelUsed || 'unknown'}`,
      `Model Responded: ${writerRes.responseModel || 'unknown'}`,
      `Finish Reason: ${writerRes.finishReason || 'unknown'}`,
      `Prompt Tokens: ${writerRes.usage?.prompt_tokens || 0}`,
      `Completion Tokens: ${writerRes.usage?.completion_tokens || 0}`,
      `====================================\n`
    ].join('\n');
    const body = [
      header,
      `--- MESSAGE CONTENT ---\n${writerRes.rawContent ?? writerRes.content ?? ''}\n`,
      writerRes.rawReasoning ? `\n--- REASONING CONTENT ---\n${writerRes.rawReasoning}\n` : ''
    ].join('\n');
    fs.writeFileSync(outPath, body, 'utf8');
    return outPath;
  } catch {
    return null;
  }
}

export function computeScopeHash(scope = []) {
  const sorted = [...scope].map(s => s.trim().replace(/\\/g, '/')).sort().join('\n');
  return hashString(sorted);
}
