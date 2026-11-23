#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

export function installPrePushHook({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const sourcePath = path.join(__dirname, 'pre-push');
  const rawHooksPath = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
  const hooksDir = path.isAbsolute(rawHooksPath) ? rawHooksPath : path.resolve(repoRoot, rawHooksPath);
  fs.mkdirSync(hooksDir, { recursive: true });
  const targetPath = path.join(hooksDir, 'pre-push');
  fs.copyFileSync(sourcePath, targetPath);
  try {
    fs.chmodSync(targetPath, 0o755);
  } catch {}
  return { sourcePath, targetPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const { targetPath } = installPrePushHook();
  console.log(`Installed pre-push hook to: ${targetPath}`);
}
