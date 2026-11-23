import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRepoRoot } from '../applier.mjs';

const REPO_ROOT = resolveRepoRoot();
const SHA_RE = /^[0-9a-f]{7,40}$/i;

/**
 * Reads an immutable file snapshot at a specific committed SHA using `git show <sha>:<path>`.
 */
export function readGitCommitFile(sha, relPath, options = {}) {
  if (!SHA_RE.test(String(sha || '').trim())) {
    throw new Error(`readGitCommitFile requires an explicit hex commit SHA (got "${sha}")`);
  }
  const cleanRel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  return execFileSync('git', ['show', `${sha}:${cleanRel}`], {
    cwd: options.repoRoot || REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
}

/**
 * Materializes committed file snapshots from a specific SHA into an isolated temp directory.
 */
export function materializeGitCommitSnapshot(sha, relPaths = [], options = {}) {
  const destDir = options.destDir || fs.mkdtempSync(path.join(os.tmpdir(), 'td-hermetic-snap-'));
  for (const relPath of relPaths) {
    const cleanRel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!cleanRel) continue;
    const content = readGitCommitFile(sha, cleanRel, options);
    const outPath = path.resolve(destDir, cleanRel);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, content, 'utf8');
  }
  return destDir;
}
