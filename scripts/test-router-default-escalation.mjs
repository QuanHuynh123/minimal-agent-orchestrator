#!/usr/bin/env node
/**
 * TDD Suite for Batch 170 Item 5:
 *  - team.yaml sets roles.router default model to ag/gemini-3.8-flash-medium
 *  - roles.reviewer remains ag/claude-opus-5-5-medium (unchanged)
 *  - decomposeGoal stays on Gemini when Attempt 1 passes (1 call)
 *  - If Gemini Attempt 1 fails plan validity, retries Attempt 2 on Gemini (NO Claude call if Attempt 2 passes)
 *  - Escalates to Claude ONLY after 2 consecutive invalid Gemini plans
 *  - Never retries/escalates on BudgetExceededError
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BudgetExceededError } from '../runtime/provider-gateway.mjs';
import { decomposeGoal } from './goal-planner.mjs';
import { loadMergedTeamConfig, resolveConfigDir } from './lib/policy-loader.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AGENT_TEAM_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(AGENT_TEAM_ROOT, '..');

function makeSseCompletion(model, content, usage = {}) {
  const promptTok = Number(usage.prompt_tokens ?? 3200);
  const compTok = Number(usage.completion_tokens ?? 120);
  const c1 = {
    id: 'cmpl-b170-i5',
    object: 'chat.completion.chunk',
    model,
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }]
  };
  const c2 = {
    id: 'cmpl-b170-i5',
    object: 'chat.completion.chunk',
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: promptTok,
      completion_tokens: compTok,
      total_tokens: promptTok + compTok,
      ...usage
    }
  };
  return new Response(
    `data: ${JSON.stringify(c1)}\n\ndata: ${JSON.stringify(c2)}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  );
}

const VALID_PLAN_JSON = JSON.stringify({
  tasks: [{
    title: 'Fix eraser mode pills in ui_web/index.html',
    goal: 'Update applyEraserMode in ui_web/index.html and verify tests/test_dom_contract.py',
    kind: 'bugfix',
    mode: 'standard',
    risk_level: 'low',
    scope: ['ui_web/index.html', 'tests/test_dom_contract.py'],
    acceptance_criteria: ['Fix applyEraserMode overflow', 'Pass DOM contract']
  }]
});

async function main() {
  // 1) Verify team.yaml config defaults & untouched reviewer
  const teamCfg = loadMergedTeamConfig({ configDir: resolveConfigDir() });
  assert.equal(teamCfg.roles?.router?.model, 'ag/gemini-3.8-flash-medium');
  assert.equal(teamCfg.roles?.router?.default_model, 'ag/gemini-3.8-flash-medium');
  assert.equal(teamCfg.roles?.router?.escalation_model, 'ag/claude-sonnet-5-5');
  assert.equal(teamCfg.roles?.router?.fallback_model, null);
  assert.equal(
    teamCfg.roles?.reviewer?.model,
    'ag/claude-opus-5-5-medium',
    'Reviewer model must NOT be changed'
  );

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'td-router-esc-'));
  const tmpRepo = path.join(tmpRoot, 'repo');
  fs.mkdirSync(path.join(tmpRepo, 'ui_web'), { recursive: true });
  fs.writeFileSync(path.join(tmpRepo, 'ui_web', 'index.html'), '<div id="eraser-mode-pills"></div>\n<script>function applyEraserMode() {}</script>\n', 'utf8');
  try {
    // 2) Valid plan on Attempt 1 -> 1 Gemini call, 0 Claude calls
    const models1 = [];
    const res1 = await decomposeGoal(
      'Fix applyEraserMode overflow in ui_web/index.html',
      {
        dryRun: true,
        oneTurnMode: true,
        repoRoot: tmpRepo,
        sessionsDir: path.join(tmpRoot, 's1'),
        baseUrlOverride: 'http://127.0.0.1:20199/v1',
        apiKeyOverride: 'mock',
        fetchFn: async (_url, init = {}) => {
          const p = JSON.parse(String(init.body || '{}'));
          models1.push(p.model);
          return makeSseCompletion(p.model, VALID_PLAN_JSON);
        }
      }
    );
    assert.equal(res1.ok, true);
    assert.deepStrictEqual(models1, ['ag/gemini-3.8-flash-medium']);
    assert.equal(res1.gemini_attempts, 1);
    assert.equal(res1.escalated_to_claude, false);

    // 3) Attempt 1 invalid (empty scope), Attempt 2 valid -> MUST stay on Gemini (NO Claude escalation)
    const models2 = [];
    let call2 = 0;
    const res2 = await decomposeGoal(
      'Fix applyEraserMode overflow in ui_web/index.html',
      {
        dryRun: true,
        oneTurnMode: true,
        repoRoot: tmpRepo,
        sessionsDir: path.join(tmpRoot, 's2'),
        baseUrlOverride: 'http://127.0.0.1:20199/v1',
        apiKeyOverride: 'mock',
        fetchFn: async (_url, init = {}) => {
          const p = JSON.parse(String(init.body || '{}'));
          models2.push(p.model);
          call2++;
          if (call2 === 1) {
            return makeSseCompletion(p.model, JSON.stringify({
              tasks: [{
                title: 'Bad empty scope plan',
                goal: 'Missing scope field',
                mode: 'quick',
                risk_level: 'low',
                scope: []
              }]
            }));
          }
          return makeSseCompletion(p.model, VALID_PLAN_JSON);
        }
      }
    );
    assert.equal(res2.ok, true);
    assert.deepStrictEqual(
      models2,
      ['ag/gemini-3.8-flash-medium', 'ag/gemini-3.8-flash-medium'],
      '1st invalid plan must retry once on Gemini BEFORE considering Claude escalation'
    );
    assert.equal(res2.gemini_attempts, 2);
    assert.equal(res2.escalated_to_claude, false);

    // 4) 2 consecutive invalid Gemini plans (e.g. non-existent hallucinated file + broken JSON) -> escalate ONCE to Claude
    const models3 = [];
    let call3 = 0;
    const res3 = await decomposeGoal(
      'Fix applyEraserMode overflow in ui_web/index.html',
      {
        dryRun: true,
        oneTurnMode: true,
        repoRoot: tmpRepo,
        sessionsDir: path.join(tmpRoot, 's3'),
        baseUrlOverride: 'http://127.0.0.1:20199/v1',
        apiKeyOverride: 'mock',
        fetchFn: async (_url, init = {}) => {
          const p = JSON.parse(String(init.body || '{}'));
          models3.push(p.model);
          call3++;
          if (call3 === 1) {
            return makeSseCompletion(p.model, JSON.stringify({
              tasks: [{
                title: 'Hallucinated nonexistent file',
                goal: 'Modify ui_web/nonexistent_fake_file_xyz.html',
                mode: 'quick',
                risk_level: 'low',
                scope: ['ui_web/nonexistent_fake_file_xyz.html']
              }]
            }));
          }
          if (call3 === 2) {
            return makeSseCompletion(p.model, 'Not valid JSON at all!');
          }
          return makeSseCompletion(p.model, VALID_PLAN_JSON);
        }
      }
    );
    assert.equal(res3.ok, true);
    assert.deepStrictEqual(
      models3,
      ['ag/gemini-3.8-flash-medium', 'ag/gemini-3.8-flash-medium', 'ag/claude-sonnet-5-5'],
      'Must escalate to Claude ONLY after 2 consecutive invalid Gemini plans'
    );
    assert.equal(res3.gemini_attempts, 2);
    assert.equal(res3.escalated_to_claude, true);
    assert.equal(res3.escalation_reason, 'gemini_invalid_plan_twice');

    // 5) BudgetExceededError must stop immediately without retry or Claude escalation
    let calls4 = 0;
    const res4 = await decomposeGoal(
      'Fix applyEraserMode overflow in ui_web/index.html',
      {
        dryRun: true,
        oneTurnMode: true,
        repoRoot: tmpRepo,
        sessionsDir: path.join(tmpRoot, 's4'),
        baseUrlOverride: 'http://127.0.0.1:20199/v1',
        apiKeyOverride: 'mock',
        fetchFn: async () => {
          calls4++;
          throw new BudgetExceededError('local budget stop: simulated cap');
        }
      }
    );
    assert.equal(res4.ok, false);
    assert.equal(res4.budget_exceeded, true);
    assert.equal(calls4, 1);

    console.log('ALL ROUTER DEFAULT & 2-STRIKE ESCALATION TESTS PASSED (5/5)');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error('[FAIL]', err);
  process.exit(1);
});
