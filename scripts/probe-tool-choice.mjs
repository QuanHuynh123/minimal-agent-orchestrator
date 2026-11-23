#!/usr/bin/env node
/**
 * Batch 169 Item 5: Verify `tools` + `tool_choice: "none"` forwarding through 9Router on Gemini Flash.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_9ROUTER_URL,
  callModelEndpoint,
  readInstalled9RouterVersion
} from '../runtime/provider-gateway.mjs';
import { TOOL_SCHEMAS } from '../runtime/tool-runtime.mjs';

const __filename = fileURLToPath(import.meta.url);

export async function probeToolChoiceNone(options = {}) {
  const model = options.model || 'ag/gemini-3.8-flash-medium';
  const baseUrl = options.baseUrl || DEFAULT_9ROUTER_URL;
  const apiKey = options.apiKey || process.env.NINE_ROUTER_API_KEY || 'sk-default';
  const nineRouterVersion = options.nineRouterVersion !== undefined
    ? options.nineRouterVersion
    : readInstalled9RouterVersion().version;

  let capturedRequest = null;
  const baseFetch = options.fetchFn || globalThis.fetch;
  const spyFetch = async (url, init = {}) => {
    try { capturedRequest = JSON.parse(String(init.body || '{}')); } catch {}
    return baseFetch(url, init);
  };

  const startedMs = Date.now();
  const res = await callModelEndpoint({
    baseUrl,
    apiKey,
    model,
    fallbackModel: null,
    tools: [TOOL_SCHEMAS.list_files],
    toolChoice: 'none',
    messages: [
      {
        role: 'system',
        content: 'You are testing tool_choice="none". Follow the user prompt.'
      },
      {
        role: 'user',
        content: 'Call list_files on directory "core" right now. Do NOT answer without calling list_files if tools are enabled; otherwise reply "NO_TOOL_CALL_OK".'
      }
    ],
    maxTokens: 128,
    temperature: 0,
    timeoutMs: Number(options.timeoutMs ?? 20000),
    stream: true,
    nineRouterVersion,
    fetchFn: spyFetch
  });
  const latencyMs = Date.now() - startedMs;

  if (!res.ok) {
    return {
      ok: false,
      nine_router_version: nineRouterVersion,
      model,
      tools_sent_count: Array.isArray(capturedRequest?.tools) ? capturedRequest.tools.length : 0,
      tool_choice_sent: capturedRequest?.tool_choice ?? null,
      tool_calls_count: 0,
      tool_choice_none_respected: false,
      latency_ms: latencyMs,
      error: res.error || 'probe call failed'
    };
  }

  const toolCalls = Array.isArray(res.tool_calls) ? res.tool_calls : [];
  return {
    ok: true,
    nine_router_version: nineRouterVersion,
    model,
    actual_model: res.actual_model || model,
    tools_sent_count: Array.isArray(capturedRequest?.tools) ? capturedRequest.tools.length : 0,
    tool_choice_sent: capturedRequest?.tool_choice ?? null,
    tool_calls_count: toolCalls.length,
    tool_calls: toolCalls,
    finish_reason: res.finish_reason || null,
    tool_choice_none_respected: toolCalls.length === 0,
    content_preview: String(res.content || '').slice(0, 200),
    latency_ms: latencyMs,
    usage: res.usage ?? null,
    raw_usage: res.raw_usage ?? null
  };
}

function parseArgs(argv) {
  const args = { live: argv.includes('--live'), model: 'ag/gemini-3.8-flash-medium', out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model' && argv[i + 1]) args.model = argv[++i];
    else if (argv[i] === '--out' && argv[i + 1]) args.out = path.resolve(argv[++i]);
  }
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const cli = parseArgs(process.argv.slice(2));
  if (!cli.live) {
    console.error('Usage: node agent-team/scripts/probe-tool-choice.mjs --live [--model ag/gemini-3.8-flash-medium] [--out file.json]');
    process.exit(2);
  }
  console.log(`[Budget Plan] ${cli.model} tool_choice="none" probe: 1 run x ~350 est. fresh tokens = ~350 total (Claude=0 / 60000).`);
  const report = await probeToolChoiceNone({ model: cli.model });
  if (cli.out) {
    fs.mkdirSync(path.dirname(cli.out), { recursive: true });
    fs.writeFileSync(cli.out, JSON.stringify(report, null, 2), 'utf8');
  }
  console.log(JSON.stringify(report, null, 2));
}
