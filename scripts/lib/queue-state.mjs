#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { loadYamlSafe } from './policy-loader.mjs';
import { analyzeTaskDemand } from './risk-policy.mjs';
import {
  mutateVersionedJsonAtomic,
  withStateFileLock,
  writeFileAtomicRaw,
  writeJsonAtomicRaw
} from './state-store.mjs';

/**
 * Extracts a canonical trimmed task ID string from a task object or ID string.
 */
export function getTaskId(raw) {
  if (typeof raw === 'string') return raw.trim();
  if (!raw || typeof raw !== 'object') return '';
  const inner = (raw.task && typeof raw.task === 'object') ? raw.task : raw;
  return String(inner.task_id || inner.id || '').trim();
}

/**
 * Normalizes a task record into the canonical summary/queue shape used across
 * orchestrator reports, live-status snapshots, and Cockpit UI.
 */
export function extractPendingReviewPatch(src = {}) {
  const explicit = src.pending_review_patch || src.last_report?.pending_review_patch;
  if (typeof explicit === 'string' && explicit.trim()) {
    return explicit.trim();
  }
  const reason = String(src.block_reason || src.last_error || src.last_report?.blocker_reason || '');
  const m = reason.match(/patch saved to\s+([^\s]+\.patch)/i);
  return m ? m[1].trim() : null;
}

export function buildGitApplyCommand(patchPath) {
  const clean = String(patchPath || '').replace(/[\r\n]+/g, '').trim();
  if (!clean) return null;
  if (/^[a-zA-Z0-9._\-\/\\]+$/.test(clean) && !/\s/.test(clean)) {
    return `git apply ${clean}`;
  }
  return `git apply "${clean.replace(/"/g, '\\"')}"`;
}

export function resolveTaskUnseenExactMatches(task = {}) {
  const dedup = new Map();
  const addItem = (m, fallbackAttempt = null) => {
    if (!m || typeof m !== 'object' || !m.file) return;
    const isDelete = Boolean(m.is_delete || m.action_kind === 'delete');
    const item = {
      block: Number(m.block || 0),
      file: String(m.file || ''),
      start_line: Number(m.start_line || 0),
      end_line: Number(m.end_line || 0),
      ...(m.non_empty_lines !== undefined && m.non_empty_lines !== null
        ? { non_empty_lines: Number(m.non_empty_lines) }
        : {}),
      is_delete: isDelete,
      action_kind: isDelete ? 'delete' : (m.action_kind ? String(m.action_kind) : 'modify'),
      ...((m.attempt ?? fallbackAttempt) !== null && (m.attempt ?? fallbackAttempt) !== undefined
        ? { attempt: Number(m.attempt ?? fallbackAttempt) }
        : {})
    };
    const key = `${item.attempt ?? ''}:${item.block}:${item.file}:${item.start_line}-${item.end_line}`;
    if (!dedup.has(key)) dedup.set(key, item);
  };

  if (Array.isArray(task?.last_report?.unseen_exact_matches) && task.last_report.unseen_exact_matches.length > 0) {
    for (const m of task.last_report.unseen_exact_matches) addItem(m, null);
  } else if (Array.isArray(task?.unseen_exact_matches) && task.unseen_exact_matches.length > 0) {
    for (const m of task.unseen_exact_matches) addItem(m, null);
  } else if (Array.isArray(task?.steps)) {
    for (const st of task.steps) {
      if (Array.isArray(st?.unseen_exact_matches)) {
        for (const m of st.unseen_exact_matches) addItem(m, st.attempt ?? null);
      }
    }
  }
  return Array.from(dedup.values());
}

export function collectUnseenExactMatchQueue(tasks = []) {
  if (!Array.isArray(tasks)) return [];
  const entries = [];
  for (const t of tasks) {
    if (!t || typeof t !== 'object') continue;
    const blocks = resolveTaskUnseenExactMatches(t);
    if (blocks.length === 0) continue;
    const deleteCount = blocks.filter(b => b.is_delete || b.action_kind === 'delete').length;
    entries.push({
      task_id: t.task_id || t.id,
      title: t.title || t.task_id || t.id,
      status: t.status || 'done',
      block_count: blocks.length,
      delete_count: deleteCount,
      modify_count: blocks.length - deleteCount,
      blocks
    });
  }
  return entries;
}

export function collectManualReviewQueue(blockedList = []) {
  if (!Array.isArray(blockedList)) return [];
  const entries = [];
  for (const t of blockedList) {
    if (!t || typeof t !== 'object') continue;
    const isManualReview =
      t.failure_class === 'review_unavailable' ||
      /review_unavailable/i.test(String(t.block_reason || ''));
    if (!isManualReview) continue;
    const patchPath = extractPendingReviewPatch(t);
    const applyCmd = t.apply_command || (patchPath ? buildGitApplyCommand(patchPath) : null);
    entries.push({
      task_id: t.task_id,
      title: t.title || t.task_id,
      failure_class: 'review_unavailable',
      pending_review_patch: patchPath || null,
      apply_command: applyCmd,
      block_reason: t.block_reason || 'review_unavailable'
    });
  }
  return entries;
}

export function normalizeQueueTask(raw, defaultStatus = null) {
  const src = (raw?.task && typeof raw.task === 'object') ? raw.task : raw;
  if (!src || typeof src !== 'object') return null;
  const tid = getTaskId(src);
  if (!tid) return null;

  const status = String(defaultStatus || src.status || 'ready').toLowerCase();
  const normalized = {
    task_id: tid,
    title: src.title || src.goal || 'Untitled Task',
    mode: src.mode || 'quick',
    status,
    risk_level: src.risk_level || 'low',
    scope: Array.isArray(src.scope) ? src.scope : [],
    goal: src.goal || null,
    model: src.model || null,
    writer_model: src.writer_model || null,
    writer_model_source: src.writer_model_source || null,
    acceptance_criteria: Array.isArray(src.acceptance_criteria) ? src.acceptance_criteria : [],
    constraints: Array.isArray(src.constraints) ? src.constraints : [],
    writer_hub_workflow: Array.isArray(src.writer_hub_workflow) ? src.writer_hub_workflow : [],
    task_demand: src.task_demand || null,
    scope_warnings: Array.isArray(src.scope_warnings) ? src.scope_warnings : [],
    steps: Array.isArray(src.steps) ? src.steps : [],
    last_report: (src.last_report && typeof src.last_report === 'object') ? src.last_report : null,
    ...(src.edit_lines_outside_window !== undefined && src.edit_lines_outside_window !== null
      ? { edit_lines_outside_window: Number(src.edit_lines_outside_window) }
      : {}),
    retries: src.retries || 0,
    commit_hash: src.commit_hash || null,
    ...(src.pending_branch ? { pending_branch: String(src.pending_branch) } : {}),
    ...(src.base_branch ? { base_branch: String(src.base_branch) } : {}),
    ...(src.merge_command ? { merge_command: String(src.merge_command) } : {}),
    ...(src.requires_user_confirmation !== undefined
      ? { requires_user_confirmation: Boolean(src.requires_user_confirmation) }
      : {}),
    ...(src.preserve_worktree === true ? { preserve_worktree: true } : {}),
    ...(src.commit_error ? { commit_error: String(src.commit_error).slice(0, 600) } : {}),
    ...(Array.isArray(src.preserved_files) && src.preserved_files.length > 0
      ? { preserved_files: Array.from(new Set(src.preserved_files.map(f => String(f || '').trim()).filter(Boolean))) }
      : {}),
    ...(src.run_id ? { run_id: String(src.run_id) } : {}),
    ...(src.last_counted_run_id ? { last_counted_run_id: String(src.last_counted_run_id) } : {}),
    ...(src.archived_from_status ? { archived_from_status: String(src.archived_from_status) } : {}),
    created_at: src.created_at || null,
    updated_at: src.updated_at || null,
    completed_at: src.completed_at || null
  };

  const unseenMatches = resolveTaskUnseenExactMatches(src);
  if (unseenMatches.length > 0) {
    normalized.unseen_exact_matches = unseenMatches;
    normalized.unseen_exact_match_count = unseenMatches.length;
  }

  const vacuousTests = [];
  const seenVacuous = new Set();
  const addVacuous = (v) => {
    if (!v || typeof v !== 'object') return;
    if (String(v.code || '') !== 'vacuous_test' && !v.test_name) return;
    const key = `${v.file || ''}:${v.test_name || ''}`;
    if (seenVacuous.has(key)) return;
    seenVacuous.add(key);
    vacuousTests.push({
      code: 'vacuous_test',
      test_name: String(v.test_name || ''),
      file: String(v.file || ''),
      parent_ref: String(v.parent_ref || 'HEAD'),
      status: String(v.status || 'passed_on_parent')
    });
  };
  for (const v of (Array.isArray(src.vacuous_tests) ? src.vacuous_tests : [])) addVacuous(v);
  for (const w of (Array.isArray(src.warnings) ? src.warnings : [])) {
    if (w && typeof w === 'object' && w.code === 'vacuous_test') addVacuous(w);
  }
  for (const st of (Array.isArray(src.steps) ? src.steps : [])) {
    for (const v of (Array.isArray(st?.vacuous_tests) ? st.vacuous_tests : [])) addVacuous(v);
    for (const w of (Array.isArray(st?.warnings) ? st.warnings : [])) {
      if (w && typeof w === 'object' && w.code === 'vacuous_test') addVacuous(w);
    }
  }
  if (vacuousTests.length > 0) {
    normalized.vacuous_tests = vacuousTests;
  }
  if (src.phase_timings && typeof src.phase_timings === 'object') {
    normalized.phase_timings = {
      preflight_ms: Math.max(0, Number(src.phase_timings.preflight_ms || 0)),
      baseline_ms: Math.max(0, Number(src.phase_timings.baseline_ms || 0)),
      writer_ms: Array.isArray(src.phase_timings.writer_ms) ? src.phase_timings.writer_ms.map(w => ({ ...w })) : [],
      validate_ms: Math.max(0, Number(src.phase_timings.validate_ms || 0)),
      fast_retry_validation_ms: Math.max(0, Number(src.phase_timings.fast_retry_validation_ms || 0)),
      commit_ms: Math.max(0, Number(src.phase_timings.commit_ms || 0))
    };
  }

  if (status === 'blocked' || status === 'failed') {
    normalized.block_reason = src.block_reason || src.last_error || 'Blocked';
    const rawFailureClass = src.failure_class || src.last_report?.failure_class || null;
    const isReviewUnavailable =
      rawFailureClass === 'review_unavailable' ||
      /review_unavailable/i.test(String(normalized.block_reason || ''));
    if (isReviewUnavailable) {
      normalized.failure_class = 'review_unavailable';
    } else if (rawFailureClass) {
      normalized.failure_class = String(rawFailureClass);
    }
    if (src.contract_conflict_report && typeof src.contract_conflict_report === 'object') {
      normalized.contract_conflict_report = { ...src.contract_conflict_report };
    }
    const patchPath = extractPendingReviewPatch(src);
    if (patchPath) {
      normalized.pending_review_patch = patchPath;
      normalized.apply_command = buildGitApplyCommand(patchPath);
    }
  }
  if (src.retried_at) {
    normalized.retried_at = src.retried_at;
  }

  return normalized;
}

/**
 * Scans a task directory (`tasks/active` or `tasks/archive`) using fail-closed YAML loading.
 */
export function scanCanonicalTaskDir(dirPath) {
  const result = new Map();
  if (!dirPath || !fs.existsSync(dirPath)) return result;

  try {
    const files = fs.readdirSync(dirPath)
      .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
      .sort();
    for (const f of files) {
      const full = path.resolve(dirPath, f);
      const parsed = loadYamlSafe(full);
      if (!parsed || typeof parsed !== 'object') continue;
      const item = normalizeQueueTask(parsed);
      if (!item || result.has(item.task_id)) continue;
      result.set(item.task_id, item);
    }
  } catch {
    // Non-throwing scan on unreadable directory
  }
  return result;
}

/**
 * Single Source of Truth for task queue lists and counts across Orchestrator,
 * morning-report.md, live-status.json, and Dashboard /api/snapshot.
 *
 * Precedence (mutually exclusive): completed (archive/done) > blocked/failed > active.
 * Stale active_tasks / blocked_tasks entries in task-state.json without a backing YAML
 * file in tasks/active/ are ignored so deleted or edited tasks never create phantom counts.
 */
export function computeCanonicalQueueState({
  tasksActiveDir,
  tasksArchiveDir,
  taskState = null
} = {}) {
  const archiveMap = scanCanonicalTaskDir(tasksArchiveDir);
  const activeDiskMap = scanCanonicalTaskDir(tasksActiveDir);

  const completedMap = new Map();
  const blockedMap = new Map();
  const activeMap = new Map();

  for (const [tid, item] of archiveMap.entries()) {
    const rawStatus = String(item?.status || 'done').toLowerCase();
    const archiveStatus = rawStatus === 'done_with_known_failures'
      ? 'done_with_known_failures'
      : 'done';
    const wasNonDone = rawStatus !== 'done' && rawStatus !== 'done_with_known_failures';
    completedMap.set(tid, {
      ...item,
      status: archiveStatus,
      ...(wasNonDone ? { archived_from_status: rawStatus } : {})
    });
  }

  for (const [tid, item] of activeDiskMap.entries()) {
    if (completedMap.has(tid)) continue;
    const status = String(item.status || 'ready').toLowerCase();
    if (status === 'done' || status === 'done_with_known_failures') {
      completedMap.set(tid, { ...item, status });
    } else if (status === 'blocked' || status === 'failed') {
      blockedMap.set(tid, {
        ...item,
        status,
        block_reason: item.block_reason || 'Blocked'
      });
    } else {
      activeMap.set(tid, item);
    }
  }

  const mergeTaskStateTelemetryIntoMap = (targetMap, rawList = []) => {
    for (const raw of (rawList || [])) {
      const tid = getTaskId(raw);
      if (!tid || !targetMap.has(tid)) continue;
      const diskEntry = targetMap.get(tid);
      const srcObj = (raw?.task && typeof raw.task === 'object') ? raw.task : raw;
      if ((!diskEntry.steps || diskEntry.steps.length === 0) && Array.isArray(srcObj?.steps) && srcObj.steps.length > 0) {
        diskEntry.steps = srcObj.steps;
      }
      if (!diskEntry.last_report && srcObj?.last_report && typeof srcObj.last_report === 'object') {
        diskEntry.last_report = srcObj.last_report;
      }
      if (diskEntry.edit_lines_outside_window === undefined && srcObj?.edit_lines_outside_window !== undefined) {
        diskEntry.edit_lines_outside_window = Number(srcObj.edit_lines_outside_window);
      }
      if (!diskEntry.commit_hash && srcObj?.commit_hash) {
        diskEntry.commit_hash = srcObj.commit_hash;
      }
      if (!diskEntry.pending_branch && srcObj?.pending_branch) {
        diskEntry.pending_branch = srcObj.pending_branch;
      }
      if (!diskEntry.merge_command && srcObj?.merge_command) {
        diskEntry.merge_command = srcObj.merge_command;
      }
      if (!diskEntry.preserve_worktree && srcObj?.preserve_worktree === true) {
        diskEntry.preserve_worktree = true;
        if (srcObj.commit_error) diskEntry.commit_error = String(srcObj.commit_error).slice(0, 600);
      }
      if ((!Array.isArray(diskEntry.preserved_files) || diskEntry.preserved_files.length === 0) && Array.isArray(srcObj?.preserved_files) && srcObj.preserved_files.length > 0) {
        diskEntry.preserved_files = Array.from(new Set(srcObj.preserved_files.map(f => String(f || '').trim()).filter(Boolean)));
      }
      const unseenMerged = resolveTaskUnseenExactMatches(diskEntry);
      if (unseenMerged.length > 0) {
        diskEntry.unseen_exact_matches = unseenMerged;
        diskEntry.unseen_exact_match_count = unseenMerged.length;
      }
      if ((!Array.isArray(diskEntry.vacuous_tests) || diskEntry.vacuous_tests.length === 0) && Array.isArray(srcObj?.vacuous_tests) && srcObj.vacuous_tests.length > 0) {
        diskEntry.vacuous_tests = srcObj.vacuous_tests;
      }
      if (!diskEntry.phase_timings && srcObj?.phase_timings && typeof srcObj.phase_timings === 'object') {
        diskEntry.phase_timings = srcObj.phase_timings;
      }
      if (!diskEntry.failure_class && srcObj?.failure_class) {
        diskEntry.failure_class = String(srcObj.failure_class);
      }
      if (!diskEntry.contract_conflict_report && srcObj?.contract_conflict_report && typeof srcObj.contract_conflict_report === 'object') {
        diskEntry.contract_conflict_report = srcObj.contract_conflict_report;
      }
      if (!diskEntry.run_id && srcObj?.run_id) {
        diskEntry.run_id = String(srcObj.run_id);
      }
      if (!diskEntry.last_counted_run_id && srcObj?.last_counted_run_id) {
        diskEntry.last_counted_run_id = String(srcObj.last_counted_run_id);
      }
    }
  };

  mergeTaskStateTelemetryIntoMap(blockedMap, taskState?.blocked_tasks);
  mergeTaskStateTelemetryIntoMap(activeMap, taskState?.active_tasks);
  mergeTaskStateTelemetryIntoMap(completedMap, taskState?.completed_tasks);

  for (const raw of (taskState?.completed_tasks || [])) {
    const tid = getTaskId(raw);
    if (!tid || completedMap.has(tid) || blockedMap.has(tid) || activeMap.has(tid)) continue;
    const item = typeof raw === 'string'
      ? { task_id: tid, title: tid, mode: 'quick', status: 'done', retries: 0 }
      : normalizeQueueTask(raw, 'done');
    if (item) {
      completedMap.set(tid, item);
    }
  }

  const active = Array.from(activeMap.values());
  const blocked = Array.from(blockedMap.values());
  const manual_review = collectManualReviewQueue(blocked);
  const completed = Array.from(completedMap.values());
  const awaiting_confirmation = active.filter(t => String(t?.status || '').toLowerCase() === 'awaiting_confirmation');
  const unseen_exact_matches = collectUnseenExactMatchQueue([...completed, ...blocked, ...active]);
  const unseen_exact_match_count = unseen_exact_matches.reduce((acc, item) => acc + item.block_count, 0);

  return {
    active,
    awaiting_confirmation,
    blocked,
    manual_review,
    completed,
    unseen_exact_matches,
    unseen_exact_match_count,
    counts: {
      active: active.length,
      completed: completed.length,
      blocked: blocked.length
    }
  };
}

/**
 * Synchronizes an in-memory `taskState` object to match canonical queue lists
 * cleanly before writing `task-state.json` or generating reports.
 */
export function syncCanonicalTaskState(state = {}, canonical) {
  if (!state || typeof state !== 'object' || !canonical) return state;
  state.active_tasks = canonical.active;
  state.blocked_tasks = canonical.blocked;
  state.completed_tasks = canonical.completed;
  if (!state.metrics || typeof state.metrics !== 'object') {
    state.metrics = { total_input_tokens: 0, total_output_tokens: 0, total_cost_est_usd: 0 };
  }
  const doneCount = Number(canonical?.counts?.completed || 0);
  const blockedCount = Number(canonical?.counts?.blocked || 0);
  const totalTok = Number(state.metrics.total_input_tokens || 0) + Number(state.metrics.total_output_tokens || 0);
  const totalCost = Number(state.metrics.total_cost_est_usd || 0);

  state.metrics.tasks_completed = doneCount;
  state.metrics.tasks_blocked = blockedCount;
  // Cumulative average tokens & USD cost per currently completed task across session history
  state.metrics.tokens_per_completed_task = doneCount > 0 ? Math.round(totalTok / doneCount) : null;
  state.metrics.cost_per_completed_task = doneCount > 0
    ? Math.round((totalCost / doneCount) * 10000) / 10000
    : null;
  return state;
}

/**
 * Finds the YAML file path for a given task_id inside `tasksActiveDir`.
 */
export function findTaskYamlFile(tasksActiveDir, taskId) {
  if (!tasksActiveDir || !taskId || !fs.existsSync(tasksActiveDir)) return null;
  const directCandidates = [
    path.resolve(tasksActiveDir, `${taskId}.yaml`),
    path.resolve(tasksActiveDir, `${taskId}.yml`)
  ];
  for (const fp of directCandidates) {
    if (fs.existsSync(fp)) return fp;
  }

  const allFiles = fs.readdirSync(tasksActiveDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  for (const af of allFiles) {
    const fp = path.resolve(tasksActiveDir, af);
    const parsed = loadYamlSafe(fp);
    if (!parsed) continue;
    if (getTaskId(parsed) === taskId) {
      return fp;
    }
  }
  return null;
}

/**
 * Atomically writes JSON payload to disk using lock + unique tmp + rename retry.
 */
export function writeJsonAtomic(filePath, data, options = {}) {
  if (!filePath) return false;
  return withStateFileLock(filePath, () => writeJsonAtomicRaw(filePath, data), options);
}

/**
 * Atomically writes YAML task container/object to disk using unique tmp + rename retry.
 */
export function writeTaskYamlAtomic(filePath, data) {
  if (!filePath) return false;
  return writeFileAtomicRaw(filePath, YAML.stringify(data));
}

/**
 * Atomically merges a partial update into `live-status.json` under state lock + revision check.
 */
export function updateLiveStatusFilePatch(liveStatusFile, patch = {}, options = {}) {
  if (!liveStatusFile) return false;
  try {
    mutateVersionedJsonAtomic(liveStatusFile, (current) => ({
      ...current,
      ...patch,
      updated_at: new Date().toISOString()
    }), {
      allowCorruptFallback: true,
      fallbackFactory: () => ({}),
      ...options
    });
    return true;
  } catch {
    return false;
  }
}

function sanitizeSummaryText(str = '') {
  return String(str || '').replace(/[\r\n\x1B]/g, ' ').slice(0, 80).trim();
}

/**
 * Computes read-only first-attempt validator pass rates grouped by (model, domain)
 * with explicit sample counts. Strictly observational (never modifies routing/config).
 */
export function computeFirstAttemptValidationStats(tasks = [], policyConfig = {}) {
  const buckets = new Map();
  const seenTaskIds = new Set();

  for (const t of (Array.isArray(tasks) ? tasks : [])) {
    if (!t || typeof t !== 'object') continue;
    const tid = getTaskId(t);
    if (tid) {
      if (seenTaskIds.has(tid)) continue;
      seenTaskIds.add(tid);
    }
    const mode = String(t.mode || '').toLowerCase();
    if (mode === 'consult') continue;

    const steps = Array.isArray(t.steps) ? t.steps : [];
    const attempt1PatchSteps = steps.filter(
      s => s && Number(s.attempt) === 1 && String(s.action || '').startsWith('apply_patch')
    );

    // Determine domain from attempt-1 patch step or task scope
    const firstPatch = attempt1PatchSteps[0] || null;
    const domainScope = Array.isArray(firstPatch?.scope) && firstPatch.scope.length > 0
      ? firstPatch.scope
      : (Array.isArray(t.scope) ? t.scope : []);
    let domain = firstPatch?.domain && ['backend', 'frontend', 'fullstack'].includes(firstPatch.domain)
      ? firstPatch.domain
      : null;
    if (!domain) {
      const demand = analyzeTaskDemand({ scope: domainScope, mode: t.mode }, policyConfig);
      if (demand.hasBackend && demand.hasFrontend) domain = 'fullstack';
      else if (demand.hasFrontend) domain = 'frontend';
      else if (demand.hasBackend) domain = 'backend';
      else domain = 'other';
    }

    const model = String(
      firstPatch?.actual_model
      || firstPatch?.model
      || t.writer_model
      || t.model
      || 'unknown'
    ).trim() || 'unknown';

    let passedFirstAttempt = false;
    const explicitStatuses = attempt1PatchSteps
      .map(s => String(s.validation_status || '').toLowerCase())
      .filter(st => st === 'passed' || st === 'failed');

    if (explicitStatuses.length > 0) {
      passedFirstAttempt = explicitStatuses.every(st => st === 'passed');
    } else {
      const hasSuccessStatus = t.last_report?.validation_passed === true
        || t.status === 'done'
        || t.status === 'done_with_known_failures';
      const retriesUsed = Number(t.last_report?.retries_used ?? t.retries ?? 0);
      if (!hasSuccessStatus && t.status !== 'blocked' && t.status !== 'failed') {
        continue;
      }
      passedFirstAttempt = Boolean(hasSuccessStatus && retriesUsed === 0);
    }

    const key = `${model}\u0000${domain}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        model,
        domain,
        first_attempt_passed: 0,
        samples: 0,
        pass_rate: 0
      });
    }
    const row = buckets.get(key);
    row.samples += 1;
    if (passedFirstAttempt) row.first_attempt_passed += 1;
    row.pass_rate = Number((row.first_attempt_passed / row.samples).toFixed(4));
  }

  return [...buckets.values()].sort((a, b) =>
    (b.samples - a.samples) || a.model.localeCompare(b.model) || a.domain.localeCompare(b.domain)
  );
}

function resolveTaskOutsideWindowLines(task = {}) {
  const fromReport = task?.last_report?.edit_lines_outside_window;
  if (fromReport !== undefined && fromReport !== null && Number.isFinite(Number(fromReport))) {
    return Number(fromReport);
  }
  if (task?.edit_lines_outside_window !== undefined && task?.edit_lines_outside_window !== null && Number.isFinite(Number(task.edit_lines_outside_window))) {
    return Number(task.edit_lines_outside_window);
  }
  if (Array.isArray(task?.steps) && task.steps.length > 0) {
    return task.steps.reduce((acc, s) => acc + Number(s?.edit_lines_outside_window || 0), 0);
  }
  return 0;
}

/**
 * Renders and writes morning-report.md directly from canonical queue state so
 * report counts always equal snapshot/live-status counts.
 */
export function writeMorningReportFile(state = {}, options = {}) {
  const {
    tasksActiveDir,
    tasksArchiveDir,
    reportFile,
    policyConfig = {}
  } = options;
  if (!reportFile) return null;

  const canonical = computeCanonicalQueueState({
    tasksActiveDir,
    tasksArchiveDir,
    taskState: state
  });
  syncCanonicalTaskState(state, canonical);

  const metrics = state?.metrics || {};
  const awaitingConfirmation = canonical.awaiting_confirmation
    || canonical.active.filter(t => String(t?.status || '').toLowerCase() === 'awaiting_confirmation');
  const totalOutsideWindow = [...canonical.completed, ...canonical.blocked, ...canonical.active]
    .reduce((acc, t) => acc + resolveTaskOutsideWindowLines(t), 0);
  const unseenEntries = canonical.unseen_exact_matches || [];
  const totalUnseenExactCount = unseenEntries.reduce((acc, e) => acc + Number(e.block_count || 0), 0);
  const totalUnseenDeleteCount = unseenEntries.reduce((acc, e) => acc + Number(e.delete_count || 0), 0);
  const formatUnseenSuffix = (t) => {
    const blocks = resolveTaskUnseenExactMatches(t);
    if (blocks.length === 0) return '';
    const detail = blocks
      .map(b => `#${b.block} ${b.file}:${b.start_line}-${b.end_line}${b.is_delete || b.action_kind === 'delete' ? ' [DELETE]' : ''}`)
      .join('; ');
    return `, unseen_exact_match: ${blocks.length} block(s) [${detail}]`;
  };
  const formatArchivedSuffix = (t) => t?.archived_from_status
    ? `, archived_from: \`${t.archived_from_status}\``
    : '';

  const lines = [
    '# Minimal Agent Orchestration — Execution Report (v2.1 Standard)',
    `Generated at: ${new Date().toISOString()}`,
    '',
    '## Summary',
    `- Completed Tasks: ${canonical.counts.completed}`,
    `- Blocked Tasks: ${canonical.counts.blocked}`,
    `- Active Tasks Remaining: ${canonical.counts.active}`,
    `- Awaiting Confirmation Tasks: ${awaitingConfirmation.length}`,
    `- Total Tokens Used: In: ${metrics.total_input_tokens || 0} | Out: ${metrics.total_output_tokens || 0}`,
    `- Edit Lines Outside Window (Run Total): ${totalOutsideWindow}`,
    `- Unseen Exact Matches (Run Total): ${totalUnseenExactCount} block(s)${totalUnseenDeleteCount > 0 ? ` (${totalUnseenDeleteCount} [DELETE])` : ''}`,
    `- Estimated Cost: $${(metrics.total_cost_est_usd || 0).toFixed(4)}`,
    '',
    '## Completed Tasks'
  ];

  if (canonical.completed.length === 0) {
    lines.push('_No tasks completed yet._');
  } else {
    for (const t of canonical.completed) {
      const tid = t.task_id || t.id;
      const displayTitle = t.title || sanitizeSummaryText(t.goal || '') || 'Untitled';
      const outsideLines = resolveTaskOutsideWindowLines(t);
      lines.push(`- **${tid}** [${t.mode || 'quick'}]: ${displayTitle} (Commit: \`${t.commit_hash || 'none'}\`, Retries: ${t.retries || 0}, edit_lines_outside_window: ${outsideLines}${formatUnseenSuffix(t)}${formatArchivedSuffix(t)})`);
    }
  }

  lines.push('', '## Awaiting Confirmation Tasks');
  if (awaitingConfirmation.length === 0) {
    lines.push('_None pending user merge confirmation._');
  } else {
    for (const t of awaitingConfirmation) {
      const tid = t.task_id || t.id;
      const displayTitle = t.title || sanitizeSummaryText(t.goal || '') || 'Untitled';
      const outsideLines = resolveTaskOutsideWindowLines(t);
      const modifiedFiles = Array.isArray(t.last_report?.modified_files) ? t.last_report.modified_files : [];
      const filesInfo = modifiedFiles.length > 0 ? `, Files: \`${modifiedFiles.join(', ')}\`` : '';
      const mergeInfo = t.merge_command ? `, Merge: \`${t.merge_command}\`` : '';
      lines.push(`- **${tid}** [${t.mode || 'quick'}]: ${displayTitle} (Branch: \`${t.pending_branch || 'none'}\`, Commit: \`${t.commit_hash || 'none'}\`, Retries: ${t.retries || 0}, edit_lines_outside_window: ${outsideLines}${filesInfo}${formatUnseenSuffix(t)}${mergeInfo})`);
    }
  }

  lines.push('', '## Blocked Tasks');
  if (canonical.blocked.length === 0) {
    lines.push('_No blocked tasks! 100% smooth flow._');
  } else {
    for (const t of canonical.blocked) {
      const tid = t.task_id || t.id;
      const displayTitle = t.title || sanitizeSummaryText(t.goal || '') || 'Untitled';
      const outsideLines = resolveTaskOutsideWindowLines(t);
      const failureClassTag = t.failure_class ? `, failure_class: ${t.failure_class}` : '';
      lines.push(`- **${tid}** [${t.mode || 'quick'}]: ${displayTitle} (edit_lines_outside_window: ${outsideLines}${failureClassTag}${formatUnseenSuffix(t)}) — Reason: \`${t.block_reason || 'Unknown error'}\``);
      if (t.contract_conflict_report && t.contract_conflict_report.failing_test_name) {
        const ccr = t.contract_conflict_report;
        lines.push(`  - Contract Conflict Test: \`${ccr.failing_test_name}\` | Assertion: \`${ccr.assertion_line || ccr.error_message || 'N/A'}\``);
      }
    }
  }

  lines.push('', '## Unseen Exact Matches');
  if (unseenEntries.length === 0) {
    lines.push('_No unseen exact matches recorded._');
  } else {
    for (const entry of unseenEntries) {
      const delLabel = entry.delete_count > 0 ? `, ${entry.delete_count} [DELETE]` : '';
      lines.push(`- **${entry.task_id}** (${entry.block_count} block(s)${delLabel}):`);
      for (const b of entry.blocks || []) {
        const kindTag = b.is_delete || b.action_kind === 'delete' ? '[DELETE]' : '[MODIFY]';
        lines.push(`  - Block #${b.block}: \`${b.file}:${b.start_line}-${b.end_line}\` ${kindTag}`);
      }
    }
  }

  const vacuousTaskEntries = [...canonical.completed, ...canonical.blocked, ...awaitingConfirmation, ...canonical.active]
    .filter(t => Array.isArray(t?.vacuous_tests) && t.vacuous_tests.length > 0);
  lines.push('', '## Vacuous Test Warnings');
  if (vacuousTaskEntries.length === 0) {
    lines.push('_No vacuous_test warnings recorded._');
  } else {
    for (const t of vacuousTaskEntries) {
      const tid = t.task_id || t.id;
      lines.push(`- **${tid}** (${t.vacuous_tests.length} vacuous_test warning(s)):`);
      for (const vt of t.vacuous_tests) {
        lines.push(`  - \`[vacuous_test]\` \`${vt.file}\` -> \`${vt.test_name}\` (passed on parent \`${vt.parent_ref || 'HEAD'}\`)`);
      }
    }
  }

  const passStats = computeFirstAttemptValidationStats([...canonical.completed, ...canonical.blocked, ...awaitingConfirmation], policyConfig);
  lines.push('', '## First-Attempt Validator Pass Rate (By Model & Domain — Read-Only)');
  if (passStats.length === 0) {
    lines.push('_No validation samples recorded yet._');
  } else {
    lines.push('| Model | Domain | First-Attempt Pass | Samples | Pass Rate |');
    lines.push('| :--- | :--- | ---: | ---: | ---: |');
    for (const row of passStats) {
      const pct = `${(row.pass_rate * 100).toFixed(1)}%`;
      lines.push(`| ${row.model} | ${row.domain} | ${row.first_attempt_passed} / ${row.samples} | ${row.samples} | ${pct} |`);
    }
  }

  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, lines.join('\n'), 'utf8');
  return { ...canonical, first_attempt_validation_stats: passStats };
}
