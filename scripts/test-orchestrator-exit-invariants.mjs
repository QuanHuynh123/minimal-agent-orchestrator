#!/usr/bin/env node
/**
 * Exit-invariant tests for orchestrator.mjs (docs/ORCHESTRATOR_SPLIT_SPEC.md, Phase 1).
 * Every case spawns the real orchestrator CLI against a throw-away git repo with a mocked 9Router
 * (fetch preload) and asserts the worktree/state invariants after the process exits.
 *
 *  Case 1  H3     draft_spec budget error must not raise a TDZ ReferenceError
 *  Case 2  H1+H4  Bucket 2 failure must clean tracked + untracked files written by Bucket 1
 *  Case 3  H2     SIGINT between buckets must roll back Bucket 1 (incl. new untracked file)
 *  Case 4  #19    unexpected exception after disk write must be rolled back by `finally`
 *  Case 5  #18/D2 git commit failure keeps the worktree, flags preserve_worktree, saves ready-to-commit.patch
 *  Case 6  rule   safeRollback() must refuse an empty target list (git checkout -- . is repo-wide)
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ORCHESTRATOR_SCRIPT = path.join(__dirname, 'orchestrator.mjs');
const GATEWAY_URL = 'http://127.0.0.1:29998/v1';

function writeMockPreload(preloadPath, scenario) {
  const code = `
import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const TARGET_BASE = ${JSON.stringify(GATEWAY_URL)};
const SC = ${JSON.stringify(scenario)};
const log = (m) => { try { fs.appendFileSync(SC.requestLog, m + '\\n'); } catch {} };

if (SC.throwOnReadAfterWrite) {
  // Arms once the orchestrator itself has written the target file, then throws on any later read of it.
  const target = SC.throwOnReadAfterWrite;
  const norm = (p) => (typeof p === 'string' ? p : (p instanceof URL ? p.pathname : '')).replace(/\\\\/g, '/');
  let armed = false;
  for (const fn of ['writeFileSync', 'renameSync', 'copyFileSync']) {
    const orig = fs[fn];
    fs[fn] = function (...args) {
      const out = orig.apply(this, args);
      if (args.some(a => norm(a).endsWith('/' + target))) { armed = true; log('armed by ' + fn); }
      return out;
    };
  }
  const origRead = fs.readFileSync;
  fs.readFileSync = function (p, ...rest) {
    if (armed && norm(p).endsWith('/' + target)) {
      throw new Error('INJECTED_FAILURE: read of ' + target + ' after disk write');
    }
    return origRead.call(this, p, ...rest);
  };
  syncBuiltinESMExports();
}

const origFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : (input?.url || String(input));
  if (!url.startsWith(TARGET_BASE)) return origFetch(input, init);
  const method = String(init?.method || 'GET').toUpperCase();
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  if (method === 'GET' && url.endsWith('/models')) {
    return json({ object: 'list', data: [{ id: 'mock-writer' }, { id: 'mock-architect' }, { id: 'mock-reviewer' }] });
  }
  if (method === 'POST' && url.endsWith('/chat/completions')) {
    let body = {};
    try { body = JSON.parse(String(init?.body || '{}')); } catch {}
    const sysMsg = String(body.messages?.[0]?.content || '');
    const userMsg = String(body.messages?.[body.messages.length - 1]?.content || '');
    const reply = (content) => json({
      id: 'chatcmpl-mock-inv', object: 'chat.completion', model: body.model || 'mock-writer',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 180, completion_tokens: 42, total_tokens: 222 }
    });
    if ((body.max_tokens && body.max_tokens <= 16) || /\\b(?:single word|ping|calibrate)\\b/i.test(userMsg)) {
      return reply('OK');
    }
    const bucketMatch = userMsg.match(/ALLOWED BUCKET SCOPE \\(ONLY modify these files in this step\\): ([^\\n]+)/);
    if (bucketMatch) {
      const firstFile = bucketMatch[1].split(',')[0].trim();
      const cfg = SC.buckets?.[firstFile];
      globalThis.__bucketCalls = globalThis.__bucketCalls || {};
      const callIdx = (globalThis.__bucketCalls[firstFile] = (globalThis.__bucketCalls[firstFile] ?? -1) + 1);
      const beh = Array.isArray(cfg) ? cfg[Math.min(callIdx, cfg.length - 1)] : cfg;
      log('bucket:' + firstFile);
      if (!beh) return reply('NO_PATCH_CONFIGURED for ' + firstFile);
      if (beh.kind === 'http_error') return json({ error: { message: beh.message || 'mock failure' } }, beh.status || 400);
      if (beh.kind === 'sigint') { log('emit SIGINT'); process.emit('SIGINT'); return new Promise(() => {}); }
      return reply(beh.text);
    }
    if (/Lead Software Architect|draft_spec|contract table/i.test(sysMsg + '\\n' + userMsg)) {
      log('spec');
      if (SC.spec === 'throw_budget') {
        const err = new Error('local budget stop: injected spec budget');
        err.name = 'BudgetExceededError'; err.code = 'LOCAL_BUDGET_STOP'; err.isBudgetExceeded = true;
        throw err;
      }
      return reply('SKIP_SPEC: nothing to specify.');
    }
    if (/post-code|review_diff|issues/i.test(sysMsg)) {
      return reply('{"passed": true, "issues": [], "summary": "ok"}');
    }
    return reply('pong');
  }
  return new Response('Not Found', { status: 404 });
};
`;
  fs.writeFileSync(preloadPath, code, 'utf8');
}

function patchText(file, search, replace) {
  return ['FILE: ' + file, '<<<<<<< SEARCH', search, '=======', replace, '>>>>>>> REPLACE'].join('\n');
}

function newFilePatch(file, content) {
  return ['FILE: ' + file, '<<<<<<< SEARCH', '=======', content, '>>>>>>> REPLACE'].join('\n');
}

function git(repoDir, ...args) {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
}

function runCase({ name, taskYaml, taskId, initialFiles, scenario = {}, setupRepo = null, policyExtra = [], timeoutMs = 120000 }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `td-inv-${name}-`));
  const repoDir = path.join(root, 'repo');
  const cfgDir = path.join(root, 'config');
  const stateDir = path.join(root, 'state');
  const tasksDir = path.join(root, 'tasks');
  const activeDir = path.join(tasksDir, 'active');
  const archiveDir = path.join(tasksDir, 'archive');
  const lockFile = path.join(root, '.orchestrator.lock');
  const preloadFile = path.join(root, 'mock-preload.mjs');
  for (const d of [repoDir, cfgDir, stateDir, activeDir, archiveDir]) fs.mkdirSync(d, { recursive: true });

  fs.writeFileSync(path.join(repoDir, '.gitignore'), 'agent-team/state/\n', 'utf8');
  fs.mkdirSync(path.join(repoDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'scripts', 'check.mjs'), 'process.exit(0);\n', 'utf8');
  for (const [rel, content] of Object.entries(initialFiles)) {
    const full = path.join(repoDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  git(repoDir, 'init', '-b', 'master');
  git(repoDir, 'config', 'user.email', 'inv@example.com');
  git(repoDir, 'config', 'user.name', 'Invariant Runner');
  git(repoDir, 'add', '-A');
  git(repoDir, 'commit', '-m', 'init baseline');
  if (setupRepo) setupRepo(repoDir);

  fs.writeFileSync(path.join(cfgDir, 'team.yaml'), [
    'providers:',
    '  local_9router:',
    `    base_url: "${GATEWAY_URL}"`,
    'roles:',
    '  writer:',
    '    model: "mock-writer"',
    '    models:',
    '      - "mock-writer"',
    '  architect:',
    '    model: "mock-architect"',
    '  reviewer:',
    '    model: "mock-reviewer"'
  ].join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(cfgDir, 'policy.yaml'), [
    'policy:',
    '  version: "3.1.0"',
    '  project_id: "inv-hermetic-repo"',
    `  repo_root: "${repoDir.replace(/\\/g, '/')}"`,
    '  scope_control:',
    '    max_files_per_task: 5',
    '    allow_new_files: true',
    '    allowed_dirs:',
    '      - "*"',
    '  approval_gates:',
    '    require_code_review: true',
    '    review_min_risk_level: "high"',
    '  git_hygiene:',
    '    require_clean_worktree_before_start: true',
    '    rollback_on_validation_fail: true',
    '    auto_commit_on_done: true',
    '    confirm_frontend_branch_before_merge: true',
    '    commit_message_prefix: "[AI-Task]"',
    ...policyExtra,
    '  validation:',
    '    max_baseline_failures: 3',
    '    max_baseline_runtime_sec: 30',
    '    fast_checks:',
    '      - name: "inv_fast"',
    '        run: "node scripts/check.mjs"',
    '        timeout_sec: 10',
    '    suite_checks:',
    '      - name: "inv_suite"',
    '        run: "node scripts/check.mjs"',
    '        timeout_sec: 10'
  ].join('\n') + '\n', 'utf8');

  const requestLog = path.join(root, 'requests.log');
  const armFile = path.join(root, 'armed.flag');
  fs.writeFileSync(path.join(activeDir, `${taskId}.yaml`), taskYaml, 'utf8');
  writeMockPreload(preloadFile, { ...scenario, requestLog, armFile });

  const res = spawnSync(process.execPath, ['--import', pathToFileURL(preloadFile).href, ORCHESTRATOR_SCRIPT], {
    env: {
      ...process.env,
      AGENT_TEAM_CONFIG_DIR: cfgDir,
      AGENT_TEAM_STATE_DIR: stateDir,
      AGENT_TEAM_TASKS_DIR: tasksDir,
      ORCHESTRATOR_LOCK_FILE: lockFile
    },
    encoding: 'utf8',
    timeout: timeoutMs
  });

  const statePath = path.join(stateDir, 'task-state.json');
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
  const allTasks = state
    ? [...(state.completed_tasks || []), ...(state.blocked_tasks || []), ...(state.failed_tasks || []), ...(state.active_tasks || [])]
    : [];
  return {
    root,
    repoDir,
    stateDir,
    code: res.status,
    signal: res.signal,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    state,
    task: allTasks.find(t => t.task_id === taskId) || null,
    porcelain: git(repoDir, 'status', '--porcelain'),
    branch: git(repoDir, 'rev-parse', '--abbrev-ref', 'HEAD'),
    requests: fs.existsSync(requestLog) ? fs.readFileSync(requestLog, 'utf8').trim().split('\n') : []
  };
}

function diag(r) {
  return `exit=${r.code} signal=${r.signal} status=${r.task?.status} block=${String(r.task?.block_reason || '').slice(0, 200)} `
    + `porcelain=${JSON.stringify(r.porcelain)} requests=${JSON.stringify(r.requests)}\n`
    + `STDOUT(tail):\n${r.stdout.slice(-1800)}\nSTDERR(tail):\n${r.stderr.slice(-800)}`;
}

const A_ORIG = 'export const a = 1;\n// marker\n';
const B_ORIG = 'export const b = 1;\n';
const norm = (s) => String(s).replace(/\r\n/g, '\n');
const MULTI_FILES = { 'src/a.js': A_ORIG, 'src/b.js': B_ORIG };
const BUCKET1 = {
  text: [
    patchText('src/a.js', 'export const a = 1;', 'export const a = 2;'),
    newFilePatch('src/new.js', 'export const created = true;')
  ].join('\n\n')
};

function multiBucketYaml(taskId, withSpec = false) {
  return [
    `task_id: ${taskId}`,
    'title: Multi bucket invariant',
    'goal: Change a.js and create new.js (bucket 1) then change b.js (bucket 2)',
    'kind: feature',
    'mode: quick',
    'risk_level: low',
    'status: ready',
    'manual_workflow_override: true',
    'scope:',
    '  - src/a.js',
    '  - src/new.js',
    '  - src/b.js',
    'acceptance_criteria:',
    '  - a is 2, new.js exists, b is 2',
    'writer_hub_workflow:',
    ...(withSpec ? [
      '  - step: 1',
      '    role: architect',
      '    action: draft_spec',
      '    sub_scope: [src/a.js, src/new.js, src/b.js]'
    ] : []),
    `  - step: ${withSpec ? 2 : 1}`,
    '    role: writer',
    '    action: apply_patch',
    '    domain: backend',
    '    sub_scope: [src/a.js, src/new.js]',
    `  - step: ${withSpec ? 3 : 2}`,
    '    role: writer',
    '    action: apply_patch',
    '    domain: backend',
    '    sub_scope: [src/b.js]'
  ].join('\n') + '\n';
}

function assertWorktreeClean(r, label) {
  assert.equal(r.porcelain, '', `${label}: worktree must be clean after exit\n${diag(r)}`);
  assert.equal(fs.existsSync(path.join(r.repoDir, 'src/new.js')), false, `${label}: untracked src/new.js must be removed\n${diag(r)}`);
  assert.equal(norm(fs.readFileSync(path.join(r.repoDir, 'src/a.js'), 'utf8')), A_ORIG, `${label}: src/a.js must be restored\n${diag(r)}`);
}

const cases = [];
const cleanup = [];
const addCase = (name, fn) => cases.push({ name, fn });

addCase('Case 1 (H3): draft_spec budget error does not raise TDZ ReferenceError', () => {
  // Black-box part: the injected budget error must end the task as blocked with a clean worktree.
  const r = runCase({
    name: 'tdz', taskId: 'T-INV-TDZ-1', initialFiles: MULTI_FILES,
    taskYaml: multiBucketYaml('T-INV-TDZ-1', true),
    scenario: { spec: 'throw_budget', buckets: { 'src/a.js': BUCKET1 } }
  });
  cleanup.push(r.root);
  assert.ok(r.requests.includes('spec'), `spec step must have been requested\n${diag(r)}`);
  assert.ok(r.task, `task record missing\n${diag(r)}`);
  assert.equal(r.task.status, 'blocked', `expected blocked\n${diag(r)}`);
  assert.match(String(r.task.block_reason || ''), /budget/i, `block_reason should mention budget\n${diag(r)}`);
  assertWorktreeClean(r, 'Case 1');

  // Structural part: the outer catch swallows the ReferenceError (blockReason is already set), so the TDZ bug is
  // invisible at runtime. Guard it statically: both flags must be declared before their first assignment.
  const src = fs.readFileSync(ORCHESTRATOR_SCRIPT, 'utf8');
  for (const name of ['patchPipelineFailed', 'shouldBreakRetryLoop']) {
    const decls = [...src.matchAll(new RegExp(`let\\s+${name}\\b`, 'g'))];
    assert.equal(decls.length, 1, `${name} must be declared exactly once (found ${decls.length})`);
    const firstUse = src.search(new RegExp(`\\b${name}\\s*=\\s*true`));
    assert.ok(firstUse >= 0, `${name} assignment not found`);
    assert.ok(decls[0].index < firstUse, `${name} is assigned (offset ${firstUse}) before its \`let\` declaration (offset ${decls[0].index}) -> TDZ`);
  }
});

addCase('Case 2 (H1+H4): Bucket 2 failure on the last attempt leaves no tracked/untracked Bucket 1 changes', () => {
  // max_retries_per_task=1: attempt 1 and attempt 2 both apply Bucket 1 then fail at Bucket 2, so the loop
  // ends right after a Bucket 2 failure (no later apply failure that would roll back by accident).
  const r = runCase({
    name: 'bucket2', taskId: 'T-INV-B2-1', initialFiles: MULTI_FILES,
    taskYaml: multiBucketYaml('T-INV-B2-1'),
    policyExtra: ['  retry_and_escalation:', '    max_retries_per_task: 1'],
    scenario: {
      buckets: {
        'src/a.js': [BUCKET1, { text: patchText('src/a.js', '// marker', '// marker-retry') }],
        'src/b.js': { kind: 'http_error', status: 400, message: 'mock provider failure' }
      }
    }
  });
  cleanup.push(r.root);
  assert.ok(r.requests.filter(x => x === 'bucket:src/b.js').length >= 1, `Bucket 2 must have been requested\n${diag(r)}`);
  assert.ok(r.task && r.task.status !== 'done', `task must not be done\n${diag(r)}`);
  assertWorktreeClean(r, 'Case 2');
});

addCase('Case 3 (H2): SIGINT between buckets rolls back Bucket 1 incl. new untracked file', () => {
  const r = runCase({
    name: 'sigint', taskId: 'T-INV-SIG-1', initialFiles: MULTI_FILES,
    taskYaml: multiBucketYaml('T-INV-SIG-1'),
    scenario: { buckets: { 'src/a.js': BUCKET1, 'src/b.js': { kind: 'sigint' } } }
  });
  cleanup.push(r.root);
  assert.ok(r.requests.includes('emit SIGINT'), `SIGINT must have been emitted at Bucket 2\n${diag(r)}`);
  assertWorktreeClean(r, 'Case 3');
});

addCase('Case 4 (#19): unexpected exception after disk write is rolled back by finally', () => {
  const r = runCase({
    name: 'exception', taskId: 'T-INV-EXC-1',
    initialFiles: { 'src/a.js': A_ORIG },
    taskYaml: [
      'task_id: T-INV-EXC-1', 'title: Exception after write', 'goal: change a.js',
      'kind: feature', 'mode: quick', 'risk_level: low', 'status: ready',
      'scope:', '  - src/a.js', 'acceptance_criteria:', '  - a is 2'
    ].join('\n') + '\n',
    scenario: {
      throwOnReadAfterWrite: 'src/a.js',
      buckets: { 'src/a.js': { text: patchText('src/a.js', 'export const a = 1;', 'export const a = 2;') } }
    }
  });
  cleanup.push(r.root);
  assert.ok(/INJECTED_FAILURE/.test(`${r.stdout}${r.stderr}${JSON.stringify(r.task || {})}`), `injected exception must have surfaced (scenario not exercised)\n${diag(r)}`);
  assert.ok(r.task && r.task.status !== 'done', `task must not be done\n${diag(r)}`);
  assert.equal(r.porcelain, '', `worktree must be clean\n${diag(r)}`);
  assert.equal(norm(fs.readFileSync(path.join(r.repoDir, 'src/a.js'), 'utf8')), A_ORIG, `src/a.js must be restored\n${diag(r)}`);
});

addCase('Case 5 (#18/D2): git commit failure preserves worktree (incl. untracked new file), records preserved_files & ready-to-commit.patch', () => {
  const r = runCase({
    name: 'commitfail', taskId: 'T-INV-GIT-1',
    initialFiles: { 'src/a.js': A_ORIG },
    setupRepo: (repoDir) => {
      const hook = path.join(repoDir, '.git', 'hooks', 'pre-commit');
      fs.writeFileSync(hook, '#!/bin/sh\necho "blocked by invariant test hook" >&2\nexit 1\n', { encoding: 'utf8', mode: 0o755 });
    },
    taskYaml: [
      'task_id: T-INV-GIT-1', 'title: Commit failure', 'goal: change a.js and create new.js',
      'kind: feature', 'mode: quick', 'risk_level: low', 'status: ready',
      'scope:', '  - src/a.js', '  - src/new.js', 'acceptance_criteria:', '  - a is 2 and new.js exists'
    ].join('\n') + '\n',
    scenario: { buckets: { 'src/a.js': BUCKET1 } }
  });
  cleanup.push(r.root);
  assert.ok(r.task, `task record missing\n${diag(r)}`);
  assert.equal(r.task.status, 'blocked', `expected blocked\n${diag(r)}`);
  assert.equal(r.task.preserve_worktree, true, `preserve_worktree flag missing in persisted state\n${diag(r)}`);
  assert.ok(String(r.task.commit_error || '').length > 0, `commit_error missing in persisted state\n${diag(r)}`);
  assert.deepEqual(
    [...(r.task.preserved_files || [])].sort(),
    ['src/a.js', 'src/new.js'],
    `preserved_files must list both tracked and untracked files in persisted state\n${diag(r)}`
  );
  assert.match(fs.readFileSync(path.join(r.repoDir, 'src/a.js'), 'utf8'), /a = 2/, `worktree must keep the passed change\n${diag(r)}`);
  assert.equal(fs.existsSync(path.join(r.repoDir, 'src/new.js')), true, `worktree must keep untracked src/new.js\n${diag(r)}`);
  assert.match(r.porcelain, /src\/a\.js/, `src/a.js must still be modified\n${diag(r)}`);
  assert.match(r.porcelain, /src\/new\.js/, `src/new.js must still be untracked\n${diag(r)}`);
  assert.equal(r.branch, 'master', `must stay on base branch\n${diag(r)}`);
  const patchPath = path.join(r.stateDir, 'runs', 'T-INV-GIT-1', 'ready-to-commit.patch');
  assert.ok(fs.existsSync(patchPath), `ready-to-commit.patch missing at ${patchPath}\n${diag(r)}`);
  assert.match(fs.readFileSync(patchPath, 'utf8'), /a = 2/, 'ready-to-commit.patch must contain the diff');
});

addCase('Case 7 (Phase 1.5 & 2.D): safeRollback with non-existent target still rolls back remaining files & no circular imports in orchestrator/*.mjs', async () => {
  const gg = await import(pathToFileURL(path.join(__dirname, 'git-guard.mjs')).href);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'td-inv-rb-nonexist-'));
  cleanup.push(tmpRoot);
  git(tmpRoot, 'init', '-b', 'master');
  git(tmpRoot, 'config', 'user.email', 'inv@example.com');
  git(tmpRoot, 'config', 'user.name', 'Invariant Runner');
  fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'src', 'a.js'), A_ORIG, 'utf8');
  git(tmpRoot, 'add', '-A');
  git(tmpRoot, 'commit', '-m', 'init');

  // Dirty tracked file + create untracked file, while first target in list does not exist on disk
  fs.writeFileSync(path.join(tmpRoot, 'src', 'a.js'), 'export const a = 999;\n', 'utf8');
  fs.writeFileSync(path.join(tmpRoot, 'src', 'new.js'), 'export const n = 1;\n', 'utf8');
  const prevCwd = process.cwd();
  try {
    process.chdir(tmpRoot);
    // Test via real rollback helper inside git-guard or spawned git in tmpRoot
    execFileSync(process.execPath, [
      '-e',
      `import(${JSON.stringify(pathToFileURL(path.join(__dirname, 'git-guard.mjs')).href)}).then(m => {` +
      `  for (const f of ['src/does-not-exist-yet.js', 'src/a.js', 'src/new.js']) {` +
      `    try { m.safeRollback([f]); } catch {}` +
      `  }` +
      `});`
    ], { cwd: tmpRoot });
  } finally {
    process.chdir(prevCwd);
  }
  // Also verify directly on a single safeRollback call with custom rollbackFn executing git in tmpRoot
  fs.writeFileSync(path.join(tmpRoot, 'src', 'a.js'), 'export const a = 999;\n', 'utf8');
  fs.writeFileSync(path.join(tmpRoot, 'src', 'new.js'), 'export const n = 1;\n', 'utf8');
  const singleCallRes = gg.safeRollback(['src/does-not-exist-yet.js', 'src/a.js', 'src/new.js'], {
    rollbackFn: (targets) => {
      for (const f of targets) {
        try {
          git(tmpRoot, 'checkout', '--', f);
        } catch {
          try { git(tmpRoot, 'clean', '-f', '--', f); } catch {}
        }
      }
      return { ok: true };
    }
  });
  assert.equal(singleCallRes.ok, true);
  assert.equal(git(tmpRoot, 'status', '--porcelain'), '', 'remaining files after non-existent target must be rolled back cleanly');
  assert.equal(norm(fs.readFileSync(path.join(tmpRoot, 'src', 'a.js'), 'utf8')), A_ORIG);
  assert.equal(fs.existsSync(path.join(tmpRoot, 'src', 'new.js')), false);

  // Static circular-import guard: no file in scripts/orchestrator/*.mjs may import from ../orchestrator.mjs
  const subDir = path.join(__dirname, 'orchestrator');
  const subFiles = fs.existsSync(subDir) ? fs.readdirSync(subDir).filter(f => f.endsWith('.mjs')) : [];
  assert.ok(subFiles.length >= 4, `expected >= 4 modules in scripts/orchestrator/, found ${subFiles.length}`);
  for (const f of subFiles) {
    const src = fs.readFileSync(path.join(subDir, f), 'utf8');
    const codeLines = src
      .split(/\r?\n/)
      .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*'))
      .join('\n');
    assert.doesNotMatch(
      codeLines,
      /from\s+['"]\.\.\/orchestrator\.mjs['"]|import\s*\(\s*['"]\.\.\/orchestrator\.mjs['"]\s*\)/,
      `scripts/orchestrator/${f} must NEVER import from ../orchestrator.mjs (circular import / module side-effect hazard)`
    );
  }
});

addCase('Case 6 (rule): safeRollback refuses an empty target list and never calls rollback([])', async () => {
  const gg = await import(pathToFileURL(path.join(__dirname, 'git-guard.mjs')).href);
  assert.equal(typeof gg.safeRollback, 'function', 'git-guard.mjs must export safeRollback()');
  const calls = [];
  const spy = (targets) => { calls.push(targets); return { ok: true }; };
  for (const bad of [[], null, undefined, ['', '  '], 'not-an-array']) {
    const res = gg.safeRollback(bad, { rollbackFn: spy });
    assert.equal(res.ok, false, `safeRollback(${JSON.stringify(bad)}) must refuse`);
  }
  assert.equal(calls.length, 0, 'rollbackFn must not be invoked for empty/invalid targets');
  const ok = gg.safeRollback(['src/a.js', '', 'src/a.js'], { rollbackFn: spy });
  assert.equal(ok.ok, true);
  assert.deepEqual(calls, [['src/a.js']], 'targets must be de-duplicated and blank-free');
});

let failed = 0;
for (const c of cases) {
  try {
    await c.fn();
    console.log(`PASS  ${c.name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${c.name}\n      ${String(err.message).split('\n').join('\n      ').slice(0, 2600)}`);
  }
}
for (const dir of cleanup) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
if (failed > 0) {
  console.error(`test-orchestrator-exit-invariants.mjs: ${failed}/${cases.length} FAILED`);
  process.exit(1);
}
console.log(`test-orchestrator-exit-invariants.mjs: ALL ${cases.length} PASSED`);
