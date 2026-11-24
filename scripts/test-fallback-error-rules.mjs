import assert from 'node:assert/strict';

import {
  BudgetExceededError,
  callModelEndpoint,
  getCircuitBrokenReason,
  isModelCircuitBroken,
  resetCircuitBreaker
} from '../runtime/provider-gateway.mjs';
import { runAgent } from '../runtime/index.mjs';
import { call9Router } from './lib/client-9router.mjs';
import * as riskPolicy from './lib/risk-policy.mjs';

function okJsonResponse(model, content = 'OK') {
  return new Response(
    JSON.stringify({
      id: 'resp-ok',
      model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

async function runTests() {
  resetCircuitBreaker();

  // 1. BudgetExceededError must NEVER trigger writer fallback
  {
    const calledModels = [];
    const fetchSpy = async (_url, init) => {
      const body = JSON.parse(String(init.body));
      calledModels.push(body.model);
      return okJsonResponse(body.model);
    };

    // 1a. Pre-call budget guard throws BudgetExceededError with 0 network calls (no fallback)
    await assert.rejects(
      () => callModelEndpoint({
        baseUrl: 'http://127.0.0.1:20128/v1',
        apiKey: 'sk-test',
        model: 'writer-primary',
        fallbackModel: 'writer-fallback',
        messages: [{ role: 'user', content: 'Implement feature X' }],
        maxTokens: 1000,
        budgetState: { used: 9500, limit: 10000, kind: 'task_budget' },
        fetchFn: fetchSpy
      }),
      (err) => err instanceof BudgetExceededError && /local budget stop/i.test(err.message)
    );
    assert.deepEqual(calledModels, [], 'BudgetExceededError pre-call must never hit primary or fallback');

    // 1b. Fetch throwing BudgetExceededError rethrows cleanly without calling fallbackModel
    await assert.rejects(
      () => callModelEndpoint({
        baseUrl: 'http://127.0.0.1:20128/v1',
        apiKey: 'sk-test',
        model: 'writer-primary',
        fallbackModel: 'writer-fallback',
        messages: [{ role: 'user', content: 'Implement feature X' }],
        fetchFn: async (_url, init) => {
          const body = JSON.parse(String(init.body));
          calledModels.push(body.model);
          throw new BudgetExceededError('provider stream cap');
        }
      }),
      (err) => err instanceof BudgetExceededError
    );
    assert.deepEqual(calledModels, ['writer-primary'], 'Thrown BudgetExceededError must never try fallbackModel');

    // 1c. runAgent Pre-Call Token Brake sets budget_exceeded without fallback
    let runFetchHits = 0;
    const brakeRes = await runAgent({
      role: 'writer',
      modelOverride: 'writer-primary',
      fallbackModel: 'writer-fallback',
      prompt: 'Edit file: ' + 'A'.repeat(2400),
      maxTokenBudget: 50,
      disableTools: true,
      fetchFn: async () => {
        runFetchHits++;
        return okJsonResponse('writer-fallback');
      }
    });
    assert.equal(brakeRes.ok, false);
    assert.equal(brakeRes.budget_exceeded, true);
    assert.equal(brakeRes.fallback_activated, false);
    assert.equal(runFetchHits, 0, 'runAgent pre-call token brake must not hit fallback or network');

    // 1d. resolveRuntimeWriterFallback refuses fallback on BudgetExceededError / budget_exceeded / budget stage
    const teamCfg = {
      roles: {
        writer: {
          enabled: true,
          models: ['writer-primary', 'writer-fallback']
        },
        reviewer: { enabled: true, models: ['reviewer-model'] }
      }
    };
    const selection = {
      ok: true,
      selected_by: 'primary',
      requested_model: 'writer-primary',
      actual_model: 'writer-primary',
      fallback_models: ['writer-fallback'],
      reason: 'primary_default'
    };

    const fbErrObj = riskPolicy.resolveRuntimeWriterFallback({
      selection,
      failureStage: 'provider',
      providerError: new BudgetExceededError('limit reached'),
      teamConfig: teamCfg
    });
    assert.equal(fbErrObj.ok, false, 'resolveRuntimeWriterFallback must reject BudgetExceededError');
    assert.match(fbErrObj.reason, /budget/i);

    const fbBudgetStr = riskPolicy.resolveRuntimeWriterFallback({
      selection,
      failureStage: 'provider',
      providerError: 'local budget stop: used + est + max > 100000',
      teamConfig: teamCfg
    });
    assert.equal(fbBudgetStr.ok, false, 'resolveRuntimeWriterFallback must reject local budget stop string');

    const fbBudgetStage = riskPolicy.resolveRuntimeWriterFallback({
      selection,
      failureStage: 'budget',
      providerError: 'Exceeded task token budget',
      teamConfig: teamCfg
    });
    assert.equal(fbBudgetStage.ok, false, 'resolveRuntimeWriterFallback must reject failureStage=budget');
  }

  // 2. HTTP 400 "model no longer supported" trips session-wide circuit breaker & disables model for session
  {
    resetCircuitBreaker();
    const kiroModel = 'kr/claude-sonnet-4.5-thinking';
    const healthyFallback = 'ag/gemini-3.8-flash-medium';
    const seenCalls = [];

    const kiro400Fetch = async (_url, init) => {
      const body = JSON.parse(String(init.body));
      seenCalls.push(body.model);
      if (body.model === kiroModel) {
        return new Response(
          JSON.stringify({ error: { message: 'This version of Kiro is no longer supported' } }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return okJsonResponse(body.model, 'PATCH OK');
    };

    // Call 1: hits HTTP 400 unsupported -> falls back to healthyFallback AND trips circuit breaker
    const res1 = await callModelEndpoint({
      baseUrl: 'http://127.0.0.1:20128/v1',
      apiKey: 'sk-test',
      model: kiroModel,
      fallbackModel: healthyFallback,
      messages: [{ role: 'user', content: 'Fix bug' }],
      fetchFn: kiro400Fetch
    });
    assert.equal(res1.ok, true, `Call 1 should succeed via fallback, got: ${JSON.stringify(res1)}`);
    assert.equal(res1.requested_model, kiroModel);
    assert.equal(res1.actual_model, healthyFallback);
    assert.equal(res1.fallback_activated, true);
    assert.deepEqual(seenCalls, [kiroModel, healthyFallback]);
    assert.equal(isModelCircuitBroken(kiroModel), true, 'HTTP 400 unsupported model must trip session circuit breaker');
    assert.match(String(getCircuitBrokenReason(kiroModel) || ''), /400|no longer supported/i);

    // Call 2: in the same session, primary kiroModel must NOT be called over the network
    seenCalls.length = 0;
    const res2 = await callModelEndpoint({
      baseUrl: 'http://127.0.0.1:20128/v1',
      apiKey: 'sk-test',
      model: kiroModel,
      fallbackModel: healthyFallback,
      messages: [{ role: 'user', content: 'Next step' }],
      fetchFn: kiro400Fetch
    });
    assert.equal(res2.ok, true);
    assert.equal(res2.fallback_activated, true);
    assert.match(String(res2.fallback_reason || ''), /^circuit_breaker:/);
    assert.deepEqual(seenCalls, [healthyFallback], 'Circuit-broken model must be skipped completely for rest of session');

    // Call 3: direct call without fallbackModel also short-circuits with 0 network calls
    seenCalls.length = 0;
    const res3 = await callModelEndpoint({
      baseUrl: 'http://127.0.0.1:20128/v1',
      apiKey: 'sk-test',
      model: kiroModel,
      fallbackModel: null,
      messages: [{ role: 'user', content: 'Direct dead call' }],
      fetchFn: kiro400Fetch
    });
    assert.equal(res3.ok, false);
    assert.equal(res3.circuit_broken, true);
    assert.notEqual(res3.nonRetryable, true, 'circuit_broken without fallback must not set nonRetryable (breaks call9Router loop)');
    assert.deepEqual(seenCalls, [], 'Direct call to session-disabled model must make 0 network requests');

    // Call 4: resolveWriterSelection with isModelCircuitBroken skips kiroModel automatically
    const selAfter400 = riskPolicy.resolveWriterSelection(
      { task_id: 'T-CB-400', scope: ['core/a.py'] },
      { roles: { writer: { enabled: true, models: [kiroModel, healthyFallback] } } },
      { isCircuitBrokenFn: isModelCircuitBroken }
    );
    assert.equal(selAfter400.ok, true);
    assert.equal(selAfter400.selected_by, 'fallback');
    assert.equal(selAfter400.actual_model, healthyFallback);

    // Contrast: HTTP 400 with generic bad request error triggers fallback once WITHOUT tripping permanent circuit breaker
    resetCircuitBreaker();
    const resGeneric400 = await callModelEndpoint({
      baseUrl: 'http://127.0.0.1:20128/v1',
      apiKey: 'sk-test',
      model: 'generic-400-model',
      fallbackModel: healthyFallback,
      messages: [{ role: 'user', content: 'Test generic 400' }],
      fetchFn: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        if (body.model === 'generic-400-model') {
          return new Response(JSON.stringify({ error: { message: 'Invalid temperature parameter' } }), { status: 400 });
        }
        return okJsonResponse(body.model);
      }
    });
    assert.equal(resGeneric400.ok, true);
    assert.equal(resGeneric400.fallback_activated, true);
    assert.equal(isModelCircuitBroken('generic-400-model'), false, 'Generic HTTP 400 must NOT permanently disable model');
  }

  // 3. Explicit provider error code matrix for fallback & circuit breaker behavior
  {
    const fallbackTriggerStatuses = [400, 401, 403, 404, 408, 429, 500, 502, 503, 504];
    const circuitTrippingStatuses = new Set([401, 404]);

    for (const statusCode of fallbackTriggerStatuses) {
      resetCircuitBreaker();
      const primary = `primary-http-${statusCode}`;
      const fallback = 'fallback-healthy';
      const bodyMsg = statusCode === 400 ? 'The model is no longer supported' : `Upstream HTTP ${statusCode}`;
      const res = await callModelEndpoint({
        baseUrl: 'http://127.0.0.1:20128/v1',
        apiKey: 'sk-test',
        model: primary,
        fallbackModel: fallback,
        messages: [{ role: 'user', content: 'Matrix check' }],
        fetchFn: async (_url, init) => {
          const req = JSON.parse(String(init.body));
          if (req.model === primary) {
            return new Response(JSON.stringify({ error: { message: bodyMsg } }), { status: statusCode });
          }
          return okJsonResponse(req.model);
        }
      });
      assert.equal(res.ok, true, `HTTP ${statusCode} must activate fallback`);
      assert.equal(res.fallback_activated, true, `HTTP ${statusCode} must set fallback_activated=true`);
      assert.equal(res.actual_model, fallback);
      const expectedCB = circuitTrippingStatuses.has(statusCode) || statusCode === 400;
      assert.equal(isModelCircuitBroken(primary), expectedCB, `Circuit breaker expectation mismatch for HTTP ${statusCode}`);
    }

    // Timeout (AbortError) triggers fallback AND trips session circuit breaker so Attempt >= 2 skips straight to fallback
    resetCircuitBreaker();
    const timeoutRes = await callModelEndpoint({
      baseUrl: 'http://127.0.0.1:20128/v1',
      apiKey: 'sk-test',
      model: 'primary-timeout',
      fallbackModel: 'fallback-healthy',
      messages: [{ role: 'user', content: 'Timeout check' }],
      fetchFn: async (_url, init) => {
        const req = JSON.parse(String(init.body));
        if (req.model === 'primary-timeout') {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
        return okJsonResponse(req.model);
      }
    });
    assert.equal(timeoutRes.ok, true);
    assert.equal(timeoutRes.fallback_activated, true);
    assert.equal(isModelCircuitBroken('primary-timeout'), true);

    // call9Router strictModelMatch mismatch also falls back
    const c9Mismatch = await call9Router('primary-req', 'sys', 'usr', 128, 'fallback-healthy', 0, {
      strictModelMatch: true,
      fetchFn: async (_url, init) => {
        const req = JSON.parse(String(init.body));
        if (req.model === 'primary-req') {
          return okJsonResponse('completely-wrong-upstream-model', 'WRONG');
        }
        return okJsonResponse(req.model, 'RIGHT');
      }
    });
    assert.equal(c9Mismatch.ok, true);
    assert.equal(c9Mismatch.fallback_activated, true);
    assert.equal(c9Mismatch.modelUsed, 'fallback-healthy');
  }

  resetCircuitBreaker();
  console.log('[PASS] test-fallback-error-rules');
}

runTests().catch((err) => {
  console.error('[FAIL] test-fallback-error-rules:', err);
  process.exit(1);
});
