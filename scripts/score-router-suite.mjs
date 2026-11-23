#!/usr/bin/env node
/**
 * Batch 168 Item 4: Router Plan Scorer & 1-turn vs 5-turn Suite Comparison Harness.
 * Evaluates decomposeGoal against suite-v1.json ground-truth `expected_plan`:
 *   - scope: matched, missing, extra, precision, recall, f1, exact_match
 *   - kind / mode / risk_level match accuracy
 * Runs 1-turn vs 5-turn (repetitions per goal, unchanged Router model) guarded by adjusted Claude fresh-token ceiling.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { decomposeGoal } from './goal-planner.mjs';
import { parseRawCompletionResponse } from './lib/cache-benchmark.mjs';
import { readInstalled9RouterVersion } from './lib/client-9router.mjs';
import { loadMergedPolicy, resolveConfigDir } from './lib/policy-loader.mjs';
import { analyzeTaskDemand, RISK_LEVEL_RANK } from './lib/risk-policy.mjs';
import {
  BudgetExceededError,
  assertBudgetBeforeCall,
  calibrateProviderBuffer,
  estimateRequestPromptTokens,
  estimateTextTokens,
  estimateWorstCaseRunTokens,
  normalizeUsage
} from '../runtime/provider-gateway.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(TEAM_DIR, '..');
const DEFAULT_SUITE_PATH = path.resolve(TEAM_DIR, 'benchmarks', 'suite-v1.json');

const MODE_RANK = {
  consult: 1,
  quick: 2,
  standard: 3
};

function normalizeScopePath(p) {
  return String(p || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

function uniqueSortedScopes(list = []) {
  return [...new Set((Array.isArray(list) ? list : []).map(normalizeScopePath).filter(Boolean))].sort();
}

function pickPrimaryKind(tasks = []) {
  if (!Array.isArray(tasks) || tasks.length === 0) return null;
  const nonTestTask = tasks.find(t =>
    Array.isArray(t.scope) && t.scope.some(f => !/^tests?\//i.test(normalizeScopePath(f)))
  );
  const chosen = nonTestTask || tasks[0];
  return chosen?.kind ? String(chosen.kind).toLowerCase().trim() : null;
}

function pickHighestMode(tasks = []) {
  if (!Array.isArray(tasks) || tasks.length === 0) return null;
  let best = null;
  let bestRank = -1;
  for (const t of tasks) {
    const m = String(t?.mode || '').toLowerCase().trim();
    const rank = MODE_RANK[m] || 0;
    if (rank > bestRank) {
      bestRank = rank;
      best = m || best;
    }
  }
  return best;
}

function pickHighestRisk(tasks = []) {
  if (!Array.isArray(tasks) || tasks.length === 0) return null;
  let best = null;
  let bestRank = -1;
  for (const t of tasks) {
    const rRaw = String(t?.risk_level || '').toLowerCase().trim();
    const r = rRaw === 'ultra' ? 'critical' : rRaw;
    const rank = RISK_LEVEL_RANK[r] || 0;
    if (rank > bestRank) {
      bestRank = rank;
      best = r || best;
    }
  }
  return best;
}

let cachedScorerPolicy = null;
function getScorerPolicy(options = {}) {
  if (options.policyConfig) return options.policyConfig;
  if (!cachedScorerPolicy) {
    try {
      cachedScorerPolicy = loadMergedPolicy({ configDir: resolveConfigDir(options.configDir) });
    } catch {
      cachedScorerPolicy = {};
    }
  }
  return cachedScorerPolicy;
}

/**
 * Computes effective (mode, risk_level) after deterministic floor rules in analyzeTaskDemand.
 */
export function resolveEffectiveExpectedPlan(expectedPlan = {}, taskMeta = {}, policyConfig = null) {
  const policy = policyConfig || getScorerPolicy();
  const expectedScope = uniqueSortedScopes(expectedPlan.scope || []);
  const rawMode = expectedPlan.mode ? String(expectedPlan.mode).toLowerCase().trim() : null;
  const rawRiskRaw = expectedPlan.risk_level || expectedPlan.risk || null;
  const rawRisk = rawRiskRaw ? String(rawRiskRaw).toLowerCase().trim() : null;
  const rawKind = expectedPlan.kind ? String(expectedPlan.kind).toLowerCase().trim() : null;

  const demand = analyzeTaskDemand({
    title: taskMeta.title || '',
    goal: taskMeta.goal || '',
    scope: expectedScope,
    ...(rawKind ? { kind: rawKind } : {}),
    ...(rawMode ? { mode: rawMode } : {}),
    ...(rawRisk ? { risk_level: rawRisk } : {})
  }, policy);

  return {
    scope: expectedScope,
    raw_kind: rawKind,
    raw_mode: rawMode,
    raw_risk: rawRisk,
    kind: rawKind || demand.kind,
    mode: rawMode ? demand.mode : null,
    risk_level: rawRisk ? demand.riskLevel : null
  };
}

/**
 * Scores a Router plan output against ground truth expected_plan: { scope, kind, mode, risk_level }.
 * Evaluates mode & risk on EFFECTIVE values after deterministic floor rules (analyzeTaskDemand).
 */
export function scoreRouterPlan(planResult = {}, expectedPlan = {}, options = {}) {
  const policy = getScorerPolicy(options);
  const taskMeta = options.taskMeta || {};
  const effExpected = resolveEffectiveExpectedPlan(expectedPlan, taskMeta, policy);

  const expectedScope = effExpected.scope;
  const expectedKind = effExpected.kind;
  const expectedMode = effExpected.mode;
  const expectedRisk = effExpected.risk_level;
  const originFields = {
    expected_plan_origin: taskMeta.expected_plan_origin || expectedPlan.expected_plan_origin || null,
    generated_by_old_router: taskMeta.generated_by_old_router ?? expectedPlan.generated_by_old_router ?? null,
    circular_with_old_router: taskMeta.circular_with_old_router ?? expectedPlan.circular_with_old_router ?? null
  };

  const ok = Boolean(planResult?.ok) && Array.isArray(planResult?.tasks) && planResult.tasks.length > 0;
  if (!ok) {
    const emptyRouterEval = {
      expected_scope: expectedScope,
      actual_scope: [],
      matched_scope: [],
      missing_scope: [...expectedScope],
      extra_scope: [],
      scope_precision: 0,
      scope_recall: expectedScope.length === 0 ? 1 : 0,
      scope_f1: 0,
      scope_f2: expectedScope.length === 0 ? 1 : 0,
      scope_exact_match: expectedScope.length === 0,
      expected_kind: expectedKind,
      actual_kind: null,
      kind_match: false
    };
    const emptyPolicyEval = {
      declared_mode: null,
      effective_mode: null,
      expected_mode: expectedMode,
      raw_expected_mode: effExpected.raw_mode,
      declared_mode_match: false,
      mode_match: false,
      declared_risk: null,
      effective_risk: null,
      expected_risk: expectedRisk,
      raw_expected_risk: effExpected.raw_risk,
      declared_risk_match: false,
      risk_match: false
    };
    return {
      ok: false,
      ...emptyRouterEval,
      declared_mode: null,
      raw_expected_mode: effExpected.raw_mode,
      expected_mode: expectedMode,
      actual_mode: null,
      mode_match: false,
      declared_risk: null,
      raw_expected_risk: effExpected.raw_risk,
      expected_risk: expectedRisk,
      actual_risk: null,
      risk_match: false,
      router_eval: emptyRouterEval,
      policy_eval: emptyPolicyEval,
      ...originFields
    };
  }

  const tasks = planResult.tasks;
  const declaredTasks = tasks.map(t => ({
    ...t,
    mode: t?.declared_mode || t?.mode || null,
    risk_level: t?.declared_risk_level || t?.risk_level || null
  }));
  const effectiveActualTasks = tasks.map(t => {
    const scopeList = Array.isArray(t?.scope) ? t.scope : [];
    const demand = analyzeTaskDemand({
      title: t?.title || taskMeta.title || '',
      goal: t?.goal || taskMeta.goal || '',
      scope: scopeList,
      ...(t?.kind ? { kind: t.kind } : {}),
      ...(t?.mode ? { mode: t.mode } : {}),
      ...(t?.risk_level ? { risk_level: t.risk_level } : {})
    }, policy);
    return {
      ...t,
      kind: t?.kind ? String(t.kind).toLowerCase().trim() : demand.kind,
      mode: t?.mode ? demand.mode : demand.mode,
      risk_level: t?.risk_level ? demand.riskLevel : demand.riskLevel
    };
  });
  const actualScope = uniqueSortedScopes(tasks.flatMap(t => Array.isArray(t.scope) ? t.scope : []));
  const actualSet = new Set(actualScope);
  const expectedSet = new Set(expectedScope);

  const matchedScope = expectedScope.filter(f => actualSet.has(f));
  const missingScope = expectedScope.filter(f => !actualSet.has(f));
  const extraScope = actualScope.filter(f => !expectedSet.has(f));

  const precision = actualScope.length > 0
    ? matchedScope.length / actualScope.length
    : (expectedScope.length === 0 ? 1 : 0);
  const recall = expectedScope.length > 0
    ? matchedScope.length / expectedScope.length
    : 1;
  const f1 = (precision + recall) > 0
    ? (2 * precision * recall) / (precision + recall)
    : 0;
  const f2 = (4 * precision + recall) > 0
    ? (5 * precision * recall) / (4 * precision + recall)
    : 0;

  const actualKind = pickPrimaryKind(effectiveActualTasks);
  const declaredMode = pickHighestMode(declaredTasks);
  const actualMode = pickHighestMode(effectiveActualTasks);
  const declaredRisk = pickHighestRisk(declaredTasks);
  const actualRisk = pickHighestRisk(effectiveActualTasks);

  const routerEval = {
    expected_scope: expectedScope,
    actual_scope: actualScope,
    matched_scope: matchedScope,
    missing_scope: missingScope,
    extra_scope: extraScope,
    scope_precision: Math.round(precision * 10000) / 10000,
    scope_recall: Math.round(recall * 10000) / 10000,
    scope_f1: Math.round(f1 * 10000) / 10000,
    scope_f2: Math.round(f2 * 10000) / 10000,
    scope_exact_match: missingScope.length === 0 && extraScope.length === 0,
    expected_kind: expectedKind,
    actual_kind: actualKind,
    kind_match: Boolean(expectedKind && actualKind && expectedKind === actualKind)
  };

  const policyEval = {
    declared_mode: declaredMode,
    effective_mode: actualMode,
    expected_mode: expectedMode,
    raw_expected_mode: effExpected.raw_mode,
    declared_mode_match: Boolean(expectedMode && declaredMode && expectedMode === declaredMode),
    mode_match: Boolean(expectedMode && actualMode && expectedMode === actualMode),
    declared_risk: declaredRisk,
    effective_risk: actualRisk,
    expected_risk: expectedRisk,
    raw_expected_risk: effExpected.raw_risk,
    declared_risk_match: Boolean(expectedRisk && declaredRisk && expectedRisk === declaredRisk),
    risk_match: Boolean(expectedRisk && actualRisk && expectedRisk === actualRisk)
  };

  return {
    ok: true,
    ...routerEval,
    declared_mode: declaredMode,
    raw_expected_mode: effExpected.raw_mode,
    expected_mode: expectedMode,
    actual_mode: actualMode,
    mode_match: policyEval.mode_match,
    declared_risk: declaredRisk,
    raw_expected_risk: effExpected.raw_risk,
    expected_risk: expectedRisk,
    actual_risk: actualRisk,
    risk_match: policyEval.risk_match,
    router_eval: routerEval,
    policy_eval: policyEval,
    ...originFields
  };
}

function summarizeRunUsage(res, modelUsedOverride = null) {
  const turns = Array.isArray(res?.turn_usages) ? res.turn_usages : [];
  let promptTokensRaw = 0;
  let promptTokensAdjusted = 0;
  let usageAdjustedBuffer = 0;
  let cachedTokens = 0;
  let freshTokensAdjusted = 0;
  let completionTokens = 0;
  let cacheReported = false;
  for (const tu of turns) {
    const rawP = Number(tu.prompt_tokens_raw ?? tu.prompt_tokens ?? 0);
    const adjP = Number(tu.prompt_tokens_adjusted ?? rawP);
    const buf = Number(tu.usage_adjusted_buffer || 0);
    const c = (tu.cache_reported && typeof tu.reported_cached_tokens === 'number') ? tu.reported_cached_tokens : 0;
    if (tu.cache_reported) cacheReported = true;
    promptTokensRaw += rawP;
    promptTokensAdjusted += adjP;
    usageAdjustedBuffer += buf;
    cachedTokens += c;
    freshTokensAdjusted += Number(tu.fresh_tokens ?? Math.max(0, adjP - c));
    completionTokens += Number(tu.completion_tokens || 0);
  }
  return {
    model_used: modelUsedOverride || res?.model_used || null,
    turns_executed: res?.turns_executed ?? turns.length,
    prompt_tokens_raw: promptTokensRaw,
    prompt_tokens_adjusted: promptTokensAdjusted,
    usage_adjusted_buffer: usageAdjustedBuffer,
    cached_tokens: cacheReported ? cachedTokens : null,
    fresh_tokens_adjusted: freshTokensAdjusted,
    completion_tokens: completionTokens
  };
}

export function aggregateRouterModeMetrics(runEntries = []) {
  const entries = Array.isArray(runEntries) ? runEntries : [];
  const completed = entries.filter(e => Boolean(e?.ok));
  const n = completed.length;

  const sum = (arr, pick) => arr.reduce((acc, item) => acc + Number(pick(item) || 0), 0);
  const round4 = (v) => Math.round(v * 10000) / 10000;
  const round2 = (v) => Math.round(v * 100) / 100;

  return {
    total_runs: entries.length,
    completed_runs: n,
    stopped_runs: entries.length - n,
    total_matched_scope: sum(completed, e => e.score?.matched_scope?.length ?? 0),
    total_missing_scope: sum(completed, e => e.score?.missing_scope?.length ?? 0),
    total_extra_scope: sum(completed, e => e.score?.extra_scope?.length ?? 0),
    mean_scope_precision: n > 0 ? round4(sum(completed, e => e.score?.scope_precision ?? 0) / n) : 0,
    mean_scope_recall: n > 0 ? round4(sum(completed, e => e.score?.scope_recall ?? 0) / n) : 0,
    mean_scope_f1: n > 0 ? round4(sum(completed, e => e.score?.scope_f1 ?? 0) / n) : 0,
    mean_scope_f2: n > 0 ? round4(sum(completed, e => e.score?.scope_f2 ?? 0) / n) : 0,
    scope_exact_match_rate: n > 0 ? round4(completed.filter(e => e.score?.scope_exact_match).length / n) : 0,
    kind_accuracy: n > 0 ? round4(completed.filter(e => e.score?.kind_match).length / n) : 0,
    mode_accuracy: n > 0 ? round4(completed.filter(e => e.score?.mode_match).length / n) : 0,
    risk_accuracy: n > 0 ? round4(completed.filter(e => e.score?.risk_match).length / n) : 0,
    total_prompt_tokens_raw: sum(entries, e => e.prompt_tokens_raw ?? 0),
    total_prompt_tokens_adjusted: sum(entries, e => e.prompt_tokens_adjusted ?? 0),
    total_cached_tokens: sum(entries, e => e.cached_tokens ?? 0),
    total_fresh_tokens_adjusted: sum(entries, e => e.fresh_tokens_adjusted ?? 0),
    total_completion_tokens: sum(entries, e => e.completion_tokens ?? 0),
    mean_fresh_tokens_adjusted: n > 0 ? round2(sum(completed, e => e.fresh_tokens_adjusted ?? 0) / n) : 0,
    mean_turns_executed: n > 0 ? round2(sum(completed, e => e.turns_executed ?? 0) / n) : 0,
    mean_latency_ms: n > 0 ? round2(sum(completed, e => e.latency_ms ?? 0) / n) : 0
  };
}

function createParentCommitWorktree(repoRoot, tmpParentBase, task) {
  const dirName = `${String(task.task_id || 'task').replace(/[^a-zA-Z0-9._-]+/g, '_')}-${task.parent_commit}`;
  const wtDir = path.join(tmpParentBase, dirName);
  execFileSync('git', ['worktree', 'add', '--detach', wtDir, task.parent_commit], {
    cwd: repoRoot,
    stdio: 'pipe'
  });
  return wtDir;
}

function removeWorktreeQuiet(repoRoot, wtDir) {
  if (!wtDir) return;
  try {
    execFileSync('git', ['worktree', 'remove', '--force', wtDir], {
      cwd: repoRoot,
      stdio: 'pipe'
    });
  } catch {
    try { fs.rmSync(wtDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Computes planned run count BEFORE dispatching requests so runs never exceed budget mid-way.
 */
export function planLiveRunsWithinBudget({
  requestedRuns = 0,
  estimatedFreshPerRun = 20000,
  maxFreshBudget = null,
  label = 'model'
} = {}) {
  const reqRuns = Math.max(0, Math.floor(Number(requestedRuns || 0)));
  const estPer = Math.max(0, Number(estimatedFreshPerRun || 0));
  const rawProjected = reqRuns * estPer;
  const hasCap = maxFreshBudget !== null && maxFreshBudget !== undefined && Number.isFinite(Number(maxFreshBudget));
  const cap = hasCap ? Math.max(0, Number(maxFreshBudget)) : null;

  let plannedRuns = reqRuns;
  let reduced = false;
  if (hasCap && estPer > 0 && rawProjected > cap) {
    plannedRuns = Math.max(0, Math.floor(cap / estPer));
    reduced = plannedRuns < reqRuns;
  }
  const projectedFreshTokens = plannedRuns * estPer;

  return {
    label,
    requested_runs: reqRuns,
    planned_runs: plannedRuns,
    estimated_fresh_per_run: estPer,
    projected_fresh_tokens: projectedFreshTokens,
    max_fresh_budget: cap,
    reduced
  };
}

/**
 * Selects the `count` lowest-scoring runs prioritizing recall (missing files hurt more than extra files).
 */
export function selectLowestRecallGoals(runEntries = [], count = 3) {
  const ranked = [...(Array.isArray(runEntries) ? runEntries : [])].sort((a, b) => {
    const okA = a?.ok ? 1 : 0;
    const okB = b?.ok ? 1 : 0;
    if (okA !== okB) return okA - okB;

    const rA = Number(a?.score?.scope_recall ?? 0);
    const rB = Number(b?.score?.scope_recall ?? 0);
    if (rA !== rB) return rA - rB;

    const f2A = Number(a?.score?.scope_f2 ?? 0);
    const f2B = Number(b?.score?.scope_f2 ?? 0);
    if (f2A !== f2B) return f2A - f2B;

    const f1A = Number(a?.score?.scope_f1 ?? 0);
    const f1B = Number(b?.score?.scope_f1 ?? 0);
    if (f1A !== f1B) return f1A - f1B;

    const metaA = (a?.score?.kind_match ? 1 : 0) + (a?.score?.mode_match ? 1 : 0) + (a?.score?.risk_match ? 1 : 0);
    const metaB = (b?.score?.kind_match ? 1 : 0) + (b?.score?.mode_match ? 1 : 0) + (b?.score?.risk_match ? 1 : 0);
    if (metaA !== metaB) return metaA - metaB;

    return Number(a?.score?.scope_precision ?? 0) - Number(b?.score?.scope_precision ?? 0);
  });
  return ranked.slice(0, Math.max(0, Number(count || 0)));
}

function createBudgetedClaudeFetch({ baseFetch, maxFreshClaudeTokens, startingFreshTokens = 0, nineRouterVersion }) {
  const state = {
    cumulativeFreshTokens: Number(startingFreshTokens || 0),
    stoppedEarly: false,
    stopReason: null
  };

  const fetchImpl = async (url, init = {}) => {
    const rawBody = String(init?.body || '{}');
    let reqObj = null;
    try { reqObj = JSON.parse(rawBody); } catch {}
    const modelName = String(reqObj?.model || '');
    const isClaude = modelName.toLowerCase().includes('claude');

    if (isClaude && state.stoppedEarly) {
      state.stopReason = state.stopReason || `local budget stop: adjusted Claude fresh-token ceiling reached (${state.cumulativeFreshTokens}/${maxFreshClaudeTokens})`;
      throw new BudgetExceededError(state.stopReason, {
        budgetKind: 'claude_fresh_tokens',
        used: state.cumulativeFreshTokens,
        limit: maxFreshClaudeTokens
      });
    }

    if (isClaude) {
      const estPrompt = reqObj ? estimateRequestPromptTokens(reqObj) : estimateTextTokens(rawBody.length);
      const maxOutput = Number(reqObj?.max_tokens ?? 16384);
      try {
        assertBudgetBeforeCall({
          used: state.cumulativeFreshTokens,
          estimatedPrompt: estPrompt,
          maxOutput,
          limit: maxFreshClaudeTokens,
          budgetKind: 'claude_fresh_tokens'
        });
      } catch (budgetErr) {
        state.stoppedEarly = true;
        state.stopReason = budgetErr.message;
        throw budgetErr;
      }
    }

    const res = await baseFetch(url, init);
    try {
      if (isClaude && res.ok) {
        const clonedText = await res.clone().text();
        const parsed = parseRawCompletionResponse(clonedText);
        const usage = parsed?.data?.usage || null;
        if (usage && (typeof usage.prompt_tokens === 'number' || typeof usage.input_tokens === 'number')) {
          const norm = normalizeUsage(usage, {
            model: modelName,
            nineRouterVersion,
            streamed: Boolean(reqObj?.stream)
          });
          state.cumulativeFreshTokens += norm.fresh_tokens;
          if (state.cumulativeFreshTokens >= maxFreshClaudeTokens) {
            state.stoppedEarly = true;
            state.stopReason = `local budget stop: adjusted Claude fresh-token ceiling reached (${state.cumulativeFreshTokens}/${maxFreshClaudeTokens})`;
          }
        }
      }
    } catch {}
    return res;
  };

  return { fetchImpl, state };
}

/**
 * Benchmarks 1-turn vs 5-turn Router across suite-v1 goals (`repetitions` per goal/mode),
 * without altering the configured Router model, guarded strictly by adjusted Claude fresh-token cap.
 */
export async function runSuiteV1RouterBenchmark(options = {}) {
  const suitePath = options.suitePath || DEFAULT_SUITE_PATH;
  const loadedSuite = fs.existsSync(suitePath) ? JSON.parse(fs.readFileSync(suitePath, 'utf8')) : { tasks: [] };
  const allTasks = Array.isArray(options.tasks) ? options.tasks : (loadedSuite.tasks || []);
  const limit = Number(options.limit || 0);
  const tasks = limit > 0 ? allTasks.slice(0, limit) : allTasks;
  const repetitions = Math.max(1, Number(options.repetitions ?? 2));
  const startingFreshTokens = Number(options.startingFreshTokens || 0);
  const maxFreshClaudeTokens = Number(options.maxFreshClaudeTokens || 100000);
  const repoRoot = options.repoRoot || REPO_ROOT;
  const useParentWorktree = Boolean(options.useParentWorktree);
  const baseFetch = options.fetchFn || globalThis.fetch;
  const tmpSessionsRoot = options.sessionsDir || fs.mkdtempSync(path.join(os.tmpdir(), 'td-suite-router-'));
  const ownsTmpDir = !options.sessionsDir;
  const wtRoot = useParentWorktree ? fs.mkdtempSync(path.join(os.tmpdir(), 'td-suite-wt-')) : null;
  const createdWorktrees = [];
  const resolved9RouterVersion = options.nineRouterVersion !== undefined
    ? options.nineRouterVersion
    : readInstalled9RouterVersion().version;

  const { fetchImpl: budgetedFetch, state: budgetState } = createBudgetedClaudeFetch({
    baseFetch,
    maxFreshClaudeTokens,
    startingFreshTokens,
    nineRouterVersion: resolved9RouterVersion
  });

  const goalResults = [];
  const allOneTurnRuns = [];
  const allFiveTurnRuns = [];

  try {
    for (const task of tasks) {
      let taskRepoRoot = repoRoot;
      if (useParentWorktree && task.parent_commit) {
        taskRepoRoot = createParentCommitWorktree(repoRoot, wtRoot, task);
        createdWorktrees.push(taskRepoRoot);
      }

      const expectedPlan = task.expected_plan || {
        scope: task.scope || [],
        kind: task.kind || 'feature',
        mode: task.mode || 'standard',
        risk_level: task.risk_level || 'low'
      };

      const runModeReps = async (oneTurnMode) => {
        const modeTag = oneTurnMode ? 'one_turn' : 'five_turn';
        const repsOut = [];
        for (let rep = 1; rep <= repetitions; rep++) {
          if (budgetState.cumulativeFreshTokens >= maxFreshClaudeTokens || budgetState.stoppedEarly) {
            budgetState.stoppedEarly = true;
            budgetState.stopReason = budgetState.stopReason || `local budget stop: skipped ${task.task_id} (${modeTag} rep ${rep}), budget ${budgetState.cumulativeFreshTokens}/${maxFreshClaudeTokens}`;
            repsOut.push({
              task_id: task.task_id,
              mode_variant: modeTag,
              repetition: rep,
              ok: false,
              error: budgetState.stopReason,
              score: scoreRouterPlan({ ok: false, tasks: [] }, expectedPlan),
              turns_executed: 0,
              prompt_tokens_raw: 0,
              prompt_tokens_adjusted: 0,
              usage_adjusted_buffer: 0,
              cached_tokens: null,
              fresh_tokens_adjusted: 0,
              completion_tokens: 0,
              latency_ms: 0
            });
            continue;
          }

          const sessDir = path.join(tmpSessionsRoot, `${task.task_id}-${modeTag}-r${rep}`);
          fs.mkdirSync(sessDir, { recursive: true });
          const t0 = performance.now();
          const res = await decomposeGoal(task.goal || task.title, {
            dryRun: true,
            stream: true,
            oneTurnMode,
            repoRoot: taskRepoRoot,
            sessionsDir: sessDir,
            ...(options.modelOverride ? { modelOverride: options.modelOverride } : {}),
            ...(options.nineRouterVersion !== undefined ? { nineRouterVersion: options.nineRouterVersion } : {}),
            ...(options.baseUrlOverride ? { baseUrlOverride: options.baseUrlOverride } : {}),
            ...(options.apiKeyOverride ? { apiKeyOverride: options.apiKeyOverride } : {}),
            fetchFn: budgetedFetch
          });
          const latencyMs = Math.round((performance.now() - t0) * 100) / 100;
          const usageSummary = summarizeRunUsage(res);
          const score = scoreRouterPlan(res, expectedPlan, { taskMeta: task });

          repsOut.push({
            task_id: task.task_id,
            mode_variant: modeTag,
            repetition: rep,
            ok: Boolean(res?.ok),
            router_mode: res?.router_mode || null,
            fallback_to_tools: Boolean(res?.fallback_to_tools),
            fallback_reason: res?.fallback_reason || null,
            error: res?.ok ? null : (res?.error || 'unknown error'),
            ...usageSummary,
            latency_ms: latencyMs,
            score
          });
        }
        return repsOut;
      };

      const oneTurnReps = await runModeReps(true);
      const fiveTurnReps = await runModeReps(false);
      allOneTurnRuns.push(...oneTurnReps);
      allFiveTurnRuns.push(...fiveTurnReps);

      goalResults.push({
        task_id: task.task_id,
        title: task.title,
        parent_commit: task.parent_commit,
        expected_plan: expectedPlan,
        one_turn_reps: oneTurnReps,
        five_turn_reps: fiveTurnReps,
        one_turn_summary: aggregateRouterModeMetrics(oneTurnReps),
        five_turn_summary: aggregateRouterModeMetrics(fiveTurnReps)
      });
    }

    return {
      experiment: 'suite_v1_router_1turn_vs_5turn',
      checked_at: new Date().toISOString(),
      nine_router_version: resolved9RouterVersion,
      repetitions_per_goal: repetitions,
      use_parent_worktree: useParentWorktree,
      budget: {
        starting_fresh_tokens: startingFreshTokens,
        experiment_fresh_tokens: budgetState.cumulativeFreshTokens - startingFreshTokens,
        cumulative_fresh_tokens: budgetState.cumulativeFreshTokens,
        max_fresh_claude_tokens: maxFreshClaudeTokens,
        stopped_early: budgetState.stoppedEarly,
        stop_reason: budgetState.stopReason
      },
      summary: {
        one_turn: aggregateRouterModeMetrics(allOneTurnRuns),
        five_turn: aggregateRouterModeMetrics(allFiveTurnRuns)
      },
      goals: goalResults
    };
  } finally {
    for (const wtDir of createdWorktrees) {
      removeWorktreeQuiet(repoRoot, wtDir);
    }
    if (wtRoot) {
      try { fs.rmSync(wtRoot, { recursive: true, force: true }); } catch {}
    }
    if (ownsTmpDir) {
      try { fs.rmSync(tmpSessionsRoot, { recursive: true, force: true }); } catch {}
    }
  }
}

export function formatRouterSuiteMarkdown(report) {
  const s1 = report.summary?.one_turn || {};
  const s5 = report.summary?.five_turn || {};
  const lines = [
    `# Router Suite v1 Benchmark (9Router v${report.nine_router_version})`,
    `Budget: ${report.budget.experiment_fresh_tokens} / ${report.budget.max_fresh_claude_tokens} adjusted Claude fresh tokens (stopped_early=${report.budget.stopped_early}${report.budget.stop_reason ? `, reason=${report.budget.stop_reason}` : ''})`,
    '',
    '| Metric | 1-Turn Default | 5-Turn Tool Loop |',
    '| :--- | :---: | :---: |',
    `| Completed Runs | ${s1.completed_runs}/${s1.total_runs} | ${s5.completed_runs}/${s5.total_runs} |`,
    `| Matched / Missing / Extra Scope | ${s1.total_matched_scope} / ${s1.total_missing_scope} / ${s1.total_extra_scope} | ${s5.total_matched_scope} / ${s5.total_missing_scope} / ${s5.total_extra_scope} |`,
    `| Mean Precision / Recall / F1 | ${s1.mean_scope_precision} / ${s1.mean_scope_recall} / ${s1.mean_scope_f1} | ${s5.mean_scope_precision} / ${s5.mean_scope_recall} / ${s5.mean_scope_f1} |`,
    `| Exact Scope Match Rate | ${s1.scope_exact_match_rate} | ${s5.scope_exact_match_rate} |`,
    `| Kind / Mode / Risk Accuracy | ${s1.kind_accuracy} / ${s1.mode_accuracy} / ${s1.risk_accuracy} | ${s5.kind_accuracy} / ${s5.mode_accuracy} / ${s5.risk_accuracy} |`,
    `| Total Adjusted Fresh Tokens | ${s1.total_fresh_tokens_adjusted} | ${s5.total_fresh_tokens_adjusted} |`,
    `| Mean Fresh Tokens / Run | ${s1.mean_fresh_tokens_adjusted} | ${s5.mean_fresh_tokens_adjusted} |`,
    `| Mean Turns / Run | ${s1.mean_turns_executed} | ${s5.mean_turns_executed} |`
  ];
  return lines.join('\n');
}

export function formatModelComparisonMarkdown(report) {
  const sg = report.summary?.gemini || {};
  const sc = report.summary?.claude_on_worst || {};
  const lines = [
    `# Router 1-Turn Suite v1: ${report.primary_model} (12 goals) -> Top-${report.top_worst_count} Escalation on ${report.escalation_model} (9Router v${report.nine_router_version})`,
    `- Gemini Plan: ${report.gemini_budget_plan.planned_runs} runs x ~${report.gemini_budget_plan.estimated_fresh_per_run} est = ~${report.gemini_budget_plan.projected_fresh_tokens} fresh (0 Claude)`,
    `- Claude Plan: ${report.claude_budget_plan.planned_runs} runs x ~${report.claude_budget_plan.estimated_fresh_per_run} est = ~${report.claude_budget_plan.projected_fresh_tokens} / ${report.claude_budget_plan.max_fresh_budget} max (reduced=${report.claude_budget_plan.reduced})`,
    `- Claude Actual Spent: ${report.claude_budget.experiment_fresh_tokens} / ${report.claude_budget.max_fresh_claude_tokens} adjusted fresh tokens (stopped_early=${report.claude_budget.stopped_early})`,
    '',
    '## All Goals on Gemini Flash (1-Turn)',
    '| Goal ID | Match/Miss/Extra | Precision | Recall | F1 | F2 | Kind/Mode/Risk | RouterMode | Turns | Fresh Adj |',
    '| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- | :---: | :---: |'
  ];
  for (const r of (report.gemini_runs || [])) {
    const s = r.score || {};
    const kmr = `${s.kind_match ? 'Y' : 'N'}/${s.mode_match ? 'Y' : 'N'}/${s.risk_match ? 'Y' : 'N'}`;
    lines.push(
      `| ${r.task_id} | ${s.matched_scope?.length ?? 0}/${s.missing_scope?.length ?? 0}/${s.extra_scope?.length ?? 0} | ${s.scope_precision ?? 0} | ${s.scope_recall ?? 0} | ${s.scope_f1 ?? 0} | ${s.scope_f2 ?? 0} | ${kmr} | ${r.router_mode || 'err'} | ${r.turns_executed} | ${r.fresh_tokens_adjusted} |`
    );
  }
  lines.push(
    `| **MEAN (${sg.completed_runs}/${sg.total_runs})** | ${sg.total_matched_scope}/${sg.total_missing_scope}/${sg.total_extra_scope} | ${sg.mean_scope_precision} | ${sg.mean_scope_recall} | ${sg.mean_scope_f1} | ${sg.mean_scope_f2} | ${sg.kind_accuracy}/${sg.mode_accuracy}/${sg.risk_accuracy} | - | ${sg.mean_turns_executed} | ${sg.total_fresh_tokens_adjusted} |`,
    '',
    '## Lowest-Recall Goals: Gemini vs Claude (1-Turn)',
    '| Goal ID | Gemini (P / R / F1 / F2 | Miss / Extra | Fresh) | Claude (P / R / F1 / F2 | Miss / Extra | Fresh) |',
    '| :--- | :--- | :--- |'
  );
  for (const p of (report.comparison_pairs || [])) {
    const gs = p.gemini?.score || {};
    const cs = p.claude?.score || {};
    lines.push(
      `| ${p.task_id} | ${gs.scope_precision}/${gs.scope_recall}/${gs.scope_f1}/${gs.scope_f2} \\| M=${gs.missing_scope?.length ?? 0},E=${gs.extra_scope?.length ?? 0} \\| ${p.gemini?.fresh_tokens_adjusted ?? 0} | ${cs.scope_precision}/${cs.scope_recall}/${cs.scope_f1}/${cs.scope_f2} \\| M=${cs.missing_scope?.length ?? 0},E=${cs.extra_scope?.length ?? 0} \\| ${p.claude?.fresh_tokens_adjusted ?? 0} |`
    );
  }
  lines.push(
    '',
    `Claude Subset Mean (n=${sc.completed_runs}/${sc.total_runs}): P=${sc.mean_scope_precision}, R=${sc.mean_scope_recall}, F1=${sc.mean_scope_f1}, F2=${sc.mean_scope_f2}, Fresh=${sc.total_fresh_tokens_adjusted}`
  );
  return lines.join('\n');
}

/**
 * Batch 169 Item 4: Run all suite-v1 goals once on primaryModel (ag/gemini-3.8-flash-medium) in 1-turn mode,
 * rank lowest by recall/F2, plan Claude budget pre-flight, and rerun topWorstCount lowest goals on escalationModel.
 */
export async function runOneTurnModelComparisonSuite(options = {}) {
  const suitePath = options.suitePath || DEFAULT_SUITE_PATH;
  const loadedSuite = fs.existsSync(suitePath) ? JSON.parse(fs.readFileSync(suitePath, 'utf8')) : { tasks: [] };
  const allTasks = Array.isArray(options.tasks) ? options.tasks : (loadedSuite.tasks || []);
  const limit = Number(options.limit || 0);
  const tasks = limit > 0 ? allTasks.slice(0, limit) : allTasks;

  const primaryModel = options.primaryModel || 'ag/gemini-3.8-flash-medium';
  const escalationModel = options.escalationModel || 'ag/claude-sonnet-5-5';
  const topWorstCount = Math.max(1, Number(options.topWorstCount ?? 3));
  const estimatedPrimaryFreshPerRun = Number(options.estimatedPrimaryFreshPerRun ?? 7000);
  const estimatedEscalationFreshPerRun = Number(options.estimatedEscalationFreshPerRun ?? 20000);
  const maxFreshClaudeTokens = Number(options.maxFreshClaudeTokens ?? 60000);
  const repoRoot = options.repoRoot || REPO_ROOT;
  const useParentWorktree = Boolean(options.useParentWorktree);
  const baseFetch = options.fetchFn || globalThis.fetch;
  const tmpSessionsRoot = options.sessionsDir || fs.mkdtempSync(path.join(os.tmpdir(), 'td-cmp-models-'));
  const ownsTmpDir = !options.sessionsDir;
  const wtRoot = useParentWorktree ? fs.mkdtempSync(path.join(os.tmpdir(), 'td-cmp-wt-')) : null;
  const wtCache = new Map();
  const resolved9RouterVersion = options.nineRouterVersion !== undefined
    ? options.nineRouterVersion
    : readInstalled9RouterVersion().version;

  let calibrationResult = null;
  if (options.calibrateBufferFirst !== false) {
    calibrationResult = await calibrateProviderBuffer(primaryModel, {
      nineRouterVersion: resolved9RouterVersion,
      ...(options.baseUrlOverride ? { baseUrl: options.baseUrlOverride } : {}),
      ...(options.apiKeyOverride ? { apiKey: options.apiKeyOverride } : {}),
      fetchFn: baseFetch
    });
    console.log(`[Buffer Calibration] ${primaryModel}: raw=${calibrationResult.probe_prompt_tokens_raw}, flag=${calibrationResult.calibration_flag}`);
  }

  const geminiBudgetPlan = planLiveRunsWithinBudget({
    requestedRuns: tasks.length,
    estimatedFreshPerRun: estimatedPrimaryFreshPerRun,
    maxFreshBudget: null,
    label: primaryModel
  });
  console.log(`[Budget Plan] ${geminiBudgetPlan.label}: ${geminiBudgetPlan.planned_runs} runs x ~${geminiBudgetPlan.estimated_fresh_per_run} est. fresh = ~${geminiBudgetPlan.projected_fresh_tokens} total (Claude=0 / ${maxFreshClaudeTokens}).`);

  const { fetchImpl: budgetedFetch, state: claudeBudgetState } = createBudgetedClaudeFetch({
    baseFetch,
    maxFreshClaudeTokens,
    startingFreshTokens: 0,
    nineRouterVersion: resolved9RouterVersion
  });

  const getTaskRepoRoot = (task) => {
    if (!useParentWorktree || !task.parent_commit) return repoRoot;
    const key = `${task.task_id}:${task.parent_commit}`;
    if (!wtCache.has(key)) {
      wtCache.set(key, createParentCommitWorktree(repoRoot, wtRoot, task));
    }
    return wtCache.get(key);
  };

  const runGoalWithModel = async (task, modelId, tag) => {
    const taskRepoRoot = getTaskRepoRoot(task);
    const expectedPlan = task.expected_plan || {
      scope: task.scope || [],
      kind: task.kind || 'feature',
      mode: task.mode || 'standard',
      risk_level: task.risk_level || 'low'
    };
    const sessDir = path.join(tmpSessionsRoot, `${tag}-${task.task_id}`);
    fs.mkdirSync(sessDir, { recursive: true });
    const t0 = performance.now();
    const res = await decomposeGoal(task.goal || task.title, {
      dryRun: true,
      stream: true,
      oneTurnMode: true,
      disableFallbackToTools: Boolean(options.disableFallbackToTools),
      modelOverride: modelId,
      repoRoot: taskRepoRoot,
      sessionsDir: sessDir,
      nineRouterVersion: resolved9RouterVersion,
      ...(options.baseUrlOverride ? { baseUrlOverride: options.baseUrlOverride } : {}),
      ...(options.apiKeyOverride ? { apiKeyOverride: options.apiKeyOverride } : {}),
      fetchFn: budgetedFetch
    });
    const latencyMs = Math.round((performance.now() - t0) * 100) / 100;
    const usageSummary = summarizeRunUsage(res, res?.model_used || modelId);
    const score = scoreRouterPlan(res, expectedPlan, { taskMeta: task });
    return {
      task_id: task.task_id,
      title: task.title,
      parent_commit: task.parent_commit,
      requested_model: modelId,
      ok: Boolean(res?.ok),
      router_mode: res?.router_mode || null,
      fallback_to_tools: Boolean(res?.fallback_to_tools),
      fallback_reason: res?.fallback_reason || null,
      error: res?.ok ? null : (res?.error || 'unknown error'),
      ...usageSummary,
      latency_ms: latencyMs,
      planned_tasks: Array.isArray(res?.tasks)
        ? res.tasks.map(t => ({
            title: t.title,
            kind: t.kind || null,
            mode: t.mode,
            risk_level: t.risk_level,
            scope: t.scope,
            verification_commands: t.verification_commands || []
          }))
        : [],
      score
    };
  };

  try {
    const geminiRuns = [];
    for (const task of tasks) {
      geminiRuns.push(await runGoalWithModel(task, primaryModel, 'gemini'));
    }

    const worstCandidates = selectLowestRecallGoals(geminiRuns, topWorstCount);
    const claudeBudgetPlan = planLiveRunsWithinBudget({
      requestedRuns: worstCandidates.length,
      estimatedFreshPerRun: estimatedEscalationFreshPerRun,
      maxFreshBudget: maxFreshClaudeTokens,
      label: escalationModel
    });
    console.log(`[Budget Plan] ${claudeBudgetPlan.label}: ${claudeBudgetPlan.planned_runs}/${claudeBudgetPlan.requested_runs} runs x ~${claudeBudgetPlan.estimated_fresh_per_run} est. fresh = ~${claudeBudgetPlan.projected_fresh_tokens} / ${claudeBudgetPlan.max_fresh_budget} cap (reduced=${claudeBudgetPlan.reduced}).`);

    const selectedWorst = worstCandidates.slice(0, claudeBudgetPlan.planned_runs);
    const taskById = new Map(tasks.map(t => [t.task_id, t]));
    const claudeRuns = [];
    for (const entry of selectedWorst) {
      const task = taskById.get(entry.task_id);
      if (task) {
        claudeRuns.push(await runGoalWithModel(task, escalationModel, 'claude'));
      }
    }

    const claudeById = new Map(claudeRuns.map(r => [r.task_id, r]));
    const comparisonPairs = selectedWorst.map(gEntry => ({
      task_id: gEntry.task_id,
      title: gEntry.title,
      gemini: gEntry,
      claude: claudeById.get(gEntry.task_id) || null
    }));

    return {
      experiment: 'suite_v1_router_1turn_gemini_then_claude_worst3',
      checked_at: new Date().toISOString(),
      nine_router_version: resolved9RouterVersion,
      primary_model: primaryModel,
      escalation_model: escalationModel,
      top_worst_count: topWorstCount,
      use_parent_worktree: useParentWorktree,
      buffer_calibration: calibrationResult,
      gemini_budget_plan: geminiBudgetPlan,
      claude_budget_plan: claudeBudgetPlan,
      claude_budget: {
        experiment_fresh_tokens: claudeBudgetState.cumulativeFreshTokens,
        max_fresh_claude_tokens: maxFreshClaudeTokens,
        stopped_early: claudeBudgetState.stoppedEarly,
        stop_reason: claudeBudgetState.stopReason
      },
      selected_worst_task_ids: selectedWorst.map(w => w.task_id),
      summary: {
        gemini: aggregateRouterModeMetrics(geminiRuns),
        gemini_on_worst: aggregateRouterModeMetrics(selectedWorst),
        claude_on_worst: aggregateRouterModeMetrics(claudeRuns)
      },
      gemini_runs: geminiRuns,
      claude_runs: claudeRuns,
      comparison_pairs: comparisonPairs
    };
  } finally {
    for (const wtDir of wtCache.values()) {
      removeWorktreeQuiet(repoRoot, wtDir);
    }
    if (wtRoot) {
      try { fs.rmSync(wtRoot, { recursive: true, force: true }); } catch {}
    }
    if (ownsTmpDir) {
      try { fs.rmSync(tmpSessionsRoot, { recursive: true, force: true }); } catch {}
    }
  }
}

export function formatOneTurnGeminiMarkdown(report = {}) {
  const s = report.summary || {};
  const totalGoals = s.total_goals ?? (report.goals || []).length;
  const lines = [
    `# Batch 171 Item 4 — Suite-v1 Evaluation (${report.model || 'ag/gemini-3.8-flash-medium'})`,
    `9Router: v${report.nine_router_version || 'unknown'} | No-fallback: ${s.no_fallback_count ?? 0}/${totalGoals} (${s.no_fallback_pct ?? 0}%) | Fresh Adj: ${s.total_fresh_tokens_adjusted ?? 0}`,
    '',
    '## (a) Router Scope/Kind Evaluation',
    '| # | Task ID | Type / Origin | Router Mode | Fallback Reason | Turns | Fresh Adj | Cached | Comp | M/Miss/Ex | P | R | F1 | F2 | Kind (act/exp) |',
    '| :--- | :--- | :--- | :--- | :--- | ---: | ---: | ---: | ---: | :--- | ---: | ---: | ---: | ---: | :---: |'
  ];
  for (let i = 0; i < (report.goals || []).length; i++) {
    const g = report.goals[i];
    const sc = g.score || {};
    const re = sc.router_eval || sc;
    const originTag = g.is_blind
      ? 'BLIND'
      : (g.generated_by_old_router ? 'legacy_router (CIRCULAR)' : 'commit_ground_truth');
    lines.push(
      `| ${i + 1} | ${g.task_id} | ${originTag} | ${g.router_mode || 'err'} | ${g.fallback_reason || '-'} | ${g.turns_executed} | ${g.fresh_tokens_adjusted} | ${g.cached_tokens ?? 'null'} | ${g.completion_tokens} | ${re.matched_scope?.length ?? 0}/${re.missing_scope?.length ?? 0}/${re.extra_scope?.length ?? 0} | ${re.scope_precision ?? 0} | ${re.scope_recall ?? 0} | ${re.scope_f1 ?? 0} | ${re.scope_f2 ?? 0} | ${re.actual_kind || '-'}/${re.expected_kind || '-'}${re.kind_match ? '✓' : '✗'} |`
    );
  }
  lines.push(
    `| **MEAN (${s.completed_runs ?? 0}/${totalGoals})** | All goals | Blind=${s.blind_count ?? 0}, Circular=${s.circular_count ?? 0} | ${s.no_fallback_count ?? 0}/${totalGoals} one_turn | - | ${s.mean_turns_executed ?? 0} | ${s.total_fresh_tokens_adjusted ?? 0} | - | ${s.total_completion_tokens ?? 0} | ${s.total_matched_scope ?? 0}/${s.total_missing_scope ?? 0}/${s.total_extra_scope ?? 0} | ${s.mean_scope_precision ?? 0} | ${s.mean_scope_recall ?? 0} | ${s.mean_scope_f1 ?? 0} | ${s.mean_scope_f2 ?? 0} | ${s.kind_accuracy ?? 0} |`,
    '',
    '## (b) Policy Floor Evaluation (Mode & Risk: Router khai / Hiệu lực / Kỳ vọng)',
    '| # | Task ID | Mode — Router khai | Mode — Hiệu lực | Mode — Kỳ vọng | Match | Risk — Router khai | Risk — Hiệu lực | Risk — Kỳ vọng | Match |',
    '| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |'
  );
  for (let i = 0; i < (report.goals || []).length; i++) {
    const g = report.goals[i];
    const pe = g.score?.policy_eval || g.score || {};
    const effMode = pe.effective_mode ?? pe.actual_mode ?? '-';
    const effRisk = pe.effective_risk ?? pe.actual_risk ?? '-';
    const expModeLabel = `${pe.expected_mode || '-'}${pe.raw_expected_mode && pe.raw_expected_mode !== pe.expected_mode ? ` (raw:${pe.raw_expected_mode})` : ''}`;
    const expRiskLabel = `${pe.expected_risk || '-'}${pe.raw_expected_risk && pe.raw_expected_risk !== pe.expected_risk ? ` (raw:${pe.raw_expected_risk})` : ''}`;
    lines.push(
      `| ${i + 1} | ${g.task_id} | ${pe.declared_mode || '-'} | ${effMode} | ${expModeLabel} | ${pe.mode_match ? '✓' : '✗'} | ${pe.declared_risk || '-'} | ${effRisk} | ${expRiskLabel} | ${pe.risk_match ? '✓' : '✗'} |`
    );
  }
  lines.push(
    `| **MEAN (${s.completed_runs ?? 0}/${totalGoals})** | Policy Accuracy | - | - | - | **${s.mode_accuracy ?? 0}** | - | - | - | **${s.risk_accuracy ?? 0}** |`
  );
  return lines.join('\n');
}

/**
 * Batch 170-171: Re-scores suite-v1 goals in 1-turn mode on Gemini Flash (`disableEscalation: true` -> 0 Claude cost),
 * evaluates split Router (scope/kind) vs Policy (declared / post-floor effective / expected), and labels legacy circularity & blind goals.
 */
export async function runSuiteV1OneTurnGeminiSuite(options = {}) {
  const suitePath = options.suitePath || DEFAULT_SUITE_PATH;
  const loadedSuite = fs.existsSync(suitePath) ? JSON.parse(fs.readFileSync(suitePath, 'utf8')) : { tasks: [] };
  let allTasks = Array.isArray(options.tasks) ? options.tasks : (loadedSuite.tasks || []);
  if (options.blindOnly) {
    allTasks = allTasks.filter(t => Boolean(t.is_blind));
  }
  const limit = Number(options.limit || 0);
  const tasks = limit > 0 ? allTasks.slice(0, limit) : allTasks;

  const modelId = options.model || 'ag/gemini-3.8-flash-medium';
  const estimatedFreshPerRun = Number(options.estimatedFreshPerRun ?? 7000);
  const repoRoot = options.repoRoot || REPO_ROOT;
  const useParentWorktree = Boolean(options.useParentWorktree);
  const baseFetch = options.fetchFn || globalThis.fetch;
  const tmpSessionsRoot = options.sessionsDir || fs.mkdtempSync(path.join(os.tmpdir(), 'td-b170-gemini-'));
  const ownsTmpDir = !options.sessionsDir;
  const wtRoot = useParentWorktree ? fs.mkdtempSync(path.join(os.tmpdir(), 'td-b170-wt-')) : null;
  const wtCache = new Map();
  const resolved9RouterVersion = options.nineRouterVersion !== undefined
    ? options.nineRouterVersion
    : readInstalled9RouterVersion().version;
  const policyConfig = getScorerPolicy(options);

  let calibrationResult = null;
  if (options.calibrateBufferFirst !== false) {
    calibrationResult = await calibrateProviderBuffer(modelId, {
      nineRouterVersion: resolved9RouterVersion,
      ...(options.baseUrlOverride ? { baseUrl: options.baseUrlOverride } : {}),
      ...(options.apiKeyOverride ? { apiKey: options.apiKeyOverride } : {}),
      fetchFn: baseFetch
    });
    console.log(`[Buffer Calibration] ${modelId}: raw=${calibrationResult.probe_prompt_tokens_raw}, flag=${calibrationResult.calibration_flag}`);
  }

  const geminiBudgetPlan = planLiveRunsWithinBudget({
    requestedRuns: tasks.length,
    estimatedFreshPerRun,
    maxFreshBudget: null,
    label: modelId
  });
  console.log(`[Budget Plan] ${geminiBudgetPlan.label}: ${geminiBudgetPlan.planned_runs} runs x ~${geminiBudgetPlan.estimated_fresh_per_run} est. fresh = ~${geminiBudgetPlan.projected_fresh_tokens} total (Claude worst-case=0).`);

  const goals = [];
  try {
    for (const task of tasks) {
      let taskRepoRoot = repoRoot;
      if (useParentWorktree && task.parent_commit) {
        const key = `${task.task_id}:${task.parent_commit}`;
        if (!wtCache.has(key)) {
          wtCache.set(key, createParentCommitWorktree(repoRoot, wtRoot, task));
        }
        taskRepoRoot = wtCache.get(key);
      }

      const expectedPlan = task.expected_plan || {
        scope: task.scope || [],
        kind: task.kind || 'feature',
        mode: task.mode || 'standard',
        risk_level: task.risk_level || 'low'
      };

      const sessDir = path.join(tmpSessionsRoot, task.task_id);
      fs.mkdirSync(sessDir, { recursive: true });
      const t0 = performance.now();
      const res = await decomposeGoal(task.goal || task.title, {
        dryRun: true,
        stream: true,
        oneTurnMode: true,
        disableEscalation: options.disableEscalation !== undefined ? Boolean(options.disableEscalation) : true,
        disableFallbackToTools: Boolean(options.disableFallbackToTools),
        modelOverride: modelId,
        repoRoot: taskRepoRoot,
        sessionsDir: sessDir,
        nineRouterVersion: resolved9RouterVersion,
        ...(options.baseUrlOverride ? { baseUrlOverride: options.baseUrlOverride } : {}),
        ...(options.apiKeyOverride ? { apiKeyOverride: options.apiKeyOverride } : {}),
        fetchFn: baseFetch
      });
      const latencyMs = Math.round((performance.now() - t0) * 100) / 100;
      const usageSummary = summarizeRunUsage(res, res?.model_used || modelId);
      const score = scoreRouterPlan(res, expectedPlan, { taskMeta: task, policyConfig });

      goals.push({
        task_id: task.task_id,
        commit_hash: task.commit_hash || null,
        parent_commit: task.parent_commit || null,
        title: task.title,
        is_blind: Boolean(task.is_blind),
        expected_plan_origin: task.expected_plan_origin || null,
        generated_by_old_router: Boolean(task.generated_by_old_router),
        circular_with_old_router: Boolean(task.circular_with_old_router),
        ok: Boolean(res?.ok),
        router_mode: res?.router_mode || null,
        fallback_to_tools: Boolean(res?.fallback_to_tools),
        fallback_reason: res?.fallback_reason || null,
        gemini_attempts: res?.gemini_attempts ?? null,
        escalated_to_claude: Boolean(res?.escalated_to_claude),
        warnings: res?.warnings || [],
        post_patch_checks: res?.post_patch_checks || null,
        error: res?.ok ? null : (res?.error || 'unknown error'),
        ...usageSummary,
        latency_ms: latencyMs,
        planned_tasks: Array.isArray(res?.tasks)
          ? res.tasks.map(t => ({
              title: t.title,
              kind: t.kind || null,
              declared_mode: t.declared_mode || null,
              mode: t.mode,
              declared_risk_level: t.declared_risk_level || null,
              risk_level: t.risk_level,
              scope: t.scope,
              verification_commands: t.verification_commands || []
            }))
          : [],
        score
      });
    }

    const agg = aggregateRouterModeMetrics(goals);
    const noFallbackCount = goals.filter(g => !g.fallback_to_tools).length;
    const totalComp = goals.reduce((s, g) => s + Number(g.completion_tokens || 0), 0);
    const circularGoals = goals.filter(g => g.generated_by_old_router);
    const nonCircularGoals = goals.filter(g => !g.generated_by_old_router && !g.is_blind);
    const blindGoals = goals.filter(g => g.is_blind);

    return {
      experiment: 'batch171_item4_suite_v1_split_eval',
      checked_at: new Date().toISOString(),
      nine_router_version: resolved9RouterVersion,
      model: modelId,
      use_parent_worktree: useParentWorktree,
      buffer_calibration: calibrationResult,
      budget_plan: geminiBudgetPlan,
      claude_fresh_tokens_used: 0,
      goals,
      summary: {
        ...agg,
        total_goals: goals.length,
        no_fallback_count: noFallbackCount,
        no_fallback_pct: goals.length > 0 ? Math.round((noFallbackCount / goals.length) * 1000) / 10 : 0,
        total_completion_tokens: totalComp,
        circular_count: circularGoals.length,
        blind_count: blindGoals.length,
        circular_subset: aggregateRouterModeMetrics(circularGoals),
        non_circular_subset: aggregateRouterModeMetrics(nonCircularGoals),
        blind_subset: aggregateRouterModeMetrics(blindGoals)
      }
    };
  } finally {
    for (const wtDir of wtCache.values()) {
      removeWorktreeQuiet(repoRoot, wtDir);
    }
    if (wtRoot) {
      try { fs.rmSync(wtRoot, { recursive: true, force: true }); } catch {}
    }
    if (ownsTmpDir) {
      try { fs.rmSync(tmpSessionsRoot, { recursive: true, force: true }); } catch {}
    }
  }
}

function parseCliArgs(argv) {
  const args = {
    live: argv.includes('--live'),
    compareModels: argv.includes('--compare-models'),
    oneTurnGemini: argv.includes('--one-turn-gemini'),
    blindOnly: argv.includes('--blind-only'),
    atParent: argv.includes('--at-parent'),
    reps: 2,
    budget: 100000,
    limit: 0,
    worst: 3,
    estClaude: 20000,
    primary: 'ag/gemini-3.8-flash-medium',
    escalation: 'ag/claude-sonnet-5-5',
    out: null
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--reps' && argv[i + 1]) args.reps = Number(argv[++i]);
    else if (argv[i] === '--budget' && argv[i + 1]) args.budget = Number(argv[++i]);
    else if (argv[i] === '--limit' && argv[i + 1]) args.limit = Number(argv[++i]);
    else if (argv[i] === '--worst' && argv[i + 1]) args.worst = Number(argv[++i]);
    else if (argv[i] === '--est-claude' && argv[i + 1]) args.estClaude = Number(argv[++i]);
    else if (argv[i] === '--primary' && argv[i + 1]) args.primary = argv[++i];
    else if (argv[i] === '--escalation' && argv[i + 1]) args.escalation = argv[++i];
    else if (argv[i] === '--out' && argv[i + 1]) args.out = path.resolve(argv[++i]);
  }
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const cli = parseCliArgs(process.argv.slice(2));
  if (!cli.live) {
    console.error('Usage: node agent-team/scripts/score-router-suite.mjs --live [--one-turn-gemini | --compare-models] [--at-parent] [--reps 2] [--budget 100000] [--limit N] [--out file.json]');
    process.exit(2);
  }
  const report = cli.oneTurnGemini
    ? await runSuiteV1OneTurnGeminiSuite({
        model: cli.primary,
        limit: cli.limit,
        blindOnly: cli.blindOnly,
        useParentWorktree: cli.atParent
      })
    : (cli.compareModels
        ? await runOneTurnModelComparisonSuite({
            primaryModel: cli.primary,
            escalationModel: cli.escalation,
            topWorstCount: cli.worst,
            estimatedEscalationFreshPerRun: cli.estClaude,
            maxFreshClaudeTokens: cli.budget,
            limit: cli.limit,
            useParentWorktree: cli.atParent
          })
        : await runSuiteV1RouterBenchmark({
            repetitions: cli.reps,
            maxFreshClaudeTokens: cli.budget,
            limit: cli.limit,
            useParentWorktree: cli.atParent
          }));
  if (cli.out) {
    fs.mkdirSync(path.dirname(cli.out), { recursive: true });
    fs.writeFileSync(cli.out, JSON.stringify(report, null, 2), 'utf8');
  }
  console.log(
    cli.oneTurnGemini
      ? formatOneTurnGeminiMarkdown(report)
      : (cli.compareModels ? formatModelComparisonMarkdown(report) : formatRouterSuiteMarkdown(report))
  );
  console.log('\n--- JSON REPORT ---');
  console.log(JSON.stringify(report, null, 2));
}
