#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import YAML from 'yaml';
import { loadMergedTeamConfig } from './lib/policy-loader.mjs';
import * as riskPolicy from './lib/risk-policy.mjs';
import { handleModelsRoutes } from './server/routes-models.mjs';
import { DASHBOARD_CSRF_TOKEN } from './server/security.mjs';

console.log('Testing Item 4: Writer routing (team.routing.yaml / team.yaml), priority order, and /api/save-team-config round-trip...\n');

assert.equal(typeof riskPolicy.resolveRoutingRuleModel, 'function', 'risk-policy.mjs must export resolveRoutingRuleModel');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-routing-'));
try {
  const cfgDir = path.join(tmpDir, 'config');
  fs.mkdirSync(cfgDir, { recursive: true });

  const teamFile = path.join(cfgDir, 'team.yaml');
  const routingFile = path.join(cfgDir, 'team.routing.yaml');

  fs.writeFileSync(teamFile, [
    'providers:',
    '  local_9router:',
    '    type: openai_compatible',
    '    base_url: "http://127.0.0.1:20128/v1"',
    '    default_key: "sk-test"',
    'custom_team_meta:',
    '  owner: "qa-team"',
    '  preserve_flag: true',
    'spec_models:',
    '  low: "ag/gemini-3.8-flash-medium"',
    '  medium: "ag/gemini-3.8-flash-medium"',
    '  high: "ag/claude-opus-5-5-medium"',
    '  critical: "ag/claude-opus-5-5-medium"',
    'routing:',
    '  rules:',
    '    - name: "team-yaml-high-risk"',
    '      risk_level: "high"',
    '      model: "ag/claude-opus-5-5-medium"',
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
    '    default_model: "deepseek-ai/deepseek-v4.1-flash-1017"',
    '    models:',
    '      - "deepseek-ai/deepseek-v4.1-flash-1017"',
    '      - "ag/gemini-3.8-flash-medium"',
    '    custom_role_note: "keep-writer-note"',
    '  designer:',
    '    enabled: true',
    '    model: "ag/claude-sonnet-5-5"',
    '  reviewer:',
    '    enabled: true',
    '    model: "ag/claude-opus-5-5-medium"'
  ].join('\n'), 'utf8');

  fs.writeFileSync(routingFile, [
    'routing:',
    '  rules:',
    '    - name: "frontend-ui-rule"',
    '      domain: "frontend"',
    '      model: "ag/claude-sonnet-5-5"'
  ].join('\n'), 'utf8');

  // 1. loadMergedTeamConfig merges team.routing.yaml
  const merged = loadMergedTeamConfig({ configDir: cfgDir });
  assert.ok(merged.routing, 'loadMergedTeamConfig must include routing');
  assert.ok(
    Array.isArray(merged.routing.rules) && merged.routing.rules.some(r => r.name === 'frontend-ui-rule'),
    'Merged team config must load rules from team.routing.yaml'
  );

  // 2. Priority check: writer_model > routing > models[0] > fallback
  const feTask = { task_id: 'T-RT-1', mode: 'standard', risk_level: 'low', scope: ['ui_web/index.html'] };
  const beTask = { task_id: 'T-RT-2', mode: 'quick', risk_level: 'low', scope: ['core/app.py'] };

  // 2a. Routing match beats models[0]
  const selRouted = riskPolicy.resolveWriterSelection(feTask, merged);
  assert.equal(selRouted.ok, true);
  assert.equal(selRouted.selected_by, 'routing_rule');
  assert.equal(selRouted.requested_model, 'ag/claude-sonnet-5-5');
  assert.equal(selRouted.actual_model, 'ag/claude-sonnet-5-5');
  assert.match(selRouted.reason, /frontend-ui-rule/);

  // 2b. Task writer_model beats routing
  const selOverride = riskPolicy.resolveWriterSelection(
    { ...feTask, writer_model: 'ag/gemini-3.8-flash-medium' },
    merged
  );
  assert.equal(selOverride.ok, true);
  assert.equal(selOverride.selected_by, 'task_override');
  assert.equal(selOverride.actual_model, 'ag/gemini-3.8-flash-medium');

  // 2c. Non-matching task uses models[0]
  const selPrimary = riskPolicy.resolveWriterSelection(beTask, merged);
  assert.equal(selPrimary.ok, true);
  assert.equal(selPrimary.selected_by, 'primary');
  assert.equal(selPrimary.actual_model, 'deepseek-ai/deepseek-v4.1-flash-1017');

  // 2d. Routed model fails preflight -> falls back to models[0] > models[1..]
  const selRoutedFallback = riskPolicy.resolveWriterSelection(feTask, merged, {
    preflightFailedModels: new Set(['ag/claude-sonnet-5-5'])
  });
  assert.equal(selRoutedFallback.ok, true);
  assert.equal(selRoutedFallback.selected_by, 'fallback');
  assert.equal(selRoutedFallback.requested_model, 'ag/claude-sonnet-5-5');
  assert.equal(selRoutedFallback.actual_model, 'deepseek-ai/deepseek-v4.1-flash-1017');

  // 3. Two-way round-trip test via POST /api/save-team-config:
  // Unknown keys + routing in team.yaml must survive saving via backend route!
  const payload = {
    roles: {
      router: { model: 'ag/gemini-3.8-flash-medium', models: ['ag/gemini-3.8-flash-medium'], display_name: 'Gemini Router' },
      writer: {
        model: 'deepseek-ai/deepseek-v4.1-flash-1017',
        models: ['deepseek-ai/deepseek-v4.1-flash-1017', 'ag/gemini-3.8-flash-medium'],
        display_name: 'Writer Squad'
      },
      designer: { model: 'ag/claude-sonnet-5-5', models: ['ag/claude-sonnet-5-5'], display_name: 'Designer' },
      reviewer: { model: 'ag/claude-opus-5-5-medium', models: ['ag/claude-opus-5-5-medium'], display_name: 'Reviewer' }
    },
    provider: { base_url: 'http://127.0.0.1:20128/v1', default_key: 'sk-updated' }
  };
  const req = Readable.from([Buffer.from(JSON.stringify(payload), 'utf8')]);
  req.method = 'POST';
  req.headers = {
    'content-type': 'application/json',
    'x-dashboard-token': DASHBOARD_CSRF_TOKEN
  };
  let statusCode = 0;
  let respBody = '';
  const res = {
    writeHead(code) { statusCode = code; },
    end(chunk) { respBody += String(chunk || ''); }
  };
  await handleModelsRoutes(req, res, new URL('http://127.0.0.1/api/save-team-config'), { TEAM_CONFIG_FILE: teamFile });
  assert.equal(statusCode, 200, `Expected 200 from save-team-config, got ${statusCode}: ${respBody}`);

  const savedYaml = YAML.parse(fs.readFileSync(teamFile, 'utf8'));
  assert.deepEqual(savedYaml.custom_team_meta, { owner: 'qa-team', preserve_flag: true }, 'Top-level unknown keys in team.yaml must survive save');
  assert.deepEqual(savedYaml.spec_models, {
    low: 'ag/gemini-3.8-flash-medium',
    medium: 'ag/gemini-3.8-flash-medium',
    high: 'ag/claude-opus-5-5-medium',
    critical: 'ag/claude-opus-5-5-medium'
  }, 'Top-level spec_models in team.yaml must survive /api/save-team-config');
  assert.ok(savedYaml.routing?.rules?.length === 1 && savedYaml.routing.rules[0].name === 'team-yaml-high-risk', 'Top-level routing in team.yaml must survive save');
  assert.equal(savedYaml.roles.writer.custom_role_note, 'keep-writer-note', 'Role-level unknown keys in team.yaml must survive save');
  assert.ok(Array.isArray(savedYaml.roles.router.disabled_models) && savedYaml.roles.router.disabled_models.length === 1, 'disabled_models must survive save');
  assert.equal(savedYaml.providers.local_9router.default_key, 'sk-updated');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('✓ Item 4 tests PASSED!');
