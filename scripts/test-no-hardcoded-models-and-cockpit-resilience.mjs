#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import YAML from 'yaml';
import { decomposeGoal } from './goal-planner.mjs';
import { handleModelsRoutes } from './server/routes-models.mjs';
import { DASHBOARD_CSRF_TOKEN } from './server/security.mjs';
import { createSnapshot } from './server/state-reader.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(TEAM_DIR, '..');

console.log('Testing Item 7: Zero hardcoded model IDs outside team.yaml, Cockpit unknown-key resilience, and Pitfall note...\n');

// 1. Scan runtime/, scripts/ (non-test/non-benchmark), ui/ for hardcoded model IDs
const FORBIDDEN_HARDCODED_MODELS = [
  'ag/gemini-3.8-flash-medium',
  'ag/claude-sonnet-5-5',
  'ag/claude-opus-5-5-medium',
  'ag/claude-opus-5-5-high',
  'kr/claude-sonnet-4.5-thinking',
  'deepseek-ai/deepseek-v4.1-flash-1017',
  'Deepseek V4.1 Flash/deepseek-ai/deepseek-v4.1-flash-1017'
];

function collectCodeFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'assets', 'state', 'tasks', 'config'].includes(entry.name)) continue;
      collectCodeFiles(full, files);
    } else if (/\.(mjs|js|html)$/i.test(entry.name)) {
      const base = entry.name;
      if (
        base.startsWith('test-') ||
        base.includes('benchmark') ||
        base.startsWith('measure-') ||
        base.startsWith('score-') ||
        base.startsWith('calibrate-') ||
        base.startsWith('inspect-') ||
        base.startsWith('probe-')
      ) {
        continue;
      }
      files.push(full);
    }
  }
  return files;
}

const targetFiles = [
  ...collectCodeFiles(path.join(TEAM_DIR, 'runtime')),
  ...collectCodeFiles(path.join(TEAM_DIR, 'scripts')),
  ...collectCodeFiles(path.join(TEAM_DIR, 'ui'))
];

const violations = [];
for (const fp of targetFiles) {
  const content = fs.readFileSync(fp, 'utf8');
  for (const modelId of FORBIDDEN_HARDCODED_MODELS) {
    if (content.includes(modelId)) {
      violations.push(`${path.relative(TEAM_DIR, fp)} contains hardcoded "${modelId}"`);
    }
  }
}
assert.deepEqual(violations, [], `Hardcoded model IDs found outside team.yaml:\n${violations.join('\n')}`);

// 2. Consult mode in goal-planner.mjs must read reviewer/role model from team.yaml (never hardcoded ag/claude-opus-5-5-high)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-item7-'));
try {
  const cfgDir = path.join(tmpDir, 'config');
  const repoDir = path.join(tmpDir, 'repo');
  const stateDir = path.join(tmpDir, 'state');
  const tasksDir = path.join(tmpDir, 'tasks');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'core'), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(tasksDir, 'active'), { recursive: true });
  fs.mkdirSync(path.join(tasksDir, 'archive'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'core', 'mod.py'), 'def fn():\n\treturn 1\n', 'utf8');

  fs.writeFileSync(path.join(cfgDir, 'policy.yaml'), [
    'policy:',
    '  version: "3.1.0"',
    '  project_id: "item7-test"',
    '  scope_control:',
    '    allowed_dirs: ["core/"]'
  ].join('\n'), 'utf8');

  const teamFile = path.join(cfgDir, 'team.yaml');
  fs.writeFileSync(teamFile, [
    'providers:',
    '  local_9router:',
    '    base_url: "http://127.0.0.1:29999/v1"',
    '    default_key: "sk-test"',
    'unknown_top_level_key:',
    '  flag: true',
    '  nested: [1, 2, 3]',
    'spec_models:',
    '  low: "custom/spec-cheap"',
    '  medium: "custom/spec-cheap"',
    '  high: "custom/spec-strong"',
    '  critical: "custom/spec-strong"',
    'routing:',
    '  rules:',
    '    - name: "r1"',
    '      domain: "backend"',
    '      model: "custom/writer-model"',
    'roles:',
    '  router:',
    '    enabled: true',
    '    model: "custom/router-model"',
    '  writer:',
    '    enabled: true',
    '    model: "custom/writer-model"',
    '    models:',
    '      - "custom/writer-model"',
    '      - id: "custom/writer-obj-fallback"',
    '        disabled: false',
    '      - id: "custom/writer-obj-disabled"',
    '        disabled: true',
    '    unknown_role_extra: { note: "ok" }',
    '  reviewer:',
    '    enabled: true',
    '    model: "custom/reviewer-opus-model"',
    '  custom_unknown_role:',
    '    enabled: true',
    '    model: "custom/specialist-model"'
  ].join('\n'), 'utf8');

  const consultRes = await decomposeGoal('Tư vấn kiến trúc opus cho core/mod.py', {
    configDir: cfgDir,
    repoRoot: repoDir,
    dryRun: true,
    fetchFn: async () => new Response(JSON.stringify({
      id: 'resp-c',
      model: 'custom/router-model',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: JSON.stringify({
            tasks: [{
              title: 'Consult architecture',
              goal: 'Review architecture in core/mod.py',
              kind: 'feature',
              mode: 'consult',
              role: 'reviewer',
              risk_level: 'low',
              scope: ['core/mod.py'],
              acceptance_criteria: ['Provide clear advice']
            }]
          })
        },
        finish_reason: 'stop'
      }],
      usage: { prompt_tokens: 100, completion_tokens: 50 }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  });
  assert.equal(consultRes.ok, true);
  assert.equal(
    consultRes.tasks[0].model,
    'custom/reviewer-opus-model',
    'Consult mode must pick reviewer model from team.yaml instead of hardcoded ag/claude-opus-5-5-high'
  );

  // 3. /api/models fallback when 9Router unreachable returns ONLY team.yaml models (no hardcoded IDs)
  let modelsJson = '';
  const mockModelsRes = {
    writeHead() {},
    end(chunk) { modelsJson += String(chunk || ''); }
  };
  await handleModelsRoutes(
    { method: 'GET', headers: {} },
    mockModelsRes,
    new URL('http://127.0.0.1/api/models'),
    { TEAM_CONFIG_FILE: teamFile }
  );
  const parsedModels = JSON.parse(modelsJson);
  assert.equal(parsedModels.ok, true);
  const fallbackIds = parsedModels.models.map(m => m.id);
  assert.ok(fallbackIds.includes('custom/writer-model'));
  for (const forbidden of FORBIDDEN_HARDCODED_MODELS) {
    assert.ok(!fallbackIds.includes(forbidden), `/api/models fallback must not inject hardcoded "${forbidden}"`);
  }

  // 4. Cockpit createSnapshot & app.js must not crash with unknown keys / object entries in models
  const snap = await createSnapshot({
    CONFIG_DIR: cfgDir,
    TEAM_DIR: tmpDir,
    STATE_DIR: stateDir,
    TASKS_ACTIVE_DIR: path.join(tasksDir, 'active'),
    TASKS_ARCHIVE_DIR: path.join(tasksDir, 'archive'),
    LOCK_FILE: path.join(tmpDir, '.orchestrator.lock'),
    COCKPIT_LOCK_FILE: path.join(tmpDir, '.cockpit.lock'),
    LIVE_STATUS_FILE: path.join(stateDir, 'live-status.json'),
    TASK_STATE_FILE: path.join(stateDir, 'task-state.json'),
    RUNS_DIR: path.join(stateDir, 'runs'),
    SESSIONS_DIR: path.join(stateDir, 'sessions')
  });
  assert.ok(snap && snap.roles, 'createSnapshot must succeed when team.yaml contains unknown keys');

  // Verify spec_models and unknown keys survive POST /api/save-team-config round-trip in Cockpit
  const saveReq = Readable.from([Buffer.from(JSON.stringify({
    roles: {
      router: { model: 'custom/router-model', models: ['custom/router-model'], display_name: 'Router' },
      writer: {
        model: 'custom/writer-model',
        models: ['custom/writer-model', 'custom/writer-obj-fallback'],
        display_name: 'Writer'
      },
      reviewer: { model: 'custom/reviewer-opus-model', models: ['custom/reviewer-opus-model'], display_name: 'Reviewer' },
      custom_unknown_role: { model: 'custom/specialist-model', models: ['custom/specialist-model'], display_name: 'Specialist' }
    },
    provider: { base_url: 'http://127.0.0.1:29999/v1', default_key: 'sk-test-2' }
  }), 'utf8')]);
  saveReq.method = 'POST';
  saveReq.headers = { 'content-type': 'application/json', 'x-dashboard-token': DASHBOARD_CSRF_TOKEN };
  let saveStatus = 0;
  let saveBody = '';
  await handleModelsRoutes(
    saveReq,
    { writeHead(code) { saveStatus = code; }, end(chunk) { saveBody += String(chunk || ''); } },
    new URL('http://127.0.0.1/api/save-team-config'),
    { TEAM_CONFIG_FILE: teamFile }
  );
  assert.equal(saveStatus, 200, `Expected 200 from /api/save-team-config, got ${saveStatus}: ${saveBody}`);
  const savedAfterCockpit = YAML.parse(fs.readFileSync(teamFile, 'utf8'));
  assert.deepEqual(savedAfterCockpit.spec_models, {
    low: 'custom/spec-cheap',
    medium: 'custom/spec-cheap',
    high: 'custom/spec-strong',
    critical: 'custom/spec-strong'
  }, 'spec_models must survive Cockpit /api/save-team-config untouched');
  assert.deepEqual(savedAfterCockpit.unknown_top_level_key, { flag: true, nested: [1, 2, 3] });
  assert.deepEqual(savedAfterCockpit.roles?.writer?.unknown_role_extra, { note: 'ok' });
  assert.equal(savedAfterCockpit.roles?.custom_unknown_role?.model, 'custom/specialist-model');

  const appJs = fs.readFileSync(path.join(TEAM_DIR, 'ui', 'js', 'app.js'), 'utf8');
  assert.ok(!appJs.includes('mId.split('), 'app.js must normalize model entries before calling .split() so object entries in models[] cannot crash Cockpit');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// 5. Verify Pitfall note & config-change rule in agent-team/DECISIONS.md (when present)
const decisionsPath = path.join(TEAM_DIR, 'DECISIONS.md');
if (fs.existsSync(decisionsPath)) {
  const decisionsMd = fs.readFileSync(decisionsPath, 'utf8');
  assert.match(decisionsMd, /team\.yaml.*Cockpit/i, 'agent-team/DECISIONS.md must document that Cockpit writes team.yaml and schema changes must preserve read/write round-trip');
  assert.match(decisionsMd, /liệt kê.*đọc.*ghi/i, 'agent-team/DECISIONS.md must include rule to list all readers and writers (including Cockpit) before changing any config file structure');
}

console.log('✓ Item 7 tests PASSED!');
