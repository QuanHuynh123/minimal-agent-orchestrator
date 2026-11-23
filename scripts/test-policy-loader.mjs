#!/usr/bin/env node
/**
 * TDD Reproduction & Regression Suite for Commit (a):
 *  - loadYamlSafe returns null (never {}) on missing/invalid YAML
 *  - policy.yaml + policy.local.yaml deep-merge (local overrides base)
 *  - Fail-closed when base policy.yaml is missing, unreadable, invalid YAML,
 *    or lacks project_id / scope_control.allowed_dirs (NO fallback to my-workspace / ['*'])
 *  - All callers across agent-team/ audited and consistent
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEAM_DIR = path.resolve(__dirname, '..');

function makeTempConfigDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-team-policy-${name}-`));
  return dir;
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function runNodeWithConfigDir(configDir, code) {
  return spawnSync(
    process.execPath,
    ['--input-type=module', '-e', code],
    {
      cwd: TEAM_DIR,
      env: { ...process.env, AGENT_TEAM_CONFIG_DIR: configDir },
      encoding: 'utf8',
      timeout: 10000
    }
  );
}

console.log('Testing Policy Loader Merge & Fail-Closed Security (Commit a)...');

// ---------------------------------------------------------------------------
// 1. Repro: Shared policy-loader module exists & loadYamlSafe returns null
// ---------------------------------------------------------------------------
let policyLoader = null;
try {
  policyLoader = await import('./lib/policy-loader.mjs');
} catch (err) {
  assert.fail(`policy-loader.mjs missing or failed to load: ${err.message}`);
}

assert.strictEqual(typeof policyLoader.loadYamlSafe, 'function', 'policy-loader must export loadYamlSafe');
assert.strictEqual(typeof policyLoader.loadMergedPolicy, 'function', 'policy-loader must export loadMergedPolicy');
assert.strictEqual(typeof policyLoader.loadMergedTeamConfig, 'function', 'policy-loader must export loadMergedTeamConfig');

{
  const tmp = makeTempConfigDir('safe-null');
  try {
    const missingRes = policyLoader.loadYamlSafe(path.join(tmp, 'does-not-exist.yaml'));
    assert.strictEqual(missingRes, null, 'loadYamlSafe MUST return null (not {}) for missing files');
    assert.ok(!missingRes, 'missing file result must be falsy so || fallback chains work safely');
  } finally {
    cleanupDir(tmp);
  }
}

// ---------------------------------------------------------------------------
// 2. Merge semantics: policy.yaml + policy.local.yaml (local overrides base)
// ---------------------------------------------------------------------------
{
  const tmp = makeTempConfigDir('merge');
  try {
    fs.writeFileSync(
      path.join(tmp, 'policy.yaml'),
      [
        'policy:',
        '  project_id: "base-project"',
        '  scope_control:',
        '    max_files_per_task: 5',
        '    allowed_dirs:',
        '      - "core/"',
        '      - "tests/"',
        '    protected_files:',
        '      - ".env"',
        '  validation:',
        '    fast_checks:',
        '      - run: "echo base-check"',
        '        timeout_sec: 10'
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmp, 'policy.local.yaml'),
      [
        'policy:',
        '  project_id: "local-override-project"',
        '  scope_control:',
        '    allowed_dirs:',
        '      - "ui_web/"'
      ].join('\n'),
      'utf8'
    );

    const merged = policyLoader.loadMergedPolicy({ configDir: tmp });
    assert.strictEqual(merged.policy.project_id, 'local-override-project', 'local policy must override project_id');
    assert.deepStrictEqual(merged.policy.scope_control.allowed_dirs, ['ui_web/'], 'local policy must override allowed_dirs');
    assert.strictEqual(merged.policy.scope_control.max_files_per_task, 5, 'base scalar fields not in local must be preserved');
    assert.deepStrictEqual(merged.policy.scope_control.protected_files, ['.env'], 'base nested arrays not in local must be preserved');
    assert.strictEqual(merged.policy.validation.fast_checks[0].run, 'echo base-check', 'base validation checks must be preserved');
  } finally {
    cleanupDir(tmp);
  }
}

// ---------------------------------------------------------------------------
// 3. Fail-closed: missing/corrupt/incomplete base policy.yaml must THROW
// ---------------------------------------------------------------------------
{
  const tmpMissing = makeTempConfigDir('fail-missing');
  const tmpCorruptBase = makeTempConfigDir('fail-corrupt');
  const tmpCorruptLocal = makeTempConfigDir('fail-corrupt-local');
  const tmpNoAllowed = makeTempConfigDir('fail-no-allowed');
  const tmpNoProjectId = makeTempConfigDir('fail-no-proj');

  try {
    // Missing base even when local exists -> FAIL CLOSED
    fs.writeFileSync(
      path.join(tmpMissing, 'policy.local.yaml'),
      'policy:\n  project_id: "local-only"\n  scope_control:\n    allowed_dirs: ["ui_web/"]\n',
      'utf8'
    );
    assert.throws(
      () => policyLoader.loadMergedPolicy({ configDir: tmpMissing }),
      /policy\.yaml/i,
      'Must fail-closed when base policy.yaml is missing even if policy.local.yaml exists'
    );

    // Corrupt base YAML -> FAIL CLOSED
    fs.writeFileSync(path.join(tmpCorruptBase, 'policy.yaml'), 'policy:\n  project_id: [broken\n', 'utf8');
    assert.throws(
      () => policyLoader.loadMergedPolicy({ configDir: tmpCorruptBase }),
      /policy\.yaml/i,
      'Must fail-closed when base policy.yaml has invalid YAML syntax'
    );

    // Corrupt local YAML -> FAIL CLOSED (never silently ignore broken local override)
    fs.writeFileSync(
      path.join(tmpCorruptLocal, 'policy.yaml'),
      'policy:\n  project_id: "ok"\n  scope_control:\n    allowed_dirs: ["core/"]\n',
      'utf8'
    );
    fs.writeFileSync(path.join(tmpCorruptLocal, 'policy.local.yaml'), 'policy:\n  project_id: [broken\n', 'utf8');
    assert.throws(
      () => policyLoader.loadMergedPolicy({ configDir: tmpCorruptLocal }),
      /policy\.local\.yaml/i,
      'Must fail-closed when policy.local.yaml exists with invalid YAML syntax'
    );

    // Empty/missing allowed_dirs -> FAIL CLOSED (no fallback to ['*'] or auto-scan)
    fs.writeFileSync(
      path.join(tmpNoAllowed, 'policy.yaml'),
      'policy:\n  project_id: "ok"\n  scope_control:\n    allowed_dirs: []\n',
      'utf8'
    );
    assert.throws(
      () => policyLoader.loadMergedPolicy({ configDir: tmpNoAllowed }),
      /allowed_dirs/i,
      'Must fail-closed when policy.scope_control.allowed_dirs is missing or empty'
    );

    // Missing project_id -> FAIL CLOSED (no fallback to "my-workspace")
    fs.writeFileSync(
      path.join(tmpNoProjectId, 'policy.yaml'),
      'policy:\n  scope_control:\n    allowed_dirs: ["core/"]\n',
      'utf8'
    );
    assert.throws(
      () => policyLoader.loadMergedPolicy({ configDir: tmpNoProjectId }),
      /project_id/i,
      'Must fail-closed when policy.project_id is missing'
    );
  } finally {
    cleanupDir(tmpMissing);
    cleanupDir(tmpCorruptBase);
    cleanupDir(tmpCorruptLocal);
    cleanupDir(tmpNoAllowed);
    cleanupDir(tmpNoProjectId);
  }
}

// ---------------------------------------------------------------------------
// 4. Caller Audit: EVERY consumer merges base+local and fails closed
// ---------------------------------------------------------------------------
{
  const tmpMerged = makeTempConfigDir('caller-merged');
  const tmpBroken = makeTempConfigDir('caller-broken');
  try {
    fs.writeFileSync(
      path.join(tmpMerged, 'policy.yaml'),
      [
        'policy:',
        '  project_id: "base-proj"',
        '  scope_control:',
        '    max_files_per_task: 5',
        '    allowed_dirs: ["core/", "tests/"]',
        '    protected_files: ["agent-team/config/policy.yaml"]',
        '  validation:',
        '    fast_checks:',
        '      - run: "node -e \\"console.log(42)\\""',
        '        timeout_sec: 10'
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpMerged, 'policy.local.yaml'),
      [
        'policy:',
        '  project_id: "local-proj"',
        '  scope_control:',
        '    allowed_dirs: ["ui_web/"]'
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpMerged, 'team.yaml'),
      'roles:\n  router:\n    model: "base-model"\n  writer:\n    model: "base-writer"\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpMerged, 'team.local.yaml'),
      'roles:\n  router:\n    model: "local-model"\n',
      'utf8'
    );

    // Broken config dir: corrupt base policy.yaml
    fs.writeFileSync(path.join(tmpBroken, 'policy.yaml'), 'policy:\n  project_id: [broken\n', 'utf8');
    fs.writeFileSync(path.join(tmpBroken, 'team.yaml'), 'roles:\n  router:\n    model: "m"\n', 'utf8');

    // 4a. goal-planner.mjs: fails closed when base policy.yaml missing/corrupt (never falls back to my-workspace / [*])
    const gpBroken = runNodeWithConfigDir(
      tmpBroken,
      'import { decomposeGoal } from "./scripts/goal-planner.mjs"; await decomposeGoal("test fail-closed", { configDir: process.env.AGENT_TEAM_CONFIG_DIR });'
    );
    assert.notStrictEqual(gpBroken.status, 0, 'goal-planner must fail non-zero when base policy.yaml is broken');
    assert.ok(
      !/my-workspace/.test(gpBroken.stderr + gpBroken.stdout),
      'goal-planner must NOT fall back to my-workspace when policy.yaml fails'
    );

    // 4b. validator.mjs: loadPolicyConfig merges base + local, fails closed on corrupt policy.yaml
    const valMerged = runNodeWithConfigDir(
      tmpMerged,
      'import { loadPolicyConfig } from "./scripts/validator.mjs"; const p = loadPolicyConfig(); console.log(JSON.stringify(p));'
    );
    assert.strictEqual(valMerged.status, 0, `validator loadPolicyConfig merged failed: ${valMerged.stderr}`);
    const valParsed = JSON.parse(valMerged.stdout.trim());
    assert.strictEqual(valParsed.policy.project_id, 'local-proj', 'validator must apply local project_id override');
    assert.deepStrictEqual(valParsed.policy.scope_control.allowed_dirs, ['ui_web/'], 'validator must apply local allowed_dirs override');
    assert.deepStrictEqual(valParsed.policy.scope_control.protected_files, ['agent-team/config/policy.yaml'], 'validator must keep base protected_files');

    const valBroken = runNodeWithConfigDir(
      tmpBroken,
      'import { loadPolicyConfig } from "./scripts/validator.mjs"; loadPolicyConfig();'
    );
    assert.notStrictEqual(valBroken.status, 0, 'validator loadPolicyConfig must fail-closed on broken base policy.yaml');

    // 4c. applier.mjs: resolveRepoRoot must fail-closed on corrupt policy.yaml
    const appBroken = runNodeWithConfigDir(
      tmpBroken,
      'import { resolveRepoRoot } from "./scripts/applier.mjs"; resolveRepoRoot();'
    );
    assert.notStrictEqual(appBroken.status, 0, 'applier resolveRepoRoot must fail-closed on corrupt base policy.yaml');

    // 4d. orchestrator.mjs: must refuse to start (non-zero exit) on corrupt policy.yaml
    const orchBroken = runNodeWithConfigDir(
      tmpBroken,
      'await import("./scripts/orchestrator.mjs");'
    );
    assert.notStrictEqual(orchBroken.status, 0, 'orchestrator must refuse to run when base policy.yaml is corrupt');

    // 4e. runtime/tool-runtime.mjs: merges base + local and fails closed on corrupt base policy.yaml
    const rtToolMerged = runNodeWithConfigDir(
      tmpMerged,
      'import { loadRuntimeScopePolicy } from "./runtime/tool-runtime.mjs"; console.log(JSON.stringify(loadRuntimeScopePolicy()));'
    );
    assert.strictEqual(rtToolMerged.status, 0, `tool-runtime loadRuntimeScopePolicy failed: ${rtToolMerged.stderr}`);
    const rtToolParsed = JSON.parse(rtToolMerged.stdout.trim());
    assert.deepStrictEqual(rtToolParsed.allowedDirs, ['ui_web/'], 'tool-runtime must merge local allowedDirs');
    assert.deepStrictEqual(rtToolParsed.protectedFiles, ['agent-team/config/policy.yaml'], 'tool-runtime must retain base protectedFiles');

    const rtToolBroken = runNodeWithConfigDir(
      tmpBroken,
      'import { loadRuntimeScopePolicy } from "./runtime/tool-runtime.mjs"; loadRuntimeScopePolicy();'
    );
    assert.notStrictEqual(rtToolBroken.status, 0, 'tool-runtime must fail-closed on corrupt base policy.yaml');

    // 4f. runtime/index.mjs: loadRoleConfig merges team + team.local and loads merged policy scope (fails closed if broken)
    const rtIdxMerged = runNodeWithConfigDir(
      tmpMerged,
      'import { loadRoleConfig } from "./runtime/index.mjs"; console.log(JSON.stringify(loadRoleConfig("router")));'
    );
    assert.strictEqual(rtIdxMerged.status, 0, `runtime/index loadRoleConfig failed: ${rtIdxMerged.stderr}`);
    const rtIdxParsed = JSON.parse(rtIdxMerged.stdout.trim());
    assert.strictEqual(rtIdxParsed.model, 'local-model', 'runtime/index must merge team.local.yaml over team.yaml');

    const rtIdxBroken = runNodeWithConfigDir(
      tmpBroken,
      'import { runAgent } from "./runtime/index.mjs"; await runAgent({ role: "router", goal: "test", configDir: process.env.AGENT_TEAM_CONFIG_DIR });'
    );
    assert.notStrictEqual(rtIdxBroken.status, 0, 'runtime/index runAgent must fail-closed on broken base policy.yaml');

    // 4g. server/state-reader.mjs: merges policy + policy.local and team + team.local
    const srCheck = runNodeWithConfigDir(
      tmpMerged,
      [
        'import fs from "node:fs"; import os from "node:os"; import path from "node:path";',
        'import { createSnapshot } from "./scripts/server/state-reader.mjs";',
        'const fakeTeam = fs.mkdtempSync(path.join(os.tmpdir(), "sr-team-"));',
        'fs.mkdirSync(path.join(fakeTeam, "config"), { recursive: true });',
        'fs.mkdirSync(path.join(fakeTeam, "state"), { recursive: true });',
        'fs.mkdirSync(path.join(fakeTeam, "tasks/active"), { recursive: true });',
        'fs.mkdirSync(path.join(fakeTeam, "tasks/archive"), { recursive: true });',
        'fs.cpSync(process.env.AGENT_TEAM_CONFIG_DIR, path.join(fakeTeam, "config"), { recursive: true });',
        'const snap = await createSnapshot({ TEAM_DIR: fakeTeam, TASKS_ACTIVE_DIR: path.join(fakeTeam, "tasks/active"), TASKS_ARCHIVE_DIR: path.join(fakeTeam, "tasks/archive"), LIVE_STATUS_FILE: path.join(fakeTeam, "state/live-status.json"), TASK_STATE_FILE: path.join(fakeTeam, "state/task-state.json"), LOCK_FILE: path.join(fakeTeam, ".orchestrator.lock"), CONFIG_DIR: path.join(fakeTeam, "config"), RUNS_DIR: path.join(fakeTeam, "state/runs"), SESSIONS_DIR: path.join(fakeTeam, "state/sessions") });',
        'console.log(JSON.stringify({ project_id: snap.policy.project_id, allowed_dirs: snap.project.allowed_dirs, protected_files: snap.policy.scope_control.protected_files, router_model: snap.roles?.router?.model, writer_model: snap.roles?.writer?.model }));',
        'fs.rmSync(fakeTeam, { recursive: true, force: true });'
      ].join(' ')
    );
    assert.strictEqual(srCheck.status, 0, `state-reader createSnapshot failed: ${srCheck.stderr}`);
    const srParsed = JSON.parse(srCheck.stdout.trim());
    assert.strictEqual(srParsed.project_id, 'local-proj', 'state-reader must merge policy.local.yaml project_id');
    assert.deepStrictEqual(srParsed.allowed_dirs, ['ui_web/'], 'state-reader must merge policy.local.yaml allowed_dirs');
    assert.deepStrictEqual(srParsed.protected_files, ['agent-team/config/policy.yaml'], 'state-reader must preserve base protected_files');
    assert.strictEqual(srParsed.router_model, 'local-model', 'state-reader must apply team.local.yaml override');
    assert.strictEqual(srParsed.writer_model, 'base-writer', 'state-reader must preserve base team.yaml roles');

    const srBroken = runNodeWithConfigDir(
      tmpBroken,
      'import { createSnapshot } from "./scripts/server/state-reader.mjs"; await createSnapshot({ CONFIG_DIR: process.env.AGENT_TEAM_CONFIG_DIR, TASKS_ACTIVE_DIR: process.env.AGENT_TEAM_CONFIG_DIR, TASKS_ARCHIVE_DIR: process.env.AGENT_TEAM_CONFIG_DIR, LIVE_STATUS_FILE: process.env.AGENT_TEAM_CONFIG_DIR + "/missing.json", TASK_STATE_FILE: process.env.AGENT_TEAM_CONFIG_DIR + "/missing2.json", LOCK_FILE: process.env.AGENT_TEAM_CONFIG_DIR + "/missing.lock", RUNS_DIR: process.env.AGENT_TEAM_CONFIG_DIR, SESSIONS_DIR: process.env.AGENT_TEAM_CONFIG_DIR, TEAM_DIR: process.env.AGENT_TEAM_CONFIG_DIR });'
    );
    assert.notStrictEqual(srBroken.status, 0, 'state-reader createSnapshot must fail-closed on corrupt base policy.yaml (never fall back to workspace / [*])');

    // 4h. goal-planner.mjs resolveGoalPlannerConfig: works with base-only (no policy.local.yaml) AND merged local override
    const tmpBaseOnly = makeTempConfigDir('caller-base-only');
    try {
      fs.writeFileSync(
        path.join(tmpBaseOnly, 'policy.yaml'),
        'policy:\n  project_id: "only-base-proj"\n  scope_control:\n    allowed_dirs: ["core/"]\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(tmpBaseOnly, 'team.yaml'),
        'roles:\n  router:\n    model: "base-router"\n',
        'utf8'
      );
      const gpBaseOnly = runNodeWithConfigDir(
        tmpBaseOnly,
        'import { resolveGoalPlannerConfig } from "./scripts/goal-planner.mjs"; const c = resolveGoalPlannerConfig(); console.log(JSON.stringify({ projectId: c.projectId, allowedDirs: c.allowedDirs }));'
      );
      assert.strictEqual(gpBaseOnly.status, 0, `goal-planner base-only failed: ${gpBaseOnly.stderr}`);
      const gpBaseParsed = JSON.parse(gpBaseOnly.stdout.trim());
      assert.strictEqual(gpBaseParsed.projectId, 'only-base-proj');
      assert.deepStrictEqual(gpBaseParsed.allowedDirs, ['core/']);

      const gpMerged = runNodeWithConfigDir(
        tmpMerged,
        'import { resolveGoalPlannerConfig } from "./scripts/goal-planner.mjs"; const c = resolveGoalPlannerConfig(); console.log(JSON.stringify({ projectId: c.projectId, allowedDirs: c.allowedDirs, routerModel: c.teamConfig.roles?.router?.model }));'
      );
      assert.strictEqual(gpMerged.status, 0, `goal-planner merged failed: ${gpMerged.stderr}`);
      const gpMergedParsed = JSON.parse(gpMerged.stdout.trim());
      assert.strictEqual(gpMergedParsed.projectId, 'local-proj');
      assert.deepStrictEqual(gpMergedParsed.allowedDirs, ['ui_web/']);
      assert.strictEqual(gpMergedParsed.routerModel, 'local-model');
    } finally {
      cleanupDir(tmpBaseOnly);
    }

    // 4i. routes-models.mjs & routes-tasks.mjs: fail-closed when base policy.yaml becomes corrupt after startup
    const routesBrokenCheck = runNodeWithConfigDir(
      tmpMerged,
      [
        'import { EventEmitter } from "node:events";',
        'import { DASHBOARD_CSRF_TOKEN } from "./scripts/server/security.mjs";',
        'import { handleModelsRoutes } from "./scripts/server/routes-models.mjs";',
        'import { handleTasksRoutes } from "./scripts/server/routes-tasks.mjs";',
        'function mkReq(method, bodyObj) { const e = new EventEmitter(); e.method = method; e.headers = { host: "127.0.0.1:3030", "x-dashboard-token": DASHBOARD_CSRF_TOKEN }; process.nextTick(() => { if (bodyObj !== undefined) e.emit("data", Buffer.from(JSON.stringify(bodyObj))); e.emit("end"); }); return e; }',
        'function mkRes() { const r = { status: 200, body: "", writeHead(s){ this.status = s; }, end(b){ this.body = b; } }; return r; }',
        `const brokenDir = ${JSON.stringify(tmpBroken)};`,
        'const brokenPolicy = brokenDir + "/policy.yaml";',
        'const brokenTeam = brokenDir + "/team.yaml";',
        'const resVal = mkRes();',
        'await handleModelsRoutes(mkReq("POST", { check_type: "fast" }), resVal, new URL("http://127.0.0.1:3030/api/run-validation-check"), { POLICY_CONFIG_FILE: brokenPolicy, TEAM_CONFIG_FILE: brokenTeam });',
        'const resApprove = mkRes();',
        'await handleTasksRoutes(mkReq("POST", {}), resApprove, new URL("http://127.0.0.1:3030/api/approve-run"), { TEAM_DIR: brokenDir, snapshotPaths: { CONFIG_DIR: brokenDir } });',
        'console.log(JSON.stringify({ valStatus: resVal.status, valOk: JSON.parse(resVal.body).ok, appStatus: resApprove.status, appOk: JSON.parse(resApprove.body).ok }));'
      ].join(' ')
    );
    assert.strictEqual(routesBrokenCheck.status, 0, `routes check crashed: ${routesBrokenCheck.stderr}`);
    const routesRes = JSON.parse(routesBrokenCheck.stdout.trim());
    assert.strictEqual(routesRes.valStatus, 500, 'routes-models /api/run-validation-check must return 500 on corrupt policy.yaml');
    assert.strictEqual(routesRes.valOk, false);
    assert.strictEqual(routesRes.appStatus, 500, 'routes-tasks /api/approve-run must return 500 on corrupt policy.yaml');
    assert.strictEqual(routesRes.appOk, false);
  } finally {
    cleanupDir(tmpMerged);
    cleanupDir(tmpBroken);
  }
}

console.log('✓ ALL Policy Loader & Fail-Closed Caller Audit tests passed!');
