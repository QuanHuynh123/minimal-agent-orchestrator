#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as sessionStore from '../runtime/session-store.mjs';
import { runAgent } from '../runtime/index.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');

async function runTests() {
  console.log('Testing Item 3: Per-run session isolation (run_id in sessionId), non-destructive archival to state/runs/<task>/<run>/, and Router/Designer audit...\n');

  assert.equal(typeof sessionStore.createTaskRunId, 'function', 'session-store must export createTaskRunId');
  assert.equal(typeof sessionStore.buildTaskStepSessionId, 'function', 'session-store must export buildTaskStepSessionId');
  assert.equal(typeof sessionStore.archivePriorTaskSessions, 'function', 'session-store must export archivePriorTaskSessions');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-sess-iso-'));
  try {
    const repoDir = path.join(tmpDir, 'repo');
    const cfgDir = path.join(tmpDir, 'cfg');
    const stateDir = path.join(tmpDir, 'state');
    const sessionsDir = path.join(stateDir, 'sessions');
    const runsDir = path.join(stateDir, 'runs');
    fs.mkdirSync(path.join(repoDir, 'web'), { recursive: true });
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(runsDir, { recursive: true });

    fs.writeFileSync(path.join(cfgDir, 'policy.yaml'), [
      'policy:',
      '  version: "3.1.0"',
      '  project_id: "sess-iso-test"',
      '  scope_control:',
      '    allowed_dirs: ["web/"]'
    ].join('\n'), 'utf8');

    fs.writeFileSync(path.join(cfgDir, 'team.yaml'), [
      'providers:',
      '  local_9router:',
      '    base_url: "http://127.0.0.1:29999/v1"',
      '    default_key: "sk-test"',
      'roles:',
      '  writer:',
      '    enabled: true',
      '    model: "mock/writer-main"',
      '    allowed_tools: ["read_file"]',
      '  designer:',
      '    enabled: true',
      '    model: "mock/designer-main"',
      '    allowed_tools: ["read_file"]'
    ].join('\n'), 'utf8');

    const taskId = 'T-SESS-RETRY-1';
    const run1 = sessionStore.createTaskRunId();
    const run2 = sessionStore.createTaskRunId();
    assert.notEqual(run1, run2, 'Two run IDs must be distinct');

    const writerSess1 = sessionStore.buildTaskStepSessionId({ taskId, runId: run1, role: 'writer', bucketIndex: 1, attempt: 1 });
    const writerSess2 = sessionStore.buildTaskStepSessionId({ taskId, runId: run2, role: 'writer', bucketIndex: 1, attempt: 1 });
    const designerSess1 = sessionStore.buildTaskStepSessionId({ taskId, runId: run1, role: 'designer', step: 1, attempt: 1 });
    const designerSess2 = sessionStore.buildTaskStepSessionId({ taskId, runId: run2, role: 'designer', step: 1, attempt: 1 });

    assert.ok(writerSess1.includes(run1) && writerSess2.includes(run2) && writerSess1 !== writerSess2, 'Writer sessionId must embed run_id');
    assert.ok(designerSess1.includes(run1) && designerSess2.includes(run2) && designerSess1 !== designerSess2, 'Designer sessionId must embed run_id');

    // Seed a legacy pre-run_id session for the same task
    const legacyPath = path.join(sessionsDir, `${taskId}-writer-b1-att1.json`);
    fs.writeFileSync(legacyPath, JSON.stringify({
      session_id: `${taskId}-writer-b1-att1`,
      role: 'writer',
      messages: [{ role: 'assistant', content: 'LEGACY_STALE_HISTORY' }],
      timestamps: { created_at: '2026-11-18T07:01:02.000Z', updated_at: '2026-11-18T07:01:02.000Z' }
    }), 'utf8');

    // Run 1 execution saves its session under sessionsDir
    const run1Fetch = async () => new Response(JSON.stringify({
      id: 'r1',
      model: 'mock/writer-main',
      choices: [{ index: 0, message: { role: 'assistant', content: 'RUN1_SECRET_HISTORY_REPLY' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

    const res1 = await runAgent({
      role: 'writer',
      prompt: 'Run 1 prompt: RUN1_PRIOR_PROMPT_MARKER',
      sessionId: writerSess1,
      scope: ['web/index.html'],
      configDir: cfgDir,
      repoRoot: repoDir,
      sessionsDir,
      maxTurns: 2,
      fetchFn: run1Fetch
    });
    assert.equal(res1.ok, true);
    assert.ok(fs.existsSync(path.join(sessionsDir, `${writerSess1}.json`)), 'Run 1 session must be written in sessionsDir');

    // Retry (Run 2): archive previous sessions into state/runs/<task>/<run>/ WITHOUT deleting them
    const archRes = sessionStore.archivePriorTaskSessions({
      taskId,
      currentRunId: run2,
      sessionsDir,
      runsDir
    });
    assert.ok(archRes.count >= 2, `Expected both legacy and run1 sessions to archive, archived ${archRes.count}`);
    assert.equal(fs.existsSync(legacyPath), false, 'Archived legacy session moved out of active sessionsDir');
    assert.equal(fs.existsSync(path.join(sessionsDir, `${writerSess1}.json`)), false, 'Archived run1 session moved out of active sessionsDir');

    // Confirm Run 1 session file STILL EXISTS safely under state/runs/<task>/<run1>/
    const archivedRun1Path = path.join(runsDir, taskId, run1, `${writerSess1}.json`);
    assert.equal(fs.existsSync(archivedRun1Path), true, `Old run session MUST be archived (NOT deleted) at ${archivedRun1Path}`);
    const archivedRun1Data = JSON.parse(fs.readFileSync(archivedRun1Path, 'utf8'));
    assert.ok(JSON.stringify(archivedRun1Data.messages).includes('RUN1_SECRET_HISTORY_REPLY'), 'Archived session must preserve full message history');

    // Run 2 executes on fresh sessionId -> MUST NOT load Run 1 or legacy history
    const run2CapturedRequests = [];
    const run2Fetch = async (_url, init) => {
      run2CapturedRequests.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({
        id: 'r2',
        model: 'mock/writer-main',
        choices: [{ index: 0, message: { role: 'assistant', content: 'RUN2_CLEAN_REPLY' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 90, completion_tokens: 15, total_tokens: 105 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const res2 = await runAgent({
      role: 'writer',
      prompt: 'Run 2 fresh prompt',
      sessionId: writerSess2,
      scope: ['web/index.html'],
      configDir: cfgDir,
      repoRoot: repoDir,
      sessionsDir,
      maxTurns: 2,
      fetchFn: run2Fetch
    });
    assert.equal(res2.ok, true);
    assert.equal(run2CapturedRequests.length, 1);
    const serializedMsgs = JSON.stringify(run2CapturedRequests[0].messages);
    assert.equal(serializedMsgs.includes('RUN1_PRIOR_PROMPT_MARKER'), false, 'Run 2 retry MUST NOT load Run 1 user prompt');
    assert.equal(serializedMsgs.includes('RUN1_SECRET_HISTORY_REPLY'), false, 'Run 2 retry MUST NOT load Run 1 assistant reply');
    assert.equal(serializedMsgs.includes('LEGACY_STALE_HISTORY'), false, 'Run 2 retry MUST NOT load legacy session history');

    // Also test Designer retry isolation across runs
    await runAgent({
      role: 'designer',
      prompt: 'Designer Run 1 secret marker DESIGNER_RUN1_LEAK',
      sessionId: designerSess1,
      scope: ['web/index.html'],
      configDir: cfgDir,
      repoRoot: repoDir,
      sessionsDir,
      maxTurns: 1,
      fetchFn: run1Fetch
    });
    const designerReq2 = [];
    await runAgent({
      role: 'designer',
      prompt: 'Designer Run 2 clean prompt',
      sessionId: designerSess2,
      scope: ['web/index.html'],
      configDir: cfgDir,
      repoRoot: repoDir,
      sessionsDir,
      maxTurns: 1,
      fetchFn: async (_u, init) => {
        designerReq2.push(JSON.parse(String(init.body)));
        return run2Fetch(_u, init);
      }
    });
    assert.equal(
      JSON.stringify(designerReq2[0].messages).includes('DESIGNER_RUN1_LEAK'),
      false,
      'Designer step on Run 2 MUST NOT load Designer Run 1 session history'
    );

    // Contract check: orchestrator.mjs uses run_id + buildTaskStepSessionId + archivePriorTaskSessions;
    // goal-planner.mjs (Router) uses dynamic per-run sessionSafeId (never fixed per task)
    const orchSrc = fs.readFileSync(path.join(TEAM_DIR, 'scripts', 'orchestrator.mjs'), 'utf8');
    assert.match(orchSrc, /createTaskRunId/, 'orchestrator.mjs must create unique run_id per task execution');
    assert.match(orchSrc, /buildTaskStepSessionId/, 'orchestrator.mjs must embed run_id in Consult/Designer/Writer sessionId');
    assert.match(orchSrc, /archivePriorTaskSessions/, 'orchestrator.mjs must archive old sessions into state/runs/<task>/<run>/');
    const plannerSrc = fs.readFileSync(path.join(TEAM_DIR, 'scripts', 'goal-planner.mjs'), 'utf8');
    assert.match(plannerSrc, /const sessionSafeId = `planner-\$\{Date\.now\(\)/, 'goal-planner.mjs (Router) must keep dynamic timestamp+random sessionId');

    console.log('[PASS] test-session-run-isolation');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

runTests().catch(err => {
  console.error('[FAIL] test-session-run-isolation:', err);
  process.exit(1);
});
