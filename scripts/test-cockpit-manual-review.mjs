#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AGENT_TEAM_DIR = path.resolve(__dirname, '..');

async function runTests() {
  console.log('Testing Cockpit "Chờ duyệt tay" Manual Review Queue (review_unavailable + git apply)...\n');

  const qs = await import('./lib/queue-state.mjs');
  const { createSnapshot } = await import('./server/state-reader.mjs');

  assert.equal(typeof qs.buildGitApplyCommand, 'function', 'queue-state.mjs must export buildGitApplyCommand');
  assert.equal(typeof qs.collectManualReviewQueue, 'function', 'queue-state.mjs must export collectManualReviewQueue');

  assert.equal(
    qs.buildGitApplyCommand('patches/T-1/pending-review-attempt-1.patch'),
    'git apply patches/T-1/pending-review-attempt-1.patch'
  );
  assert.equal(
    qs.buildGitApplyCommand('patches/task 1/pending review.patch'),
    'git apply "patches/task 1/pending review.patch"'
  );

  // 1. normalizeQueueTask preserves review_unavailable metadata & derives apply_command
  const normDirect = qs.normalizeQueueTask({
    task_id: 'T-REV-DIRECT',
    title: 'Manual review task <img onerror=alert(1)>',
    status: 'blocked',
    failure_class: 'review_unavailable',
    pending_review_patch: 'patches/T-REV-DIRECT/pending-review-attempt-1.patch',
    block_reason: 'review_unavailable: Reviewer output invalid JSON'
  });
  assert.equal(normDirect.failure_class, 'review_unavailable');
  assert.equal(normDirect.pending_review_patch, 'patches/T-REV-DIRECT/pending-review-attempt-1.patch');
  assert.equal(normDirect.apply_command, 'git apply patches/T-REV-DIRECT/pending-review-attempt-1.patch');

  const normFallback = qs.normalizeQueueTask({
    task_id: 'T-REV-FALLBACK',
    title: 'Reason-only review_unavailable task',
    status: 'blocked',
    block_reason: 'review_unavailable: malformed JSON. Code passed validation; patch saved to patches/T-REV-FALLBACK/pending-review-attempt-2.patch for manual review.'
  });
  assert.equal(normFallback.failure_class, 'review_unavailable');
  assert.equal(normFallback.pending_review_patch, 'patches/T-REV-FALLBACK/pending-review-attempt-2.patch');
  assert.equal(normFallback.apply_command, 'git apply patches/T-REV-FALLBACK/pending-review-attempt-2.patch');

  // 2. End-to-end state-reader createSnapshot queue.manual_review filtering
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'td-manual-review-'));
  try {
    const cfgDir = path.join(tmpRoot, 'config');
    const activeDir = path.join(tmpRoot, 'tasks', 'active');
    const archiveDir = path.join(tmpRoot, 'tasks', 'archive');
    const stateDir = path.join(tmpRoot, 'state');
    const runsDir = path.join(stateDir, 'runs');
    const sessionsDir = path.join(stateDir, 'sessions');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.mkdirSync(activeDir, { recursive: true });
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.mkdirSync(runsDir, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.copyFileSync(path.join(AGENT_TEAM_DIR, 'config', 'team.yaml'), path.join(cfgDir, 'team.yaml'));
    fs.copyFileSync(path.join(AGENT_TEAM_DIR, 'config', 'policy.yaml'), path.join(cfgDir, 'policy.yaml'));

    fs.writeFileSync(
      path.join(activeDir, 'T-REV-1.yaml'),
      [
        'task:',
        '  task_id: "T-REV-1"',
        '  title: "Review unavailable patch task"',
        '  status: "blocked"',
        '  failure_class: "review_unavailable"',
        '  pending_review_patch: "patches/T-REV-1/pending-review-attempt-1.patch"',
        '  block_reason: "review_unavailable: Reviewer output invalid JSON"'
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(activeDir, 'T-OTHER-BLK.yaml'),
      [
        'task:',
        '  task_id: "T-OTHER-BLK"',
        '  title: "Non-review blocked task"',
        '  status: "blocked"',
        '  block_reason: "scope violation"'
      ].join('\n'),
      'utf8'
    );

    const snap = await createSnapshot({
      TEAM_DIR: tmpRoot,
      CONFIG_DIR: cfgDir,
      TASKS_ACTIVE_DIR: activeDir,
      TASKS_ARCHIVE_DIR: archiveDir,
      LIVE_STATUS_FILE: path.join(stateDir, 'live-status.json'),
      TASK_STATE_FILE: path.join(stateDir, 'task-state.json'),
      LOCK_FILE: path.join(tmpRoot, '.orchestrator.lock'),
      RUNS_DIR: runsDir,
      SESSIONS_DIR: sessionsDir
    });

    assert.equal(snap.queue.blocked_count, 2);
    assert.equal(snap.queue.manual_review_count, 1, 'Only review_unavailable blocked tasks must enter manual_review');
    assert.ok(Array.isArray(snap.queue.manual_review) && snap.queue.manual_review.length === 1);
    assert.equal(snap.queue.manual_review[0].task_id, 'T-REV-1');
    assert.equal(snap.queue.manual_review[0].pending_review_patch, 'patches/T-REV-1/pending-review-attempt-1.patch');
    assert.equal(
      snap.queue.manual_review[0].apply_command,
      'git apply patches/T-REV-1/pending-review-attempt-1.patch'
    );

    // 2b. Verify unseen_exact_matches with modify + delete blocks flow into Cockpit snapshot
    const unseenTaskYaml = [
      'task:',
      '  task_id: "T-UNSEEN-UI"',
      '  title: "Verify unseen exact match display"',
      '  status: "done"',
      '  last_report:',
      '    final_status: "done"',
      '    unseen_exact_match_count: 2',
      '    unseen_exact_matches:',
      '      - block: 1',
      '        file: "web/view.html"',
      '        start_line: 100',
      '        end_line: 105',
      '        is_delete: false',
      '        action_kind: "modify"',
      '      - block: 2',
      '        file: "web/view.html"',
      '        start_line: 210',
      '        end_line: 218',
      '        is_delete: true',
      '        action_kind: "delete"'
    ].join('\n');
    fs.writeFileSync(path.join(archiveDir, 'T-UNSEEN-UI.yaml'), unseenTaskYaml, 'utf8');

    const snap2 = await createSnapshot({
      TEAM_DIR: tmpRoot,
      CONFIG_DIR: cfgDir,
      TASKS_ACTIVE_DIR: activeDir,
      TASKS_ARCHIVE_DIR: archiveDir,
      LIVE_STATUS_FILE: path.join(stateDir, 'live-status.json'),
      TASK_STATE_FILE: path.join(stateDir, 'task-state.json'),
      LOCK_FILE: path.join(tmpRoot, '.orchestrator.lock'),
      RUNS_DIR: runsDir,
      SESSIONS_DIR: sessionsDir
    });
    assert.equal(snap2.queue.unseen_exact_match_count, 2, 'Snapshot queue must expose total unseen_exact_match block count');
    assert.ok(Array.isArray(snap2.queue.unseen_exact_matches) && snap2.queue.unseen_exact_matches.length === 1);
    const uiEntry = snap2.queue.unseen_exact_matches[0];
    assert.equal(uiEntry.task_id, 'T-UNSEEN-UI');
    assert.equal(uiEntry.block_count, 2);
    assert.equal(uiEntry.delete_count, 1);
    assert.equal(uiEntry.blocks[1].is_delete, true);
    assert.equal(uiEntry.blocks[1].file, 'web/view.html');
    assert.equal(uiEntry.blocks[1].start_line, 210);
    assert.equal(uiEntry.blocks[1].end_line, 218);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  // 3. Cockpit UI & Anti-XSS DOM contract check
  const sidebarHtml = fs.readFileSync(path.join(AGENT_TEAM_DIR, 'ui', 'layouts', 'layout-sidebar.html'), 'utf8');
  assert.ok(sidebarHtml.includes('id="manual-review-section"'), 'Cockpit sidebar must include #manual-review-section');
  assert.ok(sidebarHtml.includes('id="cnt-manual-review"'), 'Cockpit sidebar must include #cnt-manual-review');
  assert.ok(sidebarHtml.includes('id="manual-review-list"'), 'Cockpit sidebar must include #manual-review-list');
  assert.ok(/Chờ duyệt tay/i.test(sidebarHtml), 'Cockpit manual review header must label "Chờ duyệt tay"');
  assert.ok(sidebarHtml.includes('id="unseen-exact-section"'), 'Cockpit sidebar must include #unseen-exact-section');
  assert.ok(sidebarHtml.includes('id="cnt-unseen-exact"'), 'Cockpit sidebar must include #cnt-unseen-exact');
  assert.ok(sidebarHtml.includes('id="unseen-exact-list"'), 'Cockpit sidebar must include #unseen-exact-list');

  const appJs = fs.readFileSync(path.join(AGENT_TEAM_DIR, 'ui', 'js', 'app.js'), 'utf8');
  const fnIdx = appJs.indexOf('function renderManualReviewQueue');
  assert.ok(fnIdx !== -1, 'ui/js/app.js must define renderManualReviewQueue');
  const fnSlice = appJs.slice(fnIdx, fnIdx + 2500);
  assert.ok(fnSlice.includes('apply_command') && fnSlice.includes('git apply'), 'renderManualReviewQueue must display git apply command');
  assert.ok(fnSlice.includes('.textContent'), 'renderManualReviewQueue must render fields via .textContent');
  assert.ok(!/\.innerHTML\s*=/.test(fnSlice.replace(/\w+\.innerHTML\s*=\s*['"]['"]\s*;/g, '')), 'renderManualReviewQueue must NOT inject dynamic markup via .innerHTML');

  const unseenIdx = appJs.indexOf('function renderUnseenExactMatches');
  assert.ok(unseenIdx !== -1, 'ui/js/app.js must define renderUnseenExactMatches');
  const unseenSlice = appJs.slice(unseenIdx, unseenIdx + 2600);
  assert.ok(unseenSlice.includes('unseen_exact_matches'), 'renderUnseenExactMatches must consume queue.unseen_exact_matches');
  assert.ok(unseenSlice.includes('DELETE'), 'renderUnseenExactMatches must label delete blocks clearly');
  assert.ok(unseenSlice.includes('.textContent'), 'renderUnseenExactMatches must render fields via .textContent');
  assert.ok(!/\.innerHTML\s*=/.test(unseenSlice.replace(/\w+\.innerHTML\s*=\s*['"]['"]\s*;/g, '')), 'renderUnseenExactMatches must NOT inject dynamic markup via .innerHTML');

  console.log('✓ Manual review queue backend normalization, snapshot filter & anti-XSS UI verified.');
}

runTests().catch(err => {
  console.error('Manual review queue test failed:', err);
  process.exit(1);
});
