#!/usr/bin/env node
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const execOpts = {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: process.platform === 'win32' ? true : undefined
};

export function isCleanWorktree(targetFiles = []) {
  try {
    if (Array.isArray(targetFiles) && targetFiles.length > 0) {
      const pathArgs = targetFiles.map(f => `"${f.replace(/"/g, '')}"`).join(' ');
      const status = execSync(`git status --porcelain -- ${pathArgs}`, execOpts).trim();
      return status.length === 0;
    }
    const status = execSync('git status --porcelain', execOpts).trim();
    return status.length === 0;
  } catch (err) {
    return false;
  }
}

export function getModifiedFiles(targetFiles = []) {
  try {
    const pathArgs = Array.isArray(targetFiles) && targetFiles.length > 0
      ? `-- ${targetFiles.map(f => `"${f.replace(/"/g, '')}"`).join(' ')}`
      : '';
    const raw = execSync(`git diff --name-only ${pathArgs}`.trim(), execOpts).trim();
    const staged = execSync(`git diff --cached --name-only ${pathArgs}`.trim(), execOpts).trim();
    const untracked = execSync(`git ls-files --others --exclude-standard ${pathArgs}`.trim(), execOpts).trim();
    const all = [...raw.split('\n'), ...staged.split('\n'), ...untracked.split('\n')]
      .map(s => s.trim().replace(/\\/g, '/'))
      .filter(Boolean);
    return Array.from(new Set(all));
  } catch {
    return [];
  }
}

export function getScopedDiff(targetFiles = []) {
  try {
    const pathArgs = Array.isArray(targetFiles) && targetFiles.length > 0
      ? `-- ${targetFiles.map(f => `"${f.replace(/"/g, '')}"`).join(' ')}`
      : '';
    return execSync(`git diff HEAD ${pathArgs}`.trim(), execOpts).trim();
  } catch {
    return '';
  }
}

export function snapshot() {
  try {
    const head = execSync('git rev-parse HEAD', execOpts).trim();
    return { ok: true, head };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function rollback(targetFiles = []) {
  try {
    if (Array.isArray(targetFiles) && targetFiles.length > 0) {
      // Revert specific scoped files (both tracked and untracked)
      for (const f of targetFiles) {
        const cleanFile = f.replace(/"/g, '');
        try {
          execSync(`git checkout -- "${cleanFile}"`, execOpts);
        } catch {
          // If untracked new file, remove it safely
          try {
            execSync(`git clean -f -- "${cleanFile}"`, execOpts);
          } catch {}
        }
      }
    } else {
      // Revert tracked changes only
      execSync('git checkout -- .', execOpts);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function commitDone(taskId, message, prefix = '[AI-Task]', targetFiles = []) {
  try {
    const cleanTargets = (Array.isArray(targetFiles) ? targetFiles : [])
      .map(f => f.trim().replace(/\\/g, '/').replace(/"/g, ''))
      .filter(Boolean);

    if (cleanTargets.length === 0) {
      return { ok: false, error: 'Refusing to run unscoped git add -A: targetFiles list is empty.' };
    }

    const pathArgs = cleanTargets.map(f => `"${f}"`).join(' ');
    execSync(`git add -- ${pathArgs}`, execOpts);
    const commitMsg = `${prefix} ${taskId}: ${message}`.replace(/"/g, '\\"');
    execSync(`git commit -m "${commitMsg}" -- ${pathArgs}`, execOpts);
    const hash = execSync('git rev-parse HEAD', execOpts).trim();
    return { ok: true, hash };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// CLI direct execution
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const [,, cmd, arg1, arg2] = process.argv;
  if (cmd === 'is-clean') {
    const clean = isCleanWorktree();
    console.log(JSON.stringify({ clean }));
    process.exit(clean ? 0 : 1);
  } else if (cmd === 'snapshot') {
    console.log(JSON.stringify(snapshot()));
  } else if (cmd === 'rollback') {
    console.log(JSON.stringify(rollback()));
  } else if (cmd === 'commit') {
    console.log(JSON.stringify(commitDone(arg1 || 'T-AUTO', arg2 || 'orchestrated update')));
  } else {
    console.log('Usage: node git-guard.mjs [is-clean|snapshot|rollback|commit]');
  }
}
