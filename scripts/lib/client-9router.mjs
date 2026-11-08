import { resolveApiKey, verifyResponseModel } from './risk-policy.mjs';

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

  const modelsToTry = [model, ...(fallbackModel && fallbackModel !== model ? [fallbackModel] : [])];
  let lastError = 'Unknown API error';

  for (const candidateModel of modelsToTry) {
    try {
      // Prompt Caching breakpoint: attach ephemeral cache_control for Claude models on system role
      const isClaude = candidateModel.toLowerCase().includes('claude');
      const systemContent = (isClaude && typeof systemPrompt === 'string' && systemPrompt.length >= 800)
        ? [
            {
              type: 'text',
              text: systemPrompt,
              cache_control: { type: 'ephemeral' }
            }
          ]
        : systemPrompt;

      const reqBody = {
        model: candidateModel,
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: userMessage }
        ],
        max_tokens: maxTokens,
        temperature
      };
      if (options.maxThinkingTokens !== undefined && options.maxThinkingTokens !== null) {
        reqBody.max_thinking_tokens = options.maxThinkingTokens;
      }

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(timeoutMs)
      });

      if (!res.ok) {
        const errText = await res.text();
        lastError = `HTTP ${res.status} (${candidateModel}): ${errText}`;
        continue;
      }

      const rawText = await res.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          data = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error(`Failed to parse JSON response: ${rawText.slice(0, 200)}`);
        }
      }
      const rawContent = data.choices?.[0]?.message?.content || '';
      const reasoning = data.choices?.[0]?.message?.reasoning_content || '';
      const finishReason = data.choices?.[0]?.finish_reason || 'unknown';
      const responseModel = (typeof data.model === 'string' && data.model.trim()) ? data.model.trim() : 'unknown';

      const modelCheck = verifyResponseModel(candidateModel, responseModel);
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
      const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0 };
      return {
        ok: true,
        content,
        rawContent,
        rawReasoning: reasoning,
        finishReason,
        usage,
        modelUsed: candidateModel,
        responseModel,
        modelMatched: modelCheck.match
      };
    } catch (err) {
      lastError = `${candidateModel}: ${err.name === 'TimeoutError' ? `Request timed out after ${timeoutSec}s` : err.message}`;
    }
  }

  return { ok: false, error: lastError };
}
