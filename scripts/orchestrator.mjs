#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import {
  applyEdits,
  checkAllowedDirs,
  checkForbidden,
  computeDeterministicRisk,
  normalizeOrThrow,
  resolveRepoRoot
} from './applier.mjs';
import {
  commitDone,
  getModifiedFiles,
  getScopedDiff,
  isCleanWorktree,
  rollback,
  snapshot
} from './git-guard.mjs';
import { hashString, validateFast, validateSuite } from './validator.mjs';
import { runAgent } from '../runtime/index.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');

const LOCK_FILE = path.resolve(TEAM_DIR, '.orchestrator.lock');
const STATE_FILE = path.resolve(TEAM_DIR, 'state', 'task-state.json');
const REPORT_FILE = path.resolve(TEAM_DIR, 'state', 'morning-report.md');
const LIVE_STATUS_FILE = path.resolve(TEAM_DIR, 'state', 'live-status.json');
const ACTIVE_TASKS_DIR = path.resolve(TEAM_DIR, 'tasks', 'active');
const ARCHIVE_TASKS_DIR = path.resolve(TEAM_DIR, 'tasks', 'archive');

// Telemetry Ring Buffer (Last 100 console messages for Dashboard)
const MAX_RING_BUFFER = 100;
export const consoleRingBuffer = [];

function pushToRingBuffer(level, args) {
  try {
    const msg = args.map(a => (typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a))).join(' ');
    const now = new Date();
    const ts = now.toTimeString().split(' ')[0];
    consoleRingBuffer.push({ ts, level, msg });
    if (consoleRingBuffer.length > MAX_RING_BUFFER) {
      consoleRingBuffer.shift();
    }
  } catch {
    // Non-throwing telemetry
  }
}

const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;

console.log = function(...args) {
  pushToRingBuffer('info', args);
  origLog.apply(console, args);
};
console.warn = function(...args) {
  pushToRingBuffer('warn', args);
  origWarn.apply(console, args);
};
console.error = function(...args) {
  pushToRingBuffer('error', args);
  origError.apply(console, args);
};

export let liveStatus = {
  active: false,
  pid: process.pid,
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
  updated_at: new Date().toISOString()
};

export function updateLiveStatus(patch = {}) {
  try {
    liveStatus = { ...liveStatus, ...patch, updated_at: new Date().toISOString() };
    const payload = {
      ...liveStatus,
      recent_logs: [...consoleRingBuffer]
    };
    const tmpPath = `${LIVE_STATUS_FILE}.tmp.${Date.now()}`;
    fs.mkdirSync(path.dirname(LIVE_STATUS_FILE), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmpPath, LIVE_STATUS_FILE);
  } catch {
    // Non-throwing telemetry: write contention/EPERM must NEVER crash orchestrator
  }
}

// 1. Lock File Management (with Stale PID Recovery)
export function isProcessAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function acquireLock(lockFilePath = LOCK_FILE) {
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

export function releaseLock(lockFilePath = LOCK_FILE) {
  if (fs.existsSync(lockFilePath)) {
    try {
      fs.unlinkSync(lockFilePath);
    } catch {}
  }
}

// 2. Atomic State & Task Management
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

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return sanitizeTaskState({});
  }
  try {
    return sanitizeTaskState(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
  } catch {
    return sanitizeTaskState({});
  }
}

function saveStateAtomic(state) {
  const cleanState = sanitizeTaskState(state);
  state.completed_tasks = cleanState.completed_tasks;
  state.blocked_tasks = cleanState.blocked_tasks;
  const tmpPath = `${STATE_FILE}.tmp.${Date.now()}`;
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(cleanState, null, 2), 'utf8');
  fs.renameSync(tmpPath, STATE_FILE);
}

/**
 * Unifies flat schema (task_id) and nested legacy format (task.id) into a canonical task object.
 */
export function normalizeTask(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const raw = (parsed.task && typeof parsed.task === 'object') ? { ...parsed.task } : { ...parsed };
  const canonicalId = raw.task_id || raw.id;
  if (!canonicalId || typeof canonicalId !== 'string') return null;

  raw.task_id = canonicalId.trim();
  raw.id = raw.task_id;
  raw.project_id = raw.project_id || projectConfig.project?.id || 'my-workspace';
  raw.status = raw.status || 'ready';
  raw.owner = raw.owner || 'writer';
  raw.retries = typeof raw.retries === 'number' ? raw.retries : 0;
  raw.error_history = Array.isArray(raw.error_history) ? raw.error_history : [];
  raw.scope_expansions = Array.isArray(raw.scope_expansions) ? raw.scope_expansions : [];
  raw.created_at = raw.created_at || new Date().toISOString();
  raw.updated_at = new Date().toISOString();
  return raw;
}

function saveTaskAtomic(taskPath, taskData) {
  const tmpPath = `${taskPath}.tmp.${Date.now()}`;
  fs.mkdirSync(path.dirname(taskPath), { recursive: true });
  taskData.updated_at = new Date().toISOString();
  const yamlContent = YAML.stringify(taskData);
  fs.writeFileSync(tmpPath, yamlContent, 'utf8');
  fs.renameSync(tmpPath, taskPath);
}

// 3. Load Configurations
function loadYaml(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return YAML.parse(fs.readFileSync(filePath, 'utf8'));
}

const teamConfig = loadYaml(path.resolve(TEAM_DIR, 'config', 'team.local.yaml'))
  || loadYaml(path.resolve(TEAM_DIR, 'config', 'team.yaml'))
  || {};
const projectConfig = loadYaml(path.resolve(TEAM_DIR, 'config', 'project.local.yaml'))
  || loadYaml(path.resolve(TEAM_DIR, 'config', 'project.yaml'))
  || {};
const policyConfig = loadYaml(path.resolve(TEAM_DIR, 'config', 'policy.yaml')) || {};
const REPO_ROOT = resolveRepoRoot(projectConfig);

// Helpers for v2.1 Policy, Mode Selection & Security
export function computeScopeHash(scope = []) {
  const sorted = [...scope].map(s => s.trim().replace(/\\/g, '/')).sort().join('\n');
  return hashString(sorted);
}

export const RISK_LEVEL_RANK = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
  ultra: 4
};

export function resolveEffectiveRisk(task = {}) {
  const declared = String(task.risk_level || '').toLowerCase().trim();
  const computed = computeDeterministicRisk(task.scope || []);
  const scopeLen = Array.isArray(task.scope) ? task.scope.length : 0;
  const inferred = computed === 'high' ? 'high' : (scopeLen > 3 ? 'medium' : 'low');
  const declaredRank = RISK_LEVEL_RANK[declared] || 1;
  const inferredRank = RISK_LEVEL_RANK[inferred] || 1;
  if (declaredRank >= inferredRank && RISK_LEVEL_RANK[declared]) {
    return declared === 'ultra' ? 'critical' : declared;
  }
  return inferred;
}

export function shouldRunReviewerGate(task = {}, policy = policyConfig.policy || {}, roles = teamConfig.roles || {}) {
  if (!roles?.reviewer || roles.reviewer.enabled === false) {
    return false;
  }
  if (task.force_ai_review === true) {
    return true;
  }
  const mode = (task.mode || '').toLowerCase();
  const modeConfig = policy.task_modes?.[mode] || {};
  const skipReviewer = modeConfig.skip_router_and_reviewer ?? (mode === 'quick' || mode === 'direct');
  const requireReview = policy.approval_gates?.require_code_review ?? true;
  if (skipReviewer || !requireReview) {
    return false;
  }
  const minRisk = String(policy.approval_gates?.review_min_risk_level || 'high').toLowerCase();
  const minRank = RISK_LEVEL_RANK[minRisk] || RISK_LEVEL_RANK.high;
  const taskRisk = resolveEffectiveRisk(task);
  const taskRank = RISK_LEVEL_RANK[taskRisk] || RISK_LEVEL_RANK.low;
  return taskRank >= minRank;
}

export function resolveTaskMode(task, policy = policyConfig.policy || {}) {
  const explicitMode = (task.mode || '').toLowerCase();
  if (explicitMode === 'direct' || explicitMode === 'quick' || explicitMode === 'standard') {
    return explicitMode;
  }
  const smallThreshold = policy.approval_gates?.small_task_threshold_files ?? 3;
  const scopeLen = Array.isArray(task.scope) ? task.scope.length : 0;
  const allowExpansion = Boolean(task.allow_scope_expansion || task.cross_role_edit);
  const effectiveRisk = resolveEffectiveRisk(task);

  if (scopeLen <= smallThreshold && effectiveRisk === 'low' && !allowExpansion) {
    return 'quick';
  }
  return 'standard';
}

function sanitizeGoal(str = '') {
  return str.replace(/[\r\n\x1B]/g, ' ').slice(0, 80).trim();
}

/**
 * Extracts technical identifiers/symbols from task goal, acceptance_criteria, and last_error
 * to drive smart context window slicing on large files.
 */
export function extractTaskKeywords(task = {}) {
  const corpus = [
    task.title || '',
    task.goal || '',
    ...(task.acceptance_criteria || []),
    task.last_error || ''
  ].join(' ');

  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'true', 'false', 'null', 'none',
    'file', 'files', 'code', 'test', 'tests', 'task', 'pass', 'must', 'should', 'return', 'returns',
    'trong', 'cua', 'cho', 'voi', 'cac', 'khi', 'neu', 'phai', 'duoc', 'khong', 'thanh', 'cong', 'kiem', 'tra'
  ]);

  const matches = corpus.match(/[A-Za-z_][A-Za-z0-9_.-]{2,}/g) || [];
  const unique = [];
  const seen = new Set();

  for (const m of matches) {
    const clean = m.replace(/^[.-]+|[.-]+$/g, '');
    const lower = clean.toLowerCase();
    if (clean.length < 3 || stopWords.has(lower)) continue;
    // Prioritize snake_case, camelCase, dot.paths, or identifiers >= 4 chars
    if (clean.includes('_') || clean.includes('-') || clean.includes('.') || /[a-z][A-Z]/.test(clean) || clean.length >= 4) {
      if (!seen.has(lower)) {
        seen.add(lower);
        unique.push(clean);
      }
    }
  }
  return unique.slice(0, 25);
}

/**
 * Slices a large file around lines matching task keywords (+/- windowLines),
 * merging overlapping windows and preserving exact lines for SEARCH/REPLACE blocks.
 */
export function sliceContentByKeywords(rawContent, keywords = [], maxBytes = 120000, windowLines = 80) {
  const lines = rawContent.split(/\r?\n/);
  const totalLines = lines.length;
  if (totalLines <= windowLines * 2 + 60) {
    return rawContent;
  }

  const ranges = [];
  // Always keep top header/imports (first 50 lines)
  ranges.push([0, Math.min(50, totalLines - 1)]);

  const lowerKeywords = keywords.map(k => k.toLowerCase());
  if (lowerKeywords.length > 0) {
    for (let i = 0; i < totalLines; i++) {
      const lineLower = lines[i].toLowerCase();
      if (lowerKeywords.some(k => lineLower.includes(k))) {
        const start = Math.max(0, i - windowLines);
        const end = Math.min(totalLines - 1, i + windowLines);
        ranges.push([start, end]);
      }
    }
  }

  // Always include tail of file (last 35 lines) for appending new functions/exports
  ranges.push([Math.max(0, totalLines - 35), totalLines - 1]);

  // Sort and merge overlapping ranges
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    if (merged.length === 0 || r[0] > merged[merged.length - 1][1] + 1) {
      merged.push([...r]);
    } else {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], r[1]);
    }
  }

  const chunks = [];
  let usedBytes = 0;
  for (let idx = 0; idx < merged.length; idx++) {
    const [start, end] = merged[idx];
    if (idx > 0) {
      const prevEnd = merged[idx - 1][1];
      chunks.push(`\n/* ... [OMITTED LINES ${prevEnd + 2}..${start} — DO NOT INCLUDE THIS COMMENT IN SEARCH BLOCKS] ... */\n`);
    }
    const segment = lines.slice(start, end + 1).join('\n');
    const segBytes = Buffer.byteLength(segment, 'utf8');
    if (usedBytes + segBytes > maxBytes && idx > 0) {
      const remaining = Math.max(4096, maxBytes - usedBytes);
      chunks.push(segment.slice(0, remaining));
      chunks.push(`\n/* ... [CONTEXT BUDGET REACHED AT ${maxBytes} BYTES] ... */`);
      break;
    }
    chunks.push(segment);
    usedBytes += segBytes;
  }

  return chunks.join('\n');
}

function expandScopeItem(repoRoot, rawFile, maxFiles = 5) {
  const relPath = normalizeOrThrow(repoRoot, rawFile);
  const absPath = path.resolve(repoRoot, relPath);
  if (fs.existsSync(absPath) && fs.statSync(absPath).isDirectory()) {
    const entries = fs.readdirSync(absPath, { withFileTypes: true })
      .filter(e => e.isFile() && !e.name.startsWith('.'))
      .slice(0, maxFiles)
      .map(e => `${relPath.replace(/\/+$/, '')}/${e.name}`);
    return entries.length > 0 ? entries : [relPath];
  }
  return [relPath];
}

/**
 * Context-Aware File Loader:
 * - Scales byte budget from token_budget_per_task instead of a rigid 64KB cap.
 * - Sends files 100% intact when within budget.
 * - Uses symbol/keyword window slicing (+/- 80 lines) when a file exceeds budget.
 */
export function buildScopedFilesContext(scope = [], repoRoot = REPO_ROOT, task = {}, options = {}) {
  const tokenBudget = options.tokenBudgetPerTask
    || policyConfig.policy?.retry_and_escalation?.token_budget_per_task
    || 150000;
  const maxFiles = options.maxFilesPerTask
    || policyConfig.policy?.scope_control?.max_files_per_task
    || 5;

  // Token Diet: Clamp file context budget between 24KB and 64KB (~6k - 16k tokens)
  // Since Agent Runtime v3.0 has read_file and search_code tools, massive in-prompt dumps are unnecessary.
  const totalContextBudgetBytes = Math.min(Math.max(Math.floor(tokenBudget * 3.2 * 0.12), 24 * 1024), 64 * 1024);
  const expandedFiles = [];
  for (const rawFile of scope) {
    try {
      for (const f of expandScopeItem(repoRoot, rawFile, maxFiles)) {
        if (!expandedFiles.includes(f)) expandedFiles.push(f);
      }
    } catch {
      expandedFiles.push(rawFile);
    }
  }

  const perFileBudgetBytes = Math.min(
    28 * 1024,
    Math.max(14 * 1024, Math.floor(totalContextBudgetBytes / Math.max(1, expandedFiles.length)))
  );
  const keywords = extractTaskKeywords(task);
  const sections = [];

  for (const rawFile of expandedFiles) {
    try {
      const relPath = normalizeOrThrow(repoRoot, rawFile);
      const absPath = path.resolve(repoRoot, relPath);
      if (!fs.existsSync(absPath)) {
        sections.push(`=== FILE: ${relPath} (NEW FILE - DOES NOT EXIST ON DISK YET) ===\n<Empty: Use empty SEARCH block to create this file>`);
        continue;
      }
      const stat = fs.statSync(absPath);
      if (stat.isDirectory()) {
        sections.push(`=== DIRECTORY SCOPE: ${relPath} ===`);
        continue;
      }
      const rawContent = fs.readFileSync(absPath, 'utf8');
      const byteLen = Buffer.byteLength(rawContent, 'utf8');
      if (byteLen > perFileBudgetBytes) {
        const sliced = sliceContentByKeywords(rawContent, keywords, perFileBudgetBytes, 80);
        sections.push(`=== FILE: ${relPath} (SMART CONTEXT WINDOW — RELEVANT SECTIONS FOR KEYWORDS: ${keywords.slice(0, 8).join(', ') || 'head/tail'}) ===\n${sliced}`);
      } else {
        sections.push(`=== FILE: ${relPath} (EXISTING CONTENT) ===\n${rawContent}`);
      }
    } catch (err) {
      sections.push(`=== FILE: ${rawFile} (UNREADABLE: ${err.message}) ===`);
    }
  }
  return sections.join('\n\n');
}

// 4. Pre-flight Healthcheck (HR-6), Config Validation & Local 9Router API Helper
export function resolveApiKey(teamCfg = teamConfig) {
  const envKeyName = teamCfg?.providers?.local_9router?.api_key_env || 'NINE_ROUTER_API_KEY';
  return process.env[envKeyName] || teamCfg?.providers?.local_9router?.default_key || 'sk-default';
}

export function validateConfig(teamCfg = teamConfig, policyCfg = policyConfig, projectCfg = projectConfig) {
  const errors = [];
  if (!teamCfg?.providers?.local_9router?.base_url) {
    errors.push('team.yaml: missing providers.local_9router.base_url');
  }
  if (!teamCfg?.roles?.writer?.model) {
    errors.push('team.yaml: missing roles.writer.model');
  }
  const allowedDirs = projectCfg?.project?.allowed_dirs;
  if (!Array.isArray(allowedDirs) || allowedDirs.length === 0) {
    errors.push('project.yaml: project.allowed_dirs must be a non-empty array');
  }
  const maxFiles = policyCfg?.policy?.scope_control?.max_files_per_task;
  if (typeof maxFiles !== 'number' || maxFiles <= 0) {
    errors.push('policy.yaml: policy.scope_control.max_files_per_task must be a positive number');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Strips verbose ASCII greeting banners, passing unit test lines ("... ok"), and Tkinter
 * teardown noise from test output, keeping the tail where FAIL / ERROR / Traceback appear.
 */
export function formatValidationErrorForRetry(errText = '', maxChars = 1800) {
  if (!errText) return '';
  let cleaned = String(errText).replace(/\r\n/g, '\n');

  // 1. Strip the [SQUAD] ASCII banner from test_squad_hello.py
  cleaned = cleaned.replace(
    /={20,}\n\[SQUAD\][\s\S]*?\[OK\][^\n]*\n={20,}\n*/g,
    ''
  );

  // 2. Strip noisy Tkinter background timer teardown warnings
  cleaned = cleaned.replace(
    /invalid command name "[^"]+"\n\s+while executing\n"[^"]+"\n\s+\("after" script\)\n?/g,
    ''
  );

  // 3. Remove standalone passing test lines ("test_xxx (...) ... ok") so tracebacks stand out
  const lines = cleaned.split('\n');
  const filteredLines = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Handle 2-line docstring unittest output where line i is "test_foo (...)" and line i+1 is "Docstring ... ok"
    if (/^test_[A-Za-z0-9_]+\s+\([^)]+\)\s*$/.test(line.trim()) && i + 1 < lines.length && /\.\.\.\s*ok\s*$/.test(lines[i + 1].trim())) {
      i++;
      continue;
    }
    if (/^test_[A-Za-z0-9_]+\s+\([^)]+\)\s*\.\.\.\s*ok\s*$/.test(line.trim())) {
      continue;
    }
    filteredLines.push(line);
  }

  cleaned = filteredLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (cleaned.length <= maxChars) {
    return cleaned;
  }
  return `...[truncated earlier passing output]...\n${cleaned.slice(-maxChars)}`;
}

export async function check9RouterHealth(teamCfg = teamConfig, policyCfg = policyConfig) {
  const baseUrl = teamCfg.providers?.local_9router?.base_url || 'http://127.0.0.1:20128/v1';
  const apiKey = resolveApiKey(teamCfg);
  const guardrails = policyCfg.policy?.execution_guardrails || {};
  const timeoutSec = Math.min(
    guardrails.healthcheck_timeout_sec || 15,
    guardrails.network_max_time_sec || 15
  );

  try {
    const res = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutSec * 1000)
    });
    if (res.ok) {
      return { ok: true, status: res.status };
    }
    return { ok: false, error: `9Router healthcheck returned HTTP ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      error: `9Router unreachable at ${baseUrl} (timeout ${timeoutSec}s): ${err.message}`
    };
  }
}

export async function check9RouterHealthWithRetry(teamCfg = teamConfig, policyCfg = policyConfig, delaysMs = [0, 5000, 15000]) {
  let lastRes = { ok: false, error: 'Healthcheck did not run' };
  for (let i = 0; i < delaysMs.length; i++) {
    if (delaysMs[i] > 0) {
      console.warn(`[Orchestrator] 9Router healthcheck attempt ${i} failed (${lastRes.error}). Retrying in ${delaysMs[i] / 1000}s...`);
      await new Promise(r => setTimeout(r, delaysMs[i]));
    }
    lastRes = await check9RouterHealth(teamCfg, policyCfg);
    if (lastRes.ok) return lastRes;
  }
  return lastRes;
}

export function verifyResponseModel(requestedModel = '', responseModel = 'unknown') {
  const reqRaw = String(requestedModel || '').trim();
  const resRaw = String(responseModel || '').trim();
  if (!resRaw || resRaw === 'unknown') {
    return {
      match: false,
      reason: `Upstream response omitted data.model (got "unknown" for requested "${reqRaw}")`
    };
  }
  const norm = s => s.toLowerCase().split('/').pop().replace(/[._-]+/g, '-').trim();
  const reqSlug = norm(reqRaw);
  const resSlug = norm(resRaw);
  if (
    reqRaw.toLowerCase() === resRaw.toLowerCase() ||
    (reqSlug && resSlug && (reqSlug === resSlug || resSlug.includes(reqSlug) || reqSlug.includes(resSlug)))
  ) {
    return { match: true, reason: null };
  }
  return {
    match: false,
    reason: `Requested model "${reqRaw}" but upstream responded with "${resRaw}"`
  };
}

export function saveWriterRawOutput(taskId, attemptNum, writerRes = {}) {
  try {
    const safeId = String(taskId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
    const runDir = path.resolve(TEAM_DIR, 'state', 'runs', safeId);
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

async function call9Router(model, systemPrompt, userMessage, maxTokens = 4096, fallbackModel = null, temperature = 0.1, options = {}) {
  const baseUrl = teamConfig.providers?.local_9router?.base_url || 'http://127.0.0.1:20128/v1';
  const apiKey = resolveApiKey(teamConfig);
  const timeoutSec = policyConfig.policy?.execution_guardrails?.default_cli_timeout_sec
    || teamConfig.providers?.ide_bridge?.timeout_sec
    || 120;
  const timeoutMs = timeoutSec * 1000;
  const strictModelMatch = options.strictModelMatch ?? policyConfig.policy?.execution_guardrails?.strict_model_match ?? true;

  const modelsToTry = [model, ...(fallbackModel && fallbackModel !== model ? [fallbackModel] : [])];
  let lastError = 'Unknown API error';

  for (const candidateModel of modelsToTry) {
    try {
      const reqBody = {
        model: candidateModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        max_tokens: maxTokens,
        temperature
      };
      if (options.maxThinkingTokens !== undefined && options.maxThinkingTokens !== null) {
        reqBody.max_thinking_tokens = options.maxThinkingTokens;
      }

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(timeoutMs)
      });

      if (!res.ok) {
        const errText = await res.text();
        lastError = `HTTP ${res.status} (${candidateModel}): ${errText}`;
        continue;
      }

      const rawText = await res.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          data = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error(`Failed to parse JSON response: ${rawText.slice(0, 200)}`);
        }
      }
      const rawContent = data.choices?.[0]?.message?.content || '';
      const reasoning = data.choices?.[0]?.message?.reasoning_content || '';
      const finishReason = data.choices?.[0]?.finish_reason || 'unknown';
      const responseModel = (typeof data.model === 'string' && data.model.trim()) ? data.model.trim() : 'unknown';

      const modelCheck = verifyResponseModel(candidateModel, responseModel);
      if (!modelCheck.match) {
        console.warn(`[9Router] MODEL MISMATCH WARNING: ${modelCheck.reason}`);
        if (strictModelMatch && responseModel !== 'unknown') {
          lastError = `Model mismatch rejected by policy: ${modelCheck.reason}`;
          continue;
        }
      }

      let content = rawContent;
      if (!content.includes('<<<<<<< SEARCH') && reasoning.includes('<<<<<<< SEARCH')) {
        content = reasoning;
      }
      const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0 };
      return {
        ok: true,
        content,
        rawContent,
        rawReasoning: reasoning,
        finishReason,
        usage,
        modelUsed: candidateModel,
        responseModel,
        modelMatched: modelCheck.match
      };
    } catch (err) {
      lastError = `${candidateModel}: ${err.name === 'TimeoutError' ? `Request timed out after ${timeoutSec}s` : err.message}`;
    }
  }

  return { ok: false, error: lastError };
}

// 4b. Router Context Builder (Bounded file list + Codebase Google Maps table, NO file contents)
export function buildRouterContext(allowedDirs = [], repoRoot = REPO_ROOT, maxFiles = 300) {
  const sections = [];

  // 1. Extract Codebase Google Maps table from AGENTS.md if present
  const agentsPath = path.resolve(repoRoot, 'AGENTS.md');
  if (fs.existsSync(agentsPath)) {
    try {
      const agentsContent = fs.readFileSync(agentsPath, 'utf8');
      const mapMatch = agentsContent.match(/###\s*Codebase Google Maps[\s\S]*?(?=\n---\n|\n##\s|$)/i);
      if (mapMatch) {
        sections.push(`CODEBASE GOOGLE MAPS (from AGENTS.md):\n${mapMatch[0].trim()}`);
      }
    } catch {}
  }

  // 2. Collect bounded file paths in allowedDirs (skipping __pycache__, .venv, .git, node_modules, .pyc)
  const IGNORED_DIRS = new Set(['__pycache__', '.venv', 'venv', '.git', 'node_modules', '.pytest_cache', '.mypy_cache']);
  const collected = [];

  function walkDir(relDir) {
    if (collected.length >= maxFiles) return;
    const cleanRel = relDir.replace(/\\/g, '/').replace(/\/+$/, '');
    const absDir = path.resolve(repoRoot, cleanRel);
    if (!fs.existsSync(absDir)) return;
    let stat;
    try {
      stat = fs.statSync(absDir);
    } catch {
      return;
    }
    if (stat.isFile()) {
      if (!cleanRel.endsWith('.pyc')) collected.push(cleanRel);
      return;
    }
    if (!stat.isDirectory()) return;

    let entries = [];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (collected.length >= maxFiles) break;
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const childRel = cleanRel ? `${cleanRel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walkDir(childRel);
      } else if (entry.isFile() && !entry.name.endsWith('.pyc')) {
        collected.push(childRel);
      }
    }
  }

  for (const dir of allowedDirs) {
    if (collected.length >= maxFiles) break;
    walkDir(String(dir || ''));
  }

  if (collected.length > 0) {
    const suffix = collected.length >= maxFiles ? `\n... (truncated at ${maxFiles} files)` : '';
    sections.push(`AVAILABLE WORKSPACE FILES (in allowed_dirs):\n${collected.map(f => `- ${f}`).join('\n')}${suffix}`);
  }

  return sections.join('\n\n');
}

// 4c. Router Planner (Populates scope & acceptance_criteria when task is in 'draft' status)
async function runRouterPlanner(task) {
  const routerRole = teamConfig.roles?.router || {};
  if (routerRole.enabled === false) {
    return { ok: false, error: 'Router role is disabled in team.yaml' };
  }

  const routerModel = routerRole.model || 'kr/claude-sonnet-4.5-thinking';
  const routerFallback = routerRole.fallback_model || null;
  const routerTemp = routerRole.temperature ?? 0.2;
  const routerMaxThinking = routerRole.max_thinking_tokens;
  const routerSystemPrompt = fs.existsSync(path.resolve(TEAM_DIR, 'roles', 'router.md'))
    ? fs.readFileSync(path.resolve(TEAM_DIR, 'roles', 'router.md'), 'utf8')
    : 'Analyze the goal and return JSON { "plan": [], "scope": [], "acceptance_criteria": [] }.';

  const allowedDirs = projectConfig.project?.allowed_dirs || [];
  const routerContext = buildRouterContext(allowedDirs, REPO_ROOT, 300);
  const prompt = [
    `TASK ID: ${task.task_id}`,
    `TITLE: ${task.title || ''}`,
    `GOAL: ${task.goal || task.title || ''}`,
    `ALLOWED DIRECTORIES: ${allowedDirs.join(', ')}`,
    routerContext ? routerContext : '',
    `Select only existing file paths from AVAILABLE WORKSPACE FILES (or valid new test/module paths inside ALLOWED DIRECTORIES). Return strict JSON with keys: plan, scope, acceptance_criteria.`
  ].filter(Boolean).join('\n\n');

  const res = await call9Router(routerModel, routerSystemPrompt, prompt, 2048, routerFallback, routerTemp, {
    maxThinkingTokens: routerMaxThinking
  });
  if (!res.ok) {
    return { ok: false, error: `Router API error: ${res.error}`, usage: { prompt_tokens: 0, completion_tokens: 0 } };
  }

  try {
    const jsonMatch = res.content.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(res.content);
    return {
      ok: Array.isArray(parsed.scope) && parsed.scope.length > 0,
      plan: parsed.plan || [],
      scope: parsed.scope || [],
      acceptance_criteria: parsed.acceptance_criteria || task.acceptance_criteria || [],
      usage: res.usage,
      error: (Array.isArray(parsed.scope) && parsed.scope.length > 0) ? null : 'Router returned empty scope'
    };
  } catch (err) {
    return { ok: false, error: `Router output was not valid JSON: ${err.message}`, usage: res.usage };
  }
}

// 5. Reviewer Prompt Builder (Includes constraints + previous review issues only + function-context diff)
export function buildReviewerPrompt(task, diffText, previousReviewIssues = []) {
  const constraintsList = Array.isArray(task.constraints) && task.constraints.length > 0
    ? task.constraints.map(c => `- ${c}`).join('\n')
    : '(None specified)';

  const prevIssuesBlock = Array.isArray(previousReviewIssues) && previousReviewIssues.length > 0
    ? [
        `PREVIOUS REVIEW ISSUES TO VERIFY (From your prior review of this task):`,
        ...previousReviewIssues.map((iss, idx) => `${idx + 1}. ${iss}`),
        `Verify whether the issues above have been resolved without introducing regressions. Do not shift goalposts with unrelated nitpicks.`
      ].join('\n')
    : null;

  return [
    `TASK ID: ${task.task_id}`,
    `GOAL: ${task.goal || task.title}`,
    `CONSTRAINTS:\n${constraintsList}`,
    `ACCEPTANCE CRITERIA: ${(task.acceptance_criteria || []).join('; ')}`,
    prevIssuesBlock,
    `GIT DIFF (WITH FUNCTION CONTEXT):\n${diffText}`
  ].filter(Boolean).join('\n\n');
}

// 5b. Reviewer Gate (Executed only in 'standard' mode when require_code_review is true)
async function runReviewerGate(task, scopedFiles, previousReviewIssues = []) {
  const reviewerRole = teamConfig.roles?.reviewer || {};
  if (reviewerRole.enabled === false) {
    return { ok: true, skipped: true };
  }
  const diffText = getScopedDiff(scopedFiles, { functionContext: true });
  if (!diffText) {
    return { ok: true, skipped: true };
  }

  const reviewerModel = reviewerRole.model || 'ag/claude-opus-5-5-high';
  const reviewerFallback = reviewerRole.fallback_model || null;
  const reviewerTemp = reviewerRole.temperature ?? 0.1;
  const reviewerMaxThinking = reviewerRole.max_thinking_tokens;
  const reviewerSystemPrompt = fs.existsSync(path.resolve(TEAM_DIR, 'roles', 'reviewer.md'))
    ? fs.readFileSync(path.resolve(TEAM_DIR, 'roles', 'reviewer.md'), 'utf8')
    : 'Review the git diff against acceptance criteria and return JSON { "passed": boolean, "rubric_scores": {...}, "issues": [] }.';

  const reviewMsg = buildReviewerPrompt(task, diffText, previousReviewIssues);

  const res = await call9Router(reviewerModel, reviewerSystemPrompt, reviewMsg, 2048, reviewerFallback, reviewerTemp, {
    maxThinkingTokens: reviewerMaxThinking
  });
  if (!res.ok) {
    return { ok: false, error: `Reviewer API error: ${res.error}`, usage: { prompt_tokens: 0, completion_tokens: 0 } };
  }

  try {
    const jsonMatch = res.content.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(res.content);
    const isPassed = parsed.passed === true;
    return {
      ok: isPassed,
      reviewResult: parsed,
      error: isPassed ? null : `Reviewer rejected diff: ${(parsed.issues || []).join('; ') || 'Rubric check failed'}`,
      usage: res.usage
    };
  } catch (err) {
    return {
      ok: false,
      error: `Reviewer output was not valid JSON: ${err.message}`,
      usage: res.usage
    };
  }
}

// 6. Morning Report Generator
export function writeMorningReport(state) {
  const lines = [
    `# Minimal Agent Orchestration — Execution Report (v2.1 Standard)`,
    `Generated at: ${new Date().toISOString()}`,
    ``,
    `## Summary`,
    `- Completed Tasks: ${state.completed_tasks.length}`,
    `- Blocked Tasks: ${state.blocked_tasks.length}`,
    `- Active Tasks Remaining: ${state.active_tasks.length}`,
    `- Total Tokens Used: In: ${state.metrics.total_input_tokens || 0} | Out: ${state.metrics.total_output_tokens || 0}`,
    `- Estimated Cost: $${(state.metrics.total_cost_est_usd || 0).toFixed(4)}`,
    ``,
    `## Completed Tasks`
  ];

  if (state.completed_tasks.length === 0) {
    lines.push(`_No tasks completed yet._`);
  } else {
    for (const t of state.completed_tasks) {
      const tid = t.task_id || t.id;
      const displayTitle = t.title || sanitizeGoal(t.goal || '') || 'Untitled';
      lines.push(`- **${tid}** [${t.mode || 'quick'}]: ${displayTitle} (Commit: \`${t.commit_hash || 'none'}\`, Retries: ${t.retries || 0})`);
    }
  }

  lines.push(``, `## Blocked Tasks`);
  if (state.blocked_tasks.length === 0) {
    lines.push(`_No blocked tasks! 100% smooth flow._`);
  } else {
    for (const t of state.blocked_tasks) {
      const tid = t.task_id || t.id;
      const displayTitle = t.title || sanitizeGoal(t.goal || '') || 'Untitled';
      lines.push(`- **${tid}** [${t.mode || 'quick'}]: ${displayTitle} — Reason: \`${t.block_reason || 'Unknown error'}\``);
    }
  }

  fs.writeFileSync(REPORT_FILE, lines.join('\n'), 'utf8');
}

// 7. Main Orchestrator Loop
async function runOrchestrator() {
  const cfgValidation = validateConfig(teamConfig, policyConfig, projectConfig);
  if (!cfgValidation.ok) {
    console.error(`[Orchestrator] Configuration validation failed:\n  - ${cfgValidation.errors.join('\n  - ')}`);
    process.exit(1);
  }

  if (!acquireLock()) {
    console.error('[Orchestrator] Could not acquire lock. Exiting.');
    process.exit(1);
  }

  let activeRollbackTargets = [];
  const handleGracefulShutdown = (sig) => {
    if (activeRollbackTargets.length > 0) {
      console.warn(`\n[Orchestrator] Caught ${sig} with uncommitted changes on disk. Rolling back scoped files...`);
      try {
        rollback(activeRollbackTargets);
      } catch {}
      activeRollbackTargets = [];
    }
    updateLiveStatus({ active: false, current_stage: 'idle', stage_started_at: null });
    releaseLock();
    process.exit(0);
  };

  process.on('exit', () => releaseLock());
  process.on('SIGINT', () => handleGracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => handleGracefulShutdown('SIGTERM'));

  console.log('[Orchestrator] Starting session (v2.1 Mode-Based Engine)...');

  const state = loadState();
  const maxRetries = policyConfig.policy?.retry_and_escalation?.max_retries_per_task || 3;
  const abortOnIdentical = policyConfig.policy?.retry_and_escalation?.abort_on_identical_error_count || 2;
  const tokenBudgetPerTask = policyConfig.policy?.retry_and_escalation?.token_budget_per_task || 150000;
  const nightTokenBudgetTotal = policyConfig.policy?.retry_and_escalation?.night_token_budget_total || 3000000;
  const maxFilesPerTask = policyConfig.policy?.scope_control?.max_files_per_task || 5;
  const maxScopeIncrease = policyConfig.policy?.scope_control?.max_scope_increase ?? 1;
  const allowNewFiles = policyConfig.policy?.scope_control?.allow_new_files ?? true;
  const newFilesOnlyInScope = policyConfig.policy?.scope_control?.new_files_only_in_scope ?? true;
  const requireCrossRoleApproval = policyConfig.policy?.approval_gates?.require_human_approval_for_cross_role_edit ?? true;
  const requireCleanBeforeStart = policyConfig.policy?.git_hygiene?.require_clean_worktree_before_start ?? true;
  const rollbackOnValidationFail = policyConfig.policy?.git_hygiene?.rollback_on_validation_fail ?? true;
  const autoCommitOnDone = policyConfig.policy?.git_hygiene?.auto_commit_on_done ?? true;
  const commitPrefix = policyConfig.policy?.git_hygiene?.commit_message_prefix || '[AI-Task]';
  const allowedDirs = projectConfig.project?.allowed_dirs || [];
  const protectedFiles = projectConfig.project?.protected_files || [];

  if (!fs.existsSync(ACTIVE_TASKS_DIR)) {
    fs.mkdirSync(ACTIVE_TASKS_DIR, { recursive: true });
  }
  const taskFiles = fs.readdirSync(ACTIVE_TASKS_DIR).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

  if (taskFiles.length === 0) {
    console.log(`\n======================================================`);
    console.log(`💡 [HÀNG ĐỢI RỖNG - HƯỚNG DẪN GIAO VIỆC CHO ĐỘI NGŨ AI]`);
    console.log(`======================================================`);
    console.log(`Thư mục "tasks/active/" hiện chưa có task nào.`);
    console.log(`Bạn đã cấu hình xong môi trường! Giờ hãy giao việc bằng 1 trong các cách:\n`);
    console.log(`👉 CÁCH 1 (Khuyên dùng - Bàn điều khiển Web 1-Chạm):`);
    console.log(`   npm run dashboard`);
    console.log(`   -> Mở http://127.0.0.1:4310 -> Nhập mục tiêu -> Bấm Phê Duyệt & Chạy!\n`);
    console.log(`👉 CÁCH 2 (AI Architect tự sinh task qua CLI):`);
    console.log(`   npm run plan -- "Mô tả tính năng bạn muốn làm"`);
    console.log(`   -> AI sẽ tự bóc tách ra task YAML trong tasks/active/\n`);
    console.log(`👉 CÁCH 3 (Tương tác trực tiếp với 1 Agent độc lập):`);
    console.log(`   npm run agent -- --role writer --prompt "Nhiệm vụ của bạn"`);
    console.log(`======================================================\n`);
    updateLiveStatus({ active: false, current_stage: 'idle' });
    releaseLock();
    process.exit(0);
  }

  console.log(`[Orchestrator] Found ${taskFiles.length} task(s) in tasks/active/`);

  updateLiveStatus({
    active: true,
    pid: process.pid,
    current_stage: 'preflight',
    stage_started_at: new Date().toISOString(),
    queue_stats: {
      active: taskFiles.length,
      completed: (state.completed_tasks || []).length,
      blocked: (state.blocked_tasks || []).length
    },
    tokens: {
      task_input: 0,
      task_output: 0,
      session_input: state.metrics?.total_input_tokens || 0,
      session_output: state.metrics?.total_output_tokens || 0
    }
  });

  // Pre-flight 9Router Healthcheck (HR-6 with retry): Abort session cleanly without mutating active tasks if 9Router is down
  if (taskFiles.length > 0) {
    const health = await check9RouterHealthWithRetry(teamConfig, policyConfig);
    if (!health.ok) {
      console.error(`[Orchestrator] Pre-flight healthcheck FAILED after retries: ${health.error}`);
      console.error('[Orchestrator] Aborting session safely without mutating active tasks.');
      updateLiveStatus({ active: false, current_stage: 'blocked', last_error: health.error });
      releaseLock();
      process.exit(1);
    }
  }

  for (const tFile of taskFiles) {
    const totalSessionTokens = (state.metrics.total_input_tokens || 0) + (state.metrics.total_output_tokens || 0);
    if (totalSessionTokens >= nightTokenBudgetTotal) {
      console.error(`[Orchestrator] Night token budget exhausted (${totalSessionTokens} >= ${nightTokenBudgetTotal}). Stopping session.`);
      break;
    }

    const taskPath = path.resolve(ACTIVE_TASKS_DIR, tFile);
    const parsed = loadYaml(taskPath);
    const task = normalizeTask(parsed);

    if (!task) {
      console.warn(`[Orchestrator] Skipping invalid task file (missing task_id/id): ${tFile}`);
      continue;
    }

    const initialStatus = String(task.status || 'ready').toLowerCase();
    if (initialStatus === 'blocked' || initialStatus === 'done' || initialStatus === 'draft_review') {
      const hint = initialStatus === 'draft_review'
        ? 'Awaits human approval on Dashboard or CLI (change status to "ready" to execute).'
        : 'Reset status to "ready" to re-run.';
      console.log(`[Orchestrator] Skipping ${tFile} (status="${initialStatus}"). ${hint}`);
      continue;
    }

    let retries = 0;
    let lastErrorHash = null;
    let consecutiveIdenticalErrors = 0;
    let taskTokensUsed = 0;
    let isTaskDone = false;
    let blockReason = null;
    let validationPassed = null;
    let actualModifiedFiles = [];
    let previousReviewIssues = [];
    const taskStartMs = Date.now();

    const getRollbackTargets = () => Array.from(new Set([
      ...(task.scope || []),
      ...(task.scope_expansions || []),
      ...actualModifiedFiles
    ]));

    updateLiveStatus({
      current_task_id: task.task_id,
      current_task_title: task.title || task.goal || '',
      current_stage: 'router',
      stage_started_at: new Date().toISOString(),
      task_started_at: new Date().toISOString(),
      mode: task.mode || 'quick',
      risk_level: task.risk_level || 'low',
      attempt: 1,
      max_retries: maxRetries,
      scope_files: (task.scope || []).map(f => ({ path: f, status: 'pending' })),
      last_error: null,
      raw_log_path: null
    });

    try {
      // ==========================================
      // OPTIONAL ROUTER PLANNER (For 'draft' tasks without scope)
      // ==========================================
      if (task.status === 'draft' && (!task.scope || task.scope.length === 0)) {
        const planRes = await runRouterPlanner(task);
        if (planRes.usage) {
          const rIn = planRes.usage.prompt_tokens || 0;
          const rOut = planRes.usage.completion_tokens || 0;
          taskTokensUsed += rIn + rOut;
          state.metrics.total_input_tokens = (state.metrics.total_input_tokens || 0) + rIn;
          state.metrics.total_output_tokens = (state.metrics.total_output_tokens || 0) + rOut;
        }
        if (planRes.ok) {
          task.plan = planRes.plan;
          task.scope = planRes.scope;
          if (!task.acceptance_criteria || task.acceptance_criteria.length === 0) {
            task.acceptance_criteria = planRes.acceptance_criteria;
          }
          task.status = 'planned';
        } else {
          blockReason = planRes.error || 'Router failed to produce a valid plan and scope.';
          task.status = 'blocked';
          throw new Error(blockReason);
        }
      }

      // ==========================================
      // ROUTER PRE-CHECK (0-Token Fail-Fast Gate)
      // ==========================================
      if (!task.scope || !Array.isArray(task.scope) || task.scope.length === 0) {
        blockReason = 'Task scope is empty. Explicit scope is required.';
        task.status = 'blocked';
        throw new Error(blockReason);
      }

      if (task.scope.length > maxFilesPerTask) {
        blockReason = `Task scope exceeds max_files_per_task (${task.scope.length} > ${maxFilesPerTask}). Split into smaller tasks.`;
        task.status = 'blocked';
        throw new Error(blockReason);
      }

      if (!task.acceptance_criteria || !Array.isArray(task.acceptance_criteria) || task.acceptance_criteria.length === 0) {
        blockReason = 'Task missing acceptance_criteria.';
        task.status = 'blocked';
        throw new Error(blockReason);
      }

      // Fail-fast check on task.scope for illegal paths, forbidden files, and allowedDirs
      for (const rawScopePath of task.scope) {
        let normRel;
        try {
          normRel = normalizeOrThrow(REPO_ROOT, rawScopePath);
        } catch (err) {
          blockReason = `SECURITY: Invalid path in task.scope "${rawScopePath}": ${err.message}`;
          task.status = 'blocked';
          throw new Error(blockReason);
        }

        const fCheck = checkForbidden(normRel, protectedFiles, task.forbidden_files || []);
        if (fCheck.forbidden) {
          blockReason = `SECURITY: Forbidden file in task.scope "${normRel}" (matched pattern: "${fCheck.pattern}")`;
          task.status = 'blocked';
          throw new Error(blockReason);
        }

        if (!checkAllowedDirs(normRel, allowedDirs)) {
          blockReason = `Task scope "${normRel}" is outside project.allowed_dirs: ${allowedDirs.join(', ')}`;
          task.status = 'blocked';
          throw new Error(blockReason);
        }
      }

      // Computed Risk Level & Mode Selection
      const effectiveRisk = resolveEffectiveRisk(task);
      task.risk_level = effectiveRisk;
      task.mode = resolveTaskMode(task, policyConfig.policy);
      updateLiveStatus({
        mode: task.mode,
        risk_level: task.risk_level,
        scope_files: (task.scope || []).map(f => ({ path: f, status: 'pending' }))
      });

      // Approval Check for High/Critical Risk or Cross-Role Edit
      const needsHumanApproval = (RISK_LEVEL_RANK[effectiveRisk] >= RISK_LEVEL_RANK.high) || (Boolean(task.cross_role_edit) && requireCrossRoleApproval);
      if (needsHumanApproval) {
        const expectedHash = computeScopeHash(task.scope);
        const hasValidApproval = task.approval &&
          typeof task.approval.by === 'string' &&
          task.approval.scope_hash === expectedHash;

        if (!hasValidApproval) {
          blockReason = `Waiting for human approval (risk_level: ${effectiveRisk}, cross_role_edit: ${Boolean(task.cross_role_edit)}, expected scope_hash: "${expectedHash}")`;
          task.status = 'blocked';
          throw new Error(blockReason);
        }
      }

      // Scope Expansion Justification Guard
      const allowExpansion = Boolean(task.allow_scope_expansion || task.cross_role_edit);
      if (allowExpansion && (!task.justification || task.justification.trim().length < 10)) {
        blockReason = 'allow_scope_expansion is true but justification is missing or too short (< 10 chars)';
        task.status = 'blocked';
        throw new Error(blockReason);
      }

      // Scoped Clean Worktree Guard
      if (requireCleanBeforeStart && !isCleanWorktree(task.scope)) {
        blockReason = `Scoped files have uncommitted modifications before task start: ${task.scope.join(', ')}`;
        task.status = 'blocked';
        throw new Error(blockReason);
      }

      // Baseline Fast Check Guard (Ensure repo is not already broken before Writer runs)
      const baselineCheck = await validateFast(projectConfig);
      if (!baselineCheck.ok) {
        blockReason = `Baseline fast check failed before task start (${baselineCheck.checkName}): ${baselineCheck.errorCombined.slice(0, 300)}`;
        task.status = 'blocked';
        throw new Error(blockReason);
      }

      // ==========================================
      // 3.1 PRE-HOOK (0-Token, Exactly 1 Console Line)
      // ==========================================
      const cleanGoal = sanitizeGoal(task.goal || task.title);
      console.log(`[START] ${task.task_id} | Mode: ${task.mode} | Goal: ${cleanGoal} | Scope: ${task.scope.join(', ')} | Allow-expansion: ${allowExpansion}`);

      snapshot();

      // Helper to record validation/review errors and enforce identical-error loop breaker
      const handleStageFailure = (stageName, errSummary, errHash) => {
        validationPassed = stageName === 'review' ? true : false;
        const conciseErr = stageName === 'validate'
          ? formatValidationErrorForRetry(errSummary, 1800)
          : String(errSummary || '');

        task.error_history.push({
          attempt: retries + 1,
          stage: stageName,
          error_hash: errHash,
          summary: conciseErr.slice(-600)
        });

        if (errHash === lastErrorHash) {
          consecutiveIdenticalErrors++;
        } else {
          lastErrorHash = errHash;
          consecutiveIdenticalErrors = 1;
        }

        if (rollbackOnValidationFail) {
          rollback(getRollbackTargets());
          activeRollbackTargets = [];
        }

        if (consecutiveIdenticalErrors >= abortOnIdentical) {
          blockReason = `Infinite fix loop detected in ${stageName} (${consecutiveIdenticalErrors}x identical error: ${errHash})`;
          task.status = 'blocked';
          console.error(`[Orchestrator] ${blockReason}`);
          return { shouldBreak: true };
        }

        task.last_error = conciseErr;
        retries++;
        return { shouldBreak: false };
      };

      const modeConfig = policyConfig.policy?.task_modes?.[task.mode] || {};
      const maxRuntimeSec = modeConfig.max_runtime_sec || (task.mode === 'quick' ? 60 : 300);

      // ==========================================
      // TASK EXECUTION LOOP
      // ==========================================
      while (retries <= maxRetries && !isTaskDone) {
        if (retries > 0) {
          const backoffMs = Math.min(retries * 3000, 10000);
          console.log(`[Orchestrator] Waiting ${backoffMs / 1000}s before retry attempt ${retries + 1}/${maxRetries + 1}...`);
          await new Promise(r => setTimeout(r, backoffMs));
        }

        if (taskTokensUsed > tokenBudgetPerTask) {
          blockReason = `Exceeded token budget (${taskTokensUsed} > ${tokenBudgetPerTask})`;
          task.status = 'blocked';
          console.error(`[Orchestrator] ${blockReason}`);
          break;
        }

        const elapsedSec = (Date.now() - taskStartMs) / 1000;
        if (elapsedSec > maxRuntimeSec) {
          blockReason = `Exceeded task mode "${task.mode}" max_runtime_sec (${elapsedSec.toFixed(1)}s > ${maxRuntimeSec}s)`;
          task.status = 'blocked';
          console.error(`[Orchestrator] ${blockReason}`);
          break;
        }

        task.status = 'writing';

        // Step A: Prepare Writer Prompt WITH Context-Aware Scoped File Contents
        const writerRole = teamConfig.roles?.writer || {};
        const writerModel = writerRole.model || 'deepseek-ai/deepseek-v4.1-flash-1017';
        const writerFallback = writerRole.fallback_model || null;
        const writerTemp = writerRole.temperature ?? 0.1;
        const writerMaxThinking = writerRole.max_thinking_tokens;
        const writerSystemRole = fs.existsSync(path.resolve(TEAM_DIR, 'roles', 'writer.md'))
          ? fs.readFileSync(path.resolve(TEAM_DIR, 'roles', 'writer.md'), 'utf8')
          : 'You are the backend code writer. Return changes in <<<<<<< SEARCH / ======= / >>>>>>> REPLACE blocks.';

        updateLiveStatus({
          current_stage: 'writer',
          stage_started_at: new Date().toISOString(),
          attempt: retries + 1,
          roles_status: {
            writer: { model: writerModel, status: 'working' },
            validator: { status: 'idle' },
            reviewer: { status: 'idle' }
          }
        });

        const scopedFilesContext = buildScopedFilesContext(task.scope, REPO_ROOT, task, {
          tokenBudgetPerTask,
          maxFilesPerTask
        });

        const userMessage = [
          `TASK ID: ${task.task_id}`,
          `EXECUTION MODE: ${task.mode}`,
          `GOAL: ${task.goal || task.title}`,
          `ALLOWED SCOPE: ${task.scope.join(', ')}`,
          `CONSTRAINTS: ${(task.constraints || []).join(', ')}`,
          `ACCEPTANCE CRITERIA: ${task.acceptance_criteria.join('; ')}`,
          `CURRENT SCOPED FILE CONTENTS:\n${scopedFilesContext}`,
          task.last_error
            ? `PREVIOUS ATTEMPT FAILED WITH ERROR:\n${task.last_error}\nPlease fix the issue. Think briefly (<100 words) and output exact SEARCH/REPLACE blocks.`
            : 'Please generate the exact code modifications to fulfill the goal. Think briefly (<100 words) and immediately output the SEARCH/REPLACE blocks.'
        ].join('\n\n');

        let writerRes;
        try {
          const agentRes = await runAgent({
            role: 'writer',
            prompt: userMessage,
            sessionId: `${task.task_id}-writer`,
            scope: task.scope || [],
            attachments: task.attachments || [],
            modelOverride: writerModel,
            maxTurns: 4,
            timeoutMs: (task.mode === 'quick' ? 90 : 180) * 1000,
            repoRoot: REPO_ROOT
          });

          if (agentRes.ok) {
            writerRes = {
              ok: true,
              content: agentRes.content || '',
              rawContent: agentRes.content || '',
              rawReasoning: '',
              finishReason: 'stop',
              usage: { prompt_tokens: 0, completion_tokens: 0 },
              modelUsed: agentRes.model_used || writerModel,
              responseModel: agentRes.model_used || writerModel,
              modelMatched: true
            };
          } else {
            console.warn(`[Writer Runtime] Agent run returned error: ${agentRes.error}. Falling back to call9Router...`);
            writerRes = await call9Router(writerModel, writerSystemRole, userMessage, 16384, writerFallback, writerTemp, {
              maxThinkingTokens: writerMaxThinking
            });
          }
        } catch (agentErr) {
          console.warn(`[Writer Runtime] Exception during runAgent: ${agentErr.message}. Falling back to call9Router...`);
          writerRes = await call9Router(writerModel, writerSystemRole, userMessage, 16384, writerFallback, writerTemp, {
            maxThinkingTokens: writerMaxThinking
          });
        }

        if (!writerRes.ok) {
          console.error(`[Writer] API error: ${writerRes.error}`);
          task.last_error = writerRes.error;
          updateLiveStatus({
            roles_status: {
              writer: { model: writerModel, status: 'error' },
              validator: { status: 'idle' },
              reviewer: { status: 'idle' }
            },
            last_error: writerRes.error
          });
          retries++;
          continue;
        }

        const rawLogPath = saveWriterRawOutput(task.task_id, retries + 1, writerRes);

        const inputTok = writerRes.usage?.prompt_tokens || 0;
        const outputTok = writerRes.usage?.completion_tokens || 0;
        taskTokensUsed += inputTok + outputTok;
        state.metrics.total_input_tokens = (state.metrics.total_input_tokens || 0) + inputTok;
        state.metrics.total_output_tokens = (state.metrics.total_output_tokens || 0) + outputTok;

        updateLiveStatus({
          raw_log_path: rawLogPath,
          roles_status: {
            writer: { model: writerModel, status: 'done' },
            validator: { status: 'idle' },
            reviewer: { status: 'idle' }
          },
          tokens: {
            task_input: taskTokensUsed,
            task_output: 0,
            session_input: state.metrics.total_input_tokens || 0,
            session_output: state.metrics.total_output_tokens || 0
          }
        });

        // Step A.5: Unconditional Truncation Guard (when finish_reason === 'length')
        // Even if output was cut cleanly between two SEARCH/REPLACE blocks, applying partial blocks risks committing half a feature.
        if (writerRes.finishReason === 'length') {
          const searchCount = (writerRes.content.match(/<<<<<<< SEARCH/g) || []).length;
          const replaceCount = (writerRes.content.match(/>>>>>>> REPLACE/g) || []).length;
          const truncErr = `Writer output truncated at max_tokens=16384 (finish_reason="length", ${searchCount} SEARCH / ${replaceCount} REPLACE blocks). Refusing to apply partial output; emit smaller/more concise blocks or split task.${rawLogPath ? ` (raw output: ${path.relative(REPO_ROOT, rawLogPath)})` : ''}`;
          console.warn(`[Writer] ${truncErr}`);
          const failAction = handleStageFailure('apply', truncErr, hashString('truncated_output_length'));
          if (failAction.shouldBreak) break;
          continue;
        }

        // Step B: 8-Step Applier Pipeline
        updateLiveStatus({
          current_stage: 'applier',
          stage_started_at: new Date().toISOString()
        });

        const applyRes = applyEdits(writerRes.content, task, {
          allowedDirs,
          protectedFiles,
          maxScopeIncrease,
          allowNewFiles,
          newFilesOnlyInScope,
          repoRoot: REPO_ROOT
        });

        if (!applyRes.ok) {
          const truncHint = writerRes.finishReason === 'length'
            ? ' [OUTPUT TRUNCATED AT max_tokens=16384 — Task is too large for 1 pass; split into smaller tasks (<150 lines)]'
            : '';
          const fullApplyErr = `${applyRes.error}${truncHint}${rawLogPath ? ` (raw output saved: ${path.relative(REPO_ROOT, rawLogPath)})` : ''}`;
          console.warn(`[Applier] ${fullApplyErr}`);
          if (writerRes.content) {
            console.warn(`[Applier Output Preview]:\n${writerRes.content.slice(0, 500)}`);
          }
          if (applyRes.security || applyRes.noRetry) {
            blockReason = fullApplyErr;
            task.status = 'blocked';
            rollback(getRollbackTargets());
            activeRollbackTargets = [];
            break;
          }

          const applyHash = hashString(applyRes.error);
          const failAction = handleStageFailure('apply', fullApplyErr, applyHash);
          if (failAction.shouldBreak) break;
          continue;
        }

        task.scope_expansions = applyRes.scope_expansions || task.scope_expansions;
        const allTaskFiles = Array.from(new Set([...task.scope, ...(task.scope_expansions || []), ...(applyRes.modified || [])]));
        actualModifiedFiles = getModifiedFiles(allTaskFiles);
        activeRollbackTargets = getRollbackTargets();

        updateLiveStatus({
          scope_files: allTaskFiles.map(f => ({
            path: f,
            status: actualModifiedFiles.includes(f) ? 'modified' : 'pending'
          }))
        });

        // Step C: Fast Validation (0-Token)
        task.status = 'validating';
        updateLiveStatus({
          current_stage: 'validator',
          stage_started_at: new Date().toISOString(),
          roles_status: {
            writer: { model: writerModel, status: 'done' },
            validator: { status: 'working' },
            reviewer: { status: 'idle' }
          }
        });

        const fastVal = await validateFast(projectConfig);
        if (!fastVal.ok) {
          console.warn(`[Validator] Fast check failed: ${fastVal.checkName}`);
          updateLiveStatus({
            roles_status: {
              writer: { model: writerModel, status: 'done' },
              validator: { status: 'failed' },
              reviewer: { status: 'idle' }
            }
          });
          const failAction = handleStageFailure('validate', fastVal.errorCombined, fastVal.errorHash);
          if (failAction.shouldBreak) break;
          continue;
        }

        // Step D: Suite Validation (0-Token)
        const suiteVal = await validateSuite(projectConfig);
        if (!suiteVal.ok) {
          console.warn(`[Validator] Suite check failed: ${suiteVal.checkName}`);
          updateLiveStatus({
            roles_status: {
              writer: { model: writerModel, status: 'done' },
              validator: { status: 'failed' },
              reviewer: { status: 'idle' }
            }
          });
          const failAction = handleStageFailure('validate', suiteVal.errorCombined, suiteVal.errorHash);
          if (failAction.shouldBreak) break;
          continue;
        }

        validationPassed = true;
        task.validation_result = { passed: true };

        updateLiveStatus({
          roles_status: {
            writer: { model: writerModel, status: 'done' },
            validator: { status: 'passed' },
            reviewer: { status: 'idle' }
          },
          scope_files: allTaskFiles.map(f => ({
            path: f,
            status: 'validated'
          }))
        });

        // Step E: Risk-Gated & Mode-Based Reviewer Gate
        // Only invokes AI Reviewer (Opus) when risk_level >= review_min_risk_level ('high'/'critical') or force_ai_review: true
        if (shouldRunReviewerGate(task, policyConfig.policy, teamConfig.roles)) {
          task.status = 'reviewing';
          updateLiveStatus({
            current_stage: 'reviewer',
            stage_started_at: new Date().toISOString(),
            roles_status: {
              writer: { model: writerModel, status: 'done' },
              validator: { status: 'passed' },
              reviewer: { model: teamConfig.roles?.reviewer?.model || 'ag/claude-opus-5-5-high', status: 'working' }
            }
          });

          const revRes = await runReviewerGate(task, actualModifiedFiles, previousReviewIssues);
          if (revRes.usage) {
            const rIn = revRes.usage.prompt_tokens || 0;
            const rOut = revRes.usage.completion_tokens || 0;
            taskTokensUsed += rIn + rOut;
            state.metrics.total_input_tokens = (state.metrics.total_input_tokens || 0) + rIn;
            state.metrics.total_output_tokens = (state.metrics.total_output_tokens || 0) + rOut;
          }
          if (revRes.reviewResult) {
            task.review_result = revRes.reviewResult;
          }
          if (!revRes.ok) {
            if (Array.isArray(revRes.reviewResult?.issues) && revRes.reviewResult.issues.length > 0) {
              previousReviewIssues = revRes.reviewResult.issues;
            }
            console.warn(`[Reviewer] ${revRes.error}`);
            updateLiveStatus({
              roles_status: {
                writer: { model: writerModel, status: 'done' },
                validator: { status: 'passed' },
                reviewer: { model: teamConfig.roles?.reviewer?.model || 'ag/claude-opus-5-5-high', status: 'rejected' }
              }
            });
            const revHash = hashString(revRes.error);
            const failAction = handleStageFailure('review', revRes.error, revHash);
            if (failAction.shouldBreak) break;
            continue;
          }
          updateLiveStatus({
            roles_status: {
              writer: { model: writerModel, status: 'done' },
              validator: { status: 'passed' },
              reviewer: { model: teamConfig.roles?.reviewer?.model || 'ag/claude-opus-5-5-high', status: 'approved' }
            }
          });
        } else {
          const minRisk = policyConfig.policy?.approval_gates?.review_min_risk_level || 'high';
          console.log(`[Reviewer] Skipped AI review for risk_level="${task.risk_level}" (below review_min_risk_level="${minRisk}"). Relying on 0-token Validator suite.`);
          updateLiveStatus({
            roles_status: {
              writer: { model: writerModel, status: 'done' },
              validator: { status: 'passed' },
              reviewer: { status: 'skipped' }
            }
          });
        }

        // Step F: Scoped Git Commit
        if (autoCommitOnDone && actualModifiedFiles.length > 0) {
          updateLiveStatus({
            current_stage: 'git',
            stage_started_at: new Date().toISOString()
          });
          const commitRes = commitDone(
            task.task_id,
            task.title || task.goal || 'complete task',
            commitPrefix,
            actualModifiedFiles
          );
          if (commitRes.ok) {
            task.commit_hash = commitRes.hash;
            activeRollbackTargets = [];
          } else {
            blockReason = `Git commit failed: ${commitRes.error}`;
            task.status = 'blocked';
            console.error(`[GitGuard] ${blockReason}`);
            break;
          }
        }

        activeRollbackTargets = [];
        isTaskDone = true;
        break;
      }
    } catch (err) {
      if (!blockReason) blockReason = err.message;
    } finally {
      activeRollbackTargets = [];
      // ==========================================
      // 3.2 POST-HOOK (0-Token Atomic Post-Report)
      // ==========================================
      const finalStatus = isTaskDone ? 'done' : (task.status === 'blocked' ? 'blocked' : 'failed');
      task.status = finalStatus;
      task.retries = retries;
      if (isTaskDone) {
        task.completed_at = new Date().toISOString();
      }

      task.last_report = {
        final_status: finalStatus,
        mode: task.mode || 'quick',
        modified_files: isTaskDone ? actualModifiedFiles : [],
        validation_passed: validationPassed,
        retries_used: retries,
        blocker_reason: blockReason || (isTaskDone ? null : `Exceeded max retries (${maxRetries})`),
        next_action: isTaskDone ? 'none' : (blockReason?.includes('approval') ? 'Need human approval' : 'Review task scope and constraints'),
        reported_at: new Date().toISOString()
      };

      if (isTaskDone) {
        state.completed_tasks = (state.completed_tasks || []).filter(t => (t.task_id || t.id) !== task.task_id);
        state.blocked_tasks = (state.blocked_tasks || []).filter(t => (t.task_id || t.id) !== task.task_id);
        state.completed_tasks.push(task);

        if (!fs.existsSync(ARCHIVE_TASKS_DIR)) {
          fs.mkdirSync(ARCHIVE_TASKS_DIR, { recursive: true });
        }
        const archivePath = path.resolve(ARCHIVE_TASKS_DIR, tFile);
        saveTaskAtomic(archivePath, task);
        if (fs.existsSync(taskPath)) fs.unlinkSync(taskPath);
      } else {
        task.block_reason = task.last_report.blocker_reason;
        state.blocked_tasks = (state.blocked_tasks || []).filter(t => (t.task_id || t.id) !== task.task_id);
        state.blocked_tasks.push(task);
        saveTaskAtomic(taskPath, task);
      }

      saveStateAtomic(state);
      writeMorningReport(state);

      updateLiveStatus({
        current_stage: isTaskDone ? 'done' : (task.status === 'blocked' ? 'blocked' : 'failed'),
        task_completed_at: isTaskDone ? task.completed_at : new Date().toISOString(),
        task_final_status: finalStatus,
        recovered_on_retry: isTaskDone && retries > 0,
        last_error: isTaskDone ? null : (blockReason || task.last_error || null),
        queue_stats: {
          active: fs.readdirSync(ACTIVE_TASKS_DIR).filter(f => f.endsWith('.yaml') || f.endsWith('.yml')).length,
          completed: (state.completed_tasks || []).length,
          blocked: (state.blocked_tasks || []).length
        }
      });

      // Print 1-line post-hook report to console
      const filesSummary = (task.last_report.modified_files || []).join(', ') || 'none';
      console.log(`[REPORT] ${task.task_id} | Mode: ${task.mode || 'quick'} | Status: ${finalStatus} | Files: ${filesSummary} | Validation: ${validationPassed} | Retries: ${retries}`);
    }
  }

  releaseLock();
  updateLiveStatus({
    active: false,
    current_stage: 'idle',
    stage_started_at: null
  });
  console.log(`\n[Orchestrator] Session finished. Report written to: state/morning-report.md`);
}

// Direct CLI start
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runOrchestrator().catch(err => {
    console.error('[Orchestrator] Fatal error:', err);
    releaseLock();
    process.exit(1);
  });
}
