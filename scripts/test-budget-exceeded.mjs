#!/usr/bin/env node
/**
 * TDD Suite for Batch 169 Item 1:
 *  - BudgetExceededError dedicated class (no HTTP 429, clear "local budget stop" message)
 *  - Retry / fallback paths (callModelEndpoint, call9Router, runAgent, decomposeGoal, shouldRetryFailure, retryOnRevisionConflict) NEVER retry BudgetExceededError
 *  - Local budget guards in compareRouterOneTurnVsCurrent & runSuiteV1RouterBenchmark throw BudgetExceededError instead of HTTP 429
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BudgetExceededError,
  assertBudgetBeforeCall,
  callModelEndpoint,
  estimateRequestPromptTokens,
  estimateWorstCaseRunTokens,
  isBudgetExceededError,
  shouldRetryFailure
} from '../runtime/provider-gateway.mjs';
import { runAgent } from '../runtime/index.mjs';
import { call9Router } from './lib/client-9router.mjs';
import { retryOnRevisionConflict } from './lib/state-store.mjs';
import { decomposeGoal } from './goal-planner.mjs';
import { compareRouterOneTurnVsCurrent } from './measure-router-loop.mjs';
import { runSuiteV1RouterBenchmark } from './score-router-suite.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = fs.existsSync(path.join(TEAM_DIR, '.git')) ? TEAM_DIR : path.resolve(TEAM_DIR, '..');

function writeSyntheticSuite(tmpDir) {
  const suitePath = path.join(tmpDir, 'synthetic-suite.json');
  const tasks = Array.from({ length: 6 }, (_, i) => ({
    id: `T-SYN-${i + 1}`,
    goal: `Update handler_${i + 1} in src/app.js and add tests in tests/test_app.js`,
    expected_scope: ['src/app.js', 'tests/test_app.js'],
    expected_mode: 'quick',
    expected_risk: 'low'
  }));
  fs.writeFileSync(suitePath, JSON.stringify({ suite_id: 'synthetic-v1', tasks }, null, 2), 'utf8');
  return suitePath;
}

async function testBudgetErrorPropertiesAndNoRetry() {
  const err = new BudgetExceededError('Adjusted Claude fresh tokens exceeded (60000/60000)', {
    budgetKind: 'claude_fresh_tokens',
    used: 60000,
    limit: 60000
  });
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'BudgetExceededError');
  assert.equal(err.code, 'LOCAL_BUDGET_STOP');
  assert.equal(err.nonRetryable, true);
  assert.notEqual(err.status, 429);
  assert.ok(/local budget stop/i.test(err.message), `Message must state "local budget stop", got: ${err.message}`);
  assert.equal(isBudgetExceededError(err), true);
  assert.equal(shouldRetryFailure(err), false);
  assert.equal(shouldRetryFailure({ ok: false, budget_exceeded: true, error: err.message }), false);

  // 1) callModelEndpoint MUST NOT retry with fallbackModel when BudgetExceededError is thrown
  let gwCalls = 0;
  await assert.rejects(
    async () => {
      await callModelEndpoint({
        baseUrl: 'http://127.0.0.1:20199/v1',
        apiKey: 'mock',
        model: 'ag/claude-sonnet-5-5',
        fallbackModel: 'ag/gemini-3.8-flash-medium',
        messages: [{ role: 'user', content: 'hi' }],
        fetchFn: async () => {
          gwCalls += 1;
          throw new BudgetExceededError('60k cap reached');
        }
      });
    },
    (caught) => isBudgetExceededError(caught) && /local budget stop/i.test(caught.message)
  );
  assert.equal(gwCalls, 1, `callModelEndpoint must NOT retry/fallback on BudgetExceededError (calls=${gwCalls})`);

  // 2) call9Router MUST NOT fall back to fallbackModel on BudgetExceededError
  let c9Calls = 0;
  await assert.rejects(
    async () => {
      await call9Router(
        'ag/claude-sonnet-5-5',
        'sys',
        'user',
        512,
        'ag/gemini-3.8-flash-medium',
        0.1,
        {
          fetchFn: async () => {
            c9Calls += 1;
            throw new BudgetExceededError('client budget exceeded');
          }
        }
      );
    },
    (caught) => isBudgetExceededError(caught) && /local budget stop/i.test(caught.message)
  );
  assert.equal(c9Calls, 1, `call9Router must NOT try fallback model on BudgetExceededError (calls=${c9Calls})`);

  // 3) retryOnRevisionConflict MUST NOT retry if BudgetExceededError is thrown
  let revCalls = 0;
  await assert.rejects(
    async () => {
      await retryOnRevisionConflict(async () => {
        revCalls += 1;
        throw new BudgetExceededError('nested budget stop');
      }, { maxRetries: 4, baseDelayMs: 1 });
    },
    (caught) => isBudgetExceededError(caught)
  );
  assert.equal(revCalls, 1, 'retryOnRevisionConflict must never retry BudgetExceededError');

  // 4) runAgent MUST throw BudgetExceededError immediately without synthesis turn or fallback
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-budget-err-'));
  try {
    let agentCalls = 0;
    await assert.rejects(
      async () => {
        await runAgent({
          role: 'writer',
          prompt: 'Check core/inpaint_models.py',
          scope: ['core/inpaint_models.py'],
          modelOverride: 'ag/claude-sonnet-5-5',
          maxTurns: 3,
          repoRoot: REPO_ROOT,
          sessionsDir: path.join(tmpDir, 's1'),
          baseUrlOverride: 'http://127.0.0.1:20199/v1',
          apiKeyOverride: 'mock',
          fetchFn: async () => {
            agentCalls += 1;
            throw new BudgetExceededError('runAgent loop cap reached');
          }
        });
      },
      (caught) => isBudgetExceededError(caught) && /local budget stop/i.test(caught.message)
    );
    assert.equal(agentCalls, 1, `runAgent must stop after 1 attempt without synthesis turn (calls=${agentCalls})`);

    // 5) decomposeGoal MUST NOT invoke recovery_zero_tools or 5-turn fallback on BudgetExceededError
    let plannerCalls = 0;
    const decRes = await decomposeGoal('Dọn dẹp #eraser-presets trong ui_web/index.html', {
      dryRun: true,
      repoRoot: REPO_ROOT,
      sessionsDir: path.join(tmpDir, 's2'),
      baseUrlOverride: 'http://127.0.0.1:20199/v1',
      apiKeyOverride: 'mock',
      fetchFn: async () => {
        plannerCalls += 1;
        throw new BudgetExceededError('planner cap');
      }
    });
    assert.equal(decRes.ok, false);
    assert.equal(decRes.budget_exceeded, true);
    assert.equal(decRes.nonRetryable, true);
    assert.equal(decRes.error_type, 'BudgetExceededError');
    assert.ok(/local budget stop/i.test(decRes.error), `decomposeGoal error must state "local budget stop", got: ${decRes.error}`);
    assert.equal(plannerCalls, 1, `decomposeGoal must NOT retry with recovery/fallback (calls=${plannerCalls})`);

    // 6) Harness budget guards MUST emit "local budget stop" cleanly without any HTTP 429
    const cmpStop = await compareRouterOneTurnVsCurrent({
      repoRoot: REPO_ROOT,
      sessionsDir: path.join(tmpDir, 'cmp'),
      startingFreshTokens: 60000,
      maxFreshClaudeTokens: 60000,
      fetchFn: async () => {
        throw new Error('fetch must not be called once budget is exhausted');
      }
    });
    assert.equal(cmpStop.budget.stopped_early, true);
    assert.ok(/local budget stop/i.test(cmpStop.budget.stop_reason));
    const failedRun = cmpStop.goals[0].one_turn;
    assert.equal(failedRun.ok, false);
    assert.ok(!String(failedRun.error).includes('429'), `Error must not emit fake HTTP 429: ${failedRun.error}`);

    const suitePath = writeSyntheticSuite(tmpDir);
    const suiteStop = await runSuiteV1RouterBenchmark({
      repoRoot: REPO_ROOT,
      suitePath,
      sessionsDir: path.join(tmpDir, 'suite'),
      limit: 1,
      repetitions: 1,
      startingFreshTokens: 60000,
      maxFreshClaudeTokens: 60000,
      fetchFn: async () => {
        throw new Error('fetch must not be called once budget is exhausted');
      }
    });
    assert.equal(suiteStop.budget.stopped_early, true);
    assert.ok(/local budget stop/i.test(suiteStop.budget.stop_reason));
    assert.ok(!String(suiteStop.goals[0].one_turn_reps[0].error).includes('429'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('[OK] BudgetExceededError non-retryable & "local budget stop" checks passed');
}

async function testStrictPreCall60kGuardAndWorstCasePlan() {
  // 1) Pre-call formula: used + est_prompt + max_output <= limit
  assertBudgetBeforeCall({ used: 38000, estimatedPrompt: 5500, maxOutput: 16384, limit: 60000 });
  assert.throws(
    () => assertBudgetBeforeCall({ used: 40000, estimatedPrompt: 5500, maxOutput: 16384, limit: 60000 }),
    (err) => isBudgetExceededError(err) && /local budget stop/i.test(err.message) && /40000/.test(err.message)
  );

  // 2) callModelEndpoint checks used + estPrompt + maxOutput BEFORE hitting network
  let networkHit = 0;
  await assert.rejects(
    async () => {
      await callModelEndpoint({
        baseUrl: 'http://127.0.0.1:20199/v1',
        apiKey: 'mock',
        model: 'ag/claude-sonnet-5-5',
        maxTokens: 16384,
        messages: [{ role: 'user', content: 'A'.repeat(21000) }], // ~6000 est tokens
        budgetState: { used: 40000, limit: 60000, kind: 'claude_fresh_tokens' },
        fetchFn: async () => {
          networkHit += 1;
          return new Response('{}', { status: 200 });
        }
      });
    },
    (err) => isBudgetExceededError(err) && /local budget stop/i.test(err.message)
  );
  assert.equal(networkHit, 0, 'Must throw BudgetExceededError BEFORE sending when used + estPrompt + max_output > limit');

  // 3) Worst-case 60k ceiling test across repeated multi-turn calls: NEVER exceeds 60,000 even if worst-case response consumed
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-60k-hard-cap-'));
  try {
    let sentCalls = 0;
    const suitePath = writeSyntheticSuite(tmpDir);
    const suiteRes = await runSuiteV1RouterBenchmark({
      repoRoot: REPO_ROOT,
      suitePath,
      sessionsDir: path.join(tmpDir, 's'),
      modelOverride: 'ag/claude-sonnet-5-5',
      limit: 6,
      repetitions: 1,
      maxFreshClaudeTokens: 60000,
      nineRouterVersion: '0.5.119',
      baseUrlOverride: 'http://127.0.0.1:20199/v1',
      apiKeyOverride: 'mock',
      fetchFn: async (_url, init = {}) => {
        sentCalls += 1;
        const p = JSON.parse(String(init.body || '{}'));
        const estP = estimateRequestPromptTokens(p);
        // Worst case: ZERO cache hit and provider charges full estP + 2000 9router buffer
        return new Response(
          `data: ${JSON.stringify({ id: 'w1', object: 'chat.completion.chunk', model: p.model, choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify({ tasks: [{ title: 't', goal: 'g', kind: 'feature', mode: 'quick', risk_level: 'low', scope: ['ui_web/index.html'], acceptance_criteria: ['a', 'b'] }] }) }, finish_reason: null }] })}\n\n` +
          `data: ${JSON.stringify({ id: 'w1', object: 'chat.completion.chunk', model: p.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: estP + 2000, completion_tokens: 1800, total_tokens: estP + 3800 } })}\n\n` +
          `data: [DONE]\n\n`,
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
        );
      }
    });

    assert.ok(sentCalls >= 1);
    assert.ok(
      suiteRes.budget.cumulative_fresh_tokens <= 60000,
      `Strict pre-call guard MUST NEVER let 60k ceiling be exceeded, got ${suiteRes.budget.cumulative_fresh_tokens}`
    );
    assert.equal(suiteRes.budget.stopped_early, true, 'Must stop before dispatching call that could exceed 60k');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // 4) Worst-case experiment estimator accounts for fallback turns + max_output
  const estNoFallback = estimateWorstCaseRunTokens({ estimatedPrompt: 6000, maxOutput: 2048, fallbackPossible: false });
  const estWithFallback = estimateWorstCaseRunTokens({ estimatedPrompt: 6000, maxOutput: 2048, fallbackPossible: true, fallbackMaxTurns: 5 });
  assert.ok(estWithFallback > estNoFallback * 3, 'Worst-case estimate with fallback must include multi-turn fallback runway');

  console.log('[OK] Strict pre-call (used + estPrompt + max_output <= limit) 60k guard passed');
}

testBudgetErrorPropertiesAndNoRetry()
  .then(() => testStrictPreCall60kGuardAndWorstCasePlan())
  .catch(err => {
    console.error('[FAIL]', err);
    process.exit(1);
  });
