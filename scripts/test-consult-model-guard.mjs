import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as riskPolicy from './lib/risk-policy.mjs';
import { decomposeGoal } from './goal-planner.mjs';
import { loadRoleConfig, runAgent } from '../runtime/index.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');

async function runTests() {
  assert.equal(
    typeof riskPolicy.resolveConsultModelSelection,
    'function',
    'risk-policy.mjs must export resolveConsultModelSelection'
  );

  // 1a. Consult task missing designer model MUST fall back to cheap router model, NEVER expensive reviewer
  const routerFallbackRes = riskPolicy.resolveConsultModelSelection(
    { task_id: 'T-CONSULT-1', mode: 'consult', role: 'designer' },
    {
      roles: {
        router: { enabled: true, model: 'ag/gemini-3.8-flash-medium' },
        writer: { enabled: true, models: ['deepseek-v4.1'] },
        designer: { enabled: true },
        reviewer: { enabled: true, default_model: 'ag/claude-opus-5-5-medium', models: ['ag/claude-opus-5-5-medium'] }
      }
    }
  );
  assert.equal(routerFallbackRes.ok, true, `Expected cheap router fallback, got: ${JSON.stringify(routerFallbackRes)}`);
  assert.equal(routerFallbackRes.model, 'ag/gemini-3.8-flash-medium');
  assert.equal(routerFallbackRes.source, 'router_fallback');
  assert.notEqual(routerFallbackRes.model, 'ag/claude-opus-5-5-medium', 'Must NEVER silently escalate missing consult model to reviewer');

  // 1b. Role configured with models[] only (no model/default_model) resolves models[0]
  const roleArrayRes = riskPolicy.resolveConsultModelSelection(
    { task_id: 'T-CONSULT-2', mode: 'consult', role: 'designer' },
    {
      roles: {
        router: { enabled: true, model: 'ag/gemini-3.8-flash-medium' },
        designer: { enabled: true, models: ['ag/claude-sonnet-5-5'] },
        reviewer: { enabled: true, model: 'ag/claude-opus-5-5-medium' }
      }
    }
  );
  assert.equal(roleArrayRes.ok, true);
  assert.equal(roleArrayRes.model, 'ag/claude-sonnet-5-5');
  assert.equal(roleArrayRes.source, 'role_config');

  // 1c. Consult missing model and no active router model -> clear declaration error EVEN IF reviewer exists
  const noModelRes = riskPolicy.resolveConsultModelSelection(
    { task_id: 'T-CONSULT-3', mode: 'consult', role: 'designer', model: '   ' },
    {
      roles: {
        router: { enabled: false, model: 'ag/gemini-3.8-flash-medium' },
        writer: { enabled: true, model: 'deepseek-v4.1' },
        designer: { enabled: true, model: '' },
        reviewer: { enabled: true, model: 'ag/claude-opus-5-5-medium' }
      }
    }
  );
  assert.equal(noModelRes.ok, false, 'Consult with no configured model and no active router must fail instead of using reviewer');
  assert.equal(noModelRes.model, null);
  assert.match(String(noModelRes.error || ''), /no model|khai báo|router/i);

  // 1d. Disabled consult role fails clearly even if router & reviewer are enabled
  const disabledRoleRes = riskPolicy.resolveConsultModelSelection(
    { task_id: 'T-CONSULT-4', mode: 'consult', role: 'designer' },
    {
      roles: {
        router: { enabled: true, model: 'ag/gemini-3.8-flash-medium' },
        designer: { enabled: false, model: 'ag/claude-sonnet-5-5' },
        reviewer: { enabled: true, model: 'ag/claude-opus-5-5-medium' }
      }
    }
  );
  assert.equal(disabledRoleRes.ok, false);
  assert.match(String(disabledRoleRes.error || ''), /disabled/i);

  // 1e. Disabled explicit task.model on consult task fails clearly
  const disabledTaskModelRes = riskPolicy.resolveConsultModelSelection(
    { task_id: 'T-CONSULT-5', mode: 'consult', role: 'designer', model: 'kr/claude-sonnet-4.5-thinking' },
    {
      roles: {
        designer: {
          enabled: true,
          model: 'ag/claude-sonnet-5-5',
          disabled_models: [{ id: 'kr/claude-sonnet-4.5-thinking', disabled: true }]
        }
      }
    }
  );
  assert.equal(disabledTaskModelRes.ok, false);
  assert.match(String(disabledTaskModelRes.error || ''), /disabled/i);

  // 2. End-to-end decomposeGoal & runAgent consult guards in temp workspace
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-consult-guard-'));
  try {
    const cfgDir = path.join(tmpDir, 'config');
    const repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'core'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'core', 'mod.py'), 'def fn():\n\treturn 1\n', 'utf8');
    fs.writeFileSync(path.join(cfgDir, 'policy.yaml'), [
      'policy:',
      '  version: "3.1.0"',
      '  project_id: "consult-test"',
      '  scope_control:',
      '    allowed_dirs: ["core/"]'
    ].join('\n'), 'utf8');

    // 2a. team.yaml with NO designer model, HAS cheap router + expensive reviewer -> decomposeGoal uses router model, NOT reviewer
    fs.writeFileSync(path.join(cfgDir, 'team.yaml'), [
      'providers:',
      '  local_9router:',
      '    base_url: "http://127.0.0.1:29999/v1"',
      '    default_key: "sk-test"',
      'roles:',
      '  router:',
      '    enabled: true',
      '    model: "custom/router-model"',
      '  writer:',
      '    enabled: true',
      '    models: ["custom/writer-model"]',
      '  designer:',
      '    enabled: true',
      '  reviewer:',
      '    enabled: true',
      '    model: "custom/reviewer-expensive"'
    ].join('\n'), 'utf8');

    const mockRouterFetch = async () => new Response(JSON.stringify({
      id: 'resp-consult',
      model: 'custom/router-model',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: JSON.stringify({
            tasks: [{
              title: 'Consult system architecture',
              goal: 'Tư vấn kiến trúc cho core/mod.py',
              kind: 'feature',
              mode: 'consult',
              role: 'designer',
              risk_level: 'low',
              scope: ['core/mod.py'],
              acceptance_criteria: ['Clear advice']
            }]
          })
        },
        finish_reason: 'stop'
      }],
      usage: { prompt_tokens: 90, completion_tokens: 40 }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

    const gpFallbackRouter = await decomposeGoal('Tư vấn kiến trúc core/mod.py', {
      configDir: cfgDir,
      repoRoot: repoDir,
      dryRun: true,
      fetchFn: mockRouterFetch
    });
    assert.equal(gpFallbackRouter.ok, true, `Expected consult with router fallback to succeed, got: ${JSON.stringify(gpFallbackRouter)}`);
    assert.equal(gpFallbackRouter.tasks[0].model, 'custom/router-model', 'Consult without designer model must use cheap router model, NEVER reviewer');
    assert.equal(gpFallbackRouter.tasks[0].model_source, 'router_fallback');

    // 2b. team.yaml with designer empty and router disabled (even though reviewer exists) -> decomposeGoal fails requiring explicit declaration
    fs.writeFileSync(path.join(cfgDir, 'team.yaml'), [
      'providers:',
      '  local_9router:',
      '    base_url: "http://127.0.0.1:29999/v1"',
      '    default_key: "sk-test"',
      'roles:',
      '  router:',
      '    enabled: false',
      '    model: "custom/router-model"',
      '  writer:',
      '    enabled: true',
      '    models: ["custom/writer-model"]',
      '  designer:',
      '    enabled: true',
      '  reviewer:',
      '    enabled: true',
      '    model: "custom/reviewer-expensive"'
    ].join('\n'), 'utf8');

    const gpNoConsultModel = await decomposeGoal('Tư vấn kiến trúc core/mod.py', {
      configDir: cfgDir,
      repoRoot: repoDir,
      dryRun: true,
      modelOverride: 'custom/router-model',
      fetchFn: mockRouterFetch
    });
    assert.equal(gpNoConsultModel.ok, false, 'Consult with neither role model nor active router model must fail cleanly (never use reviewer)');
    assert.match(String(gpNoConsultModel.error || ''), /no model|khai báo|router/i);

    // 2c. runAgent with whitespace modelOverride and unconfigured designer role never hits network
    let networkCalls = 0;
    const raEmpty = await runAgent({
      role: 'designer',
      modelOverride: '   ',
      configDir: cfgDir,
      repoRoot: repoDir,
      prompt: 'Consult architecture',
      disableTools: true,
      fetchFn: async () => {
        networkCalls++;
        throw new Error('Should never hit network with empty model');
      }
    });
    assert.equal(raEmpty.ok, false);
    assert.equal(networkCalls, 0, 'runAgent must never send network request with empty/whitespace model');
    assert.match(String(raEmpty.error || ''), /no model configured/i);

    // 2d. loadRoleConfig safely normalizes object/string models[] entries with configDir
    const loadedDesigner = loadRoleConfig('designer', {
      roles: {
        designer: { enabled: true, models: [{ id: 'custom/dead', disabled: true }, ' custom/live-designer '] }
      }
    });
    assert.equal(loadedDesigner.model, 'custom/live-designer');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // 3. orchestrator.mjs wires resolveConsultModelSelection inside task.mode === 'consult'
  const orchSrc = fs.readFileSync(path.resolve(TEAM_DIR, 'scripts', 'orchestrator.mjs'), 'utf8');
  assert.ok(
    orchSrc.includes('resolveConsultModelSelection'),
    'orchestrator.mjs must use resolveConsultModelSelection in consult track'
  );

  console.log('[PASS] test-consult-model-guard');
}

runTests().catch((err) => {
  console.error('[FAIL] test-consult-model-guard:', err);
  process.exit(1);
});
