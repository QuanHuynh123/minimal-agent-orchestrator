#!/usr/bin/env node
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer, server, DASHBOARD_CSRF_TOKEN } from './dashboard.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');
const ACTIVE_DIR = path.resolve(TEAM_DIR, 'tasks', 'active');

async function runCockpitTests() {
  console.log('Testing Interactive Goal Cockpit & CSRF Security...\n');

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
        body: JSON.stringify({ task_ids: [dummyTaskId] })
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
    const TEAM_CONFIG_FILE = path.resolve(TEAM_DIR, 'config', 'team.yaml');
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

    console.log('\n=============================================');
    console.log('ALL COCKPIT & CSRF SECURITY TESTS PASSED! 🎯');
    console.log('=============================================');
  } finally {
    server.close();
  }
}

runCockpitTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
