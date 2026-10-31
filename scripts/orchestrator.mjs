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
  normalizeOrThrow
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(TEAM_DIR, '..');

const LOCK_FILE = path.resolve(TEAM_DIR, '.orchestrator.lock');
const STATE_FILE = path.resolve(TEAM_DIR, 'state', 'task-state.json');
const REPORT_FILE = path.resolve(TEAM_DIR, 'state', 'morning-report.md');
const ACTIVE_TASKS_DIR = path.resolve(TEAM_DIR, 'tasks', 'active');
const ARCHIVE_TASKS_DIR = path.resolve(TEAM_DIR, 'tasks', 'archive');

const MAX_CONTEXT_BYTES_PER_FILE = 64 * 1024;

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
function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      version: '2.1',
      active_tasks: [],
      completed_tasks: [],
      blocked_tasks: [],
      metrics: { total_input_tokens: 0, total_output_tokens: 0, total_cost_est_usd: 0 }
    };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { version: '2.1', active_tasks: [], completed_tasks: [], blocked_tasks: [], metrics: {} };
  }
}

function saveStateAtomic(state) {
  const tmpPath = `${STATE_FILE}.tmp.${Date.now()}`;
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
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
  raw.project_id = raw.project_id || 'tool-download-stable';
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

const teamConfig = loadYaml(path.resolve(TEAM_DIR, 'config', 'team.yaml')) || {};
const projectConfig = loadYaml(path.resolve(TEAM_DIR, 'config', 'project.yaml')) || {};
const policyConfig = loadYaml(path.resolve(TEAM_DIR, 'config', 'policy.yaml')) || {};

// Helpers for v2.1 Policy, Mode Selection & Security
export function computeScopeHash(scope = []) {
  const sorted = [...scope].map(s => s.trim().replace(/\\/g, '/')).sort().join('\n');
  return hashString(sorted);
}

export function resolveTaskMode(task, policy = policyConfig.policy || {}) {
  const explicitMode = (task.mode || '').toLowerCase();
  if (explicitMode === 'direct' || explicitMode === 'quick' || explicitMode === 'standard') {
    return explicitMode;
  }
  const smallThreshold = policy.approval_gates?.small_task_threshold_files ?? 3;
  const scopeLen = Array.isArray(task.scope) ? task.scope.length : 0;
  const allowExpansion = Boolean(task.allow_scope_expansion || task.cross_role_edit);
  const effectiveRisk = (task.risk_level === 'high' || computeDeterministicRisk(task.scope) === 'high') ? 'high' : (task.risk_level || 'low');

  if (scopeLen <= smallThreshold && effectiveRisk === 'low' && !allowExpansion) {
    return 'quick';
  }
  return 'standard';
}

function sanitizeGoal(str = '') {
  return str.replace(/[\r\n\x1B]/g, ' ').slice(0, 80).trim();
}

/**
 * Reads existing files in task.scope so the stateless Writer model has exact lines for SEARCH blocks.
 */
export function buildScopedFilesContext(scope = [], repoRoot = REPO_ROOT) {
  const sections = [];
  for (const rawFile of scope) {
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
      if (Buffer.byteLength(rawContent, 'utf8') > MAX_CONTEXT_BYTES_PER_FILE) {
        const sliced = rawContent.slice(0, MAX_CONTEXT_BYTES_PER_FILE);
        sections.push(`=== FILE: ${relPath} (TRUNCATED TO 64KB) ===\n${sliced}\n... [FILE TRUNCATED AT 64KB]`);
      } else {
        sections.push(`=== FILE: ${relPath} (EXISTING CONTENT) ===\n${rawContent}`);
      }
    } catch (err) {
      sections.push(`=== FILE: ${rawFile} (UNREADABLE: ${err.message}) ===`);
    }
  }
  return sections.join('\n\n');
}

// 4. Local 9Router API Helper (Bounded with AbortSignal.timeout & Fallback Model)
async function call9Router(model, systemPrompt, userMessage, maxTokens = 4096, fallbackModel = null) {
  const baseUrl = teamConfig.providers?.local_9router?.base_url || 'http://127.0.0.1:20128/v1';
  const apiKey = process.env.NINE_ROUTER_API_KEY || teamConfig.providers?.local_9router?.default_key || 'sk-default';
  const timeoutSec = policyConfig.policy?.execution_guardrails?.default_cli_timeout_sec
    || teamConfig.providers?.ide_bridge?.timeout_sec
    || 120;
  const timeoutMs = timeoutSec * 1000;

  const modelsToTry = [model, ...(fallbackModel && fallbackModel !== model ? [fallbackModel] : [])];
  let lastError = 'Unknown API error';

  for (const candidateModel of modelsToTry) {
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: candidateModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage }
          ],
          max_tokens: maxTokens,
          temperature: 0.1
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });

      if (!res.ok) {
        const errText = await res.text();
        lastError = `HTTP ${res.status} (${candidateModel}): ${errText}`;
        continue;
      }

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content || '';
      const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0 };
      return { ok: true, content, usage, modelUsed: candidateModel };
    } catch (err) {
      lastError = `${candidateModel}: ${err.name === 'TimeoutError' ? `Request timed out after ${timeoutSec}s` : err.message}`;
    }
  }

  return { ok: false, error: lastError };
}

// 5. Reviewer Gate (Executed only in 'standard' mode when require_code_review is true)
async function runReviewerGate(task, scopedFiles) {
  const reviewerRole = teamConfig.roles?.reviewer || {};
  if (reviewerRole.enabled === false) {
    return { ok: true, skipped: true };
  }
  const diffText = getScopedDiff(scopedFiles);
  if (!diffText) {
    return { ok: true, skipped: true };
  }

  const reviewerModel = reviewerRole.model || 'ag/claude-opus-5-5-high';
  const reviewerFallback = reviewerRole.fallback_model || null;
  const reviewerSystemPrompt = fs.existsSync(path.resolve(TEAM_DIR, 'roles', 'reviewer.md'))
    ? fs.readFileSync(path.resolve(TEAM_DIR, 'roles', 'reviewer.md'), 'utf8')
    : 'Review the git diff against acceptance criteria and return JSON { "passed": boolean, "rubric_scores": {...}, "issues": [] }.';

  const reviewMsg = [
    `TASK ID: ${task.task_id}`,
    `GOAL: ${task.goal || task.title}`,
    `ACCEPTANCE CRITERIA: ${(task.acceptance_criteria || []).join('; ')}`,
    `GIT DIFF:\n${diffText}`
  ].join('\n\n');

  const res = await call9Router(reviewerModel, reviewerSystemPrompt, reviewMsg, 2048, reviewerFallback);
  if (!res.ok) {
    return { ok: false, error: `Reviewer API error: ${res.error}`, usage: { prompt_tokens: 0, completion_tokens: 0 } };
  }

  try {
    const jsonMatch = res.content.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(res.content);
    return {
      ok: Boolean(parsed.passed),
      reviewResult: parsed,
      error: parsed.passed ? null : `Reviewer rejected diff: ${(parsed.issues || []).join('; ') || 'Rubric check failed'}`,
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
function writeMorningReport(state) {
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
      lines.push(`- **${tid}** [${t.mode || 'quick'}]: ${t.title || 'Untitled'} (Commit: \`${t.commit_hash || 'none'}\`, Retries: ${t.retries || 0})`);
    }
  }

  lines.push(``, `## Blocked Tasks`);
  if (state.blocked_tasks.length === 0) {
    lines.push(`_No blocked tasks! 100% smooth flow._`);
  } else {
    for (const t of state.blocked_tasks) {
      const tid = t.task_id || t.id;
      lines.push(`- **${tid}** [${t.mode || 'quick'}]: ${t.title || ''} — Reason: \`${t.block_reason || 'Unknown error'}\``);
    }
  }

  fs.writeFileSync(REPORT_FILE, lines.join('\n'), 'utf8');
}

// 7. Main Orchestrator Loop
async function runOrchestrator() {
  if (!acquireLock()) {
    console.error('[Orchestrator] Could not acquire lock. Exiting.');
    process.exit(1);
  }

  process.on('exit', () => releaseLock());
  process.on('SIGINT', () => { releaseLock(); process.exit(0); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

  console.log('[Orchestrator] Starting session (v2.1 Mode-Based Engine)...');

  const state = loadState();
  const maxRetries = policyConfig.policy?.retry_and_escalation?.max_retries_per_task || 3;
  const abortOnIdentical = policyConfig.policy?.retry_and_escalation?.abort_on_identical_error_count || 2;
  const tokenBudgetPerTask = policyConfig.policy?.retry_and_escalation?.token_budget_per_task || 150000;
  const nightTokenBudgetTotal = policyConfig.policy?.retry_and_escalation?.night_token_budget_total || 3000000;
  const maxScopeIncrease = policyConfig.policy?.scope_control?.max_scope_increase ?? 1;
  const requireCleanBeforeStart = policyConfig.policy?.git_hygiene?.require_clean_worktree_before_start ?? true;
  const autoCommitOnDone = policyConfig.policy?.git_hygiene?.auto_commit_on_done ?? true;
  const commitPrefix = policyConfig.policy?.git_hygiene?.commit_message_prefix || '[AI-Task]';
  const allowedDirs = projectConfig.project?.allowed_dirs || [];
  const protectedFiles = projectConfig.project?.protected_files || [];

  if (!fs.existsSync(ACTIVE_TASKS_DIR)) {
    fs.mkdirSync(ACTIVE_TASKS_DIR, { recursive: true });
  }
  const taskFiles = fs.readdirSync(ACTIVE_TASKS_DIR).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

  console.log(`[Orchestrator] Found ${taskFiles.length} task(s) in tasks/active/`);

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

    let retries = 0;
    let lastErrorHash = null;
    let consecutiveIdenticalErrors = 0;
    let taskTokensUsed = 0;
    let isTaskDone = false;
    let blockReason = null;
    let validationPassed = null;
    let actualModifiedFiles = [];

    const getRollbackTargets = () => Array.from(new Set([
      ...(task.scope || []),
      ...(task.scope_expansions || []),
      ...actualModifiedFiles
    ]));

    try {
      // ==========================================
      // ROUTER PRE-CHECK (0-Token Fail-Fast Gate)
      // ==========================================
      if (!task.scope || !Array.isArray(task.scope) || task.scope.length === 0) {
        blockReason = 'Task scope is empty. Explicit scope is required.';
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
      const computedRisk = computeDeterministicRisk(task.scope);
      const effectiveRisk = (task.risk_level === 'high' || computedRisk === 'high') ? 'high' : (task.risk_level || 'low');
      task.risk_level = effectiveRisk;
      task.mode = resolveTaskMode(task, policyConfig.policy);

      // Approval Check for High Risk
      if (effectiveRisk === 'high') {
        const expectedHash = computeScopeHash(task.scope);
        const hasValidApproval = task.approval &&
          typeof task.approval.by === 'string' &&
          task.approval.scope_hash === expectedHash;

        if (!hasValidApproval) {
          blockReason = `Waiting for human approval (risk_level: high, expected scope_hash: "${expectedHash}")`;
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

      // ==========================================
      // 3.1 PRE-HOOK (0-Token, Exactly 1 Console Line)
      // ==========================================
      const cleanGoal = sanitizeGoal(task.goal || task.title);
      console.log(`[START] ${task.task_id} | Mode: ${task.mode} | Goal: ${cleanGoal} | Scope: ${task.scope.join(', ')} | Allow-expansion: ${allowExpansion}`);

      snapshot();

      // Helper to record validation/review errors and enforce identical-error loop breaker
      const handleStageFailure = (stageName, errSummary, errHash) => {
        validationPassed = stageName === 'review' ? true : false;
        task.error_history.push({
          attempt: retries + 1,
          stage: stageName,
          error_hash: errHash,
          summary: errSummary.slice(0, 500)
        });

        if (errHash === lastErrorHash) {
          consecutiveIdenticalErrors++;
        } else {
          lastErrorHash = errHash;
          consecutiveIdenticalErrors = 1;
        }

        rollback(getRollbackTargets());

        if (consecutiveIdenticalErrors >= abortOnIdentical) {
          blockReason = `Infinite fix loop detected in ${stageName} (${consecutiveIdenticalErrors}x identical error: ${errHash})`;
          task.status = 'blocked';
          console.error(`[Orchestrator] ${blockReason}`);
          return { shouldBreak: true };
        }

        task.last_error = errSummary;
        retries++;
        return { shouldBreak: false };
      };

      // ==========================================
      // TASK EXECUTION LOOP
      // ==========================================
      while (retries <= maxRetries && !isTaskDone) {
        if (taskTokensUsed > tokenBudgetPerTask) {
          blockReason = `Exceeded token budget (${taskTokensUsed} > ${tokenBudgetPerTask})`;
          task.status = 'blocked';
          console.error(`[Orchestrator] ${blockReason}`);
          break;
        }

        task.status = 'writing';

        // Step A: Prepare Writer Prompt WITH Scoped File Contents
        const writerRole = teamConfig.roles?.writer || {};
        const writerModel = writerRole.model || 'deepseek-ai/deepseek-v4.1-flash-1017';
        const writerFallback = writerRole.fallback_model || null;
        const writerSystemRole = fs.existsSync(path.resolve(TEAM_DIR, 'roles', 'writer.md'))
          ? fs.readFileSync(path.resolve(TEAM_DIR, 'roles', 'writer.md'), 'utf8')
          : 'You are the backend code writer. Return changes in <<<<<<< SEARCH / ======= / >>>>>>> REPLACE blocks.';

        const scopedFilesContext = buildScopedFilesContext(task.scope, REPO_ROOT);

        const userMessage = [
          `TASK ID: ${task.task_id}`,
          `EXECUTION MODE: ${task.mode}`,
          `GOAL: ${task.goal || task.title}`,
          `ALLOWED SCOPE: ${task.scope.join(', ')}`,
          `CONSTRAINTS: ${(task.constraints || []).join(', ')}`,
          `ACCEPTANCE CRITERIA: ${task.acceptance_criteria.join('; ')}`,
          `CURRENT SCOPED FILE CONTENTS:\n${scopedFilesContext}`,
          task.last_error
            ? `PREVIOUS ATTEMPT FAILED WITH ERROR:\n${task.last_error}\nPlease fix the issue and output exact SEARCH/REPLACE blocks.`
            : 'Please generate the exact code modifications to fulfill the goal.'
        ].join('\n\n');

        const writerRes = await call9Router(writerModel, writerSystemRole, userMessage, 4096, writerFallback);

        if (!writerRes.ok) {
          console.error(`[Writer] API error: ${writerRes.error}`);
          task.last_error = writerRes.error;
          retries++;
          continue;
        }

        const inputTok = writerRes.usage?.prompt_tokens || 0;
        const outputTok = writerRes.usage?.completion_tokens || 0;
        taskTokensUsed += inputTok + outputTok;
        state.metrics.total_input_tokens = (state.metrics.total_input_tokens || 0) + inputTok;
        state.metrics.total_output_tokens = (state.metrics.total_output_tokens || 0) + outputTok;

        // Step B: 8-Step Applier Pipeline
        const applyRes = applyEdits(writerRes.content, task, {
          allowedDirs,
          protectedFiles,
          maxScopeIncrease,
          repoRoot: REPO_ROOT
        });

        if (!applyRes.ok) {
          console.warn(`[Applier] ${applyRes.error}`);
          if (applyRes.security || applyRes.noRetry) {
            blockReason = applyRes.error;
            task.status = 'blocked';
            rollback(getRollbackTargets());
            break;
          }

          const applyHash = hashString(applyRes.error);
          const failAction = handleStageFailure('apply', applyRes.error, applyHash);
          if (failAction.shouldBreak) break;
          continue;
        }

        task.scope_expansions = applyRes.scope_expansions || task.scope_expansions;
        const allTaskFiles = Array.from(new Set([...task.scope, ...(task.scope_expansions || []), ...(applyRes.modified || [])]));
        actualModifiedFiles = getModifiedFiles(allTaskFiles);

        // Step C: Fast Validation (0-Token)
        task.status = 'validating';
        const fastVal = await validateFast(projectConfig);
        if (!fastVal.ok) {
          console.warn(`[Validator] Fast check failed: ${fastVal.checkName}`);
          const failAction = handleStageFailure('validate', fastVal.errorCombined, fastVal.errorHash);
          if (failAction.shouldBreak) break;
          continue;
        }

        // Step D: Suite Validation (0-Token)
        const suiteVal = await validateSuite(projectConfig);
        if (!suiteVal.ok) {
          console.warn(`[Validator] Suite check failed: ${suiteVal.checkName}`);
          const failAction = handleStageFailure('validate', suiteVal.errorCombined, suiteVal.errorHash);
          if (failAction.shouldBreak) break;
          continue;
        }

        validationPassed = true;
        task.validation_result = { passed: true };

        // Step E: Mode-Based Reviewer Gate (Skipped in 'quick' mode; enforced in 'standard' mode)
        const modeConfig = policyConfig.policy?.task_modes?.[task.mode] || {};
        const skipReviewer = modeConfig.skip_router_and_reviewer ?? (task.mode === 'quick');
        const requireReview = policyConfig.policy?.approval_gates?.require_code_review ?? true;

        if (!skipReviewer && requireReview) {
          task.status = 'reviewing';
          const revRes = await runReviewerGate(task, actualModifiedFiles);
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
            console.warn(`[Reviewer] ${revRes.error}`);
            const revHash = hashString(revRes.error);
            const failAction = handleStageFailure('review', revRes.error, revHash);
            if (failAction.shouldBreak) break;
            continue;
          }
        }

        // Step F: Scoped Git Commit
        if (autoCommitOnDone && actualModifiedFiles.length > 0) {
          const commitRes = commitDone(
            task.task_id,
            task.title || task.goal || 'complete task',
            commitPrefix,
            actualModifiedFiles
          );
          if (commitRes.ok) {
            task.commit_hash = commitRes.hash;
          } else {
            console.warn(`[GitGuard] Commit skipped/failed: ${commitRes.error}`);
          }
        }

        isTaskDone = true;
        break;
      }
    } catch (err) {
      if (!blockReason) blockReason = err.message;
    } finally {
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
        state.completed_tasks.push(task);

        if (!fs.existsSync(ARCHIVE_TASKS_DIR)) {
          fs.mkdirSync(ARCHIVE_TASKS_DIR, { recursive: true });
        }
        const archivePath = path.resolve(ARCHIVE_TASKS_DIR, tFile);
        saveTaskAtomic(archivePath, task);
        if (fs.existsSync(taskPath)) fs.unlinkSync(taskPath);
      } else {
        task.block_reason = task.last_report.blocker_reason;
        state.blocked_tasks.push(task);
        saveTaskAtomic(taskPath, task);
      }

      saveStateAtomic(state);
      writeMorningReport(state);

      // Print 1-line post-hook report to console
      const filesSummary = (task.last_report.modified_files || []).join(', ') || 'none';
      console.log(`[REPORT] ${task.task_id} | Mode: ${task.mode || 'quick'} | Status: ${finalStatus} | Files: ${filesSummary} | Validation: ${validationPassed} | Retries: ${retries}`);
    }
  }

  releaseLock();
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
