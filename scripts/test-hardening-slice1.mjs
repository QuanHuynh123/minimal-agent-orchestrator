#!/usr/bin/env node
/**
 * SLICE-1 Verification Suite (agent-team/HARDENING_SPEC_V3.2.md §1):
 *   1. runtime/index.mjs: architect/designer synthesis prompt NEVER injects router `{"tasks":` JSON schema,
 *      while router synthesis STILL enforces `{"tasks": [...]}`.
 *   2. canReuseSpecOnMechanicalApplyRetry + E2E Orchestrator:
 *      - Attempt 1 stops at `stage: 'apply'` (`finish_reason: "length"`) -> Attempt 2 reuses Spec 0-token.
 *      - Attempt 1 fails unit test at `stage: 'validate'` -> Attempt 2 re-invokes `draft_spec` 100%.
 *   3. Multi-bucket safeRollback when `rollback_on_validation_fail: false` + per-bucket raw output logs:
 *      - Bucket 1 edits tracked file + creates new file; Bucket 2 fails `apply` -> Bucket 1 files reverted/removed,
 *        pre-existing untracked file preserved, and both `attempt-1-b1.txt` & `attempt-1-b2.txt` preserved.
 *   4. policy.yaml `context_max_file_bytes === 524288` & orchestrator.mjs reads `policyConfig?.policy?.scope_control?.context_exclude`.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from 'yaml';

import { runAgent } from '../runtime/index.mjs';
import {
  SPEC_REUSE_ON_RETRY_ENABLED,
  canReuseSpecOnMechanicalApplyRetry
} from './orchestrator.mjs';
import { saveWriterRawOutput } from './lib/task-persistence.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');
const ORCHESTRATOR_SCRIPT = path.join(__dirname, 'orchestrator.mjs');
const GATEWAY_URL = 'http://127.0.0.1:29997/v1';

// =========================================================================
// 1. runtime/index.mjs synthesis prompt role separation
// =========================================================================
async function testSynthesisPromptSeparation() {
  const tmpWork = fs.mkdtempSync(path.join(os.tmpdir(), 'td-slice1-synth-'));
  try {
    fs.writeFileSync(path.join(tmpWork, 'sample.js'), 'export const x = 1;\n', 'utf8');

    const runSynthesisForRole = async (roleName) => {
      const capturedUserPrompts = [];
      let callCount = 0;
      const mockFetch = async (_url, init) => {
        callCount++;
        const body = JSON.parse(String(init?.body || '{}'));
        const msgs = Array.isArray(body.messages) ? body.messages : [];
        const lastUser = [...msgs].reverse().find(m => m.role === 'user');
        capturedUserPrompts.push(String(lastUser?.content || ''));
        if (callCount === 1) {
          return new Response(JSON.stringify({
            id: `chatcmpl-s1-${roleName}-1`,
            object: 'chat.completion',
            model: 'mock-model',
            choices: [{
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [{
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'list_files',
                    arguments: JSON.stringify({ dir: '.' })
                  }
                }]
              }
            }],
            usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        const finalText = roleName === 'router'
          ? '{"tasks": []}'
          : '# Specification\n\n## Contract Table\n- Ready.';
        return new Response(JSON.stringify({
          id: `chatcmpl-s1-${roleName}-2`,
          object: 'chat.completion',
          model: 'mock-model',
          choices: [{
            index: 0,
            finish_reason: 'stop',
            message: { role: 'assistant', content: finalText }
          }],
          usage: { prompt_tokens: 150, completion_tokens: 30, total_tokens: 180 }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };

      const res = await runAgent({
        role: roleName,
        modelOverride: 'mock-model',
        baseUrlOverride: GATEWAY_URL,
        apiKeyOverride: 'mock-key',
        systemPromptOverride: `You are ${roleName}.`,
        prompt: 'Inspect workspace and produce output.',
        repoRoot: tmpWork,
        sessionsDir: path.join(tmpWork, `sess-${roleName}`),
        allowedDirs: ['*'],
        maxTurns: 1,
        stream: false,
        sessionId: `slice1-synth-${roleName}-${Date.now()}`,
        fetchFn: mockFetch
      });
      return { res, capturedUserPrompts };
    };

    const arch = await runSynthesisForRole('architect');
    assert.equal(arch.res.ok, true, 'architect synthesis must succeed');
    assert.equal(arch.capturedUserPrompts.length, 2, 'architect should invoke tool turn + synthesis turn');
    assert.ok(
      !arch.capturedUserPrompts[1].includes('{"tasks":'),
      `architect synthesis prompt must NEVER contain {"tasks":, got: ${arch.capturedUserPrompts[1]}`
    );
    assert.match(
      arch.capturedUserPrompts[1],
      /Markdown specification/i,
      'architect synthesis prompt must ask for a Markdown specification'
    );

    const designer = await runSynthesisForRole('designer');
    assert.equal(designer.res.ok, true, 'designer synthesis must succeed');
    assert.ok(
      !designer.capturedUserPrompts[1].includes('{"tasks":'),
      `designer synthesis prompt must NEVER contain {"tasks":, got: ${designer.capturedUserPrompts[1]}`
    );
    assert.match(
      designer.capturedUserPrompts[1],
      /Markdown specification/i,
      'designer synthesis prompt must ask for a Markdown specification'
    );

    const router = await runSynthesisForRole('router');
    assert.equal(router.res.ok, true, 'router synthesis must succeed');
    assert.ok(
      router.capturedUserPrompts[1].includes('{"tasks":'),
      'router synthesis prompt must keep {"tasks": [...]} JSON contract'
    );

    console.log('PASS  SLICE-1 (1): architect/designer synthesis prompt separated from router JSON prompt');
  } finally {
    fs.rmSync(tmpWork, { recursive: true, force: true });
  }
}

// =========================================================================
// 2. Unit checks: canReuseSpecOnMechanicalApplyRetry, saveWriterRawOutput, policy/orchestrator
// =========================================================================
function testUnitHelpersAndConfig() {
  assert.equal(SPEC_REUSE_ON_RETRY_ENABLED, false, 'Global SPEC_REUSE_ON_RETRY_ENABLED must stay false');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-slice1-unit-'));
  try {
    const specFile = path.join(tmpDir, 'spec.md');
    fs.writeFileSync(specFile, '# Technical Specification\n\n| Function | Input -> Output |\n| --- | --- |\n', 'utf8');

    // Mechanical apply failure on Attempt 1 -> Attempt 2 (retries = 1) MAY reuse
    assert.equal(
      canReuseSpecOnMechanicalApplyRetry({
        task: { error_history: [{ attempt: 1, stage: 'apply', summary: 'finish_reason="length"' }], steps: [] },
        retries: 1,
        specPath: specFile,
        currentScopeHash: 'hash-a',
        previousScopeHash: 'hash-a',
        specPassedContractGate: true
      }),
      true,
      'Pure mechanical apply retry with unchanged scope and valid spec must return true'
    );

    // Validate failure on Attempt 1 -> MUST return false
    assert.equal(
      canReuseSpecOnMechanicalApplyRetry({
        task: { error_history: [{ attempt: 1, stage: 'validate', summary: 'AssertionError' }], steps: [] },
        retries: 1,
        specPath: specFile,
        currentScopeHash: 'hash-a',
        previousScopeHash: 'hash-a',
        specPassedContractGate: true
      }),
      false,
      'Validation failure on Attempt 1 must NEVER reuse spec'
    );

    // Attempt 1 failed validate, Attempt 2 failed apply -> MUST STILL return false
    assert.equal(
      canReuseSpecOnMechanicalApplyRetry({
        task: {
          error_history: [
            { attempt: 1, stage: 'validate', summary: 'AssertionError' },
            { attempt: 2, stage: 'apply', summary: 'truncated' }
          ],
          steps: []
        },
        retries: 2,
        specPath: specFile,
        currentScopeHash: 'hash-a',
        previousScopeHash: 'hash-a',
        specPassedContractGate: true
      }),
      false,
      'Any prior validate failure must permanently disqualify spec reuse'
    );

    // Scope changed -> MUST return false
    assert.equal(
      canReuseSpecOnMechanicalApplyRetry({
        task: { error_history: [{ attempt: 1, stage: 'apply', summary: 'truncated' }], steps: [] },
        retries: 1,
        specPath: specFile,
        currentScopeHash: 'hash-b',
        previousScopeHash: 'hash-a',
        specPassedContractGate: true
      }),
      false,
      'Scope change between attempts must return false'
    );

    // Contract conflict -> MUST return false
    assert.equal(
      canReuseSpecOnMechanicalApplyRetry({
        task: {
          failure_class: 'contract_conflict',
          error_history: [{ attempt: 1, stage: 'apply', summary: 'truncated' }],
          steps: []
        },
        retries: 1,
        specPath: specFile,
        currentScopeHash: 'hash-a',
        previousScopeHash: 'hash-a',
        specPassedContractGate: true
      }),
      false,
      'Contract conflict must return false'
    );

    // saveWriterRawOutput filename contract: 1 bucket -> attempt-1.txt; >1 bucket -> attempt-1-b1.txt / b2.txt
    const singlePath = saveWriterRawOutput('T-RAW-1', 1, { content: 'single bucket content' }, tmpDir, { bucketIdx: 0, totalBuckets: 1 });
    assert.equal(path.basename(singlePath), 'attempt-1.txt', 'Single bucket must preserve attempt-1.txt filename');

    const b1Path = saveWriterRawOutput('T-RAW-2', 1, { content: 'bucket one output' }, tmpDir, { bucketIdx: 0, totalBuckets: 2 });
    const b2Path = saveWriterRawOutput('T-RAW-2', 1, { content: 'bucket two output' }, tmpDir, { bucketIdx: 1, totalBuckets: 2 });
    assert.equal(path.basename(b1Path), 'attempt-1-b1.txt');
    assert.equal(path.basename(b2Path), 'attempt-1-b2.txt');
    assert.match(fs.readFileSync(b1Path, 'utf8'), /bucket one output/);
    assert.match(fs.readFileSync(b2Path, 'utf8'), /bucket two output/);

    // Policy & orchestrator context_exclude path checks
    const policyParsed = yaml.parse(fs.readFileSync(path.join(TEAM_DIR, 'config', 'policy.yaml'), 'utf8'));
    assert.equal(policyParsed?.policy?.scope_control?.context_max_file_bytes, 524288, 'policy.yaml must set context_max_file_bytes: 524288');

    const orchSrc = fs.readFileSync(ORCHESTRATOR_SCRIPT, 'utf8');
    assert.ok(
      !orchSrc.includes('policyConfig?.scope_control?.context_exclude'),
      'orchestrator.mjs must not read broken policyConfig?.scope_control?.context_exclude'
    );
    assert.ok(
      orchSrc.includes('policyConfig?.policy?.scope_control?.context_exclude'),
      'orchestrator.mjs must read policyConfig?.policy?.scope_control?.context_exclude'
    );

    console.log('PASS  SLICE-1 (2): unit helpers, per-bucket raw log paths, policy 512KB & context_exclude path');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// =========================================================================
// 3. E2E Orchestrator tests (Spec reuse on length vs re-spec on validate + multi-bucket safeRollback)
// =========================================================================
function git(repoDir, ...args) {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
}

function patchText(file, search, replace) {
  return ['FILE: ' + file, '<<<<<<< SEARCH', search, '=======', replace, '>>>>>>> REPLACE'].join('\n');
}

function newFilePatch(file, content) {
  return ['FILE: ' + file, '<<<<<<< SEARCH', '=======', content, '>>>>>>> REPLACE'].join('\n');
}

function writeMockPreload(preloadPath, scenario) {
  const code = `
import fs from 'node:fs';
const TARGET_BASE = ${JSON.stringify(GATEWAY_URL)};
const SC = ${JSON.stringify(scenario)};
const log = (m) => { try { fs.appendFileSync(SC.requestLog, m + '\\n'); } catch {} };

const origFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : (input?.url || String(input));
  if (!url.startsWith(TARGET_BASE)) return origFetch(input, init);
  const method = String(init?.method || 'GET').toUpperCase();
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  if (method === 'GET' && url.endsWith('/models')) {
    return json({ object: 'list', data: [{ id: 'mock-writer' }, { id: 'mock-architect' }, { id: 'mock-reviewer' }] });
  }
  if (method === 'POST' && url.endsWith('/chat/completions')) {
    let body = {};
    try { body = JSON.parse(String(init?.body || '{}')); } catch {}
    const sysMsg = String(body.messages?.[0]?.content || '');
    const userMsg = String(body.messages?.[body.messages.length - 1]?.content || '');
    const reply = (content, finishReason = 'stop') => json({
      id: 'chatcmpl-s1-e2e', object: 'chat.completion', model: body.model || 'mock-writer',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
      usage: { prompt_tokens: 180, completion_tokens: 42, total_tokens: 222 }
    });
    if ((body.max_tokens && body.max_tokens <= 16) || /\\b(?:single word|ping|calibrate)\\b/i.test(userMsg)) {
      return reply('OK');
    }
    const bucketMatch = userMsg.match(/ALLOWED BUCKET SCOPE \\(ONLY modify these files in this step\\): ([^\\n]+)/);
    if (bucketMatch) {
      const firstFile = bucketMatch[1].split(',')[0].trim();
      const cfg = SC.buckets?.[firstFile];
      globalThis.__bucketCalls = globalThis.__bucketCalls || {};
      const callIdx = (globalThis.__bucketCalls[firstFile] = (globalThis.__bucketCalls[firstFile] ?? -1) + 1);
      const beh = Array.isArray(cfg) ? cfg[Math.min(callIdx, cfg.length - 1)] : cfg;
      log('bucket:' + firstFile + ':' + callIdx);
      if (!beh) return reply('NO_PATCH_CONFIGURED for ' + firstFile);
      return reply(beh.text, beh.finishReason || 'stop');
    }
    if (/Lead Software Architect|draft_spec|contract table/i.test(sysMsg + '\\n' + userMsg)) {
      log('spec');
      return reply('# Technical Specification\\n\\n| Function | Input -> Output | Error / Fallback Cases |\\n| --- | --- | --- |\\n| value | () -> 2 | none |\\n');
    }
    if (/post-code|review_diff|issues/i.test(sysMsg)) {
      return reply('{"passed": true, "issues": [], "summary": "ok"}');
    }
    return reply('pong');
  }
  return new Response('Not Found', { status: 404 });
};
`;
  fs.writeFileSync(preloadPath, code, 'utf8');
}

function runE2ECase({ name, taskId, taskYaml, initialFiles, checkScript = 'process.exit(0);\n', rollbackOnValidationFail = true, extraUntracked = null, scenario }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `td-s1-${name}-`));
  const repoDir = path.join(root, 'repo');
  const cfgDir = path.join(root, 'config');
  const stateDir = path.join(root, 'state');
  const tasksDir = path.join(root, 'tasks');
  const activeDir = path.join(tasksDir, 'active');
  const archiveDir = path.join(tasksDir, 'archive');
  const lockFile = path.join(root, '.orchestrator.lock');
  const preloadFile = path.join(root, 'mock-preload.mjs');
  for (const d of [repoDir, cfgDir, stateDir, activeDir, archiveDir]) fs.mkdirSync(d, { recursive: true });

  fs.writeFileSync(path.join(repoDir, '.gitignore'), 'agent-team/state/\n', 'utf8');
  fs.mkdirSync(path.join(repoDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'scripts', 'check.mjs'), checkScript, 'utf8');
  for (const [rel, content] of Object.entries(initialFiles)) {
    const full = path.join(repoDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  git(repoDir, 'init', '-b', 'master');
  git(repoDir, 'config', 'user.email', 's1@example.com');
  git(repoDir, 'config', 'user.name', 'Slice1 Runner');
  git(repoDir, 'add', '-A');
  git(repoDir, 'commit', '-m', 'init baseline');

  if (extraUntracked) {
    for (const [rel, content] of Object.entries(extraUntracked)) {
      const full = path.join(repoDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf8');
    }
  }

  fs.writeFileSync(path.join(cfgDir, 'team.yaml'), [
    'providers:',
    '  local_9router:',
    `    base_url: "${GATEWAY_URL}"`,
    'roles:',
    '  writer:',
    '    model: "mock-writer"',
    '    models:',
    '      - "mock-writer"',
    '  architect:',
    '    model: "mock-architect"',
    '  reviewer:',
    '    model: "mock-reviewer"'
  ].join('\n') + '\n', 'utf8');

  fs.writeFileSync(path.join(cfgDir, 'policy.yaml'), [
    'policy:',
    '  version: "3.1.0"',
    '  project_id: "slice1-hermetic"',
    `  repo_root: "${repoDir.replace(/\\/g, '/')}"`,
    '  scope_control:',
    '    max_files_per_task: 5',
    '    allow_new_files: true',
    '    allowed_dirs:',
    '      - "*"',
    '  approval_gates:',
    '    require_code_review: false',
    '    review_min_risk_level: "high"',
    '  retry_and_escalation:',
    '    max_retries_per_task: 2',
    '    abort_on_identical_error_count: 3',
    '  git_hygiene:',
    '    require_clean_worktree_before_start: false',
    `    rollback_on_validation_fail: ${rollbackOnValidationFail ? 'true' : 'false'}`,
    '    auto_commit_on_done: true',
    '    confirm_frontend_branch_before_merge: true',
    '    commit_message_prefix: "[AI-Task]"',
    '  validation:',
    '    max_baseline_failures: 3',
    '    max_baseline_runtime_sec: 30',
    '    fast_checks:',
    '      - name: "s1_fast"',
    '        run: "node scripts/check.mjs"',
    '        timeout_sec: 10',
    '    suite_checks:',
    '      - name: "s1_suite"',
    '        run: "node scripts/check.mjs"',
    '        timeout_sec: 10'
  ].join('\n') + '\n', 'utf8');

  const requestLog = path.join(root, 'requests.log');
  fs.writeFileSync(path.join(activeDir, `${taskId}.yaml`), taskYaml, 'utf8');
  writeMockPreload(preloadFile, { ...scenario, requestLog });

  const res = spawnSync(process.execPath, ['--import', pathToFileURL(preloadFile).href, ORCHESTRATOR_SCRIPT], {
    env: {
      ...process.env,
      AGENT_TEAM_CONFIG_DIR: cfgDir,
      AGENT_TEAM_STATE_DIR: stateDir,
      AGENT_TEAM_TASKS_DIR: tasksDir,
      ORCHESTRATOR_LOCK_FILE: lockFile
    },
    encoding: 'utf8',
    timeout: 120000
  });

  const statePath = path.join(stateDir, 'task-state.json');
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
  const allTasks = state
    ? [...(state.completed_tasks || []), ...(state.blocked_tasks || []), ...(state.failed_tasks || []), ...(state.active_tasks || [])]
    : [];
  const reqLines = fs.existsSync(requestLog) ? fs.readFileSync(requestLog, 'utf8').trim().split('\n').filter(Boolean) : [];
  return {
    root,
    repoDir,
    stateDir,
    code: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    task: allTasks.find(t => t.task_id === taskId) || null,
    reqLines
  };
}

function testE2ESpecReuseAndMultiBucketRollback() {
  // Case A: finish_reason="length" on Attempt 1 -> Attempt 2 reuses Spec 0-token
  {
    const taskId = 'T-S1-REUSE-LEN';
    const taskYaml = [
      'task:',
      `  task_id: ${taskId}`,
      '  title: "Reuse spec after mechanical length truncation"',
      '  goal: "Update src/a.js value to 2"',
      '  mode: standard',
      '  risk_level: medium',
      '  status: ready',
      '  scope:',
      '    - src/a.js',
      '  acceptance_criteria:',
      '    - "src/a.js exports value = 2"',
      '  manual_workflow_override: true',
      '  writer_hub_workflow:',
      '    - step: 1',
      '      role: architect',
      '      action: draft_spec',
      '      sub_scope: [src/a.js]',
      '    - step: 2',
      '      role: writer',
      '      action: apply_patch',
      '      sub_scope: [src/a.js]'
    ].join('\n') + '\n';

    const r = runE2ECase({
      name: 'reuse-len',
      taskId,
      taskYaml,
      initialFiles: { 'src/a.js': 'export const value = 1;\n' },
      checkScript: 'import fs from "node:fs"; const t = fs.readFileSync("src/a.js","utf8"); process.exit(t.includes("value = 1") || t.includes("value = 2") ? 0 : 1);\n',
      scenario: {
        buckets: {
          'src/a.js': [
            { text: 'FILE: src/a.js\n<<<<<<< SEARCH\nexport const value = 1;\n=======\nexport const value =', finishReason: 'length' },
            { text: patchText('src/a.js', 'export const value = 1;', 'export const value = 2;'), finishReason: 'stop' }
          ]
        }
      }
    });
    try {
      assert.equal(r.code, 0, `Case A failed:\n${r.stdout}\n${r.stderr}`);
      assert.equal(r.task?.status, 'done', `Case A expected done, got ${r.task?.status} (block_reason=${r.task?.block_reason})\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
      const specCalls = r.reqLines.filter(l => l === 'spec');
      assert.equal(specCalls.length, 1, `Expected exactly 1 architect spec LLM call (Attempt 2 reused 0-token), got ${specCalls.length}: ${r.reqLines.join(', ')}`);
      const reuseSteps = (r.task?.steps || []).filter(s => s.action === 'reuse_spec' && s.status === 'reused_0_token');
      assert.equal(reuseSteps.length, 1, 'Expected 1 reuse_spec 0-token step recorded in task.steps');
      console.log('PASS  SLICE-1 (3A): finish_reason="length" reuses Spec 0-token on Attempt 2');
    } finally {
      fs.rmSync(r.root, { recursive: true, force: true });
    }
  }

  // Case B: validation test fails on Attempt 1 -> Attempt 2 MUST re-invoke draft_spec (NOT reuse)
  {
    const taskId = 'T-S1-RESPEC-VAL';
    const taskYaml = [
      'task:',
      `  task_id: ${taskId}`,
      '  title: "Must re-draft spec after validation failure"',
      '  goal: "Update src/a.js value to 2"',
      '  mode: standard',
      '  risk_level: medium',
      '  status: ready',
      '  scope:',
      '    - src/a.js',
      '  acceptance_criteria:',
      '    - "src/a.js exports value = 2"',
      '  manual_workflow_override: true',
      '  writer_hub_workflow:',
      '    - step: 1',
      '      role: architect',
      '      action: draft_spec',
      '      sub_scope: [src/a.js]',
      '    - step: 2',
      '      role: writer',
      '      action: apply_patch',
      '      sub_scope: [src/a.js]'
    ].join('\n') + '\n';

    const r = runE2ECase({
      name: 'respec-val',
      taskId,
      taskYaml,
      initialFiles: { 'src/a.js': 'export const value = 1;\n' },
      checkScript: 'import fs from "node:fs"; const t = fs.readFileSync("src/a.js","utf8"); if (t.includes("value = 999")) { console.error("AssertionError: expected 2 not 999"); process.exit(1); } process.exit(0);\n',
      scenario: {
        buckets: {
          'src/a.js': [
            { text: patchText('src/a.js', 'export const value = 1;', 'export const value = 999;'), finishReason: 'stop' },
            { text: patchText('src/a.js', 'export const value = 1;', 'export const value = 2;'), finishReason: 'stop' }
          ]
        }
      }
    });
    try {
      assert.equal(r.code, 0, `Case B failed:\n${r.stdout}\n${r.stderr}`);
      assert.equal(r.task?.status, 'done', `Case B expected done, got ${r.task?.status}`);
      const specCalls = r.reqLines.filter(l => l === 'spec');
      assert.equal(specCalls.length, 2, `Expected 2 architect spec LLM calls after validate failure, got ${specCalls.length}`);
      const reuseSteps = (r.task?.steps || []).filter(s => s.action === 'reuse_spec');
      assert.equal(reuseSteps.length, 0, 'Validate failure must NEVER record reuse_spec');
      console.log('PASS  SLICE-1 (3B): validate failure ALWAYS re-invokes draft_spec (0 reuse)');
    } finally {
      fs.rmSync(r.root, { recursive: true, force: true });
    }
  }

  // Case C: Multi-bucket apply failure with rollback_on_validation_fail: false ->
  //   Bucket 1 tracked+untracked edits rolled back, unrelated pre-existing untracked preserved,
  //   and attempt-1-b1.txt + attempt-1-b2.txt both saved without overwrite.
  {
    const taskId = 'T-S1-MULTI-RB';
    const taskYaml = [
      'task:',
      `  task_id: ${taskId}`,
      '  title: "Multi-bucket safeRollback under rollback_on_validation_fail=false"',
      '  goal: "Modify src/a.js, create src/new_b1.js, and modify src/b.js"',
      '  mode: quick',
      '  risk_level: low',
      '  status: ready',
      '  scope:',
      '    - src/a.js',
      '    - src/new_b1.js',
      '    - src/b.js',
      '  acceptance_criteria:',
      '    - "All files updated cleanly"',
      '  manual_workflow_override: true',
      '  writer_hub_workflow:',
      '    - step: 1',
      '      role: writer',
      '      action: apply_patch',
      '      sub_scope: [src/a.js, src/new_b1.js]',
      '    - step: 2',
      '      role: writer',
      '      action: apply_patch',
      '      sub_scope: [src/b.js]'
    ].join('\n') + '\n';

    const b1Patch = [
      patchText('src/a.js', 'export const a = 1;', 'export const a = 2;'),
      newFilePatch('src/new_b1.js', 'export const createdByB1 = true;\n')
    ].join('\n\n');

    const r = runE2ECase({
      name: 'multi-rb',
      taskId,
      taskYaml,
      rollbackOnValidationFail: false,
      initialFiles: {
        'src/a.js': 'export const a = 1;\n',
        'src/b.js': 'export const b = 1;\n'
      },
      extraUntracked: {
        'notes/keep-me.txt': 'do not delete this pre-existing untracked file\n'
      },
      scenario: {
        buckets: {
          'src/a.js': [{ text: b1Patch, finishReason: 'stop' }],
          'src/b.js': [
            { text: patchText('src/b.js', 'NONEXISTENT_ANCHOR_BLOCK', 'export const b = 2;'), finishReason: 'stop' },
            { text: 'FILE: src/b.js\n<<<<<<< SEARCH\nexport const b = 1;\n=======\nexport const b =', finishReason: 'length' },
            { text: patchText('src/b.js', 'STILL_BAD_BLOCK', 'export const b = 3;'), finishReason: 'stop' }
          ]
        }
      }
    });
    try {
      assert.ok(
        ['failed', 'blocked'].includes(r.task?.status),
        `Case C expected failed/blocked, got ${r.task?.status}\n${r.stdout}\n${r.stderr}`
      );
      // Bucket 1 tracked edit must be reverted to baseline
      assert.equal(
        fs.readFileSync(path.join(r.repoDir, 'src/a.js'), 'utf8').replace(/\r\n/g, '\n'),
        'export const a = 1;\n',
        'Bucket 1 tracked edit src/a.js must be rolled back even when rollback_on_validation_fail: false'
      );
      // Bucket 1 newly created file must be removed
      assert.equal(
        fs.existsSync(path.join(r.repoDir, 'src/new_b1.js')),
        false,
        'Bucket 1 new file src/new_b1.js must be deleted by safeRollback'
      );
      // Pre-existing unrelated untracked file must be preserved untouched
      assert.equal(
        fs.existsSync(path.join(r.repoDir, 'notes/keep-me.txt')),
        true,
        'Pre-existing untracked file notes/keep-me.txt must NOT be deleted'
      );
      assert.equal(
        fs.readFileSync(path.join(r.repoDir, 'notes/keep-me.txt'), 'utf8'),
        'do not delete this pre-existing untracked file\n'
      );
      // Both per-bucket raw logs must exist for Attempt 1 (no overwrite)
      const runDir = path.join(r.stateDir, 'runs', taskId);
      assert.ok(fs.existsSync(path.join(runDir, 'attempt-1-b1.txt')), 'attempt-1-b1.txt must be persisted');
      assert.ok(fs.existsSync(path.join(runDir, 'attempt-1-b2.txt')), 'attempt-1-b2.txt must be persisted');
      assert.match(fs.readFileSync(path.join(runDir, 'attempt-1-b1.txt'), 'utf8'), /createdByB1/);
      assert.match(fs.readFileSync(path.join(runDir, 'attempt-1-b2.txt'), 'utf8'), /NONEXISTENT_ANCHOR_BLOCK/);
      console.log('PASS  SLICE-1 (3C): multi-bucket safeRollback under rollback_on_validation_fail=false + per-bucket raw logs');
    } finally {
      fs.rmSync(r.root, { recursive: true, force: true });
    }
  }
}

await testSynthesisPromptSeparation();
testUnitHelpersAndConfig();
testE2ESpecReuseAndMultiBucketRollback();
console.log('test-hardening-slice1.mjs: ALL PASSED');
