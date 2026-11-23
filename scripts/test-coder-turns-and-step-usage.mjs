#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as riskPolicy from './lib/risk-policy.mjs';
import { reconcileTaskTokens, recordTaskStep, transitionTaskState } from './lib/task-persistence.mjs';
import { writeMorningReportFile } from './lib/queue-state.mjs';
import { runAgent } from '../runtime/index.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');

console.log('Testing Item 5: Moderate coderMaxTurns (max 5 on smart window even in quick mode), turns_used & per-turn token telemetry...\n');

assert.equal(typeof riskPolicy.resolveCoderMaxTurns, 'function', 'risk-policy.mjs must export resolveCoderMaxTurns');

// 1. Matrix checks for resolveCoderMaxTurns (must NEVER exceed 5)
assert.equal(riskPolicy.resolveCoderMaxTurns({ hasSpecsDossier: true, mode: 'quick', windowMode: 'smart' }), 2);
assert.equal(riskPolicy.resolveCoderMaxTurns({ hasSpecsDossier: true, mode: 'standard', windowMode: 'full' }), 2);
assert.equal(riskPolicy.resolveCoderMaxTurns({ hasSpecsDossier: false, mode: 'quick', windowMode: 'full', hasOmittedLines: false }), 3);
assert.equal(
  riskPolicy.resolveCoderMaxTurns({ hasSpecsDossier: false, mode: 'quick', windowMode: 'smart', hasOmittedLines: true }),
  5,
  'quick mode with smart window / OMITTED LINES must grant max 5 turns (capped well below 8-10)'
);
assert.equal(
  riskPolicy.resolveCoderMaxTurns({ hasSpecsDossier: false, mode: 'quick', windowMode: 'full', hasOmittedLines: true }),
  5,
  'hasOmittedLines=true alone must also grant 5 turns'
);
assert.equal(riskPolicy.resolveCoderMaxTurns({ hasSpecsDossier: false, mode: 'standard', windowMode: 'full' }), 5);
assert.ok(
  riskPolicy.resolveCoderMaxTurns({ hasSpecsDossier: false, mode: 'standard', windowMode: 'smart', hasOmittedLines: true }) <= 5,
  'coderMaxTurns must NEVER inflate to 8-10'
);

// 2. Verify recordTaskStep stores turns_used and normalized turn_tokens[] breakdown
const mockTask = { task_id: 'T-GEN-TURN-USAGE', steps: [] };
const stepEntry = recordTaskStep(mockTask, {
  step: '2.1',
  attempt: 1,
  role: 'writer',
  action: 'apply_patch',
  tool_turns: 4,
  turns_used: 4,
  turn_usages: [
    { turn: 1, stage: 'tool_loop', prompt_tokens: 11000, prompt_tokens_adjusted: 9000, fresh_tokens: 9000, cached_tokens: 0, completion_tokens: 100, total_tokens: 9100 },
    { turn: 2, stage: 'tool_loop', prompt_tokens: 13000, prompt_tokens_adjusted: 11000, fresh_tokens: 3000, cached_tokens: 8000, completion_tokens: 80, total_tokens: 11080 },
    { turn: 3, stage: 'tool_loop', prompt_tokens: 13500, prompt_tokens_adjusted: 11500, fresh_tokens: 1500, cached_tokens: 10000, completion_tokens: 60, total_tokens: 11560 },
    { turn: 4, stage: 'synthesis', prompt_tokens: 15000, prompt_tokens_adjusted: 13000, fresh_tokens: 2000, cached_tokens: 11000, completion_tokens: 1200, total_tokens: 14200 }
  ]
}, { skipJsonl: true });

assert.equal(stepEntry.turns_used, 4, 'steps[] must persist turns_used');
assert.ok(Array.isArray(stepEntry.turn_tokens) && stepEntry.turn_tokens.length === 4, 'steps[] must persist per-turn token usage array turn_tokens[]');
assert.equal(stepEntry.turn_tokens[0].turn, 1);
assert.equal(stepEntry.turn_tokens[0].prompt_tokens_adjusted, 9000);
assert.equal(stepEntry.turn_tokens[3].stage, 'synthesis');
assert.equal(stepEntry.turn_tokens[3].completion_tokens, 1200);

// 3. Verify orchestrator.mjs wires resolveCoderMaxTurns + turns_used + turn_tokens & app.js no longer advertises "Tối đa 12 lượt" for writer
const orchSrc = fs.readFileSync(path.join(TEAM_DIR, 'scripts', 'orchestrator.mjs'), 'utf8');
assert.match(orchSrc, /\bresolveCoderMaxTurns\b/, 'orchestrator.mjs must use resolveCoderMaxTurns');
assert.match(orchSrc, /\bturns_used:/, 'orchestrator.mjs must pass turns_used to recordTaskStep');
assert.match(orchSrc, /\bturn_tokens:/, 'orchestrator.mjs must pass turn_tokens/turn_usages to recordTaskStep');

const appJs = fs.readFileSync(path.join(TEAM_DIR, 'ui', 'js', 'app.js'), 'utf8');
const writerBlockMatch = /writer:\s*\{[\s\S]*?kpi1:\s*\{[^\n]+\}/.exec(appJs);
assert.ok(writerBlockMatch, 'writer kpi1 block must exist in app.js');
assert.ok(
  !writerBlockMatch[0].includes('Tối đa 12 lượt'),
  'app.js Writer Role Guide kpi1 must match actual 2-5 turns policy instead of claiming "Tối đa 12 lượt"'
);

// 4. Reconcile turn_tokens[] sums vs step.prompt_tokens_adjusted, buffer, completion & total_tokens (using raw gateway payload style)
const realStyleTurns = [
  {
    turn: 1,
    stage: 'tool_loop',
    prompt_tokens: 26831,
    prompt_tokens_raw: 26831,
    prompt_tokens_adjusted: 24831,
    usage_adjusted_buffer: 2000,
    fresh_tokens: 24831,
    cached_tokens: 0,
    reported_cached_tokens: 0,
    completion_tokens: 211,
    total_tokens: 27042, // Gateway sets RAW total_tokens
    total_tokens_adjusted: 25042
  },
  {
    turn: 2,
    stage: 'tool_loop',
    prompt_tokens: 32220,
    prompt_tokens_raw: 32220,
    prompt_tokens_adjusted: 30220,
    usage_adjusted_buffer: 2000,
    fresh_tokens: 5644,
    cached_tokens: 24576,
    reported_cached_tokens: 24576,
    completion_tokens: 189,
    total_tokens: 32409,
    total_tokens_adjusted: 30409
  },
  {
    turn: 3,
    stage: 'synthesis',
    prompt_tokens: 35287,
    prompt_tokens_raw: 35287,
    prompt_tokens_adjusted: 33287,
    usage_adjusted_buffer: 2000,
    fresh_tokens: 3079,
    cached_tokens: 30208,
    reported_cached_tokens: 30208,
    completion_tokens: 4977,
    total_tokens: 40264,
    total_tokens_adjusted: 38264
  }
];
const sumField = (arr, k) => arr.reduce((a, x) => a + Number(x[k] || 0), 0);
const realLikeTask = { task_id: 'T-TURN-RECON', steps: [] };
const stepFromTurns = recordTaskStep(realLikeTask, {
  step: '2.1',
  attempt: 1,
  role: 'writer',
  action: 'apply_patch',
  prompt_tokens: 94338,
  prompt_tokens_raw: 94338,
  prompt_tokens_adjusted: 88338,
  usage_adjusted_buffer: 6000,
  fresh_tokens: 33554,
  cached_tokens: 54784,
  completion_tokens: 5377,
  edit_lines_outside_window: 17,
  turn_tokens: realStyleTurns
}, { skipJsonl: true });

assert.equal(sumField(stepFromTurns.turn_tokens, 'prompt_tokens_adjusted'), stepFromTurns.prompt_tokens_adjusted, 'sum(turn_tokens.prompt_tokens_adjusted) MUST equal step.prompt_tokens_adjusted');
assert.equal(sumField(stepFromTurns.turn_tokens, 'usage_adjusted_buffer'), stepFromTurns.usage_adjusted_buffer, 'sum(turn_tokens.usage_adjusted_buffer) MUST equal step.usage_adjusted_buffer');
assert.equal(sumField(stepFromTurns.turn_tokens, 'fresh_tokens'), stepFromTurns.fresh_tokens, 'sum(turn_tokens.fresh_tokens) MUST equal step.fresh_tokens');
assert.equal(sumField(stepFromTurns.turn_tokens, 'completion_tokens'), stepFromTurns.completion_tokens, 'sum(turn_tokens.completion_tokens) MUST equal step.completion_tokens');
assert.equal(sumField(stepFromTurns.turn_tokens, 'total_tokens'), stepFromTurns.total_tokens, 'sum(turn_tokens.total_tokens) MUST equal step.total_tokens (adjusted input + completion)');
assert.equal(sumField(stepFromTurns.turn_tokens, 'total_tokens_adjusted'), stepFromTurns.total_tokens_adjusted);

// Also verify stepEntry (section 2 above where only turn_usages was passed) reconciles step sums automatically
assert.equal(stepEntry.prompt_tokens_adjusted, 44500, 'recordTaskStep must sum prompt_tokens_adjusted from turn_tokens when omitted on step');
assert.equal(stepEntry.total_tokens, 45940, 'recordTaskStep must sum total_tokens from turn_tokens when omitted on step');

const reconOk = reconcileTaskTokens(realLikeTask, stepFromTurns.total_tokens);
assert.equal(reconOk.ok, true, `reconcileTaskTokens must pass cleanly when turn & step sums match: ${reconOk.warning}`);
assert.equal(reconOk.turn_drift, 0, 'reconcileTaskTokens must report turn_drift === 0');

// 5. Verify Token Brake before a tool turn does NOT skip turn numbering (contiguous 1, 2, 3)
//    AND edit_lines_outside_window flows into task.last_report + morning-report.md!
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-telem-rep-'));
try {
  const activeDir = path.join(tmpDir, 'tasks', 'active');
  const archiveDir = path.join(tmpDir, 'tasks', 'archive');
  const cfgDir = path.join(tmpDir, 'cfg');
  const sessDir = path.join(tmpDir, 'sess');
  const repoDir = path.join(tmpDir, 'repo');
  const reportFile = path.join(tmpDir, 'state', 'morning-report.md');
  fs.mkdirSync(activeDir, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(sessDir, { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'web'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'web', 'a.js'), 'const a = 1;\nconst b = 2;\n', 'utf8');
  fs.writeFileSync(path.join(cfgDir, 'policy.yaml'), 'policy:\n  project_id: "telem-rep"\n  scope_control:\n    allowed_dirs: ["web/"]\n', 'utf8');
  fs.writeFileSync(path.join(cfgDir, 'team.yaml'), [
    'providers:',
    '  local_9router:',
    '    base_url: "http://127.0.0.1:29999/v1"',
    '    default_key: "sk-test"',
    'roles:',
    '  writer:',
    '    enabled: true',
    '    model: "mock/writer-main"',
    '    allowed_tools: ["read_file"]'
  ].join('\n'), 'utf8');

  let apiCall = 0;
  const brakeRes = await runAgent({
    role: 'writer',
    prompt: 'Read file then write patch',
    sessionId: 'turn-seq-test',
    scope: ['web/a.js'],
    configDir: cfgDir,
    repoRoot: repoDir,
    sessionsDir: sessDir,
    maxTurns: 4,
    maxTokenBudget: 1500, // Allow turn 1, then trigger Token Brake before turn 2 -> synthesis becomes turn 2 (contiguous!)
    fetchFn: async () => {
      apiCall++;
      if (apiCall === 1) {
        return new Response(JSON.stringify({
          id: 'c1',
          model: 'mock/writer-main',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'web/a.js', start_line: 1, end_line: 2 }) } }]
            },
            finish_reason: 'tool_calls'
          }],
          usage: { prompt_tokens: 1400, completion_tokens: 150, total_tokens: 1550 }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        id: 'c2',
        model: 'mock/writer-main',
        choices: [{ index: 0, message: { role: 'assistant', content: 'FINAL_OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1600, completion_tokens: 50, total_tokens: 1650 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  });
  assert.equal(brakeRes.ok, true);
  assert.deepEqual(brakeRes.turn_usages.map(t => t.turn), [1, 2], 'Token Brake before a turn must keep turn numbering contiguous [1, 2], never jumping [1, 3]');

  const blockedYamlPath = path.join(activeDir, 'T-TURN-RECON.yaml');
  fs.writeFileSync(blockedYamlPath, 'task_id: T-TURN-RECON\ntitle: "Token recon task"\nstatus: blocked\nscope:\n  - web/a.js\n', 'utf8');
  const stateObj = { active_tasks: [], completed_tasks: [], blocked_tasks: [], metrics: { total_input_tokens: 0, total_output_tokens: 0 } };
  transitionTaskState(realLikeTask, stateObj, 'blocked', {
    blockReason: 'test_outside_window',
    retries: 1,
    activeTaskPath: blockedYamlPath
  });
  assert.equal(realLikeTask.last_report.edit_lines_outside_window, 17, 'task.last_report must record edit_lines_outside_window');

  writeMorningReportFile(stateObj, {
    tasksActiveDir: activeDir,
    tasksArchiveDir: archiveDir,
    reportFile
  });
  const md = fs.readFileSync(reportFile, 'utf8');
  assert.match(md, /edit_lines_outside_window:\s*17/, 'morning-report.md must display per-task edit_lines_outside_window');
  assert.match(md, /Edit Lines Outside Window.*:\s*17/i, 'morning-report.md summary must record edit_lines_outside_window total');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('✓ All Item 5 coderMaxTurns & per-turn steps[] telemetry tests passed.');
