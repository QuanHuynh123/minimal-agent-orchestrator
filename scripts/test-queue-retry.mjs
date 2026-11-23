#!/usr/bin/env node
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import * as gitGuard from './git-guard.mjs';
import { createSnapshot } from './server/state-reader.mjs';
import { handleTasksRoutes } from './server/routes-tasks.mjs';
import { DASHBOARD_CSRF_TOKEN } from './server/security.mjs';
import { writeMorningReport } from './orchestrator.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');

function makeMockReq({ method, url, headers = {}, body = null }) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:4310', ...headers };
  req.destroy = () => {};
  process.nextTick(() => {
    if (body !== null && body !== undefined) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      req.emit('data', Buffer.from(payload, 'utf8'));
    }
    req.emit('end');
  });
  return req;
}

function makeMockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers = {}) {
      this.statusCode = code;
      this.headers = headers;
    },
    end(chunk = '') {
      this.body += chunk ? String(chunk) : '';
    },
    json() {
      return this.body ? JSON.parse(this.body) : null;
    }
  };
}

function assertDisjointCanonicalSets(countsOrLists) {
  const activeIds = new Set(countsOrLists.active.map(t => t.task_id || t.id));
  const blockedIds = new Set(countsOrLists.blocked.map(t => t.task_id || t.id));
  const completedIds = new Set(countsOrLists.completed.map(t => t.task_id || t.id));
  for (const id of activeIds) {
    assert.ok(!blockedIds.has(id), `Task ${id} cannot be in both active and blocked`);
    assert.ok(!completedIds.has(id), `Task ${id} cannot be in both active and completed`);
  }
  for (const id of blockedIds) {
    assert.ok(!completedIds.has(id), `Task ${id} cannot be in both blocked and completed`);
  }
}

async function runTests() {
  console.log('Testing dirty-worktree messaging, blocked retry, and canonical queue counts...\n');

  // 1. Disallow allow_dirty_worktree_with_snapshot & verify clear dirty block message
  console.log('1. Checking absence of allow_dirty_worktree_with_snapshot and dirty block message...');
  const policyText = fs.readFileSync(path.resolve(TEAM_DIR, 'config', 'policy.yaml'), 'utf8');
  const readOrchestratorCombinedSource = (scriptsDir) => {
    const subDir = path.join(scriptsDir, 'orchestrator');
    const subFiles = fs.existsSync(subDir)
      ? fs.readdirSync(subDir).filter(f => f.endsWith('.mjs')).sort().map(f => path.join(subDir, f))
      : [];
    return [path.join(scriptsDir, 'orchestrator.mjs'), ...subFiles]
      .map(p => fs.readFileSync(p, 'utf8'))
      .join('\n');
  };
  const orchText = readOrchestratorCombinedSource(path.resolve(TEAM_DIR, 'scripts'));
  assert.ok(
    !policyText.includes('allow_dirty_worktree_with_snapshot') && !orchText.includes('allow_dirty_worktree_with_snapshot'),
    'allow_dirty_worktree_with_snapshot must NOT exist in policy.yaml or orchestrator.mjs'
  );
  assert.strictEqual(
    typeof gitGuard.formatDirtyWorktreeBlockMessage,
    'function',
    'git-guard.mjs must export formatDirtyWorktreeBlockMessage(scopeFiles, dirtyFiles)'
  );
  const blockMsg = gitGuard.formatDirtyWorktreeBlockMessage(
    ['ui_web/index.html', 'tests/test_dom_contract.py'],
    ['ui_web/index.html']
  );
  assert.ok(blockMsg.includes('ui_web/index.html'), 'Block message must name exact dirty file ui_web/index.html');
  assert.ok(!blockMsg.includes('tests/test_dom_contract.py'), 'Block message must NOT falsely blame clean scoped files');
  assert.ok(blockMsg.includes('git add --') && blockMsg.includes('git commit'), 'Block message must include copyable commit command');
  assert.ok(blockMsg.includes('git stash push'), 'Block message must include copyable stash command');
  assert.ok(
    orchText.includes('formatDirtyWorktreeBlockMessage(') && orchText.includes('getModifiedFiles(task.scope)'),
    'orchestrator.mjs must use formatDirtyWorktreeBlockMessage(task.scope, getModifiedFiles(task.scope)) when blocked by dirty worktree'
  );
  console.log('✓ Dirty worktree block message verified.');

  // 2. Canonical Single Source of Truth invariant test across queue-state, state-reader, and morning-report
  console.log('2. Testing Single Source of Truth for task queue counts...');
  const { computeCanonicalQueueState } = await import('./lib/queue-state.mjs');
  assert.strictEqual(typeof computeCanonicalQueueState, 'function', 'queue-state.mjs must export computeCanonicalQueueState');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-queue-'));
  try {
    const tmpTeam = path.join(tmpDir, 'agent-team');
    const cfgDir = path.join(tmpTeam, 'config');
    const tasksActiveDir = path.join(tmpTeam, 'tasks', 'active');
    const tasksArchiveDir = path.join(tmpTeam, 'tasks', 'archive');
    const stateDir = path.join(tmpTeam, 'state');
    const runsDir = path.join(stateDir, 'runs');
    const sessionsDir = path.join(stateDir, 'sessions');
    const liveStatusFile = path.join(stateDir, 'live-status.json');
    const taskStateFile = path.join(stateDir, 'task-state.json');
    const lockFile = path.join(tmpTeam, '.orchestrator.lock');
    const reportFile = path.join(stateDir, 'morning-report.md');

    fs.mkdirSync(cfgDir, { recursive: true });
    fs.mkdirSync(tasksActiveDir, { recursive: true });
    fs.mkdirSync(tasksArchiveDir, { recursive: true });
    fs.mkdirSync(runsDir, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });

    fs.writeFileSync(
      path.join(cfgDir, 'policy.yaml'),
      'policy:\n  project_id: "test-proj"\n  scope_control:\n    allowed_dirs: ["ui_web", "tests"]\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(cfgDir, 'team.yaml'),
      'team:\n  version: "2.1"\nroles: {}\n',
      'utf8'
    );

    const writeTaskYaml = (dir, name, obj) => {
      fs.writeFileSync(path.join(dir, name), YAML.stringify({ task: obj }), 'utf8');
    };

    writeTaskYaml(tasksActiveDir, 'T-ACTIVE-READY.yaml', {
      task_id: 'T-ACTIVE-READY',
      title: 'Ready Task',
      status: 'ready',
      scope: ['ui_web/index.html']
    });
    writeTaskYaml(tasksActiveDir, 'T-ACTIVE-DRAFT.yaml', {
      task_id: 'T-ACTIVE-DRAFT',
      title: 'Draft Task',
      status: 'draft_review',
      scope: ['ui_web/index.html']
    });
    writeTaskYaml(tasksActiveDir, 'T-BLOCKED-1.yaml', {
      task_id: 'T-BLOCKED-1',
      title: 'Blocked Task',
      status: 'blocked',
      block_reason: blockMsg,
      last_error: blockMsg,
      scope: ['ui_web/index.html']
    });
    // Stale duplicate in active/ whose canonical state is already done in archive/
    writeTaskYaml(tasksActiveDir, 'T-STALE-DONE-IN-ACTIVE.yaml', {
      task_id: 'T-DONE-1',
      title: 'Already Archived Task',
      status: 'ready',
      scope: ['ui_web/index.html']
    });
    writeTaskYaml(tasksArchiveDir, 'T-DONE-1.yaml', {
      task_id: 'T-DONE-1',
      title: 'Archived Done 1',
      status: 'done',
      completed_at: '2026-11-13T10:00:00.000Z'
    });
    writeTaskYaml(tasksArchiveDir, 'T-DONE-2.yaml', {
      task_id: 'T-DONE-2',
      title: 'Archived Done 2',
      status: 'done',
      completed_at: '2026-11-13T11:00:00.000Z'
    });

    const driftedTaskState = {
      active_tasks: [
        { task_id: 'T-DONE-1', status: 'ready' },
        { task_id: 'T-BLOCKED-1', status: 'ready' },
        { task_id: 'T-PHANTOM-ACTIVE', status: 'ready' }
      ],
      blocked_tasks: [
        { task_id: 'T-BLOCKED-1', status: 'blocked' },
        { task_id: 'T-BLOCKED-1', status: 'blocked' },
        { task_id: 'T-PHANTOM-BLOCKED', status: 'blocked' }
      ],
      completed_tasks: [
        { task_id: 'T-DONE-1', status: 'done' },
        { task_id: 'T-LEGACY-DONE', status: 'done' }
      ],
      metrics: { total_input_tokens: 0, total_output_tokens: 0, total_cost_est_usd: 0 }
    };
    fs.writeFileSync(taskStateFile, JSON.stringify(driftedTaskState, null, 2), 'utf8');

    const driftedLiveStatus = {
      active: false,
      current_task_id: 'T-BLOCKED-1',
      current_stage: 'blocked',
      last_error: blockMsg,
      queue_stats: { active: 99, completed: 0, blocked: 77 },
      tokens: { task_input: 0, task_output: 0, session_input: 0, session_output: 0, session_cached: 0, cache_hit_pct: 0 }
    };
    fs.writeFileSync(liveStatusFile, JSON.stringify(driftedLiveStatus, null, 2), 'utf8');

    const canonical = computeCanonicalQueueState({
      tasksActiveDir,
      tasksArchiveDir,
      taskState: driftedTaskState
    });
    assertDisjointCanonicalSets(canonical);
    assert.deepStrictEqual(canonical.counts, { active: 2, completed: 3, blocked: 1 });
    assert.deepStrictEqual(
      canonical.active.map(t => t.task_id).sort(),
      ['T-ACTIVE-DRAFT', 'T-ACTIVE-READY']
    );
    assert.deepStrictEqual(
      canonical.blocked.map(t => t.task_id),
      ['T-BLOCKED-1']
    );
    assert.deepStrictEqual(
      canonical.completed.map(t => t.task_id).sort(),
      ['T-DONE-1', 'T-DONE-2', 'T-LEGACY-DONE']
    );

    const snapshotPaths = {
      TEAM_DIR: tmpTeam,
      CONFIG_DIR: cfgDir,
      TASKS_ACTIVE_DIR: tasksActiveDir,
      TASKS_ARCHIVE_DIR: tasksArchiveDir,
      RUNS_DIR: runsDir,
      SESSIONS_DIR: sessionsDir,
      LIVE_STATUS_FILE: liveStatusFile,
      TASK_STATE_FILE: taskStateFile,
      LOCK_FILE: lockFile
    };
    const snap = await createSnapshot(snapshotPaths);
    assert.strictEqual(snap.queue.active_count, 2, 'Snapshot active_count must match canonical count');
    assert.strictEqual(snap.queue.blocked_count, 1, 'Snapshot blocked_count must match canonical count');
    assert.strictEqual(snap.queue.completed_count, 3, 'Snapshot completed_count must match canonical count');
    assert.deepStrictEqual(
      snap.live_status.queue_stats,
      { active: 2, completed: 3, blocked: 1 },
      'Snapshot live_status.queue_stats must stay synchronized with canonical counts'
    );

    writeMorningReport(driftedTaskState, {
      tasksActiveDir,
      tasksArchiveDir,
      reportFile
    });
    const reportMd = fs.readFileSync(reportFile, 'utf8');
    assert.ok(reportMd.includes('- Completed Tasks: 3'), `Morning report completed mismatch:\n${reportMd}`);
    assert.ok(reportMd.includes('- Blocked Tasks: 1'), `Morning report blocked mismatch:\n${reportMd}`);
    assert.ok(reportMd.includes('- Active Tasks Remaining: 2'), `Morning report active mismatch:\n${reportMd}`);
    console.log('✓ Canonical queue counts match identically across queue-state, snapshot, live-status, and morning-report.');

    // 3. Blocked Retry endpoint & resync behavior
    console.log('3. Testing POST /api/task/retry endpoint & resync...');
    const fullSnapshotPaths = {
      ...snapshotPaths,
      REPORT_FILE: reportFile
    };
    const routeOptions = {
      TEAM_DIR: tmpTeam,
      TASKS_ACTIVE_DIR: tasksActiveDir,
      SESSIONS_DIR: sessionsDir,
      LOCK_FILE: lockFile,
      snapshotPaths: fullSnapshotPaths
    };
    const retryUrl = new URL('/api/task/retry', 'http://127.0.0.1:4310');

    // 3a. Unauthorized request without CSRF token must return 403
    const unauthRes = makeMockRes();
    const unauthHandled = await handleTasksRoutes(
      makeMockReq({ method: 'POST', url: '/api/task/retry', body: { task_id: 'T-BLOCKED-1' } }),
      unauthRes,
      retryUrl,
      routeOptions
    );
    assert.strictEqual(unauthHandled, true);
    assert.strictEqual(unauthRes.statusCode, 403);

    // 3b. Path traversal task_id must be rejected with 400
    const badIdRes = makeMockRes();
    await handleTasksRoutes(
      makeMockReq({
        method: 'POST',
        url: '/api/task/retry',
        headers: { 'x-dashboard-token': DASHBOARD_CSRF_TOKEN },
        body: { task_id: '../evil', start_orchestrator: false }
      }),
      badIdRes,
      retryUrl,
      routeOptions
    );
    assert.strictEqual(badIdRes.statusCode, 400);

    // 3c. Non-blocked task must be rejected with 409
    const notBlockedRes = makeMockRes();
    await handleTasksRoutes(
      makeMockReq({
        method: 'POST',
        url: '/api/task/retry',
        headers: { 'x-dashboard-token': DASHBOARD_CSRF_TOKEN },
        body: { task_id: 'T-ACTIVE-READY', start_orchestrator: false }
      }),
      notBlockedRes,
      retryUrl,
      routeOptions
    );
    assert.strictEqual(notBlockedRes.statusCode, 409);

    // 3d. Retrying blocked task succeeds, clears blocker metadata, and updates canonical counts immediately
    const retryRes = makeMockRes();
    const retryHandled = await handleTasksRoutes(
      makeMockReq({
        method: 'POST',
        url: '/api/task/retry',
        headers: { 'x-dashboard-token': DASHBOARD_CSRF_TOKEN },
        body: { task_id: 'T-BLOCKED-1', start_orchestrator: false }
      }),
      retryRes,
      retryUrl,
      routeOptions
    );
    assert.strictEqual(retryHandled, true);
    assert.strictEqual(retryRes.statusCode, 200, `Expected 200, got ${retryRes.statusCode}: ${retryRes.body}`);
    const retryJson = retryRes.json();
    assert.strictEqual(retryJson.ok, true);
    assert.strictEqual(retryJson.task_id, 'T-BLOCKED-1');
    assert.strictEqual(retryJson.status, 'ready');
    assert.deepStrictEqual(retryJson.queue_stats, { active: 3, completed: 3, blocked: 0 });

    const retriedYaml = YAML.parse(fs.readFileSync(path.join(tasksActiveDir, 'T-BLOCKED-1.yaml'), 'utf8'));
    assert.strictEqual(retriedYaml.task.status, 'ready');
    assert.strictEqual(retriedYaml.task.block_reason, undefined);
    assert.strictEqual(retriedYaml.task.last_error, undefined);

    const postRetrySnap = await createSnapshot(snapshotPaths);
    assert.strictEqual(postRetrySnap.queue.active_count, 3);
    assert.strictEqual(postRetrySnap.queue.blocked_count, 0);
    assert.strictEqual(postRetrySnap.queue.completed_count, 3);
    assert.deepStrictEqual(postRetrySnap.live_status.queue_stats, { active: 3, completed: 3, blocked: 0 });
    assert.strictEqual(postRetrySnap.live_status.last_error, null, 'Clearing final blocked task should clear stale blocked last_error');

    const postRetryReport = fs.readFileSync(reportFile, 'utf8');
    assert.ok(postRetryReport.includes('- Active Tasks Remaining: 3'));
    assert.ok(postRetryReport.includes('- Blocked Tasks: 0'));
    console.log('✓ /api/task/retry state reset & canonical count resync verified.');

    // 3e. awaiting_confirmation task telemetry & morning-report aggregation
    console.log('3e. Testing awaiting_confirmation telemetry merge & morning-report aggregation...');
    writeTaskYaml(tasksActiveDir, 'T-AWAIT-UI.yaml', {
      task_id: 'T-AWAIT-UI',
      title: 'Frontend layout task awaiting merge confirmation',
      mode: 'quick',
      status: 'awaiting_confirmation',
      scope: ['ui_web/index.html'],
      pending_branch: 'ai-task/T-AWAIT-UI',
      commit_hash: 'deadbeef1234',
      merge_command: 'git merge --no-ff ai-task/T-AWAIT-UI'
    });
    const awaitTaskState = {
      active_tasks: [
        {
          task_id: 'T-AWAIT-UI',
          title: 'Frontend layout task awaiting merge confirmation',
          mode: 'quick',
          status: 'awaiting_confirmation',
          commit_hash: 'deadbeef1234',
          pending_branch: 'ai-task/T-AWAIT-UI',
          merge_command: 'git merge --no-ff ai-task/T-AWAIT-UI',
          retries: 0,
          edit_lines_outside_window: 77,
          steps: [
            {
              step: '2.1',
              attempt: 1,
              role: 'writer',
              action: 'apply_patch (bucket 1/2)',
              actual_model: 'deepseek-v4.1',
              scope: ['ui_web/index.html'],
              validation_status: 'passed',
              edit_lines_outside_window: 77,
              unseen_exact_match: true,
              unseen_exact_matches: [
                { block: 1, file: 'ui_web/index.html', start_line: 310, end_line: 318, non_empty_lines: 7, is_delete: true, action_kind: 'delete' }
              ]
            }
          ],
          last_report: {
            final_status: 'awaiting_confirmation',
            validation_passed: true,
            retries_used: 0,
            edit_lines_outside_window: 77,
            unseen_exact_match_count: 1,
            unseen_exact_matches: [
              { block: 1, file: 'ui_web/index.html', start_line: 310, end_line: 318, non_empty_lines: 7, is_delete: true, action_kind: 'delete' }
            ]
          }
        }
      ],
      completed_tasks: [],
      blocked_tasks: [],
      metrics: { total_input_tokens: 5000, total_output_tokens: 900, total_cost_est_usd: 0.01 }
    };
    const awaitReportFile = path.join(stateDir, 'morning-report-await.md');
    const awaitReportMeta = writeMorningReport(awaitTaskState, {
      tasksActiveDir,
      tasksArchiveDir,
      reportFile: awaitReportFile
    });
    assert.ok(
      Array.isArray(awaitReportMeta.awaiting_confirmation) && awaitReportMeta.awaiting_confirmation.length === 1,
      'Canonical report state must include awaiting_confirmation list'
    );
    const awaitMd = fs.readFileSync(awaitReportFile, 'utf8');
    assert.ok(awaitMd.includes('- Awaiting Confirmation Tasks: 1'), `Expected awaiting confirmation count in Summary:\n${awaitMd}`);
    assert.ok(awaitMd.includes('- Edit Lines Outside Window (Run Total): 77'), `Expected Edit Lines Outside Window: 77 in Summary:\n${awaitMd}`);
    assert.ok(awaitMd.includes('- Unseen Exact Matches (Run Total): 1 block(s) (1 [DELETE])'), `Expected Unseen Exact Matches: 1 block(s) in Summary:\n${awaitMd}`);
    assert.ok(awaitMd.includes('## Awaiting Confirmation Tasks') && awaitMd.includes('T-AWAIT-UI'), `Expected Awaiting Confirmation Tasks section listing T-AWAIT-UI:\n${awaitMd}`);
    assert.ok(awaitMd.includes('ui_web/index.html:310-318') && awaitMd.includes('[DELETE]'), `Expected awaiting task unseen_exact_match detail:\n${awaitMd}`);
    console.log('✓ awaiting_confirmation morning-report & telemetry merge verified.');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // 4. Cockpit UI Retry button & safe DOM (no innerHTML) verification
  console.log('4. Checking Cockpit UI Retry button contract & anti-XSS DOM safety...');
  const apiJs = fs.readFileSync(path.resolve(TEAM_DIR, 'ui', 'js', 'api.js'), 'utf8');
  const appJs = fs.readFileSync(path.resolve(TEAM_DIR, 'ui', 'js', 'app.js'), 'utf8');
  const cssText = fs.readFileSync(path.resolve(TEAM_DIR, 'ui', 'css', 'style.css'), 'utf8');
  assert.ok(apiJs.includes('retryTask') && apiJs.includes('/api/task/retry'), 'ui/js/api.js must expose retryTask calling /api/task/retry');
  const retryStartIdx = appJs.indexOf('async function handleRetryBlockedTask');
  const retryEndIdx = appJs.indexOf('// Render Scoped Files securely');
  const queueStartIdx = appJs.indexOf('function renderTaskQueue');
  assert.ok(retryStartIdx >= 0 && retryEndIdx > retryStartIdx && queueStartIdx > retryEndIdx, 'Retry and queue helpers must exist in ui/js/app.js');
  const retryBannerSlice = appJs.slice(retryStartIdx, retryEndIdx);
  const queueSlice = appJs.slice(queueStartIdx, queueStartIdx + 4500);
  assert.ok(retryBannerSlice.includes('btn-banner-retry') && queueSlice.includes('btn-queue-retry'), 'ui/js/app.js must wire Retry button calling retryTask');
  assert.ok(!retryBannerSlice.includes('.innerHTML') && !queueSlice.includes('.innerHTML'), 'Retry banner & task queue rendering must not use .innerHTML');
  assert.ok(cssText.includes('.btn-queue-retry'), 'ui/css/style.css must style .btn-queue-retry');
  console.log('✓ Cockpit UI Retry button & safe DOM verified.');

  console.log('\n=============================================');
  console.log('ALL QUEUE / RETRY / CANONICAL TESTS PASSED!');
  console.log('=============================================');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
