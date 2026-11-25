#!/usr/bin/env node
import assert from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { readLatestRunOutput } from './server/state-reader.mjs';
import { handleTasksRoutes } from './server/routes-tasks.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');

async function runCockpitTests() {
  console.log('Testing Interactive Goal Cockpit & CSRF Security...\n');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'td-cockpit-hermetic-'));
  const tmpConfigDir = path.join(tmpRoot, 'config');
  const tmpStateDir = path.join(tmpRoot, 'state');
  const tmpTasksDir = path.join(tmpRoot, 'tasks');
  const ACTIVE_DIR = path.join(tmpTasksDir, 'active');
  fs.mkdirSync(tmpConfigDir, { recursive: true });
  fs.mkdirSync(tmpStateDir, { recursive: true });
  fs.mkdirSync(ACTIVE_DIR, { recursive: true });
  fs.mkdirSync(path.join(tmpTasksDir, 'archive'), { recursive: true });
  fs.copyFileSync(path.resolve(TEAM_DIR, 'config', 'team.yaml'), path.join(tmpConfigDir, 'team.yaml'));
  fs.copyFileSync(path.resolve(TEAM_DIR, 'config', 'policy.yaml'), path.join(tmpConfigDir, 'policy.yaml'));

  process.env.AGENT_TEAM_CONFIG_DIR = tmpConfigDir;
  process.env.AGENT_TEAM_STATE_DIR = tmpStateDir;
  process.env.AGENT_TEAM_TASKS_DIR = tmpTasksDir;
  process.env.ORCHESTRATOR_LOCK_FILE = path.join(tmpRoot, '.orchestrator.lock');
  process.env.COCKPIT_LOCK_FILE = path.join(tmpRoot, '.cockpit.lock');

  const { startServer, server, DASHBOARD_CSRF_TOKEN } = await import('./dashboard.mjs');

  // Start test server on dynamic free port
  const srv = await startServer(0, '127.0.0.1');
  const testPort = srv.address().port;

  try {
    // Test 1: Snapshot returns CSRF token
    console.log('1. Testing /api/snapshot CSRF token injection...');
    const snapRes = await fetch(`http://127.0.0.1:${testPort}/api/snapshot`);
    assert.strictEqual(snapRes.status, 200, 'Snapshot should return 200');
    const snapData = await snapRes.json();
    assert.ok(snapData.csrf_token, 'Snapshot must include csrf_token');
    assert.strictEqual(snapData.csrf_token, DASHBOARD_CSRF_TOKEN, 'CSRF token must match runtime secret');
    console.log('✓ Snapshot CSRF token verified.');

    // Test 2: POST /api/decompose without CSRF token is blocked
    console.log('2. Testing CSRF block on unauthenticated POST /api/decompose...');
    const blockedRes = await fetch(`http://127.0.0.1:${testPort}/api/decompose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'Test unauth goal' })
    });
    assert.strictEqual(blockedRes.status, 403, 'Request without token must be blocked with 403 Forbidden');
    console.log('✓ CSRF guard successfully blocked unauthorized POST.');

    // Test 3: POST /api/approve-run converts 'draft_review' to 'ready'
    console.log('3. Testing /api/approve-run task status conversion...');
    const dummyTaskId = `T-test-cockpit-dummy-${Date.now()}`;
    const dummyPath = path.resolve(ACTIVE_DIR, `${dummyTaskId}.yaml`);
    fs.mkdirSync(ACTIVE_DIR, { recursive: true });
    fs.writeFileSync(dummyPath, `task:\n  task_id: "${dummyTaskId}"\n  status: "draft_review"\n  scope: ["src/example.js"]\n`, 'utf8');

    try {
      const approveRes = await fetch(`http://127.0.0.1:${testPort}/api/approve-run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Dashboard-Token': DASHBOARD_CSRF_TOKEN
        },
        body: JSON.stringify({ task_ids: [dummyTaskId], start_orchestrator: false })
      });
      assert.strictEqual(approveRes.status, 200, 'Approve run must return 200');
      const approveData = await approveRes.json();
      assert.ok(approveData.ok, 'Approve response must be ok');

      const updatedYaml = fs.readFileSync(dummyPath, 'utf8');
      assert.ok(updatedYaml.includes('status: ready'), 'Task status must be converted to "ready"');
      console.log('✓ Task status successfully updated to "ready".');
    } finally {
      if (fs.existsSync(dummyPath)) fs.unlinkSync(dummyPath);
    }

    // Test 4: GET /api/models returns model list
    console.log('4. Testing GET /api/models endpoint...');
    const modelsRes = await fetch(`http://127.0.0.1:${testPort}/api/models`);
    assert.strictEqual(modelsRes.status, 200, 'GET /api/models should return 200');
    const modelsData = await modelsRes.json();
    assert.ok(modelsData.ok, 'modelsData.ok should be true');
    assert.ok(Array.isArray(modelsData.models), 'modelsData.models should be an array');
    assert.ok(modelsData.models.length > 0, 'models array should not be empty');
    console.log(`✓ GET /api/models returned ${modelsData.models.length} models (source: ${modelsData.source}).`);

    // Test 5: POST /api/test-model CSRF and ping structure
    console.log('5. Testing POST /api/test-model with CSRF protection...');
    const testModelUnauth = await fetch(`http://127.0.0.1:${testPort}/api/test-model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'kr/claude-sonnet-4.5-thinking' })
    });
    assert.strictEqual(testModelUnauth.status, 403, 'Unauthorized /api/test-model must be 403');

    const testModelAuth = await fetch(`http://127.0.0.1:${testPort}/api/test-model`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Dashboard-Token': DASHBOARD_CSRF_TOKEN
      },
      body: JSON.stringify({ model: 'kr/claude-sonnet-4.5-thinking' })
    });
    assert.strictEqual(testModelAuth.status, 200, 'Authorized /api/test-model must return 200');
    const testModelData = await testModelAuth.json();
    assert.ok(typeof testModelData.latency_ms === 'number', 'latency_ms must be numeric');
    console.log(`✓ POST /api/test-model returned status: ${testModelData.status} (${testModelData.latency_ms}ms).`);

    // Test 6: POST /api/save-team-config updates team.yaml and rolls back
    console.log('6. Testing POST /api/save-team-config with CSRF and rollback...');
    const TEAM_CONFIG_FILE = path.join(tmpConfigDir, 'team.yaml');
    const originalYaml = fs.readFileSync(TEAM_CONFIG_FILE, 'utf8');

    try {
      const saveRes = await fetch(`http://127.0.0.1:${testPort}/api/save-team-config`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Dashboard-Token': DASHBOARD_CSRF_TOKEN
        },
        body: JSON.stringify({
          roles: {
            router: { model: 'ag/gemini-3.6-flash-low', display_name: 'Gemini 3.6 Flash' }
          }
        })
      });
      assert.strictEqual(saveRes.status, 200, 'POST /api/save-team-config must return 200');
      const saveData = await saveRes.json();
      assert.ok(saveData.ok, 'Save response must be ok');

      const updatedYaml = fs.readFileSync(TEAM_CONFIG_FILE, 'utf8');
      assert.ok(updatedYaml.includes('ag/gemini-3.6-flash-low'), 'team.yaml must reflect new model');
      console.log('✓ team.yaml successfully updated via /api/save-team-config.');
    } finally {
      // Restore original team.yaml
      fs.writeFileSync(TEAM_CONFIG_FILE, originalYaml, 'utf8');
      console.log('✓ Restored original team.yaml.');
    }

    // Test 7: GET /api/task/detail, POST /api/task/save, POST /api/task/delete
    console.log('7. Testing /api/task/detail, /api/task/save, /api/task/delete lifecycle...');
    const testTaskId = `T-test-crud-${Date.now()}`;
    const testTaskFile = path.resolve(ACTIVE_DIR, `${testTaskId}.yaml`);
    fs.writeFileSync(testTaskFile, `task:\n  task_id: "${testTaskId}"\n  title: "Test CRUD Task"\n  status: "draft_review"\n  mode: "quick"\n  goal: "Verify CRUD API"\n`, 'utf8');

    try {
      // 7a. GET detail
      const detailRes = await fetch(`http://127.0.0.1:${testPort}/api/task/detail?id=${encodeURIComponent(testTaskId)}`);
      assert.strictEqual(detailRes.status, 200, 'GET /api/task/detail should return 200');
      const detailData = await detailRes.json();
      assert.ok(detailData.ok, 'detailData.ok should be true');
      assert.strictEqual(detailData.task_id, testTaskId);
      assert.strictEqual(detailData.task.title, 'Test CRUD Task');
      assert.ok(detailData.raw_yaml.includes('Verify CRUD API'), 'raw_yaml should contain task content');
      console.log('✓ /api/task/detail verified successfully.');

      // 7b. POST save (editing task)
      const saveRes = await fetch(`http://127.0.0.1:${testPort}/api/task/save`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Dashboard-Token': DASHBOARD_CSRF_TOKEN
        },
        body: JSON.stringify({
          task_id: testTaskId,
          raw_yaml: `task:\n  task_id: "${testTaskId}"\n  title: "Updated CRUD Task"\n  status: "draft_review"\n  mode: "quick"\n  goal: "Verify Save Hook"\n`
        })
      });
      assert.strictEqual(saveRes.status, 200, 'POST /api/task/save should return 200');
      const saveData = await saveRes.json();
      assert.ok(saveData.ok, 'saveData.ok should be true');
      const savedYaml = fs.readFileSync(testTaskFile, 'utf8');
      assert.ok(savedYaml.includes('Updated CRUD Task'), 'File on disk must reflect saved content');
      console.log('✓ /api/task/save verified successfully.');

      // 7c. POST delete without CSRF token must be 403
      const delUnauth = await fetch(`http://127.0.0.1:${testPort}/api/task/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: testTaskId })
      });
      assert.strictEqual(delUnauth.status, 403, 'Unauthorized /api/task/delete must be 403');

      // 7d. POST delete with CSRF token deletes file
      const delAuth = await fetch(`http://127.0.0.1:${testPort}/api/task/delete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Dashboard-Token': DASHBOARD_CSRF_TOKEN
        },
        body: JSON.stringify({ task_id: testTaskId })
      });
      assert.strictEqual(delAuth.status, 200, 'Authorized /api/task/delete must return 200');
      const delData = await delAuth.json();
      assert.ok(delData.ok, 'delData.ok should be true');
      assert.strictEqual(fs.existsSync(testTaskFile), false, 'Task file must be deleted from disk');
      console.log('✓ /api/task/delete verified successfully.');
    } finally {
      if (fs.existsSync(testTaskFile)) fs.unlinkSync(testTaskFile);
    }

    // Test 8: Cockpit v3.1 Preset Selector & Cache Hit Telemetry DOM/API Contract
    console.log('8. Testing Cockpit v3.1 Workflow Preset Selector & Cache Hit Telemetry...');
    assert.strictEqual(typeof snapData.live_status?.tokens?.cache_hit_pct, 'number', 'Snapshot tokens must include numeric cache_hit_pct');
    const htmlRes = await fetch(`http://127.0.0.1:${testPort}/`);
    assert.strictEqual(htmlRes.status, 200, 'GET / should return 200');
    const htmlText = await htmlRes.text();
    assert.ok(htmlText.includes('id="sel-workflow-preset"'), 'Index HTML must include #sel-workflow-preset selector');
    assert.ok(htmlText.includes('id="tok-cache"'), 'Index HTML must include #tok-cache telemetry badge');
    assert.ok(htmlText.includes('id="cfg-panel-roles"'), 'Index HTML must include #cfg-panel-roles Role Dossier panel');
    assert.ok(htmlText.includes('id="dossier-stage-grid"'), 'Index HTML must include #dossier-stage-grid 3-column character sheet');
    console.log('✓ Cockpit v3.1 Preset Selector, Cache Telemetry & Role Dossier verified.');

    // Test 9: Policy Hub (/api/save-policy-config & /api/run-validation-check)
    console.log('9. Testing Policy Hub (/api/save-policy-config & /api/run-validation-check)...');
    const POLICY_CONFIG_FILE = path.join(tmpConfigDir, 'policy.yaml');
    const originalPolicyYaml = fs.readFileSync(POLICY_CONFIG_FILE, 'utf8');

    try {
      const savePolicyRes = await fetch(`http://127.0.0.1:${testPort}/api/save-policy-config`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Dashboard-Token': DASHBOARD_CSRF_TOKEN
        },
        body: JSON.stringify({
          policy: {
            scope_control: { max_files_per_task: 6 },
            validation: {
              fast_checks: [{ name: 'fast_smoke', run: 'node -v', timeout_sec: 15 }]
            }
          }
        })
      });
      assert.strictEqual(savePolicyRes.status, 200, 'POST /api/save-policy-config must return 200');
      const savePolicyData = await savePolicyRes.json();
      assert.ok(savePolicyData.ok, 'savePolicyData.ok must be true');

      const updatedPolicyYaml = fs.readFileSync(POLICY_CONFIG_FILE, 'utf8');
      assert.ok(updatedPolicyYaml.includes('max_files_per_task: 6'), 'policy.yaml must reflect updated value');
      console.log('✓ policy.yaml successfully updated via /api/save-policy-config.');

      // Test run-validation-check
      const runCheckRes = await fetch(`http://127.0.0.1:${testPort}/api/run-validation-check`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Dashboard-Token': DASHBOARD_CSRF_TOKEN
        },
        body: JSON.stringify({ check_type: 'fast' })
      });
      assert.strictEqual(runCheckRes.status, 200, 'POST /api/run-validation-check must return 200');
      const runCheckData = await runCheckRes.json();
      assert.ok(runCheckData.ok, 'Fast check should pass');
      assert.strictEqual(runCheckData.exit_code, 0);
      console.log(`✓ /api/run-validation-check verified successfully (${runCheckData.duration_ms}ms).`);
    } finally {
      fs.writeFileSync(POLICY_CONFIG_FILE, originalPolicyYaml, 'utf8');
      console.log('✓ Restored original policy.yaml.');
    }

    // Test 10: POST /api/task/retry (CSRF guard + blocked reset + UI Retry contract)
    console.log('10. Testing POST /api/task/retry endpoint & Cockpit Retry button...');
    const STATE_DIR = tmpStateDir;
    const backupFiles = ['task-state.json', 'live-status.json', 'morning-report.md'].map(name => {
      const fp = path.resolve(STATE_DIR, name);
      return {
        fp,
        existed: fs.existsSync(fp),
        content: fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : null
      };
    });
    const retryTaskId = `T-test-retry-${Date.now()}`;
    const retryTaskFile = path.resolve(ACTIVE_DIR, `${retryTaskId}.yaml`);
    fs.mkdirSync(ACTIVE_DIR, { recursive: true });
    fs.writeFileSync(
      retryTaskFile,
      `task:\n  task_id: "${retryTaskId}"\n  title: "Blocked retry test"\n  status: "blocked"\n  failure_class: "review_unavailable"\n  pending_review_patch: "patches/${retryTaskId}/pending-review-attempt-1.patch"\n  block_reason: "dirty ui_web/index.html"\n  scope: ["ui_web/index.html"]\n`,
      'utf8'
    );

    try {
      const manualSnapRes = await fetch(`http://127.0.0.1:${testPort}/api/snapshot`);
      assert.strictEqual(manualSnapRes.status, 200);
      const manualSnapData = await manualSnapRes.json();
      assert.strictEqual(manualSnapData.queue?.manual_review_count, 1, 'HTTP /api/snapshot must include manual_review_count');
      assert.strictEqual(manualSnapData.queue?.manual_review?.[0]?.apply_command, `git apply patches/${retryTaskId}/pending-review-attempt-1.patch`);

      const retryUnauth = await fetch(`http://127.0.0.1:${testPort}/api/task/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: retryTaskId, start_orchestrator: false })
      });
      assert.strictEqual(retryUnauth.status, 403, 'Unauthenticated /api/task/retry must return 403');

      const retryAuth = await fetch(`http://127.0.0.1:${testPort}/api/task/retry`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Dashboard-Token': DASHBOARD_CSRF_TOKEN
        },
        body: JSON.stringify({ task_id: retryTaskId, start_orchestrator: false })
      });
      assert.strictEqual(retryAuth.status, 200, 'Authenticated /api/task/retry must return 200');
      const retryData = await retryAuth.json();
      assert.strictEqual(retryData.ok, true);
      assert.strictEqual(retryData.status, 'ready');
      assert.strictEqual(typeof retryData.queue_stats?.active, 'number');

      const updatedRetryYaml = fs.readFileSync(retryTaskFile, 'utf8');
      assert.ok(updatedRetryYaml.includes('status: ready'), 'Retried task YAML must flip status to ready');
      assert.ok(!updatedRetryYaml.includes('block_reason'), 'Retried task YAML must remove stale block_reason');
      assert.ok(!updatedRetryYaml.includes('failure_class'), 'Retried task YAML must remove stale failure_class');
      assert.ok(!updatedRetryYaml.includes('pending_review_patch'), 'Retried task YAML must remove stale pending_review_patch');
      console.log('✓ /api/task/retry HTTP + CSRF verified.');
    } finally {
      if (fs.existsSync(retryTaskFile)) fs.unlinkSync(retryTaskFile);
      for (const b of backupFiles) {
        if (b.existed) {
          fs.writeFileSync(b.fp, b.content, 'utf8');
        } else if (fs.existsSync(b.fp)) {
          fs.unlinkSync(b.fp);
        }
      }
    }

    // Test 11: UI-1 Hardening (CORS scope, provider round-trip, multi-bucket large raw log, archive detail, /api/stop)
    console.log('11. Testing UI-1 server wiring, CORS, multi-bucket logs, archive detail & /api/stop...');

    // 11a. Localhost CORS gating
    const evilSnapRes = await fetch(`http://127.0.0.1:${testPort}/api/snapshot`, {
      headers: { Origin: 'https://evil.example' }
    });
    assert.strictEqual(evilSnapRes.status, 200);
    assert.strictEqual(
      evilSnapRes.headers.get('access-control-allow-origin'),
      null,
      'GET /api/snapshot must omit Access-Control-Allow-Origin for non-localhost origins'
    );
    const localOrigin = `http://127.0.0.1:${testPort}`;
    const localSnapRes = await fetch(`http://127.0.0.1:${testPort}/api/snapshot`, {
      headers: { Origin: localOrigin }
    });
    assert.strictEqual(localSnapRes.status, 200);
    assert.strictEqual(
      localSnapRes.headers.get('access-control-allow-origin'),
      localOrigin,
      'GET /api/snapshot must echo localhost Access-Control-Allow-Origin'
    );

    // 11b. Custom 9Router provider round-trip (providers.local_9router)
    const TEAM_FILE_UI1 = path.join(tmpConfigDir, 'team.yaml');
    const origTeamYamlUi1 = fs.readFileSync(TEAM_FILE_UI1, 'utf8');
    try {
      const customSaveRes = await fetch(`http://127.0.0.1:${testPort}/api/save-team-config`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Dashboard-Token': DASHBOARD_CSRF_TOKEN
        },
        body: JSON.stringify({
          roles: {
            writer: { model: 'custom/writer-ui1', models: ['custom/writer-ui1'], display_name: 'Writer UI1' }
          },
          provider: {
            base_url: 'http://127.0.0.1:29876/v1',
            default_key: 'sk-custom-ui1'
          }
        })
      });
      assert.strictEqual(customSaveRes.status, 200);

      const customSnapRes = await fetch(`http://127.0.0.1:${testPort}/api/snapshot`);
      assert.strictEqual(customSnapRes.status, 200);
      const customSnap = await customSnapRes.json();
      assert.strictEqual(customSnap.router_provider?.base_url, 'http://127.0.0.1:29876/v1');
      assert.strictEqual(customSnap.router_provider?.default_key, 'sk-custom-ui1');
      assert.strictEqual(customSnap.router_health?.host_label, ':29876');
    } finally {
      fs.writeFileSync(TEAM_FILE_UI1, origTeamYamlUi1, 'utf8');
    }

    // 11c. readLatestRunOutput preserves header metadata & parses multi-bucket header on > 20KB logs
    const multiTaskId = `T-ui1-multibucket-${Date.now()}`;
    const multiRunDir = path.join(tmpStateDir, 'runs', multiTaskId);
    fs.mkdirSync(multiRunDir, { recursive: true });
    const bigLogPath = path.join(multiRunDir, 'attempt-2-b1.txt');
    const bigHeader = [
      '=== WRITER ATTEMPT 2 (BUCKET 1/2) ===',
      'Timestamp: 2026-11-25T17:00:00.000Z',
      'Model Requested: deepseek/custom-writer',
      'Model Responded: deepseek/custom-writer-v4',
      'Finish Reason: stop',
      'Prompt Tokens: 4321',
      'Completion Tokens: 987',
      '',
      'FILE: src/example.js',
      '<<<<<<< SEARCH',
      'oldLine()',
      '=======',
      'newLine()',
      '>>>>>>> REPLACE',
      ''
    ].join('\n');
    const filler = '// padding line for >20KB truncation check\n'.repeat(550);
    fs.writeFileSync(bigLogPath, bigHeader + filler, 'utf8');
    const parsedOut = readLatestRunOutput(multiTaskId, bigLogPath, path.join(tmpStateDir, 'runs'), tmpRoot);
    assert.strictEqual(parsedOut.attempt_number, 2);
    assert.strictEqual(parsedOut.bucket_index, 1);
    assert.strictEqual(parsedOut.bucket_count, 2);
    assert.strictEqual(parsedOut.model_requested, 'deepseek/custom-writer');
    assert.strictEqual(parsedOut.model_responded, 'deepseek/custom-writer-v4');
    assert.strictEqual(parsedOut.finish_reason, 'stop');
    assert.strictEqual(parsedOut.prompt_tokens, 4321);
    assert.strictEqual(parsedOut.completion_tokens, 987);
    assert.strictEqual(parsedOut.truncated, true);

    // 11d. GET /api/task/detail finds tasks in tasks/archive/
    const ARCHIVE_DIR = path.join(tmpTasksDir, 'archive');
    const archTaskId = `T-test-archived-${Date.now()}`;
    const archTaskFile = path.join(ARCHIVE_DIR, `${archTaskId}.yaml`);
    fs.writeFileSync(archTaskFile, `task:\n  task_id: "${archTaskId}"\n  title: "Archived Task"\n  status: "done"\n`, 'utf8');
    try {
      const archRes = await fetch(`http://127.0.0.1:${testPort}/api/task/detail?id=${encodeURIComponent(archTaskId)}`);
      assert.strictEqual(archRes.status, 200, 'Archived task detail must return 200');
      const archJson = await archRes.json();
      assert.strictEqual(archJson.ok, true);
      assert.strictEqual(archJson.archived, true);
      assert.strictEqual(archJson.task?.title, 'Archived Task');
    } finally {
      if (fs.existsSync(archTaskFile)) fs.unlinkSync(archTaskFile);
    }

    // 11e. POST /api/stop terminates running lock PID, removes .orchestrator.lock, and marks live-status inactive
    const sleeperProc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], {
      stdio: 'ignore'
    });
    const orchLockPath = process.env.ORCHESTRATOR_LOCK_FILE;
    const liveStatusPath = path.join(tmpStateDir, 'live-status.json');
    fs.writeFileSync(orchLockPath, JSON.stringify({ pid: sleeperProc.pid, started_at: new Date().toISOString() }), 'utf8');
    fs.writeFileSync(liveStatusPath, JSON.stringify({ active: true, current_stage: 'writer', pid: sleeperProc.pid }), 'utf8');
    try {
      const stopRes = await fetch(`http://127.0.0.1:${testPort}/api/stop`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Dashboard-Token': DASHBOARD_CSRF_TOKEN
        }
      });
      assert.strictEqual(stopRes.status, 200);
      const stopJson = await stopRes.json();
      assert.strictEqual(stopJson.ok, true);
      assert.strictEqual(fs.existsSync(orchLockPath), false, '.orchestrator.lock must be cleaned up after /api/stop');
      const liveAfterStop = JSON.parse(fs.readFileSync(liveStatusPath, 'utf8'));
      assert.strictEqual(liveAfterStop.active, false);
      assert.strictEqual(liveAfterStop.current_stage, 'idle');
    } finally {
      try { if (sleeperProc.exitCode === null) sleeperProc.kill('SIGKILL'); } catch {}
      if (fs.existsSync(orchLockPath)) try { fs.unlinkSync(orchLockPath); } catch {}
    }

    console.log('✓ UI-1 server wiring, CORS, multi-bucket raw output, archive lookup & /api/stop verified.');

    // Test 12: UI-2 Anti-XSS (zero innerHTML), project-neutral UI, WebP role portraits, Architect & multi-check policy save
    console.log('12. Testing UI-2 Anti-XSS, neutrality, WebP assets, Architect surface & policy checks preservation...');
    const appJsSrc = fs.readFileSync(path.join(TEAM_DIR, 'ui', 'js', 'app.js'), 'utf8');
    const apiJsSrc = fs.readFileSync(path.join(TEAM_DIR, 'ui', 'js', 'api.js'), 'utf8');
    assert.strictEqual(/\binnerHTML\b/.test(appJsSrc), false, 'ui/js/app.js must contain ZERO innerHTML assignments');
    assert.strictEqual(/\binnerHTML\b/.test(apiJsSrc), false, 'ui/js/api.js must contain ZERO innerHTML assignments');

    const layoutsDir = path.join(TEAM_DIR, 'ui', 'layouts');
    const layoutTexts = fs.readdirSync(layoutsDir)
      .filter(f => f.endsWith('.html'))
      .map(f => ({ name: f, text: fs.readFileSync(path.join(layoutsDir, f), 'utf8') }));
    const forbiddenLeakRe = /\bPython\b|\bUnittest\b|TAB\s*\(\\t\)|tool-download/i;
    assert.doesNotMatch(appJsSrc, forbiddenLeakRe, 'ui/js/app.js must not leak host-project terms (Python/Unittest/TAB/tool-download)');
    for (const lt of layoutTexts) {
      assert.doesNotMatch(lt.text, forbiddenLeakRe, `ui/layouts/${lt.name} must not leak host-project terms`);
    }

    const rolesImgDir = path.join(TEAM_DIR, 'ui', 'assets', 'roles');
    const expectedWebps = ['router.webp', 'designer.webp', 'writer.webp', 'reviewer.webp', 'gatekeeper.webp'];
    const remainingPngs = fs.readdirSync(rolesImgDir).filter(f => f.toLowerCase().endsWith('.png'));
    assert.deepStrictEqual(remainingPngs, [], 'ui/assets/roles must replace heavy PNGs with compressed WebPs');
    let totalWebpBytes = 0;
    for (const wf of expectedWebps) {
      const wp = path.join(rolesImgDir, wf);
      assert.ok(fs.existsSync(wp), `Expected compressed portrait asset ui/assets/roles/${wf}`);
      totalWebpBytes += fs.statSync(wp).size;
    }
    assert.ok(totalWebpBytes < 500 * 1024, `Compressed role portraits must total < 500KB, got ${totalWebpBytes}B`);

    assert.ok(htmlText.includes('id="squad-row-architect"'), 'Sidebar must include #squad-row-architect');
    assert.ok(htmlText.includes('id="spec-models-summary-bar"'), 'Config modal must include #spec-models-summary-bar');
    assert.ok(htmlText.includes('data-role="architect"'), 'Role dossier tabs must include Architect');
    assert.ok(snapData.spec_models && typeof snapData.spec_models === 'object', 'Snapshot must expose spec_models when configured');

    // Verify save-policy-config preserves empty [] and multi-check arrays cleanly
    const POLICY_FILE_UI2 = path.join(tmpConfigDir, 'policy.yaml');
    const origPolUi2 = fs.readFileSync(POLICY_FILE_UI2, 'utf8');
    try {
      const multiChecks = [
        { name: 'fast_one', run: 'node -v', timeout_sec: 15 },
        { name: 'fast_two', run: 'echo second', timeout_sec: 20 }
      ];
      const saveMultiRes = await fetch(`http://127.0.0.1:${testPort}/api/save-policy-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': DASHBOARD_CSRF_TOKEN },
        body: JSON.stringify({ policy: { validation: { fast_checks: multiChecks, suite_checks: [] } } })
      });
      assert.strictEqual(saveMultiRes.status, 200);
      const parsedMulti = YAML.parse(fs.readFileSync(POLICY_FILE_UI2, 'utf8'));
      assert.strictEqual(parsedMulti.policy.validation.fast_checks.length, 2);
      assert.strictEqual(parsedMulti.policy.validation.fast_checks[1].name, 'fast_two');
      assert.deepStrictEqual(parsedMulti.policy.validation.suite_checks, []);
    } finally {
      fs.writeFileSync(POLICY_FILE_UI2, origPolUi2, 'utf8');
    }

    console.log('✓ UI-2 Anti-XSS, neutrality, WebP portraits, Architect surface & policy checks verified.');

    // Test 13: v3.2.3 Bugs #7 & #8 — awaiting_confirmation snapshot, draft queue isolation, & confirm-merge / discard-branch endpoints
    console.log('13. Testing awaiting_confirmation snapshot, UI guards, and confirm-merge / discard-branch endpoints...');
    assert.ok(htmlText.includes('id="awaiting-confirm-board"'), 'Cockpit HTML must render #awaiting-confirm-board');
    assert.ok(htmlText.includes('id="awaiting-confirm-section"'), 'Sidebar HTML must render #awaiting-confirm-section');
    assert.ok(apiJsSrc.includes('confirmMergeTask') && apiJsSrc.includes('discardBranchTask'), 'api.js must expose confirmMergeTask and discardBranchTask');
    assert.ok(appJsSrc.includes("t.status === 'draft_review' || t.status === 'ready'") && !appJsSrc.includes('const activeIds = new Set((data.queue?.active || []).map(t => t.task_id))'), 'app.js must sync draft board against draft_review/ready only');

    const awaitSnapId = `T-test-await-${Date.now()}`;
    const awaitSnapFile = path.join(ACTIVE_DIR, `${awaitSnapId}.yaml`);
    const awaitLivePath = path.join(tmpStateDir, 'live-status.json');
    const prevLiveText = fs.existsSync(awaitLivePath) ? fs.readFileSync(awaitLivePath, 'utf8') : null;
    fs.writeFileSync(awaitSnapFile, YAML.stringify({
      task: {
        task_id: awaitSnapId,
        title: 'UI branch awaiting confirmation',
        status: 'awaiting_confirmation',
        pending_branch: `ai-task/${awaitSnapId}`,
        base_branch: 'main',
        commit_hash: 'abcdef1234567',
        merge_command: `git merge --no-ff ai-task/${awaitSnapId}`
      }
    }), 'utf8');
    fs.writeFileSync(awaitLivePath, JSON.stringify({ active: false, current_task_id: awaitSnapId, current_stage: 'awaiting_confirmation' }), 'utf8');
    try {
      const awaitSnapRes = await fetch(`http://127.0.0.1:${testPort}/api/snapshot`);
      assert.strictEqual(awaitSnapRes.status, 200);
      const awaitSnapJson = await awaitSnapRes.json();
      assert.strictEqual(awaitSnapJson.queue?.awaiting_confirmation_count, 1, 'Snapshot must count awaiting_confirmation tasks');
      assert.strictEqual(awaitSnapJson.queue?.awaiting_confirmation?.[0]?.pending_branch, `ai-task/${awaitSnapId}`);
      assert.strictEqual(awaitSnapJson.live_status?.task_final_status, 'awaiting_confirmation');
    } finally {
      if (fs.existsSync(awaitSnapFile)) fs.unlinkSync(awaitSnapFile);
      if (prevLiveText !== null) fs.writeFileSync(awaitLivePath, prevLiveText, 'utf8');
      else if (fs.existsSync(awaitLivePath)) fs.unlinkSync(awaitLivePath);
    }

    const tmpGitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'td-cockpit-git-'));
    const gitRepoDir = path.join(tmpGitRoot, 'repo');
    const gitStateDir = path.join(tmpGitRoot, 'state');
    const gitTasksActive = path.join(tmpGitRoot, 'tasks', 'active');
    const gitTasksArchive = path.join(tmpGitRoot, 'tasks', 'archive');
    const gitConfigDir = path.join(tmpGitRoot, 'config');
    fs.mkdirSync(path.join(gitRepoDir, 'web'), { recursive: true });
    fs.mkdirSync(gitStateDir, { recursive: true });
    fs.mkdirSync(gitTasksActive, { recursive: true });
    fs.mkdirSync(gitTasksArchive, { recursive: true });
    fs.mkdirSync(gitConfigDir, { recursive: true });
    fs.copyFileSync(path.resolve(TEAM_DIR, 'config', 'policy.yaml'), path.join(gitConfigDir, 'policy.yaml'));

    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: gitRepoDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: gitRepoDir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: gitRepoDir });
    fs.writeFileSync(path.join(gitRepoDir, 'web', 'index.html'), '<h1>Base</h1>\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: gitRepoDir });
    execFileSync('git', ['commit', '-q', '-m', 'init main'], { cwd: gitRepoDir });

    const mergeTaskId = 'T-cockpit-fe-merge';
    const mergeBranch = `ai-task/${mergeTaskId}`;
    execFileSync('git', ['checkout', '-q', '-b', mergeBranch], { cwd: gitRepoDir });
    fs.writeFileSync(path.join(gitRepoDir, 'web', 'index.html'), '<h1>Gallery Ready</h1>\n', 'utf8');
    execFileSync('git', ['add', 'web/index.html'], { cwd: gitRepoDir });
    execFileSync('git', ['commit', '-q', '-m', '[AI-Task] gallery ui'], { cwd: gitRepoDir });
    const mergeCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gitRepoDir, encoding: 'utf8' }).trim();
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: gitRepoDir });

    const mergeTaskYamlPath = path.join(gitTasksActive, `${mergeTaskId}.yaml`);
    fs.writeFileSync(mergeTaskYamlPath, YAML.stringify({
      task: {
        task_id: mergeTaskId,
        title: 'Build gallery UI',
        status: 'awaiting_confirmation',
        mode: 'standard',
        scope: ['web/index.html'],
        pending_branch: mergeBranch,
        base_branch: 'main',
        commit_hash: mergeCommitSha,
        requires_user_confirmation: true,
        merge_command: `git merge --no-ff ${mergeBranch}`
      }
    }), 'utf8');

    const gitRouteOpts = {
      TEAM_DIR,
      REPO_ROOT: gitRepoDir,
      TASKS_ACTIVE_DIR: gitTasksActive,
      TASKS_ARCHIVE_DIR: gitTasksArchive,
      TASK_STATE_FILE: path.join(gitStateDir, 'task-state.json'),
      LIVE_STATUS_FILE: path.join(gitStateDir, 'live-status.json'),
      REPORT_FILE: path.join(gitStateDir, 'morning-report.md'),
      LOCK_FILE: path.join(tmpGitRoot, '.orchestrator.lock'),
      SESSIONS_DIR: path.join(gitStateDir, 'sessions'),
      snapshotPaths: {
        CONFIG_DIR: gitConfigDir,
        REPO_ROOT: gitRepoDir,
        TASKS_ACTIVE_DIR: gitTasksActive,
        TASKS_ARCHIVE_DIR: gitTasksArchive,
        TASK_STATE_FILE: path.join(gitStateDir, 'task-state.json'),
        LIVE_STATUS_FILE: path.join(gitStateDir, 'live-status.json'),
        TEAM_DIR
      }
    };
    const gitRouteServer = http.createServer(async (req, res) => {
      const reqUrl = new URL(req.url, 'http://127.0.0.1');
      const handled = await handleTasksRoutes(req, res, reqUrl, gitRouteOpts);
      if (!handled) {
        res.writeHead(404);
        res.end('Not Found');
      }
    });
    await new Promise(resolve => gitRouteServer.listen(0, '127.0.0.1', resolve));
    const gitPort = gitRouteServer.address().port;

    try {
      // Unauthenticated request must fail CSRF (403)
      const unauthMerge = await fetch(`http://127.0.0.1:${gitPort}/api/task/confirm-merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: mergeTaskId })
      });
      assert.strictEqual(unauthMerge.status, 403);

      // Checked out on task branch -> confirm-merge & discard-branch must both return 409 safely
      execFileSync('git', ['checkout', '-q', mergeBranch], { cwd: gitRepoDir });
      const selfMergeRes = await fetch(`http://127.0.0.1:${gitPort}/api/task/confirm-merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': DASHBOARD_CSRF_TOKEN },
        body: JSON.stringify({ task_id: mergeTaskId })
      });
      assert.strictEqual(selfMergeRes.status, 409);
      const selfMergeJson = await selfMergeRes.json();
      assert.strictEqual(selfMergeJson.reason, 'on_task_branch_cannot_merge');

      const selfDiscardRes = await fetch(`http://127.0.0.1:${gitPort}/api/task/discard-branch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': DASHBOARD_CSRF_TOKEN },
        body: JSON.stringify({ task_id: mergeTaskId })
      });
      assert.strictEqual(selfDiscardRes.status, 409);
      const selfDiscardJson = await selfDiscardRes.json();
      assert.strictEqual(selfDiscardJson.reason, 'on_task_branch_cannot_discard');

      // Switch back to main -> confirm-merge succeeds, deletes branch, moves YAML to archive
      execFileSync('git', ['checkout', '-q', 'main'], { cwd: gitRepoDir });
      const okMergeRes = await fetch(`http://127.0.0.1:${gitPort}/api/task/confirm-merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': DASHBOARD_CSRF_TOKEN },
        body: JSON.stringify({ task_id: mergeTaskId })
      });
      assert.strictEqual(okMergeRes.status, 200);
      const okMergeJson = await okMergeRes.json();
      assert.strictEqual(okMergeJson.ok, true);
      assert.strictEqual(okMergeJson.status, 'done');
      assert.strictEqual(okMergeJson.branch_deleted, true);
      assert.ok(fs.readFileSync(path.join(gitRepoDir, 'web', 'index.html'), 'utf8').includes('Gallery Ready'));
      assert.strictEqual(fs.existsSync(mergeTaskYamlPath), false, 'Confirmed task YAML must leave tasks/active');
      const archivedYamlPath = path.join(gitTasksArchive, `${mergeTaskId}.yaml`);
      assert.strictEqual(fs.existsSync(archivedYamlPath), true, 'Confirmed task YAML must move to tasks/archive');
      const archivedParsed = YAML.parse(fs.readFileSync(archivedYamlPath, 'utf8'));
      assert.strictEqual(archivedParsed.status, 'done');

      // Discard branch flow -> deletes ai-task/* ref and sets active task status to blocked
      const discardTaskId = 'T-cockpit-fe-discard';
      const discardBranch = `ai-task/${discardTaskId}`;
      execFileSync('git', ['checkout', '-q', '-b', discardBranch], { cwd: gitRepoDir });
      fs.writeFileSync(path.join(gitRepoDir, 'web', 'index.html'), '<h1>Bad UI</h1>\n', 'utf8');
      execFileSync('git', ['add', 'web/index.html'], { cwd: gitRepoDir });
      execFileSync('git', ['commit', '-q', '-m', '[AI-Task] bad ui'], { cwd: gitRepoDir });
      execFileSync('git', ['checkout', '-q', 'main'], { cwd: gitRepoDir });

      const discardYamlPath = path.join(gitTasksActive, `${discardTaskId}.yaml`);
      fs.writeFileSync(discardYamlPath, YAML.stringify({
        task: {
          task_id: discardTaskId,
          title: 'Discardable UI branch',
          status: 'awaiting_confirmation',
          scope: ['web/index.html'],
          pending_branch: discardBranch,
          base_branch: 'main',
          requires_user_confirmation: true
        }
      }), 'utf8');

      const okDiscardRes = await fetch(`http://127.0.0.1:${gitPort}/api/task/discard-branch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': DASHBOARD_CSRF_TOKEN },
        body: JSON.stringify({ task_id: discardTaskId })
      });
      assert.strictEqual(okDiscardRes.status, 200);
      const okDiscardJson = await okDiscardRes.json();
      assert.strictEqual(okDiscardJson.ok, true);
      assert.strictEqual(okDiscardJson.status, 'blocked');
      assert.strictEqual(okDiscardJson.branch_existed, true);
      assert.strictEqual(execFileSync('git', ['branch', '--list', discardBranch], { cwd: gitRepoDir, encoding: 'utf8' }).trim(), '');
      const discardedYaml = YAML.parse(fs.readFileSync(discardYamlPath, 'utf8'));
      assert.strictEqual(discardedYaml.status, 'blocked');
      assert.strictEqual(discardedYaml.pending_branch, undefined);
      assert.ok(fs.readFileSync(path.join(gitRepoDir, 'web', 'index.html'), 'utf8').includes('Gallery Ready'));
    } finally {
      gitRouteServer.close();
      try { fs.rmSync(tmpGitRoot, { recursive: true, force: true }); } catch {}
    }

    console.log('✓ awaiting_confirmation snapshot, draft queue isolation, & confirm-merge / discard-branch endpoints verified.');

    console.log('\n=============================================');
    console.log('ALL COCKPIT & CSRF SECURITY TESTS PASSED! 🎯');
    console.log('=============================================');
  } finally {
    server.close();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
}

runCockpitTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
