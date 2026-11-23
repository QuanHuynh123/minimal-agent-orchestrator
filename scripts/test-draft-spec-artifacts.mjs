#!/usr/bin/env node
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as riskPolicy from './lib/risk-policy.mjs';
import * as orchestrator from './orchestrator.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');

function runTests() {
  assert.strictEqual(
    typeof riskPolicy.resolveSpecArtifactPath,
    'function',
    'risk-policy.mjs must export resolveSpecArtifactPath'
  );
  assert.strictEqual(
    typeof orchestrator.writeDraftSpecArtifact,
    'function',
    'orchestrator.mjs must export writeDraftSpecArtifact'
  );

  const task = {
    task_id: 'T-SPEC-GITIGNORE-TEST',
    title: 'Add publish privacy endpoint and modal selector',
    goal: 'Add API method and UI dropdown for publish privacy options',
    mode: 'standard',
    risk_level: 'medium',
    scope: ['ui_bridge/js_api.py', 'ui_web/index.html', 'tests/test_ui_bridge.py']
  };
  const teamCfg = {
    roles: {
      writer: { model: 'deepseek-v4.1-flash' },
      reviewer: { model: 'ag/claude-sonnet-5-5' },
      designer: { model: 'ag/claude-sonnet-5-5' }
    }
  };

  const workflow = riskPolicy.resolveWriterHubWorkflow(task, teamCfg, {});
  const specSteps = workflow.filter(s => s.action === 'draft_spec');
  assert.ok(specSteps.length >= 1, 'Expected at least 1 draft_spec step in workflow');

  for (const s of specSteps) {
    assert.ok(
      s.output_artifact.startsWith('agent-team/state/runs/'),
      `Expected spec artifact inside agent-team/state/runs/, got: ${s.output_artifact}`
    );
    assert.ok(
      !s.output_artifact.startsWith('artifacts/'),
      `Must NOT emit legacy root artifacts/ path: ${s.output_artifact}`
    );
  }

  // Test isolated git repo copy using real agent-team/.gitignore: writing draft_spec keeps git status clean
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'td-spec-clean-'));
  try {
    fs.mkdirSync(path.join(tmpRepo, 'agent-team', 'state', 'runs'), { recursive: true });
    const gitignoreSrc = fs.readFileSync(path.join(TEAM_DIR, '.gitignore'), 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'agent-team', '.gitignore'), gitignoreSrc, 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'README.md'), 'init\n', 'utf8');
    execSync('git init -q && git config user.email t@t.com && git config user.name t && git add . && git commit -q -m init', { cwd: tmpRepo });

    const written = orchestrator.writeDraftSpecArtifact(
      task.task_id,
      'reviewer',
      specSteps[0],
      '# Pre-Code Spec\nContract verified.',
      { repoRoot: tmpRepo }
    );
    assert.ok(written.relPath.startsWith('agent-team/state/runs/'), `Unexpected relPath: ${written.relPath}`);
    assert.ok(fs.existsSync(written.absPath), 'Spec file must exist on disk inside state/runs');

    // Legacy wfStep.output_artifact='artifacts/...' must also be safely redirected into state/runs
    const legacyWritten = orchestrator.writeDraftSpecArtifact(
      task.task_id,
      'designer',
      { output_artifact: `artifacts/${task.task_id}_design_spec.md` },
      '# Design Spec\nLayout verified.',
      { repoRoot: tmpRepo }
    );
    assert.ok(
      legacyWritten.relPath.startsWith('agent-team/state/runs/'),
      `Legacy artifacts/ path must redirect to agent-team/state/runs/, got: ${legacyWritten.relPath}`
    );
    assert.strictEqual(
      fs.existsSync(path.join(tmpRepo, 'artifacts')),
      false,
      'Root artifacts/ directory must NEVER be created in repo'
    );

    const gitStatus = execSync('git status --porcelain', { cwd: tmpRepo, encoding: 'utf8' }).trim();
    assert.strictEqual(gitStatus, '', `Repo git status must remain clean after draft_spec, got:\n${gitStatus}`);

    console.log('ALL DRAFT_SPEC ARTIFACT PATH TESTS PASSED (2/2)');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
}

runTests();
