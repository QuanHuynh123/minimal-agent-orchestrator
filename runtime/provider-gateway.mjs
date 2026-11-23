#!/usr/bin/env node
/**
 * 9Router Provider Gateway & Capability Matrix Adapter
 * Part of Agent Runtime (agent-team/runtime/provider-gateway.mjs)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_9ROUTER_URL = 'http://127.0.0.1:20128/v1';
export const DEFAULT_TIMEOUT_MS = 180000; // 180s hard timeout (HR-1)
export const NINE_ROUTER_PROMPT_BUFFER = 2000;
export const BUFFER_CALIBRATION_THRESHOLD = 1900;
// Verified in chunks/5330.js:282 (module 73483, O9: +=2e3) and chunks/8895.js:3,58,60
export const CONFIRMED_9ROUTER_BUFFER_VERSIONS = new Set(['0.5.119']);

const _sessionBufferCalibrations = new Map();

export function resetSessionBufferCalibration() {
  _sessionBufferCalibrations.clear();
}

export function calibrateBufferFromProbeResult({
  model = '',
  rawPromptTokens = 0,
  actualModel = null,
  nineRouterVersion = null
} = {}) {
  const modelKey = String(model || '').trim();
  const isAg = isAntigravityModel(modelKey);
  const rawTokens = Number(rawPromptTokens || 0);
  const enabled = Number.isFinite(rawTokens) && rawTokens >= BUFFER_CALIBRATION_THRESHOLD;
  const record = {
    calibrated: true,
    model: modelKey,
    actual_model: actualModel || modelKey || null,
    is_ag: isAg,
    nine_router_version: nineRouterVersion || null,
    threshold: BUFFER_CALIBRATION_THRESHOLD,
    probe_prompt_tokens_raw: rawTokens,
    apply_buffer_adjustment: enabled,
    buffer_amount: enabled ? NINE_ROUTER_PROMPT_BUFFER : 0,
    calibration_flag: enabled ? 'buffer_2000_enabled' : 'buffer_2000_disabled',
    calibrated_at: new Date().toISOString()
  };

  if (modelKey) {
    _sessionBufferCalibrations.set(modelKey.toLowerCase(), record);
  }
  if (isAg) {
    _sessionBufferCalibrations.set('ag/*', record);
  }
  return record;
}

export function getSessionBufferCalibration(model = '') {
  const key = String(model || '').trim().toLowerCase();
  if (key && _sessionBufferCalibrations.has(key)) {
    return _sessionBufferCalibrations.get(key);
  }
  if (isAntigravityModel(key) && _sessionBufferCalibrations.has('ag/*')) {
    return _sessionBufferCalibrations.get('ag/*');
  }
  return null;
}

export function listSessionBufferCalibrations() {
  return [..._sessionBufferCalibrations.values()];
}

export class BudgetExceededError extends Error {
  constructor(message = 'local budget stop', meta = {}) {
    const raw = String(message || 'local budget stop').trim();
    const fullMsg = /local budget stop/i.test(raw) ? raw : `local budget stop: ${raw}`;
    super(fullMsg);
    this.name = 'BudgetExceededError';
    this.code = 'LOCAL_BUDGET_STOP';
    this.isBudgetExceeded = true;
    this.nonRetryable = true;
    this.budgetKind = meta.budgetKind || 'token_budget';
    this.used = meta.used ?? null;
    this.limit = meta.limit ?? null;
  }
}

export function isBudgetExceededError(err) {
  return Boolean(
    err && (
      err instanceof BudgetExceededError ||
      err.name === 'BudgetExceededError' ||
      err.code === 'LOCAL_BUDGET_STOP' ||
      err.isBudgetExceeded === true
    )
  );
}

export function shouldRetryFailure(errOrRes) {
  if (!errOrRes) return true;
  if (isBudgetExceededError(errOrRes)) return false;
  if (errOrRes.nonRetryable === true || errOrRes.budget_exceeded === true) return false;
  return true;
}

/**
 * Empirical calibration (DECISIONS D-012): raw `chars / 3.5` estimated 19,923 tokens
 * on a saved 59,157+ char review prompt that actually consumed ~38k fresh Claude tokens (~1.9x).
 */
export const BASELINE_CHARS_PER_TOKEN = 3.5;
export const TOKEN_ESTIMATION_CALIBRATION_FACTOR = 1.9;
export const CALIBRATED_CHARS_PER_TOKEN = BASELINE_CHARS_PER_TOKEN / TOKEN_ESTIMATION_CALIBRATION_FACTOR;

export function estimateTextTokens(charCount = 0) {
  const chars = Number(charCount) || 0;
  return chars > 0 ? Math.ceil((chars / BASELINE_CHARS_PER_TOKEN) * TOKEN_ESTIMATION_CALIBRATION_FACTOR) : 0;
}

/**
 * Estimates prompt tokens across messages, tools, and system fields using the D-012 calibrated 1.9x ratio (~1.84 chars/token).
 */
export function estimateRequestPromptTokens(payloadOrReq = {}) {
  if (!payloadOrReq || typeof payloadOrReq !== 'object') return 0;
  let totalChars = 0;
  if (payloadOrReq.system !== undefined && payloadOrReq.system !== null) {
    totalChars += typeof payloadOrReq.system === 'string'
      ? payloadOrReq.system.length
      : JSON.stringify(payloadOrReq.system).length;
  }
  if (Array.isArray(payloadOrReq.messages)) {
    for (const msg of payloadOrReq.messages) {
      totalChars += JSON.stringify(msg ?? '').length;
    }
  }
  if (Array.isArray(payloadOrReq.tools) && payloadOrReq.tools.length > 0) {
    totalChars += JSON.stringify(payloadOrReq.tools).length;
  }
  return estimateTextTokens(totalChars);
}

/**
 * Strict pre-call budget guard: enforces `used + estimatedPrompt + maxOutput <= limit`.
 * Throws BudgetExceededError ("local budget stop") BEFORE any request leaves the process.
 */
export function assertBudgetBeforeCall({
  used = 0,
  estimatedPrompt = 0,
  maxOutput = 0,
  limit = null,
  budgetKind = 'token_budget'
} = {}) {
  if (limit === null || limit === undefined || !Number.isFinite(Number(limit)) || Number(limit) <= 0) {
    return { ok: true, used: Number(used || 0), projected: Number(used || 0) + Number(estimatedPrompt || 0) + Number(maxOutput || 0) };
  }
  const numUsed = Number(used || 0);
  const numPrompt = Math.max(0, Number(estimatedPrompt || 0));
  const numOut = Math.max(0, Number(maxOutput || 0));
  const numLimit = Number(limit);
  const projected = numUsed + numPrompt + numOut;
  if (projected > numLimit) {
    throw new BudgetExceededError(
      `local budget stop: used(${numUsed}) + est_prompt(${numPrompt}) + max_output(${numOut}) = ${projected} > ceiling(${numLimit})`,
      { budgetKind, used: numUsed, limit: numLimit, projected }
    );
  }
  return { ok: true, used: numUsed, projected, limit: numLimit };
}

/**
 * Computes worst-case zero-cache token consumption for an agent/router run (including optional fallback turns).
 */
export function estimateWorstCaseRunTokens({
  estimatedPrompt = 6000,
  maxOutput = 16384,
  fallbackPossible = true,
  fallbackMaxTurns = 5,
  perTurnHistoryGrowth = 1500
} = {}) {
  const baseTurn = Math.max(0, Number(estimatedPrompt || 0)) + Math.max(0, Number(maxOutput || 0));
  if (!fallbackPossible) {
    return baseTurn;
  }
  const turns = Math.max(1, Number(fallbackMaxTurns || 5));
  let fallbackTotal = 0;
  for (let t = 0; t < turns; t++) {
    fallbackTotal += Math.max(0, Number(estimatedPrompt || 0)) + t * perTurnHistoryGrowth + 1200;
  }
  return baseTurn + fallbackTotal + Math.max(0, Number(maxOutput || 0));
}

let _cached9RouterVersion = null;

export function resolve9RouterPackageJsonPaths(options = {}) {
  const candidates = [];
  if (options.packageJsonPath) {
    candidates.push(path.resolve(options.packageJsonPath));
  }
  if (process.env.NINE_ROUTER_PACKAGE_JSON) {
    candidates.push(path.resolve(process.env.NINE_ROUTER_PACKAGE_JSON));
  }
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  if (!options.packageJsonPath) {
    candidates.push(
      path.join(appData, 'npm', 'node_modules', '9router', 'package.json'),
      path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', '9router', 'package.json'),
      '/usr/local/lib/node_modules/9router/package.json'
    );
  }
  return [...new Set(candidates.filter(Boolean))];
}

export function readInstalled9RouterVersion(options = {}) {
  if (_cached9RouterVersion && !options.packageJsonPath && !options.forceRefresh) {
    return _cached9RouterVersion;
  }

  for (const pkgPath of resolve9RouterPackageJsonPaths(options)) {
    try {
      if (!fs.existsSync(pkgPath)) continue;
      const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const version = typeof parsed?.version === 'string' && parsed.version.trim()
        ? parsed.version.trim()
        : null;
      const result = {
        found: true,
        name: String(parsed?.name || '9router'),
        version,
        package_json_path: pkgPath
      };
      if (!options.packageJsonPath) {
        _cached9RouterVersion = result;
      }
      return result;
    } catch {}
  }

  return {
    found: false,
    name: '9router',
    version: null,
    package_json_path: resolve9RouterPackageJsonPaths(options)[0] || null
  };
}

export function resolveNineRouterBufferAdjustment({
  model = '',
  nineRouterVersion = null,
  rawPromptTokens = 0,
  applyNineRouterBuffer = true,
  calibration = null
} = {}) {
  if (applyNineRouterBuffer === false) return 0;
  const rawNum = Number(rawPromptTokens || 0);
  if (rawNum < NINE_ROUTER_PROMPT_BUFFER) return 0;

  const cal = calibration || getSessionBufferCalibration(model);
  if (cal && cal.calibrated) {
    return cal.apply_buffer_adjustment ? (cal.buffer_amount ?? NINE_ROUTER_PROMPT_BUFFER) : 0;
  }

  if (!isAntigravityModel(model)) return 0;
  const ver = String(nineRouterVersion || '').trim();
  if (!ver || !CONFIRMED_9ROUTER_BUFFER_VERSIONS.has(ver)) return 0;
  return NINE_ROUTER_PROMPT_BUFFER;
}

export function isAntigravityModel(modelId = '') {
  return String(modelId || '').trim().toLowerCase().startsWith('ag/');
}

export function isGeminiModel(modelId = '') {
  return String(modelId || '').trim().toLowerCase().includes('gemini');
}

/**
 * In-Session Circuit Breaker with configurable TTL (default 10 minutes = 600,000 ms):
 * tracks models that failed with unrecoverable provider/credential/unsupported-model errors
 * so subsequent calls route directly to fallback until TTL expires.
 */
export const DEFAULT_CIRCUIT_BREAKER_TTL_MS = 10 * 60 * 1000;
const SESSION_DEAD_MODELS = new Map();

export function resolveCircuitBreakerTtlMs(policyOrGuardrails = {}) {
  const guardrails = policyOrGuardrails?.policy?.execution_guardrails
    || policyOrGuardrails?.execution_guardrails
    || policyOrGuardrails
    || {};
  const rawMs = Number(guardrails.circuit_breaker_ttl_ms);
  if (Number.isFinite(rawMs) && rawMs > 0) return rawMs;
  const rawSec = Number(guardrails.circuit_breaker_ttl_sec);
  if (Number.isFinite(rawSec) && rawSec > 0) return rawSec * 1000;
  return DEFAULT_CIRCUIT_BREAKER_TTL_MS;
}

function getEffectiveEntryTtl(entry, ttlMs = null) {
  const overrideTtl = Number(ttlMs);
  if (Number.isFinite(overrideTtl) && overrideTtl > 0) return overrideTtl;
  const entryTtl = Number(entry?.ttl_ms);
  if (Number.isFinite(entryTtl) && entryTtl > 0) return entryTtl;
  return DEFAULT_CIRCUIT_BREAKER_TTL_MS;
}

function pruneExpiredCircuitBreakers(nowMs = Date.now(), ttlMs = null) {
  for (const [mId, entry] of SESSION_DEAD_MODELS.entries()) {
    const effectiveTtl = getEffectiveEntryTtl(entry, ttlMs);
    if ((nowMs - entry.tripped_at) >= effectiveTtl) {
      SESSION_DEAD_MODELS.delete(mId);
    }
  }
}

export function isModelCircuitBroken(modelId, options = {}) {
  if (!modelId || !SESSION_DEAD_MODELS.has(modelId)) return false;
  const entry = SESSION_DEAD_MODELS.get(modelId);
  const nowMs = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const effectiveTtl = getEffectiveEntryTtl(entry, options.ttlMs);
  if ((nowMs - entry.tripped_at) >= effectiveTtl) {
    SESSION_DEAD_MODELS.delete(modelId);
    return false;
  }
  return true;
}

export function getCircuitBrokenReason(modelId, options = {}) {
  if (!isModelCircuitBroken(modelId, options)) return null;
  return SESSION_DEAD_MODELS.get(modelId)?.reason || null;
}

export function tripModelCircuitBreaker(modelId, reason, options = {}) {
  if (!modelId) return;
  const nowMs = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const ttlMs = getEffectiveEntryTtl(null, options.ttlMs);
  SESSION_DEAD_MODELS.set(modelId, {
    model: modelId,
    reason: String(reason || 'Unrecoverable provider error'),
    status: options.status ?? null,
    tripped_at: nowMs,
    ttl_ms: ttlMs
  });
}

export function getCircuitBreakerSnapshot(options = {}) {
  const nowMs = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const fallbackTtl = getEffectiveEntryTtl(null, options.ttlMs);
  pruneExpiredCircuitBreakers(nowMs, options.ttlMs);
  const models = [];
  for (const entry of SESSION_DEAD_MODELS.values()) {
    const effectiveTtl = getEffectiveEntryTtl(entry, options.ttlMs);
    const expiresAt = entry.tripped_at + effectiveTtl;
    const remainingMs = Math.max(0, expiresAt - nowMs);
    if (remainingMs <= 0) continue;
    models.push({
      model: entry.model,
      reason: entry.reason,
      status: entry.status,
      tripped_at: entry.tripped_at,
      ttl_ms: effectiveTtl,
      expires_at: expiresAt,
      remaining_ms: remainingMs
    });
  }
  return {
    active_count: models.length,
    ttl_ms: fallbackTtl,
    checked_at: nowMs,
    models
  };
}

export function resetCircuitBreaker() {
  SESSION_DEAD_MODELS.clear();
}

/**
 * Capability Matrix: Family-based capability presets (no hardcoded personal model IDs).
 */
export const CAPABILITY_MATRIX = {};

/**
 * Returns capability flags for any given model ID based on model family capabilities.
 */
export function getModelCapabilities(modelId = '') {
  const normalized = String(modelId).toLowerCase();

  if (CAPABILITY_MATRIX[modelId]) {
    return { ...CAPABILITY_MATRIX[modelId] };
  }

  const isClaude = normalized.includes('claude') || normalized.includes('sonnet') || normalized.includes('opus') || normalized.includes('haiku');
  const isGpt4 = normalized.includes('gpt-4') || normalized.includes('gpt-5') || normalized.includes('o1') || normalized.includes('o3');
  const isGemini = normalized.includes('gemini');
  const isDeepseek = normalized.includes('deepseek');
  const isQwenCoder = normalized.includes('qwen') || normalized.includes('coder');
  const isVision = !isDeepseek && (isClaude || isGpt4 || isGemini || normalized.includes('vision') || normalized.includes('vl'));

  return {
    supports_vision: isVision,
    supports_multimodal: isVision,
    supports_tool_calls: isClaude || isGpt4 || isGemini || isDeepseek || isQwenCoder || normalized.includes('instruct'),
    supports_long_context: isClaude || isGemini || isDeepseek || normalized.includes('128k') || normalized.includes('200k'),
    supports_json_schema: isGpt4 || isClaude || isGemini || isDeepseek,
    supports_code_generation: true,
    max_context_tokens: isClaude || isGemini ? 200000 : (isDeepseek ? 128000 : 64000)
  };
}

/**
 * Extracts tool calls from both OpenAI native format and fallback structured text.
 */
export function parseToolCalls(choiceMessage) {
  if (!choiceMessage) return [];

  // 1. Native OpenAI tool_calls
  if (Array.isArray(choiceMessage.tool_calls) && choiceMessage.tool_calls.length > 0) {
    return choiceMessage.tool_calls.map(tc => {
      let parsedArgs = {};
      try {
        parsedArgs = typeof tc.function?.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : (tc.function?.arguments || {});
      } catch {
        parsedArgs = { raw_arguments: tc.function?.arguments };
      }
      return {
        id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: tc.function?.name || '',
        arguments: parsedArgs,
        ...(tc.thought_signature ? { thought_signature: tc.thought_signature } : {}),
        ...(tc.signature ? { thought_signature: tc.signature } : {}),
        ...(tc.provider_specific_fields ? { provider_specific_fields: tc.provider_specific_fields } : {})
      };
    });
  }

  // 2. Fallback structured tags: <tool_call>{"name": "...", "arguments": {...}}</tool_call>
  const content = choiceMessage.content || '';
  const regex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  const calls = [];
  let match;

  while ((match = regex.exec(content)) !== null) {
    const rawJson = match[1].trim();
    try {
      const parsed = JSON.parse(rawJson);
      if (parsed && parsed.name) {
        calls.push({
          id: `fallback_${Date.now()}_${calls.length}`,
          name: parsed.name,
          arguments: parsed.arguments || {}
        });
      }
    } catch {
      // Ignore unparseable fallback tags
    }
  }

  return calls;
}

/**
 * Parses Server-Sent Events (SSE) streaming format if provider defaults to streaming.
 */
export function parseSSEResponse(sseText) {
  const lines = sseText.split(/\r?\n/);
  let content = '';
  let model = '';
  let finishReason = 'stop';
  let reasoningContent = '';
  let rawUsage = null;
  const toolCallsMap = new Map();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const dataStr = trimmed.slice(5).trim();
    if (dataStr === '[DONE]') break;
    try {
      const chunk = JSON.parse(dataStr);
      if (chunk.model) model = chunk.model;
      if (chunk.message && typeof chunk.message === 'object') {
        if (chunk.message.model) model = chunk.message.model;
        if (chunk.message.usage && typeof chunk.message.usage === 'object') {
          rawUsage = rawUsage
            ? { ...rawUsage, ...JSON.parse(JSON.stringify(chunk.message.usage)) }
            : JSON.parse(JSON.stringify(chunk.message.usage));
        }
      }
      if (chunk.usage && typeof chunk.usage === 'object') {
        rawUsage = rawUsage
          ? { ...rawUsage, ...JSON.parse(JSON.stringify(chunk.usage)) }
          : JSON.parse(JSON.stringify(chunk.usage));
      }
      const delta = chunk.choices?.[0]?.delta || chunk.choices?.[0]?.message || {};
      if (delta.content) content += delta.content;
      if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
      if (delta.reasoning) reasoningContent += delta.reasoning;
      if (delta.thinking) reasoningContent += delta.thinking;
      if (chunk.delta && typeof chunk.delta === 'object') {
        if (typeof chunk.delta.text === 'string') content += chunk.delta.text;
        if (typeof chunk.delta.thinking === 'string') reasoningContent += chunk.delta.thinking;
        if (chunk.delta.stop_reason) finishReason = chunk.delta.stop_reason;
      }
      if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCallsMap.has(idx)) {
            toolCallsMap.set(idx, {
              id: tc.id || '',
              name: tc.function?.name || '',
              argsText: '',
              thought_signature: tc.thought_signature || tc.signature || null,
              provider_specific_fields: tc.provider_specific_fields || null
            });
          }
          const existing = toolCallsMap.get(idx);
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.argsText += tc.function.arguments;
          if (tc.thought_signature || tc.signature) {
            existing.thought_signature = tc.thought_signature || tc.signature;
          }
          if (tc.provider_specific_fields) {
            existing.provider_specific_fields = tc.provider_specific_fields;
          }
        }
      }
    } catch {}
  }

  const finalToolCalls = [];
  for (const [_, tc] of toolCallsMap.entries()) {
    let args = {};
    try {
      args = JSON.parse(tc.argsText);
    } catch {
      args = { raw_arguments: tc.argsText };
    }
    finalToolCalls.push({
      id: tc.id || `call_${Date.now()}`,
      name: tc.name,
      arguments: args,
      ...(tc.thought_signature ? { thought_signature: tc.thought_signature } : {}),
      ...(tc.provider_specific_fields ? { provider_specific_fields: tc.provider_specific_fields } : {})
    });
  }

  return {
    content,
    model,
    finish_reason: finishReason,
    reasoning_content: reasoningContent,
    tool_calls: finalToolCalls,
    usage: rawUsage
  };
}

/**
 * Returns the numeric cached token count explicitly reported by the provider,
 * or `null` when the provider omitted all cache telemetry fields.
 */
export function extractReportedCachedTokens(raw = null) {
  if (!raw || typeof raw !== 'object') return null;
  const candidates = [
    raw.cache_read_input_tokens,
    raw.prompt_tokens_details?.cached_tokens,
    raw.prompt_tokens_details?.cache_read_input_tokens,
    raw.cached_tokens,
    raw.cached_content_token_count,
    raw.usage_metadata?.cached_content_token_count
  ];
  for (const val of candidates) {
    if (val !== undefined && val !== null && Number.isFinite(Number(val))) {
      return Number(val);
    }
  }
  return null;
}

/**
 * Normalizes usage telemetry across OpenAI, Anthropic, and 9Router formats,
 * calculating uncached input and cache hit ratios while preserving reportability
 * and marking degraded non-stream / Gemini thoughts-in-prompt adjustments.
 */
export function normalizeUsage(raw = {}, options = {}) {
  const {
    nonStreamDegraded = false,
    streamed = false,
    isGemini = false,
    model = '',
    nineRouterVersion = null,
    applyNineRouterBuffer = true
  } = options;
  const geminiTarget = isGemini || isGeminiModel(model);

  const reportedCached = extractReportedCachedTokens(raw);
  const cacheCreation = Number(raw?.cache_creation_input_tokens ?? 0);
  const rawInput = Number(raw?.prompt_tokens ?? raw?.input_tokens ?? 0);
  const completion = Number(raw?.completion_tokens ?? raw?.output_tokens ?? 0);
  const reasoning = Number(
    raw?.completion_tokens_details?.reasoning_tokens
    ?? raw?.output_tokens_details?.reasoning_tokens
    ?? raw?.reasoning_tokens
    ?? raw?.thinking_tokens
    ?? 0
  );
  const totalPrompt = raw?.cache_read_input_tokens !== undefined
    ? (rawInput + (reportedCached ?? 0) + cacheCreation)
    : rawInput;

  const cal = getSessionBufferCalibration(model);
  const bufferOffset = resolveNineRouterBufferAdjustment({
    model,
    nineRouterVersion,
    rawPromptTokens: totalPrompt,
    applyNineRouterBuffer,
    calibration: cal
  });
  const calibrationFlag = cal?.calibrated
    ? cal.calibration_flag
    : (bufferOffset > 0 ? 'version_fallback_enabled' : 'not_calibrated');
  const reasoningOffset = (nonStreamDegraded && geminiTarget) ? reasoning : 0;
  const promptTokensAdjusted = Math.max(0, totalPrompt - bufferOffset - reasoningOffset);
  const totalTokensAdjusted = promptTokensAdjusted + completion;

  if (nonStreamDegraded) {
    const freshDegraded = promptTokensAdjusted;
    return {
      prompt_tokens: totalPrompt,
      prompt_tokens_raw: totalPrompt,
      prompt_tokens_adjusted: promptTokensAdjusted,
      usage_adjusted_buffer: bufferOffset,
      buffer_calibration_flag: calibrationFlag,
      uncached_input_tokens: freshDegraded,
      fresh_tokens: freshDegraded,
      cached_tokens: null,
      cache_reported: false,
      reported_cached_tokens: null,
      cache_creation_input_tokens: cacheCreation,
      completion_tokens: completion,
      reasoning_tokens: reasoning,
      total_tokens: totalPrompt + completion,
      total_tokens_adjusted: totalTokensAdjusted,
      cache_hit_ratio: 0,
      usage_quality: 'degraded',
      usage_adjusted: geminiTarget
    };
  }

  const cached = reportedCached !== null ? reportedCached : 0;
  const freshTokens = Math.max(0, promptTokensAdjusted - cached);

  return {
    prompt_tokens: totalPrompt,
    prompt_tokens_raw: totalPrompt,
    prompt_tokens_adjusted: promptTokensAdjusted,
    usage_adjusted_buffer: bufferOffset,
    buffer_calibration_flag: calibrationFlag,
    uncached_input_tokens: freshTokens,
    fresh_tokens: freshTokens,
    cached_tokens: cached,
    cache_reported: reportedCached !== null,
    reported_cached_tokens: reportedCached,
    cache_creation_input_tokens: cacheCreation,
    completion_tokens: completion,
    reasoning_tokens: reasoning,
    total_tokens: totalPrompt + completion,
    total_tokens_adjusted: totalTokensAdjusted,
    cache_hit_ratio: promptTokensAdjusted > 0 ? Number((cached / promptTokensAdjusted).toFixed(4)) : 0,
    usage_quality: streamed ? 'full' : 'standard',
    usage_adjusted: false
  };
}

/**
 * Core HTTP Request Dispatcher to 9Router (:20128/v1/chat/completions)
 */
export async function callModelEndpoint(options = {}) {
  const {
    baseUrl = DEFAULT_9ROUTER_URL,
    apiKey = process.env.NINE_ROUTER_API_KEY || 'sk-default',
    model,
    messages = [],
    tools = null,
    temperature = 0.2,
    maxTokens = 16384,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fallbackModel = null,
    circuitBreakerTtlMs = DEFAULT_CIRCUIT_BREAKER_TTL_MS,
    nowFn = null,
    extraHeaders = {},
    fetchFn = null
  } = options;
  const fetchImpl = typeof fetchFn === 'function' ? fetchFn : globalThis.fetch;
  const getNowMs = typeof nowFn === 'function' ? nowFn : () => Date.now();

  if (!model) {
    return { ok: false, error: 'Model identifier is required' };
  }

  async function executeSingleCall(targetModel) {
    // Multi-Breakpoint Prompt Caching (SPEC Section 3.4) & Outbound Message Sanitization:
    // Strip raw reasoning_content from outbound request messages to prevent HTTP 400 on strict providers
    // while preserving thought_signature and thinking_blocks.
    let formattedMessages = messages.map(m => {
      if (m && typeof m === 'object' && 'reasoning_content' in m) {
        const { reasoning_content, ...rest } = m;
        return rest;
      }
      return m;
    });
    const isClaude = String(targetModel).toLowerCase().includes('claude');

    if (isClaude && Array.isArray(formattedMessages) && formattedMessages.length > 0) {
      if (formattedMessages[0]?.role === 'system') {
        const sys = formattedMessages[0];
        if (typeof sys.content === 'string' && sys.content.length >= 800) {
          formattedMessages[0] = {
            ...sys,
            content: [
              {
                type: 'text',
                text: sys.content,
                cache_control: { type: 'ephemeral' }
              }
            ]
          };
        }
      }

      if (formattedMessages.length > 1 && formattedMessages[1]?.role === 'user') {
        const rootUser = formattedMessages[1];
        if (typeof rootUser.content === 'string' && rootUser.content.length >= 800) {
          formattedMessages[1] = {
            ...rootUser,
            content: [
              {
                type: 'text',
                text: rootUser.content,
                cache_control: { type: 'ephemeral' }
              }
            ]
          };
        } else if (Array.isArray(rootUser.content) && rootUser.content.length > 0) {
          const lastTextItem = [...rootUser.content].reverse().find(item => item.type === 'text');
          if (lastTextItem && (lastTextItem.text || '').length >= 400) {
            lastTextItem.cache_control = { type: 'ephemeral' };
          }
        }
      }
    }

    // Attach breakpoint to last tool in tools array for Claude
    let formattedTools = tools;
    if (isClaude && Array.isArray(tools) && tools.length > 0) {
      formattedTools = tools.map((t, idx) => {
        if (idx === tools.length - 1) {
          return {
            ...t,
            cache_control: { type: 'ephemeral' }
          };
        }
        return t;
      });
    }

    const isAgTarget = isAntigravityModel(targetModel);
    const shouldStream = options.stream !== undefined ? Boolean(options.stream) : isAgTarget;

    const payload = {
      model: targetModel,
      messages: formattedMessages,
      temperature,
      max_tokens: maxTokens,
      stream: shouldStream
    };
    if (shouldStream) {
      payload.stream_options = { include_usage: true };
    }

    if (options.maxThinkingTokens !== undefined && options.maxThinkingTokens !== null) {
      payload.max_thinking_tokens = options.maxThinkingTokens;
    }

    if (Array.isArray(formattedTools) && formattedTools.length > 0) {
      payload.tools = formattedTools;
      payload.tool_choice = options.toolChoice !== undefined ? options.toolChoice : 'auto';
    } else if (options.toolChoice !== undefined && options.toolChoice !== null) {
      payload.tool_choice = options.toolChoice;
    }

    const endpoint = baseUrl.endsWith('/') ? `${baseUrl}chat/completions` : `${baseUrl}/chat/completions`;

    if (options.budgetState && options.budgetState.limit !== undefined && options.budgetState.limit !== null) {
      const estPrompt = estimateRequestPromptTokens(payload);
      assertBudgetBeforeCall({
        used: options.budgetState.used ?? 0,
        estimatedPrompt: estPrompt,
        maxOutput: maxTokens,
        limit: options.budgetState.limit,
        budgetKind: options.budgetState.kind || 'token_budget'
      });
    }

    let timeoutId = null;
    try {
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          ...extraHeaders
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      timeoutId = null;

      if (!response.ok) {
        const errorText = await response.text();
        return {
          ok: false,
          status: response.status,
          error: `9Router returned HTTP ${response.status}: ${errorText.slice(0, 300)}`
        };
      }

      const rawText = await response.text();
      const resolved9RouterVersion = options.nineRouterVersion !== undefined
        ? options.nineRouterVersion
        : readInstalled9RouterVersion().version;

      // Check if response is Server-Sent Events stream (starts with data:)
      if (rawText.trim().startsWith('data:')) {
        const sseParsed = parseSSEResponse(rawText);
        const fallbackTools = parseToolCalls({ content: sseParsed.content });
        const mergedTools = sseParsed.tool_calls.length > 0 ? sseParsed.tool_calls : fallbackTools;
        const sseActualModel = sseParsed.model || targetModel;
        const sseNormalized = normalizeUsage(sseParsed.usage || {}, {
          streamed: true,
          nonStreamDegraded: isAgTarget && !shouldStream,
          isGemini: isGeminiModel(sseActualModel) || isGeminiModel(targetModel),
          model: targetModel,
          nineRouterVersion: resolved9RouterVersion
        });

        return {
          ok: true,
          requested_model: model,
          model_used: targetModel,
          model_responded: sseActualModel,
          actual_model: sseActualModel,
          endpoint,
          stream_used: shouldStream,
          max_tokens_sent: maxTokens,
          fallback_activated: false,
          fallback_reason: null,
          content: sseParsed.content || '',
          reasoning_content: sseParsed.reasoning_content || '',
          thought_signature: sseParsed.thought_signature || null,
          thinking_blocks: null,
          tool_calls: mergedTools,
          finish_reason: sseParsed.finish_reason || 'stop',
          usage: sseNormalized,
          raw_usage: sseParsed.usage ? JSON.parse(JSON.stringify(sseParsed.usage)) : null
        };
      }

      // Standard JSON parsing
      let json;
      try {
        json = JSON.parse(rawText);
      } catch {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          json = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error(`Failed to parse response: ${rawText.slice(0, 200)}`);
        }
      }

      const choice = json.choices?.[0];
      const message = choice?.message || {};
      const toolCalls = parseToolCalls(message);
      const jsonActualModel = json.model || targetModel;
      const hasJsonCache = extractReportedCachedTokens(json.usage) !== null;
      const isDegradedJson = isAgTarget && (!shouldStream || !hasJsonCache);
      const jsonNormalized = normalizeUsage(json.usage || {}, {
        streamed: shouldStream,
        nonStreamDegraded: isDegradedJson,
        isGemini: isGeminiModel(jsonActualModel) || isGeminiModel(targetModel),
        model: targetModel,
        nineRouterVersion: resolved9RouterVersion
      });

      return {
        ok: true,
        requested_model: model,
        model_used: targetModel,
        model_responded: jsonActualModel,
        actual_model: jsonActualModel,
        endpoint,
        stream_used: shouldStream,
        max_tokens_sent: maxTokens,
        fallback_activated: false,
        fallback_reason: null,
        content: message.content || '',
        reasoning_content: message.reasoning_content || message.thinking || '',
        thought_signature: message.thought_signature || message.signature || null,
        thinking_blocks: Array.isArray(message.thinking_blocks) ? message.thinking_blocks : null,
        tool_calls: toolCalls,
        finish_reason: choice?.finish_reason || 'stop',
        usage: jsonNormalized,
        raw_usage: json.usage ? JSON.parse(JSON.stringify(json.usage)) : null
      };
    } catch (err) {
      if (isBudgetExceededError(err)) {
        throw err;
      }
      if (err.name === 'AbortError') {
        return { ok: false, requested_model: model, endpoint, error: `Request timed out after ${timeoutMs}ms (HR-1 Bounded Execution)` };
      }
      return { ok: false, requested_model: model, endpoint, error: `Network connection failed: ${err.message}` };
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
    }
  }

  const cbOpts = { now: getNowMs(), ttlMs: circuitBreakerTtlMs };

  // Circuit Breaker check: if primary model is already marked dead in this session (within TTL) and fallback is available, skip directly
  if (isModelCircuitBroken(model, cbOpts) && fallbackModel && fallbackModel !== model) {
    const cbReason = getCircuitBrokenReason(model, cbOpts);
    console.warn(`[Circuit Breaker] Model "${model}" is circuit-broken (${cbReason}). Routing directly to fallback: ${fallbackModel}`);
    const directFallback = await executeSingleCall(fallbackModel);
    if (directFallback.ok) {
      directFallback.requested_model = model;
      directFallback.fallback_activated = true;
      directFallback.fallback_reason = `circuit_breaker: ${cbReason}`;
    }
    return directFallback;
  }
  if (isModelCircuitBroken(model, cbOpts)) {
    const cbReason = getCircuitBrokenReason(model, cbOpts);
    return {
      ok: false,
      requested_model: model,
      circuit_broken: true,
      error: `Circuit breaker open for model "${model}" (${cbReason}); skipping call until TTL expires.`
    };
  }

  // Primary model execution
  const primaryResult = await executeSingleCall(model);
  if (primaryResult.ok) {
    return primaryResult;
  }

  // Strict circuit breaker classification: NEVER trip on strange/unrelated error messages or generic 400 parameter errors.
  const errStr = String(primaryResult.error || '');
  const isUnsupportedModel400 = primaryResult.status === 400
    && /\b(?:this version of kiro is no longer supported|unsupported[_ ]?model)\b|\bmodel\b[^.\n]{0,40}\b(?:no longer supported|not supported|deprecated)\b/i.test(errStr);
  const isExplicitProviderDeadMsg = /\bno active credentials(?:\s+for provider)?\b|\bmodel_not_found\b|\binvalid_api_key\b|\bprovider\s+['"]?[a-z0-9._-]+['"]?\s+not found\b/i.test(errStr);
  const shouldTripCB = primaryResult.status === 404 || primaryResult.status === 401 || isUnsupportedModel400 || isExplicitProviderDeadMsg;

  if (shouldTripCB) {
    tripModelCircuitBreaker(model, errStr.slice(0, 160), {
      now: getNowMs(),
      ttlMs: circuitBreakerTtlMs,
      status: primaryResult.status ?? null
    });
  }

  // HTTP 400 request/parameter rejection (not unsupported model): fall back with request_rejected + warning
  const isRequestRejected400 = primaryResult.status === 400 && !shouldTripCB;
  const fallbackReasonStr = isRequestRejected400
    ? `request_rejected: ${errStr.slice(0, 180)}`
    : String(primaryResult.error || 'primary_call_failed').slice(0, 200);
  const fallbackWarning = isRequestRejected400
    ? `WARNING [Runtime Gateway] request_rejected (HTTP 400) on "${model}": ${errStr.slice(0, 180)}`
    : null;

  // Attempt fallback only when failure is retryable and fallback model is distinct
  if (shouldRetryFailure(primaryResult) && fallbackModel && fallbackModel !== model) {
    if (fallbackWarning) {
      console.warn(`${fallbackWarning}. Falling back to "${fallbackModel}" without tripping circuit breaker.`);
    } else {
      console.warn(`[Runtime Gateway] Primary model ${model} failed (${primaryResult.error}). Retrying with fallback: ${fallbackModel}...`);
    }
    const fallbackResult = await executeSingleCall(fallbackModel);
    if (fallbackResult.ok) {
      fallbackResult.requested_model = model;
      fallbackResult.fallback_activated = true;
      fallbackResult.fallback_reason = fallbackReasonStr;
      if (fallbackWarning) fallbackResult.fallback_warning = fallbackWarning;
      return fallbackResult;
    }
    return {
      ok: false,
      requested_model: model,
      fallback_activated: true,
      fallback_reason: fallbackReasonStr,
      ...(fallbackWarning ? { fallback_warning: fallbackWarning } : {}),
      error: `Primary (${model}: ${primaryResult.error}) and Fallback (${fallbackModel}: ${fallbackResult.error}) both failed.`
    };
  }

  if (fallbackWarning) {
    console.warn(fallbackWarning);
    primaryResult.fallback_warning = fallbackWarning;
  }
  return primaryResult;
}

/**
 * Calibrates the +2000 9Router buffer for the current session using one tiny (~few dozen token) probe request.
 */
export async function calibrateProviderBuffer(model, options = {}) {
  const targetModel = String(model || '').trim();
  const baseUrl = options.baseUrl || DEFAULT_9ROUTER_URL;
  const apiKey = options.apiKey || process.env.NINE_ROUTER_API_KEY || 'sk-default';
  const resolved9RouterVersion = options.nineRouterVersion !== undefined
    ? options.nineRouterVersion
    : readInstalled9RouterVersion().version;

  const startedMs = Date.now();
  const res = await callModelEndpoint({
    baseUrl,
    apiKey,
    model: targetModel,
    fallbackModel: null,
    messages: [{ role: 'user', content: 'OK' }],
    maxTokens: Number(options.maxTokens ?? 4),
    temperature: 0,
    timeoutMs: Number(options.timeoutMs ?? 20000),
    stream: options.stream,
    nineRouterVersion: resolved9RouterVersion,
    fetchFn: options.fetchFn || null
  });
  const latencyMs = Date.now() - startedMs;

  if (!res.ok) {
    return {
      ok: false,
      calibrated: false,
      model: targetModel,
      is_ag: isAntigravityModel(targetModel),
      nine_router_version: resolved9RouterVersion,
      latency_ms: latencyMs,
      error: res.error || 'Calibration probe failed'
    };
  }

  const rawPromptTokens = Number(res.raw_usage?.prompt_tokens ?? res.raw_usage?.input_tokens ?? res.usage?.prompt_tokens_raw ?? 0);
  const record = calibrateBufferFromProbeResult({
    model: targetModel,
    rawPromptTokens,
    actualModel: res.actual_model || targetModel,
    nineRouterVersion: resolved9RouterVersion
  });

  return {
    ok: true,
    ...record,
    latency_ms: latencyMs,
    raw_usage: res.raw_usage ?? null
  };
}

export async function runSessionBufferCalibrationMatrix(options = {}) {
  const models = Array.isArray(options.models) && options.models.length > 0
    ? options.models
    : [];
  const results = [];
  for (const m of models) {
    results.push(await calibrateProviderBuffer(m, options));
  }
  return {
    checked_at: new Date().toISOString(),
    nine_router_version: options.nineRouterVersion !== undefined
      ? options.nineRouterVersion
      : readInstalled9RouterVersion().version,
    threshold: BUFFER_CALIBRATION_THRESHOLD,
    results,
    session_flags: listSessionBufferCalibrations()
  };
}
