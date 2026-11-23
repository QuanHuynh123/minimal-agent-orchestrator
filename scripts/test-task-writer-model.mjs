#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWriterSelection } from './lib/risk-policy.mjs';
import { decomposeGoal } from './goal-planner.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');

console.log('Testing Item 3: Task writer_model roster+disabled guard & Goal Studio selector...\n');

const teamCfg = {
  providers: { local_9router: { base_url: 'http://127.0.0.1:20128/v1', default_key: 'sk-test' } },
  disabled_models: ['global/blocked-model'],
  roles: {
    router: {
      enabled: true,
      model: 'ag/gemini-3.8-flash-medium',
      disabled_models: [{ id: 'kr/claude-sonnet-4.5-thinking', disabled: true, reason: 'HTTP 400' }]
    },
    writer: {
      enabled: true,
      model: 'deepseek-ai/deepseek-v4.1-flash-1017',
      models: ['deepseek-ai/deepseek-v4.1-flash-1017', 'ag/gemini-3.8-flash-medium']
    },
    designer: {
      enabled: true,
      model: 'ag/claude-sonnet-5-5'
    },
    reviewer: {
      enabled: true,
      model: 'ag/claude-opus-5-5-medium'
    }
  }
};

// 1a. Valid writer_model in active roster
const okSel = resolveWriterSelection({ task_id: 'T-1', writer_model: 'ag/claude-sonnet-5-5', scope: ['core/a.py'] }, teamCfg);
assert.equal(okSel.ok, true);
assert.equal(okSel.selected_by, 'task_override');
assert.equal(okSel.requested_model, 'ag/claude-sonnet-5-5');
assert.equal(okSel.actual_model, 'ag/claude-sonnet-5-5');
assert.deepEqual(okSel.fallback_models, []);

// 1b. writer_model not in roster -> blocked loudly, NO silent substitution
const unknownSel = resolveWriterSelection({ task_id: 'T-2', writer_model: 'openai/nonexistent-model', scope: ['core/a.py'] }, teamCfg);
assert.equal(unknownSel.ok, false, 'Unknown writer_model must be blocked, not substituted');
assert.equal(unknownSel.actual_model, null);
assert.match(unknownSel.blocked_reason, /roster|not in|không nằm trong/i);

// 1c. writer_model disabled in config -> blocked loudly, NO silent substitution
const disabledRoleSel = resolveWriterSelection({ task_id: 'T-3', writer_model: 'kr/claude-sonnet-4.5-thinking', scope: ['core/a.py'] }, teamCfg);
assert.equal(disabledRoleSel.ok, false, 'Disabled writer_model must be blocked');
assert.equal(disabledRoleSel.actual_model, null);
assert.match(disabledRoleSel.blocked_reason, /disabled/i);

const disabledGlobalSel = resolveWriterSelection({ task_id: 'T-4', writer_model: 'global/blocked-model', scope: ['core/a.py'] }, teamCfg);
assert.equal(disabledGlobalSel.ok, false, 'Globally disabled writer_model must be blocked');
assert.equal(disabledGlobalSel.actual_model, null);

// 1d. Valid writer_model that fails preflight/circuit breaker -> blocked loudly, NO fallback
const preflightBlocked = resolveWriterSelection(
  { task_id: 'T-5', writer_model: 'ag/gemini-3.8-flash-medium', scope: ['core/a.py'] },
  teamCfg,
  { preflightFailedModels: new Set(['ag/gemini-3.8-flash-medium']) }
);
assert.equal(preflightBlocked.ok, false, 'Failed-preflight task writer_model must block, never silent-fallback');
assert.equal(preflightBlocked.actual_model, null);
assert.match(preflightBlocked.blocked_reason, /preflight/i);

// 2. decomposeGoal with writerModel option
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-wm-goal-'));
try {
  const cfgDir = path.join(tmpDir, 'config');
  const repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'core'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'core', 'app.py'), 'def ping():\n\treturn True\n', 'utf8');
  fs.writeFileSync(path.join(cfgDir, 'policy.yaml'), [
    'policy:',
    '  version: "3.1.0"',
    '  project_id: "wm-test"',
    '  scope_control:',
    '    allowed_dirs: ["core/", "tests/"]'
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(cfgDir, 'team.yaml'), [
    'providers:',
    '  local_9router:',
    '    base_url: "http://127.0.0.1:20128/v1"',
    '    default_key: "sk-test"',
    'roles:',
    '  router:',
    '    enabled: true',
    '    model: "ag/gemini-3.8-flash-medium"',
    '    disabled_models:',
    '      - id: "kr/claude-sonnet-4.5-thinking"',
    '        disabled: true',
    '  writer:',
    '    enabled: true',
    '    model: "deepseek-ai/deepseek-v4.1-flash-1017"',
    '    models:',
    '      - "deepseek-ai/deepseek-v4.1-flash-1017"',
    '      - "ag/gemini-3.8-flash-medium"',
    '  designer:',
    '    enabled: true',
    '    model: "ag/claude-sonnet-5-5"'
  ].join('\n'), 'utf8');

  let llmCalls = 0;
  const mockFetch = async () => {
    llmCalls++;
    return new Response(JSON.stringify({
      id: 'resp-1',
      model: 'ag/gemini-3.8-flash-medium',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: JSON.stringify({
            tasks: [{
              title: 'Update ping in core/app.py',
              goal: 'Update ping return value in core/app.py',
              kind: 'feature',
              mode: 'quick',
              risk_level: 'low',
              scope: ['core/app.py'],
              acceptance_criteria: ['ping works']
            }]
          })
        },
        finish_reason: 'stop'
      }],
      usage: { prompt_tokens: 100, completion_tokens: 50 }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  // Invalid writerModel must reject BEFORE calling LLM (0 calls)
  const invalidGoalRes = await decomposeGoal('Update ping in core/app.py', {
    configDir: cfgDir,
    repoRoot: repoDir,
    dryRun: true,
    writerModel: 'kr/claude-sonnet-4.5-thinking',
    fetchFn: mockFetch
  });
  assert.equal(invalidGoalRes.ok, false, 'Disabled writerModel in decomposeGoal must fail fast');
  assert.equal(llmCalls, 0, 'Must not call Router LLM when explicit writerModel is invalid/disabled');
  assert.match(invalidGoalRes.error, /disabled/i);

  // Valid writerModel sets writer_model and writer_model_source='user'
  const validGoalRes = await decomposeGoal('Update ping in core/app.py', {
    configDir: cfgDir,
    repoRoot: repoDir,
    dryRun: true,
    writerModel: 'ag/claude-sonnet-5-5',
    fetchFn: mockFetch
  });
  assert.equal(validGoalRes.ok, true, `Expected valid goal decompose, got: ${validGoalRes.error}`);
  assert.equal(validGoalRes.tasks[0].writer_model, 'ag/claude-sonnet-5-5');
  assert.equal(validGoalRes.tasks[0].writer_model_source, 'user');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// 3. Goal Studio UI selector & app.js wiring
const centralStageHtml = fs.readFileSync(path.resolve(TEAM_DIR, 'ui', 'layouts', 'layout-central-stage.html'), 'utf8');
assert.ok(centralStageHtml.includes('id="sel-goal-writer-model"'), 'Goal Studio must include #sel-goal-writer-model select element');

const appJsSrc = fs.readFileSync(path.resolve(TEAM_DIR, 'ui', 'js', 'app.js'), 'utf8');
assert.ok(appJsSrc.includes('sel-goal-writer-model'), 'app.js must bind #sel-goal-writer-model');
assert.ok(appJsSrc.includes('writer_model'), 'app.js must forward writer_model in decompose request');

console.log('✓ Item 3 tests PASSED!');
