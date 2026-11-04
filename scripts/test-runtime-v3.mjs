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
  parseToolCalls
} from '../runtime/provider-gateway.mjs';
import {
  compactMessagesForContext,
  loadSession,
  saveSession,
  SESSIONS_DIR
} from '../runtime/session-store.mjs';
import {
  executeTool,
  getAvailableToolSchemas,
  isDangerousCommand,
  toolListFiles,
  toolReadFile,
  toolRunCommand,
  toolSearchCode
} from '../runtime/tool-runtime.mjs';
import { loadRoleConfig } from '../runtime/index.mjs';

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

// Fallback tag in text
const fallbackMsg = {
  content: 'I need to check the code first.\n<tool_call>{"name": "search_code", "arguments": {"pattern": "liveStatus"}}</tool_call>\nAnd then inspect.'
};
const fallbackParsed = parseToolCalls(fallbackMsg);
assert.strictEqual(fallbackParsed.length, 1);
assert.strictEqual(fallbackParsed[0].name, 'search_code');
assert.strictEqual(fallbackParsed[0].arguments.pattern, 'liveStatus');

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

// 1-Model Minimal Onboarding inheritance check
const singleModelCfg = loadRoleConfig('designer', {
  providers: { local_9router: { base_url: 'http://127.0.0.1:11434/v1', default_key: 'ollama' } },
  roles: {
    writer: { enabled: true, model: 'qwen2.5-coder:14b' },
    router: { enabled: false },
    reviewer: { enabled: false }
  }
});
assert.strictEqual(singleModelCfg.model, 'qwen2.5-coder:14b', 'Designer role should inherit writer.model when router/designer omitted');
assert.strictEqual(singleModelCfg.base_url, 'http://127.0.0.1:11434/v1');
assert.strictEqual(singleModelCfg.api_key, 'ollama');

console.log('✓ Context & Vision Adapter + 1-Model Onboarding tests passed.');

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

// run_command security guardrail checks
assert.strictEqual(isDangerousCommand('del /f /s /q C:\\Windows'), true);
assert.strictEqual(isDangerousCommand('format d:'), true);
assert.strictEqual(isDangerousCommand('cat .env.production'), true);
assert.strictEqual(isDangerousCommand('type .env'), true);
assert.strictEqual(isDangerousCommand('git status --short'), false);
assert.strictEqual(isDangerousCommand('npm test'), false);

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

// Clean up test session file
const testSessionPath = path.resolve(SESSIONS_DIR, `${testSessionId}.json`);
if (fs.existsSync(testSessionPath)) {
  fs.unlinkSync(testSessionPath);
}

console.log('✓ Session Memory Store tests passed.\n');

console.log('====================================================');
console.log('ALL AGENT RUNTIME V3.0 CORE TESTS PASSED! 🚀🎯');
console.log('====================================================');
