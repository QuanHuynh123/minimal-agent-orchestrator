import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { handleModelsRoutes } from './server/routes-models.mjs';
import { DASHBOARD_CSRF_TOKEN } from './server/security.mjs';
import { createSnapshot } from './server/state-reader.mjs';
import { loadMergedTeamConfig } from './lib/policy-loader.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');

function makeJsonPostReq(payload, csrf = DASHBOARD_CSRF_TOKEN) {
  const req = Readable.from([Buffer.from(JSON.stringify(payload), 'utf8')]);
  req.method = 'POST';
  req.headers = {
    host: '127.0.0.1:4322',
    origin: 'http://127.0.0.1:4322',
    'x-dashboard-token': csrf,
    'content-type': 'application/json'
  };
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

function makeMockRes() {
  let status = 200;
  let body = '';
  return {
    writeHead(code) { status = code; },
    end(chunk) { body += String(chunk || ''); },
    parse() { return { status, json: JSON.parse(body || '{}') }; }
  };
}

async function runTests() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-cockpit-obj-models-'));
  try {
    const cfgDir = path.join(tmpDir, 'config');
    const stateDir = path.join(tmpDir, 'state');
    const tasksDir = path.join(tmpDir, 'tasks');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(path.join(tasksDir, 'active'), { recursive: true });
    fs.mkdirSync(path.join(tasksDir, 'archive'), { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'policy.yaml'), 'policy:\n  version: "3.1.0"\n  project_id: "cockpit-obj-test"\n  scope_control:\n    allowed_dirs: ["core/"]\n', 'utf8');

    const teamFile = path.join(cfgDir, 'team.yaml');
    fs.writeFileSync(teamFile, [
      'providers:',
      '  local_9router:',
      '    base_url: "http://127.0.0.1:29999/v1"',
      '    default_key: "sk-test"',
      'unknown_top_level_flag: "preserve-me"',
      'roles:',
      '  writer:',
      '    enabled: true',
      '    model: "custom/writer-a"',
      '    models:',
      '      - id: "custom/writer-a"',
      '        note: "primary obj"',
      '      - model: "custom/writer-b"',
      '        tier: "fallback"',
      '      - id: "custom/writer-dead"',
      '        disabled: true',
      '        reason: "HTTP 400"',
      '  reviewer:',
      '    enabled: true',
      '    models:',
      '      - id: "custom/reviewer-a"'
    ].join('\n'), 'utf8');

    // 1. Read path: createSnapshot & /api/models work without crash on object entries in models[]
    const snapBefore = await createSnapshot({
      CONFIG_DIR: cfgDir,
      TEAM_DIR: tmpDir,
      STATE_DIR: stateDir,
      TASKS_ACTIVE_DIR: path.join(tasksDir, 'active'),
      TASKS_ARCHIVE_DIR: path.join(tasksDir, 'archive'),
      LOCK_FILE: path.join(tmpDir, '.orchestrator.lock'),
      COCKPIT_LOCK_FILE: path.join(tmpDir, '.cockpit.lock'),
      LIVE_STATUS_FILE: path.join(stateDir, 'live-status.json'),
      TASK_STATE_FILE: path.join(stateDir, 'task-state.json'),
      RUNS_DIR: path.join(stateDir, 'runs'),
      SESSIONS_DIR: path.join(stateDir, 'sessions')
    });
    assert.ok(snapBefore.roles?.writer, 'Snapshot must load writer role when models[] contains objects');
    assert.ok(snapBefore.roster_models.some(m => m.model === 'custom/writer-a'));
    assert.ok(snapBefore.roster_models.some(m => m.model === 'custom/writer-b'));
    assert.ok(!snapBefore.roster_models.some(m => m.model === 'custom/writer-dead'), 'Disabled object entry must be excluded from active roster');

    // 2. Write path A: POST /api/save-team-config with object entries in roles.writer.models[]
    //    Chosen strategy: normalize to pure string array + return explicit warnings (+ preserve disabled entries in disabled_models)
    const resObjPayload = makeMockRes();
    await handleModelsRoutes(
      makeJsonPostReq({
        roles: {
          writer: {
            model: '',
            models: [
              { id: 'custom/writer-a', label: 'Primary' },
              { model: 'custom/writer-b' },
              { id: 'custom/writer-dead', disabled: true, reason: 'HTTP 400' }
            ],
            display_name: 'Writer Squad'
          },
          reviewer: {
            model: 'custom/reviewer-a',
            models: [{ id: 'custom/reviewer-a' }],
            display_name: 'Reviewer'
          }
        },
        provider: {
          base_url: 'http://127.0.0.1:29999/v1',
          default_key: 'sk-test'
        }
      }),
      resObjPayload,
      new URL('http://127.0.0.1:4322/api/save-team-config'),
      {
        DASHBOARD_CSRF_TOKEN: 'tok-item6',
        PORT: 4322,
        TEAM_CONFIG_FILE: teamFile
      }
    );

    const parsedA = resObjPayload.parse();
    assert.equal(parsedA.status, 200);
    assert.equal(parsedA.json.ok, true);
    assert.ok(
      Array.isArray(parsedA.json.warnings) && parsedA.json.warnings.length >= 2,
      `Expected warnings when normalizing object entries in models[], got: ${JSON.stringify(parsedA.json)}`
    );
    assert.ok(
      parsedA.json.warnings.some(w => /normaliz|object/i.test(w) && /writer/i.test(w)),
      `Expected writer normalization warning, got: ${JSON.stringify(parsedA.json.warnings)}`
    );

    const savedDiskA = YAML.parse(fs.readFileSync(teamFile, 'utf8'));
    assert.equal(savedDiskA.unknown_top_level_flag, 'preserve-me', 'Unknown keys must stay intact after normalizing models[]');
    assert.deepEqual(
      savedDiskA.roles.writer.models,
      ['custom/writer-a', 'custom/writer-b'],
      'Normalized writer.models[] must be pure active strings'
    );
    assert.equal(typeof savedDiskA.roles.writer.model, 'string');
    assert.equal(savedDiskA.roles.writer.model, 'custom/writer-a');
    assert.equal(savedDiskA.roles.writer.default_model, 'custom/writer-a');
    assert.equal(savedDiskA.roles.writer.fallback_model, 'custom/writer-b');
    assert.ok(
      Array.isArray(savedDiskA.roles.writer.disabled_models)
        && savedDiskA.roles.writer.disabled_models.some(d => (typeof d === 'string' ? d : d?.id) === 'custom/writer-dead'),
      'Disabled object entry from models[] must be retained in disabled_models rather than reactivated or silently dropped'
    );
    assert.deepEqual(savedDiskA.roles.reviewer.models, ['custom/reviewer-a']);

    // 3. Write path B: Simulated Cockpit UI round-trip when disk team.yaml already has object entries in models[]
    fs.writeFileSync(teamFile, [
      'providers:',
      '  local_9router:',
      '    base_url: "http://127.0.0.1:29999/v1"',
      '    default_key: "sk-test"',
      'roles:',
      '  writer:',
      '    enabled: true',
      '    model: "custom/writer-a"',
      '    models:',
      '      - id: "custom/writer-a"',
      '        custom_tag: "from-disk"',
      '      - id: "custom/writer-disk-disabled"',
      '        disabled: true',
      '        reason: "dead-on-disk"'
    ].join('\n'), 'utf8');

    const resDiskUiSave = makeMockRes();
    await handleModelsRoutes(
      makeJsonPostReq({
        roles: {
          writer: {
            model: 'custom/writer-a',
            models: ['custom/writer-a'],
            display_name: 'Writer Squad'
          }
        },
        provider: { base_url: 'http://127.0.0.1:29999/v1', default_key: 'sk-test' }
      }),
      resDiskUiSave,
      new URL('http://127.0.0.1:4322/api/save-team-config'),
      {
        DASHBOARD_CSRF_TOKEN: 'tok-item6',
        PORT: 4322,
        TEAM_CONFIG_FILE: teamFile
      }
    );
    const parsedB = resDiskUiSave.parse();
    assert.equal(parsedB.status, 200);
    assert.equal(parsedB.json.ok, true);
    assert.ok(
      Array.isArray(parsedB.json.warnings) && parsedB.json.warnings.some(w => /normaliz|object/i.test(w)),
      `Expected warning when saving over disk object models[], got: ${JSON.stringify(parsedB.json)}`
    );

    const savedDiskB = loadMergedTeamConfig({ configDir: cfgDir });
    assert.deepEqual(savedDiskB.roles.writer.models, ['custom/writer-a']);
    assert.ok(
      Array.isArray(savedDiskB.roles.writer.disabled_models)
        && savedDiskB.roles.writer.disabled_models.some(d => (typeof d === 'string' ? d : d?.id) === 'custom/writer-disk-disabled'),
      'Pre-existing disabled object entry in disk models[] must be preserved in disabled_models on Cockpit save'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // 4. Verify Cockpit frontend app.js surfaces backend warnings when saving team config
  const appJs = fs.readFileSync(path.join(TEAM_DIR, 'ui', 'js', 'app.js'), 'utf8');
  assert.ok(
    appJs.includes('data.warnings'),
    'app.js must surface data.warnings returned by /api/save-team-config'
  );

  console.log('[PASS] test-cockpit-models-roundtrip');
}

runTests().catch((err) => {
  console.error('[FAIL] test-cockpit-models-roundtrip:', err);
  process.exit(1);
});
