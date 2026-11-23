#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as stateStore from './lib/state-store.mjs';
import * as taskPersistence from './lib/task-persistence.mjs';
import { createSnapshot } from './server/state-reader.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');

function writeWithUtf8Bom(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const bomBuf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text, 'utf8')]);
  fs.writeFileSync(filePath, bomBuf);
}

function assertNoUtf8Bom(filePath, msg) {
  const buf = fs.readFileSync(filePath);
  const hasBom = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
  assert.equal(hasBom, false, msg || `File "${filePath}" must NOT be written with UTF-8 BOM`);
}

async function runTests() {
  console.log('Testing Item 2: UTF-8 BOM stripping on state/YAML readers, BOM-free writes, & fail-loud corrupt guard...\n');

  assert.equal(typeof stateStore.stripUtf8Bom, 'function', 'state-store.mjs must export stripUtf8Bom');
  assert.equal(typeof taskPersistence.loadTaskStateStrict, 'function', 'task-persistence.mjs must export loadTaskStateStrict');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-bom-state-'));
  try {
    // --- 1. state-store.mjs: BOM read succeeds, rewrite has NO BOM, corrupt syntax throws without overwriting ---
    const jsonBomPath = path.join(tmpDir, 'state_dir', 'bom-state.json');
    writeWithUtf8Bom(jsonBomPath, JSON.stringify({
      version: '2.1',
      revision: 3,
      completed_tasks: [{ task_id: 'T-KEEP-HIST', status: 'done' }],
      active_tasks: [],
      blocked_tasks: []
    }, null, 2));

    const loadedBom = stateStore.readVersionedJson(jsonBomPath);
    assert.equal(loadedBom.revision, 3);
    assert.equal(loadedBom.completed_tasks[0].task_id, 'T-KEEP-HIST');

    const mutated = stateStore.mutateVersionedJsonAtomic(jsonBomPath, (d) => {
      d.active_tasks.push({ task_id: 'T-ADDED', status: 'ready' });
      return d;
    });
    assert.equal(mutated.revision, 4);
    assert.equal(mutated.completed_tasks.length, 1);
    assertNoUtf8Bom(jsonBomPath, 'mutateVersionedJsonAtomic must write BOM-free UTF-8');

    // writeFileAtomicRaw must strip BOM even if caller passes string with leading \uFEFF
    const rawBombOut = path.join(tmpDir, 'state_dir', 'raw-no-bom.json');
    stateStore.writeFileAtomicRaw(rawBombOut, '\uFEFF{"ok":true}');
    assertNoUtf8Bom(rawBombOut, 'writeFileAtomicRaw must never emit UTF-8 BOM');

    // Corrupt JSON (even after stripping BOM) MUST throw clearly and NEVER overwrite original file bytes!
    const corruptJsonPath = path.join(tmpDir, 'state_dir', 'corrupt-state.json');
    const corruptPayload = '{ "completed_tasks": [ { "task_id": "DO-NOT-WIPE" ';
    writeWithUtf8Bom(corruptJsonPath, corruptPayload);
    const bytesBefore = fs.readFileSync(corruptJsonPath);

    assert.throws(
      () => stateStore.readVersionedJson(corruptJsonPath),
      /Failed parsing|JSON/i,
      'readVersionedJson must throw loudly on genuine JSON syntax error'
    );
    assert.throws(
      () => stateStore.mutateVersionedJsonAtomic(corruptJsonPath, d => d),
      /Failed parsing|JSON/i,
      'mutateVersionedJsonAtomic must fail loudly without resetting corrupt state'
    );
    assert.deepEqual(
      fs.readFileSync(corruptJsonPath),
      bytesBefore,
      'Corrupt state file MUST NOT be overwritten when read/mutate throws'
    );

    // --- 2. task-persistence.mjs: BOM read + corrupt throw for both JSON state & YAML task ---
    const strictBomJson = path.join(tmpDir, 'state_dir', 'strict-bom.json');
    writeWithUtf8Bom(strictBomJson, JSON.stringify({
      version: '2.1',
      active_tasks: [],
      completed_tasks: [{ task_id: 'T-BOM-OK', status: 'done' }],
      blocked_tasks: []
    }));
    const loadedStrict = taskPersistence.loadTaskStateStrict(strictBomJson);
    assert.equal(loadedStrict.completed_tasks[0].task_id, 'T-BOM-OK');
    assert.throws(
      () => taskPersistence.loadTaskStateStrict(corruptJsonPath),
      /corrupt|invalid|json/i,
      'loadTaskStateStrict must fail loudly on corrupt JSON instead of returning empty state'
    );

    const yamlBomPath = path.join(tmpDir, 'out_tasks', 'T-BOM-YAML.yaml');
    writeWithUtf8Bom(yamlBomPath, 'task:\n  task_id: T-BOM-YAML\n  title: Test BOM YAML\n');
    const parsedYaml = taskPersistence.loadTaskYaml(yamlBomPath);
    assert.equal(parsedYaml?.task?.task_id, 'T-BOM-YAML');
    taskPersistence.saveTaskAtomic(yamlBomPath, parsedYaml);
    assertNoUtf8Bom(yamlBomPath, 'saveTaskAtomic must write YAML without BOM');

    const corruptYamlPath = path.join(tmpDir, 'out_tasks', 'T-CORRUPT.yaml');
    writeWithUtf8Bom(corruptYamlPath, 'task:\n  scope: [unclosed_bracket\n');
    const yamlBytesBefore = fs.readFileSync(corruptYamlPath);
    assert.throws(
      () => taskPersistence.loadTaskYaml(corruptYamlPath),
      /invalid yaml|yaml/i,
      'loadTaskYaml must throw clearly on genuine YAML syntax corruption'
    );
    assert.deepEqual(fs.readFileSync(corruptYamlPath), yamlBytesBefore, 'Corrupt YAML must never be overwritten');

    // --- 3. state-reader.mjs (createSnapshot): handles BOM state cleanly, throws loudly on corrupt task state JSON ---
    const snapRoot = path.join(tmpDir, 'snap');
    const cfgDir = path.join(snapRoot, 'cfg');
    const stDir = path.join(snapRoot, 'st');
    const tActDir = path.join(snapRoot, 't_act');
    const tArcDir = path.join(snapRoot, 't_arc');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.mkdirSync(path.join(stDir, 'runs'), { recursive: true });
    fs.mkdirSync(path.join(stDir, 'sessions'), { recursive: true });
    fs.mkdirSync(tActDir, { recursive: true });
    fs.mkdirSync(tArcDir, { recursive: true });

    fs.writeFileSync(path.join(cfgDir, 'policy.yaml'), 'policy:\n  version: "3.1.0"\n  project_id: "bom-test"\n  scope_control:\n    allowed_dirs: ["web/"]\n', 'utf8');
    fs.writeFileSync(path.join(cfgDir, 'team.yaml'), 'roles:\n  writer:\n    enabled: true\n    model: "mock/w"\n', 'utf8');

    const stFile = path.join(stDir, 'task-state.json');
    const liveFile = path.join(stDir, 'live-status.json');
    writeWithUtf8Bom(stFile, JSON.stringify({
      version: '2.1',
      active_tasks: [],
      completed_tasks: [{ task_id: 'T-SNAP-HIST', title: 'Kept history', status: 'done' }],
      blocked_tasks: [],
      metrics: { total_runs: 1, tasks_completed: 1 }
    }));
    writeWithUtf8Bom(liveFile, JSON.stringify({ active: false, current_stage: 'idle', tokens: { task_input: 123 } }));

    const snapOpts = {
      CONFIG_DIR: cfgDir,
      TEAM_DIR: snapRoot,
      STATE_DIR: stDir,
      TASKS_ACTIVE_DIR: tActDir,
      TASKS_ARCHIVE_DIR: tArcDir,
      LOCK_FILE: path.join(snapRoot, 'orch.lock'),
      COCKPIT_LOCK_FILE: path.join(snapRoot, 'cockpit.lock'),
      LIVE_STATUS_FILE: liveFile,
      TASK_STATE_FILE: stFile,
      RUNS_DIR: path.join(stDir, 'runs'),
      SESSIONS_DIR: path.join(stDir, 'sessions')
    };
    const snapOk = await createSnapshot(snapOpts);
    assert.equal(snapOk.live_status?.tokens?.task_input, 123, 'createSnapshot must parse BOM-prefixed live-status');
    assert.ok(
      snapOk.queue?.recent_completed?.some(t => t.task_id === 'T-SNAP-HIST'),
      'createSnapshot must preserve completed_tasks from BOM-prefixed task-state JSON'
    );

    // Genuine corrupt task-state.json -> createSnapshot MUST throw instead of returning empty task list
    writeWithUtf8Bom(stFile, '{ "completed_tasks": [ broken_json');
    await assert.rejects(
      () => createSnapshot(snapOpts),
      /corrupt|invalid|json/i,
      'createSnapshot must throw loudly when task-state JSON is genuinely corrupt instead of treating it as empty'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Verify orchestrator.mjs loadState refuses silent empty fallback on corrupt state
  const orchSrc = fs.readFileSync(path.join(TEAM_DIR, 'scripts', 'orchestrator.mjs'), 'utf8');
  assert.match(orchSrc, /\bloadTaskStateStrict\b/, 'orchestrator.mjs loadState must use fail-loud loadTaskStateStrict');

  console.log('✓ All Item 2 BOM stripping, BOM-free writes & corrupt-state fail-loud tests passed.');
}

runTests().catch(err => {
  console.error('Item 2 BOM test failed:', err);
  process.exit(1);
});
