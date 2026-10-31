#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const TEAM_DIR = path.resolve(__dirname, '..');

export function resolveRepoRoot(projectConfig = null) {
  let cfg = projectConfig;
  if (!cfg) {
    const cfgPath = path.resolve(TEAM_DIR, 'config', 'project.yaml');
    if (fs.existsSync(cfgPath)) {
      try {
        cfg = YAML.parse(fs.readFileSync(cfgPath, 'utf8'));
      } catch {}
    }
  }
  const configuredRoot = cfg?.project?.repo_root || '..';
  return path.resolve(TEAM_DIR, configuredRoot);
}

const REPO_ROOT = resolveRepoRoot();

const LAZY_PATTERNS = [
  /\/\/\s*\.{3,}\s*(existing|remains|rest|code|logic|unchanged)/i,
  /#\s*\.{3,}\s*(existing|remains|rest|code|logic|unchanged)/i,
  /<!--\s*\.{3,}\s*(existing|remains|rest|code|logic|unchanged)\s*-->/i,
  /\/\*\s*\.{3,}\s*(existing|remains|rest|code|logic|unchanged)\s*\*\//i,
  /\.{3,}\s*(existing code|rest of code|remains the same)/i
];

function checkLazyGuard(text) {
  for (const pat of LAZY_PATTERNS) {
    if (pat.test(text)) {
      return `Lazy truncation detected matching pattern: ${pat}. Writer must output full exact code blocks.`;
    }
  }
  return null;
}

/**
 * Normalizes relative path and guards against path traversal, null bytes, absolute paths.
 * Returns normalized relative path with forward slashes.
 */
export function normalizeOrThrow(repoRoot, filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('File path cannot be empty');
  }
  if (filePath.includes('\0')) {
    throw new Error(`Null byte in path: ${filePath}`);
  }

  const cleaned = filePath.replace(/\\/g, '/').trim();
  if (path.isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) {
    throw new Error(`Absolute paths forbidden: ${filePath}`);
  }

  const abs = path.resolve(repoRoot, cleaned);
  const rel = path.relative(repoRoot, abs);

  if (rel === '..' || rel.startsWith('..' + path.sep) || rel.startsWith('../') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes repository root: ${filePath}`);
  }

  return rel.split(path.sep).join('/');
}

/**
 * Case-insensitive glob and wildcard matcher.
 */
export function matchesPattern(filePath, pattern) {
  const normPath = filePath.replace(/\\/g, '/').toLowerCase();
  const normPat = pattern.replace(/\\/g, '/').toLowerCase();

  if (normPat.startsWith('**/')) {
    const sub = normPat.slice(3);
    if (sub.endsWith('*')) {
      const prefix = sub.slice(0, -1);
      return normPath.split('/').some(part => part.startsWith(prefix));
    }
    return normPath === sub || normPath.endsWith('/' + sub) || normPath.includes('/' + sub);
  }
  if (normPat.endsWith('/**')) {
    const dir = normPat.slice(0, -3);
    return normPath === dir || normPath.startsWith(dir + '/');
  }
  if (normPat.endsWith('*')) {
    const prefix = normPat.slice(0, -1);
    return normPath.startsWith(prefix) || (normPath.split('/').pop() || '').startsWith(prefix);
  }
  return normPath === normPat || normPath.endsWith('/' + normPat);
}

export function checkForbidden(relPath, protectedFiles = [], taskForbidden = []) {
  const allForbidden = [...(protectedFiles || []), ...(taskForbidden || [])];
  for (const pat of allForbidden) {
    if (matchesPattern(relPath, pat)) {
      return { forbidden: true, pattern: pat };
    }
  }
  return { forbidden: false };
}

export function checkAllowedDirs(relPath, allowedDirs = []) {
  if (!allowedDirs || allowedDirs.length === 0) return true;
  const normPath = relPath.replace(/\\/g, '/').toLowerCase();
  return allowedDirs.some(dir => {
    const d = dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return normPath === d || normPath.startsWith(d + '/');
  });
}

export function isFileInScope(relPath, taskScope = []) {
  if (!taskScope || taskScope.length === 0) return false;
  const normPath = relPath.replace(/\\/g, '/').toLowerCase();
  return taskScope.some(scopeItem => {
    const s = scopeItem.replace(/\\/g, '/').trim().toLowerCase();
    if (!s) return false;
    if (s.endsWith('/**')) {
      const dir = s.slice(0, -3);
      return normPath === dir || normPath.startsWith(dir + '/');
    }
    if (s.endsWith('/')) {
      return normPath.startsWith(s);
    }
    if (s.startsWith('**/')) {
      const sub = s.slice(3);
      return normPath === sub || normPath.endsWith('/' + sub);
    }
    return normPath === s;
  });
}

export function computeDeterministicRisk(scope = []) {
  const sensitivePatterns = [
    'agent-team/scripts',
    'agent-team/config',
    '.github/',
    'keyring',
    'auth',
    'secret',
    'migration',
    'infra'
  ];
  const isHigh = scope.some(item => {
    const s = (item || '').toLowerCase().replace(/\\/g, '/');
    return sensitivePatterns.some(p => s.includes(p));
  });
  return isHigh ? 'high' : 'low';
}

export function checkNoSymlinkEscape(repoRoot, absPath) {
  const realRoot = fs.realpathSync(repoRoot);
  let current = absPath;
  while (current && current !== repoRoot && current !== path.dirname(current)) {
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        return { ok: false, error: `SECURITY: Symlink disallowed in path lineage: "${path.relative(repoRoot, current)}"` };
      }
      const realCurrent = fs.realpathSync(current);
      const relToRoot = path.relative(realRoot, realCurrent);
      if (relToRoot === '..' || relToRoot.startsWith('..' + path.sep) || path.isAbsolute(relToRoot)) {
        return { ok: false, error: `SECURITY: Realpath escapes repository root: "${path.relative(repoRoot, current)}"` };
      }
    }
    current = path.dirname(current);
  }
  return { ok: true };
}

export function parseSearchReplaceBlocks(content) {
  const lines = content.split(/\r?\n/);
  const blocks = [];
  let currentFile = null;
  let state = 'IDLE'; // IDLE, SEARCH, REPLACE
  let searchLines = [];
  let replaceLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fileMatch = line.match(/^(?:###\s*)?(?:FILE|File):\s*`?([^\s`]+)`?/i);
    if (fileMatch && state === 'IDLE') {
      currentFile = fileMatch[1].trim();
      continue;
    }

    if (line.trim().startsWith('<<<<<<< SEARCH')) {
      state = 'SEARCH';
      searchLines = [];
      replaceLines = [];
      continue;
    }

    if (line.trim().startsWith('=======') && state === 'SEARCH') {
      state = 'REPLACE';
      continue;
    }

    if (line.trim().startsWith('>>>>>>> REPLACE') && state === 'REPLACE') {
      state = 'IDLE';
      blocks.push({
        file: currentFile,
        search: searchLines.join('\n'),
        replace: replaceLines.join('\n')
      });
      continue;
    }

    if (state === 'SEARCH') {
      searchLines.push(line);
    } else if (state === 'REPLACE') {
      replaceLines.push(line);
    }
  }

  return blocks;
}

/**
 * 8-Step Pipeline for Applying Edits:
 * 1. Parse Search/Replace blocks
 * 2. Normalize and validate paths
 * 3. Chặn Symlink / Submodule
 * 4. Chặn Forbidden files (effective_forbidden) -> no retry
 * 5. Chặn ngoài project.allowed_dirs
 * 6. Kiểm tra Scope & Scope expansion giới hạn cộng dồn
 * 7. Kiểm tra All-or-Nothing (mô phỏng 100% blocks pass trước khi chạm disk)
 * 8. Atomic Write State
 */
export function applyEdits(rawOutput, task = {}, options = {}) {
  const {
    allowedDirs = [],
    protectedFiles = [],
    maxScopeIncrease = 1,
    allowNewFiles = true,
    newFilesOnlyInScope = true,
    repoRoot = REPO_ROOT
  } = options;

  const taskScope = task.scope || [];
  const taskForbidden = task.forbidden_files || [];
  const allowExpansion = Boolean(task.allow_scope_expansion || task.cross_role_edit);
  const existingExpansions = task.scope_expansions || [];

  // BƯỚC 1: Parse blocks
  const blocks = parseSearchReplaceBlocks(rawOutput);
  if (blocks.length === 0) {
    return {
      ok: false,
      error: 'No <<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE blocks detected in output.'
    };
  }

  // Group blocks by normalized relative path
  const byFile = {};
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block.file) {
      return {
        ok: false,
        error: `Block ${i + 1} encountered without target file header (e.g. "FILE: path/to/file")`
      };
    }

    // BƯỚC 2: Normalize path
    let relPath;
    try {
      relPath = normalizeOrThrow(repoRoot, block.file);
    } catch (err) {
      return {
        ok: false,
        security: true,
        noRetry: true,
        error: `SECURITY: ${err.message}`
      };
    }

    // BƯỚC 4: Check Forbidden Files
    const forbiddenCheck = checkForbidden(relPath, protectedFiles, taskForbidden);
    if (forbiddenCheck.forbidden) {
      return {
        ok: false,
        security: true,
        noRetry: true,
        error: `SECURITY: Forbidden file edit attempted on "${relPath}" (matched pattern: "${forbiddenCheck.pattern}")`
      };
    }

    // BƯỚC 5: Check Allowed Dirs
    if (!checkAllowedDirs(relPath, allowedDirs)) {
      return {
        ok: false,
        error: `Path "${relPath}" is outside project.allowed_dirs: ${allowedDirs.join(', ')}`
      };
    }

    if (!byFile[relPath]) byFile[relPath] = [];
    byFile[relPath].push(block);
  }

  const modifiedFiles = Object.keys(byFile);

  // BƯỚC 6: Scope & Scope Expansion Check
  const outOfScopeFiles = modifiedFiles.filter(f => !isFileInScope(f, taskScope));
  let updatedExpansions = [...existingExpansions];

  if (outOfScopeFiles.length > 0) {
    if (!allowExpansion) {
      return {
        ok: false,
        error: `Out-of-scope edit attempted on ${outOfScopeFiles.join(', ')}`
      };
    }

    // Prevent silent privilege escalation into high-risk files via scope expansion
    if (computeDeterministicRisk(outOfScopeFiles) === 'high') {
      return {
        ok: false,
        security: true,
        noRetry: true,
        error: `SECURITY: Scope expansion into high-risk sensitive path is forbidden: ${outOfScopeFiles.join(', ')}`
      };
    }

    // Accumulate unique expansions
    const combined = Array.from(new Set([...existingExpansions, ...outOfScopeFiles]));
    if (combined.length > maxScopeIncrease) {
      return {
        ok: false,
        error: `Scope expansion limit exceeded: attempted ${combined.length} files (max allowed: ${maxScopeIncrease}): ${combined.join(', ')}`
      };
    }
    updatedExpansions = combined;
  }

  // BƯỚC 7: All-or-Nothing In-Memory Simulation
  const simulatedOutputs = {};

  for (const [relPath, fileBlocks] of Object.entries(byFile)) {
    const absPath = path.resolve(repoRoot, relPath);
    let originalRaw = '';
    const fileExists = fs.existsSync(absPath);
    let eol = '\n';

    // BƯỚC 3: Check symlink in path lineage (covers leaf & parent dirs)
    try {
      const symCheck = checkNoSymlinkEscape(repoRoot, absPath);
      if (!symCheck.ok) {
        return {
          ok: false,
          security: true,
          noRetry: true,
          error: symCheck.error
        };
      }
    } catch (err) {
      return {
        ok: false,
        security: true,
        noRetry: true,
        error: `SECURITY: Symlink check failed on "${relPath}": ${err.message}`
      };
    }

    if (fileExists) {
      originalRaw = fs.readFileSync(absPath, 'utf8');
      if (originalRaw.includes('\r\n')) {
        eol = '\r\n';
      }
    } else {
      if (!allowNewFiles) {
        return {
          ok: false,
          error: `Creating new file "${relPath}" is disallowed by policy (allow_new_files: false).`
        };
      }
      if (newFilesOnlyInScope && !isFileInScope(relPath, taskScope)) {
        return {
          ok: false,
          error: `New file "${relPath}" must be explicitly declared in task.scope (policy: new_files_only_in_scope).`
        };
      }
    }

    let currentContent = originalRaw.replace(/\r\n/g, '\n');

    for (let i = 0; i < fileBlocks.length; i++) {
      const b = fileBlocks[i];
      const normSearch = b.search.replace(/\r\n/g, '\n');
      const normReplace = b.replace.replace(/\r\n/g, '\n');

      const lazyError = checkLazyGuard(normReplace);
      if (lazyError) {
        return {
          ok: false,
          error: `Block ${i + 1} for "${relPath}": ${lazyError}`
        };
      }

      if (!normSearch) {
        if (fileExists) {
          return {
            ok: false,
            error: `Block ${i + 1} for "${relPath}": Empty SEARCH block is only permitted when creating a new file.`
          };
        }
        currentContent = normReplace;
        continue;
      }

      const firstIdx = currentContent.indexOf(normSearch);
      if (firstIdx === -1) {
        return {
          ok: false,
          error: `SEARCH block ${i + 1} not found in "${relPath}". Check exact indentation and whitespace.`
        };
      }

      const secondIdx = currentContent.indexOf(normSearch, firstIdx + 1);
      if (secondIdx !== -1) {
        return {
          ok: false,
          error: `SEARCH block ${i + 1} matches multiple times in "${relPath}". Add more surrounding context lines.`
        };
      }

      currentContent = currentContent.slice(0, firstIdx) + normReplace + currentContent.slice(firstIdx + normSearch.length);
    }

    if (eol === '\r\n') {
      currentContent = currentContent.replace(/\n/g, '\r\n');
    }

    simulatedOutputs[relPath] = { absPath, content: currentContent };
  }

  // BƯỚC 8: Atomic Write to Disk (Passes only if 100% simulated successfully)
  const appliedList = [];
  for (const [relPath, item] of Object.entries(simulatedOutputs)) {
    const tmpPath = `${item.absPath}.tmp.${Date.now()}`;
    fs.mkdirSync(path.dirname(item.absPath), { recursive: true });
    fs.writeFileSync(tmpPath, item.content, 'utf8');
    fs.renameSync(tmpPath, item.absPath);
    appliedList.push(relPath);
  }

  return {
    ok: true,
    modified: appliedList,
    scope_expansions: updatedExpansions
  };
}

// CLI direct execution
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const [,, inputFile] = process.argv;
  if (!inputFile) {
    console.log('Usage: node applier.mjs <patch-file>');
    process.exit(1);
  }
  const raw = fs.readFileSync(path.resolve(inputFile), 'utf8');
  const res = applyEdits(raw);
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
}
