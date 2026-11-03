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
