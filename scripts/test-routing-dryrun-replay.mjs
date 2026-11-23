#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(TEAM_DIR, '..');

function makeSseCompletion(model, content) {
  return new Response(
    `data: ${JSON.stringify({ id: 'r1', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ id: 'r1', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3000, completion_tokens: 90, total_tokens: 3090 } })}\n\n` +
    `data: [DONE]\n\n`,
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
  );
}

async function runTests() {
  console.log('Testing Item 5: dryRun Routing Replay & Before/After Workflow Reporter...\n');

  const { runDryRunRoutingReplay, summarizeWorkflowSteps } = await import('./replay-routing-dryrun.mjs');
  assert.equal(typeof runDryRunRoutingReplay, 'function', 'replay-routing-dryrun must export runDryRunRoutingReplay');
  assert.equal(typeof summarizeWorkflowSteps, 'function', 'replay-routing-dryrun must export summarizeWorkflowSteps');

  // Empty workflow [] represents auto-collapsed direct 1-step Writer with 0 spec steps
  const collapsedSummary = summarizeWorkflowSteps([], 'mock/writer');
  assert.equal(collapsedSummary.spec_steps, 0);
  assert.equal(collapsedSummary.writer_steps, 1);
  assert.equal(collapsedSummary.is_single_writer_no_spec, true);

  // Generalized workspace fixture in temp dir (UI + test file only)
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'td-replay-dryrun-'));
  const tmpSess = path.join(tmpRepo, 'sessions');
  try {
    fs.mkdirSync(path.join(tmpRepo, 'ui_web'), { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, 'tests'), { recursive: true });
    fs.mkdirSync(tmpSess, { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'ui_web', 'app.html'), '<div id="legacy"></div>\n', 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'tests', 'test_view.py'), 'def test_view():\n\tassert True\n', 'utf8');

    const beforeTaskSnapshot = {
      task_id: 'T-GEN-BEFORE',
      mode: 'standard',
      kind: 'feature',
      risk_level: 'low',
      scope: ['ui_web/app.html', 'tests/test_view.py'],
      writer_hub_workflow: [
        { step: 1, role: 'reviewer', model: 'tier/reviewer-top', action: 'draft_spec' },
        { step: 2, role: 'designer', model: 'tier/designer-mid', action: 'draft_spec' },
        { step: 3, role: 'writer', model: 'tier/writer-main', action: 'apply_patch' }
      ]
    };

    const replayRes = await runDryRunRoutingReplay({
      goal: 'Loại bỏ khối cũ #legacy và chỉnh lại CSS grid trong ui_web/app.html, cập nhật tests/test_view.py',
      beforeTask: beforeTaskSnapshot,
      repoRoot: tmpRepo,
      configDir: path.join(TEAM_DIR, 'config'),
      sessionsDir: tmpSess,
      baseUrlOverride: 'http://127.0.0.1:20199/v1',
      apiKeyOverride: 'mock',
      fetchFn: async (_url, init) => {
        const payload = JSON.parse(String(init.body || '{}'));
        return makeSseCompletion(payload.model, JSON.stringify({
          tasks: [{
            title: 'Clean up legacy panel and layout CSS',
            goal: 'Remove #legacy and update layout CSS in ui_web/app.html + tests/test_view.py',
            kind: 'remove',
            mode: 'quick',
            risk_level: 'low',
            scope: ['ui_web/app.html', 'tests/test_view.py'],
            acceptance_criteria: ['Legacy element removed', 'Tests pass']
          }]
        }));
      }
    });

    assert.equal(replayRes.ok, true, replayRes.error);
    assert.equal(replayRes.before.spec_steps, 2, 'Baseline workflow before fix had 2 spec steps');
    assert.equal(replayRes.before.is_single_writer_no_spec, false);
    assert.equal(replayRes.after.mode, 'quick', 'After fix, [html + test.py] quick stays quick');
    assert.equal(replayRes.after.kind, 'remove');
    assert.equal(replayRes.after.spec_steps, 0, 'After fix, quick/low must have 0 spec steps');
    assert.equal(replayRes.after.writer_steps, 1, 'After fix, must execute with single Writer step');
    assert.equal(replayRes.after.is_single_writer_no_spec, true);
    assert.deepEqual(replayRes.after.writer_hub_workflow, [], 'Collapsed workflow must be [] (1 Writer, no spec)');

    // Also verify task YAML wrapper (`task: { ... }`) loads cleanly via taskFile option
    const wrappedYamlPath = path.join(tmpRepo, 'wrapped-task.yaml');
    fs.writeFileSync(
      wrappedYamlPath,
      [
        'task:',
        '  task_id: T-WRAPPED',
        '  goal: "Loại bỏ khối cũ #legacy trong ui_web/app.html"',
        '  mode: standard',
        '  risk_level: low',
        '  scope:',
        '    - ui_web/app.html',
        '    - tests/test_view.py',
        '  writer_hub_workflow:',
        '    - step: 1',
        '      role: reviewer',
        '      model: tier/reviewer-top',
        '      action: draft_spec'
      ].join('\n'),
      'utf8'
    );
    const wrappedRes = await runDryRunRoutingReplay({
      taskFile: wrappedYamlPath,
      repoRoot: tmpRepo,
      configDir: path.join(TEAM_DIR, 'config'),
      sessionsDir: tmpSess,
      baseUrlOverride: 'http://127.0.0.1:20199/v1',
      apiKeyOverride: 'mock',
      fetchFn: async (_u, init) => {
        const p = JSON.parse(String(init.body || '{}'));
        return makeSseCompletion(p.model, JSON.stringify({
          tasks: [{
            title: 'Remove #legacy',
            goal: 'Remove #legacy in ui_web/app.html and tests/test_view.py',
            kind: 'remove',
            mode: 'quick',
            risk_level: 'low',
            scope: ['ui_web/app.html', 'tests/test_view.py'],
            acceptance_criteria: ['Done']
          }]
        }));
      }
    });
    assert.equal(wrappedRes.ok, true, wrappedRes.error);
    assert.equal(wrappedRes.before.spec_steps, 1);
    assert.equal(wrappedRes.after.is_single_writer_no_spec, true);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }

  console.log('✓ All Item 5 dryRun routing replay & before/after workflow tests passed.');
}

runTests().catch(err => {
  console.error('Item 5 test failed:', err);
  process.exit(1);
});
