import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { decomposeGoal, resolveGoalPlannerConfig } from './goal-planner.mjs';
import { resolveRepoRoot } from './applier.mjs';
import { parseRawCompletionResponse } from './lib/cache-benchmark.mjs';
import { check9RouterHealth, readInstalled9RouterVersion } from './lib/client-9router.mjs';
import { analyzeTurn1PayloadHashes } from './lib/prefix-invariant.mjs';
import {
  BudgetExceededError,
  assertBudgetBeforeCall,
  estimateRequestPromptTokens,
  estimateTextTokens,
  extractReportedCachedTokens,
  normalizeUsage
} from '../runtime/provider-gateway.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = resolveRepoRoot();

export const DEFAULT_PRESET_PILLS_GOAL =
  'Remove deprecated #filter-presets toolbar pills and legacy event listeners, fix grid overflow on #filter-mode-pills in web/index.html, and update tests/test_dom_contract.js.';

export async function runRouterDryRunLoopBenchmark(options = {}) {
  const repetitions = Number(options.repetitions || 3);
  const goal = String(options.goal || DEFAULT_PRESET_PILLS_GOAL);
  const tmpSessionsRoot = options.sessionsDir || fs.mkdtempSync(path.join(os.tmpdir(), 'td-router-loop-'));
  const ownsTmpDir = !options.sessionsDir;

  const runs = [];
  try {
    for (let rep = 1; rep <= repetitions; rep++) {
      const repSessionsDir = path.join(tmpSessionsRoot, `rep-${rep}`);
      fs.mkdirSync(repSessionsDir, { recursive: true });
      const startedMs = performance.now();
      const res = await decomposeGoal(goal, {
        dryRun: true,
        stream: true,
        oneTurnMode: options.oneTurnMode ?? false,
        repoRoot: options.repoRoot || REPO_ROOT,
        sessionsDir: repSessionsDir,
        ...(options.modelOverride ? { modelOverride: options.modelOverride } : {}),
        ...(options.baseUrlOverride ? { baseUrlOverride: options.baseUrlOverride } : {}),
        ...(options.apiKeyOverride ? { apiKeyOverride: options.apiKeyOverride } : {}),
        ...(options.fetchFn ? { fetchFn: options.fetchFn } : {})
      });
      const totalLatencyMs = Math.round((performance.now() - startedMs) * 100) / 100;

      const turns = Array.isArray(res.turn_usages)
        ? res.turn_usages.map(tu => ({
            turn: tu.turn,
            stage: tu.stage || 'tool_loop',
            requested_model: tu.requested_model || null,
            actual_model: tu.actual_model || tu.model || null,
            prompt_tokens: tu.prompt_tokens ?? 0,
            cached_tokens: tu.cache_reported ? (tu.reported_cached_tokens ?? null) : null,
            cache_reported: Boolean(tu.cache_reported),
            cache_hit_ratio: tu.cache_reported ? (tu.cache_hit_ratio ?? null) : null,
            cache_creation_input_tokens: tu.cache_creation_input_tokens ?? 0,
            completion_tokens: tu.completion_tokens ?? 0,
            reasoning_tokens: tu.reasoning_tokens ?? 0,
            usage_quality: tu.usage_quality || 'full',
            raw_usage: tu.raw_usage ?? null
          }))
        : [];

      runs.push({
        repetition: rep,
        ok: Boolean(res.ok),
        model_used: res.model_used || null,
        turns_executed: res.turns_executed ?? turns.length,
        total_latency_ms: totalLatencyMs,
        total_created_tasks: res.total_created || 0,
        error: res.ok ? null : (res.error || 'unknown error'),
        turns
      });
    }
  } finally {
    if (ownsTmpDir) {
      fs.rmSync(tmpSessionsRoot, { recursive: true, force: true });
    }
  }

  return {
    experiment: 'router_dry_run_stream',
    checked_at: new Date().toISOString(),
    nine_router_version: options.nineRouterVersion ?? readInstalled9RouterVersion().version,
    goal,
    repetitions,
    runs
  };
}

export async function runTurn1OfflineDiagnosis(options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const sessionsDir = path.join(TEAM_DIR, 'state', 'sessions');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'td-turn1-diag-'));

  const summarizeDiag = (diag) => ({
    system_hash_equal: diag.system_hash_equal,
    tools_hash_equal: diag.tools_hash_equal,
    differing_parts: diag.differing_parts,
    parts: diag.parts.map(p => ({
      part: p.part,
      equal: p.equal,
      bytes_1: p.bytes_1,
      bytes_2: p.bytes_2,
      sha256_1: p.sha256_1.slice(0, 12),
      sha256_2: p.sha256_2.slice(0, 12)
    })),
    user_subsections: diag.user_subsections.map(s => ({
      index: s.index,
      label: s.label,
      equal: s.equal,
      bytes_1: s.bytes_1,
      bytes_2: s.bytes_2,
      sha256_1: s.sha256_1.slice(0, 12),
      sha256_2: (s.sha256_2 || '').slice(0, 12),
      reasons: s.volatile_reasons
    })),
    volatile_before_static: diag.volatile_before_static
  });

  try {
    const captureTurn1Offline = async (goalText, tag) => {
      let firstPayload = null;
      await decomposeGoal(goalText, {
        dryRun: true,
        stream: true,
        repoRoot,
        sessionsDir: path.join(tmpRoot, tag),
        baseUrlOverride: 'http://127.0.0.1:20199/v1',
        apiKeyOverride: 'mock-offline',
        fetchFn: async (_url, init = {}) => {
          const payload = JSON.parse(String(init.body || '{}'));
          if (!firstPayload) firstPayload = payload;
          const okJson = JSON.stringify({
            tasks: [{
              title: 'Offline diag',
              goal: goalText,
              mode: 'quick',
              risk_level: 'low',
              scope: ['web/index.html'],
              acceptance_criteria: ['OK 1', 'OK 2']
            }]
          });
          return new Response(
            `data: ${JSON.stringify({ id: 'diag', model: payload.model, choices: [{ index: 0, delta: { content: okJson }, finish_reason: null }] })}\n\n` +
            `data: ${JSON.stringify({ id: 'diag', model: payload.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n` +
            `data: [DONE]\n\n`,
            { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
          );
        }
      });
      return firstPayload;
    };

    let recordedSessions = null;
    const rec1Path = path.join(sessionsDir, 'planner-mw99cc19.json');
    const rec2Path = path.join(sessionsDir, 'planner-mw8ugugt.json');
    if (fs.existsSync(rec1Path) && fs.existsSync(rec2Path)) {
      const s1 = JSON.parse(fs.readFileSync(rec1Path, 'utf8'));
      const s2 = JSON.parse(fs.readFileSync(rec2Path, 'utf8'));
      recordedSessions = summarizeDiag(
        analyzeTurn1PayloadHashes(
          { model: s1.model, messages: [s1.messages[0]] },
          { model: s2.model, messages: [s2.messages[0]] }
        )
      );
    }

    const goalA = DEFAULT_PRESET_PILLS_GOAL;
    const goalB = 'Refactor job queue retry backoff in src/worker.js and update tests/test_worker.js';
    const pSame1 = await captureTurn1Offline(goalA, 'same-1');
    const pSame2 = await captureTurn1Offline(goalA, 'same-2');
    const pOtherB = await captureTurn1Offline(goalB, 'other-b');

    return {
      experiment: 'router_turn1_offline_hash_diagnosis',
      checked_at: new Date().toISOString(),
      nine_router_version: options.nineRouterVersion ?? readInstalled9RouterVersion().version,
      recorded_legacy_sessions_mw99cc19_vs_mw8ugugt: recordedSessions,
      current_same_goal_run1_vs_run2: summarizeDiag(analyzeTurn1PayloadHashes(pSame1, pSame2)),
      current_cross_goal_runA_vs_runB: summarizeDiag(analyzeTurn1PayloadHashes(pSame1, pOtherB))
    };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

export const DEFAULT_THREE_COMPARISON_GOALS = [
  {
    id: 'goal-1-filter-pills',
    label: 'Filter Pills UI + DOM Contract',
    goal: DEFAULT_PRESET_PILLS_GOAL
  },
  {
    id: 'goal-2-worker-bounds',
    label: 'Worker Bounds + Bridge + Test',
    goal: 'Fix empty input bounds handling in src/worker.js, wire health check in api/bridge.js, and add unit tests in tests/test_worker.js.'
  },
  {
    id: 'goal-3-provider-presets',
    label: 'ProviderService + Bridge Presets + Test',
    goal: 'Fix default model list handling in ProviderService (src/providers/service.js) and list_presets in api/bridge.js with unit tests in tests/test_providers.js.'
  }
];

function summarizePlanResult(res) {
  if (!res || !res.ok) {
    return {
      ok: false,
      error: res?.error || 'unknown error',
      turns_executed: res?.turns_executed ?? 0,
      tasks: []
    };
  }
  const tasks = Array.isArray(res.tasks)
    ? res.tasks.map(t => ({
        title: t.title,
        kind: t.kind || null,
        mode: t.mode,
        risk_level: t.risk_level,
        scope: Array.isArray(t.scope) ? t.scope : [],
        scope_dependents: t.scope_dependents || null,
        scope_warnings: t.scope_warnings || [],
        acceptance_criteria_count: Array.isArray(t.acceptance_criteria) ? t.acceptance_criteria.length : 0
      }))
    : [];
  const turns = Array.isArray(res.turn_usages) ? res.turn_usages : [];
  let promptTokensRaw = 0;
  let promptTokensAdjusted = 0;
  let usageAdjustedBuffer = 0;
  let cachedTokens = 0;
  let freshTokens = 0;
  let completionTokens = 0;
  for (const tu of turns) {
    const rawP = Number(tu.prompt_tokens_raw ?? tu.prompt_tokens ?? 0);
    const adjP = Number(tu.prompt_tokens_adjusted ?? rawP);
    const c = tu.cache_reported && typeof tu.reported_cached_tokens === 'number' ? tu.reported_cached_tokens : 0;
    promptTokensRaw += rawP;
    promptTokensAdjusted += adjP;
    usageAdjustedBuffer += Number(tu.usage_adjusted_buffer || 0);
    cachedTokens += c;
    freshTokens += Number(tu.fresh_tokens ?? Math.max(0, adjP - c));
    completionTokens += Number(tu.completion_tokens || 0);
  }
  return {
    ok: true,
    model_used: res.model_used || null,
    turns_executed: res.turns_executed ?? turns.length,
    prompt_tokens: promptTokensRaw,
    prompt_tokens_raw: promptTokensRaw,
    prompt_tokens_adjusted: promptTokensAdjusted,
    usage_adjusted_buffer: usageAdjustedBuffer,
    cached_tokens: turns.some(t => t.cache_reported) ? cachedTokens : null,
    fresh_tokens: freshTokens,
    completion_tokens: completionTokens,
    tasks
  };
}

function diffRouterPlans(fiveSummary, oneSummary) {
  if (!fiveSummary?.ok || !oneSummary?.ok) {
    return {
      comparable: false,
      reason: !fiveSummary?.ok ? `5-turn unavailable (${fiveSummary?.error || 'skipped'})` : `1-turn failed (${oneSummary?.error || 'failed'})`
    };
  }
  const scope5 = [...new Set(fiveSummary.tasks.flatMap(t => t.scope || []))].sort();
  const scope1 = [...new Set(oneSummary.tasks.flatMap(t => t.scope || []))].sort();
  const set5 = new Set(scope5);
  const set1 = new Set(scope1);
  return {
    comparable: true,
    task_count_5turn: fiveSummary.tasks.length,
    task_count_1turn: oneSummary.tasks.length,
    modes_5turn: fiveSummary.tasks.map(t => t.mode),
    modes_1turn: oneSummary.tasks.map(t => t.mode),
    risks_5turn: fiveSummary.tasks.map(t => t.risk_level),
    risks_1turn: oneSummary.tasks.map(t => t.risk_level),
    scope_common: scope5.filter(f => set1.has(f)),
    scope_added_in_1turn: scope1.filter(f => !set5.has(f)),
    scope_removed_in_1turn: scope5.filter(f => !set1.has(f)),
    fresh_token_delta: oneSummary.fresh_tokens - fiveSummary.fresh_tokens,
    turn_delta: oneSummary.turns_executed - fiveSummary.turns_executed
  };
}

/**
 * Runs a 3-goal comparison between current 5-turn Router and 1-turn embedded-snippet Router
 * without modifying the configured Router model, guarded strictly by a cumulative Claude fresh-token cap.
 */
export async function compareRouterOneTurnVsCurrent(options = {}) {
  const goals = Array.isArray(options.goals) && options.goals.length > 0
    ? options.goals
    : DEFAULT_THREE_COMPARISON_GOALS;
  const startingFreshTokens = Number(options.startingFreshTokens || 0);
  const maxFreshClaudeTokens = Number(options.maxFreshClaudeTokens || 200000);
  const repoRoot = options.repoRoot || REPO_ROOT;
  const baseFetch = options.fetchFn || globalThis.fetch;
  const tmpSessionsRoot = options.sessionsDir || fs.mkdtempSync(path.join(os.tmpdir(), 'td-router-cmp-'));
  const ownsTmpDir = !options.sessionsDir;

  const resolved9RouterVersion = options.nineRouterVersion !== undefined
    ? options.nineRouterVersion
    : readInstalled9RouterVersion().version;

  let cumulativeFreshTokens = startingFreshTokens;
  let stoppedEarly = false;
  let stopReason = null;

  const budgetedFetch = async (url, init = {}) => {
    const rawBody = String(init?.body || '{}');
    let reqObj = null;
    try { reqObj = JSON.parse(rawBody); } catch {}
    const modelName = String(reqObj?.model || '');
    const isClaude = modelName.toLowerCase().includes('claude');

    if (isClaude && (cumulativeFreshTokens >= maxFreshClaudeTokens || stoppedEarly)) {
      stoppedEarly = true;
      stopReason = stopReason || `local budget stop: Claude fresh-token ceiling reached (${cumulativeFreshTokens}/${maxFreshClaudeTokens})`;
      throw new BudgetExceededError(stopReason, {
        budgetKind: 'claude_fresh_tokens',
        used: cumulativeFreshTokens,
        limit: maxFreshClaudeTokens
      });
    }

    if (isClaude) {
      const estPrompt = reqObj ? estimateRequestPromptTokens(reqObj) : estimateTextTokens(rawBody.length);
      const maxOutput = Number(reqObj?.max_tokens ?? 16384);
      try {
        assertBudgetBeforeCall({
          used: cumulativeFreshTokens,
          estimatedPrompt: estPrompt,
          maxOutput,
          limit: maxFreshClaudeTokens,
          budgetKind: 'claude_fresh_tokens'
        });
      } catch (budgetErr) {
        stoppedEarly = true;
        stopReason = budgetErr.message;
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
            nineRouterVersion: resolved9RouterVersion,
            streamed: Boolean(reqObj?.stream)
          });
          cumulativeFreshTokens += norm.fresh_tokens;
          if (cumulativeFreshTokens >= maxFreshClaudeTokens) {
            stoppedEarly = true;
            stopReason = `local budget stop: Claude adjusted fresh-token ceiling reached after turn (${cumulativeFreshTokens}/${maxFreshClaudeTokens})`;
          }
        }
      }
    } catch {}
    return res;
  };

  const resultsByGoal = new Map(goals.map(g => [g.id, { ...g, one_turn: null, five_turn: null }]));

  const runSingle = async (goalEntry, oneTurnMode) => {
    const modeLabel = oneTurnMode ? 'oneTurn' : 'fiveTurn';
    if (cumulativeFreshTokens >= maxFreshClaudeTokens || stoppedEarly) {
      stoppedEarly = true;
      stopReason = stopReason || `local budget stop: skipped ${goalEntry.id} (${modeLabel}), fresh budget ${cumulativeFreshTokens}/${maxFreshClaudeTokens}`;
      return { ok: false, budget_exceeded: true, nonRetryable: true, error: stopReason, turns_executed: 0, tasks: [] };
    }
    const sessDir = path.join(tmpSessionsRoot, `${goalEntry.id}-${modeLabel}`);
    fs.mkdirSync(sessDir, { recursive: true });
    const startedMs = performance.now();
    const res = await decomposeGoal(goalEntry.goal, {
      dryRun: true,
      stream: true,
      oneTurnMode,
      repoRoot,
      sessionsDir: sessDir,
      ...(options.modelOverride ? { modelOverride: options.modelOverride } : {}),
      ...(options.nineRouterVersion !== undefined ? { nineRouterVersion: options.nineRouterVersion } : {}),
      ...(options.baseUrlOverride ? { baseUrlOverride: options.baseUrlOverride } : {}),
      ...(options.apiKeyOverride ? { apiKeyOverride: options.apiKeyOverride } : {}),
      fetchFn: budgetedFetch
    });
    const latencyMs = Math.round((performance.now() - startedMs) * 100) / 100;
    return {
      ...summarizePlanResult(res),
      latency_ms: latencyMs
    };
  };

  try {
    // Pass 1: Run all 3 goals in 1-turn mode first (guarantees full 1-turn baseline cleanly within budget)
    for (const g of goals) {
      resultsByGoal.get(g.id).one_turn = await runSingle(g, true);
    }
    // Pass 2: Run 5-turn current Router on each goal until completion or budget cap
    for (const g of goals) {
      resultsByGoal.get(g.id).five_turn = await runSingle(g, false);
    }

    const goalReports = goals.map(g => {
      const entry = resultsByGoal.get(g.id);
      return {
        id: g.id,
        label: g.label,
        goal: g.goal,
        five_turn: entry.five_turn,
        one_turn: entry.one_turn,
        diff: diffRouterPlans(entry.five_turn, entry.one_turn)
      };
    });

    return {
      experiment: 'router_5turn_vs_1turn_3goals',
      checked_at: new Date().toISOString(),
      nine_router_version: options.nineRouterVersion ?? readInstalled9RouterVersion().version,
      budget: {
        starting_fresh_tokens: startingFreshTokens,
        experiment_fresh_tokens: cumulativeFreshTokens - startingFreshTokens,
        cumulative_fresh_tokens: cumulativeFreshTokens,
        max_fresh_claude_tokens: maxFreshClaudeTokens,
        stopped_early: stoppedEarly,
        stop_reason: stopReason
      },
      goals: goalReports
    };
  } finally {
    if (ownsTmpDir) {
      fs.rmSync(tmpSessionsRoot, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  if (process.argv.includes('--diagnose-turn1')) {
    const report = await runTurn1OfflineDiagnosis();
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }
  const modelIdx = process.argv.indexOf('--model');
  const modelOverride = modelIdx !== -1 ? process.argv[modelIdx + 1] : null;
  const { teamConfig, policyConfig } = resolveGoalPlannerConfig();
  const health = await check9RouterHealth(teamConfig, policyConfig);
  if (!health.ok) {
    console.error(`[RouterLoop] 9Router healthcheck failed: ${health.error}`);
    process.exit(1);
  }

  if (process.argv.includes('--compare-3-goals')) {
    const startIdx = process.argv.indexOf('--starting-fresh');
    const budgetIdx = process.argv.indexOf('--budget');
    const startingFreshTokens = startIdx !== -1 ? Number(process.argv[startIdx + 1] || 0) : 0;
    const maxFreshClaudeTokens = budgetIdx !== -1 ? Number(process.argv[budgetIdx + 1] || 200000) : 200000;
    const report = await compareRouterOneTurnVsCurrent({
      startingFreshTokens,
      maxFreshClaudeTokens,
      ...(modelOverride ? { modelOverride } : {})
    });
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }

  const repsIdx = process.argv.indexOf('--reps');
  const repetitions = repsIdx !== -1 && Number(process.argv[repsIdx + 1]) > 0
    ? Number(process.argv[repsIdx + 1])
    : 3;

  const report = await runRouterDryRunLoopBenchmark({
    repetitions,
    ...(modelOverride ? { modelOverride } : {})
  });
  console.log(JSON.stringify(report, null, 2));
}
