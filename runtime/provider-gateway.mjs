#!/usr/bin/env node
/**
 * 9Router Provider Gateway & Capability Matrix Adapter
 * Part of Agent Runtime (agent-team/runtime/provider-gateway.mjs)
 */

export const DEFAULT_9ROUTER_URL = 'http://127.0.0.1:20128/v1';
export const DEFAULT_TIMEOUT_MS = 90000; // 90s hard timeout (HR-1)

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
      if (chunk.usage) rawUsage = chunk.usage;
      const delta = chunk.choices?.[0]?.delta || chunk.choices?.[0]?.message || {};
      if (delta.content) content += delta.content;
      if (delta.reasoning_content) reasoningContent += delta.reasoning_content;
      if (delta.thinking) reasoningContent += delta.thinking;
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
 * Normalizes usage telemetry across OpenAI, Anthropic, and 9Router formats,
 * calculating uncached input and cache hit ratios.
 */
export function normalizeUsage(raw = {}) {
  const cached = Number(
    raw?.cache_read_input_tokens
    ?? raw?.prompt_tokens_details?.cached_tokens
    ?? raw?.cached_tokens
    ?? 0
  );
  const cacheCreation = Number(raw?.cache_creation_input_tokens ?? 0);
  const rawInput = Number(raw?.prompt_tokens ?? raw?.input_tokens ?? 0);
  const completion = Number(raw?.completion_tokens ?? raw?.output_tokens ?? 0);
  const totalPrompt = raw?.cache_read_input_tokens !== undefined
    ? (rawInput + cached + cacheCreation)
    : rawInput;
  const uncachedInput = Math.max(0, totalPrompt - cached);

  return {
    prompt_tokens: totalPrompt,
    uncached_input_tokens: uncachedInput,
    cached_tokens: cached,
    completion_tokens: completion,
    total_tokens: totalPrompt + completion,
    cache_hit_ratio: totalPrompt > 0 ? Number((cached / totalPrompt).toFixed(4)) : 0
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
    maxTokens = 8192,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fallbackModel = null,
    extraHeaders = {}
  } = options;

  if (!model) {
    return { ok: false, error: 'Model identifier is required' };
  }

  async function executeSingleCall(targetModel) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

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

    const payload = {
      model: targetModel,
      messages: formattedMessages,
      temperature,
      max_tokens: maxTokens,
      stream: false // Explicitly disable streaming
    };

    if (options.maxThinkingTokens !== undefined && options.maxThinkingTokens !== null) {
      payload.max_thinking_tokens = options.maxThinkingTokens;
    }

    if (Array.isArray(formattedTools) && formattedTools.length > 0) {
      payload.tools = formattedTools;
      payload.tool_choice = 'auto';
    }

    const endpoint = baseUrl.endsWith('/') ? `${baseUrl}chat/completions` : `${baseUrl}/chat/completions`;

    try {
      const response = await fetch(endpoint, {
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

      if (!response.ok) {
        const errorText = await response.text();
        return {
          ok: false,
          status: response.status,
          error: `9Router returned HTTP ${response.status}: ${errorText.slice(0, 300)}`
        };
      }

      const rawText = await response.text();

      // Check if response is Server-Sent Events stream (starts with data:)
      if (rawText.trim().startsWith('data:')) {
        const sseParsed = parseSSEResponse(rawText);
        const fallbackTools = parseToolCalls({ content: sseParsed.content });
        const mergedTools = sseParsed.tool_calls.length > 0 ? sseParsed.tool_calls : fallbackTools;

        return {
          ok: true,
          model_used: targetModel,
          model_responded: sseParsed.model || targetModel,
          content: sseParsed.content || '',
          reasoning_content: sseParsed.reasoning_content || '',
          thought_signature: sseParsed.thought_signature || null,
          thinking_blocks: null,
          tool_calls: mergedTools,
          finish_reason: sseParsed.finish_reason || 'stop',
          usage: normalizeUsage(sseParsed.usage)
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

      return {
        ok: true,
        model_used: targetModel,
        model_responded: json.model || targetModel,
        content: message.content || '',
        reasoning_content: message.reasoning_content || message.thinking || '',
        thought_signature: message.thought_signature || message.signature || null,
        thinking_blocks: Array.isArray(message.thinking_blocks) ? message.thinking_blocks : null,
        tool_calls: toolCalls,
        finish_reason: choice?.finish_reason || 'stop',
        usage: normalizeUsage(json.usage)
      };
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        return { ok: false, error: `Request timed out after ${timeoutMs}ms (HR-1 Bounded Execution)` };
      }
      return { ok: false, error: `Network connection failed: ${err.message}` };
    }
  }

  // Primary model execution
  const primaryResult = await executeSingleCall(model);
  if (primaryResult.ok) {
    return primaryResult;
  }

  // Attempt fallback if configured and primary call failed
  if (fallbackModel && fallbackModel !== model) {
    console.warn(`[Runtime Gateway] Primary model ${model} failed (${primaryResult.error}). Retrying with fallback: ${fallbackModel}...`);
    const fallbackResult = await executeSingleCall(fallbackModel);
    if (fallbackResult.ok) {
      fallbackResult.fallback_activated = true;
      return fallbackResult;
    }
    return {
      ok: false,
      error: `Primary (${model}: ${primaryResult.error}) and Fallback (${fallbackModel}: ${fallbackResult.error}) both failed.`
    };
  }

  return primaryResult;
}
