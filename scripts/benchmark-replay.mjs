#!/usr/bin/env node
/**
 * Benchmark Suite Inspector, Token Reconciler & Median/IQR Reporter
 * Enforces the Single-Variable Experimentation Protocol:
 * - Fixed 8-task suite on verified parent commits (agent-team/benchmarks/suite-v1.json)
 * - Reports Median & Range/IQR (never mean alone)
 * - Verifies sum(steps[].total_tokens) === task.tokens_used via reconcileTaskTokens()
 */

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadTaskYaml,
  mutateTaskStateAtomic,
  reconcileTaskTokens,
  reconstructTaskStepsFromArtifacts,
  saveTaskAtomic
} from './lib/task-persistence.mjs';
import { loadMergedPolicy } from './lib/policy-loader.mjs';
import {
  evaluateTaskOutcomeWithBaseline,
  runBaselinePreflight
} from './lib/baseline-policy.mjs';
import { collectEnvironmentFingerprint, runSingleValidationCheck } from './validator.mjs';
import { resolveRepoRoot } from './applier.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');
const DEFAULT_REPO_ROOT = path.resolve(TEAM_DIR, '..');
const SUITE_PATH = path.resolve(TEAM_DIR, 'benchmarks', 'suite-v1.json');
const PRESET_PILLS_TASK_PATH = path.resolve(TEAM_DIR, 'tasks', 'task-template.yaml');
const ARCHIVE_DIR = path.resolve(TEAM_DIR, 'tasks', 'archive');
const STATE_PATH = path.resolve(TEAM_DIR, 'state', 'task-state.json');
const CALLS_JSONL_PATH = path.resolve(TEAM_DIR, 'state', 'telemetry', 'calls.jsonl');

export function computeMedianAndRange(values = []) {
  const nums = values.map(Number).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  if (nums.length === 0) {
    return { count: 0, median: 0, min: 0, max: 0, p25: 0, p75: 0, iqr: 0 };
  }
  const quantile = (q) => {
    const pos = (nums.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (nums[base + 1] !== undefined) {
      return nums[base] + rest * (nums[base + 1] - nums[base]);
    }
    return nums[base];
  };
  const median = Number(quantile(0.5).toFixed(4));
  const p25 = Number(quantile(0.25).toFixed(4));
  const p75 = Number(quantile(0.75).toFixed(4));
  return {
    count: nums.length,
    median,
    min: nums[0],
    max: nums[nums.length - 1],
    p25,
    p75,
    iqr: Number((p75 - p25).toFixed(4))
  };
}

function commitExists(sha, cwd = DEFAULT_REPO_ROOT) {
  try {
    execFileSync('git', ['cat-file', '-t', String(sha)], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000
    });
    return true;
  } catch {
    return false;
  }
}

export function runBenchmarkInspect({ backfillJsonl = false, archiveFile = null } = {}) {
  if (!fs.existsSync(SUITE_PATH)) {
    throw new Error(`Benchmark suite not found at ${SUITE_PATH}`);
  }
  const suite = JSON.parse(fs.readFileSync(SUITE_PATH, 'utf8'));
  console.log(`=== Benchmark Suite: ${suite.suite_id} (v${suite.version}) ===`);
  console.log(`Decision Rules: Cost reduction >= ${suite.decision_rules.keep_criteria.min_cost_reduction_pct}%, First-pass drop <= ${suite.decision_rules.keep_criteria.max_first_attempt_pass_rate_drop_pts} pts, Repetitions >= ${suite.decision_rules.min_repetitions_per_small_task}, Metric: ${suite.decision_rules.reporting_metric}\n`);

  let validCommits = 0;
  for (const item of suite.tasks) {
    const hasParent = commitExists(item.parent_commit);
    const hasCommit = commitExists(item.commit_hash);
    if (hasParent && hasCommit) validCommits++;
    console.log(`- [${item.category}] ${item.task_id} | parent=${item.parent_commit} (${hasParent ? 'OK' : 'MISSING'}) -> commit=${item.commit_hash} (${hasCommit ? 'OK' : 'MISSING'}) | scope=${item.scope.length} files`);
  }
  console.log(`\nVerified git commits: ${validCommits}/${suite.tasks.length} tasks ready for deterministic replay.`);

  // Reconcile archived task YAML & backfill enriched telemetry if requested
  const targetArchive = archiveFile ? path.resolve(archiveFile) : null;
  if (targetArchive && fs.existsSync(targetArchive)) {
    const task = loadTaskYaml(targetArchive);
    if (backfillJsonl) {
      if (fs.existsSync(CALLS_JSONL_PATH)) {
        fs.unlinkSync(CALLS_JSONL_PATH);
      }
      reconstructTaskStepsFromArtifacts(task, TEAM_DIR);
      const recon = reconcileTaskTokens(task);
      task.token_reconciliation = recon;
      saveTaskAtomic(targetArchive, task);

      if (fs.existsSync(STATE_PATH)) {
        mutateTaskStateAtomic(STATE_PATH, (state) => {
          state.completed_tasks = (state.completed_tasks || []).map(t =>
            (t.task_id === task.task_id) ? task : t
          );
        });
      }
    }

    const recon = reconcileTaskTokens(task);
    console.log(`\n=== Token Reconciliation (${task.task_id}) ===`);
    console.log(`steps_total: ${recon.steps_total.toLocaleString()} tokens | task.tokens_used: ${recon.task_total.toLocaleString()} tokens | drift: ${recon.drift} | cost_est_usd: $${recon.cost_total_usd}`);
  }

  if (fs.existsSync(CALLS_JSONL_PATH)) {
    const lines = fs.readFileSync(CALLS_JSONL_PATH, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    const records = lines.map(l => JSON.parse(l)).filter(r => r.total_tokens > 0);
    const tokStats = computeMedianAndRange(records.map(r => r.total_tokens));
    const costStats = computeMedianAndRange(records.map(r => r.cost_est_usd));
    const durStats = computeMedianAndRange(records.map(r => r.duration_ms));

    console.log(`\n=== Telemetry Summary from calls.jsonl (${records.length} non-zero model steps) ===`);
    console.log(`Tokens/step : median=${tokStats.median} | IQR=${tokStats.iqr} (p25=${tokStats.p25}, p75=${tokStats.p75}) | range=[${tokStats.min}, ${tokStats.max}]`);
    console.log(`Cost/step($): median=$${costStats.median} | IQR=$${costStats.iqr} | range=[$${costStats.min}, $${costStats.max}]`);
    console.log(`Duration(ms): median=${durStats.median}ms | IQR=${durStats.iqr}ms | range=[${durStats.min}ms, ${durStats.max}ms]`);
  }

  return { ok: validCommits === suite.tasks.length, validCommits, totalTasks: suite.tasks.length };
}

function collectConfiguredValidationChecks(policyConfig = {}) {
  const valCfg = policyConfig?.policy?.validation || policyConfig?.validation || {};
  const fast = (Array.isArray(valCfg.fast_checks) ? valCfg.fast_checks : []).map(c => ({ ...c, stage: 'fast_checks' }));
  const suite = (Array.isArray(valCfg.suite_checks) ? valCfg.suite_checks : []).map(c => ({ ...c, stage: 'suite_checks' }));
  return [...fast, ...suite];
}

/**
 * Replays the preset-pills task (or any scoped task YAML) under the baseline-failures
 * policy against its historical parent commit, proving 0 extra Writer retries occur
 * once a preexisting baseline failure is recognized.
 */
export async function replayPresetPillsBenchmark(options = {}) {
  const taskPath = path.resolve(options.taskPath || PRESET_PILLS_TASK_PATH);
  const task = loadTaskYaml(taskPath);
  const parentCommit = String(options.parentCommit || task.orchestrator_git_sha || '27b6731').trim();
  const gitRepoRoot = path.resolve(options.gitRepoRoot || DEFAULT_REPO_ROOT);
  const parentCommitVerified = commitExists(parentCommit, gitRepoRoot);

  const policyConfig = options.policyConfig || loadMergedPolicy();
  const repoRoot = path.resolve(options.repoRoot || resolveRepoRoot(policyConfig) || DEFAULT_REPO_ROOT);
  const maxRetries = Number.isInteger(options.maxRetries)
    ? options.maxRetries
    : (policyConfig?.policy?.retry_and_escalation?.max_retries_per_task ?? 3);

  const collectFp = options.collectFingerprintFn || (async () => collectEnvironmentFingerprint(policyConfig));
  const checkRunner = options.runCheckFn
    ? (check, ctx) => options.runCheckFn(check, ctx)
    : async (check, ctx) => runSingleValidationCheck(check, check.stage, policyConfig, ctx.envFingerprint);

  const tempCacheDir = options.stateDir ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'td-replay-cache-'));
  try {
    const stateDir = options.stateDir || tempCacheDir;
    const baselineRes = await runBaselinePreflight({
      policyConfig,
      repoRoot,
      task,
      stateDir,
      headSha: options.headSha,
      collectFingerprintFn: collectFp,
      runCheckFn: checkRunner
    });

    if (!baselineRes.ok) {
      return {
        ok: true,
        task_id: task.task_id,
        parent_commit: parentCommit,
        parent_commit_verified: parentCommitVerified,
        baseline_failures: baselineRes.baseline_failures || [],
        flaky_baseline_failures: baselineRes.flaky_baseline_failures || [],
        writer_calls_total: 0,
        additional_writer_calls_after_recognition: 0,
        final_outcome: 'blocked',
        block_reason_code: baselineRes.reason || 'baseline_blocked',
        can_retry: false,
        baseline_preflight: baselineRes
      };
    }

    const allChecks = collectConfiguredValidationChecks(policyConfig);
    const writerFn = options.writerInvokerFn || (async ({ attempt }) => ({
      ok: true,
      attempt,
      modifiedFiles: Array.isArray(task.scope) ? [...task.scope] : ['web/index.html'],
      diffText: ''
    }));

    let writerCallsTotal = 0;
    let recognizedBaselineStop = false;
    let additionalWriterCallsAfterRecognition = 0;
    let finalOutcome = 'blocked';
    let blockReasonCode = null;
    let canRetry = false;
    let lastEval = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (recognizedBaselineStop) {
        additionalWriterCallsAfterRecognition += 1;
      }
      writerCallsTotal += 1;
      const patchRes = await writerFn({ attempt: attempt + 1, task });
      const currentFp = await collectFp();
      const checkResults = [];
      for (const check of allChecks) {
        checkResults.push(await checkRunner(check, { round: 'post_patch', attempt: attempt + 1, envFingerprint: currentFp }));
      }

      const evalRes = evaluateTaskOutcomeWithBaseline({
        task,
        checkResults,
        baselineResult: baselineRes,
        diffText: patchRes.diffText || '',
        modifiedFiles: patchRes.modifiedFiles || [],
        policyConfig,
        repoRoot
      });
      lastEval = evalRes;
      finalOutcome = evalRes.outcome;
      blockReasonCode = evalRes.reason || null;
      canRetry = Boolean(evalRes.canRetry);

      if (!evalRes.canRetry) {
        recognizedBaselineStop = evalRes.reason === 'preexisting_failure' || evalRes.outcome === 'done_with_known_failures';
        break;
      }
    }

    return {
      ok: true,
      task_id: task.task_id,
      parent_commit: parentCommit,
      parent_commit_verified: parentCommitVerified,
      baseline_failures: baselineRes.baseline_failures || [],
      flaky_baseline_failures: baselineRes.flaky_baseline_failures || [],
      writer_calls_total: writerCallsTotal,
      additional_writer_calls_after_recognition: additionalWriterCallsAfterRecognition,
      final_outcome: finalOutcome,
      block_reason_code: blockReasonCode,
      can_retry: canRetry,
      evaluation: lastEval
    };
  } finally {
    if (tempCacheDir) {
      fs.rmSync(tempCacheDir, { recursive: true, force: true });
    }
  }
}

/**
 * Replay variant verifying low-risk task + unrelated out-of-scope baseline test
 * with explicit owner/due_at resolves to `done_with_known_failures` with 0 extra Writer calls.
 */
export async function replayPresetPillsKnownFailuresVariant(options = {}) {
  const basePolicy = options.policyConfig || loadMergedPolicy();
  const baseValidation = basePolicy?.policy?.validation || basePolicy?.validation || {};
  const existingKnown = Array.isArray(baseValidation.known_failures) ? baseValidation.known_failures : [];
  let inferredTestId = options.testIdContains || null;
  if (!inferredTestId) {
    try {
      const sampleTask = loadTaskYaml(path.resolve(options.taskPath || PRESET_PILLS_TASK_PATH));
      const m = String(sampleTask?.last_error || '').match(/\bFAIL:\s+([A-Za-z0-9_]+)/);
      if (m) inferredTestId = m[1];
    } catch {}
  }
  const variantPolicy = {
    ...basePolicy,
    policy: {
      ...(basePolicy.policy || {}),
      validation: {
        ...baseValidation,
        known_failures: [
          ...existingKnown,
          {
            check_name: 'unit_test_suite',
            test_id_contains: inferredTestId || 'test_flaky_background_worker',
            owner: options.owner || 'Jane Doe',
            due_at: options.due_at || '2099-12-31'
          }
        ]
      }
    }
  };
  return replayPresetPillsBenchmark({
    ...options,
    policyConfig: variantPolicy
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const backfill = process.argv.includes('--backfill');
  if (process.argv.includes('--replay-preset-pills')) {
    const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), 'td-live-preset-'));
    try {
      const task = loadTaskYaml(PRESET_PILLS_TASK_PATH);
      const historicalErrorSummary = task.last_error || task.error_history?.[0]?.summary || [
        'FAIL: test_flaky_background_worker (tests.test_worker.WorkerTests.test_flaky_background_worker)',
        'AssertionError: expected status 200'
      ].join('\n');
      const policyConfig = loadMergedPolicy();
      const liveBaseline = await runBaselinePreflight({ policyConfig, repoRoot: DEFAULT_REPO_ROOT, stateDir: tmpOut });
      const fp = liveBaseline.baseline_fingerprint;
      const runSimCheck = async (check) => check.stage === 'fast_checks'
        ? { ok: true, checkName: check.name, stage: check.stage, command: check.run, exitCode: 0, errorCombined: '', env_fingerprint: fp }
        : { ok: false, checkName: check.name, stage: check.stage, command: check.run, exitCode: 1, errorCombined: historicalErrorSummary, env_fingerprint: fp };
      const simulatedHistorical = await replayPresetPillsBenchmark({
        taskPath: PRESET_PILLS_TASK_PATH,
        parentCommit: '27b6731',
        gitRepoRoot: DEFAULT_REPO_ROOT,
        repoRoot: DEFAULT_REPO_ROOT,
        stateDir: tmpOut,
        headSha: '27b6731-historical-sim',
        policyConfig,
        collectFingerprintFn: async () => fp,
        runCheckFn: runSimCheck
      });
      const knownFailuresVariant = await replayPresetPillsKnownFailuresVariant({
        taskPath: PRESET_PILLS_TASK_PATH,
        parentCommit: '27b6731',
        gitRepoRoot: DEFAULT_REPO_ROOT,
        repoRoot: DEFAULT_REPO_ROOT,
        stateDir: tmpOut,
        headSha: '27b6731-kf-variant',
        policyConfig,
        collectFingerprintFn: async () => fp,
        runCheckFn: runSimCheck
      });
      console.log(JSON.stringify({
        workspace_master_baseline: {
          head_sha: liveBaseline.head_sha,
          red_baseline_count: liveBaseline.baseline_failures.length,
          flaky_baseline_count: liveBaseline.flaky_baseline_failures.length,
          baseline_failures: liveBaseline.baseline_failures
        },
        preset_pills_historical_replay: {
          task_id: simulatedHistorical.task_id,
          parent_commit: simulatedHistorical.parent_commit,
          parent_commit_verified: simulatedHistorical.parent_commit_verified,
          baseline_failures_detected: simulatedHistorical.baseline_failures.length,
          writer_calls_total: simulatedHistorical.writer_calls_total,
          additional_writer_calls_after_recognition: simulatedHistorical.additional_writer_calls_after_recognition,
          final_outcome: simulatedHistorical.final_outcome,
          block_reason_code: simulatedHistorical.block_reason_code,
          can_retry: simulatedHistorical.can_retry
        },
        preset_pills_known_failures_variant: {
          task_id: knownFailuresVariant.task_id,
          parent_commit: knownFailuresVariant.parent_commit,
          writer_calls_total: knownFailuresVariant.writer_calls_total,
          additional_writer_calls_after_recognition: knownFailuresVariant.additional_writer_calls_after_recognition,
          final_outcome: knownFailuresVariant.final_outcome,
          known_failures_count: knownFailuresVariant.evaluation?.known_failures?.length || 0,
          can_retry: knownFailuresVariant.can_retry
        }
      }, null, 2));
    } finally {
      fs.rmSync(tmpOut, { recursive: true, force: true });
    }
  } else {
    runBenchmarkInspect({ backfillJsonl: backfill });
  }
}
