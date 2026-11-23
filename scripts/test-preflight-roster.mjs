import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadMergedPolicy, loadMergedTeamConfig, resolveConfigDir } from './lib/policy-loader.mjs';
import * as client9Router from './lib/client-9router.mjs';
import { recordTaskStep } from './lib/task-persistence.mjs';
import { resolveWriterSelection } from './lib/risk-policy.mjs';
const { collectActiveRosterModels, runRosterPreflightPing } = client9Router;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');

async function runTests() {
  // 1. Verify kr/claude-sonnet-4.5-thinking is marked disabled / excluded from active roster in team.yaml
  const mergedTeam = loadMergedTeamConfig({ configDir: resolveConfigDir() });
  const activeModels = collectActiveRosterModels(mergedTeam);
  const activeIds = activeModels.map(m => m.model);
  assert.ok(activeIds.length > 0, 'Active roster must contain at least one enabled model');
  assert.ok(
    !activeIds.includes('kr/claude-sonnet-4.5-thinking'),
    `kr/claude-sonnet-4.5-thinking (HTTP 400) must be removed/disabled from active roster, got: ${activeIds.join(', ')}`
  );

  // 2. Ping sends max_tokens=1 per unique model in roster and fails loudly without silent fallback
  const pingRequests = [];
  const fakeTeam = {
    providers: { local_9router: { base_url: 'http://127.0.0.1:20128/v1', default_key: 'sk-mock' } },
    roles: {
      router: {
        enabled: true,
        model: 'ag/claude-sonnet-5-5',
        disabled_models: [{ id: 'kr/claude-sonnet-4.5-thinking', disabled: true }]
      },
      writer: {
        enabled: true,
        model: 'Deepseek V4.1 Flash/deepseek-ai/deepseek-v4.1-flash-1017',
        fallback_model: 'ag/gemini-3.8-flash-medium'
      },
      broken: {
        enabled: true,
        model: 'kr/claude-sonnet-4.5-thinking',
        fallback_model: 'ag/claude-sonnet-5-5'
      }
    }
  };

  const failFetch = async (_url, init = {}) => {
    const req = JSON.parse(String(init.body));
    pingRequests.push(req);
    if (req.model === 'kr/claude-sonnet-4.5-thinking') {
      return new Response(JSON.stringify({ error: { message: 'This version of Kiro is no longer supported' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({
      id: 'ping-ok',
      model: req.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  const failRes = await runRosterPreflightPing(fakeTeam, {}, { fetchFn: failFetch });
  assert.equal(failRes.ok, false, 'Preflight must fail loudly when any active roster model returns HTTP 400');
  assert.equal(failRes.failed_models.length, 1);
  assert.equal(failRes.failed_models[0].model, 'kr/claude-sonnet-4.5-thinking');
  assert.ok(failRes.errors[0].includes('kr/claude-sonnet-4.5-thinking'), 'Error must name failing model clearly');
  assert.ok(failRes.errors[0].includes('400'), 'Error must include HTTP 400 cause');
  assert.ok(
    pingRequests.every(r => r.max_tokens === 1),
    `Every preflight ping must use max_tokens=1, got ${JSON.stringify(pingRequests.map(r => r.max_tokens))}`
  );
  // Ensure broken role did NOT silently fallback to ag/claude-sonnet-5-5 twice (only once from router role)
  const sonnetPings = pingRequests.filter(r => r.model === 'ag/claude-sonnet-5-5');
  assert.equal(sonnetPings.length, 1, 'Broken model must never trigger a silent fallback ping');

  // 3. All active models healthy -> preflight passes
  delete fakeTeam.roles.broken;
  pingRequests.length = 0;
  const okRes = await runRosterPreflightPing(fakeTeam, {}, { fetchFn: failFetch });
  assert.equal(okRes.ok, true, `Expected healthy preflight to pass, got: ${JSON.stringify(okRes)}`);
  assert.equal(okRes.checked_models.length, 3);
  assert.equal(pingRequests.length, 3);

  // 4. Verify orchestrator.mjs wires runRosterPreflightPing & logs primary error details on writer fallback
  const orchSrc = fs.readFileSync(path.resolve(TEAM_DIR, 'scripts', 'orchestrator.mjs'), 'utf8');
  assert.ok(orchSrc.includes('runRosterPreflightPing'), 'orchestrator.mjs must invoke runRosterPreflightPing in preflight');
  assert.equal(
    typeof client9Router.formatWriterPreflightFallbackWarning,
    'function',
    'client-9router.mjs must export formatWriterPreflightFallbackWarning'
  );
  const sampleRosterPreflight = {
    ok: false,
    failed_models: [{ model: 'mock/writer-primary', roles: ['writer'], status: 402, latency_ms: 312, error: 'Insufficient credits' }],
    errors: ['Preflight model ping failed for "mock/writer-primary" (roles: writer): 9Router returned HTTP 402: Insufficient credits']
  };
  const warnText = client9Router.formatWriterPreflightFallbackWarning(sampleRosterPreflight, {
    ok: true,
    selected_by: 'fallback',
    actual_model: 'mock/writer-fallback',
    reason: 'preflight_failed'
  });
  assert.ok(warnText.includes('mock/writer-fallback'), 'Warning must include fallback model');
  assert.ok(warnText.includes('mock/writer-primary'), 'Warning must include failing primary writer model');
  assert.ok(warnText.includes('HTTP 402') && warnText.includes('Insufficient credits'), 'Warning must include exact status/error details');
  assert.ok(
    orchSrc.includes('formatWriterPreflightFallbackWarning') || orchSrc.includes('rosterPreflight.errors'),
    'orchestrator.mjs must emit rosterPreflight error details when promoting writer fallback'
  );

  // 5. Transient preflight failure (HTTP 503 on attempt 1 -> 200 OK on attempt 2) keeps primary writer
  const transientCounts = new Map();
  const transientTeam = {
    providers: { local_9router: { base_url: 'http://127.0.0.1:20128/v1', default_key: 'sk-mock' } },
    roles: {
      writer: {
        enabled: true,
        models: ['mock/writer-primary', 'mock/writer-fallback']
      }
    }
  };
  const transient503Fetch = async (_url, init = {}) => {
    const req = JSON.parse(String(init.body));
    const count = (transientCounts.get(req.model) || 0) + 1;
    transientCounts.set(req.model, count);
    if (req.model === 'mock/writer-primary' && count === 1) {
      return new Response(JSON.stringify({ error: { message: 'Service temporarily unavailable' } }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({
      id: `ping-${count}`,
      model: req.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const retryPassRes = await runRosterPreflightPing(transientTeam, {}, {
    fetchFn: transient503Fetch,
    retryDelayMs: 1,
    calibrateBuffer: false
  });
  assert.equal(retryPassRes.ok, true, 'Transient 503 followed by 200 on retry must pass preflight');
  assert.equal(retryPassRes.failed_models.length, 0, 'Primary writer must not fail when retry succeeds');
  const primaryCheck = retryPassRes.checked_models.find(m => m.model === 'mock/writer-primary');
  assert.equal(primaryCheck?.preflight_attempts, 2, 'Primary writer must record preflight_attempts=2');
  assert.equal(retryPassRes.preflight_attempts, 2, 'Aggregate preflight_attempts must record 2');
  const selAfterRetry = resolveWriterSelection({}, transientTeam, {
    preflightFailedModels: new Set((retryPassRes.failed_models || []).map(f => f.model))
  });
  assert.equal(selAfterRetry.actual_model, 'mock/writer-primary', 'Primary writer must NOT be demoted when retry passes');
  assert.equal(selAfterRetry.selected_by, 'primary');

  // 6. Network/timeout rejection twice -> passes on 3rd attempt (default maxRetries=2 => 3 total attempts)
  const netCounts = new Map();
  const netTimeoutThenPassFetch = async (_url, init = {}) => {
    const req = JSON.parse(String(init.body));
    const count = (netCounts.get(req.model) || 0) + 1;
    netCounts.set(req.model, count);
    if (req.model === 'mock/writer-primary' && count <= 2) {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    }
    return new Response(JSON.stringify({
      id: `ping-net-${count}`,
      model: req.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const netRetryRes = await runRosterPreflightPing(transientTeam, {}, {
    fetchFn: netTimeoutThenPassFetch,
    retryDelayMs: 1,
    calibrateBuffer: false
  });
  assert.equal(netRetryRes.ok, true, 'Two transient timeouts followed by attempt 3 success must pass');
  assert.equal(
    netRetryRes.checked_models.find(m => m.model === 'mock/writer-primary')?.preflight_attempts,
    3,
    'Should use up to 3 total attempts (initial + 2 retries)'
  );

  // 7. Persistent 502 exhausts all 3 attempts, records preflight_attempts=3, and falls back
  const always502Counts = new Map();
  const always502Fetch = async (_url, init = {}) => {
    const req = JSON.parse(String(init.body));
    always502Counts.set(req.model, (always502Counts.get(req.model) || 0) + 1);
    if (req.model === 'mock/writer-primary') {
      return new Response(JSON.stringify({ error: { message: 'Bad Gateway' } }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({
      id: 'ping-fb-ok',
      model: req.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const exhaustRes = await runRosterPreflightPing(transientTeam, {}, {
    fetchFn: always502Fetch,
    retryDelayMs: 1,
    calibrateBuffer: false
  });
  assert.equal(exhaustRes.ok, false);
  assert.equal(exhaustRes.failed_models.length, 1);
  assert.equal(exhaustRes.failed_models[0].preflight_attempts, 3, 'Exhausted 502 must report 3 attempts');
  const selAfterExhaust = resolveWriterSelection({}, transientTeam, {
    preflightFailedModels: new Set(exhaustRes.failed_models.map(f => f.model))
  });
  assert.equal(selAfterExhaust.actual_model, 'mock/writer-fallback');
  assert.equal(selAfterExhaust.selected_by, 'fallback');

  // 8. Non-retryable HTTP 400 fails immediately without retries (preflight_attempts=1)
  const fail400Check = failRes.failed_models.find(f => f.model === 'kr/claude-sonnet-4.5-thinking');
  assert.equal(fail400Check?.preflight_attempts, 1, 'HTTP 400 must fail immediately with 1 attempt');

  // 9. recordTaskStep & orchestrator.mjs wire preflight_attempts into steps[]
  const fakeTask = { task_id: 'T-PREFLIGHT-TELEM', steps: [] };
  const recorded = recordTaskStep(fakeTask, {
    role: 'writer',
    action: 'apply_patch',
    requested_model: 'mock/writer-primary',
    actual_model: 'mock/writer-primary',
    preflight_attempts: 2
  }, { skipJsonl: true });
  assert.equal(recorded.preflight_attempts, 2, 'recordTaskStep must persist preflight_attempts in steps[]');
  assert.ok(orchSrc.includes('preflight_attempts'), 'orchestrator.mjs must record preflight_attempts into steps[]');

  console.log('[PASS] test-preflight-roster');
}

runTests().catch(err => {
  console.error('[FAIL] test-preflight-roster:', err);
  process.exit(1);
});
