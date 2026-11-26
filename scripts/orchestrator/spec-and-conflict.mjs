#!/usr/bin/env node
/**
 * Spec Prompts, Pre-Rollback Failure Capture, Contract Conflict Gate & Diff Risk Floor
 * (Phase 3 — Step 3A.1 of docs/ORCHESTRATOR_SPLIT_SPEC.md)
 *
 * Pure / top-level helpers extracted from `orchestrator.mjs` (`L199–L564`).
 * INVARIANT: Never import from `../orchestrator.mjs` and never eagerly load config at module load.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRepoRoot } from '../applier.mjs';
import { getScopedDiff } from '../git-guard.mjs';
import {
  extractStructuredFailureBlocks,
  formatValidationErrorForRetry
} from '../lib/context-builders.mjs';
import {
  evaluatePostPatchDiffRisk,
  shouldRunReviewerGate
} from '../lib/risk-policy.mjs';
import { saveAttemptPatchDiff } from '../lib/task-persistence.mjs';
import {
  extractNewlyAddedTestNamesByFile,
  hashString
} from '../validator.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_TEAM_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_REPO_ROOT = resolveRepoRoot();

/**
 * Captures pre-rollback validation failure artifacts atomically BEFORE rollback() wipes disk edits:
 * 1) Persists raw `git diff` into `agent-team/state/runs/<task_id>/attempt-<N>.patch`.
 * 2) Extracts failing test body, AssertionError, and project traceback frames into `task.last_error`.
 * 3) Invokes `rollbackFn(targets)` only after both captures finish.
 */
export function capturePreRollbackValidationFailure({
  task,
  attemptNum,
  errSummary,
  targets = [],
  diffText = null,
  repoRoot = DEFAULT_REPO_ROOT,
  teamDir = DEFAULT_TEAM_DIR,
  rollbackFn = null,
  shouldRollback = true,
  getScopedDiffFn = getScopedDiff
} = {}) {
  const cleanTargets = Array.isArray(targets) ? targets.filter(Boolean) : [];
  let rawDiff = typeof diffText === 'string' ? diffText : '';
  if (!rawDiff && cleanTargets.length > 0 && typeof getScopedDiffFn === 'function') {
    try {
      rawDiff = getScopedDiffFn(cleanTargets, { cwd: repoRoot }) || '';
    } catch {}
  }

  const patchPath = task?.task_id
    ? saveAttemptPatchDiff(task.task_id, attemptNum, rawDiff, teamDir)
    : null;

  const conciseErr = formatValidationErrorForRetry(errSummary, 1800, {
    repoRoot: repoRoot,
    scope: cleanTargets
  });

  if (shouldRollback && typeof rollbackFn === 'function') {
    rollbackFn(cleanTargets);
  }

  if (task && typeof task === 'object') {
    task.last_error = conciseErr;
  }

  return { conciseErr, patchPath, rawDiff };
}

export const SPEC_REUSE_ON_RETRY_ENABLED = false;

/**
 * Deterministic 0-token gate deciding whether an existing draft_spec artifact may be
 * reused on a retry attempt WITHOUT re-invoking the Architect/Designer model:
 *   1. Must be a retry attempt (retries > 0) with a valid, non-stale Markdown spec file on disk.
 *   2. The immediately preceding attempt must have stopped strictly at `stage === 'apply'`
 *      (mechanical truncation `finish_reason === 'length'`, SEARCH/REPLACE mismatch, or
 *      `not_in_seen_window`) — BEFORE reaching `validate` or `review`.
 *   3. The task must NEVER have failed `validate`, `validate_env`, `review`, or
 *      `post_patch_signature_gate` on any prior attempt, and must have passed ContractConflictGate.
 *   4. Task scope must be unchanged since the spec artifact was drafted.
 * Any validation/test failure (such as D-017) ALWAYS returns `false` so Spec is freshly re-evaluated.
 */
export function canReuseSpecOnMechanicalApplyRetry({
  task = {},
  retries = 0,
  specPath = '',
  currentScopeHash = null,
  previousScopeHash = null,
  specPassedContractGate = true
} = {}) {
  if (Number(retries) <= 0) return false;
  if (!specPath || !fs.existsSync(specPath)) return false;
  if (!specPassedContractGate) return false;
  if (task?.failure_class === 'contract_conflict' || task?.contract_conflict_report) return false;

  if (currentScopeHash && previousScopeHash && currentScopeHash !== previousScopeHash) {
    return false;
  }

  const history = Array.isArray(task?.error_history) ? task.error_history : [];
  if (history.length === 0) return false;

  const hasNonApplyFailure = history.some((entry) => {
    const stage = String(entry?.stage || '').toLowerCase();
    return stage === 'validate' || stage === 'validate_env' || stage === 'review' || stage === 'post_patch_signature_gate';
  });
  if (hasNonApplyFailure) return false;

  const prevAttempt = Number(retries);
  const lastEntry = history[history.length - 1];
  if (!lastEntry || String(lastEntry.stage || '').toLowerCase() !== 'apply') {
    return false;
  }
  if (lastEntry.attempt != null && Number(lastEntry.attempt) !== prevAttempt) {
    return false;
  }

  const steps = Array.isArray(task?.steps) ? task.steps : [];
  const hasPriorValidationFailureOrReview = steps.some((s) =>
    s && (
      String(s.validation_status || '').toLowerCase() === 'failed' ||
      String(s.role || '').toLowerCase() === 'reviewer'
    )
  );
  if (hasPriorValidationFailureOrReview) return false;

  try {
    const existingSpec = fs.readFileSync(specPath, 'utf8').trim();
    const isStaleJsonReview = existingSpec.startsWith('```json') || existingSpec.includes('"passed": false');
    if (existingSpec.length <= 20 || isStaleJsonReview) return false;
  } catch {
    return false;
  }

  return true;
}

/**
 * Builds both the user prompt and system prompt override for pre-code draft_spec steps
 * (Architect / Designer), enforcing Contract Table (Input -> Output | Error/Fallback Cases),
 * strict acceptance_criteria precedence over Spec, and [ASSUMPTION] tagging.
 */
export function buildDraftSpecPrompts({
  wfStep = {},
  task = {},
  specScope = [],
  specScopedContext = '',
  neighborRepoMap = '',
  bridgeSkeletonMap = '',
  upstreamSpecs = '',
  backendApiContract = '',
  dataSchemaSamples = '',
  retries = 0
} = {}) {
  const stepRole = wfStep.role || 'architect';
  const effectiveScope = Array.isArray(specScope) && specScope.length > 0
    ? specScope
    : (Array.isArray(task.scope) ? task.scope : []);

  const specPromptParts = [
    `TASK ID: ${task.task_id || 'unknown'} (Step ${wfStep.step || 1}: ${stepRole})`,
    `ROLE ARCHETYPE: ${String(stepRole).toUpperCase()}${wfStep.spec_focus ? ` (Focus: ${wfStep.spec_focus})` : ''}`,
    `ALLOWED TASK SCOPE: ${(task.scope || []).join(', ')}`,
    `DOMAIN-SCOPED FILES FOR THIS STEP: ${effectiveScope.join(', ')}`
  ];

  if (neighborRepoMap && neighborRepoMap.trim()) {
    specPromptParts.push(`NEIGHBORING CODEBASE SKELETON (Symbols & Signatures for Reference):\n${neighborRepoMap.trim()}`);
  }

  if (bridgeSkeletonMap && bridgeSkeletonMap.trim()) {
    const bridgeFiles = Array.isArray(wfStep.bridge_skeleton_scope) ? wfStep.bridge_skeleton_scope.join(', ') : '';
    specPromptParts.push(
      `CROSS-DOMAIN / BRIDGE SKELETON (Function & Class Signatures from ${bridgeFiles} — Use for API/Bridge Alignment):\n${bridgeSkeletonMap.trim()}`
    );
  }

  if (upstreamSpecs && upstreamSpecs.trim()) {
    specPromptParts.push(`UPSTREAM ARCHITECTURAL CONTRACT (Must Align 100%):\n${upstreamSpecs.trim()}`);
  }

  specPromptParts.push(`CURRENT SCOPED FILE CONTENTS (Smart Knapsack Windows + Header Anchor):\n${specScopedContext}`);

  if (backendApiContract && backendApiContract.trim()) {
    specPromptParts.push(
      `BACKEND API & ROUTE CONTRACT (Read-Only — Match existing endpoints/payloads & reuse existing routes instead of duplicating):\n${backendApiContract.trim()}`
    );
  }

  if (dataSchemaSamples && dataSchemaSamples.trim()) {
    specPromptParts.push(
      `REFERENCED DATA SCHEMA SAMPLES (Read-Only first <=30 lines / <=2KB — Do NOT guess field names):\n${dataSchemaSamples.trim()}`
    );
  }

  specPromptParts.push(
    `GOAL: ${task.goal || task.title || ''}`,
    `CONSTRAINTS: ${(task.constraints || []).join(', ')}`,
    `ACCEPTANCE CRITERIA: ${(task.acceptance_criteria || []).join('; ')}`
  );

  if (retries > 0 && task.last_error) {
    specPromptParts.push(
      `PREVIOUS ATTEMPT FAILURE CONTEXT (Resolve any Spec vs Test/Contract ambiguity before re-specifying):\n${String(task.last_error).slice(0, 1400)}`
    );
  }

  if (wfStep.spec_focus !== 'ui_ux_and_visual_audit') {
    specPromptParts.push(
      `API / BRIDGE CONTRACT REQUIREMENT (MANDATORY Bảng hợp đồng):\nInclude a concise Markdown Contract Table with columns: \`Function | Input -> Output | Error / Fallback Cases\` specifying exact method/RPC names, parameter signatures, and JSON return payload keys.`,
      `CONTRACT PRECEDENCE & [ASSUMPTION] RULE:\n- \`acceptance_criteria\` ALWAYS wins over Spec. Never invent silent fallbacks (e.g., returning \`ok=True\` when a target file is missing or falling back to parent folder) unless explicitly required by \`acceptance_criteria\`.\n- Any non-obvious behavior or fallback added by the Spec MUST be tagged explicitly with \`[ASSUMPTION]\` so ambiguity with tests is immediately flagged.`
    );
  }

  if (wfStep.allow_skip_spec) {
    specPromptParts.push(
      `TOOL & FAST-EXIT POLICY (MAX 3 TURNS): The relevant code windows and cross-domain AST signatures are ALREADY provided above. Do NOT call read_file or search_code unless a critical symbol definition is omitted. If the goal and scope are already self-evident and unambiguous, respond immediately on Turn 1 with 'SKIP_SPEC: <1-sentence reason>'. Otherwise, draft a concise Markdown specification directly.`
    );
  } else {
    specPromptParts.push(
      `TOOL POLICY (MAX 3 TURNS): The relevant code windows and cross-domain AST signatures are ALREADY provided above. Only call search_code/read_file if a required section was omitted, then draft a concise, clear technical specification in Markdown detailing architecture, contracts (Contract Table), and implementation steps for the Coder.`
    );
  }

  const userMessage = specPromptParts.join('\n\n');
  const systemPromptOverride = (wfStep.spec_focus !== 'ui_ux_and_visual_audit')
    ? [
        '# ROLE: Lead Software Architect (Pre-Code Specification)',
        'You are drafting a concise Pre-Code Technical Specification BEFORE the Coder modifies any files.',
        'CRITICAL RULES:',
        '1. Code changes have NOT been applied yet — NEVER output a post-code review JSON (`{"passed": false}`) and NEVER complain that the workspace still matches pre-task code.',
        '2. Keep your specification concise (< 300 words) and strictly scoped to `DOMAIN-SCOPED FILES FOR THIS STEP`. Do NOT write UI/CSS redesigns.',
        '3. `acceptance_criteria` ALWAYS wins over Spec. Never invent unmarked fallbacks; mark any non-obvious Spec fallback with `[ASSUMPTION]`.',
        '4. If the task goal and acceptance criteria are already unambiguous, respond immediately on Turn 1 with `SKIP_SPEC: <reason>`. Otherwise, output Markdown with a `Bảng hợp đồng` (`Function | Input -> Output | Error / Fallback Cases`) and targeted implementation bullets per backend file.'
      ].join('\n')
    : null;

  return { userMessage, systemPromptOverride };
}

export function collectSpecExcerptsForConflict({
  task = {},
  specPaths = [],
  failBlock = {},
  repoRoot = DEFAULT_REPO_ROOT
} = {}) {
  const candidates = new Set();
  for (const sp of (Array.isArray(specPaths) ? specPaths : [])) {
    if (sp && typeof sp === 'string') {
      candidates.add(sp.replace(/\\/g, '/'));
    }
  }
  if (candidates.size === 0 && task?.task_id && repoRoot) {
    const runDir = path.join(repoRoot, 'agent-team', 'state', 'runs', String(task.task_id));
    if (fs.existsSync(runDir)) {
      try {
        for (const entry of fs.readdirSync(runDir)) {
          if (entry.toLowerCase().endsWith('.md')) {
            candidates.add(path.relative(repoRoot, path.join(runDir, entry)).replace(/\\/g, '/'));
          }
        }
      } catch {}
    }
  }

  const terms = [];
  if (failBlock?.testName) {
    for (const part of String(failBlock.testName).replace(/^test_/, '').split('_')) {
      if (part.length >= 4) terms.push(part.toLowerCase());
    }
  }
  if (Array.isArray(failBlock?.productFrames)) {
    for (const fr of failBlock.productFrames) {
      if (fr?.fn && fr.fn.length >= 3) terms.push(String(fr.fn).toLowerCase());
    }
  }

  const excerpts = [];
  for (const rel of candidates) {
    const abs = path.isAbsolute(rel) ? rel : path.resolve(repoRoot, rel);
    if (!fs.existsSync(abs)) continue;
    try {
      const rawLines = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').split('\n');
      const matched = rawLines.filter(line => {
        const lower = line.toLowerCase();
        if (!line.trim()) return false;
        if (lower.includes('[assumption]') || lower.includes('fallback') || lower.includes('error') || lower.includes('return:') || lower.includes('|')) {
          return true;
        }
        return terms.some(t => lower.includes(t));
      });
      const chosen = (matched.length > 0 ? matched : rawLines.filter(l => l.trim())).slice(0, 10);
      if (chosen.length > 0) {
        excerpts.push(`[${rel}]\n${chosen.join('\n')}`);
      }
    } catch {}
  }
  return excerpts;
}

/**
 * 0-token gate stopping retry loops early on unresolved Contract Conflict:
 * when the SAME task-added test + SAME assertion fails on 2 consecutive attempts
 * (regardless of line shifts or suite size changes), records `contract_conflict_report`
 * and transitions task to blocked (`failure_class: 'contract_conflict'`).
 */
export function evaluateContractConflictGate({
  task,
  attemptNum,
  errSummary,
  diffText = '',
  targets = [],
  specPaths = [],
  repoRoot = DEFAULT_REPO_ROOT,
  getScopedDiffFn = getScopedDiff
} = {}) {
  if (!task || typeof task !== 'object') return { contractConflict: false };

  let rawDiff = typeof diffText === 'string' ? diffText : '';
  const cleanTargets = Array.isArray(targets) ? targets.filter(Boolean) : [];
  if (!rawDiff && cleanTargets.length > 0 && typeof getScopedDiffFn === 'function') {
    try {
      rawDiff = getScopedDiffFn(cleanTargets, { cwd: repoRoot }) || '';
    } catch {}
  }

  const addedByFile = extractNewlyAddedTestNamesByFile(rawDiff);
  if (!task.attempt_added_tests || typeof task.attempt_added_tests !== 'object') {
    task.attempt_added_tests = {};
  }
  const allKnownAddedNames = new Set();
  for (const [f, set] of addedByFile.entries()) {
    const merged = new Set(Array.isArray(task.attempt_added_tests[f]) ? task.attempt_added_tests[f] : []);
    for (const name of set) {
      merged.add(name);
      allKnownAddedNames.add(name);
    }
    task.attempt_added_tests[f] = [...merged];
  }
  for (const arr of Object.values(task.attempt_added_tests)) {
    if (Array.isArray(arr)) {
      for (const name of arr) allKnownAddedNames.add(name);
    }
  }

  if (allKnownAddedNames.size === 0) {
    return { contractConflict: false };
  }

  const parsedBlocks = extractStructuredFailureBlocks(errSummary, { repoRoot });
  if (parsedBlocks.length === 0) {
    return { contractConflict: false };
  }

  const isNewlyAddedTestBlock = (blk) => {
    if (!blk?.testName) return false;
    const normFile = String(blk.testFile || '').replace(/\\/g, '/');
    if (normFile && addedByFile.has(normFile)) {
      return addedByFile.get(normFile).has(blk.testName);
    }
    return allKnownAddedNames.has(blk.testName);
  };

  const failingNewBlocks = parsedBlocks.filter(isNewlyAddedTestBlock);
  if (failingNewBlocks.length === 0) {
    return { contractConflict: false };
  }

  const prevFailures = Array.isArray(task.attempt_test_failures)
    ? task.attempt_test_failures.filter(e => Number(e?.attempt) !== Number(attemptNum))
    : [];

  const currentFailures = failingNewBlocks.map(blk => {
    const sigInput = `${blk.testName}::${String(blk.assertionLine || '').trim()}::${String(blk.errorMessage || '').trim()}`;
    return {
      attempt: Number(attemptNum),
      signature: hashString(sigInput),
      testName: blk.testName,
      testFile: blk.testFile || '',
      assertionLine: blk.assertionLine || '',
      errorMessage: blk.errorMessage || ''
    };
  });

  task.attempt_test_failures = [...prevFailures, ...currentFailures];

  const prevAttempt = Number(attemptNum) - 1;
  if (prevAttempt < 1) {
    return { contractConflict: false };
  }

  const matchedIndex = currentFailures.findIndex(cur =>
    prevFailures.some(prev => Number(prev.attempt) === prevAttempt && prev.signature === cur.signature)
  );
  if (matchedIndex === -1) {
    return { contractConflict: false };
  }

  const matchedCur = currentFailures[matchedIndex];
  const matchedBlk = failingNewBlocks[matchedIndex];
  const specExcerpts = collectSpecExcerptsForConflict({
    task,
    specPaths,
    failBlock: matchedBlk,
    repoRoot
  });

  const report = {
    attempt_pair: [prevAttempt, Number(attemptNum)],
    failing_test_name: matchedCur.testName,
    failing_test_file: matchedCur.testFile,
    assertion_line: matchedCur.assertionLine,
    error_message: matchedCur.errorMessage,
    signature: matchedCur.signature,
    acceptance_criteria: Array.isArray(task.acceptance_criteria) ? [...task.acceptance_criteria] : [],
    spec_excerpts: specExcerpts,
    failing_test_body: matchedBlk.testBody || matchedBlk.errBlockText || '',
    current_code_behavior: matchedBlk.productCodeBehavior || ''
  };

  const blockReason = `Contract conflict: newly added test "${matchedCur.testName}" failed twice consecutively (${prevAttempt} & ${attemptNum}) with identical assertion (${matchedCur.assertionLine || matchedCur.errorMessage})`;
  task.status = 'blocked';
  task.failure_class = 'contract_conflict';
  task.contract_conflict_report = report;
  task.block_reason = blockReason;

  return { contractConflict: true, report, blockReason };
}

/**
 * Evaluates post-patch diff right before Reviewer / Git Commit without rolling back
 * a validation-passing patch. When physical deletion calls lift effective risk
 * from low/medium -> high, triggers Reviewer Gate or falls back to
 * `awaiting_confirmation` branch isolation when Reviewer is unavailable.
 */
export function applyPostPatchDiffRiskFloor({
  task = {},
  diffText = '',
  policy = {},
  roles = {},
  usedWriterModels = []
} = {}) {
  const evalRes = evaluatePostPatchDiffRisk(task, diffText);
  if (task && typeof task === 'object') {
    task.pre_patch_risk_level = evalRes.pre_patch_risk_level;
    task.post_patch_risk_level = evalRes.post_patch_risk_level;
    task.post_patch_risk_escalation = evalRes;
  }

  if (!evalRes.escalated_to_high) {
    return {
      ...evalRes,
      reviewerRequired: false,
      requiresConfirmation: false
    };
  }

  if (task && typeof task === 'object') {
    task.risk_level = evalRes.post_patch_risk_level;
    task.post_patch_high_risk_escalated = true;
  }

  const reviewerRequired = shouldRunReviewerGate(task, policy, roles, usedWriterModels);
  const requiresConfirmation = !reviewerRequired;
  if (task && typeof task === 'object') {
    task.post_patch_confirmation_required = requiresConfirmation;
  }

  return {
    ...evalRes,
    reviewerRequired,
    requiresConfirmation
  };
}
