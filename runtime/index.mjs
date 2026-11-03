#!/usr/bin/env node
/**
 * Agent Runtime Core Entrypoint (Standalone CLI & Programmatic API)
 * Part of Agent Runtime (agent-team/runtime/index.mjs)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { resolveRepoRoot } from '../scripts/applier.mjs';
import { buildUserMessage } from './context-adapter.mjs';
import { callModelEndpoint, getModelCapabilities } from './provider-gateway.mjs';
import { compactMessagesForContext, loadSession, saveSession } from './session-store.mjs';
import { executeTool, getAvailableToolSchemas } from './tool-runtime.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const TEAM_DIR = path.resolve(__dirname, '..');
export const ROLES_DIR = path.resolve(TEAM_DIR, 'roles');
export const CONFIG_FILE = path.resolve(TEAM_DIR, 'config', 'team.yaml');

export const MAX_AGENT_TOOL_TURNS = 4; // Hard ceiling to prevent infinite tool loops

/**
 * Loads team role & provider configuration from team.yaml.
 * Supports 1-Model Minimal Onboarding: if a specialized role is omitted or disabled in team.yaml,
 * it automatically inherits roles.writer.model so newcomers only need 1 working model.
 */
export function loadRoleConfig(roleName = 'designer', customTeamCfg = null) {
  let teamCfg = customTeamCfg || {};
  if (!customTeamCfg && fs.existsSync(CONFIG_FILE)) {
    try {
      teamCfg = YAML.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
    } catch {}
  }

  const providerCfg = teamCfg.providers?.local_9router || {};
  const baseUrl = providerCfg.base_url || 'http://127.0.0.1:20128/v1';
  const envName = providerCfg.api_key_env || 'NINE_ROUTER_API_KEY';
  const apiKey = (process.env[envName] && process.env[envName].trim())
    ? process.env[envName].trim()
    : (providerCfg.default_key || 'sk-default');

  const roles = teamCfg.roles || {};
  const writerCfg = roles.writer || {};
  const roleCfg = roles[roleName] || {};

  // Resolve default tools by role archetype
  let defaultTools = ['read_file', 'list_files', 'search_code'];
  let fallbackDefaultModel = writerCfg.model || 'kr/claude-sonnet-4.5-thinking';

  if (roleName === 'writer' || roleName === 'backend_writer') {
    defaultTools = ['read_file', 'list_files', 'search_code', 'apply_patch', 'run_validator', 'run_command'];
    fallbackDefaultModel = writerCfg.model || 'deepseek-ai/deepseek-v4.1-flash-1017';
  } else if (roleName === 'designer') {
    defaultTools = ['read_file', 'list_files', 'search_code', 'apply_patch', 'run_validator', 'run_command'];
    fallbackDefaultModel = roles.router?.model || writerCfg.model || 'kr/claude-sonnet-4.5-thinking';
  } else if (roleName === 'reviewer') {
    defaultTools = ['read_file', 'search_code'];
    fallbackDefaultModel = writerCfg.model || 'ag/claude-opus-5-5-high';
  }

  const resolvedModel = (roleCfg.enabled !== false && roleCfg.model)
    ? roleCfg.model
    : fallbackDefaultModel;

  return {
    name: roleName,
    display_name: roleCfg.display_name || roleName,
    model: resolvedModel,
    fallback_model: roleCfg.fallback_model || writerCfg.fallback_model || writerCfg.model || null,
    allowed_tools: roleCfg.allowed_tools || defaultTools,
    allowed_scope: roleCfg.allowed_scope || [],
    temperature: roleCfg.temperature ?? 0.2,
    base_url: baseUrl,
    api_key: apiKey
  };
}

/**
 * Loads system prompt markdown for role
 */
export function loadRoleSystemPrompt(roleName) {
  const roleFile = path.resolve(ROLES_DIR, `${roleName}.md`);
  if (fs.existsSync(roleFile)) {
    try {
      return fs.readFileSync(roleFile, 'utf8');
    } catch {}
  }
  return `You are a specialized ${roleName} agent operating within a software repository. You have access to tools to inspect files and propose exact modifications.`;
}

/**
 * Programmatic API: Runs a complete standalone agent loop with vision, tools, and session memory.
 */
export async function runAgent(options = {}) {
  const {
    role = 'designer',
    sessionId = null,
    prompt = '',
    images = [],
    files = [],
    scope = [],
    model: modelOverride = null,
    timeoutMs = 90000,
    repoRoot = resolveRepoRoot(),
    maxTurns = MAX_AGENT_TOOL_TURNS
  } = options;

  if (!prompt && images.length === 0 && files.length === 0) {
    return { ok: false, error: 'Prompt or attachments are required to run agent' };
  }

  // 1. Resolve Role Config
  const roleConfig = loadRoleConfig(role);
  const activeModel = modelOverride || roleConfig.model;
  const capabilities = getModelCapabilities(activeModel);

  // 2. Load or Restore Session
  const session = loadSession(sessionId, role, activeModel);
  const sessionSafeId = session.session_id;

  // 3. Prepare System Prompt & Tool Schemas
  const systemPromptText = loadRoleSystemPrompt(role);
  const toolSchemas = getAvailableToolSchemas(roleConfig.allowed_tools);

  // 4. Build User Message Payload (with Vision / Text File Attachments)
  let userMessage;
  try {
    userMessage = buildUserMessage({
      prompt,
      images,
      files,
      repoRoot,
      modelCapabilities: capabilities
    });
  } catch (attErr) {
    return { ok: false, error: `Context adapter error: ${attErr.message}` };
  }

  // Assemble message history with compaction
  const history = compactMessagesForContext(session.messages || []);
  const messages = [
    { role: 'system', content: systemPromptText },
    ...history,
    userMessage
  ];

  // 5. Bounded Tool Execution Loop
  let currentTurn = 0;
  const turnReceipts = [];
  let finalContent = '';
  let modelUsed = activeModel;

  while (currentTurn < maxTurns) {
    currentTurn++;

    const callRes = await callModelEndpoint({
      model: activeModel,
      fallbackModel: roleConfig.fallback_model,
      messages,
      tools: toolSchemas.length > 0 ? toolSchemas : null,
      temperature: roleConfig.temperature,
      timeoutMs,
      baseUrl: roleConfig.base_url,
      apiKey: roleConfig.api_key
    });

    if (!callRes.ok) {
      return {
        ok: false,
        error: `Agent call failed on turn ${currentTurn}: ${callRes.error}`,
        session_id: sessionSafeId
      };
    }

    modelUsed = callRes.model_used;
    const toolCalls = callRes.tool_calls || [];

    // Push assistant response to conversational trajectory
    const assistantMsg = {
      role: 'assistant',
      content: callRes.content || ''
    };
    if (toolCalls.length > 0) {
      assistantMsg.tool_calls = toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments)
        }
      }));
    }
    messages.push(assistantMsg);

    // If no tool calls, model provided final response
    if (toolCalls.length === 0) {
      finalContent = callRes.content || '';
      break;
    }

    // Execute tool calls sequentially
    for (const tc of toolCalls) {
      const toolContext = {
        role,
        sessionId: sessionSafeId,
        repoRoot,
        allowedTools: roleConfig.allowed_tools,
        allowedScope: scope.length > 0 ? scope : roleConfig.allowed_scope
      };

      const execResult = await executeTool(tc.name, tc.arguments, toolContext);
      
      const receipt = {
        turn: currentTurn,
        tool: tc.name,
        call_id: tc.id,
        status: execResult.ok ? 'ok' : 'error',
        summary: execResult.ok ? (execResult.total || execResult.count || 'done') : execResult.error
      };
      turnReceipts.push(receipt);
      session.tool_receipts.push(receipt);

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(execResult)
      });
    }
  }

  // 6. Update & Persist Session (Save full conversational trajectory including intermediate tool calls & receipts)
  const newMessages = messages.slice(1 + history.length);
  for (const m of newMessages) {
    session.messages.push(m);
  }
  session.model = modelUsed;
  saveSession(session);

  return {
    ok: true,
    role,
    model_used: modelUsed,
    session_id: sessionSafeId,
    turns_executed: currentTurn,
    tool_receipts: turnReceipts,
    content: finalContent
  };
}

// -------------------------------------------------------------
// CLI Handler
// -------------------------------------------------------------
function parseCliArgs() {
  const args = process.argv.slice(2);
  const options = {
    role: 'designer',
    sessionId: null,
    prompt: '',
    images: [],
    files: [],
    scope: [],
    model: null
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--role' && args[i + 1]) {
      options.role = args[++i];
    } else if (arg === '--session' && args[i + 1]) {
      options.sessionId = args[++i];
    } else if (arg === '--prompt' && args[i + 1]) {
      options.prompt = args[++i];
    } else if (arg === '--image' && args[i + 1]) {
      options.images.push(args[++i]);
    } else if (arg === '--file' && args[i + 1]) {
      options.files.push(args[++i]);
    } else if (arg === '--scope' && args[i + 1]) {
      options.scope.push(args[++i]);
    } else if (arg === '--model' && args[i + 1]) {
      options.model = args[++i];
    }
  }

  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const cliOptions = parseCliArgs();

  if (!cliOptions.prompt && cliOptions.images.length === 0 && cliOptions.files.length === 0) {
    console.log(`
Usage: node agent-team/runtime/index.mjs [options]

Options:
  --role <name>       Role to invoke (designer | writer | router | reviewer) [default: designer]
  --session <id>      Session identifier for persistent memory [default: auto-generated]
  --prompt <text>     Task prompt or question
  --image <path>      Attach image file for vision (supports multiple)
  --file <path>       Attach text file content (supports multiple)
  --scope <path>      Limit patch scope for writer
  --model <id>        Override model identifier
    `);
    process.exit(0);
  }

  console.log(`[Agent Runtime] Initializing Role: "${cliOptions.role}" (Session: ${cliOptions.sessionId || 'new'})...`);
  runAgent(cliOptions)
    .then(res => {
      if (res.ok) {
        console.log(`\n=== AGENT RESPONSE (${res.model_used} | Turns: ${res.turns_executed} | Session: ${res.session_id}) ===\n`);
        console.log(res.content);
        if (res.tool_receipts && res.tool_receipts.length > 0) {
          console.log(`\n--- Tool Receipts (${res.tool_receipts.length}) ---`);
          res.tool_receipts.forEach(r => console.log(` • [Turn ${r.turn}] ${r.tool} -> ${r.status} (${JSON.stringify(r.summary)})`));
        }
      } else {
        console.error(`\n[Agent Runtime Error]: ${res.error}`);
        process.exit(1);
      }
    })
    .catch(err => {
      console.error(`\n[Fatal Runtime Exception]: ${err.message}`);
      process.exit(1);
    });
}
