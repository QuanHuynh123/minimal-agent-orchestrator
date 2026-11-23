#!/usr/bin/env node
/**
 * Task Intake & Entry Gates Stage (Phase 2 — Step 2.2 of docs/ORCHESTRATOR_SPLIT_SPEC.md)
 * Encapsulates:
 *   - Block C: Consultation Track (`mode === 'consult'`)
 *   - Block D: Optional Router Planner (for `draft` tasks) + 10 Fail-Fast Entry Gates
 *              + Baseline Validation Preflight (`runBaselinePreflight`)
 *
 * INVARIANT: Never import from `../orchestrator.mjs` (to avoid module-load side effects
 * and circular dependencies). All orchestrator-scoped callbacks/paths are passed explicitly.
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildTaskStepSessionId, runAgent as defaultRunAgent } from '../../runtime/index.mjs';
import {
  checkAllowedDirs,
  checkForbidden,
  normalizeOrThrow
} from '../applier.mjs';
import {
  formatDirtyWorktreeBlockMessage,
  getModifiedFiles,
  isCleanWorktree
} from '../git-guard.mjs';
import {
  formatFlakyBaselineReport,
  runBaselinePreflight
} from '../lib/baseline-policy.mjs';
import {
  RISK_LEVEL_RANK,
  checkAndRefreshTaskRouting,
  resolveConsultModelSelection,
  resolveEffectiveRisk,
  resolveTaskMode
} from '../lib/risk-policy.mjs';
import { computeScopeHash } from '../lib/task-persistence.mjs';

export async function runTaskIntakeAndGates({
  task,
  state,
  taskRunId,
  taskTokensUsed = 0,
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
    repoRoot,
    teamDir,
    stateDir
  },
  callbacks: {
    updateLiveStatusFn,
    runRouterPlannerFn,
    runAgentFn = defaultRunAgent,
    accumulateTaskAndStateUsageFn,
    getAdjustedPromptTokensFn,
    sanitizeGoalFn
  }
}) {
  let currentTokensUsed = taskTokensUsed;
  const blocked = (reason) => ({
    outcome: 'blocked',
    blockReason: reason,
    tokensUsed: currentTokensUsed,
    baselineResult: null,
    baselineFingerprint: null,
    baselineDurationMs: 0,
    allowExpansion: false
  });

  task.mode = resolveTaskMode(task, policyConfig.policy);

  // ==========================================
  // CONSULTATION TRACK (Read-Only Advisory, Bypasses Mutation Gates)
  // ==========================================
  if (task.mode === 'consult') {
    const consultPlan = resolveConsultModelSelection(task, teamConfig);
    if (!consultPlan.ok || !String(consultPlan.model || '').trim()) {
      return blocked(
        consultPlan.error || `Consultation role "${consultPlan.role}" has no model configured in team.yaml. Stopping execution.`
      );
    }
    const consultRole = consultPlan.role;
    const consultModel = String(consultPlan.model).trim();
    const promptText = task.goal || task.prompt || task.title || 'Review codebase and provide consultation.';

    console.log(`[START] ${task.task_id} | Mode: consult | Role: ${consultRole} | Model: ${consultModel} | Goal: ${sanitizeGoalFn(promptText)}`);

    updateLiveStatusFn({
      current_stage: 'consult',
      stage_started_at: new Date().toISOString(),
      roles_status: {
        [consultRole]: { model: consultModel, status: 'working' }
      }
    });

    const consultTimeoutSec = policyConfig.policy?.task_modes?.consult?.max_runtime_sec || 180;
    const agentRes = await runAgentFn({
      role: consultRole,
      prompt: promptText,
      sessionId: buildTaskStepSessionId({ taskId: task.task_id, runId: taskRunId, role: 'consult' }),
      scope: Array.isArray(task.scope) ? task.scope : [],
      attachments: Array.isArray(task.attachments) ? task.attachments : (task.image ? [task.image] : []),
      modelOverride: consultModel,
      timeoutMs: consultTimeoutSec * 1000,
      repoRoot
    });

    if (!agentRes.ok) {
      return blocked(`Consultation agent failed: ${agentRes.error}`);
    }

    if (agentRes.usage) {
      currentTokensUsed = accumulateTaskAndStateUsageFn(state, agentRes.usage, currentTokensUsed);
      if ((agentRes.usage.cached_tokens || 0) > 0) {
        console.log(`[Consult Cache] Prompt: ${getAdjustedPromptTokensFn(agentRes.usage)} | Cached: ${agentRes.usage.cached_tokens} (Hit: ${(agentRes.usage.cache_hit_ratio * 100).toFixed(1)}%) | Completion: ${agentRes.usage.completion_tokens || 0}`);
      }
    }

    const reportsDir = path.resolve(teamDir, 'state', 'reports');
    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true });
    }
    const reportFile = `${task.task_id}-report.md`;
    const reportPath = path.resolve(reportsDir, reportFile);
    const receiptsSummary = (agentRes.tool_receipts && agentRes.tool_receipts.length > 0)
      ? `\n\n## 3. Tool Receipts (${agentRes.tool_receipts.length})\n` + agentRes.tool_receipts.map(r => `- [Turn ${r.turn}] \`${r.tool}\`: ${JSON.stringify(r.summary)}`).join('\n')
      : '';

    const reportContent = [
      `# Consultation Report: ${task.title || task.goal || task.task_id}`,
      `- **Task ID:** \`${task.task_id}\``,
      `- **Role:** \`${consultRole}\``,
      `- **Model Used:** \`${agentRes.model_used || consultModel}\``,
      `- **Timestamp:** ${new Date().toISOString()}`,
      `- **Turns Executed:** ${agentRes.turns_executed || 1}`,
      '',
      '## 1. Inquiry / Goal',
      promptText,
      '',
      '## 2. Advisory & Findings',
      agentRes.content || '(No textual content produced)',
      receiptsSummary
    ].join('\n');

    fs.writeFileSync(reportPath, reportContent.trim() + '\n', 'utf8');

    task.report_file = `agent-team/state/reports/${reportFile}`;
    task.report_content = agentRes.content;
    console.log(`[Consult] Report generated successfully: ${task.report_file}`);

    updateLiveStatusFn({
      roles_status: {
        [consultRole]: { model: consultModel, status: 'done' }
      }
    });

    return {
      outcome: 'consult_done',
      blockReason: null,
      tokensUsed: currentTokensUsed,
      baselineResult: null,
      baselineFingerprint: null,
      baselineDurationMs: 0,
      allowExpansion: false
    };
  }

  // ==========================================
  // OPTIONAL ROUTER PLANNER (For 'draft' tasks without scope)
  // ==========================================
  if (task.status === 'draft' && (!task.scope || task.scope.length === 0)) {
    const planRes = await runRouterPlannerFn(task);
    if (planRes.usage) {
      currentTokensUsed = accumulateTaskAndStateUsageFn(state, planRes.usage, currentTokensUsed);
    }
    if (planRes.ok) {
      task.plan = planRes.plan;
      task.scope = planRes.scope;
      if (!task.acceptance_criteria || task.acceptance_criteria.length === 0) {
        task.acceptance_criteria = planRes.acceptance_criteria;
      }
      task.status = 'planned';
    } else {
      return blocked(planRes.error || 'Router failed to produce a valid plan and scope.');
    }
  }

  // ==========================================
  // ROUTER PRE-CHECK (0-Token Fail-Fast Gate)
  // ==========================================
  if (!task.scope || !Array.isArray(task.scope) || task.scope.length === 0) {
    return blocked('Task scope is empty. Explicit scope is required.');
  }

  if (task.scope.length > maxFilesPerTask) {
    return blocked(`Task scope exceeds max_files_per_task (${task.scope.length} > ${maxFilesPerTask}). Split into smaller tasks.`);
  }

  if (!task.acceptance_criteria || !Array.isArray(task.acceptance_criteria) || task.acceptance_criteria.length === 0) {
    return blocked('Task missing acceptance_criteria.');
  }

  // Fail-fast check on task.scope for illegal paths, forbidden files, and allowedDirs
  for (const rawScopePath of task.scope) {
    let normRel;
    try {
      normRel = normalizeOrThrow(repoRoot, rawScopePath);
    } catch (err) {
      return blocked(`SECURITY: Invalid path in task.scope "${rawScopePath}": ${err.message}`);
    }

    const fCheck = checkForbidden(normRel, protectedFiles, task.forbidden_files || []);
    if (fCheck.forbidden) {
      return blocked(`SECURITY: Forbidden file in task.scope "${normRel}" (matched pattern: "${fCheck.pattern}")`);
    }

    if (!checkAllowedDirs(normRel, allowedDirs)) {
      return blocked(`Task scope "${normRel}" is outside project.allowed_dirs: ${allowedDirs.join(', ')}`);
    }
  }

  // Check routing_version and recompute stale task routing before risk/mode resolution
  const routingRefresh = checkAndRefreshTaskRouting(task, teamConfig, policyConfig);
  for (const warning of routingRefresh.warnings) {
    console.warn(`[Orchestrator] [RoutingVersion] ${warning}`);
  }
  if (routingRefresh.stale) {
    if (routingRefresh.recomputed) {
      task.mode = routingRefresh.mode;
      task.risk_level = routingRefresh.risk_level;
      if (routingRefresh.kind) task.kind = routingRefresh.kind;
      if (routingRefresh.kind_source) task.kind_source = routingRefresh.kind_source;
      task.writer_hub_workflow = routingRefresh.workflow;
    }
    task.routing_version = routingRefresh.currentVersion;
  }

  // Computed Risk Level & Mode Selection
  const effectiveRisk = resolveEffectiveRisk(task);
  task.risk_level = effectiveRisk;
  task.mode = resolveTaskMode(task, policyConfig.policy);
  updateLiveStatusFn({
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
      return blocked(`Waiting for human approval (risk_level: ${effectiveRisk}, cross_role_edit: ${Boolean(task.cross_role_edit)}, expected scope_hash: "${expectedHash}")`);
    }
  }

  // Scope Expansion Justification Guard
  const allowExpansion = Boolean(task.allow_scope_expansion || task.cross_role_edit);
  if (allowExpansion && (!task.justification || task.justification.trim().length < 10)) {
    return blocked('allow_scope_expansion is true but justification is missing or too short (< 10 chars)');
  }

  // Scoped Clean Worktree Guard
  if (requireCleanBeforeStart && !isCleanWorktree(task.scope)) {
    const dirtyScoped = getModifiedFiles(task.scope);
    return blocked(formatDirtyWorktreeBlockMessage(task.scope, dirtyScoped));
  }

  // Baseline Validation Preflight (1 full + 2x retry red-only, cached by (HEAD sha, env_fingerprint))
  // Runs under its own `max_baseline_runtime_sec` budget so baseline checks do NOT consume `task_modes.<mode>.max_runtime_sec`.
  const baselineWallStartMs = Date.now();
  const baselineResult = await runBaselinePreflight({
    policyConfig,
    repoRoot,
    task,
    stateDir
  });
  const baselineDurationMs = baselineResult?.duration_ms ?? Math.max(0, Date.now() - baselineWallStartMs);
  const baselineFingerprint = baselineResult?.baseline_fingerprint || null;
  task.baseline_failures = baselineResult?.baseline_failures || [];
  task.flaky_baseline_failures = baselineResult?.flaky_baseline_failures || [];
  task.baseline_duration_ms = baselineDurationMs;
  phaseTracker.setBaselineMs(baselineDurationMs);
  console.log(formatFlakyBaselineReport(task.flaky_baseline_failures));
  if (baselineResult?.skipped) {
    console.log('[Validator] Baseline check: No fast_checks or suite_checks defined.');
  } else if (baselineResult?.blocked) {
    const bReason = baselineResult.reason === 'baseline_timeout'
      ? (baselineResult.message || 'Baseline preflight exceeded max_baseline_runtime_sec')
      : (baselineResult.message || `Baseline preflight blocked (${baselineResult.reason || 'baseline_failed'})`);
    return {
      outcome: 'blocked',
      blockReason: bReason,
      tokensUsed: currentTokensUsed,
      baselineResult,
      baselineFingerprint,
      baselineDurationMs,
      allowExpansion
    };
  } else {
    console.log(`[Validator] Baseline preflight finished in ${(baselineDurationMs / 1000).toFixed(1)}s${baselineResult.cacheHit ? ' [cache hit]' : ''} (excluded from task max_runtime_sec); persistent failures: ${task.baseline_failures.length}/${baselineResult.max_baseline_failures}.`);
  }

  return {
    outcome: 'ready',
    blockReason: null,
    tokensUsed: currentTokensUsed,
    baselineResult,
    baselineFingerprint,
    baselineDurationMs,
    allowExpansion
  };
}
