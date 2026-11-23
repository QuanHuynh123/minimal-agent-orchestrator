#!/usr/bin/env node
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveSquadRoster,
  resolveWriterHubWorkflow,
  splitPatchStepsByOutputBudget
} from './lib/risk-policy.mjs';

console.log('Testing Item 1: models[0] primary writer, models[1..] fallback only, optional frontend_writer override...\n');

// 1. writer.models with UI-sounding secondary model must NOT hijack frontendWriterModel
const teamWithFallback = {
  roles: {
    writer: {
      enabled: true,
      model: 'deepseek-v4.1',
      default_model: 'deepseek-v4.1',
      models: ['deepseek-v4.1', 'ag/gemini-3.8-flash-medium', 'ag/claude-sonnet-5-5']
    },
    designer: { enabled: true, model: 'ag/claude-sonnet-5-5' },
    reviewer: { enabled: true, model: 'ag/claude-opus-5-5-medium' }
  }
};

const mixedTask = {
  task_id: 'T-WS-1',
  title: 'Add endpoint and new button modal',
  goal: 'Add new backend API and design new UI button layout',
  kind: 'feature',
  mode: 'standard',
  risk_level: 'high',
  scope: ['core/api.py', 'ui_web/index.html']
};

const roster1 = resolveSquadRoster(teamWithFallback, mixedTask);
assert.strictEqual(roster1.backendWriterModel, 'deepseek-v4.1');
assert.strictEqual(
  roster1.frontendWriterModel,
  'deepseek-v4.1',
  'frontendWriterModel must stay models[0] (default_model) even when models[1..] has gemini/claude/sonnet names'
);
assert.strictEqual(roster1.frontendWriterRole, 'writer');

const wf1 = resolveWriterHubWorkflow(mixedTask, teamWithFallback);
const patchSteps1 = wf1.filter(s => s.action === 'apply_patch');
assert.strictEqual(patchSteps1.length, 1, 'Without roles.frontend_writer, mixed task keeps single merged apply_patch bucket');
assert.strictEqual(patchSteps1[0].model, 'deepseek-v4.1', 'Merged apply_patch bucket must use models[0]');

// 2. Pure frontend task without roles.frontend_writer also uses models[0]
const feTask = {
  task_id: 'T-WS-2',
  title: 'Create new button panel UI',
  goal: 'Design new button spacing and layout in UI',
  kind: 'feature',
  mode: 'standard',
  attachments: ['mockup.png'],
  scope: ['ui_web/index.html']
};
const wfFe = resolveWriterHubWorkflow(feTask, teamWithFallback);
const fePatches = wfFe.filter(s => s.action === 'apply_patch');
assert.strictEqual(fePatches.length, 1);
assert.strictEqual(fePatches[0].model, 'deepseek-v4.1', 'Pure frontend task must use models[0], not models[1]');

// 3. roles.frontend_writer optional override still splits BE -> FE with AST bridge
const teamWithFrontendOverride = {
  roles: {
    writer: {
      enabled: true,
      model: 'deepseek-v4.1',
      models: ['deepseek-v4.1', 'ag/gemini-3.8-flash-medium']
    },
    frontend_writer: {
      enabled: true,
      model: 'ag/claude-sonnet-5-5'
    },
    reviewer: { enabled: true, model: 'ag/claude-opus-5-5-medium' }
  }
};
const rosterOverride = resolveSquadRoster(teamWithFrontendOverride, mixedTask);
assert.strictEqual(rosterOverride.backendWriterModel, 'deepseek-v4.1');
assert.strictEqual(rosterOverride.frontendWriterModel, 'ag/claude-sonnet-5-5');
assert.strictEqual(rosterOverride.frontendWriterRole, 'frontend_writer');

const wfOverride = resolveWriterHubWorkflow(mixedTask, teamWithFrontendOverride);
const overridePatches = wfOverride.filter(s => s.action === 'apply_patch');
assert.strictEqual(overridePatches.length, 2, 'Explicit roles.frontend_writer splits BE -> FE buckets');
assert.strictEqual(overridePatches[0].domain, 'backend');
assert.strictEqual(overridePatches[0].model, 'deepseek-v4.1');
assert.strictEqual(overridePatches[1].domain, 'frontend');
assert.strictEqual(overridePatches[1].model, 'ag/claude-sonnet-5-5');
assert.deepStrictEqual(overridePatches[1].inject_updated_repo_map_from, ['core/api.py']);

// 4. splitPatchStepsByOutputBudget keeps models[0] across every split bucket
const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'td-ws-split-'));
try {
  fs.mkdirSync(path.join(tmpRepo, 'core'), { recursive: true });
  fs.mkdirSync(path.join(tmpRepo, 'ui_web'), { recursive: true });
  fs.writeFileSync(path.join(tmpRepo, 'core', 'api.py'), 'x'.repeat(40 * 1024), 'utf8');
  fs.writeFileSync(path.join(tmpRepo, 'ui_web', 'index.html'), 'y'.repeat(40 * 1024), 'utf8');
  const split = splitPatchStepsByOutputBudget(patchSteps1, tmpRepo, 55 * 1024);
  assert.ok(split.length >= 2, 'Output-budget bucket splitting must still split large files');
  assert.deepStrictEqual(split[1].inject_updated_repo_map_from, ['core/api.py'], 'Bucket splitting must keep AST bridge handoff');
  for (const b of split) {
    assert.strictEqual(b.model, 'deepseek-v4.1', 'Every output-budget bucket must use primary writer model');
  }
} finally {
  fs.rmSync(tmpRepo, { recursive: true, force: true });
}

console.log('✓ Item 1 tests PASSED!');
