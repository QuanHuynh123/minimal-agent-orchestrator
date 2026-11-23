#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AGENT_TEAM_DIR = path.resolve(__dirname, '..');

async function runTests() {
  console.log('Testing Calibrated Token Estimator (~1.9x D-012 Review Prompt Ratio)...\n');

  const gw = await import('../runtime/provider-gateway.mjs');
  const ss = await import('../runtime/session-store.mjs');

  assert.equal(gw.BASELINE_CHARS_PER_TOKEN, 3.5, 'Baseline chars/token must remain 3.5');
  assert.equal(gw.TOKEN_ESTIMATION_CALIBRATION_FACTOR, 1.9, 'Calibration factor must equal empirical 1.9x from D-012');
  assert.equal(typeof gw.estimateTextTokens, 'function', 'provider-gateway.mjs must export estimateTextTokens');

  // Empirical D-012 baseline: 59,157 chars prompt + ~10,573 chars schema/framing previously gave ~19,923 est tok vs ~38k actual
  const empiricalMessages = [
    { role: 'system', content: 'S'.repeat(8000) },
    { role: 'user', content: 'R'.repeat(59157) }
  ];
  const empiricalTools = [{ type: 'function', function: { name: 'inspect', parameters: { x: 'T'.repeat(2500) } } }];
  const calibratedReqTokens = gw.estimateRequestPromptTokens({ messages: empiricalMessages, tools: empiricalTools });
  const calibratedPayloadTokens = ss.estimatePayloadTokens(empiricalMessages, empiricalTools);

  assert.ok(
    calibratedReqTokens >= 36000 && calibratedReqTokens <= 41000,
    `Calibrated request estimate for ~69.7K chars (D-012 benchmark) must align with ~38k actual tokens, got ${calibratedReqTokens}`
  );
  assert.ok(
    calibratedPayloadTokens >= 36000 && calibratedPayloadTokens <= 41000,
    `Calibrated session-store payload estimate must align with ~38k actual tokens, got ${calibratedPayloadTokens}`
  );

  // Verify pre-call budget guard now catches a 59,157-char prompt (~32K+ calibrated tokens) under a 34K cap with maxOutput=4096
  const promptOnlyTokens = gw.estimateRequestPromptTokens({ messages: [{ role: 'user', content: 'D'.repeat(59157) }] });
  assert.ok(promptOnlyTokens >= 31500 && promptOnlyTokens <= 33500, `59,157 chars alone should calibrate to ~32.1k tokens, got ${promptOnlyTokens}`);
  assert.throws(
    () => gw.assertBudgetBeforeCall({ used: 0, estimatedPrompt: promptOnlyTokens, maxOutput: 4096, limit: 34000, budgetKind: 'calibrated_review_guard' }),
    err => gw.isBudgetExceededError(err)
  );

  // Zero/empty inputs must safely yield 0
  assert.equal(gw.estimateTextTokens(0), 0);
  assert.equal(gw.estimateRequestPromptTokens({ messages: [], tools: [] }), 0);
  assert.equal(ss.estimatePayloadTokens([], []), 0);

  // Verify no uncalibrated `/ 3.5` remains directly outside provider-gateway's BASELINE_CHARS_PER_TOKEN definition
  for (const relPath of [
    'runtime/index.mjs',
    'runtime/session-store.mjs',
    'scripts/measure-router-loop.mjs',
    'scripts/score-router-suite.mjs'
  ]) {
    const src = fs.readFileSync(path.join(AGENT_TEAM_DIR, relPath), 'utf8');
    assert.ok(!/\/\s*3\.5\b/.test(src), `${relPath} must use calibrated estimateTextTokens instead of raw "/ 3.5"`);
  }

  console.log(`✓ Calibrated estimator verified (D-012 ~70K chars req=${calibratedReqTokens} tok, payload=${calibratedPayloadTokens} tok; 59,157 chars=${promptOnlyTokens} tok)`);
}

runTests().catch(err => {
  console.error('Token calibration test failed:', err);
  process.exit(1);
});
