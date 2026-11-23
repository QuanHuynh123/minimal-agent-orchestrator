#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

export const ZERO_SHA = '0000000000000000000000000000000000000000';
export const TARGET_MASTER_REF = 'refs/heads/master';

export function parsePrePushStdin(stdinText = '') {
  const updates = [];
  for (const rawLine of String(stdinText || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    updates.push({
      localRef: parts[0],
      localSha: parts[1],
      remoteRef: parts[2],
      remoteSha: parts[3]
    });
  }
  return updates;
}

export function shouldRunPrePushChecks(updates = []) {
  return updates.some(
    u => u.remoteRef === TARGET_MASTER_REF && u.localSha && u.localSha !== ZERO_SHA && !/^0+$/.test(u.localSha)
  );
}

export function runCleanVerifierProcess({ repoRoot = DEFAULT_REPO_ROOT, withCockpit = false } = {}) {
  const verifierPath = path.join(repoRoot, 'agent-team', 'scripts', 'verify-worktrees.mjs');
  const args = [verifierPath, '--commits', 'HEAD'];
  if (withCockpit) args.push('--with-cockpit');
  const res = spawnSync(process.execPath, args, {
    cwd: path.join(repoRoot, 'agent-team'),
    stdio: 'inherit'
  });
  return {
    ok: res.status === 0,
    code: typeof res.status === 'number' ? res.status : 1
  };
}

export async function runPrePushHook({
  stdinText = '',
  manual = false,
  withCockpit = false,
  repoRoot = DEFAULT_REPO_ROOT,
  runCleanFn = runCleanVerifierProcess,
  log = console.log
} = {}) {
  if (!manual) {
    const updates = parsePrePushStdin(stdinText);
    if (!shouldRunPrePushChecks(updates)) {
      log('[pre-push] Push does not target refs/heads/master; skipping test:clean.');
      return { ok: true, skipped: true, code: 0, reason: 'non_master_push' };
    }
  }
  const label = withCockpit ? 'test:clean --with-cockpit' : 'test:clean';
  log(`[pre-push] Running ${label} before ${manual ? 'manual prepush' : 'pushing to refs/heads/master'}...`);
  const result = await runCleanFn({ repoRoot, withCockpit: Boolean(withCockpit) });
  if (!result || !result.ok) {
    return { ok: false, skipped: false, code: result?.code ?? 1, reason: 'test_clean_failed' };
  }
  return { ok: true, skipped: false, code: 0 };
}

function readHookStdinIfPiped() {
  if (process.stdin.isTTY) return '';
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const argv = process.argv.slice(2);
  const manual = argv.includes('--manual');
  const withCockpit = argv.includes('--with-cockpit') || process.env.AGENT_TEAM_PREPUSH_WITH_COCKPIT === '1';
  const stdinText = manual ? '' : readHookStdinIfPiped();
  runPrePushHook({ stdinText, manual, withCockpit }).then(res => {
    if (!res.ok) process.exit(res.code || 1);
  }).catch(err => {
    console.error('[pre-push] Hook failed:', err);
    process.exit(1);
  });
}
