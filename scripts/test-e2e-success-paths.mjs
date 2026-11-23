#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ORCHESTRATOR_SCRIPT = path.join(__dirname, 'orchestrator.mjs');

function writeMockFetchPreload(preloadPath, gatewayBaseUrl, patchByTarget) {
  const code = [
    `const TARGET_BASE = ${JSON.stringify(gatewayBaseUrl)};`,
    `const PATCHES = ${JSON.stringify(patchByTarget)};`,
    'const origFetch = globalThis.fetch;',
    'globalThis.fetch = async (input, init = {}) => {',
    '  const url = typeof input === "string" ? input : (input?.url || String(input));',
    '  if (!url.startsWith(TARGET_BASE)) {',
    '    return origFetch(input, init);',
    '  }',
    '  const method = String(init?.method || "GET").toUpperCase();',
    '  if (method === "GET" && url.endsWith("/models")) {',
    '    return new Response(JSON.stringify({',
    '      object: "list",',
    '      data: [{ id: "mock-writer" }, { id: "mock-architect" }, { id: "mock-reviewer" }]',
    '    }), { status: 200, headers: { "Content-Type": "application/json" } });',
    '  }',
    '  if (method === "POST" && url.endsWith("/chat/completions")) {',
    '    let body = {};',
    '    try { body = JSON.parse(String(init?.body || "{}")); } catch {}',
    '    const sysMsg = String(body.messages?.[0]?.content || "");',
    '    const userMsg = String(body.messages?.[body.messages.length - 1]?.content || "");',
    '    let content = "pong";',
    '    if ((body.max_tokens && body.max_tokens <= 16) || /\b(?:single word|ping|calibrate)\b/i.test(userMsg)) {',
    '      content = "OK";',
    '    } else if (/Lead Software Architect|draft_spec|contract table/i.test(sysMsg + "\\n" + userMsg)) {',
    '      content = "SKIP_SPEC: Ambiguity-free single file change.";',
    '    } else if (/post-code|review_diff|issues/i.test(sysMsg)) {',
    '      content = \'{"passed": true, "issues": [], "summary": "Looks good"}\';',
    '    } else {',
    '      for (const [targetFile, patchText] of Object.entries(PATCHES)) {',
    '        if (userMsg.includes(targetFile)) {',
    '          content = patchText;',
    '          break;',
    '        }',
    '      }',
    '    }',
    '    return new Response(JSON.stringify({',
    '      id: "chatcmpl-mock-e2e",',
    '      object: "chat.completion",',
    '      model: body.model || "mock-writer",',
    '      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],',
    '      usage: { prompt_tokens: 180, completion_tokens: 42, total_tokens: 222 }',
    '    }), { status: 200, headers: { "Content-Type": "application/json" } });',
    '  }',
    '  return new Response("Not Found", { status: 404 });',
    '};'
  ].join('\n');
  fs.writeFileSync(preloadPath, code, 'utf8');
}

function runE2ECase({ name, taskYaml, initialFiles, patchByTarget }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `td-e2e-${name}-`));
  const repoDir = path.join(root, 'repo');
  const cfgDir = path.join(root, 'config');
  const stateDir = path.join(root, 'state');
  const tasksDir = path.join(root, 'tasks');
  const activeDir = path.join(tasksDir, 'active');
  const archiveDir = path.join(tasksDir, 'archive');
  const lockFile = path.join(root, '.orchestrator.lock');
  const preloadFile = path.join(root, 'mock-gateway-preload.mjs');
  const gatewayUrl = 'http://127.0.0.1:29999/v1';

  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(activeDir, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });

  fs.writeFileSync(path.join(repoDir, '.gitignore'), 'agent-team/state/\n', 'utf8');
  fs.mkdirSync(path.join(repoDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'scripts', 'check.mjs'), 'process.exit(0);\n', 'utf8');
  for (const [rel, content] of Object.entries(initialFiles)) {
    const full = path.join(repoDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }

  execFileSync('git', ['init', '-b', 'master'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'E2E Runner'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['add', '-A'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init baseline'], { cwd: repoDir, stdio: 'ignore' });

  fs.writeFileSync(path.join(cfgDir, 'team.yaml'), [
    'providers:',
    '  local_9router:',
    `    base_url: "${gatewayUrl}"`,
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

  const normalizedRepoPath = repoDir.replace(/\\/g, '/');
  fs.writeFileSync(path.join(cfgDir, 'policy.yaml'), [
    'policy:',
    '  version: "3.1.0"',
    '  project_id: "e2e-hermetic-repo"',
    `  repo_root: "${normalizedRepoPath}"`,
    '  scope_control:',
    '    max_files_per_task: 5',
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
    '  validation:',
    '    max_baseline_failures: 3',
    '    max_baseline_runtime_sec: 30',
    '    fast_checks:',
    '      - name: "e2e_fast"',
    '        run: "node scripts/check.mjs"',
    '        timeout_sec: 10',
    '    suite_checks:',
    '      - name: "e2e_suite"',
    '        run: "node scripts/check.mjs"',
    '        timeout_sec: 10'
  ].join('\n') + '\n', 'utf8');

  fs.writeFileSync(path.join(activeDir, `${name}.yaml`), taskYaml, 'utf8');
  writeMockFetchPreload(preloadFile, gatewayUrl, patchByTarget);

  const preloadUrl = pathToFileURL(preloadFile).href;
  const childRes = spawnSync(
    process.execPath,
    ['--import', preloadUrl, ORCHESTRATOR_SCRIPT],
    {
      env: {
        ...process.env,
        AGENT_TEAM_CONFIG_DIR: cfgDir,
        AGENT_TEAM_STATE_DIR: stateDir,
        AGENT_TEAM_TASKS_DIR: tasksDir,
        ORCHESTRATOR_LOCK_FILE: lockFile
      },
      encoding: 'utf8',
      timeout: 30000
    }
  );

  const statePath = path.join(stateDir, 'task-state.json');
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
  const statusOut = execFileSync('git', ['status', '--porcelain'], { cwd: repoDir, encoding: 'utf8' }).trim();
  const curBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

  return {
    childRes: { code: childRes.status, stdout: childRes.stdout || '', stderr: childRes.stderr || '' },
    state,
    repoDir,
    activeDir,
    archiveDir,
    stateDir,
    statusOut,
    curBranch
  };
}

const cleanupDirs = [];
try {
  // Case (a): Non-frontend task -> commits directly to main branch (master), status = done
  const caseA = runE2ECase({
    name: 'non-frontend',
    initialFiles: {
      'src/app.js': [
        'export function greet(name) {',
        '  return `hi ${name}`;',
        '}'
      ].join('\n') + '\n'
    },
    patchByTarget: {
      'src/app.js': [
        'FILE: src/app.js',
        '<<<<<<< SEARCH',
        'export function greet(name) {',
        '  return `hi ${name}`;',
        '}',
        '=======',
        'export function greet(name) {',
        '  const safe = String(name || "world").trim();',
        '  return `hello ${safe}`;',
        '}',
        '>>>>>>> REPLACE'
      ].join('\n')
    },
    taskYaml: [
      'task_id: T-E2E-BE-1',
      'title: Update greet helper',
      'goal: Format greeting safely in src/app.js',
      'kind: feature',
      'mode: quick',
      'risk_level: low',
      'status: ready',
      'scope:',
      '  - src/app.js',
      'acceptance_criteria:',
      '  - greet trims whitespace and handles empty name'
    ].join('\n') + '\n'
  });
  cleanupDirs.push(path.dirname(caseA.repoDir));

  assert.equal(caseA.childRes.code, 0, `Case (a) orchestrator exited ${caseA.childRes.code}:\n${caseA.childRes.stderr}`);
  assert.equal(
    caseA.state?.completed_tasks?.length,
    1,
    `Case (a) expected completed_tasks=1, blocked=${JSON.stringify(caseA.state?.blocked_tasks?.map(t => ({ id: t.task_id, status: t.status, block_reason: t.block_reason, last_error: t.last_error })))}, active=${JSON.stringify(caseA.state?.active_tasks?.map(t => ({ id: t.task_id, status: t.status, block_reason: t.block_reason })))}\nSTDOUT:\n${caseA.childRes.stdout.slice(-1500)}\nSTDERR:\n${caseA.childRes.stderr.slice(-1500)}`
  );
  const taskA = caseA.state.completed_tasks[0];
  assert.equal(taskA.status, 'done');
  assert.ok(taskA.commit_hash && taskA.commit_hash.length >= 7, 'Case (a) must record commit_hash');
  assert.equal(caseA.curBranch, 'master');
  assert.equal(caseA.statusOut, '');
  const lastMsgA = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: caseA.repoDir, encoding: 'utf8' }).trim();
  assert.match(lastMsgA, /T-E2E-BE-1/);
  assert.match(fs.readFileSync(path.join(caseA.repoDir, 'src/app.js'), 'utf8'), /hello \$\{safe\}/);

  // Case (b): Frontend task -> creates ai-task/<id> branch, returns to master, status = awaiting_confirmation
  const caseB = runE2ECase({
    name: 'frontend',
    initialFiles: {
      'ui_web/index.html': [
        '<div id="app">',
        '  <span id="status-badge">Idle</span>',
        '</div>'
      ].join('\n') + '\n'
    },
    patchByTarget: {
      'ui_web/index.html': [
        'FILE: ui_web/index.html',
        '<<<<<<< SEARCH',
        '<div id="app">',
        '  <span id="status-badge">Idle</span>',
        '</div>',
        '=======',
        '<div id="app">',
        '  <span id="status-badge">Ready</span>',
        '</div>',
        '>>>>>>> REPLACE'
      ].join('\n')
    },
    taskYaml: [
      'task_id: T-E2E-FE-1',
      'title: Update UI status badge label',
      'goal: Change default status badge text to Ready in ui_web/index.html',
      'kind: feature',
      'mode: quick',
      'risk_level: low',
      'status: ready',
      'scope:',
      '  - ui_web/index.html',
      'acceptance_criteria:',
      '  - Status badge shows Ready'
    ].join('\n') + '\n'
  });
  cleanupDirs.push(path.dirname(caseB.repoDir));

  assert.equal(caseB.childRes.code, 0, `Case (b) orchestrator exited ${caseB.childRes.code}:\n${caseB.childRes.stderr}`);
  const awaitingB = (caseB.state?.active_tasks || []).find(t => t.task_id === 'T-E2E-FE-1');
  assert.ok(
    awaitingB && awaitingB.status === 'awaiting_confirmation',
    `Case (b) expected task awaiting_confirmation, got active=${JSON.stringify(caseB.state?.active_tasks?.map(t => ({ id: t.task_id, status: t.status, block_reason: t.block_reason })))}`
  );
  assert.equal(awaitingB.requires_user_confirmation, true);
  assert.ok(awaitingB.pending_branch && awaitingB.pending_branch.startsWith('ai-task/T-E2E-FE-1'));
  assert.match(awaitingB.merge_command || '', /git merge/);
  assert.equal(caseB.curBranch, 'master', 'Frontend branch gate must keep working tree on base branch awaiting merge');
  assert.equal(caseB.statusOut, '');
  const branchHtml = execFileSync('git', ['show', `${awaitingB.pending_branch}:ui_web/index.html`], { cwd: caseB.repoDir, encoding: 'utf8' });
  assert.match(branchHtml, /Ready/);

  console.log('test-e2e-success-paths.mjs: ALL PASSED (Case A direct commit + Case B awaiting_confirmation branch)');
} finally {
  for (const dir of cleanupDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}
