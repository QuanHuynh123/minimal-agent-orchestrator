#!/usr/bin/env node
/**
 * Reviewer Gate, Balanced JSON Extraction & Spec/Pending-Review Patch Artifacts
 * (Phase 3 — Step 3A.2 of docs/ORCHESTRATOR_SPLIT_SPEC.md)
 *
 * Top-level helpers extracted from `orchestrator.mjs`.
 * INVARIANT: Never import from `../orchestrator.mjs` and never eagerly load config at module load.
 * `teamConfig`, `repoRoot`, `teamDir`, and `callModel` are passed at call time by the caller.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRepoRoot } from '../applier.mjs';
import { getScopedDiff, rollback } from '../git-guard.mjs';
import {
  buildConsolidatedSpecsContext,
  buildReviewerPrompt
} from '../lib/context-builders.mjs';
import { resolveSpecArtifactPath } from '../lib/risk-policy.mjs';
import { hashString } from '../validator.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_TEAM_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_REPO_ROOT = resolveRepoRoot();

export function scanBalancedJsonCandidates(str) {
  const candidates = [];
  const text = String(str || '');
  let idx = 0;
  while (idx < text.length) {
    const start = text.indexOf('{', idx);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let matchedEnd = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          matchedEnd = i;
          break;
        }
      }
    }
    if (matchedEnd !== -1) {
      candidates.push(text.slice(start, matchedEnd + 1));
      idx = matchedEnd + 1;
    } else {
      idx = start + 1;
    }
  }
  return candidates;
}

/**
 * Extracts the first valid balanced JSON object from model text (preferring fenced ```json blocks),
 * ignoring trailing commentary that may contain {...} snippets.
 */
export function extractFirstBalancedJsonObject(rawText) {
  const text = String(rawText ?? '').trim();
  if (!text) return null;

  const tryParseCandidates = (source) => {
    for (const candidate of scanBalancedJsonCandidates(source)) {
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {}
    }
    return null;
  };

  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fenceMatch;
  while ((fenceMatch = fenceRegex.exec(text)) !== null) {
    const inside = fenceMatch[1] || '';
    const parsedFromFence = tryParseCandidates(inside);
    if (parsedFromFence) return parsedFromFence;
  }

  return tryParseCandidates(text);
}

/**
 * Persists a draft_spec artifact safely inside gitignored agent-team/state/runs/<task_id>/
 * so repo root artifacts/ is never created.
 */
export function writeDraftSpecArtifact(taskId, stepRole = 'architect', wfStep = {}, content = '', options = {}) {
  const repoRoot = options.repoRoot ? path.resolve(options.repoRoot) : DEFAULT_REPO_ROOT;
  const relPath = resolveSpecArtifactPath(taskId, `${stepRole}_spec.md`, wfStep?.output_artifact);
  const absPath = path.resolve(repoRoot, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, String(content || ''), 'utf8');
  return { relPath, absPath };
}

/**
 * Persists a validated patch under agent-team/state/runs/<task_id>/ when AI Reviewer JSON is unavailable.
 */
export function savePendingReviewPatch(taskId, attemptNum = 1, diffText = '', options = {}) {
  const safeId = String(taskId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_');
  const teamDir = options.teamDir ? path.resolve(options.teamDir) : DEFAULT_TEAM_DIR;
  const runDir = path.resolve(teamDir, 'state', 'runs', safeId);
  fs.mkdirSync(runDir, { recursive: true });
  const fileName = `pending-review-attempt-${attemptNum}.patch`;
  const absPath = path.resolve(runDir, fileName);
  fs.writeFileSync(absPath, String(diffText || ''), 'utf8');
  return {
    absPath,
    relPath: `agent-team/state/runs/${safeId}/${fileName}`
  };
}

export async function runReviewerGateCore(task, scopedFiles, previousReviewIssues = [], activeWriterModel = null, options = {}) {
  const activeTeamConfig = options.teamConfig || {};
  const repoRoot = options.repoRoot ? path.resolve(options.repoRoot) : DEFAULT_REPO_ROOT;
  const teamDir = options.teamDir ? path.resolve(options.teamDir) : DEFAULT_TEAM_DIR;

  const reviewerRole = activeTeamConfig.roles?.reviewer || {};
  if (reviewerRole.enabled === false) {
    return { ok: true, skipped: true };
  }
  const getDiffFn = typeof options.getDiff === 'function'
    ? options.getDiff
    : (files) => getScopedDiff(files, { functionContext: true });
  const diffText = getDiffFn(scopedFiles);
  if (!diffText) {
    return { ok: true, skipped: true };
  }

  const reviewerModel = reviewerRole.model || reviewerRole.default_model;
  if (!reviewerModel) {
    return { ok: false, error: 'Reviewer role is enabled but has no model configured in team.yaml. Stopping instead of letting writer self-review.' };
  }
  const reviewerFallback = reviewerRole.fallback_model || null;
  const reviewerTemp = reviewerRole.temperature ?? 0.1;
  const reviewerMaxThinking = reviewerRole.max_thinking_tokens;
  const reviewerSystemPrompt = typeof options.systemPrompt === 'string'
    ? options.systemPrompt
    : (fs.existsSync(path.resolve(teamDir, 'roles', 'reviewer.md'))
        ? fs.readFileSync(path.resolve(teamDir, 'roles', 'reviewer.md'), 'utf8')
        : 'Review the git diff against acceptance criteria and return JSON { "passed": boolean, "rubric_scores": {...}, "issues": [] }.');

  const specArtifacts = Array.isArray(options.specArtifacts) && options.specArtifacts.length > 0
    ? options.specArtifacts
    : (Array.isArray(task?.writer_hub_workflow)
        ? task.writer_hub_workflow.filter(s => s?.action === 'draft_spec' && s?.output_artifact).map(s => s.output_artifact)
        : []);
  const specText = typeof options.specText === 'string'
    ? options.specText
    : (specArtifacts.length > 0 ? buildConsolidatedSpecsContext(specArtifacts, repoRoot) : '');

  const reviewMsg = buildReviewerPrompt(task, diffText, previousReviewIssues, { specText });

  const callModelFn = options.callModel;
  if (typeof callModelFn !== 'function') {
    throw new Error('runReviewerGateCore requires options.callModel function');
  }
  const res = await callModelFn(reviewerModel, reviewerSystemPrompt, reviewMsg, 2048, reviewerFallback, reviewerTemp, {
    maxThinkingTokens: reviewerMaxThinking
  });
  if (!res.ok) {
    return { ok: false, model: reviewerModel, requested_model: reviewerModel, actual_model: reviewerModel, error: `Reviewer API error: ${res.error}`, usage: { prompt_tokens: 0, completion_tokens: 0, reported_cached_tokens: null }, raw_usage: null };
  }

  try {
    const jsonSlice = extractFirstBalancedJsonObject(res.content);
    const parsed = jsonSlice ? JSON.parse(jsonSlice) : JSON.parse(res.content);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.passed !== 'boolean') {
      throw new Error('Missing boolean "passed" field in Reviewer JSON');
    }
    const isPassed = parsed.passed === true;
    return {
      ok: isPassed,
      model: res.actual_model || reviewerModel,
      requested_model: res.requested_model || reviewerModel,
      actual_model: res.actual_model || reviewerModel,
      fallback_activated: Boolean(res.fallback_activated),
      fallback_reason: res.fallback_reason || null,
      reviewResult: parsed,
      error: isPassed ? null : `Reviewer rejected diff: ${(parsed.issues || []).join('; ') || 'Rubric check failed'}`,
      usage: res.usage,
      raw_usage: res.raw_usage ?? null
    };
  } catch (err) {
    return {
      ok: false,
      failure_class: 'review_unavailable',
      review_unavailable: true,
      diffText,
      model: res.actual_model || reviewerModel,
      requested_model: res.requested_model || reviewerModel,
      actual_model: res.actual_model || reviewerModel,
      fallback_activated: Boolean(res.fallback_activated),
      fallback_reason: res.fallback_reason || null,
      error: `Reviewer output was not valid JSON: ${err.message}`,
      usage: res.usage,
      raw_usage: res.raw_usage ?? null
    };
  }
}

/**
 * Resolves a failed Reviewer gate step: malformed/non-JSON output transitions cleanly to
 * blocked (failure_class="review_unavailable") while preserving Validation pass, saving patch,
 * and rolling back the worktree for manual human review instead of misclassifying as Infinite fix loop.
 */
export function resolveReviewStageOutcome({
  task,
  revRes,
  attemptNum = 1,
  rollbackTargets = [],
  rollbackFn = rollback,
  onRejectedReview = null,
  teamDir = DEFAULT_TEAM_DIR
} = {}) {
  if (revRes?.review_unavailable || revRes?.failure_class === 'review_unavailable') {
    const saved = savePendingReviewPatch(task?.task_id || task?.id, attemptNum, revRes.diffText || '', { teamDir });
    const reasonText = `review_unavailable: ${revRes.error || 'Reviewer output invalid JSON'}. Code passed validation; patch saved to ${saved.relPath} for manual review.`;
    if (task && typeof task === 'object') {
      task.failure_class = 'review_unavailable';
      task.pending_review_patch = saved.relPath;
      task.status = 'blocked';
      task.last_error = reasonText;
      task.error_history = Array.isArray(task.error_history) ? task.error_history : [];
      task.error_history.push({
        attempt: attemptNum,
        stage: 'review',
        failure_class: 'review_unavailable',
        error_hash: hashString(revRes.error || 'review_unavailable'),
        summary: reasonText.slice(-600)
      });
    }
    if (typeof rollbackFn === 'function') {
      rollbackFn(rollbackTargets);
    }
    console.warn(`[Reviewer] review_unavailable (Validation PASSED): ${revRes.error}`);
    console.warn(`[Reviewer] Saved patch to ${saved.relPath} and rolled back worktree. Manual review required.`);
    return {
      action: 'break_blocked',
      validationPassed: true,
      status: 'blocked',
      failure_class: 'review_unavailable',
      patchPath: saved.absPath,
      relPatchPath: saved.relPath,
      blockReason: reasonText
    };
  }

  console.warn(`[Reviewer] ${revRes?.error}`);
  const failAction = typeof onRejectedReview === 'function'
    ? onRejectedReview(revRes)
    : { shouldBreak: true };
  return {
    action: failAction?.shouldBreak ? 'break_rejected' : 'retry_rejected',
    validationPassed: true
  };
}
