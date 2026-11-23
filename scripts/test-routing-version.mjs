#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { decomposeGoal } from './goal-planner.mjs';
import * as riskPolicy from './lib/risk-policy.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ORCHESTRATOR_FILE = path.join(__dirname, 'orchestrator.mjs');

const GENERIC_TEAM = {
  spec_models: {
    low: 'mock/cheap-spec',
    medium: 'mock/cheap-spec',
    high: 'mock/strong-spec',
    critical: 'mock/strong-spec'
  },
  roles: {
    router: { enabled: true, model: 'mock/cheap-router', default_model: 'mock/cheap-router' },
    writer: { enabled: true, model: 'mock/writer-main', default_model: 'mock/writer-main', models: ['mock/writer-main'] },
    designer: { enabled: true, model: 'mock/ui-designer', default_model: 'mock/ui-designer' },
    reviewer: { enabled: true, model: 'mock/strong-reviewer', default_model: 'mock/strong-reviewer' }
  }
};

async function runTests() {
  console.log('Testing Item 3: task routing_version persistence & stale routing warning/recomputation...\n');

  assert.equal(typeof riskPolicy.CURRENT_ROUTING_VERSION, 'number', 'risk-policy.mjs must export CURRENT_ROUTING_VERSION');
  assert.ok(riskPolicy.CURRENT_ROUTING_VERSION >= 2, 'CURRENT_ROUTING_VERSION must be >= 2');
  assert.equal(typeof riskPolicy.checkAndRefreshTaskRouting, 'function', 'risk-policy.mjs must export checkAndRefreshTaskRouting');

  // 1. goal-planner saves routing_version: CURRENT_ROUTING_VERSION into generated Task YAML on disk
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-routing-ver-'));
  try {
    const cfgDir = path.join(tmpDir, 'cfg');
    const repoDir = path.join(tmpDir, 'repo');
    const outTasksDir = path.join(tmpDir, 'out_tasks');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'ui_web'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'tests'), { recursive: true });
    fs.mkdirSync(outTasksDir, { recursive: true });

    fs.writeFileSync(path.join(repoDir, 'ui_web', 'app.html'), '<div class="bar"></div>\n', 'utf8');
    fs.writeFileSync(path.join(repoDir, 'tests', 'test_dom.py'), 'def test_ok():\n\tassert True\n', 'utf8');

    fs.writeFileSync(path.join(cfgDir, 'policy.yaml'), [
      'policy:',
      '  version: "3.1.0"',
      '  project_id: "routing-version-test"',
      '  scope_control:',
      '    allowed_dirs: ["ui_web/", "tests/"]'
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(cfgDir, 'team.yaml'), YAML.stringify(GENERIC_TEAM), 'utf8');

    const planRes = await decomposeGoal('Clean up toolbar spacing in ui_web/app.html', {
      configDir: cfgDir,
      repoRoot: repoDir,
      activeTasksDir: outTasksDir,
      fetchFn: async () => new Response(JSON.stringify({
        id: 'resp-rv',
        model: 'mock/cheap-router',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify({
              tasks: [{
                title: 'Clean up toolbar CSS spacing',
                goal: 'Remove redundant padding rule in ui_web/app.html',
                kind: 'refactor',
                mode: 'quick',
                risk_level: 'low',
                scope: ['ui_web/app.html', 'tests/test_dom.py'],
                acceptance_criteria: ['Tests pass']
              }]
            })
          },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 100, completion_tokens: 50 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    });

    assert.equal(planRes.ok, true, `decomposeGoal failed: ${planRes.error}`);
    assert.equal(planRes.tasks.length, 1);
    assert.equal(planRes.tasks[0].routing_version, riskPolicy.CURRENT_ROUTING_VERSION, 'Planned task in memory must carry CURRENT_ROUTING_VERSION');

    const yamlFiles = fs.readdirSync(outTasksDir).filter(f => f.endsWith('.yaml'));
    assert.equal(yamlFiles.length, 1, 'Expected task YAML written to activeTasksDir');
    const diskDoc = YAML.parse(fs.readFileSync(path.join(outTasksDir, yamlFiles[0]), 'utf8'));
    assert.equal(
      diskDoc?.task?.routing_version,
      riskPolicy.CURRENT_ROUTING_VERSION,
      'Saved Task YAML on disk MUST include task.routing_version'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // 2. Stale task without routing_version (or routing_version: 1) triggers warning & recomputes stale workflow/mode
  const staleMissingVersion = {
    task_id: 'T-OLD-NO-VER',
    title: 'Clean up UI controls',
    goal: 'Clean up toolbar layout and spacing CSS',
    kind: 'refactor',
    kind_source: 'router',
    declared_mode: 'quick',
    mode: 'standard', // polluted by pre-fix routing!
    declared_risk_level: 'low',
    risk_level: 'low',
    scope: ['ui_web/app.html', 'tests/test_dom.py'],
    writer_hub_workflow: [
      { step: 1, role: 'designer', action: 'draft_spec', model: 'mock/ui-designer' },
      { step: 2, role: 'reviewer', action: 'draft_spec', model: 'mock/strong-reviewer' },
      { step: 3, role: 'writer', action: 'apply_patch', model: 'mock/writer-main' }
    ]
  };
  const refreshedMissing = riskPolicy.checkAndRefreshTaskRouting(staleMissingVersion, GENERIC_TEAM, {});
  assert.equal(refreshedMissing.stale, true, 'Task missing routing_version must be treated as stale');
  assert.equal(refreshedMissing.recomputed, true, 'Stale task without manual override must recompute workflow');
  assert.ok(refreshedMissing.warnings.length >= 1, 'Stale task must emit at least 1 clear warning');
  assert.match(refreshedMissing.warnings.join(' '), /routing_version/i);
  assert.equal(refreshedMissing.mode, 'quick', 'Recomputed mode must honor declared_mode=quick');
  assert.deepEqual(refreshedMissing.workflow, [], 'Recomputed workflow must collapse stale 3-step pipeline to 1-step Writer []');

  const staleOldVersion = {
    ...staleMissingVersion,
    task_id: 'T-OLD-V1',
    routing_version: 1
  };
  const refreshedV1 = riskPolicy.checkAndRefreshTaskRouting(staleOldVersion, GENERIC_TEAM, {});
  assert.equal(refreshedV1.stale, true, 'Task with routing_version=1 < CURRENT must be treated as stale');
  assert.equal(refreshedV1.recomputed, true);
  assert.ok(refreshedV1.warnings.length >= 1);
  assert.deepEqual(refreshedV1.workflow, []);

  // 3. Stale task with manual_workflow_override=true warns clearly without discarding manual workflow
  const staleManualTask = {
    ...staleOldVersion,
    task_id: 'T-OLD-MANUAL',
    manual_workflow_override: true
  };
  const refreshedManual = riskPolicy.checkAndRefreshTaskRouting(staleManualTask, GENERIC_TEAM, {});
  assert.equal(refreshedManual.stale, true);
  assert.equal(refreshedManual.recomputed, false, 'Must respect manual_workflow_override instead of overwriting workflow');
  assert.ok(refreshedManual.warnings.length >= 1, 'Still warns when manual_workflow_override task has stale routing_version');
  assert.equal(refreshedManual.workflow.length, 3);

  // 4. Current routing_version task does NOT warn or mark stale
  const currentTask = {
    ...staleMissingVersion,
    task_id: 'T-CURRENT-VER',
    mode: 'quick',
    routing_version: riskPolicy.CURRENT_ROUTING_VERSION,
    writer_hub_workflow: []
  };
  const refreshedCurrent = riskPolicy.checkAndRefreshTaskRouting(currentTask, GENERIC_TEAM, {});
  assert.equal(refreshedCurrent.stale, false);
  assert.equal(refreshedCurrent.recomputed, false);
  assert.deepEqual(refreshedCurrent.warnings, []);

  // 5. Verify orchestrator.mjs wires checkAndRefreshTaskRouting at runtime
  const orchestratorSrc = fs.readFileSync(ORCHESTRATOR_FILE, 'utf8');
  assert.match(orchestratorSrc, /\bcheckAndRefreshTaskRouting\b/, 'orchestrator.mjs must invoke checkAndRefreshTaskRouting');

  console.log('✓ All Item 3 routing_version & stale recomputation tests passed.');
}

runTests().catch(err => {
  console.error('routing_version test failed:', err);
  process.exit(1);
});
