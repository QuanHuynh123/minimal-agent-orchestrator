import { resolveApiKey, verifyResponseModel } from './risk-policy.mjs';
import {
  BudgetExceededError,
  calibrateBufferFromProbeResult,
  callModelEndpoint,
  isBudgetExceededError,
  isModelCircuitBroken,
  readInstalled9RouterVersion,
  resolve9RouterPackageJsonPaths
} from '../../runtime/provider-gateway.mjs';

export { BudgetExceededError, isBudgetExceededError, isModelCircuitBroken, readInstalled9RouterVersion, resolve9RouterPackageJsonPaths };

/**
 * Single-attempt Healthcheck to 9Router /models endpoint
 */
export async function check9RouterHealth(teamCfg = {}, policyCfg = {}) {
  const baseUrl = teamCfg.providers?.local_9router?.base_url || 'http://127.0.0.1:20128/v1';
  const apiKey = resolveApiKey(teamCfg);
  const guardrails = policyCfg.policy?.execution_guardrails || {};
  const timeoutSec = Math.min(
    guardrails.healthcheck_timeout_sec || 15,
    guardrails.network_max_time_sec || 15
  );

  try {
    const res = await fetch(`${baseUrl}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutSec * 1000)
    });
    if (res.ok) {
      return { ok: true, status: res.status };
    }
    return { ok: false, error: `9Router healthcheck returned HTTP ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      error: `9Router unreachable at ${baseUrl} (timeout ${timeoutSec}s): ${err.message}`
    };
  }
}

/**
 * Healthcheck with retry backoff
 */
export async function check9RouterHealthWithRetry(teamCfg = {}, policyCfg = {}, delaysMs = [0, 5000, 15000]) {
  let lastRes = { ok: false, error: 'Healthcheck did not run' };
  for (let i = 0; i < delaysMs.length; i++) {
    if (delaysMs[i] > 0) {
      console.warn(`[Orchestrator] 9Router healthcheck attempt ${i} failed (${lastRes.error}). Retrying in ${delaysMs[i] / 1000}s...`);
      await new Promise(r => setTimeout(r, delaysMs[i]));
    }
    lastRes = await check9RouterHealth(teamCfg, policyCfg);
    if (lastRes.ok) return lastRes;
  }
  return lastRes;
}

function resolveDisabledModelSet(entries = []) {
  const disabled = new Set();
  for (const item of (Array.isArray(entries) ? entries : [])) {
    if (typeof item === 'string' && item.trim()) {
      disabled.add(item.trim());
    } else if (item && typeof item === 'object' && item.disabled !== false) {
      const id = String(item.id || item.model || '').trim();
      if (id) disabled.add(id);
    }
  }
  return disabled;
}

/**
 * Collects unique enabled models across all active roles in team.yaml,
 * excluding entries marked disabled in `disabled_models` or per-model objects.
 */
export function collectActiveRosterModels(teamCfg = {}) {
  const globalDisabled = resolveDisabledModelSet(teamCfg?.disabled_models);
  const byModel = new Map();
  const roles = teamCfg?.roles || {};

  for (const [roleName, roleCfg] of Object.entries(roles)) {
    if (!roleCfg || roleCfg.enabled === false) continue;
    const roleDisabled = new Set([...globalDisabled, ...resolveDisabledModelSet(roleCfg.disabled_models)]);

    const candidates = [];
    for (const raw of [roleCfg.model, roleCfg.default_model, roleCfg.fallback_model]) {
      if (typeof raw === 'string' && raw.trim()) {
        candidates.push(raw.trim());
      }
    }
    if (Array.isArray(roleCfg.models)) {
      for (const m of roleCfg.models) {
        if (typeof m === 'string' && m.trim()) {
          candidates.push(m.trim());
        } else if (m && typeof m === 'object') {
          const id = String(m.id || m.model || '').trim();
          if (!id) continue;
          if (m.disabled === true) {
            roleDisabled.add(id);
          } else {
            candidates.push(id);
          }
        }
      }
    }

    for (const modelId of candidates) {
      if (roleDisabled.has(modelId)) continue;
      if (!byModel.has(modelId)) {
        byModel.set(modelId, new Set());
      }
      byModel.get(modelId).add(roleName);
    }
  }

  return [...byModel.entries()].map(([model, roleSet]) => ({
    model,
    roles: [...roleSet]
  }));
}

/**
 * Returns true if a preflight ping failure is transient (timeout, network error, 408, 429, or 5xx)
 * and safe to retry before declaring preflight_failed.
 */
export function isTransientPreflightFailure(res) {
  if (!res || res.ok) return false;
  const status = res.status !== null && res.status !== undefined && res.status !== ''
    ? Number(res.status)
    : null;
  if (status !== null && Number.isFinite(status) && status > 0) {
    if (status === 408 || status === 429 || status >= 500) return true;
    if (status >= 400 && status < 500) return false;
  }
  const errStr = String(res.error || '');
  if (/\bHTTP\s+(400|401|402|403|404|422)\b/i.test(errStr)) return false;
  return true;
}

/**
 * Resolves recorded preflight attempt count for a requested/active model from runRosterPreflightPing().
 */
export function summarizePreflightAttempts(rosterPreflight, modelId) {
  if (!rosterPreflight || typeof rosterPreflight !== 'object') return null;
  if (modelId && rosterPreflight.preflight_attempts_by_model && Object.prototype.hasOwnProperty.call(rosterPreflight.preflight_attempts_by_model, modelId)) {
    return Number(rosterPreflight.preflight_attempts_by_model[modelId]);
  }
  if (modelId && Array.isArray(rosterPreflight.checked_models)) {
    const match = rosterPreflight.checked_models.find(c => c && c.model === modelId);
    if (match && Number.isFinite(Number(match.preflight_attempts))) {
      return Number(match.preflight_attempts);
    }
  }
  if (Number.isFinite(Number(rosterPreflight.preflight_attempts)) && Number(rosterPreflight.preflight_attempts) > 0) {
    return Number(rosterPreflight.preflight_attempts);
  }
  return null;
}

/**
 * Preflight roster check: pings every active model in the team roster with
 * strictly 1 output token (`max_tokens: 1`), retrying transient errors (timeout / network / 5xx)
 * up to `maxRetries` times (default 2 => max 3 attempts). Fails loudly on permanent errors with zero silent fallback.
 */
export async function runRosterPreflightPing(teamCfg = {}, policyCfg = {}, options = {}) {
  const baseUrl = teamCfg.providers?.local_9router?.base_url || 'http://127.0.0.1:20128/v1';
  const apiKey = resolveApiKey(teamCfg);
  const guardrails = policyCfg?.policy?.execution_guardrails || {};
  const timeoutMs = Number(
    options.timeoutMs
    || (guardrails.healthcheck_timeout_sec || 15) * 1000
  );
  const rawMaxRetries = options.maxRetries !== undefined
    ? Number(options.maxRetries)
    : (guardrails.preflight_max_retries !== undefined ? Number(guardrails.preflight_max_retries) : 2);
  const maxRetries = Number.isFinite(rawMaxRetries) ? Math.max(0, Math.floor(rawMaxRetries)) : 2;
  const retryDelaysMs = Array.isArray(options.retryDelaysMs)
    ? options.retryDelaysMs.map(d => Math.max(0, Number(d) || 0))
    : (options.retryDelayMs !== undefined
        ? Array.from({ length: Math.max(1, maxRetries) }, () => Math.max(0, Number(options.retryDelayMs) || 0))
        : [2000, 4000]);
  const sleepFn = typeof options.sleepFn === 'function'
    ? options.sleepFn
    : (ms => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve()));
  const roster = collectActiveRosterModels(teamCfg);

  if (roster.length === 0) {
    return {
      ok: false,
      checked_models: [],
      failed_models: [],
      errors: ['No enabled non-disabled models configured in team.yaml roles'],
      preflight_attempts: 0,
      preflight_attempts_by_model: {}
    };
  }

  const checked_models = [];
  const failed_models = [];
  const errors = [];
  const preflight_attempts_by_model = {};
  let maxAttemptsObserved = 0;

  for (const entry of roster) {
    const startedMs = Date.now();
    let res = null;
    let attempts = 0;

    for (let attempt = 1; attempt <= 1 + maxRetries; attempt++) {
      attempts = attempt;
      res = await callModelEndpoint({
        baseUrl,
        apiKey,
        model: entry.model,
        fallbackModel: null, // Strictly prohibit silent fallback during preflight ping
        messages: [{ role: 'user', content: 'OK' }],
        maxTokens: 1,
        temperature: 0,
        timeoutMs,
        fetchFn: options.fetchFn || null
      });
      if (res.ok) break;
      if (attempt <= maxRetries && isTransientPreflightFailure(res)) {
        const delayMs = retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)] ?? 2000;
        console.warn(`[Preflight] Transient ping failure for "${entry.model}" (attempt ${attempt}/${1 + maxRetries}): ${res.error || 'Unknown error'}. Retrying in ${delayMs}ms...`);
        await sleepFn(delayMs);
        continue;
      }
      break;
    }

    const latency_ms = Date.now() - startedMs;
    preflight_attempts_by_model[entry.model] = attempts;
    maxAttemptsObserved = Math.max(maxAttemptsObserved, attempts);

    if (!res?.ok) {
      const detail = res?.error || 'Unknown error';
      const msg = `Preflight model ping failed for "${entry.model}" (roles: ${entry.roles.join(', ')}, attempts: ${attempts}): ${detail}. No silent fallback permitted.`;
      failed_models.push({
        model: entry.model,
        roles: entry.roles,
        status: res?.status || null,
        latency_ms,
        preflight_attempts: attempts,
        error: detail
      });
      errors.push(msg);
      checked_models.push({
        model: entry.model,
        roles: entry.roles,
        ok: false,
        latency_ms,
        preflight_attempts: attempts,
        error: detail
      });
      continue;
    }

    const rawPromptTokens = Number(res.raw_usage?.prompt_tokens ?? res.raw_usage?.input_tokens ?? res.usage?.prompt_tokens_raw ?? 0);
    const calibration = options.calibrateBuffer === false
      ? null
      : calibrateBufferFromProbeResult({
          model: entry.model,
          rawPromptTokens,
          actualModel: res.actual_model || entry.model,
          nineRouterVersion: readInstalled9RouterVersion().version
        });

    checked_models.push({
      model: entry.model,
      roles: entry.roles,
      ok: true,
      actual_model: res.actual_model || entry.model,
      latency_ms,
      preflight_attempts: attempts,
      calibration_flag: calibration?.calibration_flag || null,
      buffer_amount: calibration?.buffer_amount ?? null,
      usage: res.raw_usage ?? res.usage ?? null
    });
  }

  return {
    ok: failed_models.length === 0,
    checked_models,
    failed_models,
    errors,
    preflight_attempts: maxAttemptsObserved,
    preflight_attempts_by_model,
    buffer_calibrations: checked_models
      .filter(c => c.ok && c.calibration_flag)
      .map(c => ({ model: c.model, calibration_flag: c.calibration_flag, buffer_amount: c.buffer_amount }))
  };
}

export function formatWriterPreflightFallbackWarning(rosterPreflight = {}, writerFallbackProbe = {}) {
  const failedList = Array.isArray(rosterPreflight?.failed_models) ? rosterPreflight.failed_models : [];
  const errList = Array.isArray(rosterPreflight?.errors) ? rosterPreflight.errors : [];
  const detailParts = failedList.length > 0
    ? failedList.map(fm => {
        const statusPart = fm?.status ? `HTTP ${fm.status}` : '';
        const latPart = Number.isFinite(fm?.latency_ms) ? `${fm.latency_ms}ms` : '';
        const attPart = Number(fm?.preflight_attempts) > 1 ? `attempts=${fm.preflight_attempts}` : '';
        const meta = [statusPart, latPart, attPart].filter(Boolean).join(', ');
        const errText = fm?.error || 'Unknown error';
        return `"${fm?.model || '<unknown>'}"${meta ? ` [${meta}]` : ''}: ${errText}`;
      })
    : errList;
  const detailsText = detailParts.length > 0 ? detailParts.join(' | ') : 'No preflight error details captured';
  return `[Orchestrator] Pre-flight writer primary failed; promoting fallback "${writerFallbackProbe.actual_model || '<unknown>'}" (reason: ${writerFallbackProbe.reason || 'preflight_failed'}) | details: ${detailsText}`;
}

/**
 * Pure 9Router Chat Completion Client with fallback model and timeout guardrails
 */
export async function call9Router(model, systemPrompt, userMessage, maxTokens = 4096, fallbackModel = null, temperature = 0.1, options = {}) {
  const teamCfg = options.teamConfig || {};
  const policyCfg = options.policyConfig || {};

  const baseUrl = teamCfg.providers?.local_9router?.base_url || 'http://127.0.0.1:20128/v1';
  const apiKey = resolveApiKey(teamCfg);
  const timeoutSec = policyCfg.policy?.execution_guardrails?.default_cli_timeout_sec
    || teamCfg.providers?.ide_bridge?.timeout_sec
    || 120;
  const timeoutMs = timeoutSec * 1000;
  const strictModelMatch = options.strictModelMatch ?? policyCfg.policy?.execution_guardrails?.strict_model_match ?? true;
  const fetchImpl = typeof options.fetchFn === 'function' ? options.fetchFn : globalThis.fetch;

  const modelsToTry = [model, ...(fallbackModel && fallbackModel !== model ? [fallbackModel] : [])];
  let lastError = 'Unknown API error';

  for (const candidateModel of modelsToTry) {
    try {
      const gwRes = await callModelEndpoint({
        baseUrl,
        apiKey,
        model: candidateModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        maxTokens,
        temperature,
        timeoutMs,
        maxThinkingTokens: options.maxThinkingTokens,
        stream: options.stream,
        ...(options.nineRouterVersion !== undefined ? { nineRouterVersion: options.nineRouterVersion } : {}),
        fetchFn: fetchImpl
      });

      if (!gwRes.ok) {
        lastError = gwRes.status
          ? `HTTP ${gwRes.status} (${candidateModel}): ${gwRes.error}`
          : `${candidateModel}: ${gwRes.error}`;
        if (gwRes.budget_exceeded || gwRes.nonRetryable) {
          return { ok: false, budget_exceeded: Boolean(gwRes.budget_exceeded), nonRetryable: true, error: lastError };
        }
        continue;
      }

      const rawContent = gwRes.content || '';
      const reasoning = gwRes.reasoning_content || '';
      const finishReason = gwRes.finish_reason || 'unknown';
      const responseModel = (typeof gwRes.model_responded === 'string' && gwRes.model_responded.trim())
        ? gwRes.model_responded.trim()
        : 'unknown';

      const modelCheck = verifyResponseModel(candidateModel, responseModel, { policyConfig: policyCfg });
      if (!modelCheck.match) {
        console.warn(`[9Router] MODEL MISMATCH WARNING: ${modelCheck.reason}`);
        if (strictModelMatch && responseModel !== 'unknown') {
          lastError = `Model mismatch rejected by policy: ${modelCheck.reason}`;
          continue;
        }
      }

      let content = rawContent;
      if (!content.includes('<<<<<<< SEARCH') && reasoning.includes('<<<<<<< SEARCH')) {
        content = reasoning;
      }
      const rawUsage = gwRes.raw_usage ? JSON.parse(JSON.stringify(gwRes.raw_usage)) : null;
      const usage = gwRes.usage || { prompt_tokens: 0, completion_tokens: 0, reported_cached_tokens: null };
      const actualModel = responseModel !== 'unknown' ? responseModel : candidateModel;
      return {
        ok: true,
        content,
        rawContent,
        rawReasoning: reasoning,
        finishReason,
        usage,
        raw_usage: rawUsage,
        endpoint: gwRes.endpoint || baseUrl,
        stream_used: gwRes.stream_used,
        requested_model: model,
        requestedModel: model,
        actual_model: actualModel,
        actualModel,
        fallback_activated: candidateModel !== model,
        fallback_reason: candidateModel !== model ? lastError : null,
        modelUsed: candidateModel,
        responseModel,
        modelMatched: modelCheck.match
      };
    } catch (err) {
      if (isBudgetExceededError(err)) {
        throw err;
      }
      lastError = `${candidateModel}: ${err.name === 'TimeoutError' ? `Request timed out after ${timeoutSec}s` : err.message}`;
    }
  }

  return { ok: false, error: lastError };
}
