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
  parseSearchReplaceBlocks,
  resolveRepoRoot
} from './applier.mjs';
import {
  commitDone,
  finalizeTaskCommitWithFrontendGate,
  formatDirtyWorktreeBlockMessage,
  getModifiedFiles,
  getScopedDiff,
  isCleanWorktree,
  rollback,
  safeRollback,
  snapshot
} from './git-guard.mjs';
import { buildValidationResult, detectVacuousNewTestsOnParent, evaluateDeletedIdentifierGate, extractNewlyAddedTestNamesByFile, hashString, runSingleValidationCheck, validateFast, validateStageChecks, validateSuite, verifyTestDiffIntegrity } from './validator.mjs';
import { isEnobufsFailure } from './lib/enobufs-diagnostics.mjs';
import { evaluateTaskExecutionRuntime, evaluateTaskOutcomeWithBaseline, extractFailingTestTargetsForRetry, formatFlakyBaselineReport, runBaselinePreflight, runSuiteValidationWithFastRetryFirst } from './lib/baseline-policy.mjs';
import { evaluatePostPatchSignatureGate } from './goal-planner.mjs';
import {
  archivePriorTaskSessions,
  buildTaskStepSessionId,
  createTaskRunId,
  formatPriorReadContext,
  mergeReadRanges,
  runAgent
} from '../runtime/index.mjs';
import { loadMergedPolicy, loadMergedTeamConfig, loadYamlSafe, resolveCockpitConfig, resolveConfigDir } from './lib/policy-loader.mjs';

// Modular Helpers (Giai đoạn 1: Tách Leaf Helpers ít rủi ro)
import {
  extractTaskKeywords,
  sliceContentByKeywords,
  sliceContentByKeywordsWithMeta,
  expandScopeItem,
  buildScopedFilesContext,
  buildScopedFilesContextWithMeta,
  measureEditedLinesOutsideWindow,
  buildWriterRetryInstruction,
  extractStructuredFailureBlocks,
  formatValidationErrorForRetry,
  buildRouterContext,
  buildRouterContextParts,
  buildReviewerPrompt,
  buildConsolidatedSpecsContext,
  generateRepoMap
} from './lib/context-builders.mjs';

import {
  DEFAULT_POLICY_CONFIG,
  mergePolicyWithDefaults,
  RISK_LEVEL_RANK,
  resolveEffectiveRisk,
  evaluatePostPatchDiffRisk,
  shouldRunReviewerGate,
  resolveTaskMode,
  resolveApiKey,
  validateConfig,
  verifyResponseModel,
  resolveThinkingBudget,
  CURRENT_ROUTING_VERSION,
  checkAndRefreshTaskRouting,
  resolveWriterHubWorkflow,
  resolveWriterSelection,
  resolveRuntimeWriterFallback,
  resolveConsultModelSelection,
  resolveSpecArtifactPath,
  resolveCoderMaxTurns,
  splitPatchStepsByOutputBudget,
  computeDynamicTaskTokenBudget
} from './lib/risk-policy.mjs';

import {
  acquireSingleInstanceLock,
  releaseSingleInstanceLock,
  runForceUnlockCli
} from './lib/runtime-lock.mjs';
import {
  RevisionRetryExhaustedError,
  mutateVersionedJsonAtomic,
  retryOnRevisionConflictSync
} from './lib/state-store.mjs';
import {
  isProcessAlive,
  RevisionConflictError,
  acquireLock as acquireLockBase,
  releaseLock as releaseLockBase,
  sanitizeTaskState,
  transitionTaskState,
  recordTaskStep,
  reconcileTaskTokens,
  estimateStepCostUsd,
  redactSecretsFromText,
  getOrchestratorVersionMetadata,
  reconstructTaskStepsFromArtifacts,
  normalizeTask as normalizeTaskBase,
  loadTaskStateStrict,
  saveTaskAtomic as saveTaskAtomicBase,
  saveStateAtomic as saveStateAtomicBase,
  mutateTaskStateAtomic as mutateTaskStateAtomicBase,
  saveAttemptPatchDiff,
  saveWriterRawOutput as saveWriterRawOutputBase,
  computeScopeHash,
  createPhaseTimingsTracker,
  finalizePhaseTimings
} from './lib/task-persistence.mjs';

import {
  computeCanonicalQueueState,
  syncCanonicalTaskState,
  writeMorningReportFile
} from './lib/queue-state.mjs';

import {
  check9RouterHealth as check9RouterHealthBase,
  check9RouterHealthWithRetry as check9RouterHealthWithRetryBase,
  formatWriterPreflightFallbackWarning,
  isBudgetExceededError,
  isModelCircuitBroken,
  runRosterPreflightPing as runRosterPreflightPingBase,
  summarizePreflightAttempts,
  call9Router as call9RouterBase
} from './lib/client-9router.mjs';
import { getCircuitBreakerSnapshot } from '../runtime/provider-gateway.mjs';
import { finalizeTaskExecution } from './orchestrator/task-finalize.mjs';
import { runTaskIntakeAndGates } from './orchestrator/task-intake.mjs';
import {
  SPEC_REUSE_ON_RETRY_ENABLED,
  applyPostPatchDiffRiskFloor,
  buildDraftSpecPrompts,
  capturePreRollbackValidationFailure,
  collectSpecExcerptsForConflict,
  evaluateContractConflictGate
} from './orchestrator/spec-and-conflict.mjs';
import {
  extractFirstBalancedJsonObject,
  resolveReviewStageOutcome,
  runReviewerGateCore,
  savePendingReviewPatch,
  writeDraftSpecArtifact
} from './orchestrator/reviewer-gate.mjs';

// Re-export leaf helpers to preserve 100% external API contract
export {
  extractTaskKeywords,
  sliceContentByKeywords,
  expandScopeItem,
  buildScopedFilesContext,
  formatValidationErrorForRetry,
  buildRouterContext,
  buildRouterContextParts,
  buildReviewerPrompt,
  generateRepoMap,
  DEFAULT_POLICY_CONFIG,
  mergePolicyWithDefaults,
  RISK_LEVEL_RANK,
  resolveEffectiveRisk,
  evaluatePostPatchDiffRisk,
  shouldRunReviewerGate,
  resolveTaskMode,
  resolveApiKey,
  validateConfig,
  verifyResponseModel,
  resolveWriterHubWorkflow,
  resolveWriterSelection,
  resolveRuntimeWriterFallback,
  resolveConsultModelSelection,
  resolveSpecArtifactPath,
  resolveCoderMaxTurns,
  splitPatchStepsByOutputBudget,
  computeDynamicTaskTokenBudget,
  isProcessAlive,
  sanitizeTaskState,
  transitionTaskState,
  recordTaskStep,
  reconcileTaskTokens,
  estimateStepCostUsd,
  redactSecretsFromText,
  getOrchestratorVersionMetadata,
  reconstructTaskStepsFromArtifacts,
  computeScopeHash,
  SPEC_REUSE_ON_RETRY_ENABLED,
  applyPostPatchDiffRiskFloor,
  buildDraftSpecPrompts,
  capturePreRollbackValidationFailure,
  evaluateContractConflictGate,
  extractFirstBalancedJsonObject,
  resolveReviewStageOutcome,
  savePendingReviewPatch,
  writeDraftSpecArtifact
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');

const LOCK_FILE = process.env.ORCHESTRATOR_LOCK_FILE
  ? path.resolve(process.env.ORCHESTRATOR_LOCK_FILE)
  : path.resolve(TEAM_DIR, '.orchestrator.lock');
const STATE_DIR = process.env.AGENT_TEAM_STATE_DIR
  ? path.resolve(process.env.AGENT_TEAM_STATE_DIR)
  : path.resolve(TEAM_DIR, 'state');
const TASKS_DIR = process.env.AGENT_TEAM_TASKS_DIR
  ? path.resolve(process.env.AGENT_TEAM_TASKS_DIR)
  : path.resolve(TEAM_DIR, 'tasks');
const STATE_FILE = path.resolve(STATE_DIR, 'task-state.json');
const REPORT_FILE = path.resolve(STATE_DIR, 'morning-report.md');
const LIVE_STATUS_FILE = path.resolve(STATE_DIR, 'live-status.json');
const ACTIVE_TASKS_DIR = path.resolve(TASKS_DIR, 'active');
const ARCHIVE_TASKS_DIR = path.resolve(TASKS_DIR, 'archive');

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
  tokens: { task_input: 0, task_output: 0, session_input: 0, session_output: 0, session_cached: 0, cache_hit_pct: 0 },
  updated_at: new Date().toISOString()
};

export function updateLiveStatus(patch = {}) {
  try {
    const nowIso = new Date().toISOString();
    const cbSnap = getCircuitBreakerSnapshot();
    liveStatus = {
      ...liveStatus,
      ...patch,
      circuit_broken_models: cbSnap.models,
      updated_at: nowIso
    };
    const saved = mutateVersionedJsonAtomic(LIVE_STATUS_FILE, (currentDisk) => ({
      ...currentDisk,
      ...liveStatus,
      ...patch,
      circuit_broken_models: cbSnap.models,
      recent_logs: [...consoleRingBuffer],
      updated_at: nowIso
    }), {
      allowCorruptFallback: true,
      fallbackFactory: () => ({ ...liveStatus })
    });
    liveStatus.revision = saved.revision;
  } catch {
    // Non-throwing telemetry: write contention/EPERM must NEVER crash orchestrator
  }
}

// 1. Lock File Management (delegated to lib/runtime-lock.mjs + lib/task-persistence.mjs)
let activeLockInstanceId = null;

export function acquireLock(lockFilePath = LOCK_FILE, options = {}) {
  const res = acquireSingleInstanceLock(lockFilePath, {
    role: 'orchestrator',
    port: null,
    ...options
  });
  if (!res.ok) {
    console.error(res.message);
    return false;
  }
  if (path.resolve(lockFilePath) === path.resolve(LOCK_FILE)) {
    activeLockInstanceId = res.lock.instance_id;
  }
  return true;
}

export function releaseLock(lockFilePath = LOCK_FILE, options = {}) {
  const isDefault = path.resolve(lockFilePath) === path.resolve(LOCK_FILE);
  const instanceId = options.instanceId ?? (isDefault ? activeLockInstanceId : undefined);
  if (isDefault && !instanceId) {
    return false;
  }
  const released = releaseSingleInstanceLock(lockFilePath, { ...options, instanceId });
  if (released && isDefault) {
    activeLockInstanceId = null;
  }
  return released;
}

// 2. Atomic State & Task Management (delegated to lib/task-persistence.mjs)
function loadState() {
  return loadTaskStateStrict(STATE_FILE);
}

function saveStateAtomic(state) {
  return saveStateAtomicBase(STATE_FILE, state);
}

function mergeTaskRecordOnConflict(diskTask = {}, localTask = {}) {
  const diskStatus = String(diskTask?.status || '').toLowerCase();
  const localStatus = String(localTask?.status || '').toLowerCase();

  let status;
  const isDoneStatus = (s) => s === 'done' || s === 'done_with_known_failures';
  if (isDoneStatus(localStatus) || isDoneStatus(diskStatus)) {
    status = (localStatus === 'done' || diskStatus === 'done') ? 'done' : 'done_with_known_failures';
  } else if (
    diskTask?.retried_at &&
    localTask?.updated_at &&
    String(diskTask.retried_at) > String(localTask.updated_at)
  ) {
    status = diskTask.status || localTask.status || 'ready';
  } else {
    status = localTask?.status || diskTask?.status || 'ready';
  }

  const seenErrKeys = new Set();
  const mergedHistory = [];
  for (const entry of [...(diskTask?.error_history || []), ...(localTask?.error_history || [])]) {
    const key = typeof entry === 'object' && entry !== null ? JSON.stringify(entry) : String(entry);
    if (!seenErrKeys.has(key)) {
      seenErrKeys.add(key);
      mergedHistory.push(entry);
    }
  }

  const merged = {
    ...diskTask,
    ...localTask,
    status
  };

  if (mergedHistory.length > 0 || Array.isArray(diskTask?.error_history) || Array.isArray(localTask?.error_history)) {
    merged.error_history = mergedHistory;
  }

  const diskTok = Number(diskTask?.tokens_used);
  const localTok = Number(localTask?.tokens_used);
  if (diskTask?.tokens_used !== undefined || localTask?.tokens_used !== undefined) {
    merged.tokens_used = Math.max(
      Number.isFinite(diskTok) ? diskTok : 0,
      Number.isFinite(localTok) ? localTok : 0
    );
  }

  if (status === 'done' || status === 'done_with_known_failures') {
    delete merged.last_error;
    delete merged.block_reason;
    delete merged.preserve_worktree;
    delete merged.commit_error;
    delete merged.preserved_files;
  } else {
    const resolvedErr = localTask?.last_error ?? diskTask?.last_error;
    if (resolvedErr !== undefined && resolvedErr !== null && resolvedErr !== '') {
      merged.last_error = resolvedErr;
    } else {
      delete merged.last_error;
    }
    const resolvedBlock = localTask?.block_reason ?? diskTask?.block_reason;
    if (resolvedBlock !== undefined && resolvedBlock !== null && resolvedBlock !== '') {
      merged.block_reason = resolvedBlock;
    }
    if (status === 'blocked' && (localTask?.preserve_worktree === true || diskTask?.preserve_worktree === true)) {
      merged.preserve_worktree = true;
      const resolvedCommitErr = localTask?.commit_error ?? diskTask?.commit_error;
      if (resolvedCommitErr) merged.commit_error = resolvedCommitErr;
      const rawPreserved = Array.isArray(localTask?.preserved_files) && localTask.preserved_files.length > 0
        ? localTask.preserved_files
        : (Array.isArray(diskTask?.preserved_files) ? diskTask.preserved_files : []);
      if (rawPreserved.length > 0) {
        merged.preserved_files = Array.from(new Set(rawPreserved.map(f => String(f || '').trim()).filter(Boolean)));
      }
    } else {
      delete merged.preserve_worktree;
      delete merged.commit_error;
      delete merged.preserved_files;
    }
  }

  return merged;
}

/**
 * Deterministic Per-Field State Merge Law on RevisionConflictError:
 *  - active/completed/blocked lists: union by task_id across disk + incoming, mutually exclusive by merged `status`
 *    (done -> completed_tasks; blocked/failed -> blocked_tasks; otherwise -> active_tasks).
 *  - status: terminal `done` wins over non-done; concurrent disk retry newer than local updated_at wins; else local.
 *  - error_history: ordered deduplicated union (disk entries + local entries).
 *  - last_error: deleted when merged status === 'done'; otherwise keeps freshest non-empty error.
 *  - tokens_used & metrics accumulators: monotonic non-decreasing max across disk and local.
 */
export function mergeTaskStateOnConflict(diskState = {}, incomingState = {}) {
  const indexList = (map, arr, fallbackStatus) => {
    for (const raw of (arr || [])) {
      const id = typeof raw === 'string' ? raw : (raw?.task_id || raw?.id);
      if (!id) continue;
      const item = typeof raw === 'string'
        ? { task_id: id, status: fallbackStatus }
        : { ...raw, task_id: id, status: raw.status || fallbackStatus };
      map.set(id, item);
    }
  };

  const diskMap = new Map();
  indexList(diskMap, diskState.active_tasks, 'ready');
  indexList(diskMap, diskState.blocked_tasks, 'blocked');
  indexList(diskMap, diskState.completed_tasks, 'done');

  const localMap = new Map();
  indexList(localMap, incomingState.active_tasks, 'ready');
  indexList(localMap, incomingState.blocked_tasks, 'blocked');
  indexList(localMap, incomingState.completed_tasks, 'done');

  const allIds = new Set([...diskMap.keys(), ...localMap.keys()]);
  const completed_tasks = [];
  const blocked_tasks = [];
  const active_tasks = [];

  for (const id of allIds) {
    const dTask = diskMap.get(id);
    const lTask = localMap.get(id);
    const mergedTask = (dTask && lTask)
      ? mergeTaskRecordOnConflict(dTask, lTask)
      : (lTask ? mergeTaskRecordOnConflict({}, lTask) : mergeTaskRecordOnConflict({}, dTask));
    const st = String(mergedTask.status || '').toLowerCase();
    if (st === 'done' || st === 'done_with_known_failures') {
      completed_tasks.push(mergedTask);
    } else if (st === 'blocked' || st === 'failed') {
      blocked_tasks.push(mergedTask);
    } else {
      active_tasks.push(mergedTask);
    }
  }

  const mergedMetrics = { ...(diskState.metrics || {}), ...(incomingState.metrics || {}) };
  for (const metricKey of [
    'total_input_tokens',
    'total_output_tokens',
    'total_cached_tokens',
    'total_cost_est_usd',
    'total_runs',
    'total_retries'
  ]) {
    const dVal = Number(diskState.metrics?.[metricKey]);
    const lVal = Number(incomingState.metrics?.[metricKey]);
    if (diskState.metrics?.[metricKey] !== undefined || incomingState.metrics?.[metricKey] !== undefined) {
      mergedMetrics[metricKey] = Math.max(
        Number.isFinite(dVal) ? dVal : 0,
        Number.isFinite(lVal) ? lVal : 0
      );
    }
  }

  return sanitizeTaskState({
    ...diskState,
    ...incomingState,
    version: incomingState.version || diskState.version || '2.1',
    active_tasks,
    completed_tasks,
    blocked_tasks,
    metrics: mergedMetrics,
    last_run: incomingState.last_run || diskState.last_run
  });
}

export function persistTaskStateWithConflictRecovery({
  state,
  stateFilePath = STATE_FILE,
  saveFn = (s) => saveStateAtomic(s),
  mergeFn,
  retryOptions = {},
  liveStatusUpdater = updateLiveStatus,
  logger = console.error
} = {}) {
  try {
    const saved = saveFn(state);
    if (saved && typeof saved === 'object') {
      Object.assign(state, saved);
    }
    return saved || state;
  } catch (stateErr) {
    if (!(stateErr instanceof RevisionConflictError || stateErr?.code === 'REVISION_CONFLICT')) {
      throw stateErr;
    }
    const effectiveRetryOptions = {
      maxRetries: 4,
      baseDelayMs: 25,
      maxDelayMs: 250,
      jitterRatio: 0.25,
      ...retryOptions
    };
    try {
      const mergedSaved = retryOnRevisionConflictSync(() => {
        if (typeof mergeFn === 'function') {
          return mergeFn(state);
        }
        return mutateTaskStateAtomicBase(stateFilePath, (latestDiskState) => (
          mergeTaskStateOnConflict(latestDiskState, state)
        ));
      }, effectiveRetryOptions);
      if (mergedSaved && typeof mergedSaved === 'object') {
        Object.assign(state, mergedSaved);
      }
      return mergedSaved || state;
    } catch (retryErr) {
      if (retryErr instanceof RevisionRetryExhaustedError || retryErr?.code === 'REVISION_RETRY_EXHAUSTED') {
        const msg = `[Orchestrator] CRITICAL: State persistence exhausted revision conflict retries (${retryErr.attempts} attempts, maxRetries=${retryErr.maxRetries}) on "${retryErr.filePath}": expected revision ${retryErr.expectedRevision}, found ${retryErr.actualRevision}. Aborting fail-loud without overwriting newer state.`;
        logger(msg);
        liveStatusUpdater({
          active: false,
          current_stage: 'blocked',
          stage_started_at: null,
          revision_conflict_exhausted: true,
          last_error: msg
        });
      }
      throw retryErr;
    }
  }
}

export function handleOrchestratorFatalError(err, {
  liveStatusUpdater = updateLiveStatus,
  releaseLockFn = releaseLock,
  logger = console.error
} = {}) {
  const isExhausted = Boolean(err && (err instanceof RevisionRetryExhaustedError || err.code === 'REVISION_RETRY_EXHAUSTED'));
  if (isExhausted) {
    logger(`[Orchestrator] Exiting non-zero due to RevisionRetryExhaustedError on "${err.filePath}" (attempts=${err.attempts}, expected=${err.expectedRevision}, actual=${err.actualRevision}).`);
  } else {
    logger('[Orchestrator] Fatal error:', err);
  }
  liveStatusUpdater({
    active: false,
    current_stage: isExhausted ? 'blocked' : 'failed',
    stage_started_at: null,
    ...(isExhausted ? { revision_conflict_exhausted: true } : {}),
    last_error: err?.message || String(err)
  });
  releaseLockFn();
  return { code: 1, isRevisionExhausted: isExhausted };
}

export function evaluateValidationTrust({
  fastVal = null,
  suiteVal = null,
  envFingerprint = null,
  baselineFingerprint = null
} = {}) {
  const validationResult = buildValidationResult({
    fastVal,
    suiteVal,
    envFingerprint,
    baselineFingerprint
  });
  if (validationResult.environment_mismatch) {
    const mismatchFields = Array.isArray(validationResult.environment_mismatch_fields)
      ? validationResult.environment_mismatch_fields
      : [];
    const detail = mismatchFields.length > 0 ? mismatchFields.join(', ') : 'unknown_fields';
    const errorMessage = `[Validator] FAIL-CLOSED: Refusing validation result due to environment_mismatch (${detail})`;
    return {
      ok: false,
      trusted: false,
      blocked: true,
      reason: 'environment_mismatch',
      errorMessage,
      validationResult
    };
  }
  const ok = Boolean(validationResult.passed && validationResult.trusted !== false);
  return {
    ok,
    trusted: validationResult.trusted !== false,
    blocked: false,
    reason: ok ? null : (validationResult.status || 'validation_failed'),
    errorMessage: ok ? null : (validationResult.note || 'Validation failed'),
    validationResult
  };
}

export function normalizeTask(parsed) {
  return normalizeTaskBase(parsed, policyConfig?.policy?.project_id || 'my-workspace');
}

function saveTaskAtomic(taskPath, taskData) {
  return saveTaskAtomicBase(taskPath, taskData);
}

// 3. Load Configurations (Merged + Fail-Closed on base policy.yaml / team.yaml)
function loadYaml(filePath) {
  return loadYamlSafe(filePath);
}

const activeConfigDir = resolveConfigDir();
const teamConfig = loadMergedTeamConfig({ configDir: activeConfigDir });
const rawPolicyConfig = loadMergedPolicy({ configDir: activeConfigDir });
const policyConfig = { policy: mergePolicyWithDefaults(rawPolicyConfig) };
const REPO_ROOT = resolveRepoRoot(policyConfig);

function sanitizeGoal(str = '') {
  return str.replace(/[\r\n\x1B]/g, ' ').slice(0, 80).trim();
}

export async function check9RouterHealth(teamCfg = teamConfig, policyCfg = policyConfig) {
  return check9RouterHealthBase(teamCfg, policyCfg);
}

export async function check9RouterHealthWithRetry(teamCfg = teamConfig, policyCfg = policyConfig, delaysMs = [0, 5000, 15000]) {
  return check9RouterHealthWithRetryBase(teamCfg, policyCfg, delaysMs);
}

export function saveWriterRawOutput(taskId, attemptNum, writerRes = {}) {
  return saveWriterRawOutputBase(taskId, attemptNum, writerRes, TEAM_DIR);
}

async function attachIsolatedEnobufsRetries(checkList = [], stageName = 'suite_checks', policyCfg = {}) {
  const out = [];
  for (const check of (checkList || [])) {
    if (check && check.ok === false && isEnobufsFailure(check.errorCombined || '') && check.command) {
      const retryRes = await runSingleValidationCheck(
        { name: check.checkName || check.check_name || 'enobufs_retry', run: check.command },
        stageName,
        policyCfg,
        check.env_fingerprint || null
      );
      out.push({
        ...check,
        isolated_retry_passed: Boolean(retryRes.ok)
      });
    } else {
      out.push(check);
    }
  }
  return out;
}

function getAdjustedPromptTokens(usage = {}) {
  return Number(usage?.prompt_tokens_adjusted ?? usage?.prompt_tokens ?? 0);
}

function accumulateTaskAndStateUsage(state, usage = {}, taskTokensUsedRef = 0) {
  const inTok = getAdjustedPromptTokens(usage);
  const outTok = Number(usage?.completion_tokens || 0);
  const cachedTok = Number(usage?.cached_tokens || 0);
  if (state?.metrics) {
    state.metrics.total_input_tokens = (state.metrics.total_input_tokens || 0) + inTok;
    state.metrics.total_output_tokens = (state.metrics.total_output_tokens || 0) + outTok;
    state.metrics.total_cached_tokens = (state.metrics.total_cached_tokens || 0) + cachedTok;
  }
  return taskTokensUsedRef + inTok + outTok;
}

function extractUsageTelemetryFields(res = {}) {
  const usage = res.usage || {};
  return {
    prompt_tokens: usage.prompt_tokens || 0,
    prompt_tokens_raw: usage.prompt_tokens_raw ?? usage.prompt_tokens ?? 0,
    prompt_tokens_adjusted: getAdjustedPromptTokens(usage),
    usage_adjusted_buffer: usage.usage_adjusted_buffer || 0,
    fresh_tokens: usage.fresh_tokens ?? usage.uncached_input_tokens ?? getAdjustedPromptTokens(usage),
    cached_tokens: usage.usage_quality === 'degraded' ? null : (usage.reported_cached_tokens ?? null),
    cache_reported: usage.cache_reported ?? false,
    usage_quality: usage.usage_quality || (res.raw_usage ? 'full' : 'standard'),
    usage_adjusted: Boolean(usage.usage_adjusted),
    completion_tokens: usage.completion_tokens || 0,
    reasoning_tokens: usage.reasoning_tokens || 0,
    raw_usage: res.raw_usage ?? null
  };
}

async function call9Router(model, systemPrompt, userMessage, maxTokens = 4096, fallbackModel = null, temperature = 0.1, options = {}) {
  return call9RouterBase(model, systemPrompt, userMessage, maxTokens, fallbackModel, temperature, {
    ...options,
    teamConfig,
    policyConfig
  });
}

// 4c. Router Planner (Populates scope & acceptance_criteria when task is in 'draft' status)
async function runRouterPlanner(task) {
  const routerRole = teamConfig.roles?.router || {};
  if (routerRole.enabled === false) {
    return { ok: false, error: 'Router role is disabled in team.yaml' };
  }

  const routerModel = routerRole.model || routerRole.default_model;
  if (!routerModel) {
    return { ok: false, error: 'Router role has no model configured in team.yaml. Stopping instead of falling back to writer.' };
  }
  const routerFallback = routerRole.fallback_model || null;
  const routerTemp = routerRole.temperature ?? 0.2;
  const routerMaxThinking = routerRole.max_thinking_tokens;
  const routerSystemPrompt = fs.existsSync(path.resolve(TEAM_DIR, 'roles', 'router.md'))
    ? fs.readFileSync(path.resolve(TEAM_DIR, 'roles', 'router.md'), 'utf8')
    : 'Analyze the goal and return JSON { "plan": [], "scope": [], "acceptance_criteria": [] }.';

  const allowedDirs = policyConfig.policy?.scope_control?.allowed_dirs
    || policyConfig.policy?.allowed_dirs
    || ['*'];
  const routerQuery = `${task.title || ''} ${task.goal || ''}`.trim();
  const ctxParts = buildRouterContextParts(allowedDirs, REPO_ROOT, 300, routerQuery, [], {
    staticRepoMap: true
  });
  const prompt = [
    `ALLOWED DIRECTORIES: ${allowedDirs.join(', ')}`,
    ctxParts.staticText || '',
    `Select only existing file paths from AVAILABLE WORKSPACE FILES (or valid new test/module paths inside ALLOWED DIRECTORIES). Return strict JSON with keys: plan, scope, acceptance_criteria.`,
    ctxParts.dynamicText || '',
    `TASK ID: ${task.task_id}`,
    `TITLE: ${task.title || ''}`,
    `GOAL: ${task.goal || task.title || ''}`
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

// 5b. Reviewer Gate (Executed only in 'standard' mode when require_code_review is true; core logic in orchestrator/reviewer-gate.mjs)
export async function runReviewerGate(task, scopedFiles, previousReviewIssues = [], activeWriterModel = null, options = {}) {
  return runReviewerGateCore(task, scopedFiles, previousReviewIssues, activeWriterModel, {
    teamConfig,
    repoRoot: REPO_ROOT,
    teamDir: TEAM_DIR,
    callModel: call9Router,
    ...options
  });
}

// 6. Morning Report Generator
export function writeMorningReport(state, options = {}) {
  return writeMorningReportFile(state, {
    tasksActiveDir: options.tasksActiveDir || ACTIVE_TASKS_DIR,
    tasksArchiveDir: options.tasksArchiveDir || ARCHIVE_TASKS_DIR,
    reportFile: options.reportFile || REPORT_FILE
  });
}

// 7. Main Orchestrator Loop
async function runOrchestrator() {
  const cfgValidation = validateConfig(teamConfig, policyConfig);
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
        safeRollback(activeRollbackTargets);
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
  const allowedDirs = policyConfig.policy?.scope_control?.allowed_dirs
    || policyConfig.policy?.allowed_dirs
    || ['*'];
  const protectedFiles = policyConfig.policy?.scope_control?.protected_files
    || policyConfig.policy?.protected_files
    || [];

  if (!fs.existsSync(ACTIVE_TASKS_DIR)) {
    fs.mkdirSync(ACTIVE_TASKS_DIR, { recursive: true });
  }
  const taskFiles = fs.readdirSync(ACTIVE_TASKS_DIR).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

  const initialQueue = computeCanonicalQueueState({
    tasksActiveDir: ACTIVE_TASKS_DIR,
    tasksArchiveDir: ARCHIVE_TASKS_DIR,
    taskState: state
  });

  if (taskFiles.length === 0) {
    console.log(`\n======================================================`);
    console.log(`💡 [HÀNG ĐỢI RỖNG - HƯỚNG DẪN GIAO VIỆC CHO ĐỘI NGŨ AI]`);
    console.log(`======================================================`);
    console.log(`Thư mục "tasks/active/" hiện chưa có task nào.`);
    console.log(`Bạn đã cấu hình xong môi trường! Giờ hãy giao việc bằng 1 trong các cách:\n`);
    console.log(`👉 CÁCH 1 (Khuyên dùng - Bàn điều khiển Web 1-Chạm):`);
    console.log(`   npm run dashboard`);
    console.log(`   -> Mở ${resolveCockpitConfig({ policyConfig, configDir: activeConfigDir }).url} -> Nhập mục tiêu -> Bấm Phê Duyệt & Chạy!\n`);
    console.log(`👉 CÁCH 2 (AI Architect tự sinh task qua CLI):`);
    console.log(`   npm run plan -- "Mô tả tính năng bạn muốn làm"`);
    console.log(`   -> AI sẽ tự bóc tách ra task YAML trong tasks/active/\n`);
    console.log(`👉 CÁCH 3 (Tương tác trực tiếp với 1 Agent độc lập):`);
    console.log(`   npm run agent -- --role writer --prompt "Nhiệm vụ của bạn"`);
    console.log(`======================================================\n`);
    updateLiveStatus({ active: false, current_stage: 'idle', queue_stats: initialQueue.counts });
    releaseLock();
    process.exit(0);
  }

  console.log(`[Orchestrator] Found ${taskFiles.length} task(s) in tasks/active/`);

  updateLiveStatus({
    active: true,
    pid: process.pid,
    current_stage: 'preflight',
    stage_started_at: new Date().toISOString(),
    queue_stats: initialQueue.counts,
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

  // Pre-flight Squad Check: Ensure team.yaml has at least one active model
  const activeRolesCount = Object.keys(teamConfig.roles || {}).filter(k => teamConfig.roles[k]?.enabled !== false && teamConfig.roles[k]?.model).length;
  if (taskFiles.length > 0 && activeRolesCount === 0) {
    const errSquad = 'Đội ngũ AI trong team.yaml rỗng (chưa cấu hình model nào)! Vui lòng mở giao diện Cấu hình để thêm thành viên trước khi chạy.';
    console.error(`[Orchestrator] Pre-flight squad check FAILED: ${errSquad}`);
    updateLiveStatus({ active: false, current_stage: 'blocked', last_error: errSquad });
    releaseLock();
    process.exit(1);
  }

  // Pre-flight Roster 1-Token Ping: fail loudly on any broken model unless writer has healthy fallback
  const preflightFailedModels = new Set();
  let rosterPreflightResult = null;
  let preflightDurationMs = 0;
  if (taskFiles.length > 0) {
    const preflightStartMs = Date.now();
    const rosterPreflight = await runRosterPreflightPingBase(teamConfig, policyConfig);
    preflightDurationMs = Math.max(0, Date.now() - preflightStartMs);
    rosterPreflightResult = rosterPreflight;
    for (const fm of (rosterPreflight.failed_models || [])) {
      if (fm?.model) preflightFailedModels.add(fm.model);
    }
    if (!rosterPreflight.ok) {
      const onlyWriterFailed = (rosterPreflight.failed_models || []).length > 0
        && (rosterPreflight.failed_models || []).every(fm => Array.isArray(fm.roles) && fm.roles.every(r => r === 'writer'));
      const writerFallbackProbe = onlyWriterFailed
        ? resolveWriterSelection({}, teamConfig, { preflightFailedModels, isCircuitBrokenFn: isModelCircuitBroken })
        : { ok: false };
      if (writerFallbackProbe.ok && writerFallbackProbe.selected_by === 'fallback') {
        console.warn(formatWriterPreflightFallbackWarning(rosterPreflight, writerFallbackProbe));
      } else {
        const errMsg = rosterPreflight.errors.join(' | ');
        console.error(`[Orchestrator] Pre-flight roster model ping FAILED:\n  - ${rosterPreflight.errors.join('\n  - ')}`);
        updateLiveStatus({ active: false, current_stage: 'blocked', last_error: errMsg });
        releaseLock();
        process.exit(1);
      }
    } else {
      const calSummary = (rosterPreflight.buffer_calibrations || [])
        .map(c => `${c.model}=${c.calibration_flag}`)
        .join(', ');
      console.log(`[Orchestrator] Pre-flight roster ping passed (${rosterPreflight.checked_models.length} active model(s))${calSummary ? ` | calibration: [${calSummary}]` : ''}.`);
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
    const autoApprove = process.argv.includes('--approve') || process.argv.includes('-y');
    if (initialStatus === 'draft_review') {
      if (autoApprove) {
        console.log(`[APPROVE] Auto-approving ${tFile} (--approve flag detected). Status changed to 'ready'.`);
        task.status = 'ready';
        task.updated_at = new Date().toISOString();
        if (parsed.task && typeof parsed.task === 'object') {
          parsed.task.status = 'ready';
          parsed.task.updated_at = task.updated_at;
        } else {
          parsed.status = 'ready';
          parsed.updated_at = task.updated_at;
        }
        fs.writeFileSync(taskPath, YAML.stringify(parsed), 'utf8');
      } else {
        console.log(`[Orchestrator] Skipping ${tFile} (status="draft_review"). Awaits approval on Dashboard (:${resolveCockpitConfig({ policyConfig, configDir: activeConfigDir }).port}) or run 'npm start -- --approve' to execute.`);
        continue;
      }
    } else if (initialStatus === 'blocked' || initialStatus === 'done' || initialStatus === 'done_with_known_failures' || initialStatus === 'awaiting_confirmation') {
      console.log(`[Orchestrator] Skipping ${tFile} (status="${initialStatus}").${initialStatus === 'awaiting_confirmation' ? ' Waiting for user confirmation before merging pending frontend branch.' : ' Reset status to "ready" to re-run.'}`);
      continue;
    }

    let retries = 0;
    let lastErrorHash = null;
    let consecutiveIdenticalErrors = 0;
    let taskTokensUsed = 0;
    const stateTokensBeforeTask = (state.metrics?.total_input_tokens || 0) + (state.metrics?.total_output_tokens || 0);
    if (Array.isArray(task.steps) && task.steps.length > 0) {
      task.steps_history = [...(task.steps_history || []), ...task.steps];
    }
    task.steps = [];
    task.tokens_used = 0;
    let isTaskDone = false;
    let finalSuccessStatus = 'done';
    let blockReason = null;
    let validationPassed = null;
    let actualModifiedFiles = [];
    let previousReviewIssues = [];
    // Opt-in safety net (default: keep current behaviour). Set to true only by exit paths that must not leave a dirty worktree.
    let rollbackOnExit = false;
    // Set when the work passed every gate but could not be committed: `finally` must NOT roll it back (D2).
    let preserveWorktreeOnExit = false;
    const taskStartMs = Date.now();
    const taskRunId = createTaskRunId(taskStartMs);
    const phaseTracker = createPhaseTimingsTracker({ preflight_ms: preflightDurationMs });
    task.run_id = taskRunId;
    // A re-run starts from a clean slate: stale D2 markers from a previous blocked commit must not leak.
    delete task.preserve_worktree;
    delete task.commit_error;
    delete task.preserved_files;
    archivePriorTaskSessions({
      taskId: task.task_id,
      currentRunId: taskRunId,
      sessionsDir: path.resolve(STATE_DIR, 'sessions'),
      runsDir: path.resolve(STATE_DIR, 'runs')
    });

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
      const intakeRes = await runTaskIntakeAndGates({
        task,
        state,
        taskRunId,
        taskTokensUsed,
        phaseTracker,
        teamConfig,
        policyConfig,
        limits: {
          maxFilesPerTask,
          requireCrossRoleApproval,
          requireCleanBeforeStart,
          allowedDirs,
          protectedFiles
        },
        paths: {
          repoRoot: REPO_ROOT,
          teamDir: TEAM_DIR,
          stateDir: STATE_DIR
        },
        callbacks: {
          updateLiveStatusFn: updateLiveStatus,
          runRouterPlannerFn: runRouterPlanner,
          runAgentFn: runAgent,
          accumulateTaskAndStateUsageFn: accumulateTaskAndStateUsage,
          getAdjustedPromptTokensFn: getAdjustedPromptTokens,
          sanitizeGoalFn: sanitizeGoal
        }
      });
      taskTokensUsed = intakeRes.tokensUsed;
      if (intakeRes.outcome === 'consult_done') {
        validationPassed = true;
        actualModifiedFiles = [];
        isTaskDone = true;
        continue;
      }
      if (intakeRes.outcome === 'blocked') {
        blockReason = intakeRes.blockReason;
        task.status = 'blocked';
        throw new Error(blockReason);
      }
      const {
        baselineResult,
        baselineFingerprint,
        baselineDurationMs,
        allowExpansion
      } = intakeRes;

      // Start task execution runtime clock AFTER baseline preflight finishes
      const taskExecutionStartMs = Date.now();

      // ==========================================
      // 3.1 PRE-HOOK (0-Token, Exactly 1 Console Line)
      // ==========================================
      const cleanGoal = sanitizeGoal(task.goal || task.title);
      console.log(`[START] ${task.task_id} | Mode: ${task.mode} | Goal: ${cleanGoal} | Scope: ${task.scope.join(', ')} | Allow-expansion: ${allowExpansion}`);

      snapshot();

      // Helper to mark validation_status on current attempt's apply_patch steps
      const markAttemptPatchValidationStatus = (attemptNum, statusLabel) => {
        if (!Array.isArray(task.steps)) return;
        for (const st of task.steps) {
          if (st && Number(st.attempt) === attemptNum && String(st.action || '').startsWith('apply_patch')) {
            st.validation_status = statusLabel;
          }
        }
      };

      let lastGeneratedSpecs = [];
      let lastValidationChecks = [];

      // Helper to record validation/review errors and enforce identical-error loop breaker
      const handleStageFailure = (stageName, errSummary, errHash) => {
        validationPassed = stageName === 'review' ? true : false;
        const attemptNum = retries + 1;
        if (stageName === 'validate') {
          markAttemptPatchValidationStatus(attemptNum, 'failed');
        }

        let conciseErr = '';
        let conflictResult = { contractConflict: false };
        if (stageName === 'validate') {
          const nextTargets = extractFailingTestTargetsForRetry(errSummary, lastValidationChecks);
          if (nextTargets.length > 0) {
            task.previous_failing_tests = nextTargets;
          }
          const rollbackTargets = getRollbackTargets();
          let preRollbackDiff = '';
          if (rollbackTargets.length > 0) {
            try {
              preRollbackDiff = getScopedDiff(rollbackTargets, { cwd: REPO_ROOT }) || '';
            } catch {}
          }
          conflictResult = evaluateContractConflictGate({
            task,
            attemptNum,
            errSummary,
            diffText: preRollbackDiff,
            targets: rollbackTargets,
            specPaths: lastGeneratedSpecs,
            repoRoot: REPO_ROOT
          });
          const captured = capturePreRollbackValidationFailure({
            task,
            attemptNum,
            errSummary,
            targets: rollbackTargets,
            diffText: preRollbackDiff,
            repoRoot: REPO_ROOT,
            teamDir: TEAM_DIR,
            rollbackFn: rollback,
            shouldRollback: rollbackOnValidationFail
          });
          conciseErr = captured.conciseErr;
          if (rollbackOnValidationFail) {
            activeRollbackTargets = [];
          }
          if (captured.patchPath) {
            console.log(`[Validator] Saved attempt-${attemptNum} patch diff before rollback: ${path.relative(REPO_ROOT, captured.patchPath).replace(/\\/g, '/')}`);
          }
        } else {
          conciseErr = String(errSummary || '');
          if (rollbackOnValidationFail) {
            rollback(getRollbackTargets());
            activeRollbackTargets = [];
          }
        }

        task.error_history.push({
          attempt: attemptNum,
          stage: stageName,
          error_hash: errHash,
          summary: conciseErr.slice(-600)
        });

        if (conflictResult.contractConflict) {
          blockReason = conflictResult.blockReason || task.block_reason || 'Contract conflict detected';
          console.error(`[Validator] CONTRACT CONFLICT DETECTED: ${blockReason}`);
          return { shouldBreak: true, contractConflict: true };
        }

        if (errHash === lastErrorHash) {
          consecutiveIdenticalErrors++;
        } else {
          lastErrorHash = errHash;
          consecutiveIdenticalErrors = 1;
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

      const rejectUntrustedValidation = (trustGate) => {
        task.validation_result = trustGate.validationResult;
        blockReason = trustGate.errorMessage || '[Validator] FAIL-CLOSED: Refusing untrusted validation environment';
        task.last_error = blockReason;
        task.error_history.push({
          attempt: retries + 1,
          stage: 'validate_env',
          error_hash: trustGate.validationResult?.error_hash || hashString(blockReason),
          summary: blockReason.slice(-600)
        });
        task.status = 'blocked';
        console.error(blockReason);
        if (rollbackOnValidationFail) {
          rollback(getRollbackTargets());
          activeRollbackTargets = [];
        }
        updateLiveStatus({
          roles_status: {
            writer: { model: writerModel, status: 'done' },
            validator: { status: 'failed' },
            reviewer: { status: 'idle' }
          }
        });
      };

      const stopOnBaselineBlock = (evalRes, currentWriterModel = null) => {
        blockReason = evalRes.block_reason || evalRes.reason || 'preexisting_failure';
        task.last_error = blockReason;
        if (Array.isArray(evalRes.known_failures)) {
          task.known_failures = evalRes.known_failures;
        }
        task.error_history.push({
          attempt: retries + 1,
          stage: evalRes.reason === 'environment_mismatch' ? 'validate_env' : 'validate',
          error_hash: hashString(blockReason),
          summary: blockReason.slice(-600)
        });
        task.status = 'blocked';
        console.error(`[Validator] Stopped immediately (0 extra retries): ${blockReason}`);
        if (rollbackOnValidationFail) {
          rollback(getRollbackTargets());
          activeRollbackTargets = [];
        }
        updateLiveStatus({
          roles_status: {
            writer: { model: currentWriterModel, status: 'done' },
            validator: { status: 'failed' },
            reviewer: { status: 'idle' }
          }
        });
      };

      const modeConfig = policyConfig.policy?.task_modes?.[task.mode] || {};
      const maxRuntimeSec = modeConfig.max_runtime_sec || (task.mode === 'quick' ? 60 : 300);

      // Dynamic Cognitive Budgeting (Adaptive Token Budget per Task)
      const rawWorkflow = (Array.isArray(task.writer_hub_workflow) && task.writer_hub_workflow.length > 0 && task.manual_workflow_override)
        ? task.writer_hub_workflow
        : resolveWriterHubWorkflow(task, teamConfig, policyConfig);
      const dynamicTaskBudget = computeDynamicTaskTokenBudget(task, rawWorkflow, policyConfig);
      console.log(`[Orchestrator] Dynamic token budget for task "${task.task_id}": ${dynamicTaskBudget.toLocaleString()} tokens (mode: ${task.mode || 'standard'}, risk: ${task.risk_level || 'low'}, scope: ${(task.scope || []).length} files)`);

      // Track read_file ranges across attempts per patch bucket so retries inherit Files Already Read
      const priorReadRangesByBucket = new Map();

      // ==========================================
      // TASK EXECUTION LOOP
      // ==========================================
      while (retries <= maxRetries && !isTaskDone) {
        if (retries > 0) {
          const backoffMs = Math.min(retries * 3000, 10000);
          console.log(`[Orchestrator] Waiting ${backoffMs / 1000}s before retry attempt ${retries + 1}/${maxRetries + 1}...`);
          await new Promise(r => setTimeout(r, backoffMs));
        }

        if (taskTokensUsed > dynamicTaskBudget) {
          blockReason = `Exceeded token budget (${taskTokensUsed} > ${dynamicTaskBudget})`;
          task.status = 'blocked';
          console.error(`[Orchestrator] ${blockReason}`);
          break;
        }

        const runtimeCheck = evaluateTaskExecutionRuntime({
          executionStartMs: taskExecutionStartMs,
          nowMs: Date.now(),
          maxRuntimeSec,
          baselineDurationMs
        });
        if (runtimeCheck.exceeded) {
          blockReason = `Exceeded task mode "${task.mode}" max_runtime_sec (${runtimeCheck.execution_elapsed_sec.toFixed(1)}s > ${runtimeCheck.max_runtime_sec}s; baseline ${runtimeCheck.baseline_elapsed_sec.toFixed(1)}s excluded)`;
          task.status = 'blocked';
          console.error(`[Orchestrator] ${blockReason}`);
          break;
        }

        task.status = 'writing';

        // Step A: Prepare Writer Prompt WITH Context-Aware Scoped File Contents
        const writerRole = teamConfig.roles?.writer || {};
        const writerSelection = resolveWriterSelection(task, teamConfig, {
          policyConfig,
          preflightFailedModels,
          isCircuitBrokenFn: isModelCircuitBroken
        });
        if (!writerSelection.ok || !writerSelection.actual_model) {
          blockReason = writerSelection.blocked_reason || 'Writer role has no usable model specified in task or team.yaml';
          task.status = 'blocked';
          break;
        }
        const writerModel = writerSelection.actual_model;
        const writerFallback = writerSelection.selected_by === 'task_override'
          ? null
          : (writerSelection.fallback_models[0] || null);
        const writerTemp = writerRole.temperature ?? 0.1;
        const writerMaxThinking = writerRole.max_thinking_tokens;
        const writerSpecFile = writerRole.spec_file || 'roles/writer.md';
        const writerSystemRole = fs.existsSync(path.resolve(TEAM_DIR, writerSpecFile))
          ? fs.readFileSync(path.resolve(TEAM_DIR, writerSpecFile), 'utf8')
          : 'You are the code writer. Return changes in <<<<<<< SEARCH / ======= / >>>>>>> REPLACE blocks.';

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

        const scopedFilesMeta = buildScopedFilesContextWithMeta(task.scope, REPO_ROOT, task, {
          tokenBudgetPerTask: dynamicTaskBudget,
          maxFilesPerTask
        });
        const scopedFilesContext = scopedFilesMeta.text;

        // Inject concise neighboring symbol map for architectural awareness (PageRank seeded with task.scope)
        let neighborRepoMap = '';
        try {
          const taskKeywords = extractTaskKeywords(task);
          neighborRepoMap = generateRepoMap(REPO_ROOT, {
            query: taskKeywords,
            scopeFiles: task.scope,
            maxChars: 2500
          });
        } catch {}

        // Declared before the draft_spec loop (it assigns them on budget errors) to avoid a TDZ ReferenceError.
        let patchPipelineFailed = false;
        let shouldBreakRetryLoop = false;

        // ====================================================================
        // WRITER HUB: Dynamic Multi-Tier Forward-Only Execution
        // (Step 1: Architect/Designer draft_spec -> Step 2A/2B: Scoped Bucket apply_patch)
        // ====================================================================
        const workflowSteps = (Array.isArray(task.writer_hub_workflow) && task.writer_hub_workflow.length > 0 && task.manual_workflow_override)
          ? task.writer_hub_workflow
          : resolveWriterHubWorkflow(task, teamConfig, policyConfig);
        const generatedArtifacts = [];

        // 1. Execute upstream spec drafting steps (if declared in workflow)
        for (const wfStep of workflowSteps) {
          if (wfStep.action === 'draft_spec') {
            const stepRole = wfStep.role || 'architect';
            const roleCfg = teamConfig.roles?.[stepRole] || {};
            if (roleCfg.enabled === false) {
              blockReason = `Spec role "${stepRole}" is disabled in team.yaml (enabled: false). Stopping instead of falling back to writer.`;
              task.status = 'blocked';
              break;
            }
            const stepModel = wfStep.model || roleCfg.default_model || roleCfg.model;
            if (!stepModel) {
              blockReason = `Spec role "${stepRole}" has no model configured in team.yaml. Stopping instead of falling back to writer.`;
              task.status = 'blocked';
              break;
            }
            const stepThinking = resolveThinkingBudget(task.risk_level, stepModel, roleCfg);
            const targetArtifact = resolveSpecArtifactPath(task.task_id, `${stepRole}_spec.md`, wfStep.output_artifact);
            const artFullPath = path.resolve(REPO_ROOT, targetArtifact);

            // Spec Reuse on Retry (disabled by default: retries must re-evaluate spec vs failing test contract)
            if (SPEC_REUSE_ON_RETRY_ENABLED && retries > 0 && fs.existsSync(artFullPath)) {
              try {
                const existingSpec = fs.readFileSync(artFullPath, 'utf8').trim();
                const isStaleJsonReview = existingSpec.startsWith('```json') || existingSpec.includes('"passed": false');
                if (existingSpec.length > 20 && !isStaleJsonReview) {
                  console.log(`[Writer Hub] Reusing existing spec artifact from previous attempt (0 tokens): ${targetArtifact}`);
                  recordTaskStep(task, {
                    step: `1.${wfStep.step || 1}`,
                    attempt: retries + 1,
                    role: stepRole,
                    action: 'reuse_spec',
                    model: '0-token-cache',
                    scope: Array.isArray(wfStep.sub_scope) ? wfStep.sub_scope : (task.scope || []),
                    prompt_tokens: 0,
                    cached_tokens: 0,
                    completion_tokens: 0,
                    reasoning_tokens: 0,
                    duration_ms: 1,
                    status: 'reused_0_token'
                  });
                  generatedArtifacts.push(targetArtifact);
                  continue;
                }
              } catch {}
            }

            // Pre-Step Token Brake (Spec step capped at max 20% of dynamic task token budget, <= 65k tokens)
            const remainingBeforeSpec = dynamicTaskBudget - taskTokensUsed;
            if (remainingBeforeSpec <= 2000) {
              blockReason = `Exceeded token budget (${taskTokensUsed} > ${dynamicTaskBudget}) before spec step ${wfStep.step || 1}`;
              task.status = 'blocked';
              break;
            }
            const specStepBudget = Math.min(remainingBeforeSpec, Math.floor(dynamicTaskBudget * 0.20), 65000);

            console.log(`[Writer Hub] Step ${wfStep.step || 1}: Role "${stepRole}" (${stepModel}) drafting spec -> ${targetArtifact} (budget cap: ${specStepBudget.toLocaleString()} tokens)...`);

            updateLiveStatus({
              roles_status: {
                ...liveStatus.roles_status,
                [stepRole]: { model: stepModel, status: 'working' }
              }
            });

            const specScope = (Array.isArray(wfStep.sub_scope) && wfStep.sub_scope.length > 0)
              ? wfStep.sub_scope
              : (task.scope || []);
            const specScopedContext = buildScopedFilesContext(specScope, REPO_ROOT, { ...task, scope: specScope }, {
              tokenBudgetPerTask: dynamicTaskBudget,
              maxFilesPerTask,
              perFileBudgetBytes: 10 * 1024
            });

            let bridgeSkeletonMap = '';
            if (Array.isArray(wfStep.bridge_skeleton_scope) && wfStep.bridge_skeleton_scope.length > 0) {
              try {
                bridgeSkeletonMap = generateRepoMap(REPO_ROOT, {
                  query: extractTaskKeywords(task),
                  scopeFiles: wfStep.bridge_skeleton_scope,
                  maxChars: 2200
                });
              } catch {}
            }

            const upstreamSpecs = (Array.isArray(wfStep.inputs) && wfStep.inputs.length > 0)
              ? (buildConsolidatedSpecsContext(wfStep.inputs, REPO_ROOT) || '')
              : '';

            const {
              userMessage: specUserMessage,
              systemPromptOverride: preCodeArchitectPrompt
            } = buildDraftSpecPrompts({
              wfStep,
              task,
              specScope,
              specScopedContext,
              neighborRepoMap,
              bridgeSkeletonMap,
              upstreamSpecs,
              retries
            });

            let specRes;
            const specStepStartMs = Date.now();

            try {
              const hasVisualSpecInput = (task.attachments || task.images || []).length > 0;
              const specMaxTurns = hasVisualSpecInput ? 2 : 1;
              const specDisableTools = !hasVisualSpecInput;

              const agentRes = await runAgent({
                role: stepRole,
                prompt: specUserMessage,
                sessionId: buildTaskStepSessionId({
                  taskId: task.task_id,
                  runId: taskRunId,
                  role: stepRole,
                  step: wfStep.step || 1,
                  attempt: retries + 1
                }),
                scope: task.scope || [],
                images: task.attachments || task.images || [],
                modelOverride: stepModel,
                maxTurns: specMaxTurns,
                disableTools: specDisableTools,
                timeoutMs: (task.mode === 'quick' ? 90 : 180) * 1000,
                repoRoot: REPO_ROOT,
                maxThinkingTokens: stepThinking,
                maxTokenBudget: specStepBudget,
                systemPromptOverride: preCodeArchitectPrompt
              });

              if (agentRes.usage) {
                taskTokensUsed = accumulateTaskAndStateUsage(state, agentRes.usage, taskTokensUsed);
                if ((agentRes.usage.cached_tokens || 0) > 0) {
                  console.log(`[Spec Cache] Prompt: ${getAdjustedPromptTokens(agentRes.usage)} | Cached: ${agentRes.usage.cached_tokens} (Hit: ${(agentRes.usage.cache_hit_ratio * 100).toFixed(1)}%) | Completion: ${agentRes.usage.completion_tokens || 0}`);
                }
              }

              if (agentRes.ok) {
                specRes = {
                  ok: true,
                  content: agentRes.content || '',
                  usage: agentRes.usage || { prompt_tokens: 0, completion_tokens: 0, reported_cached_tokens: null },
                  raw_usage: agentRes.raw_usage ?? null,
                  requestedModel: agentRes.requested_model || stepModel,
                  actualModel: agentRes.actual_model || agentRes.model_used || stepModel,
                  fallbackActivated: Boolean(agentRes.fallback_activated),
                  fallbackReason: agentRes.fallback_reason || null,
                  finishReason: agentRes.finish_reason || 'stop',
                  maxTokensSent: agentRes.max_tokens_sent || 16384,
                  toolTurns: agentRes.turns_executed || 1,
                  promptVersion: agentRes.prompt_version || 'default',
                  endpoint: agentRes.endpoint || 'http://127.0.0.1:20128/v1'
                };
              } else if (agentRes.budget_exceeded) {
                console.warn(`[Token Brake] Spec step "${stepRole}" hit step budget (${specStepBudget}): ${agentRes.error}. Skipping spec to preserve budget for Coder.`);
                specRes = {
                  ok: true,
                  content: `SKIP_SPEC: Step budget cap (${specStepBudget} tokens) reached.`,
                  raw_usage: null,
                  requestedModel: stepModel,
                  actualModel: '0-token-brake',
                  finishReason: 'budget_brake',
                  toolTurns: 0,
                  promptVersion: agentRes.prompt_version || 'default'
                };
              } else {
                const specSysRole = preCodeArchitectPrompt || (
                  fs.existsSync(path.resolve(TEAM_DIR, roleCfg.spec_file || `roles/${stepRole}.md`))
                    ? fs.readFileSync(path.resolve(TEAM_DIR, roleCfg.spec_file || `roles/${stepRole}.md`), 'utf8')
                    : `You are the ${stepRole} agent. Draft clear technical specs in Markdown.`
                );
                specRes = await call9Router(stepModel, specSysRole, specUserMessage, 8192, null, 0.2, {
                  maxThinkingTokens: stepThinking
                });
                if (specRes) {
                  specRes.requestedModel = specRes.requested_model || stepModel;
                  specRes.actualModel = specRes.actual_model || specRes.responseModel || stepModel;
                }
              }
            } catch (err) {
              if (isBudgetExceededError(err)) {
                blockReason = err.message;
                console.error(`[Orchestrator] ${blockReason}`);
                task.status = 'blocked';
                patchPipelineFailed = true;
                shouldBreakRetryLoop = true;
                break;
              }
              console.warn(`[Writer Hub] Error during ${stepRole} runAgent: ${err.message}`);
              specRes = { ok: false, error: err.message };
            }

            if (specRes.ok && specRes.content) {
              const isSkip = specRes.content.trim().startsWith('SKIP_SPEC');
              const bodyToWrite = isSkip
                ? `# Specification Skipped (Fast-Exit)\n${specRes.content.trim()}\n`
                : `${specRes.content.trim()}\n`;
              const writtenSpec = writeDraftSpecArtifact(task.task_id, stepRole, { ...wfStep, output_artifact: targetArtifact }, bodyToWrite, { repoRoot: REPO_ROOT });
              if (isSkip) {
                console.log(`[Writer Hub] Fast-exit triggered for ${stepRole}: ${specRes.content.slice(0, 150)}`);
              } else {
                console.log(`[Writer Hub] Spec artifact successfully written: ${writtenSpec.relPath}`);
              }
              generatedArtifacts.push(writtenSpec.relPath);
              recordTaskStep(task, {
                step: `1.${wfStep.step || 1}`,
                attempt: retries + 1,
                role: stepRole,
                action: `draft_spec (${wfStep.spec_focus || 'spec'})`,
                requested_model: specRes.requestedModel || specRes.requested_model || stepModel,
                actual_model: specRes.actualModel || specRes.actual_model || specRes.responseModel || stepModel,
                model: specRes.actualModel || specRes.actual_model || specRes.responseModel || stepModel,
                fallback_activated: Boolean(specRes.fallbackActivated ?? specRes.fallback_activated),
                fallback_reason: specRes.fallbackReason || specRes.fallback_reason || null,
                endpoint: specRes.endpoint || 'http://127.0.0.1:20128/v1',
                prompt_version: specRes.promptVersion || 'default',
                max_tokens_sent: specRes.maxTokensSent || 8192,
                finish_reason: specRes.finishReason || 'stop',
                tool_turns: specRes.toolTurns ?? 1,
                scope: specScope,
                ...extractUsageTelemetryFields(specRes),
                duration_ms: Math.max(1, Date.now() - specStepStartMs),
                status: isSkip ? 'fast_exit_skip' : 'ok',
                applier_status: 'n/a'
              });
            } else {
              console.warn(`[Writer Hub] Role ${stepRole} failed to draft spec: ${specRes.error || 'Empty response'}. Continuing workflow.`);
              recordTaskStep(task, {
                step: `1.${wfStep.step || 1}`,
                attempt: retries + 1,
                role: stepRole,
                action: `draft_spec (${wfStep.spec_focus || 'spec'})`,
                requested_model: specRes.requestedModel || specRes.requested_model || stepModel,
                actual_model: specRes.actualModel || specRes.actual_model || stepModel,
                model: specRes.actualModel || specRes.actual_model || stepModel,
                fallback_activated: Boolean(specRes.fallbackActivated ?? specRes.fallback_activated),
                fallback_reason: specRes.fallbackReason || specRes.fallback_reason || null,
                prompt_version: specRes.promptVersion || 'default',
                scope: specScope,
                ...extractUsageTelemetryFields(specRes),
                duration_ms: Math.max(1, Date.now() - specStepStartMs),
                status: 'failed',
                applier_status: 'n/a'
              });
            }

            updateLiveStatus({
              roles_status: {
                ...liveStatus.roles_status,
                [stepRole]: { model: stepModel, status: 'done' }
              }
            });
          }
        }
        lastGeneratedSpecs = [...generatedArtifacts];

        if (task.status === 'blocked') {
          break;
        }

        // 2. Execute Coder Patch Buckets (Split heavy buckets >55KB by Output Budget so responses never truncate)
        let patchSteps = workflowSteps.filter(s => s.action === 'apply_patch');
        if (patchSteps.length === 0) {
          patchSteps = [{
            step: 1,
            role: 'writer',
            model: writerModel,
            domain: 'fullstack',
            action: 'apply_patch',
            sub_scope: task.scope || [],
            inputs: generatedArtifacts
          }];
        }
        patchSteps = splitPatchStepsByOutputBudget(patchSteps, REPO_ROOT, {
          maxOutputTokens: writerRole?.max_tokens || 16384
        });
        for (let bIdx = 0; bIdx < patchSteps.length; bIdx++) {
          const b = patchSteps[bIdx];
          if (b?.bucket_grouping_reason) {
            console.log(`[Writer Hub] Bucket ${bIdx + 1}/${patchSteps.length} [${(b.sub_scope || []).join(', ')}]: ${b.bucket_grouping_reason}`);
          }
        }

        let lastActiveWriterModel = writerModel;
        const usedWriterModels = new Set([writerModel]);
        const cumulativeModified = new Set();
        const beforePatchContents = {};

        // Mid-bucket failure cleanup (D1): Bucket >= 1 failed after earlier buckets already wrote to disk.
        // Always rolls back every file touched in this attempt (tracked + untracked) regardless of
        // rollback_on_validation_fail. Never calls rollback([]) (see safeRollback).
        const collectAttemptRollbackTargets = () => Array.from(new Set([
          ...getRollbackTargets(),
          ...cumulativeModified
        ])).filter(f => f && !String(f).includes('*'));
        const rollbackAttemptChanges = () => {
          const targets = collectAttemptRollbackTargets();
          if (cumulativeModified.size === 0 && actualModifiedFiles.length === 0 && activeRollbackTargets.length === 0) {
            return;
          }
          const rbRes = safeRollback(targets);
          if (!rbRes.ok) {
            console.error(`[Orchestrator] Attempt rollback failed: ${rbRes.error}`);
          } else {
            console.warn(`[Orchestrator] Rolled back ${targets.length} file(s) touched earlier in this attempt: ${targets.join(', ')}`);
          }
          activeRollbackTargets = [];
          cumulativeModified.clear();
        };

        for (let pIdx = 0; pIdx < patchSteps.length; pIdx++) {
          // Pre-Step Token Brake before each Coder patch bucket
          const remainingBeforePatch = dynamicTaskBudget - taskTokensUsed;
          if (remainingBeforePatch <= 2000) {
            blockReason = `Exceeded token budget (${taskTokensUsed} > ${dynamicTaskBudget})`;
            console.error(`[Orchestrator] ${blockReason}`);
            task.status = 'blocked';
            patchPipelineFailed = true;
            shouldBreakRetryLoop = true;
            rollbackAttemptChanges();
            break;
          }

          const coderStep = patchSteps[pIdx];
          const stepRole = coderStep.role || 'writer';
          const stepDomain = coderStep.domain || 'fullstack';
          const stepScope = Array.isArray(coderStep.sub_scope) && coderStep.sub_scope.length > 0
            ? coderStep.sub_scope
            : (task.scope || []);

          const inputArtifacts = coderStep.inputs || (generatedArtifacts.length > 0 ? generatedArtifacts : []);
          let specsDossier = '';
          if (inputArtifacts.length > 0) {
            specsDossier = buildConsolidatedSpecsContext(inputArtifacts, REPO_ROOT);
          }

          const activeWriterModel = (coderStep.role && coderStep.role !== 'writer' && coderStep.model)
            ? coderStep.model
            : writerModel;
          const bucketSelection = (activeWriterModel === writerModel)
            ? writerSelection
            : {
                ok: true,
                selected_by: writerSelection.selected_by === 'task_override' ? 'task_override' : 'primary',
                requested_model: activeWriterModel,
                actual_model: activeWriterModel,
                fallback_models: writerSelection.selected_by === 'task_override' ? [] : writerSelection.fallback_models,
                reason: writerSelection.reason
              };
          lastActiveWriterModel = activeWriterModel;
          usedWriterModels.add(activeWriterModel);
          const coderThinking = resolveThinkingBudget(task.risk_level, activeWriterModel, writerRole);

          const stepScopedMeta = (stepScope.length === (task.scope || []).length)
            ? scopedFilesMeta
            : buildScopedFilesContextWithMeta(stepScope, REPO_ROOT, { ...task, scope: stepScope }, {
                tokenBudgetPerTask: dynamicTaskBudget,
                maxFilesPerTask
              });
          const stepScopedContext = stepScopedMeta.text;

          // Live AST Bridge: If Step 2B (Frontend) follows Step 2A (Backend), extract updated signatures from Step 2A files
          let updatedBackendBridgeMap = '';
          if (Array.isArray(coderStep.inject_updated_repo_map_from) && coderStep.inject_updated_repo_map_from.length > 0) {
            try {
              updatedBackendBridgeMap = generateRepoMap(REPO_ROOT, {
                query: extractTaskKeywords(task),
                scopeFiles: coderStep.inject_updated_repo_map_from,
                maxChars: 2000
              });
            } catch {}
          }

          const userMessageParts = [
            `TASK ID: ${task.task_id}${patchSteps.length > 1 ? ` (Bucket ${pIdx + 1}/${patchSteps.length}: ${stepDomain.toUpperCase()} — [${stepScope.join(', ')}])` : ''}`,
            `EXECUTION MODE: ${task.mode}`,
            `ALLOWED BUCKET SCOPE (ONLY modify these files in this step): ${stepScope.join(', ')}`
          ];

          if (updatedBackendBridgeMap && updatedBackendBridgeMap.trim()) {
            userMessageParts.push(`UPDATED BACKEND CONTRACT (Live AST Signatures written in earlier bucket — match these 100%):\n${updatedBackendBridgeMap.trim()}`);
          } else if (neighborRepoMap && neighborRepoMap.trim()) {
            userMessageParts.push(`NEIGHBORING CODEBASE SKELETON (Symbols & Signatures for Reference):\n${neighborRepoMap.trim()}`);
          }

          if (specsDossier && specsDossier.trim()) {
            userMessageParts.push(`DESIGN SPECIFICATIONS & ARCHITECTURAL DOSSIER:\n${specsDossier.trim()}`);
          }

          userMessageParts.push(`CURRENT SCOPED FILE CONTENTS:\n${stepScopedContext}`);

          const bucketReadKey = `${stepRole}:${pIdx}:${stepScope.join(',')}`;
          const priorBucketReads = priorReadRangesByBucket.get(bucketReadKey) || [];
          if (priorBucketReads.length > 0) {
            const priorContextText = formatPriorReadContext(priorBucketReads, { repoRoot: REPO_ROOT });
            if (priorContextText) {
              userMessageParts.push(priorContextText);
            }
          }

          if (stepScopedMeta.windowMode === 'smart') {
            userMessageParts.push(
              `SMART WINDOW NOTICE: File(s) with OMITTED LINES are sliced. If you need lines from multiple omitted ranges or distant handlers, you CAN issue multiple \`read_file\` tool calls in parallel within the SAME turn instead of reading one range per turn.`
            );
          }

          // Place task-specific GOAL, CONSTRAINTS, ACCEPTANCE CRITERIA, and action prompt at the bottom (U-shaped attention optimal zone)
          userMessageParts.push(
            `GOAL: ${task.goal || task.title}`,
            `CONSTRAINTS: ${(task.constraints || []).join(', ')}`,
            `ACCEPTANCE CRITERIA: ${(task.acceptance_criteria || []).join('; ')}`
          );

          const hasSpecsDossier = Boolean(specsDossier && specsDossier.trim());
          // Dynamic Worker Turns:
          // - If architectural specs (TechSpec / DesignSpec) already exist, clamp maxTurns to 2.
          // - When smart window omits lines (OMITTED LINES), allow up to 5 turns even in quick mode (never 8-10; token brake governs).
          const hasOmittedLines = stepScopedMeta.windowMode === 'smart' || stepScopedContext.includes('OMITTED LINES');
          const coderMaxTurns = resolveCoderMaxTurns({
            hasSpecsDossier,
            mode: task.mode,
            windowMode: stepScopedMeta.windowMode,
            hasOmittedLines
          });

          if (hasSpecsDossier) {
            userMessageParts.push(
              `CRITICAL WORKER INSTRUCTION (MAX 2 TURNS): Architectural specs, exact contracts, and implementation steps are ALREADY fully locked above in DESIGN SPECIFICATIONS & ARCHITECTURAL DOSSIER. Do NOT call read_file or search_code repeatedly to wander around. Think briefly (<50 words) and immediately output the exact SEARCH/REPLACE blocks.`
            );
          }

          userMessageParts.push(
            task.last_error
              ? buildWriterRetryInstruction(task.last_error, stepScope)
              : `Please generate the exact code modifications ONLY for [${stepScope.join(', ')}] to fulfill its part of the goal. Think briefly (<100 words) and immediately output the SEARCH/REPLACE blocks.`
          );

          const userMessage = userMessageParts.join('\n\n');
          const writerBucketBudget = Math.min(remainingBeforePatch, Math.floor(dynamicTaskBudget * 0.35), 95000);
          const writerStepStartMs = Date.now();

          let writerRes;
          try {
            const agentRes = await runAgent({
              role: stepRole,
              prompt: userMessage,
              sessionId: buildTaskStepSessionId({
                taskId: task.task_id,
                runId: taskRunId,
                role: stepRole,
                bucketIndex: pIdx + 1,
                attempt: retries + 1
              }),
              scope: stepScope,
              images: task.attachments || task.images || [],
              modelOverride: activeWriterModel,
              fallbackModel: bucketSelection.selected_by === 'task_override' ? null : writerFallback,
              maxTurns: coderMaxTurns,
              timeoutMs: (task.mode === 'quick' ? 120 : 240) * 1000,
              repoRoot: REPO_ROOT,
              maxThinkingTokens: coderThinking,
              maxTokenBudget: writerBucketBudget,
              priorReadRanges: priorBucketReads
            });

            if (Array.isArray(agentRes?.read_ranges) && agentRes.read_ranges.length > 0) {
              priorReadRangesByBucket.set(
                bucketReadKey,
                mergeReadRanges(priorBucketReads, agentRes.read_ranges)
              );
            }

            if (agentRes.ok) {
              const receipts = Array.isArray(agentRes.tool_receipts) ? agentRes.tool_receipts : [];
              writerRes = {
                ok: true,
                content: agentRes.content || '',
                rawContent: agentRes.content || '',
                rawReasoning: '',
                finishReason: agentRes.finish_reason || 'stop',
                maxTokensSent: agentRes.max_tokens_sent || 16384,
                toolTurns: agentRes.turns_executed || 1,
                turnsUsed: agentRes.turns_executed || 1,
                turn_usages: Array.isArray(agentRes.turn_usages) ? agentRes.turn_usages : [],
                extraReadCalls: receipts.filter(r => r && r.tool === 'read_file').length,
                promptVersion: agentRes.prompt_version || 'default',
                endpoint: agentRes.endpoint || 'http://127.0.0.1:20128/v1',
                usage: agentRes.usage || { prompt_tokens: 0, completion_tokens: 0, reported_cached_tokens: null },
                raw_usage: agentRes.raw_usage ?? null,
                requestedModel: bucketSelection.requested_model || agentRes.requested_model || activeWriterModel,
                modelUsed: agentRes.model_used || activeWriterModel,
                responseModel: agentRes.actual_model || agentRes.model_used || activeWriterModel,
                actualModel: agentRes.actual_model || agentRes.model_used || activeWriterModel,
                fallbackActivated: Boolean(agentRes.fallback_activated || bucketSelection.selected_by === 'fallback'),
                fallbackReason: agentRes.fallback_reason || (bucketSelection.selected_by === 'fallback' ? bucketSelection.reason : null),
                selectedBy: agentRes.fallback_activated ? 'fallback' : bucketSelection.selected_by,
                selectionReason: agentRes.fallback_activated ? (agentRes.fallback_reason || 'provider_error') : bucketSelection.reason,
                modelMatched: Boolean(agentRes.model_used)
              };
            } else if (agentRes.budget_exceeded) {
              const bIn = getAdjustedPromptTokens(agentRes.usage);
              const bOut = agentRes.usage?.completion_tokens || 0;
              taskTokensUsed += bIn + bOut;
              blockReason = `Exceeded token budget (${agentRes.error})`;
              console.error(`[Orchestrator] ${blockReason}`);
              task.status = 'blocked';
              patchPipelineFailed = true;
              shouldBreakRetryLoop = true;
              rollbackAttemptChanges();
              break;
            } else {
              const fbPlan = resolveRuntimeWriterFallback({
                selection: bucketSelection,
                failureStage: 'provider',
                providerError: agentRes.error,
                teamConfig,
                preflightFailedModels,
                isCircuitBrokenFn: isModelCircuitBroken
              });
              console.warn(`[Writer Runtime] Agent run returned error: ${agentRes.error}. ${fbPlan.ok ? `Falling back to ${fbPlan.actual_model}` : 'No fallback permitted/available'}...`);
              if (fbPlan.ok) {
                writerRes = await call9Router(fbPlan.actual_model, writerSystemRole, userMessage, 16384, null, writerTemp, {
                  maxThinkingTokens: coderThinking
                });
                if (writerRes) {
                  writerRes.requestedModel = fbPlan.requested_model;
                  writerRes.fallbackActivated = true;
                  writerRes.fallbackReason = fbPlan.reason;
                  writerRes.selectedBy = 'fallback';
                  writerRes.selectionReason = fbPlan.reason;
                }
              } else {
                writerRes = { ok: false, error: agentRes.error };
              }
            }
          } catch (agentErr) {
            if (isBudgetExceededError(agentErr)) {
              blockReason = agentErr.message;
              console.error(`[Orchestrator] ${blockReason}`);
              task.status = 'blocked';
              patchPipelineFailed = true;
              shouldBreakRetryLoop = true;
              rollbackAttemptChanges();
              break;
            }
            const fbPlan = resolveRuntimeWriterFallback({
              selection: bucketSelection,
              failureStage: 'provider',
              providerError: agentErr.message,
              teamConfig,
              preflightFailedModels,
              isCircuitBrokenFn: isModelCircuitBroken
            });
            console.warn(`[Writer Runtime] Exception during runAgent: ${agentErr.message}. ${fbPlan.ok ? `Falling back to ${fbPlan.actual_model}` : 'No fallback permitted/available'}...`);
            if (fbPlan.ok) {
              writerRes = await call9Router(fbPlan.actual_model, writerSystemRole, userMessage, 16384, null, writerTemp, {
                maxThinkingTokens: coderThinking
              });
              if (writerRes) {
                writerRes.requestedModel = fbPlan.requested_model;
                writerRes.fallbackActivated = true;
                writerRes.fallbackReason = fbPlan.reason;
                writerRes.selectedBy = 'fallback';
                writerRes.selectionReason = fbPlan.reason;
              }
            } else {
              writerRes = { ok: false, error: agentErr.message };
            }
          }

          if (!writerRes.ok) {
            console.error(`[Writer] API error: ${writerRes.error}`);
            task.last_error = writerRes.error;
            updateLiveStatus({
              roles_status: {
                writer: { model: activeWriterModel, status: 'error' },
                validator: { status: 'idle' },
                reviewer: { status: 'idle' }
              },
              last_error: writerRes.error
            });
            if (writerRes.controlled_failure && writerRes.nonRetryable) {
              blockReason = writerRes.error;
              task.status = 'blocked';
              patchPipelineFailed = true;
              shouldBreakRetryLoop = true;
              rollbackAttemptChanges();
              break;
            }
            retries++;
            patchPipelineFailed = true;
            rollbackAttemptChanges();
            break;
          }

          // Record actual model that generated the patch (accounting for fallback) so Anti-Self-Review gate is accurate
          lastActiveWriterModel = writerRes.actualModel || writerRes.actual_model || writerRes.modelUsed || writerRes.responseModel || activeWriterModel;
          usedWriterModels.add(lastActiveWriterModel);

          const rawLogPath = saveWriterRawOutput(task.task_id, retries + 1, writerRes);

          const inputTok = getAdjustedPromptTokens(writerRes.usage);
          const outputTok = writerRes.usage?.completion_tokens || 0;
          const cachedTok = writerRes.usage?.cached_tokens || 0;
          const writerReportedCached = writerRes.usage?.reported_cached_tokens ?? null;
          taskTokensUsed = accumulateTaskAndStateUsage(state, writerRes.usage, taskTokensUsed);
          if (cachedTok > 0) {
            console.log(`[Writer Cache] Prompt: ${inputTok} | Cached: ${cachedTok} (Hit: ${((writerRes.usage.cache_hit_ratio || 0) * 100).toFixed(1)}%) | Completion: ${outputTok}`);
          }

          const totalSessIn = state.metrics.total_input_tokens || 0;
          const totalSessCached = state.metrics.total_cached_tokens || 0;
          const sessCacheHitPct = totalSessIn > 0
            ? Math.round((totalSessCached / totalSessIn) * 1000) / 10
            : 0;

          updateLiveStatus({
            raw_log_path: rawLogPath,
            roles_status: {
              writer: { model: activeWriterModel, status: 'done' },
              validator: { status: 'idle' },
              reviewer: { status: 'idle' }
            },
            tokens: {
              task_input: taskTokensUsed,
              task_output: 0,
              session_input: totalSessIn,
              session_output: state.metrics.total_output_tokens || 0,
              session_cached: totalSessCached,
              cache_hit_pct: sessCacheHitPct
            }
          });

          // Step A.5: Unconditional Truncation Guard (when finish_reason === 'length')
          if (writerRes.finishReason === 'length') {
            const searchCount = (writerRes.content.match(/<<<<<<< SEARCH/g) || []).length;
            const replaceCount = (writerRes.content.match(/>>>>>>> REPLACE/g) || []).length;
            const truncErr = `Writer output truncated at max_tokens=16384 (finish_reason="length", ${searchCount} SEARCH / ${replaceCount} REPLACE blocks). Refusing to apply partial output; emit smaller/more concise blocks or split task.${rawLogPath ? ` (raw output: ${path.relative(REPO_ROOT, rawLogPath)})` : ''}`;
            console.warn(`[Writer] ${truncErr}`);
            const failAction = handleStageFailure('apply', truncErr, hashString('truncated_output_length'));
            patchPipelineFailed = true;
            shouldBreakRetryLoop = failAction.shouldBreak;
            break;
          }

          // Step B: 8-Step Applier Pipeline (Scoped to current bucket stepScope)
          updateLiveStatus({
            current_stage: 'applier',
            stage_started_at: new Date().toISOString()
          });

          for (const scopeRel of stepScope) {
            const normScopeRel = String(scopeRel || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
            if (!normScopeRel || Object.prototype.hasOwnProperty.call(beforePatchContents, normScopeRel)) continue;
            try {
              const absBefore = path.resolve(REPO_ROOT, normScopeRel);
              if (fs.existsSync(absBefore) && fs.statSync(absBefore).isFile()) {
                beforePatchContents[normScopeRel] = fs.readFileSync(absBefore, 'utf8');
              }
            } catch {}
          }

          const parsedWriterBlocks = parseSearchReplaceBlocks(writerRes.content || '');
          const editLinesOutsideWindow = measureEditedLinesOutsideWindow(
            parsedWriterBlocks,
            beforePatchContents,
            stepScopedMeta
          );
          const requestedWriterModelForStep = writerRes.requestedModel || writerRes.requested_model || bucketSelection.requested_model || activeWriterModel;
          const stepPreflightAttempts = summarizePreflightAttempts(rosterPreflightResult, requestedWriterModelForStep);
          const windowTelemetryFields = {
            context_lines_sent: stepScopedMeta.contextLinesSent || 0,
            window_mode: stepScopedMeta.windowMode || 'full',
            edit_lines_outside_window: editLinesOutsideWindow,
            references_truncated: Boolean(stepScopedMeta.referencesTruncated),
            extra_read_calls: Number(writerRes.extraReadCalls || 0),
            ...(stepPreflightAttempts !== null ? { preflight_attempts: stepPreflightAttempts } : {}),
            turns_used: Number(writerRes.turnsUsed ?? writerRes.toolTurns ?? 1),
            ...(Array.isArray(writerRes.turn_usages) && writerRes.turn_usages.length > 0 ? { turn_tokens: writerRes.turn_usages } : {})
          };

          const scopedSubTask = { ...task, scope: stepScope };
          const latestBucketReads = priorReadRangesByBucket.get(bucketReadKey) || priorBucketReads || [];
          // Arm rollback BEFORE the first disk write of this attempt (closes the SIGINT window between buckets).
          activeRollbackTargets = collectAttemptRollbackTargets();
          const applyRes = applyEdits(writerRes.content, scopedSubTask, {
            allowedDirs,
            protectedFiles,
            maxScopeIncrease,
            allowNewFiles,
            newFilesOnlyInScope,
            repoRoot: REPO_ROOT,
            contextMeta: stepScopedMeta,
            readRanges: latestBucketReads
          });
          const writerBucketElapsedMs = Math.max(1, Date.now() - writerStepStartMs);
          phaseTracker.addWriterBucketMs({
            bucket: pIdx + 1,
            attempt: retries + 1,
            role: stepRole,
            duration_ms: writerBucketElapsedMs
          });

          if (!applyRes.ok) {
            if (applyRes.revealed_range?.path && applyRes.revealed_range?.start_line) {
              priorReadRangesByBucket.set(
                bucketReadKey,
                mergeReadRanges(latestBucketReads, [applyRes.revealed_range])
              );
            }
            const truncHint = writerRes.finishReason === 'length'
              ? ' [OUTPUT TRUNCATED AT max_tokens=16384 — Task is too large for 1 pass; split into smaller tasks (<150 lines)]'
              : '';
            const fullApplyErr = `${applyRes.error}${truncHint}${rawLogPath ? ` (raw output saved: ${path.relative(REPO_ROOT, rawLogPath)})` : ''}`;
            console.warn(`[Applier] ${fullApplyErr}`);
            const applyHash = applyRes.error_hash || hashString(applyRes.error);
            recordTaskStep(task, {
              step: `2.${pIdx + 1}`,
              attempt: retries + 1,
              role: stepRole,
              action: `apply_patch (bucket ${pIdx + 1}/${patchSteps.length})`,
              selected_by: writerRes.selectedBy || (writerRes.fallbackActivated ? 'fallback' : bucketSelection.selected_by),
              reason: writerRes.selectionReason || writerRes.fallbackReason || bucketSelection.reason,
              requested_model: writerRes.requestedModel || writerRes.requested_model || bucketSelection.requested_model || activeWriterModel,
              actual_model: writerRes.actualModel || writerRes.actual_model || lastActiveWriterModel,
              model: writerRes.actualModel || writerRes.actual_model || lastActiveWriterModel,
              fallback_activated: Boolean(writerRes.fallbackActivated ?? writerRes.fallback_activated),
              fallback_reason: writerRes.fallbackReason || writerRes.fallback_reason || null,
              endpoint: writerRes.endpoint || 'http://127.0.0.1:20128/v1',
              prompt_version: writerRes.promptVersion || 'default',
              max_tokens_sent: writerRes.maxTokensSent || 16384,
              finish_reason: writerRes.finishReason || 'stop',
              tool_turns: writerRes.toolTurns ?? 1,
              scope: stepScope,
              estimated_output_tokens: coderStep.estimated_output_tokens ?? null,
              output_token_limit: coderStep.output_token_limit ?? null,
              bucket_grouping_reason: coderStep.bucket_grouping_reason || null,
              ...windowTelemetryFields,
              ...extractUsageTelemetryFields(writerRes),
              duration_ms: Math.max(1, Date.now() - writerStepStartMs),
              status: 'failed_apply',
              applier_status: 'rejected',
              applier_reason: applyRes.error.slice(0, 600),
              ...(applyRes.failed_block ? { failed_block: applyRes.failed_block } : {}),
              scope_miss: /outside.*scope|not in.*scope/i.test(applyRes.error),
              error_hash: applyHash,
              retry_reason: retries > 0 ? String(task.last_error || '').slice(0, 120) : null,
              note: applyRes.error.slice(0, 120)
            });
            if (writerRes.content) {
              console.warn(`[Applier Output Preview]:\n${writerRes.content.slice(0, 500)}`);
            }
            if (applyRes.security || applyRes.noRetry) {
              blockReason = fullApplyErr;
              task.status = 'blocked';
              rollback(getRollbackTargets());
              activeRollbackTargets = [];
              patchPipelineFailed = true;
              shouldBreakRetryLoop = true;
              break;
            }

            const failAction = handleStageFailure('apply', fullApplyErr, applyHash);
            patchPipelineFailed = true;
            shouldBreakRetryLoop = failAction.shouldBreak;
            break;
          }

          recordTaskStep(task, {
            step: `2.${pIdx + 1}`,
            attempt: retries + 1,
            role: stepRole,
            action: `apply_patch (bucket ${pIdx + 1}/${patchSteps.length})`,
            selected_by: writerRes.selectedBy || (writerRes.fallbackActivated ? 'fallback' : bucketSelection.selected_by),
            reason: writerRes.selectionReason || writerRes.fallbackReason || bucketSelection.reason,
            requested_model: writerRes.requestedModel || writerRes.requested_model || bucketSelection.requested_model || activeWriterModel,
            actual_model: writerRes.actualModel || writerRes.actual_model || lastActiveWriterModel,
            model: writerRes.actualModel || writerRes.actual_model || lastActiveWriterModel,
            fallback_activated: Boolean(writerRes.fallbackActivated ?? writerRes.fallback_activated),
            fallback_reason: writerRes.fallbackReason || writerRes.fallback_reason || null,
            endpoint: writerRes.endpoint || 'http://127.0.0.1:20128/v1',
            prompt_version: writerRes.promptVersion || 'default',
            max_tokens_sent: writerRes.maxTokensSent || 16384,
            finish_reason: writerRes.finishReason || 'stop',
            tool_turns: writerRes.toolTurns ?? 1,
            scope: stepScope,
            estimated_output_tokens: coderStep.estimated_output_tokens ?? null,
            output_token_limit: coderStep.output_token_limit ?? null,
            bucket_grouping_reason: coderStep.bucket_grouping_reason || null,
            ...windowTelemetryFields,
            ...extractUsageTelemetryFields(writerRes),
            duration_ms: Math.max(1, Date.now() - writerStepStartMs),
            status: 'ok',
            applier_status: 'accepted',
            scope_miss: Boolean(Array.isArray(applyRes.scope_expansions) && applyRes.scope_expansions.length > 0),
            unseen_exact_match: Boolean(applyRes.unseen_exact_match),
            ...(Array.isArray(applyRes.unseen_exact_matches) && applyRes.unseen_exact_matches.length > 0
              ? { unseen_exact_matches: applyRes.unseen_exact_matches }
              : {}),
            retry_reason: retries > 0 ? String(task.last_error || '').slice(0, 120) : null
          });
          if (applyRes.unseen_exact_match) {
            const unseenList = Array.isArray(applyRes.unseen_exact_matches) ? applyRes.unseen_exact_matches : [];
            const unseenSummaryText = unseenList
              .map(m => `#${m.block} ${m.file}:${m.start_line}-${m.end_line}${m.is_delete ? ' [DELETE]' : ''}`)
              .join(', ');
            console.log(`[Applier] Accepted ${unseenList.length || 1} exact unique (>=3 non-empty lines) block(s) outside initial seen window (telemetry: unseen_exact_match=true${unseenSummaryText ? `; ${unseenSummaryText}` : ''}).`);
          }

          if (Array.isArray(applyRes.scope_expansions) && applyRes.scope_expansions.length > 0) {
            task.scope_expansions = Array.from(new Set([...(task.scope_expansions || []), ...applyRes.scope_expansions]));
          }
          for (const modFile of (applyRes.modified || [])) {
            cumulativeModified.add(modFile);
          }
          // Keep the armed set in sync so SIGINT between buckets also removes files created by this bucket.
          activeRollbackTargets = collectAttemptRollbackTargets();
        }

        if (patchPipelineFailed) {
          if (shouldBreakRetryLoop) break;
          continue;
        }

        const allTaskFiles = Array.from(new Set([...task.scope, ...(task.scope_expansions || []), ...cumulativeModified]));
        actualModifiedFiles = getModifiedFiles(allTaskFiles);
        activeRollbackTargets = getRollbackTargets();

        const sigGateRes = evaluatePostPatchSignatureGate({
          modifiedFiles: actualModifiedFiles,
          beforeContents: beforePatchContents,
          taskScope: allTaskFiles,
          repoRoot: REPO_ROOT
        });
        if (sigGateRes.blocked) {
          blockReason = sigGateRes.block_reason || 'blocked: signature_change_out_of_scope';
          task.last_error = blockReason;
          task.blocked_dependents = sigGateRes.blocked_dependents;
          task.changed_signatures = sigGateRes.changed_signatures;
          task.status = 'blocked';
          task.error_history.push({
            attempt: retries + 1,
            stage: 'post_patch_signature_gate',
            error_hash: hashString(blockReason),
            summary: blockReason.slice(-600)
          });
          console.error(`[SignatureGate] ${blockReason}`);
          if (rollbackOnValidationFail) {
            rollback(getRollbackTargets());
            activeRollbackTargets = [];
          }
          break;
        }

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

        const validatePhaseStartMs = Date.now();
        let isValidationSkipped = false;
        let taskDiffText = '';
        try {
        const fastVal = await validateStageChecks('fast_checks', policyConfig, { defaultTimeoutMs: 30000, collectAll: true });
        if (fastVal.skipped) {
          console.log(`[Validator] Notice: ${fastVal.message}`);
        }
        const fastTrust = evaluateValidationTrust({ fastVal, baselineFingerprint });
        task.validation_result = fastTrust.validationResult;
        if (fastTrust.blocked) {
          rejectUntrustedValidation(fastTrust);
          break;
        }

        taskDiffText = getScopedDiff(actualModifiedFiles);
        const fastCheckList = Array.isArray(fastVal.checks) && fastVal.checks.length > 0 ? fastVal.checks : (fastVal.skipped ? [] : [fastVal]);
        const enrichedFastChecks = !fastVal.ok
          ? await attachIsolatedEnobufsRetries(fastCheckList, 'fast_checks', policyConfig)
          : fastCheckList;
        if (!fastVal.ok) {
          console.warn(`[Validator] Fast check failed: ${fastVal.checkName}`);
          const fastBaselineEval = evaluateTaskOutcomeWithBaseline({
            task,
            checkResults: enrichedFastChecks,
            baselineResult,
            diffText: taskDiffText,
            modifiedFiles: actualModifiedFiles,
            policyConfig,
            repoRoot: REPO_ROOT
          });
          if (enrichedFastChecks.some(c => c && c.ok === false && isEnobufsFailure(c.errorCombined || ''))) {
            task.consecutive_enobufs = Number(task.consecutive_enobufs || 0) + 1;
          }
          if (fastBaselineEval.outcome === 'blocked') {
            stopOnBaselineBlock(fastBaselineEval, writerModel);
            break;
          }
          if (fastBaselineEval.outcome === 'retry_writer') {
            updateLiveStatus({
              roles_status: {
                writer: { model: writerModel, status: 'done' },
                validator: { status: 'failed' },
                reviewer: { status: 'idle' }
              }
            });
            lastValidationChecks = enrichedFastChecks;
            const failAction = handleStageFailure('validate', fastBaselineEval.errorCombined || fastVal.errorCombined, fastBaselineEval.errorHash || fastVal.errorHash);
            if (failAction.shouldBreak) break;
            continue;
          }
          console.log('[Validator] Fast check failure matches out-of-scope baseline; continuing to suite checks...');
        }

        // Step C.5: Deterministic 0-Token Deleted Identifier Gate (kind = remove | refactor)
        const deletedIdGate = evaluateDeletedIdentifierGate(taskDiffText, task, {
          repoRoot: REPO_ROOT,
          excludeDirs: Array.isArray(policyConfig?.scope_control?.context_exclude) ? policyConfig.scope_control.context_exclude : []
        });
        if (!deletedIdGate.skipped && Array.isArray(deletedIdGate.warnings) && deletedIdGate.warnings.length > 0) {
          task.warnings = [...new Set([...(Array.isArray(task.warnings) ? task.warnings : []), ...deletedIdGate.warnings])];
          console.warn(`[Validator] Deleted-identifier test warnings (${deletedIdGate.warnings.length}): ${deletedIdGate.warnings.slice(0, 3).join('; ')}`);
        }
        if (!deletedIdGate.ok) {
          console.warn(`[Validator] Deleted identifier gate failed (${deletedIdGate.violations.length} orphan ref(s)): ${deletedIdGate.violations.slice(0, 3).join('; ')}`);
          updateLiveStatus({
            roles_status: {
              writer: { model: writerModel, status: 'done' },
              validator: { status: 'failed' },
              reviewer: { status: 'idle' }
            }
          });
          lastValidationChecks = [];
          const failAction = handleStageFailure('validate', deletedIdGate.retryPrompt, deletedIdGate.errorHash || hashString(deletedIdGate.retryPrompt));
          if (failAction.shouldBreak) break;
          continue;
        }

        // Step D: Suite Validation (0-Token, fast-retry targeted pre-check when retries > 0, then full suite)
        const suiteRun = await runSuiteValidationWithFastRetryFirst({
          task,
          retries,
          policyConfig,
          baselineResult,
          envFingerprint: baselineFingerprint.envFingerprint,
          fastChecks: enrichedFastChecks,
          diffText: taskDiffText,
          modifiedFiles: actualModifiedFiles,
          repoRoot: REPO_ROOT,
          phaseTracker,
          recordStepFn: (st) => recordTaskStep(task, st),
          runCheckFn: runSingleValidationCheck,
          validateStageChecksFn: validateStageChecks,
          attachEnobufsFn: attachIsolatedEnobufsRetries
        });
        if (suiteRun.fastRetryResult?.attempted) {
          const fallbackNote = suiteRun.fastRetryResult.fast_retry_fallback_reason
            ? `FALLBACK (${suiteRun.fastRetryResult.fast_retry_fallback_reason}) -> ran verification modules`
            : (suiteRun.shortCircuited ? 'FAILED -> short-circuiting full suite' : 'PASSED -> continuing to full suite');
          console.log(
            `[Validator] Fast retry targeted check (${suiteRun.fastRetryResult.targeted_tests.join(', ')}): ` +
            `${fallbackNote} (${suiteRun.fastRetryResult.fast_retry_validation_ms}ms)`
          );
        }
        const suiteVal = suiteRun.suiteVal;
        if (!suiteRun.shortCircuited) {
          if (suiteVal.skipped) {
            console.log(`[Validator] Notice: ${suiteVal.message}`);
          }
          const trustGate = evaluateValidationTrust({ fastVal, suiteVal, baselineFingerprint });
          task.validation_result = trustGate.validationResult;
          if (trustGate.blocked) {
            rejectUntrustedValidation(trustGate);
            break;
          }
        }

        const enrichedSuiteChecks = suiteRun.enrichedSuiteChecks;
        const baselineEval = suiteRun.baselineEval;
        if (enrichedSuiteChecks.some(c => c && c.ok === false && isEnobufsFailure(c.errorCombined || ''))) {
          task.consecutive_enobufs = Number(task.consecutive_enobufs || 0) + 1;
        } else if (suiteVal.ok && fastVal.ok) {
          task.consecutive_enobufs = 0;
        }
        if (baselineEval.outcome === 'blocked') {
          stopOnBaselineBlock(baselineEval, writerModel);
          break;
        }
        if (baselineEval.outcome === 'retry_writer') {
          console.warn(`[Validator] Suite/baseline evaluation requires Writer retry: ${baselineEval.reason || suiteVal.checkName || fastVal.checkName}`);
          updateLiveStatus({
            roles_status: {
              writer: { model: writerModel, status: 'done' },
              validator: { status: 'failed' },
              reviewer: { status: 'idle' }
            }
          });
          lastValidationChecks = enrichedSuiteChecks;
          const failAction = handleStageFailure('validate', baselineEval.errorCombined || suiteVal.errorCombined || fastVal.errorCombined, baselineEval.errorHash || suiteVal.errorHash || fastVal.errorHash);
          if (failAction.shouldBreak) break;
          continue;
        }

        // Step D.5: Deterministic 0-Token Test-Suite Preservation Check
        const testIntegrity = verifyTestDiffIntegrity(taskDiffText, task);
        if (!testIntegrity.ok) {
          const integrityErr = testIntegrity.violations.join('; ');
          console.warn(`[Validator] Test suite integrity violation: ${integrityErr}`);
          const failAction = handleStageFailure('validate', integrityErr, hashString(integrityErr));
          if (failAction.shouldBreak) break;
          continue;
        }

        // Step D.6: Vacuous New Test Warning Check (kind = remove | bugfix | feature; warn-only)
        const vacuousCheck = detectVacuousNewTestsOnParent(taskDiffText, task, {
          repoRoot: REPO_ROOT,
          parentRef: 'HEAD',
          actualModifiedFiles
        });
        if (!vacuousCheck.skipped && (vacuousCheck.vacuousTests?.length > 0 || vacuousCheck.parentTestResults?.length > 0)) {
          task.parent_test_verification = {
            parent_failure_kind: vacuousCheck.parent_failure_kind || null,
            parent_failure_kinds: vacuousCheck.parent_failure_kinds || {},
            parent_test_results: vacuousCheck.parentTestResults || []
          };
          if (vacuousCheck.vacuousTests?.length > 0) {
            task.warnings = [...new Set([...(Array.isArray(task.warnings) ? task.warnings : []), ...vacuousCheck.warnings])];
            const prevVacuous = Array.isArray(task.vacuous_tests) ? task.vacuous_tests : [];
            task.vacuous_tests = [...prevVacuous, ...vacuousCheck.vacuousTests];
            console.warn(`[Validator] Warning vacuous_test (${vacuousCheck.vacuousTests.length}): ${vacuousCheck.warnings.join('; ')}`);
          } else {
            const summaryStr = (vacuousCheck.parentTestResults || [])
              .map(r => `${r.test_name}=${r.parent_failure_kind}(${r.verification_strength})`)
              .join(', ');
            console.log(`[Validator] Parent test failure classification: ${summaryStr}`);
          }
          recordTaskStep(task, {
            step: '3.5',
            attempt: retries + 1,
            role: 'validator',
            action: 'vacuous_test_check',
            requested_model: '0-token',
            actual_model: '0-token',
            model: '0-token',
            status: vacuousCheck.vacuousTests?.length > 0 ? 'warning' : 'ok',
            ...(vacuousCheck.vacuousTests?.length > 0 ? { warnings: vacuousCheck.vacuousTests, vacuous_tests: vacuousCheck.vacuousTests } : {}),
            parent_failure_kind: vacuousCheck.parent_failure_kind || null,
            parent_test_results: vacuousCheck.parentTestResults || [],
            duration_ms: vacuousCheck.durationMs || 0,
            note: vacuousCheck.vacuousTests?.length > 0
              ? `Detected ${vacuousCheck.vacuousTests.length} vacuous new test(s) passing on parent`
              : `Parent failure kind: ${vacuousCheck.parent_failure_kind || 'none'}`
          });
        }

        finalSuccessStatus = baselineEval.final_status === 'done_with_known_failures' ? 'done_with_known_failures' : 'done';
        task.known_failures = baselineEval.known_failures || [];
        task.flaky_baseline_failures = baselineEval.flaky_baseline_failures || task.flaky_baseline_failures || [];
        if (task.validation_result && typeof task.validation_result === 'object') {
          task.validation_result.baseline_outcome = finalSuccessStatus;
          task.validation_result.known_failures = task.known_failures;
        }
        if (finalSuccessStatus === 'done_with_known_failures') {
          console.log(`[Validator] Accepting outcome="${finalSuccessStatus}" (${task.known_failures.length} documented out-of-scope baseline failure(s)).`);
        }

        isValidationSkipped = Boolean(fastVal?.skipped && suiteVal?.skipped);
        validationPassed = true;
        markAttemptPatchValidationStatus(retries + 1, isValidationSkipped ? 'skipped' : 'passed');
        } finally {
          phaseTracker.addValidateMs(Math.max(0, Date.now() - validatePhaseStartMs));
        }

        updateLiveStatus({
          roles_status: {
            writer: { model: writerModel, status: 'done' },
            validator: { status: isValidationSkipped ? 'skipped' : 'passed' },
            reviewer: { status: 'idle' }
          },
          scope_files: allTaskFiles.map(f => ({
            path: f,
            status: isValidationSkipped ? 'applied' : 'validated'
          }))
        });

        const postPatchRiskOutcome = applyPostPatchDiffRiskFloor({
          task,
          diffText: taskDiffText,
          policy: policyConfig.policy,
          roles: teamConfig.roles,
          usedWriterModels: [...usedWriterModels]
        });
        if (postPatchRiskOutcome.escalated_to_high) {
          console.warn(
            `[PostPatchRisk] Escalated effective risk ${postPatchRiskOutcome.pre_patch_risk_level} -> ${postPatchRiskOutcome.post_patch_risk_level} ` +
            `(${postPatchRiskOutcome.reason}). Reviewer=${postPatchRiskOutcome.reviewerRequired ? 'required' : 'unavailable->awaiting_confirmation'}`
          );
        }

        // Step E: Risk-Gated & Mode-Based Reviewer Gate (with Anti-Self-Review Invariant)
        // Only invokes AI Reviewer when risk_level >= review_min_risk_level ('high'/'critical') or force_ai_review: true,
        // and when Reviewer model is distinct from the active Writer model.
        if (shouldRunReviewerGate(task, policyConfig.policy, teamConfig.roles, [...usedWriterModels])) {
          task.status = 'reviewing';
          const effectiveReviewerModel = teamConfig.roles?.reviewer?.model || teamConfig.roles?.techlead?.model || writerModel;
          updateLiveStatus({
            current_stage: 'reviewer',
            stage_started_at: new Date().toISOString(),
            roles_status: {
              writer: { model: writerModel, status: 'done' },
              validator: { status: 'passed' },
              reviewer: { model: effectiveReviewerModel, status: 'working' }
            }
          });

          const reviewStartMs = Date.now();
          const revRes = await runReviewerGate(task, actualModifiedFiles, previousReviewIssues, writerModel, {
            specArtifacts: generatedArtifacts
          });
          const reviewerActualModel = revRes.model || effectiveReviewerModel;
          if (revRes.usage) {
            taskTokensUsed = accumulateTaskAndStateUsage(state, revRes.usage, taskTokensUsed);
          }
          recordTaskStep(task, {
            step: '3.1',
            attempt: retries + 1,
            role: 'reviewer',
            action: 'review_diff',
            requested_model: revRes.requested_model || effectiveReviewerModel,
            actual_model: revRes.actual_model || reviewerActualModel,
            model: revRes.actual_model || reviewerActualModel,
            fallback_activated: Boolean(revRes.fallback_activated),
            fallback_reason: revRes.fallback_reason || null,
            scope: actualModifiedFiles,
            ...extractUsageTelemetryFields(revRes),
            duration_ms: Math.max(1, Date.now() - reviewStartMs),
            status: revRes.ok ? 'approved' : 'rejected'
          });
          if (revRes.reviewResult) {
            task.review_result = revRes.reviewResult;
          }
          if (!revRes.ok) {
            if (Array.isArray(revRes.reviewResult?.issues) && revRes.reviewResult.issues.length > 0) {
              previousReviewIssues = revRes.reviewResult.issues;
            }
            const reviewOutcome = resolveReviewStageOutcome({
              task,
              revRes,
              attemptNum: retries + 1,
              rollbackTargets: getRollbackTargets(),
              rollbackFn: (targets) => {
                if (rollbackOnValidationFail) {
                  rollback(targets);
                }
              },
              onRejectedReview: () => handleStageFailure('review', revRes.error, hashString(revRes.error)),
              teamDir: TEAM_DIR
            });
            if (reviewOutcome.action === 'break_blocked') {
              validationPassed = reviewOutcome.validationPassed;
              activeRollbackTargets = [];
              blockReason = reviewOutcome.blockReason;
              updateLiveStatus({
                roles_status: {
                  writer: { model: writerModel, status: 'done' },
                  validator: { status: 'passed' },
                  reviewer: { model: reviewerActualModel, status: 'blocked' }
                }
              });
              break;
            }
            updateLiveStatus({
              roles_status: {
                writer: { model: writerModel, status: 'done' },
                validator: { status: 'passed' },
                reviewer: { model: reviewerActualModel, status: 'rejected' }
              }
            });
            if (reviewOutcome.action === 'break_rejected') break;
            continue;
          }
          updateLiveStatus({
            roles_status: {
              writer: { model: writerModel, status: 'done' },
              validator: { status: 'passed' },
              reviewer: { model: reviewerActualModel, status: 'approved' }
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

        // Step F: Scoped Git Commit (with Frontend Branch + User Confirmation Gate before Merge)
        if (autoCommitOnDone && actualModifiedFiles.length > 0) {
          updateLiveStatus({
            current_stage: 'git',
            stage_started_at: new Date().toISOString()
          });
          const commitPhaseStartMs = Date.now();
          let commitRes;
          try {
            commitRes = finalizeTaskCommitWithFrontendGate({
              task,
              actualModifiedFiles,
              commitPrefix,
              finalSuccessStatus,
              policyConfig,
              cwd: REPO_ROOT
            });
          } finally {
            phaseTracker.addCommitMs(Math.max(0, Date.now() - commitPhaseStartMs));
          }
          if (commitRes.ok) {
            finalSuccessStatus = commitRes.finalSuccessStatus;
            activeRollbackTargets = [];
            if (commitRes.awaitingConfirmation) {
              console.log(`[GitGuard] Committed frontend changes on branch "${commitRes.branch}" (${commitRes.hash.slice(0, 7)}). Waiting for user confirmation before merging into ${commitRes.baseBranch}: ${commitRes.mergeCommand}`);
            }
          } else {
            // D2: the work passed every gate; keep it on disk instead of rolling it back.
            const preservedFiles = Array.from(new Set(actualModifiedFiles));
            let readyPatchPath = null;
            try {
              readyPatchPath = saveAttemptPatchDiff(
                task.task_id,
                'ready-to-commit',
                getScopedDiff(preservedFiles, { cwd: REPO_ROOT }) || '',
                TEAM_DIR,
                'ready-to-commit.patch'
              );
            } catch {}
            task.preserve_worktree = true;
            task.commit_error = String(commitRes.error || 'unknown commit error');
            task.preserved_files = preservedFiles;
            preserveWorktreeOnExit = true;
            activeRollbackTargets = [];
            blockReason = `Git commit failed: ${commitRes.error}. Worktree PRESERVED (validated changes kept on disk) in: ${preservedFiles.join(', ') || '(none detected)'}.`
              + `${readyPatchPath ? ` Backup diff: ${path.relative(REPO_ROOT, readyPatchPath).replace(/\\/g, '/')}.` : ''}`
              + ' Recover: commit manually (git add + git commit) then set status back to "ready", or discard with git checkout -- <files>.';
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
      // Any exception that escaped the stage handlers (#19) must not leave a half-applied worktree behind.
      rollbackOnExit = true;
    } finally {
      if (rollbackOnExit && !preserveWorktreeOnExit && !isTaskDone && activeRollbackTargets.length > 0) {
        const exitRb = safeRollback(activeRollbackTargets);
        if (exitRb.ok) {
          console.warn(`[Orchestrator] Safety-net rollback on task exit: ${activeRollbackTargets.join(', ')}`);
        } else {
          console.error(`[Orchestrator] Safety-net rollback failed: ${exitRb.error}`);
        }
      }
      activeRollbackTargets = [];
      // ==========================================
      // 3.2 POST-HOOK (0-Token Atomic Post-Report via Single Canonical State Transition)
      // ==========================================
      finalizeTaskExecution({
        task,
        tFile,
        taskPath,
        state,
        taskTokensUsed,
        stateTokensBeforeTask,
        isTaskDone,
        finalSuccessStatus,
        actualModifiedFiles,
        validationPassed,
        retries,
        blockReason,
        maxRetries,
        phaseTracker,
        taskRunId,
        paths: {
          activeTasksDir: ACTIVE_TASKS_DIR,
          archiveTasksDir: ARCHIVE_TASKS_DIR,
          stateDir: STATE_DIR,
          stateFile: STATE_FILE
        },
        callbacks: {
          updateLiveStatusFn: updateLiveStatus,
          persistTaskStateWithConflictRecoveryFn: persistTaskStateWithConflictRecovery,
          saveStateAtomicFn: saveStateAtomic,
          mergeTaskStateOnConflictFn: mergeTaskStateOnConflict,
          writeMorningReportFn: writeMorningReport
        }
      });
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
  const cliArgs = process.argv.slice(2);
  if (cliArgs.includes('--force-unlock')) {
    runForceUnlockCli({
      role: 'orchestrator',
      lockFilePath: LOCK_FILE,
      argv: cliArgs
    }).then((res) => process.exit(res.code));
  } else {
    runOrchestrator().catch(err => {
      const fatalRes = handleOrchestratorFatalError(err);
      process.exit(fatalRes.code);
    });
  }
}
