#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { loadMergedPolicy } from './lib/policy-loader.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const TEAM_DIR = path.resolve(__dirname, '..');

export function resolveRepoRoot(projectConfig = null, options = {}) {
  let cfg = projectConfig;
  if (!cfg) {
    cfg = loadMergedPolicy({ configDir: options.configDir });
  }
  const defaultRoot = fs.existsSync(path.join(TEAM_DIR, '.git')) ? '.' : '..';
  const configuredRoot = cfg?.policy?.repo_root || cfg?.project?.repo_root || defaultRoot;
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

export const BUILTIN_PROTECTED_FILES = [
  '**/.env*',
  '.git/**',
  'agent-team/scripts/**',
  'agent-team/runtime/**',
  'agent-team/config/**',
  '**/*secret*',
  '**/*keyring*'
];

export function checkForbidden(relPath, protectedFiles = [], taskForbidden = []) {
  const allForbidden = [
    ...BUILTIN_PROTECTED_FILES,
    ...(protectedFiles || []),
    ...(taskForbidden || [])
  ];
  for (const pat of allForbidden) {
    if (matchesPattern(relPath, pat)) {
      return { forbidden: true, pattern: pat };
    }
  }
  return { forbidden: false };
}

export function checkAllowedDirs(relPath, allowedDirs = []) {
  if (!allowedDirs || allowedDirs.length === 0 || allowedDirs.includes('*')) return true;
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
    'infra',
    'package.json',
    'package-lock.json',
    'requirements.txt',
    'pyproject.toml',
    'cargo.toml',
    'go.mod',
    'dockerfile',
    'docker-compose'
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

  if (state !== 'IDLE') {
    blocks.dangling = {
      state,
      file: currentFile || 'unknown'
    };
  }

  return blocks;
}

function normalizeSearchForFingerprint(searchText = '') {
  return String(searchText || '').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

export function computeApplierErrorHash({ errorCode = 'apply_error', file = '', search = '', fallbackMessage = '' } = {}) {
  const normSearch = normalizeSearchForFingerprint(search);
  const searchFingerprint = normSearch
    ? crypto.createHash('sha1').update(normSearch).digest('hex').slice(0, 16)
    : '';
  const signature = JSON.stringify({
    code: String(errorCode || 'apply_error'),
    file: String(file || ''),
    search_fp: searchFingerprint,
    detail: searchFingerprint ? '' : String(fallbackMessage || '')
  });
  return crypto.createHash('sha1').update(signature).digest('hex');
}

function merge1BasedIntervals(intervals = []) {
  const clean = (Array.isArray(intervals) ? intervals : [])
    .filter(r => Array.isArray(r) && Number.isFinite(Number(r[0])) && Number.isFinite(Number(r[1])) && Number(r[1]) >= Number(r[0]))
    .map(r => [Math.max(1, Math.trunc(Number(r[0]))), Math.max(1, Math.trunc(Number(r[1])))])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [s, e] of clean) {
    if (merged.length === 0 || s > merged[merged.length - 1][1] + 1) {
      merged.push([s, e]);
    } else {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    }
  }
  return merged;
}

function intervalOverlapsRanges(startLine, endLine, ranges = []) {
  for (const [s, e] of ranges) {
    if (startLine <= e && endLine >= s) return true;
  }
  return false;
}

function computeRemainingOmitted(omittedRanges = [], seenRanges = []) {
  const omitted = merge1BasedIntervals(omittedRanges);
  const seen = merge1BasedIntervals(seenRanges);
  if (omitted.length === 0) return [];
  if (seen.length === 0) return omitted;

  const remaining = [];
  for (const [os, oe] of omitted) {
    let cursor = os;
    for (const [ss, se] of seen) {
      if (se < cursor) continue;
      if (ss > oe) break;
      if (ss > cursor) {
        remaining.push([cursor, Math.min(oe, ss - 1)]);
      }
      cursor = Math.max(cursor, se + 1);
      if (cursor > oe) break;
    }
    if (cursor <= oe) {
      remaining.push([cursor, oe]);
    }
  }
  return remaining;
}

function isIndentSensitivePath(relPath = '') {
  const clean = String(relPath || '').trim().replace(/\\/g, '/').toLowerCase();
  const base = path.posix.basename(clean);
  if (base === 'makefile' || base.endsWith('.mk')) return true;
  return /\.(?:py|pyw|yaml|yml)$/.test(base);
}

/**
 * Strips leading/trailing whitespace and collapses horizontal whitespace [ \t]+ to a single space
 * ONLY outside quoted string literals ('...', "...", `...`). Never strips spaces inside strings.
 */
function normalizeCodeLineOutsideStrings(line = '') {
  const trimmed = String(line || '').replace(/[ \t]+$/g, '').trimStart();
  if (!trimmed) return '';
  let out = '';
  let inQuote = null;
  let inSpaceRun = false;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inQuote) {
      out += ch;
      if (ch === '\\' && i + 1 < trimmed.length) {
        out += trimmed[i + 1];
        i++;
        continue;
      }
      if (ch === inQuote) {
        inQuote = null;
      }
      continue;
    }

    if (ch === '\'' || ch === '"' || ch === '`') {
      if (inSpaceRun && out.length > 0) {
        out += ' ';
      }
      inSpaceRun = false;
      inQuote = ch;
      out += ch;
    } else if (ch === ' ' || ch === '\t') {
      inSpaceRun = true;
    } else {
      if (inSpaceRun && out.length > 0) {
        out += ' ';
      }
      inSpaceRun = false;
      out += ch;
    }
  }
  return out;
}

function gcdPositive(a, b) {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x;
}

function inferSpaceIndentUnit(lines = [], relPath = '') {
  const defaultUnit = /\.ya?ml$/i.test(String(relPath || '')) ? 2 : 4;
  const counts = [];
  for (const ln of lines) {
    if (!ln || !ln.trim()) continue;
    const m = /^ +/.exec(ln);
    if (m && m[0].length > 0) counts.push(m[0].length);
  }
  if (counts.length === 0) return defaultUnit;
  let g = counts[0];
  for (let i = 1; i < counts.length; i++) {
    g = gcdPositive(g, counts[i]);
  }
  return Math.max(1, Math.min(g, 8));
}

function computeIndentLevel(line = '', spaceUnit = 4) {
  const lead = /^[ \t]*/.exec(String(line || ''))?.[0] || '';
  const tabs = (lead.match(/\t/g) || []).length;
  const spaces = (lead.match(/ /g) || []).length;
  if (tabs > 0 && spaces > 0) {
    return tabs + (spaces / spaceUnit);
  }
  return tabs > 0 ? tabs : (spaces / spaceUnit);
}

function checkIndentHierarchyMatch(searchLines, matchedLines, relPath) {
  const searchSpaceUnit = inferSpaceIndentUnit(searchLines, relPath);
  const fileSpaceUnit = inferSpaceIndentUnit(matchedLines, relPath);

  let baseSearchLevel = null;
  let baseFileLevel = null;

  for (let k = 0; k < searchLines.length; k++) {
    const sLine = searchLines[k] || '';
    const fLine = matchedLines[k] || '';
    if (!sLine.trim() && !fLine.trim()) continue;

    const sLevel = computeIndentLevel(sLine, searchSpaceUnit);
    const fLevel = computeIndentLevel(fLine, fileSpaceUnit);

    if (baseSearchLevel === null) {
      baseSearchLevel = sLevel;
      baseFileLevel = fLevel;
      continue;
    }

    const sDelta = sLevel - baseSearchLevel;
    const fDelta = fLevel - baseFileLevel;
    if (Math.abs(sDelta - fDelta) > 1e-6) {
      return false;
    }
  }
  return true;
}

function reindentReplaceForMatch(normReplace, searchLines, matchedLines, relPath, currentContent) {
  const replaceLines = String(normReplace || '').split('\n');
  const firstSearchLine = searchLines.find(l => l.trim().length > 0) || '';
  const firstMatchLine = matchedLines.find(l => l.trim().length > 0) || '';

  const matchUsesTabs = /^\t+/m.test(matchedLines.join('\n')) || (/^\t+/m.test(currentContent) && !/^  +/m.test(matchedLines.join('\n')));
  const searchSpaceUnit = inferSpaceIndentUnit([...searchLines, ...replaceLines], relPath);
  const fileSpaceUnit = inferSpaceIndentUnit(matchedLines, relPath);

  const searchBaseLevel = computeIndentLevel(firstSearchLine, searchSpaceUnit);
  const targetBaseIndent = /^[ \t]*/.exec(firstMatchLine)?.[0] || '';
  const targetUnitStr = matchUsesTabs ? '\t' : ' '.repeat(fileSpaceUnit);

  const trimOneUnit = (indentStr) => {
    if (matchUsesTabs) return indentStr.replace(/\t$/, '');
    return indentStr.length >= fileSpaceUnit ? indentStr.slice(0, indentStr.length - fileSpaceUnit) : '';
  };

  return replaceLines.map(rLine => {
    const body = rLine.trimStart();
    if (!body) return '';
    const rLevel = computeIndentLevel(rLine, searchSpaceUnit);
    const relDepth = Math.round(rLevel - searchBaseLevel);
    if (relDepth >= 0) {
      return targetBaseIndent + targetUnitStr.repeat(relDepth) + body;
    }
    let reduced = targetBaseIndent;
    for (let u = 0; u < Math.abs(relDepth); u++) {
      reduced = trimOneUnit(reduced);
    }
    return reduced + body;
  }).join('\n');
}

function tryUniqueWhitespaceMatch(currentContent, normSearch, relPath = '') {
  const searchLines = normSearch.split('\n');
  const normSearchLines = searchLines.map(normalizeCodeLineOutsideStrings);
  const hasAnyNonEmpty = normSearchLines.some(l => l.length > 0);
  if (!hasAnyNonEmpty) return { found: false, multiple: false, match: null };

  const fileLines = currentContent.split('\n');
  const winLen = searchLines.length;
  if (winLen === 0 || winLen > fileLines.length) {
    return { found: false, multiple: false, match: null };
  }

  // Precompute character start offsets for every line in currentContent
  const lineOffsets = new Array(fileLines.length);
  let pos = 0;
  for (let idx = 0; idx < fileLines.length; idx++) {
    lineOffsets[idx] = pos;
    pos += fileLines[idx].length + 1;
  }

  const indentSensitive = isIndentSensitivePath(relPath);
  const matches = [];
  for (let start = 0; start <= fileLines.length - winLen; start++) {
    let linesOk = true;
    for (let k = 0; k < winLen; k++) {
      if (normalizeCodeLineOutsideStrings(fileLines[start + k]) !== normSearchLines[k]) {
        linesOk = false;
        break;
      }
    }
    if (!linesOk) continue;

    const candidateSliceLines = fileLines.slice(start, start + winLen);
    if (indentSensitive && !checkIndentHierarchyMatch(searchLines, candidateSliceLines, relPath)) {
      continue;
    }

    const matchedText = candidateSliceLines.join('\n');
    const startOffset = lineOffsets[start];
    const endOffset = startOffset + matchedText.length;
    matches.push({
      startLine: start + 1,
      endLine: start + winLen,
      startOffset,
      endOffset,
      matchedText,
      matchedLines: candidateSliceLines
    });
  }

  if (matches.length === 1) {
    return { found: true, multiple: false, match: matches[0] };
  }
  if (matches.length > 1) {
    return { found: false, multiple: true, count: matches.length, match: null };
  }
  return { found: false, multiple: false, match: null };
}

function tokenizeForSimilarity(line = '') {
  return new Set((String(line || '').toLowerCase().match(/[a-z0-9_$-]{2,}/g)) || []);
}

function lineSimilarity(a = '', b = '') {
  const ta = String(a || '').trim();
  const tb = String(b || '').trim();
  if (!ta && !tb) return 0.5;
  if (!ta || !tb) return 0;
  if (ta === tb) return 1.0;

  const setA = tokenizeForSimilarity(ta);
  const setB = tokenizeForSimilarity(tb);
  let tokenJaccard = 0;
  if (setA.size > 0 && setB.size > 0) {
    let inter = 0;
    for (const tok of setA) {
      if (setB.has(tok)) inter++;
    }
    tokenJaccard = inter / (setA.size + setB.size - inter);
  }

  const normA = ta.replace(/\s+/g, ' ');
  const normB = tb.replace(/\s+/g, ' ');
  let bigramDice = 0;
  if (normA.length >= 2 && normB.length >= 2) {
    const bigramsA = new Map();
    for (let i = 0; i < normA.length - 1; i++) {
      const bg = normA.slice(i, i + 2);
      bigramsA.set(bg, (bigramsA.get(bg) || 0) + 1);
    }
    let overlap = 0;
    for (let i = 0; i < normB.length - 1; i++) {
      const bg = normB.slice(i, i + 2);
      const cnt = bigramsA.get(bg) || 0;
      if (cnt > 0) {
        overlap++;
        bigramsA.set(bg, cnt - 1);
      }
    }
    bigramDice = (2 * overlap) / ((normA.length - 1) + (normB.length - 1));
  }
  return Math.max(tokenJaccard, 0.55 * tokenJaccard + 0.45 * bigramDice);
}

function findBestApproximateRegion(relPath, fileLines = [], searchLines = [], allowedRanges = null) {
  const totalLines = fileLines.length;
  if (totalLines === 0) {
    return { bestLine: 1, similarity: 0, snippetStart: 1, snippetEnd: 1, formattedSnippet: '' };
  }

  const nonEmptySearch = searchLines
    .map((text, idx) => ({ text: text.trim(), idx }))
    .filter(x => x.text.length > 0);
  const anchors = nonEmptySearch.slice(0, 4);
  const compareLen = Math.min(Math.max(1, searchLines.length), 20);

  const candidateStarts = new Set();
  const isAllowed = (line1Based) => !Array.isArray(allowedRanges) || allowedRanges.length === 0 || intervalOverlapsRanges(line1Based, line1Based, allowedRanges);

  if (totalLines <= 300) {
    for (let i = 0; i < totalLines; i++) {
      if (isAllowed(i + 1)) candidateStarts.add(i);
    }
  } else {
    const scoredLines = [];
    for (let i = 0; i < totalLines; i++) {
      if (!isAllowed(i + 1)) continue;
      let maxAnchorSim = 0;
      let bestOffset = 0;
      for (const anc of anchors) {
        const sim = lineSimilarity(anc.text, fileLines[i]);
        if (sim > maxAnchorSim) {
          maxAnchorSim = sim;
          bestOffset = anc.idx;
        }
      }
      if (maxAnchorSim >= 0.25) {
        scoredLines.push({ start: Math.max(0, i - bestOffset), sim: maxAnchorSim });
      }
    }
    scoredLines.sort((a, b) => b.sim - a.sim);
    for (const item of scoredLines.slice(0, 30)) {
      candidateStarts.add(item.start);
    }
    if (candidateStarts.size === 0 && Array.isArray(allowedRanges) && allowedRanges.length > 0) {
      candidateStarts.add(Math.max(0, allowedRanges[0][0] - 1));
    } else if (candidateStarts.size === 0) {
      candidateStarts.add(0);
    }
  }

  let bestLine = 1;
  let bestScore = 0;

  for (const startIdx of candidateStarts) {
    if (!isAllowed(startIdx + 1)) continue;
    let sumSim = 0;
    let weightSum = 0;
    for (let k = 0; k < compareLen; k++) {
      if (startIdx + k >= totalLines) break;
      const sLine = searchLines[k] || '';
      const weight = sLine.trim().length > 0 ? 1.0 : 0.2;
      sumSim += lineSimilarity(sLine, fileLines[startIdx + k]) * weight;
      weightSum += weight;
    }
    const avgSim = weightSum > 0 ? sumSim / weightSum : 0;
    if (avgSim > bestScore) {
      bestScore = avgSim;
      bestLine = startIdx + 1;
    }
  }

  const snippetStart = Math.max(1, bestLine - 8);
  const snippetEnd = Math.min(totalLines, snippetStart + 29); // Strictly max 30 lines
  const numbered = [];
  for (let ln = snippetStart; ln <= snippetEnd; ln++) {
    numbered.push(`${ln}: ${fileLines[ln - 1]}`);
  }
  const formattedSnippet = [
    `=== ACTUAL FILE CONTENT (${relPath}:${snippetStart}-${snippetEnd}) ===`,
    ...numbered,
    '=== END ACTUAL FILE CONTENT ==='
  ].join('\n');

  return {
    bestLine,
    similarity: Number(bestScore.toFixed(4)),
    snippetStart,
    snippetEnd,
    formattedSnippet
  };
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
    repoRoot = REPO_ROOT,
    contextMeta = null,
    readRanges = []
  } = options;

  const taskScope = task.scope || [];
  const taskForbidden = task.forbidden_files || [];
  const allowExpansion = Boolean(task.allow_scope_expansion || task.cross_role_edit);
  const existingExpansions = task.scope_expansions || [];

  // BƯỚC 1: Parse blocks & Detect Truncated/Dangling Blocks (Provider-Agnostic Truncation Guard)
  const blocks = parseSearchReplaceBlocks(rawOutput);
  if (blocks.dangling) {
    return {
      ok: false,
      truncated: true,
      error: `Truncated/dangling SEARCH-REPLACE block detected in "${blocks.dangling.file}" (unclosed ${blocks.dangling.state} block without >>>>>>> REPLACE). Refusing to apply partial output.`
    };
  }
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
  let fuzzyWhitespaceMatches = 0;
  const unseenExactMatches = [];

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

    const origNormContent = originalRaw.replace(/\r\n/g, '\n');
    const origFileLines = origNormContent.split('\n');

    // Resolve seen vs omitted line ranges in ORIGINAL file coordinates when smart context windowing was used
    const fileMeta = contextMeta?.byFile?.[relPath] || null;
    const readsForFile = (Array.isArray(readRanges) ? readRanges : [])
      .filter(r => r && String(r.path || '').trim().replace(/\\/g, '/').replace(/^\.\//, '') === relPath)
      .map(r => [r.start_line, r.end_line]);
    const initialSent = Array.isArray(fileMeta?.sentRanges) ? fileMeta.sentRanges : [];
    const initialOmitted = Array.isArray(fileMeta?.omittedRanges) ? fileMeta.omittedRanges : [];
    const seenRanges = merge1BasedIntervals([...initialSent, ...readsForFile]);
    const remainingOmitted = computeRemainingOmitted(initialOmitted, seenRanges);
    const hasSmartWindowGuard = Boolean(fileExists && fileMeta && initialOmitted.length > 0 && seenRanges.length > 0);

    const plannedEdits = [];

    for (let i = 0; i < fileBlocks.length; i++) {
      const b = fileBlocks[i];
      const normSearch = b.search.replace(/\r\n/g, '\n');
      const normReplace = b.replace.replace(/\r\n/g, '\n');

      const lazyError = checkLazyGuard(normReplace);
      if (lazyError) {
        const errorHash = computeApplierErrorHash({
          errorCode: 'lazy_guard',
          file: relPath,
          search: normSearch,
          fallbackMessage: lazyError
        });
        return {
          ok: false,
          error_hash: errorHash,
          failed_block: { index: i + 1, file: relPath, error_code: 'lazy_guard' },
          error: `Block ${i + 1} for "${relPath}": ${lazyError}`
        };
      }

      if (!normSearch) {
        if (fileExists && origNormContent.trim().length > 0) {
          const msg = `Block ${i + 1} for "${relPath}": Empty SEARCH block is only permitted when creating a new file or editing an empty file.`;
          return {
            ok: false,
            error_hash: computeApplierErrorHash({ errorCode: 'empty_search_nonempty_file', file: relPath, search: '', fallbackMessage: msg }),
            failed_block: { index: i + 1, file: relPath, error_code: 'empty_search_nonempty_file' },
            error: msg
          };
        }
        plannedEdits.push({
          blockIndex: i + 1,
          startOffset: 0,
          endOffset: origNormContent.length,
          startLine: 1,
          endLine: origFileLines.length,
          normSearch,
          replaceText: normReplace
        });
        continue;
      }

      const searchLines = normSearch.split('\n');
      const firstNonEmptyLine = (searchLines.find(l => l.trim().length > 0) || searchLines[0] || '').trim().slice(0, 100);

      const makeSeenWindowError = (suggestedOmittedRanges = remainingOmitted) => {
        const omitDesc = suggestedOmittedRanges.length > 0
          ? suggestedOmittedRanges.map(([s, e]) => `OMITTED LINES ${s}..${e}`).join(', ')
          : initialOmitted.map(([s, e]) => `OMITTED LINES ${s}..${e}`).join(', ');
        const msg = `SEARCH block #${i + 1} không nằm trong phần văn bản đã thấy in "${relPath}". Read the unseen section(s) with read_file first (${omitDesc || 'call read_file on target lines'}). First SEARCH line: "${firstNonEmptyLine}"`;
        return {
          ok: false,
          error_hash: computeApplierErrorHash({ errorCode: 'not_in_seen_window', file: relPath, search: normSearch }),
          failed_block: { index: i + 1, file: relPath, error_code: 'not_in_seen_window' },
          error: msg
        };
      };

      const firstIdx = origNormContent.indexOf(normSearch);
      if (firstIdx !== -1) {
        const secondIdx = origNormContent.indexOf(normSearch, firstIdx + 1);
        if (secondIdx !== -1) {
          const msg = `SEARCH block ${i + 1} matches multiple times in "${relPath}". Add more surrounding context lines.`;
          return {
            ok: false,
            error_hash: computeApplierErrorHash({ errorCode: 'multiple_matches', file: relPath, search: normSearch }),
            failed_block: { index: i + 1, file: relPath, error_code: 'multiple_matches' },
            error: msg
          };
        }

        const matchStartLine = origNormContent.slice(0, firstIdx).split('\n').length;
        const matchEndLine = matchStartLine + searchLines.length - 1;
        if (hasSmartWindowGuard && !intervalOverlapsRanges(matchStartLine, matchEndLine, seenRanges)) {
          const nonEmptySearchLines = searchLines.filter(l => l.trim().length > 0).length;
          if (nonEmptySearchLines >= 3) {
            // Cổng seen_window chỉ chặn khối <3 dòng hoặc dùng để giải thích khi KHÔNG khớp;
            // khối khớp chính xác + duy nhất + >=3 dòng không rỗng được áp dụng và ghi telemetry unseen_exact_match.
            const isDeleteBlock = normReplace.trim().length === 0;
            unseenExactMatches.push({
              block: i + 1,
              file: relPath,
              start_line: matchStartLine,
              end_line: matchEndLine,
              non_empty_lines: nonEmptySearchLines,
              is_delete: isDeleteBlock,
              action_kind: isDeleteBlock ? 'delete' : 'modify'
            });
          } else {
            const targetGap = remainingOmitted.filter(([s, e]) => intervalOverlapsRanges(matchStartLine, matchEndLine, [[s, e]]));
            return makeSeenWindowError(targetGap.length > 0 ? targetGap : remainingOmitted);
          }
        }

        plannedEdits.push({
          blockIndex: i + 1,
          startOffset: firstIdx,
          endOffset: firstIdx + normSearch.length,
          startLine: matchStartLine,
          endLine: matchEndLine,
          normSearch,
          replaceText: normReplace
        });
        continue;
      }

      // Branch (c): Strict whitespace/indentation-only fuzzy match on original file, ONLY when unique
      const wsRes = tryUniqueWhitespaceMatch(origNormContent, normSearch, relPath);
      if (wsRes.multiple) {
        const msg = `SEARCH block ${i + 1} matches multiple locations (after whitespace normalization) in "${relPath}". Add more surrounding context lines.`;
        return {
          ok: false,
          error_hash: computeApplierErrorHash({ errorCode: 'multiple_matches', file: relPath, search: normSearch }),
          failed_block: { index: i + 1, file: relPath, error_code: 'multiple_matches' },
          error: msg
        };
      }
      if (wsRes.found && wsRes.match) {
        if (hasSmartWindowGuard && !intervalOverlapsRanges(wsRes.match.startLine, wsRes.match.endLine, seenRanges)) {
          const targetGap = remainingOmitted.filter(([s, e]) => intervalOverlapsRanges(wsRes.match.startLine, wsRes.match.endLine, [[s, e]]));
          return makeSeenWindowError(targetGap.length > 0 ? targetGap : remainingOmitted);
        }
        const effectiveReplace = reindentReplaceForMatch(
          normReplace,
          searchLines,
          wsRes.match.matchedLines,
          relPath,
          origNormContent
        );
        plannedEdits.push({
          blockIndex: i + 1,
          startOffset: wsRes.match.startOffset,
          endOffset: wsRes.match.endOffset,
          startLine: wsRes.match.startLine,
          endLine: wsRes.match.endLine,
          normSearch,
          replaceText: effectiveReplace
        });
        fuzzyWhitespaceMatches++;
        continue;
      }

      // Neither exact nor whitespace-only unique match found. Check (a) unseen-window vs (b) closest-match diagnostic.
      if (hasSmartWindowGuard && remainingOmitted.length > 0) {
        const bestInSeen = findBestApproximateRegion(relPath, origFileLines, searchLines, seenRanges);
        if (bestInSeen.similarity < 0.45) {
          const bestOverall = findBestApproximateRegion(relPath, origFileLines, searchLines, null);
          const matchingGaps = bestOverall.similarity >= 0.45
            ? remainingOmitted.filter(([s, e]) => intervalOverlapsRanges(bestOverall.bestLine, bestOverall.bestLine, [[s, e]]))
            : [];
          return makeSeenWindowError(matchingGaps.length > 0 ? matchingGaps : remainingOmitted);
        }
        const pct = Math.round(bestInSeen.similarity * 100);
        const msg = [
          `SEARCH block ${i + 1} not found in "${relPath}".`,
          `First SEARCH line: "${firstNonEmptyLine}"`,
          `Closest match at line ${bestInSeen.bestLine} (similarity ${pct}%).`,
          bestInSeen.formattedSnippet
        ].join('\n');
        return {
          ok: false,
          error_hash: computeApplierErrorHash({ errorCode: 'search_not_found', file: relPath, search: normSearch }),
          failed_block: { index: i + 1, file: relPath, error_code: 'search_not_found', closest_line: bestInSeen.bestLine, similarity: bestInSeen.similarity },
          revealed_range: { path: relPath, start_line: bestInSeen.snippetStart, end_line: bestInSeen.snippetEnd, content: bestInSeen.formattedSnippet },
          error: msg
        };
      }

      // Branch (b): Full-file or legacy check with closest line + similarity + <=30 lines of ACTUAL FILE CONTENT
      const bestFull = findBestApproximateRegion(relPath, origFileLines, searchLines, null);
      const pctFull = Math.round(bestFull.similarity * 100);
      const msgFull = [
        `SEARCH block ${i + 1} not found in "${relPath}".`,
        `First SEARCH line: "${firstNonEmptyLine}"`,
        `Closest match at line ${bestFull.bestLine} (similarity ${pctFull}%).`,
        bestFull.formattedSnippet
      ].join('\n');
      return {
        ok: false,
        error_hash: computeApplierErrorHash({ errorCode: 'search_not_found', file: relPath, search: normSearch }),
        failed_block: { index: i + 1, file: relPath, error_code: 'search_not_found', closest_line: bestFull.bestLine, similarity: bestFull.similarity },
        revealed_range: { path: relPath, start_line: bestFull.snippetStart, end_line: bestFull.snippetEnd, content: bestFull.formattedSnippet },
        error: msgFull
      };
    }

    // Detect overlapping spans on original file coordinates before splicing atomically
    if (plannedEdits.length > 1) {
      const sortedAsc = [...plannedEdits].sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset || a.blockIndex - b.blockIndex);
      for (let k = 1; k < sortedAsc.length; k++) {
        const prev = sortedAsc[k - 1];
        const cur = sortedAsc[k];
        if (cur.startOffset < prev.endOffset || (cur.startOffset === prev.startOffset && cur.endOffset === prev.endOffset)) {
          const msg = `Overlapping SEARCH blocks #${prev.blockIndex} (lines ${prev.startLine}-${prev.endLine}) and #${cur.blockIndex} (lines ${cur.startLine}-${cur.endLine}) in "${relPath}". Merge overlapping edits into a single SEARCH block.`;
          return {
            ok: false,
            error_hash: computeApplierErrorHash({ errorCode: 'overlapping_blocks', file: relPath, search: cur.normSearch, fallbackMessage: msg }),
            failed_block: {
              index: cur.blockIndex,
              overlaps_with: prev.blockIndex,
              file: relPath,
              error_code: 'overlapping_blocks'
            },
            error: msg
          };
        }
      }
    }

    // Atomic bottom-up splice against original coordinates (invariant to deletions/insertions in earlier blocks)
    let currentContent = origNormContent;
    const sortedDesc = [...plannedEdits].sort((a, b) => b.startOffset - a.startOffset || b.endOffset - a.endOffset);
    for (const edit of sortedDesc) {
      currentContent = currentContent.slice(0, edit.startOffset) + edit.replaceText + currentContent.slice(edit.endOffset);
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
    scope_expansions: updatedExpansions,
    fuzzy_whitespace_matches: fuzzyWhitespaceMatches,
    unseen_exact_match: unseenExactMatches.length > 0,
    ...(unseenExactMatches.length > 0 ? { unseen_exact_matches: unseenExactMatches } : {})
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
