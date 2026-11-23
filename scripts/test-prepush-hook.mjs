#!/usr/bin/env node
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AGENT_TEAM_DIR = path.resolve(__dirname, '..');

async function runTests() {
  console.log('Testing Pre-Push Hook, npm run prepush & Hook Installer (TDD)...\n');

  const {
    ZERO_SHA,
    parsePrePushStdin,
    shouldRunPrePushChecks,
    runPrePushHook
  } = await import('./git-hooks/pre-push.mjs');
  const { installPrePushHook } = await import('./git-hooks/install.mjs');

  // 1. Parsing git pre-push stdin ref lines & filtering master branch
  const nonMasterStdin = [
    'refs/heads/feat-ui aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/heads/feat-ui bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    `refs/heads/old-branch ${ZERO_SHA} refs/heads/old-branch cccccccccccccccccccccccccccccccccccccccc`
  ].join('\n');
  const parsedNonMaster = parsePrePushStdin(nonMasterStdin);
  assert.strictEqual(parsedNonMaster.length, 2);
  assert.strictEqual(shouldRunPrePushChecks(parsedNonMaster), false, 'Pushing non-master branch must skip test:clean');

  const deleteMasterStdin = `(delete) ${ZERO_SHA} refs/heads/master bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n`;
  assert.strictEqual(shouldRunPrePushChecks(parsePrePushStdin(deleteMasterStdin)), false, 'Deleting master ref must not trigger test:clean');

  const pushMasterStdin = `refs/heads/master 1111111111111111111111111111111111111111 refs/heads/master ${ZERO_SHA}\n`;
  assert.strictEqual(shouldRunPrePushChecks(parsePrePushStdin(pushMasterStdin)), true, 'Pushing commits to refs/heads/master must trigger test:clean');

  // 2. Hook execution behavior (skip vs run vs failure blocks push, plus --with-cockpit)
  const calls = [];
  const skipOutcome = await runPrePushHook({
    stdinText: nonMasterStdin,
    runCleanFn: opts => { calls.push(opts); return { ok: true, code: 0 }; }
  });
  assert.strictEqual(skipOutcome.ok, true);
  assert.strictEqual(skipOutcome.skipped, true);
  assert.strictEqual(calls.length, 0, 'Non-master push must not invoke test:clean');

  const runOutcome = await runPrePushHook({
    stdinText: pushMasterStdin,
    runCleanFn: opts => { calls.push(opts); return { ok: true, code: 0 }; }
  });
  assert.strictEqual(runOutcome.ok, true);
  assert.strictEqual(runOutcome.skipped, false);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].withCockpit, false);

  const cockpitOutcome = await runPrePushHook({
    manual: true,
    withCockpit: true,
    runCleanFn: opts => { calls.push(opts); return { ok: true, code: 0 }; }
  });
  assert.strictEqual(cockpitOutcome.ok, true);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[1].withCockpit, true, 'Manual prepush with --with-cockpit must pass withCockpit: true');

  const failOutcome = await runPrePushHook({
    stdinText: pushMasterStdin,
    runCleanFn: () => ({ ok: false, code: 1 })
  });
  assert.strictEqual(failOutcome.ok, false, 'Failing test:clean must fail pre-push hook so git aborts push');

  // 3. Hook template script & package.json script wiring
  const shellHookPath = path.join(__dirname, 'git-hooks', 'pre-push');
  assert.ok(fs.existsSync(shellHookPath), 'agent-team/scripts/git-hooks/pre-push wrapper script must exist');
  const shellHookText = fs.readFileSync(shellHookPath, 'utf8');
  assert.ok(shellHookText.startsWith('#!/bin/sh'), 'Shell hook must start with #!/bin/sh');
  assert.ok(shellHookText.includes('pre-push.mjs'), 'Shell hook must delegate to pre-push.mjs');

  const pkg = JSON.parse(fs.readFileSync(path.join(AGENT_TEAM_DIR, 'package.json'), 'utf8'));
  assert.ok(typeof pkg.scripts?.prepush === 'string' && pkg.scripts.prepush.includes('pre-push.mjs'), 'package.json must expose npm run prepush');
  assert.ok(typeof pkg.scripts?.['hooks:install'] === 'string', 'package.json must expose npm run hooks:install');

  // 4. Temp git repo hook installation test
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'td-hook-install-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: tmpRepo, stdio: 'pipe' });
    const res = installPrePushHook({ repoRoot: tmpRepo });
    assert.ok(fs.existsSync(res.targetPath), 'installPrePushHook must write .git/hooks/pre-push');
    assert.ok(fs.readFileSync(res.targetPath, 'utf8').includes('pre-push.mjs'));
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }

  console.log('\n=================================================');
  console.log('ALL PRE-PUSH HOOK & --WITH-COCKPIT TESTS PASSED!');
  console.log('=================================================');
}

runTests().catch(err => {
  console.error('Pre-push hook test failed:', err);
  process.exit(1);
});
