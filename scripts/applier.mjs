#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

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

export function isInsideDir(childPath, parentDir) {
  const rel = path.relative(parentDir, childPath);
  if (process.platform === 'win32') {
    return !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.toLowerCase().startsWith('..');
  }
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function validateScope(filePath, allowedScope = [], allowedDirs = []) {
  const absPath = path.resolve(REPO_ROOT, filePath);
  
  // Must be inside repo root
  if (!isInsideDir(absPath, REPO_ROOT)) {
    return { valid: false, error: `Path "${filePath}" is outside repo boundary: ${REPO_ROOT}` };
  }

  // Allowed dirs check
  if (allowedDirs.length > 0) {
    const inAllowed = allowedDirs.some(dir => {
      const absDir = path.resolve(REPO_ROOT, dir);
      return isInsideDir(absPath, absDir);
    });
    if (!inAllowed) {
      return { valid: false, error: `Path "${filePath}" is not inside allowed_dirs: ${allowedDirs.join(', ')}` };
    }
  }

  // Task scope check
  if (allowedScope && allowedScope.length > 0) {
    const inScope = allowedScope.some(scopeItem => {
      const absScope = path.resolve(REPO_ROOT, scopeItem);
      // Can be exact file match or within a scoped directory
      if (absScope.toLowerCase() === absPath.toLowerCase()) return true;
      return isInsideDir(absPath, absScope);
    });
    if (!inScope) {
      return { valid: false, error: `Path "${filePath}" is outside task.scope: ${allowedScope.join(', ')}` };
    }
  }

  return { valid: true, absPath };
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

    // File target indicator: e.g. "FILE: path/to/file.ext" or "### File: path/to/file.ext"
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

export function applyBlocksToFile(filePath, blocks) {
  const absPath = path.resolve(REPO_ROOT, filePath);
  let originalRaw = '';
  let fileExists = fs.existsSync(absPath);
  let eol = '\n';

  if (fileExists) {
    originalRaw = fs.readFileSync(absPath, 'utf8');
    if (originalRaw.includes('\r\n')) {
      eol = '\r\n';
    }
  }

  // Work with normalized LF for consistent searching
  let currentContent = originalRaw.replace(/\r\n/g, '\n');

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const normSearch = block.search.replace(/\r\n/g, '\n');
    const normReplace = block.replace.replace(/\r\n/g, '\n');

    const lazyError = checkLazyGuard(normReplace);
    if (lazyError) {
      return { ok: false, error: `Block ${i + 1} for ${filePath}: ${lazyError}` };
    }

    if (!normSearch && !fileExists) {
      // New file creation block
      currentContent = normReplace;
      continue;
    }

    // Match count check (Opus requirement: exactly 1 match)
    const firstIdx = currentContent.indexOf(normSearch);
    if (firstIdx === -1) {
      return {
        ok: false,
        error: `SEARCH block ${i + 1} not found in ${filePath}. Check exact indentation and whitespace.`
      };
    }

    const secondIdx = currentContent.indexOf(normSearch, firstIdx + 1);
    if (secondIdx !== -1) {
      return {
        ok: false,
        error: `SEARCH block ${i + 1} matches multiple times in ${filePath}. Add more surrounding context lines.`
      };
    }

    // Perform slice replacement
    currentContent = currentContent.slice(0, firstIdx) + normReplace + currentContent.slice(firstIdx + normSearch.length);
  }

  // Restore original EOL
  if (eol === '\r\n') {
    currentContent = currentContent.replace(/\n/g, '\r\n');
  }

  // Atomic write via temp file
  const tmpPath = `${absPath}.tmp.${Date.now()}`;
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(tmpPath, currentContent, 'utf8');
  fs.renameSync(tmpPath, absPath);

  return { ok: true, path: filePath, bytes: Buffer.byteLength(currentContent, 'utf8') };
}

export function applyEdits(rawOutput, taskScope = [], allowedDirs = [], strictScope = true) {
  const blocks = parseSearchReplaceBlocks(rawOutput);
  if (blocks.length === 0) {
    return { ok: false, error: 'No <<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE blocks detected in output.' };
  }

  // Group blocks by file
  const byFile = {};
  for (const block of blocks) {
    if (!block.file) {
      return { ok: false, error: 'Block encountered without target file specified (e.g. "FILE: path/to/file")' };
    }
    const targetFile = block.file.replace(/\\/g, '/');
    if (strictScope) {
      const scopeCheck = validateScope(targetFile, taskScope, allowedDirs);
      if (!scopeCheck.valid) {
        return { ok: false, error: scopeCheck.error };
      }
    }
    if (!byFile[targetFile]) byFile[targetFile] = [];
    byFile[targetFile].push(block);
  }

  const results = [];
  for (const [file, fileBlocks] of Object.entries(byFile)) {
    const res = applyBlocksToFile(file, fileBlocks);
    if (!res.ok) {
      return { ok: false, error: res.error, failedFile: file };
    }
    results.push(res);
  }

  return { ok: true, modified: results };
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
