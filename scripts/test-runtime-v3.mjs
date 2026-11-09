#!/usr/bin/env node
/**
 * Test Suite for Agent Runtime v3.0 Core
 * (agent-team/scripts/test-runtime-v3.mjs)
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveRepoRoot } from './applier.mjs';
import {
  buildUserMessage,
  encodeImageAttachment,
  isForbiddenAttachment,
  readTextAttachment
} from '../runtime/context-adapter.mjs';
import {
  getModelCapabilities,
  parseToolCalls,
  normalizeUsage
} from '../runtime/provider-gateway.mjs';
import {
  compactMessagesForContext,
  estimatePayloadTokens,
  groupMessagesIntoTurns,
  loadSession,
  saveSession,
  SESSIONS_DIR,
  COMPACTION_HIGH_WATERMARK_TOKENS
} from '../runtime/session-store.mjs';
import {
  executeTool,
  getAvailableToolSchemas,
  isDangerousCommand,
  toolApplyPatch,
  toolGetRepoMap,
  toolListFiles,
  toolReadFile,
  toolRunCommand,
  toolSearchCode,
  MAX_READ_LINES,
  MAX_READ_BYTES,
  MAX_SINGLE_LINE_CHARS
} from '../runtime/tool-runtime.mjs';
import {
  computePersonalizedPageRank,
  extractSymbolsFromCode,
  generateRepoMap,
  isTreeSitterWasmReady,
  resolveImportTarget,
  scanWorkspaceSymbols
} from '../runtime/repo-map.mjs';
import { loadRoleConfig, runAgent, stripOldInlineThinking } from '../runtime/index.mjs';
import {
  resolveThinkingBudget,
  matchesDomainPattern,
  partitionScopeByDomain,
  analyzeTaskDemand,
  resolveSquadRoster,
  resolveWriterHubWorkflow,
  shouldRunReviewerGate
} from './lib/risk-policy.mjs';
import { verifyPlannedScope } from './goal-planner.mjs';
import {
  buildConsolidatedSpecsContext,
  buildRouterContext,
  sanitizeProjectRules,
  loadProjectConventions
} from './lib/context-builders.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = resolveRepoRoot();

console.log('Testing Agent Runtime v3.0 Core Modules...\n');

// -------------------------------------------------------------
// Test 1: Capability Matrix & Model Classification
// -------------------------------------------------------------
console.log('1. Testing Capability Matrix...');
const sonnetCaps = getModelCapabilities('kr/claude-sonnet-4.5-thinking');
assert.strictEqual(sonnetCaps.supports_vision, true, 'Sonnet 4.5 must support vision');
assert.strictEqual(sonnetCaps.supports_tool_calls, true, 'Sonnet 4.5 must support tool calls');

const deepseekCaps = getModelCapabilities('deepseek-ai/deepseek-v4.1-flash-1017');
assert.strictEqual(deepseekCaps.supports_vision, false, 'DeepSeek V4.1 should not support vision');
assert.strictEqual(deepseekCaps.supports_code_generation, true, 'DeepSeek V4.1 must support code generation');

const unknownGptCaps = getModelCapabilities('gpt-4o-custom');
assert.strictEqual(unknownGptCaps.supports_vision, true, 'GPT-4 variant should heuristic vision');

console.log('✓ Capability Matrix tests passed.');

// -------------------------------------------------------------
// Test 2: Dual Tool Call Parser (Native + Fallback)
// -------------------------------------------------------------
console.log('2. Testing Dual Tool Call Parser...');
// Native
const nativeMsg = {
  tool_calls: [
    { id: 'call_1', function: { name: 'read_file', arguments: '{"path": "package.json"}' } }
  ]
};
const nativeParsed = parseToolCalls(nativeMsg);
assert.strictEqual(nativeParsed.length, 1);
assert.strictEqual(nativeParsed[0].name, 'read_file');
assert.strictEqual(nativeParsed[0].arguments.path, 'package.json');

// Native with thought_signature and provider_specific_fields
const nativeWithSigMsg = {
  tool_calls: [
    {
      id: 'call_sig_1',
      function: { name: 'tool_test', arguments: '{"key": "val"}' },
      thought_signature: 'sig_abc_123',
      provider_specific_fields: { vertex_thought: true }
    }
  ]
};
const sigParsed = parseToolCalls(nativeWithSigMsg);
assert.strictEqual(sigParsed.length, 1);
assert.strictEqual(sigParsed[0].thought_signature, 'sig_abc_123');
assert.deepStrictEqual(sigParsed[0].provider_specific_fields, { vertex_thought: true });

// Fallback tag in text
const fallbackMsg = {
  content: 'I need to check the code first.\n<tool_call>{"name": "search_code", "arguments": {"pattern": "liveStatus"}}</tool_call>\nAnd then inspect.'
};
const fallbackParsed = parseToolCalls(fallbackMsg);
assert.strictEqual(fallbackParsed.length, 1);
assert.strictEqual(fallbackParsed[0].name, 'search_code');
assert.strictEqual(fallbackParsed[0].arguments.pattern, 'liveStatus');

// normalizeUsage tests
const stdUsage = normalizeUsage({ prompt_tokens: 100, completion_tokens: 50 });
assert.strictEqual(stdUsage.prompt_tokens, 100);
assert.strictEqual(stdUsage.uncached_input_tokens, 100);
assert.strictEqual(stdUsage.cached_tokens, 0);
assert.strictEqual(stdUsage.completion_tokens, 50);
assert.strictEqual(stdUsage.total_tokens, 150);
assert.strictEqual(stdUsage.cache_hit_ratio, 0);

const anthropicUsage = normalizeUsage({
  input_tokens: 200,
  cache_read_input_tokens: 800,
  output_tokens: 150
});
assert.strictEqual(anthropicUsage.prompt_tokens, 1000);
assert.strictEqual(anthropicUsage.cached_tokens, 800);
assert.strictEqual(anthropicUsage.uncached_input_tokens, 200);
assert.strictEqual(anthropicUsage.completion_tokens, 150);
assert.strictEqual(anthropicUsage.cache_hit_ratio, 0.8);

const openAiUsage = normalizeUsage({
  prompt_tokens: 500,
  prompt_tokens_details: { cached_tokens: 250 },
  completion_tokens: 100
});
assert.strictEqual(openAiUsage.prompt_tokens, 500);
assert.strictEqual(openAiUsage.cached_tokens, 250);
assert.strictEqual(openAiUsage.uncached_input_tokens, 250);
assert.strictEqual(openAiUsage.cache_hit_ratio, 0.5);

console.log('✓ Dual Tool Call Parser tests passed.');

// -------------------------------------------------------------
// Test 3: Context & Vision Adapter (File & Image Attachment)
// -------------------------------------------------------------
console.log('3. Testing Context & Vision Adapter...');

// Forbidden check
assert.strictEqual(isForbiddenAttachment('.env'), true);
assert.strictEqual(isForbiddenAttachment('.env.local'), true);
assert.strictEqual(isForbiddenAttachment('keys/id_rsa'), true);
assert.strictEqual(isForbiddenAttachment('agent-team/UI_DASHBOARD_SPEC.md'), false);

// Text attachment
const textAtt = readTextAttachment(REPO_ROOT, 'agent-team/config/team.yaml');
assert.ok(textAtt.content.includes('hybrid-agent-squad'));
assert.strictEqual(textAtt.rel_path, 'agent-team/config/team.yaml');

// Path traversal guard
assert.throws(() => {
  readTextAttachment(REPO_ROOT, '../../outside.txt');
}, /Path escapes repository root/);

// Image attachment (self-contained fallback 1x1 PNG if sample image was removed by user)
let testImgPath = 'agent-team/ui/reference-9router-graph.png';
let tempImgCreated = false;
const absDefaultImg = path.resolve(REPO_ROOT, testImgPath);
if (!fs.existsSync(absDefaultImg)) {
  testImgPath = 'agent-team/state/temp-test-1x1.png';
  const absTempImg = path.resolve(REPO_ROOT, testImgPath);
  fs.mkdirSync(path.dirname(absTempImg), { recursive: true });
  const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  fs.writeFileSync(absTempImg, Buffer.from(tinyPngBase64, 'base64'));
  tempImgCreated = true;
}

const imgAtt = encodeImageAttachment(REPO_ROOT, testImgPath);
assert.strictEqual(imgAtt.mime_type, 'image/png');
assert.ok(imgAtt.payload.image_url.url.startsWith('data:image/png;base64,'));

// Multimodal user message builder
const msgVision = buildUserMessage({
  prompt: 'Analyze this image',
  images: [testImgPath],
  repoRoot: REPO_ROOT,
  modelCapabilities: { supports_vision: true }
});
assert.strictEqual(Array.isArray(msgVision.content), true);
assert.strictEqual(msgVision.content[0].text, 'Analyze this image');
assert.strictEqual(msgVision.content[1].type, 'image_url');

// Vision block on non-vision model
assert.throws(() => {
  buildUserMessage({
    prompt: 'Look at this',
    images: [testImgPath],
    repoRoot: REPO_ROOT,
    modelCapabilities: { supports_vision: false }
  });
}, /does not support vision/);

if (tempImgCreated) {
  const absTempImg = path.resolve(REPO_ROOT, testImgPath);
  if (fs.existsSync(absTempImg)) fs.unlinkSync(absTempImg);
}

// Fail-fast role isolation & no cross-role fallback check
const testTeamCfg = {
  providers: { local_9router: { base_url: 'http://127.0.0.1:11434/v1', default_key: 'ollama' } },
  roles: {
    writer: { enabled: true, model: 'qwen2.5-coder:14b', fallback_model: 'gemini-flash' },
    designer: { enabled: true, model: 'claude-sonnet-5-5', fallback_model: null },
    router: { enabled: false, model: 'claude-sonnet-4.5' },
    reviewer: { enabled: false }
  }
};
const designerCfg = loadRoleConfig('designer', testTeamCfg);
assert.strictEqual(designerCfg.enabled, true);
assert.strictEqual(designerCfg.model, 'claude-sonnet-5-5');
assert.strictEqual(designerCfg.fallback_model, null, 'Designer with fallback_model: null must NOT fall back to writer model');
assert.strictEqual(designerCfg.allowed_tools.includes('run_command'), false, 'Designer must NOT have run_command by default');

const writerCfgTest = loadRoleConfig('writer', testTeamCfg);
assert.strictEqual(writerCfgTest.allowed_tools.includes('run_command'), false, 'Writer must NOT have run_command by default');
assert.strictEqual(writerCfgTest.fallback_model, 'gemini-flash');

const disabledRouterCfg = loadRoleConfig('router', testTeamCfg);
assert.strictEqual(disabledRouterCfg.enabled, false, 'Disabled role must report enabled: false');
assert.strictEqual(disabledRouterCfg.model, null, 'Disabled role must NOT inherit writer model');
assert.strictEqual(disabledRouterCfg.fallback_model, null);

const unconfiguredArchCfg = loadRoleConfig('architect', testTeamCfg);
assert.strictEqual(unconfiguredArchCfg.model, null, 'Unconfigured specialized role must return model: null instead of writer model');

console.log('✓ Context & Vision Adapter + Fail-Fast Role Isolation tests passed.');

// -------------------------------------------------------------
// Test 4: Tool Execution Runtime & RBAC
// -------------------------------------------------------------
console.log('4. Testing Tool Execution Runtime...');

// list_files
const listRes = toolListFiles(REPO_ROOT, { dir: 'agent-team/roles' });
assert.strictEqual(listRes.ok, true);
assert.ok(listRes.files.some(f => f.includes('writer.md')));

// search_code
const searchRes = toolSearchCode(REPO_ROOT, { pattern: 'single_writer_lock', dir: 'agent-team/config' });
assert.strictEqual(searchRes.ok, true);
assert.ok(searchRes.count >= 1);
assert.ok(searchRes.matches.some(m => m.file.includes('team.yaml')));

// read_file
const readRes = toolReadFile(REPO_ROOT, { path: 'agent-team/roles/writer.md', start_line: 1, end_line: 10 });
assert.strictEqual(readRes.ok, true);
assert.strictEqual(readRes.start_line, 1);
assert.ok(readRes.content.includes('1: # ROLE: Writer'));
assert.ok(readRes.navigation_hint.includes('Showing lines 1-10'));

// Zero-Error Clamping: end_line requested far beyond MAX_READ_LINES (e.g. 1000)
const clampRes = toolReadFile(REPO_ROOT, { path: 'agent-team/scripts/orchestrator.mjs', start_line: 1, end_line: 1000 });
assert.strictEqual(clampRes.ok, true);
assert.strictEqual(clampRes.start_line, 1);
assert.strictEqual(clampRes.end_line, MAX_READ_LINES);
assert.strictEqual(clampRes.truncated, true);
assert.ok(clampRes.navigation_hint.includes(`Showing lines 1-${MAX_READ_LINES}`));
assert.ok(clampRes.navigation_hint.includes(`start_line=${MAX_READ_LINES + 1}`));

// Start line exceeds total lines
const outOfBoundsRes = toolReadFile(REPO_ROOT, { path: 'agent-team/roles/writer.md', start_line: 9999 });
assert.strictEqual(outOfBoundsRes.ok, false);
assert.ok(outOfBoundsRes.error.includes('exceeds total file lines'));

// Open Read: Agent can freely inspect other workspace files (read-only) for architecture and cross-file references
const scopedReadAllowed = await executeTool('read_file', { path: 'agent-team/scripts/applier.mjs', start_line: 1, end_line: 5 }, {
  role: 'writer',
  allowedTools: ['read_file'],
  allowedScope: ['agent-team/scripts/applier.mjs']
});
assert.strictEqual(scopedReadAllowed.ok, true);

// Reading cross-file outside write scope is allowed for exploration
const crossFileRead = await executeTool('read_file', { path: 'agent-team/scripts/validator.mjs', start_line: 1, end_line: 5 }, {
  role: 'writer',
  allowedTools: ['read_file'],
  allowedScope: ['agent-team/scripts/applier.mjs']
});
assert.strictEqual(crossFileRead.ok, true);

// Sensitive files remain strictly blocked
const sensitiveReadDenied = await executeTool('read_file', { path: '.env', start_line: 1, end_line: 5 }, {
  role: 'writer',
  allowedTools: ['read_file']
});
assert.strictEqual(sensitiveReadDenied.ok, false);
assert.ok(sensitiveReadDenied.error.includes('Access denied to sensitive file'));

// RBAC Guard
const rbacDenied = await executeTool('apply_patch', { patch: 'test' }, {
  role: 'router',
  allowedTools: ['read_file', 'list_files']
});
assert.strictEqual(rbacDenied.ok, false);
assert.ok(rbacDenied.error.includes('PERMISSION_DENIED'));

// Schemas filter
const schemas = getAvailableToolSchemas(['read_file', 'apply_patch', 'run_command']);
assert.strictEqual(schemas.length, 3);
assert.strictEqual(schemas[0].function.name, 'read_file');
assert.strictEqual(schemas[1].function.name, 'apply_patch');
assert.strictEqual(schemas[2].function.name, 'run_command');

// run_command security guardrail checks (whitelist + dangerous command blocklist)
assert.strictEqual(isDangerousCommand('del /f /s /q C:\\Windows'), true);
assert.strictEqual(isDangerousCommand('format d:'), true);
assert.strictEqual(isDangerousCommand('cat .env.production'), true);
assert.strictEqual(isDangerousCommand('type .env'), true);
assert.strictEqual(isDangerousCommand('gc .env'), true);
assert.strictEqual(isDangerousCommand('Set-Content -Path core/x.py -Value "hacked"'), true);
assert.strictEqual(isDangerousCommand('Remove-Item -Recurse -Force core/'), true);
assert.strictEqual(isDangerousCommand('git commit -m "bypass applier"'), true);
assert.strictEqual(isDangerousCommand('pip install evil-pkg'), true);
assert.strictEqual(isDangerousCommand('python -c "open(\'.env\').read()"'), true);
assert.strictEqual(isDangerousCommand('git status && del x.py'), true);
assert.strictEqual(isDangerousCommand('git status --short'), false);
assert.strictEqual(isDangerousCommand('npm test'), false);
assert.strictEqual(isDangerousCommand('node --check agent-team/scripts/applier.mjs'), false);

// toolApplyPatch enforces policy.yaml protected_files & allowed_dirs even when omitted from context
const protectedPatchAttempt = `FILE: tests/test_indentation.py\n<<<<<<< SEARCH\nimport unittest\n=======\n# hacked\n>>>>>>> REPLACE`;
const protectedPatchRes = toolApplyPatch(REPO_ROOT, { patch: protectedPatchAttempt }, {
  sessionId: 'test-sec',
  allowedScope: ['tests/test_indentation.py']
});
assert.strictEqual(protectedPatchRes.ok, false, 'toolApplyPatch must block edits to protected_files from policy.yaml');
assert.ok(protectedPatchRes.error.includes('Forbidden file'), `Expected Forbidden file error, got: ${protectedPatchRes.error}`);

const outsideDirPatchAttempt = `FILE: unauthorized_dir/hack.py\n<<<<<<< SEARCH\n=======\nprint(1)\n>>>>>>> REPLACE`;
const outsideDirPatchRes = toolApplyPatch(REPO_ROOT, { patch: outsideDirPatchAttempt }, {
  sessionId: 'test-sec-dir',
  allowedScope: ['unauthorized_dir/hack.py']
});
assert.strictEqual(outsideDirPatchRes.ok, false, 'toolApplyPatch must block files outside allowed_dirs from policy.yaml');
assert.ok(outsideDirPatchRes.error.includes('outside project.allowed_dirs'), `Expected allowed_dirs error, got: ${outsideDirPatchRes.error}`);

// run_command execution
const cmdSafe = await toolRunCommand(REPO_ROOT, { command: 'node -e "console.log(\'AGENT_CLI_OK\')"' });
assert.strictEqual(cmdSafe.ok, true);
assert.ok(cmdSafe.stdout.includes('AGENT_CLI_OK'));

const cmdBlocked = await toolRunCommand(REPO_ROOT, { command: 'del /f /s /q C:\\Windows\\System32' });
assert.strictEqual(cmdBlocked.ok, false);
assert.ok(cmdBlocked.error.includes('SECURITY_BLOCKED'));

const cmdViaDispatch = await executeTool('run_command', { command: 'node -e "console.log(\'DISPATCH_OK\')"' }, {
  role: 'writer',
  allowedTools: ['run_command']
});
assert.strictEqual(cmdViaDispatch.ok, true);
assert.ok(cmdViaDispatch.stdout.includes('DISPATCH_OK'));

// get_repo_map tool & symbol extraction tests
console.log('Testing Structural Repo-Map Engine & Tool...');
const mockPy = `class TestClass:\n\tdef method_a(self, x: int) -> bool:\n\t\tpass\ndef helper_func(y: str):\n\tpass`;
const symRes = extractSymbolsFromCode('test.py', mockPy);
assert.strictEqual(symRes.classes.length, 1);
assert.strictEqual(symRes.classes[0].name, 'TestClass');
assert.strictEqual(symRes.classes[0].methods[0].name, 'method_a');
assert.strictEqual(symRes.functions.length, 1);
assert.strictEqual(symRes.functions[0].name, 'helper_func');

const repoMapRes = generateRepoMap(REPO_ROOT, { query: 'applier', maxChars: 2000, allowedDirs: ['agent-team'] });
assert.ok(repoMapRes.includes('applier.mjs'), 'Repo-map must contain applier.mjs');
assert.ok(repoMapRes.includes('resolveRepoRoot'), 'Repo-map must include resolveRepoRoot signature');

const repoMapViaDispatch = await executeTool('get_repo_map', { query: 'validator' }, {
  role: 'router',
  allowedTools: ['get_repo_map']
});
assert.strictEqual(repoMapViaDispatch.ok, true);
assert.ok(repoMapViaDispatch.map.includes('validator.mjs'));

const repoMapSchemas = getAvailableToolSchemas(['get_repo_map']);
assert.strictEqual(repoMapSchemas.length, 1);
assert.strictEqual(repoMapSchemas[0].function.name, 'get_repo_map');

console.log('✓ Tool Execution Runtime tests passed.');

// -------------------------------------------------------------
// Test 5: Persistent Session Memory Store & Compaction
// -------------------------------------------------------------
console.log('5. Testing Session Memory Store & Compaction...');

const testSessionId = `test_harness_${Date.now()}`;
const newSess = loadSession(testSessionId, 'designer', 'claude-sonnet-4.5');
assert.strictEqual(newSess.session_id, testSessionId);
assert.strictEqual(newSess.role, 'designer');

newSess.facts.push('Node graph canvas verified');
newSess.messages.push({ role: 'user', content: 'Design Tab 1' });
newSess.messages.push({ role: 'assistant', content: 'Canvas layout implemented' });

const saved = saveSession(newSess);
assert.strictEqual(saved, true);

// Verify reload from disk
const reloaded = loadSession(testSessionId);
assert.strictEqual(reloaded.facts[0], 'Node graph canvas verified');
assert.strictEqual(reloaded.messages.length, 2);

// Context compaction
const rawOldMessages = [
  { role: 'user', content: 'Turn 1: Read large file' },
  { role: 'assistant', content: 'Reading...', tool_calls: [{ id: '1', function: { name: 'read_file' } }] },
  { role: 'tool', tool_call_id: '1', content: JSON.stringify({ file: 'app.js', start_line: 1, end_line: 300, total_lines: 500 }) },
  { role: 'user', content: 'Turn 2: Recent question' },
  { role: 'assistant', content: 'Recent answer' }
];

const compacted = compactMessagesForContext(rawOldMessages, 1);
assert.strictEqual(compacted.length, rawOldMessages.length);
assert.ok(compacted[2].content.includes('[Tool Output: read_file(app.js, lines 1-300) -> OK (500 total lines)]'));

// Test Atomic Turn Grouping & Tool-Call Pair Invariant Guard
const multiToolMessages = [
  { role: 'assistant', content: '', tool_calls: [{ id: 'call_A', function: { name: 'fnA' } }, { id: 'call_B', function: { name: 'fnB' } }] },
  { role: 'tool', tool_call_id: 'call_A', content: '{"ok":true}' },
  { role: 'tool', tool_call_id: 'call_B', content: '{"ok":true}' }
];
const turns = groupMessagesIntoTurns(multiToolMessages);
assert.strictEqual(turns.length, 1, 'Multi-tool calls must be grouped into exactly 1 atomic turn');
assert.strictEqual(turns[0].messages.length, 3);

// Test Orphaned Tool Response Purging (chống vỡ protocol 400 Bad Request)
const orphanedMessages = [
  { role: 'tool', tool_call_id: 'call_ghost', content: '{"ok":true}' },
  { role: 'user', content: 'Hello' }
];
const sanitized = compactMessagesForContext(orphanedMessages, 1);
assert.strictEqual(sanitized.length, 1, 'Ghost tool message without assistant parent must be purged');
assert.strictEqual(sanitized[0].role, 'user');

// Test Epoch Compaction Watermark (SPEC Section 3.3)
assert.strictEqual(COMPACTION_HIGH_WATERMARK_TOKENS, 32000);
const smallSessionMessages = [
  { role: 'user', content: 'Task 1' },
  { role: 'assistant', content: 'Thinking...', tool_calls: [{ id: 'c1', function: { name: 'list_files' } }] },
  { role: 'tool', tool_call_id: 'c1', content: '{"ok":true,"files":["a.js"]}' },
  { role: 'assistant', content: 'Done' }
];
// Under 32,000 tokens, useEpochWatermark keeps 100% Append-Only history
const epochPreserved = compactMessagesForContext(smallSessionMessages, 1, { useEpochWatermark: true });
assert.strictEqual(epochPreserved.length, smallSessionMessages.length);
assert.strictEqual(epochPreserved[2].content, '{"ok":true,"files":["a.js"]}', 'Raw tool output must be preserved for KV Cache');

// Test stripOldInlineThinking (SPEC Section 3.2)
const thinkMsgs = [
  { role: 'user', content: 'Hello' },
  { role: 'assistant', content: '<think>Deep intermediate thoughts</think>I will read file', thought_signature: 'sig_1' },
  { role: 'tool', tool_call_id: 'c1', content: '{}' },
  { role: 'assistant', content: '<think>Latest reasoning to preserve</think>Final reply', thought_signature: 'sig_2' }
];
const stripped = stripOldInlineThinking(thinkMsgs, 1);
assert.strictEqual(stripped[1].content, 'I will read file');
assert.strictEqual(stripped[1].thought_signature, 'sig_1', 'thought_signature must be preserved when stripping think tag');
assert.ok(stripped[3].content.includes('<think>Latest reasoning to preserve</think>'), 'Most recent turn thinking must be preserved');

// Clean up test session file
const testSessionPath = path.resolve(SESSIONS_DIR, `${testSessionId}.json`);
if (fs.existsSync(testSessionPath)) {
  fs.unlinkSync(testSessionPath);
}

console.log('✓ Session Memory Store tests passed.\n');

// -------------------------------------------------------------
// Test 6: Writer Hub Multi-Tier Spec Dossier & Cognitive Budgeting
// -------------------------------------------------------------
console.log('6. Testing Writer Hub Multi-Tier Dossier & Cognitive Budgeting...');

// 6.1 Cognitive Budgeting by Task Risk
assert.strictEqual(
  resolveThinkingBudget('low', 'kr/claude-sonnet-4.5-thinking'),
  null,
  'Low risk must disable thinking budget to save tokens and avoid HTTP 400'
);
assert.strictEqual(
  resolveThinkingBudget('medium', 'kr/claude-sonnet-4.5-thinking'),
  null,
  'Medium risk must disable thinking budget'
);
const highThinking = resolveThinkingBudget('high', 'kr/claude-sonnet-4.5-thinking');
assert.ok(highThinking >= 1024, `High risk thinking model must get >= 1024 tokens (got ${highThinking})`);

const criticalThinking = resolveThinkingBudget('critical', 'deepseek-ai/deepseek-v4.1-flash-1017', { max_thinking_tokens: 2048 });
assert.strictEqual(criticalThinking, 2048, 'Critical risk with explicit config must allocate >= 1024');

assert.strictEqual(
  resolveThinkingBudget('high', 'gpt-4o'),
  null,
  'Non-thinking model without config should return null'
);

// 6.2 Structured Spec Dossier Merging
const tmpSpec1 = path.resolve(REPO_ROOT, 'agent-team', 'state', 'test_spec_be.md');
const tmpSpec2 = path.resolve(REPO_ROOT, 'agent-team', 'state', 'test_spec_ui.md');
fs.writeFileSync(tmpSpec1, '# Backend Architecture\nAPI: /api/v1/cart', 'utf8');
fs.writeFileSync(tmpSpec2, '# Frontend Design\nButton: .btn-checkout', 'utf8');

const dossier = buildConsolidatedSpecsContext(
  ['agent-team/state/test_spec_be.md', 'agent-team/state/test_spec_ui.md'],
  REPO_ROOT
);
assert.ok(dossier.includes('=== [SPECIFICATION DOSSIER: test_spec_be.md]'), 'Dossier must contain Spec 1 divider');
assert.ok(dossier.includes('API: /api/v1/cart'), 'Dossier must contain Spec 1 content');
assert.ok(dossier.includes('=== [SPECIFICATION DOSSIER: test_spec_ui.md]'), 'Dossier must contain Spec 2 divider');
assert.ok(dossier.includes('Button: .btn-checkout'), 'Dossier must contain Spec 2 content');

// Clean up temp specs
fs.unlinkSync(tmpSpec1);
fs.unlinkSync(tmpSpec2);

// 6.3 Unconfigured Role Fail-Fast Guard (Architect not in team.yaml -> model: null, runAgent stops)
const archCfg = loadRoleConfig('architect');
assert.strictEqual(archCfg.model, null, 'Unconfigured architect role must return model: null instead of silent inheritance');
assert.ok(archCfg.allowed_tools.includes('read_file'), 'Architect role must have read_file tool');
const failFastRes = await runAgent({ role: 'architect', prompt: 'Draft spec' });
assert.strictEqual(failFastRes.ok, false, 'runAgent must fail fast when role has no model configured');
assert.ok(failFastRes.error.includes('no model configured'), `Expected no model configured error, got: ${failFastRes.error}`);

// 6.4 Model Override Parameter Contract Guard
const testOverrideRole = loadRoleConfig('writer');
assert.ok(testOverrideRole.model, 'Default writer model must exist');

console.log('✓ Writer Hub Multi-Tier Dossier & Cognitive Budgeting tests passed.\n');

// -------------------------------------------------------------
// Test 7: Universal Task-Demand × Squad-Roster Matrix & Invariants
// -------------------------------------------------------------
console.log('7. Testing Universal Task-Demand × Squad-Roster Matrix & 4 Invariants...');

// 7.1 Glob & Path Normalization (root files, nested dirs, Windows backslashes, test files)
assert.strictEqual(matchesDomainPattern('index.html', '**/*.html'), true);
assert.strictEqual(matchesDomainPattern('ui/x.py', '**/ui/**'), true);
assert.strictEqual(matchesDomainPattern('ui\\x.py', '**/ui/**'), true);
assert.strictEqual(matchesDomainPattern('src\\components\\Modal.tsx', '**/components/**'), true);

const partitioned = partitionScopeByDomain([
  'src/services/auth.ts',
  'ui\\x.py',
  'src/components/LoginModal.tsx',
  'tests/ui/test_modal.py'
]);
assert.deepStrictEqual(partitioned.backendScope, ['src/services/auth.ts', 'tests/ui/test_modal.py']);
assert.deepStrictEqual(partitioned.frontendScope, ['ui/x.py', 'src/components/LoginModal.tsx']);
assert.deepStrictEqual(partitioned.testScope, ['tests/ui/test_modal.py']);

// 7.2 Unicode-Safe Vietnamese UI Intent Regex (NFC + NFD decomposed) & Effective Risk Escalation
const nfdGoal = 'Cập nhật hiển thị và bố cục modal'.normalize('NFD');
const uiDemand = analyzeTaskDemand({
  title: 'Sửa giao diện',
  goal: nfdGoal,
  mode: 'quick',
  risk_level: 'low',
  scope: ['src/components/Modal.tsx']
});
assert.strictEqual(uiDemand.hasUiIntent, true, 'Must detect Vietnamese UI keywords even when NFD-decomposed');
assert.strictEqual(uiDemand.needsDesignSpec, true, 'UI intent on frontend scope must request Design Spec');

// Scope verification warns if UI intent has zero frontend files
const missingUiVerify = verifyPlannedScope(['src/api/server.ts'], REPO_ROOT, analyzeTaskDemand({
  goal: 'Sửa bố cục hiển thị trang chủ',
  mode: 'quick',
  scope: ['src/api/server.ts']
}));
assert.strictEqual(missingUiVerify.ok, false);
assert.ok(missingUiVerify.warnings.some(w => w.includes('no frontend/UI file')));

// 7.3 Matrix Property Verification Helper (Enforces 4 Universal Invariants on any workflow)
function assertWorkflowInvariants(workflow, demand, roster) {
  const producedArtifacts = new Set();
  const patchModels = new Set(workflow.filter(s => s.action === 'apply_patch').map(s => s.model));

  for (const step of workflow) {
    // Invariant 1: Never call Designer when task has no frontend and no visual attachments
    if (!demand.hasFrontend && !demand.hasVisualInput) {
      assert.notStrictEqual(step.role, 'designer', 'Invariant 1 violated: Designer called on pure backend task');
    }
    // Invariant 2: Never schedule a Spec step using the exact same model as the sole patch writer
    if (step.action === 'draft_spec' && patchModels.size === 1) {
      assert.strictEqual(patchModels.has(step.model), false, `Invariant 2 violated: Model ${step.model} drafted spec for itself`);
    }
    // Invariant 4: Every input artifact must have been produced by an earlier step
    if (Array.isArray(step.inputs)) {
      for (const inp of step.inputs) {
        assert.strictEqual(producedArtifacts.has(inp), true, `Invariant 4 violated: Step ${step.step} depends on unproduced artifact ${inp}`);
      }
    }
    if (step.output_artifact) {
      producedArtifacts.add(step.output_artifact);
    }
  }
}

const taskPureBackend = {
  task_id: 'T-be',
  title: 'Implement token bucket rate limiter',
  goal: 'Add rate limiter service and unit tests',
  mode: 'standard',
  risk_level: 'high',
  scope: ['src/services/rateLimiter.ts', 'tests/rateLimiter.test.ts']
};

const taskPureFrontend = {
  task_id: 'T-fe',
  title: 'Redesign dashboard header layout',
  goal: 'Update CSS spacing and responsive dark mode header',
  mode: 'standard',
  risk_level: 'medium',
  scope: ['src/components/Header.tsx', 'src/styles/header.css']
};

const taskMixedFullstack = {
  task_id: 'T-mixed',
  title: 'Add user profile export feature',
  goal: 'Add backend export endpoint and frontend export modal button',
  mode: 'quick', // Should auto-escalate to standard because it is cross-domain (BE + FE)
  risk_level: 'low',
  scope: ['src/api/profile.ts', 'src/components/ProfileModal.tsx']
};

// Combo 1: [Writer Only] (1 Model)
const squad1WriterOnly = {
  roles: {
    writer: { enabled: true, model: 'deepseek-v4.1' }
  }
};
for (const t of [taskPureBackend, taskPureFrontend, taskMixedFullstack]) {
  const wf = resolveWriterHubWorkflow(t, squad1WriterOnly);
  assertWorkflowInvariants(wf, analyzeTaskDemand(t), resolveSquadRoster(squad1WriterOnly, t));
  assert.strictEqual(wf.length, 0, 'Combo 1 (Writer only) must auto-collapse to [] (direct 1-step Writer patch)');
  // Invariant 3: Anti-Self-Review
  assert.strictEqual(shouldRunReviewerGate(t, {}, squad1WriterOnly.roles, 'deepseek-v4.1'), false);
}

// Combo 2: [Writer + TechLead (Reviewer)] (No Designer)
const squad2WriterTechlead = {
  roles: {
    writer: { enabled: true, model: 'deepseek-v4.1' },
    reviewer: { enabled: true, model: 'claude-opus-4.5' }
  }
};
const wfCombo2Be = resolveWriterHubWorkflow(taskPureBackend, squad2WriterTechlead);
assertWorkflowInvariants(wfCombo2Be, analyzeTaskDemand(taskPureBackend), resolveSquadRoster(squad2WriterTechlead, taskPureBackend));
assert.strictEqual(wfCombo2Be.length, 2, 'Combo 2 on standard BE task must run TechLead Spec -> Writer Patch');
assert.strictEqual(wfCombo2Be[0].role, 'reviewer');
assert.strictEqual(wfCombo2Be[0].action, 'draft_spec');
assert.strictEqual(wfCombo2Be[1].action, 'apply_patch');
assert.strictEqual(shouldRunReviewerGate(taskPureBackend, {}, squad2WriterTechlead.roles, 'deepseek-v4.1'), true);
assert.strictEqual(shouldRunReviewerGate(taskPureBackend, {}, squad2WriterTechlead.roles, 'claude-opus-4.5'), false, 'Anti-self-review must block when writer == reviewer');

// Combo 3: [Writer + Designer] (No TechLead)
const squad3WriterDesigner = {
  roles: {
    writer: { enabled: true, model: 'deepseek-v4.1' },
    designer: { enabled: true, model: 'gemini-3.8-pro' }
  }
};
// 3a: Pure Backend task -> Designer MUST NOT be called! Collapses to [] (direct 1-step Writer patch)
const wfCombo3Be = resolveWriterHubWorkflow(taskPureBackend, squad3WriterDesigner);
assertWorkflowInvariants(wfCombo3Be, analyzeTaskDemand(taskPureBackend), resolveSquadRoster(squad3WriterDesigner, taskPureBackend));
assert.strictEqual(wfCombo3Be.length, 0, 'Combo 3 on pure BE task must skip Designer and auto-collapse to [] (direct Writer step)');
// 3b: Pure Frontend task -> Designer drafts UI spec -> Writer patches
const wfCombo3Fe = resolveWriterHubWorkflow(taskPureFrontend, squad3WriterDesigner);
assertWorkflowInvariants(wfCombo3Fe, analyzeTaskDemand(taskPureFrontend), resolveSquadRoster(squad3WriterDesigner, taskPureFrontend));
assert.strictEqual(wfCombo3Fe.length, 2);
assert.strictEqual(wfCombo3Fe[0].role, 'designer');
assert.strictEqual(wfCombo3Fe[1].action, 'apply_patch');
assert.strictEqual(shouldRunReviewerGate(taskPureFrontend, {}, squad3WriterDesigner.roles, 'deepseek-v4.1'), false, 'No TechLead configured -> skip Reviewer Gate');

// Combo 4: [Writer + Designer + TechLead] (3 Specialist Roles)
const squad4ThreeRoles = {
  roles: {
    writer: { enabled: true, model: 'deepseek-v4.1' },
    designer: { enabled: true, model: 'gemini-3.8-pro' },
    reviewer: { enabled: true, model: 'claude-opus-4.5' }
  }
};
const wfCombo4Mixed = resolveWriterHubWorkflow(taskMixedFullstack, squad4ThreeRoles);
assertWorkflowInvariants(wfCombo4Mixed, analyzeTaskDemand(taskMixedFullstack), resolveSquadRoster(squad4ThreeRoles, taskMixedFullstack));
assert.strictEqual(wfCombo4Mixed.length, 3, 'Combo 4 on Mixed task with distinct TechLead & Designer must run TechSpec -> DesignSpec -> Writer');
assert.strictEqual(wfCombo4Mixed[0].role, 'reviewer');
assert.strictEqual(wfCombo4Mixed[1].role, 'designer');
assert.deepStrictEqual(wfCombo4Mixed[1].inputs, [wfCombo4Mixed[0].output_artifact], 'Designer must receive TechLead contract via inputs');
assert.strictEqual(wfCombo4Mixed[2].action, 'apply_patch');

// Combo 5: [BE Writer + FE Writer + Designer + TechLead] (4+ Models Full Squad)
const squad5FullMultiWriter = {
  roles: {
    writer: {
      enabled: true,
      model: 'deepseek-v4.1',
      models: ['deepseek-v4.1', 'ag/gemini-3.8-flash']
    },
    designer: { enabled: true, model: 'claude-sonnet-4.5' },
    architect: { enabled: true, model: 'claude-sonnet-4.5' },
    reviewer: { enabled: true, model: 'claude-opus-4.5' }
  }
};
const wfCombo5Mixed = resolveWriterHubWorkflow(taskMixedFullstack, squad5FullMultiWriter);
assertWorkflowInvariants(wfCombo5Mixed, analyzeTaskDemand(taskMixedFullstack), resolveSquadRoster(squad5FullMultiWriter, taskMixedFullstack));
// Architect and Designer share claude-sonnet-4.5 -> auto-collapsed into 1 unified spec!
// BE Writer (deepseek-v4.1) !== FE Writer (ag/gemini-3.8-flash) -> split into Step 2A (BE) -> Step 2B (FE with AST bridge)!
assert.strictEqual(wfCombo5Mixed.length, 3);
assert.strictEqual(wfCombo5Mixed[0].action, 'draft_spec');
assert.strictEqual(wfCombo5Mixed[0].spec_focus, 'unified_tech_and_ui');
assert.strictEqual(wfCombo5Mixed[1].action, 'apply_patch');
assert.strictEqual(wfCombo5Mixed[1].domain, 'backend');
assert.strictEqual(wfCombo5Mixed[1].model, 'deepseek-v4.1');
assert.deepStrictEqual(wfCombo5Mixed[1].sub_scope, ['src/api/profile.ts']);
assert.strictEqual(wfCombo5Mixed[2].action, 'apply_patch');
assert.strictEqual(wfCombo5Mixed[2].domain, 'frontend');
assert.strictEqual(wfCombo5Mixed[2].model, 'ag/gemini-3.8-flash');
assert.deepStrictEqual(wfCombo5Mixed[2].sub_scope, ['src/components/ProfileModal.tsx']);
assert.deepStrictEqual(wfCombo5Mixed[2].inject_updated_repo_map_from, ['src/api/profile.ts']);

// Test Selective Host Project Conventions Loader (sanitizeProjectRules & loadProjectConventions)
const sampleHostRule = [
  '# Project Overview',
  '## 1. Architecture & Routing',
  '- Backend lives in src/api/, Frontend lives in src/ui/.',
  '## 2. Task Triage & Execution Architecture',
  '- Run node orchestrator.mjs and update docs/STATE.md at end of task.',
  '## 3. Hard Coding & Security Invariants',
  '- Always use strict TypeScript and never expose API keys.'
].join('\n');
const filteredRule = sanitizeProjectRules(sampleHostRule, 'writer');
assert.ok(filteredRule.includes('## 1. Architecture & Routing'), 'Architecture section must be kept');
assert.ok(filteredRule.includes('## 3. Hard Coding & Security Invariants'), 'Coding invariants section must be kept');
assert.strictEqual(filteredRule.includes('Task Triage & Execution Architecture'), false, 'Conflicting IDE workflow section must be stripped');

const loadedConv = loadProjectConventions(REPO_ROOT, { role: 'writer' });
assert.ok(loadedConv.includes('<project_conventions'), 'Existing project rule file must wrap in <project_conventions>');
assert.ok(loadedConv.includes('[ORCHESTRATOR PRECEDENCE OVERRIDE]'), 'Must include Orchestrator Precedence Override guard');
assert.strictEqual(loadedConv.includes('## 2. Task Triage & Execution Architecture'), false, 'Host AGENTS.md Section 2 workflow must be filtered out');

const emptyConv = loadProjectConventions(path.resolve(REPO_ROOT, 'non_existent_workspace_dir_12345'));
assert.strictEqual(emptyConv, '', 'Workspace without rule files must gracefully return empty string');

// 7.4 Verify buildRouterContext Repo-Map Injection (Regression Test for queryKeywords)
const routerCtxDefault = buildRouterContext(['agent-team/runtime'], REPO_ROOT, 50);
assert.ok(routerCtxDefault.includes('CODEBASE SKELETON & SYMBOL MAP'), 'buildRouterContext without queryKeywords must inject CODEBASE SKELETON & SYMBOL MAP');
const routerCtxRanked = buildRouterContext(['agent-team/runtime'], REPO_ROOT, 50, 'compactMessagesForContext session');
assert.ok(routerCtxRanked.includes('session-store.mjs'), 'buildRouterContext with queryKeywords must rank matching symbol files');

// 7.5 Verify Pillar 1: Tree-Sitter WASM AST Parser (Comments, Template Literals, Methods, Arrow Functions, Multi-line)
assert.strictEqual(isTreeSitterWasmReady(), true, 'Tree-sitter WASM must initialize automatically');
const jsSample = [
  '/* export class FakeCommentedClass {} */',
  '// export function fakeSingleLineComment() {}',
  'const fakeTemplate = `',
  'export function fakeInsideTemplateLiteral() {}',
  '`;',
  'export class PaymentService extends BaseService {',
  '  async processCharge(amount, currency) {',
  '    if (amount <= 0) {',
  '      return false;',
  '    }',
  '    return true;',
  '  }',
  '}',
  'export const calculateFee = async (subtotal, rate) => subtotal * rate;',
  'export function formatReceipt(',
  '  receiptId,',
  '  customerName',
  ') {',
  '  return receiptId;',
  '}'
].join('\n');
const extractedJs = extractSymbolsFromCode('src/payment.js', jsSample);
assert.strictEqual(extractedJs.parser, 'tree-sitter-wasm', 'Must use real Tree-Sitter WASM AST parser');
assert.strictEqual(extractedJs.classes.length, 1, 'Commented-out classes must be ignored by AST');
assert.strictEqual(extractedJs.classes[0].name, 'PaymentService');
assert.strictEqual(extractedJs.classes[0].methods.length, 1, 'JS class method must be extracted without matching if()');
assert.strictEqual(extractedJs.classes[0].methods[0].name, 'processCharge');
assert.ok(extractedJs.functions.some(f => f.name === 'calculateFee'), 'JS arrow function must be extracted');
assert.ok(extractedJs.functions.some(f => f.name === 'formatReceipt' && f.params.includes('receiptId')), 'JS multi-line function signature must be extracted');
assert.strictEqual(extractedJs.functions.some(f => f.name.startsWith('fake')), false, 'Functions inside comments or template literals must NEVER be extracted');

// 7.5b Verify Pillar 2: resolveImportTarget (./, ../, extension probing, TS .js->.ts, index.*, Python dotted/relative)
const mockRepoFiles = new Set([
  'agent-team/scripts/orchestrator.mjs',
  'agent-team/scripts/applier.mjs',
  'agent-team/scripts/lib/risk-policy.mjs',
  'agent-team/scripts/server/routes-tasks.mjs',
  'agent-team/runtime/index.mjs',
  'src/services/user.ts',
  'src/components/index.tsx',
  'core/eraser.py',
  'core/providers/__init__.py',
  'core/providers/store.py'
]);
assert.strictEqual(
  resolveImportTarget('agent-team/scripts/orchestrator.mjs', './lib/risk-policy.mjs', mockRepoFiles),
  'agent-team/scripts/lib/risk-policy.mjs',
  'Relative ./ import with extension must resolve'
);
assert.strictEqual(
  resolveImportTarget('agent-team/scripts/orchestrator.mjs', '../runtime/index.mjs', mockRepoFiles),
  'agent-team/runtime/index.mjs',
  'Parent ../ import must resolve'
);
assert.strictEqual(
  resolveImportTarget('agent-team/scripts/orchestrator.mjs', './server/routes-tasks', mockRepoFiles),
  'agent-team/scripts/server/routes-tasks.mjs',
  'Extension-less relative import must resolve via extension probing'
);
assert.strictEqual(
  resolveImportTarget('src/app.ts', './services/user.js', mockRepoFiles),
  'src/services/user.ts',
  'TypeScript ESM .js import must resolve to .ts file'
);
assert.strictEqual(
  resolveImportTarget('src/app.ts', './components', mockRepoFiles),
  'src/components/index.tsx',
  'Directory import must resolve to /index.tsx'
);
assert.strictEqual(
  resolveImportTarget('ui_bridge/js_api.py', 'core.eraser', mockRepoFiles),
  'core/eraser.py',
  'Python dotted module import must resolve'
);
assert.strictEqual(
  resolveImportTarget('core/providers/service.py', '.store', mockRepoFiles),
  'core/providers/store.py',
  'Python relative .store import must resolve'
);

// Verify real workspace caller graph & Pillar 3 Personalized PageRank with scopeFiles
const wsMap = scanWorkspaceSymbols(REPO_ROOT, ['agent-team/scripts', 'agent-team/runtime']);
const riskSym = wsMap.get('agent-team/scripts/lib/risk-policy.mjs');
assert.ok(riskSym && riskSym.callers.includes('agent-team/scripts/orchestrator.mjs'), 'risk-policy.mjs callers must include orchestrator.mjs via resolved ./lib/risk-policy.mjs import');

const pprRanks = computePersonalizedPageRank(wsMap, {
  keywords: ['risk'],
  scopeFiles: ['agent-team/scripts/orchestrator.mjs']
});
assert.ok((pprRanks.get('agent-team/scripts/orchestrator.mjs') || 0) > (pprRanks.get('agent-team/scripts/dashboard.mjs') || 0), 'Scoped file must receive higher Personalized PageRank than unscoped file');

const scopedMapOut = generateRepoMap(REPO_ROOT, {
  allowedDirs: ['agent-team/scripts', 'agent-team/runtime'],
  scopeFiles: ['agent-team/scripts/orchestrator.mjs'],
  maxChars: 1200
});
assert.ok(scopedMapOut.includes('[agent-team/scripts/orchestrator.mjs] [SCOPE]'), 'Scoped file must be tagged [SCOPE] and placed at top of Repo Map');
assert.ok(scopedMapOut.includes('additional files omitted to fit context budget'), 'Truncated Repo Map must explicitly report count of omitted files');

// 7.6 Verify Turn Grouping Resilience (Out-of-Order & Missing Tool Results) + Persistent Epoch Checkpoint
const messyMessages = [
  { role: 'user', content: 'Inspect files' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      { id: 'call_2', type: 'function', function: { name: 'search_code', arguments: '{}' } },
      { id: 'call_3', type: 'function', function: { name: 'list_files', arguments: '{}' } }
    ]
  },
  // Out-of-order result for call_2, call_1 is second, and call_3 is missing completely!
  { role: 'tool', tool_call_id: 'call_2', content: '{"matches":[],"count":0}' },
  { role: 'tool', tool_call_id: 'call_1', content: '{"file":"a.js","total_lines":10,"start_line":1,"end_line":10}' },
  { role: 'tool', tool_call_id: 'orphan_999', content: '{"Orphan":true}' }
];
const groupedTurns = groupMessagesIntoTurns(messyMessages);
assert.strictEqual(groupedTurns.length, 2);
const toolTurnMsgs = groupedTurns[1].messages;
assert.strictEqual(toolTurnMsgs.length, 4, 'Assistant + 3 ordered tool results (1 synthesized)');
assert.strictEqual(toolTurnMsgs[1].tool_call_id, 'call_1', 'Tool results must be ordered to match assistant.tool_calls');
assert.strictEqual(toolTurnMsgs[2].tool_call_id, 'call_2');
assert.strictEqual(toolTurnMsgs[3].tool_call_id, 'call_3', 'Missing tool result must be synthesized');
assert.ok(toolTurnMsgs[3].content.includes('missing or interrupted'));

// Verify Persistent Epoch Checkpoint in-place rotation
const epochSessionMsgs = [
  { role: 'user', content: 'CURRENT SCOPED FILE CONTENTS:\n' + 'A'.repeat(6000) },
  {
    role: 'assistant',
    content: 'Reading',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }]
  },
  { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ file: 'x.py', start_line: 1, end_line: 200, total_lines: 200, content: 'B'.repeat(6000) }) },
  { role: 'user', content: 'Recent turn 1' },
  { role: 'assistant', content: 'Recent reply 1' },
  { role: 'user', content: 'Recent turn 2' },
  { role: 'assistant', content: 'Recent reply 2' }
];
// Trigger epoch checkpoint with custom low watermark (1000 tokens)
const compactedEpoch = compactMessagesForContext(epochSessionMsgs, 2, {
  useEpochWatermark: true,
  highWatermarkTokens: 1000
});
assert.ok(compactedEpoch[0].content.includes('[COMPACTED EPOCH SUMMARY]'), 'Epoch compaction must stamp [COMPACTED EPOCH SUMMARY]');
assert.strictEqual(epochSessionMsgs.length, compactedEpoch.length, 'Session array must be checkpointed in-place');
assert.ok(epochSessionMsgs[0].content.includes('[COMPACTED EPOCH SUMMARY]'), 'Persisted session array must retain Epoch Checkpoint');
const postCheckpointTokens = estimatePayloadTokens(epochSessionMsgs);
assert.ok(postCheckpointTokens < 500, `Compacted epoch tokens (${postCheckpointTokens}) must drop well below watermark (1000)`);

// Verify Vision Base64 Token Normalization
const fakeBase64Img = 'data:image/png;base64,' + 'A'.repeat(70000);
const visionMsg = [{ role: 'user', content: [{ type: 'text', text: 'Hello' }, { type: 'image_url', image_url: { url: fakeBase64Img } }] }];
const visionTokens = estimatePayloadTokens(visionMsg, [{ name: 'read_file', description: 'Read file' }]);
assert.ok(visionTokens > 1024 && visionTokens < 1200, `Vision block must normalize to ~1024 tokens instead of raw base64 length (got ${visionTokens})`);

console.log('✓ Universal Task-Demand × Squad-Roster Matrix & 4 Invariants tests passed.\n');

console.log('====================================================');
console.log('ALL AGENT RUNTIME V3.0 CORE TESTS PASSED! 🚀🎯');
console.log('====================================================');
