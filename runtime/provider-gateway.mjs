#!/usr/bin/env node
/**
 * 9Router Provider Gateway & Capability Matrix Adapter
 * Part of Agent Runtime (agent-team/runtime/provider-gateway.mjs)
 */

export const DEFAULT_9ROUTER_URL = 'http://127.0.0.1:20128/v1';
export const DEFAULT_TIMEOUT_MS = 90000; // 90s hard timeout (HR-1)

/**
 * Capability Matrix: Maps known models to their operational capabilities.
 */
export const CAPABILITY_MATRIX = {
  // Claude 3.7 / 3.5 / 4.5 Thinking profiles
  'kr/claude-sonnet-4.5-thinking': {
    supports_vision: true,
    supports_multimodal: true,
    supports_tool_calls: true,
    supports_long_context: true,
    supports_json_schema: true,
    supports_code_generation: true,
    max_context_tokens: 200000
  },
  'claude-sonnet-4.5': {
    supports_vision: true,
    supports_multimodal: true,
    supports_tool_calls: true,
    supports_long_context: true,
    supports_json_schema: true,
    supports_code_generation: true,
    max_context_tokens: 200000
  },
  'ag/claude-opus-5-5-high': {
    supports_vision: true,
    supports_multimodal: true,
    supports_tool_calls: true,
    supports_long_context: true,
    supports_json_schema: true,
    supports_code_generation: true,
    max_context_tokens: 200000
  },
  // DeepSeek coding models
  'Deepseek V4.1 Flash/deepseek-ai/deepseek-v4.1-flash-1017': {
    supports_vision: false,
    supports_multimodal: false,
    supports_tool_calls: true,
    supports_long_context: true,
    supports_json_schema: true,
    supports_code_generation: true,
    max_context_tokens: 128000
  },
  'deepseek-ai/deepseek-v4.1-flash-1017': {
    supports_vision: false,
    supports_multimodal: false,
    supports_tool_calls: true,
    supports_long_context: true,
    supports_json_schema: true,
    supports_code_generation: true,
    max_context_tokens: 128000
  },
  'deepseek-chat': {
    supports_vision: false,
    supports_multimodal: false,
    supports_tool_calls: true,
    supports_long_context: true,
    supports_json_schema: true,
    supports_code_generation: true,
    max_context_tokens: 64000
  }
};

/**
 * Returns capability flags for any given model ID (with safe heuristics for unknowns).
 */
export function getModelCapabilities(modelId = '') {
  const normalized = String(modelId).toLowerCase();
  
  if (CAPABILITY_MATRIX[modelId]) {
    return { ...CAPABILITY_MATRIX[modelId] };
  }

  // Heuristics for unknown model IDs
  const isClaude = normalized.includes('claude');
  const isGpt4 = normalized.includes('gpt-4') || normalized.includes('o1') || normalized.includes('o3');
  const isGemini = normalized.includes('gemini');
  const isVision = isClaude || isGpt4 || isGemini || normalized.includes('vision');

  return {
    supports_vision: isVision,
    supports_multimodal: isVision,
    supports_tool_calls: isClaude || isGpt4 || normalized.includes('instruct'),
    supports_long_context: isClaude || isGemini || normalized.includes('128k') || normalized.includes('200k'),
    supports_json_schema: isGpt4 || isClaude,
    supports_code_generation: true,
    max_context_tokens: isClaude || isGemini ? 200000 : 64000
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
        arguments: parsedArgs
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
  const toolCallsMap = new Map();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const dataStr = trimmed.slice(5).trim();
    if (dataStr === '[DONE]') break;
    try {
      const chunk = JSON.parse(dataStr);
      if (chunk.model) model = chunk.model;
      const delta = chunk.choices?.[0]?.delta || chunk.choices?.[0]?.message || {};
      if (delta.content) content += delta.content;
      if (chunk.choices?.[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCallsMap.has(idx)) {
            toolCallsMap.set(idx, { id: tc.id || '', name: tc.function?.name || '', argsText: '' });
          }
          const existing = toolCallsMap.get(idx);
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) existing.argsText += tc.function.arguments;
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
    finalToolCalls.push({ id: tc.id || `call_${Date.now()}`, name: tc.name, arguments: args });
  }

  return {
    content,
    model,
    finish_reason: finishReason,
    tool_calls: finalToolCalls
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

    const payload = {
      model: targetModel,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false // Explicitly disable streaming
    };

    if (Array.isArray(tools) && tools.length > 0) {
      payload.tools = tools;
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
          tool_calls: mergedTools,
          finish_reason: sseParsed.finish_reason || 'stop',
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
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
        tool_calls: toolCalls,
        finish_reason: choice?.finish_reason || 'stop',
        usage: json.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
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
