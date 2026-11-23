#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  callModelEndpoint,
  getCircuitBreakerSnapshot,
  isModelCircuitBroken,
  resetCircuitBreaker,
  tripModelCircuitBreaker
} from '../runtime/provider-gateway.mjs';
import { DEFAULT_POLICY_CONFIG, mergePolicyWithDefaults } from './lib/risk-policy.mjs';
import { createSnapshot } from './server/state-reader.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');

function okJson(model, content = 'OK') {
  return new Response(
    JSON.stringify({
      id: 'cb-ok',
      model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

async function main() {
  resetCircuitBreaker();

  // 1. Default 10-minute (600,000 ms) TTL in policy config & configurable override
  assert.equal(
    DEFAULT_POLICY_CONFIG.execution_guardrails.circuit_breaker_ttl_ms,
    600000,
    'Default circuit_breaker_ttl_ms must be 10 minutes (600000ms)'
  );
  const customMerged = mergePolicyWithDefaults({
    policy: { execution_guardrails: { circuit_breaker_ttl_ms: 45000 } }
  });
  assert.equal(customMerged.execution_guardrails.circuit_breaker_ttl_ms, 45000);

  // 2. Circuit breaker expires automatically after TTL
  const t0 = 1_700_000_000_000;
  tripModelCircuitBreaker('dead-ttl-model', 'HTTP 404 model_not_found', { now: t0, ttlMs: 5000 });
  assert.equal(isModelCircuitBroken('dead-ttl-model', { now: t0 + 4999, ttlMs: 5000 }), true);
  assert.equal(isModelCircuitBroken('dead-ttl-model', { now: t0 + 5000, ttlMs: 5000 }), false, 'Model must recover automatically once TTL expires');

  // Re-trip at t0 with default 10-min TTL and verify callModelEndpoint recovers past 10 minutes
  resetCircuitBreaker();
  tripModelCircuitBreaker('dead-default-ttl', 'HTTP 404 model_not_found', { now: t0 });
  assert.equal(isModelCircuitBroken('dead-default-ttl', { now: t0 + 599999 }), true);
  assert.equal(isModelCircuitBroken('dead-default-ttl', { now: t0 + 600000 }), false);

  let recoveredPrimaryHit = false;
  resetCircuitBreaker();
  tripModelCircuitBreaker('retry-after-ttl', 'HTTP 404 model_not_found', { now: t0, ttlMs: 1000 });
  const afterTtlRes = await callModelEndpoint({
    baseUrl: 'http://127.0.0.1:20128/v1',
    apiKey: 'sk-test',
    model: 'retry-after-ttl',
    fallbackModel: 'fallback-m',
    messages: [{ role: 'user', content: 'hi' }],
    circuitBreakerTtlMs: 1000,
    nowFn: () => t0 + 1500,
    fetchFn: async (_url, init) => {
      const req = JSON.parse(String(init.body));
      if (req.model === 'retry-after-ttl') recoveredPrimaryHit = true;
      return okJson(req.model);
    }
  });
  assert.equal(recoveredPrimaryHit, true, 'Primary must be attempted again after circuit breaker TTL expires');
  assert.equal(afterTtlRes.ok, true);
  assert.equal(afterTtlRes.fallback_activated, false);

  // 3. Strange / unrelated error messages MUST NOT trip circuit breaker falsely
  const weirdErrors = [
    { status: 500, msg: 'Upstream provider log file not found in /tmp/req.log' },
    { status: 429, msg: 'Rate limit exceeded: slow down' },
    { status: 400, msg: 'Invalid parameter: temperature must be <= 2.0' },
    { status: 400, msg: 'context_length_exceeded: max is 128000' },
    { status: 503, msg: 'Weird proxy quirk: gateway cache miss' }
  ];
  for (let i = 0; i < weirdErrors.length; i++) {
    resetCircuitBreaker();
    const { status, msg } = weirdErrors[i];
    const mName = `weird-err-model-${i}`;
    await callModelEndpoint({
      baseUrl: 'http://127.0.0.1:20128/v1',
      apiKey: 'sk-test',
      model: mName,
      fallbackModel: 'fallback-m',
      messages: [{ role: 'user', content: 'test' }],
      fetchFn: async (_url, init) => {
        const req = JSON.parse(String(init.body));
        if (req.model === mName) {
          return new Response(JSON.stringify({ error: { message: msg } }), { status });
        }
        return okJson(req.model);
      }
    });
    assert.equal(isModelCircuitBroken(mName), false, `Strange error (${status}: ${msg}) must NOT trip circuit breaker`);
  }

  // 4. HTTP 400 parameter error: fallback with fallback_reason=request_rejected... + warning (no circuit trip)
  resetCircuitBreaker();
  const warningsSeen = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warningsSeen.push(args.map(String).join(' ')); };
  let param400Res;
  try {
    param400Res = await callModelEndpoint({
      baseUrl: 'http://127.0.0.1:20128/v1',
      apiKey: 'sk-test',
      model: 'writer-param-400',
      fallbackModel: 'writer-fallback',
      messages: [{ role: 'user', content: 'edit file' }],
      fetchFn: async (_url, init) => {
        const req = JSON.parse(String(init.body));
        if (req.model === 'writer-param-400') {
          return new Response(
            JSON.stringify({ error: { message: 'Unsupported parameter: max_thinking_tokens' } }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return okJson(req.model, 'PATCH');
      }
    });
  } finally {
    console.warn = origWarn;
  }
  assert.equal(param400Res.ok, true);
  assert.equal(param400Res.fallback_activated, true);
  assert.equal(param400Res.actual_model, 'writer-fallback');
  assert.equal(isModelCircuitBroken('writer-param-400'), false, 'HTTP 400 parameter rejection must NOT trip circuit breaker');
  assert.match(
    String(param400Res.fallback_reason || ''),
    /^request_rejected:/,
    `Expected fallback_reason starting with request_rejected:, got "${param400Res.fallback_reason}"`
  );
  assert.ok(
    param400Res.fallback_warning && /request_rejected/i.test(param400Res.fallback_warning),
    `Expected explicit fallback_warning on HTTP 400 request rejection, got: ${JSON.stringify(param400Res.fallback_warning)}`
  );
  assert.ok(
    warningsSeen.some(w => /request_rejected/i.test(w)),
    `Expected console.warn containing request_rejected, got: ${JSON.stringify(warningsSeen)}`
  );

  // 5. Cockpit snapshot exposes circuit_breakers state (merged with live_status + TTL filtering) & UI elements exist
  resetCircuitBreaker();
  const nowSnap = Date.now();
  tripModelCircuitBreaker('dead-live-model', 'HTTP 400: This version of Kiro is no longer supported', { now: nowSnap - 2000, ttlMs: 600000 });
  const cbSnap = getCircuitBreakerSnapshot({ now: nowSnap, ttlMs: 600000 });
  assert.equal(cbSnap.active_count, 1);
  assert.equal(cbSnap.models[0].model, 'dead-live-model');
  assert.ok(cbSnap.models[0].remaining_ms > 590000 && cbSnap.models[0].remaining_ms <= 600000);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-cb-cockpit-'));
  try {
    const cfgDir = path.join(tmpDir, 'config');
    const stateDir = path.join(tmpDir, 'state');
    const tasksDir = path.join(tmpDir, 'tasks');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(path.join(tasksDir, 'active'), { recursive: true });
    fs.mkdirSync(path.join(tasksDir, 'archive'), { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'policy.yaml'), [
      'policy:',
      '  version: "3.1.0"',
      '  project_id: "cb-test"',
      '  scope_control:',
      '    allowed_dirs: ["core/"]',
      '  execution_guardrails:',
      '    circuit_breaker_ttl_ms: 600000'
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(cfgDir, 'team.yaml'), [
      'roles:',
      '  writer:',
      '    enabled: true',
      '    models: ["dead-live-model", "writer-fallback"]'
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(stateDir, 'live-status.json'), JSON.stringify({
      active: true,
      current_stage: 'writer',
      circuit_broken_models: [
        {
          model: 'expired-live-model',
          reason: 'HTTP 404',
          tripped_at: nowSnap - 700000,
          expires_at: nowSnap - 100000,
          ttl_ms: 600000
        },
        {
          model: 'other-proc-dead',
          reason: 'HTTP 401 invalid_api_key',
          tripped_at: nowSnap - 10000,
          expires_at: nowSnap + 590000,
          ttl_ms: 600000
        }
      ]
    }), 'utf8');

    const snap = await createSnapshot({
      CONFIG_DIR: cfgDir,
      TEAM_DIR: tmpDir,
      STATE_DIR: stateDir,
      TASKS_ACTIVE_DIR: path.join(tasksDir, 'active'),
      TASKS_ARCHIVE_DIR: path.join(tasksDir, 'archive'),
      LOCK_FILE: path.join(tmpDir, '.orchestrator.lock'),
      COCKPIT_LOCK_FILE: path.join(tmpDir, '.cockpit.lock'),
      LIVE_STATUS_FILE: path.join(stateDir, 'live-status.json'),
      TASK_STATE_FILE: path.join(stateDir, 'task-state.json'),
      RUNS_DIR: path.join(stateDir, 'runs'),
      SESSIONS_DIR: path.join(stateDir, 'sessions')
    });
    assert.ok(snap.circuit_breakers, 'createSnapshot must expose circuit_breakers telemetry');
    assert.equal(snap.circuit_breakers.ttl_ms, 600000);
    const cbModels = snap.circuit_breakers.models.map(m => m.model).sort();
    assert.deepEqual(
      cbModels,
      ['dead-live-model', 'other-proc-dead'],
      'Cockpit snapshot must merge live + local circuit breakers and drop TTL-expired entries'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetCircuitBreaker();
  }

  const sidebarHtml = fs.readFileSync(path.join(TEAM_DIR, 'ui', 'layouts', 'layout-sidebar.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(TEAM_DIR, 'ui', 'js', 'app.js'), 'utf8');
  assert.ok(sidebarHtml.includes('id="squad-circuit-breaker-status"'), 'layout-sidebar.html must render circuit breaker status element');
  assert.ok(appJs.includes('squad-circuit-breaker-status') && appJs.includes('circuit_breakers'), 'app.js must display data.circuit_breakers safely');

  console.log('[PASS] test-circuit-breaker-ttl-and-400');
}

main().catch(err => {
  console.error('[FAIL] test-circuit-breaker-ttl-and-400:', err);
  process.exit(1);
});
