#!/usr/bin/env node
/**
 * TDD Suite for Batch 169 Item 2:
 *  - Per-session +2000 buffer calibration from one tiny startup probe request:
 *      1) raw prompt_tokens >= ~2000 -> enable -2000 adjustment + flag 'buffer_2000_enabled'
 *      2) raw prompt_tokens <  ~2000 -> disable -2000 adjustment + flag 'buffer_2000_disabled'
 *  - Independent tracking for ag/* vs non-ag/* providers (e.g., deepseek / hive via 9Router)
 */

import assert from 'node:assert/strict';
import {
  BUFFER_CALIBRATION_THRESHOLD,
  calibrateBufferFromProbeResult,
  calibrateProviderBuffer,
  getSessionBufferCalibration,
  normalizeUsage,
  resetSessionBufferCalibration,
  runSessionBufferCalibrationMatrix
} from '../runtime/provider-gateway.mjs';

function makeProbeResponse(model, promptTokens, completionTokens = 2) {
  return new Response(
    `data: ${JSON.stringify({
      id: 'cal-1',
      object: 'chat.completion.chunk',
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }]
    })}\n\n` +
    `data: ${JSON.stringify({
      id: 'cal-1',
      object: 'chat.completion.chunk',
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
    })}\n\n` +
    `data: [DONE]\n\n`,
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  );
}

async function testTwoSimulatedCalibrationScenarios() {
  resetSessionBufferCalibration();
  assert.ok(BUFFER_CALIBRATION_THRESHOLD >= 1800 && BUFFER_CALIBRATION_THRESHOLD <= 2000);

  // Scenario 1: Tiny probe reports prompt_tokens >= ~2000 (e.g. 2024 with 9router +2000 buffer)
  const calEnabled = await calibrateProviderBuffer('ag/gemini-3.8-flash-medium', {
    baseUrl: 'http://127.0.0.1:20199/v1',
    apiKey: 'mock',
    nineRouterVersion: '0.5.119',
    fetchFn: async (_url, init) => {
      const req = JSON.parse(String(init.body || '{}'));
      assert.ok(req.max_tokens <= 16, 'Calibration probe must stay tiny');
      return makeProbeResponse('gemini-3.8-flash-n', 2024, 1);
    }
  });

  assert.equal(calEnabled.ok, true);
  assert.equal(calEnabled.calibrated, true);
  assert.equal(calEnabled.probe_prompt_tokens_raw, 2024);
  assert.equal(calEnabled.apply_buffer_adjustment, true);
  assert.equal(calEnabled.buffer_amount, 2000);
  assert.equal(calEnabled.calibration_flag, 'buffer_2000_enabled');

  const storedEnabled = getSessionBufferCalibration('ag/gemini-3.8-flash-medium');
  assert.equal(storedEnabled?.apply_buffer_adjustment, true);
  assert.equal(storedEnabled?.calibration_flag, 'buffer_2000_enabled');

  // Even if nineRouterVersion changes to unknown 0.5.120, calibrated session MUST keep subtracting 2000
  const usageWhenEnabled = normalizeUsage(
    { prompt_tokens: 7500, completion_tokens: 50, total_tokens: 7550, prompt_tokens_details: { cached_tokens: 3000 } },
    { model: 'ag/gemini-3.8-flash-medium', nineRouterVersion: '0.5.120', streamed: true }
  );
  assert.equal(usageWhenEnabled.usage_adjusted_buffer, 2000);
  assert.equal(usageWhenEnabled.prompt_tokens_adjusted, 5500);
  assert.equal(usageWhenEnabled.fresh_tokens, 2500);
  assert.equal(usageWhenEnabled.buffer_calibration_flag, 'buffer_2000_enabled');

  // Scenario 2: Tiny probe reports prompt_tokens < ~2000 (e.g. 24 when +2000 buffer is absent)
  resetSessionBufferCalibration();
  const calDisabled = await calibrateProviderBuffer('ag/gemini-3.8-flash-medium', {
    baseUrl: 'http://127.0.0.1:20199/v1',
    apiKey: 'mock',
    nineRouterVersion: '0.5.119',
    fetchFn: async () => makeProbeResponse('gemini-3.8-flash-n', 24, 1)
  });

  assert.equal(calDisabled.ok, true);
  assert.equal(calDisabled.calibrated, true);
  assert.equal(calDisabled.probe_prompt_tokens_raw, 24);
  assert.equal(calDisabled.apply_buffer_adjustment, false);
  assert.equal(calDisabled.buffer_amount, 0);
  assert.equal(calDisabled.calibration_flag, 'buffer_2000_disabled');

  // Even on 0.5.119, disabled calibration flag MUST suppress -2000 subtraction
  const usageWhenDisabled = normalizeUsage(
    { prompt_tokens: 7500, completion_tokens: 50, total_tokens: 7550, prompt_tokens_details: { cached_tokens: 3000 } },
    { model: 'ag/gemini-3.8-flash-medium', nineRouterVersion: '0.5.119', streamed: true }
  );
  assert.equal(usageWhenDisabled.usage_adjusted_buffer, 0);
  assert.equal(usageWhenDisabled.prompt_tokens_adjusted, 7500);
  assert.equal(usageWhenDisabled.fresh_tokens, 4500);
  assert.equal(usageWhenDisabled.buffer_calibration_flag, 'buffer_2000_disabled');

  // Scenario 3: Matrix calibration comparing ag/* (with +2000) vs non-ag/* (without +2000)
  resetSessionBufferCalibration();
  const matrix = await runSessionBufferCalibrationMatrix({
    models: ['ag/gemini-3.8-flash-medium', 'Deepseek V4.1 Flash/deepseek-ai/deepseek-v4.1-flash-1017'],
    baseUrl: 'http://127.0.0.1:20199/v1',
    apiKey: 'mock',
    nineRouterVersion: '0.5.119',
    fetchFn: async (_url, init) => {
      const req = JSON.parse(String(init.body || '{}'));
      if (req.model.startsWith('ag/')) {
        return makeProbeResponse(req.model, 2019, 1);
      }
      return makeProbeResponse(req.model, 14, 1);
    }
  });
  assert.equal(matrix.results.length, 2);
  assert.equal(matrix.results[0].is_ag, true);
  assert.equal(matrix.results[0].calibration_flag, 'buffer_2000_enabled');
  assert.equal(matrix.results[1].is_ag, false);
  assert.equal(matrix.results[1].calibration_flag, 'buffer_2000_disabled');

  const direct = calibrateBufferFromProbeResult({ model: 'hive/deepseek-v3', rawPromptTokens: 16 });
  assert.equal(direct.apply_buffer_adjustment, false);
  assert.equal(direct.calibration_flag, 'buffer_2000_disabled');

  resetSessionBufferCalibration();
  console.log('[OK] Per-session buffer calibration (both scenarios & ag vs non-ag matrix) passed');
}

testTwoSimulatedCalibrationScenarios().catch(err => {
  console.error('[FAIL]', err);
  process.exit(1);
});
