import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { checkNoSymlinkEscape, normalizeOrThrow } from '../applier.mjs';
import { isForbiddenAttachment } from '../../runtime/context-adapter.mjs';
import { extractPublicSymbolSignatures } from '../../runtime/repo-map.mjs';
import { buildRouterContextParts } from './context-builders.mjs';
import { partitionScopeByDomain } from './risk-policy.mjs';

function isFrontendDomainFile(relPath, policyConfig = {}) {
  return partitionScopeByDomain([relPath], policyConfig).frontendScope.length > 0;
}

const TEST_FILE_HINT_RE = /(?:^|\/)(?:tests?|__tests__|spec)\/|(?:\.test\.|\.spec\.|^test[_-])/i;
const DOC_OR_ASSET_RE = /\.(?:md|markdown|txt|json|ya?ml|css|scss|sass|less|html|htm|svg|png|jpg|jpeg|webp|gif|ico|woff2?|ttf|lock)$/i;
const DATA_SAMPLE_PATH_RE = /(?:^|[\s(`'"\[])([a-zA-Z0-9_.\-/]+\.(?:json|ya?ml|csv|sql|toml))(?=$|[\s)`'"\],;:])/gi;

function normalizeRelPath(p) {
  return String(p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function collectAllowedSourceFiles(repoRoot, policyConfig = {}, options = {}) {
  if (Array.isArray(options.candidateFiles) && options.candidateFiles.length > 0) {
    return options.candidateFiles.map(normalizeRelPath).filter(Boolean);
  }
  const sc = policyConfig?.policy?.scope_control || policyConfig?.scope_control || {};
  const allowedDirs = Array.isArray(sc.allowed_dirs) && sc.allowed_dirs.length > 0
    ? sc.allowed_dirs
    : ['src', 'app', 'lib', 'server', 'api', 'routes', 'services'];
  const contextExclude = Array.isArray(sc.context_exclude) ? sc.context_exclude : [];
  try {
    const parts = buildRouterContextParts(allowedDirs, repoRoot, options.maxFiles ?? 600, '', [], {
      includeConventions: false,
      contextExclude,
      maxFileSizeBytes: options.maxFileSizeBytes ?? 512 * 1024
    });
    return Array.isArray(parts?.collected) ? parts.collected.map(normalizeRelPath).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function listRecentGitModifiedFiles(repoRoot, limitCommits = 3) {
  try {
    const out = execFileSync(
      'git',
      ['log', '-n', String(limitCommits), '--name-only', '--pretty=format:'],
      { cwd: repoRoot, encoding: 'utf8', timeout: 2500, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return new Set(
      String(out || '')
        .split(/\r?\n/)
        .map(normalizeRelPath)
        .filter(Boolean)
    );
  } catch {
    return new Set();
  }
}

function readSafeTextFile(repoRoot, relPath, maxBytes = 256 * 1024) {
  try {
    const safeRel = normalizeOrThrow(repoRoot, relPath);
    if (isForbiddenAttachment(safeRel)) return null;
    const absPath = path.resolve(repoRoot, safeRel);
    const sym = checkNoSymlinkEscape(repoRoot, absPath);
    if (!sym.ok) return null;
    if (!fs.existsSync(absPath)) return null;
    const st = fs.statSync(absPath);
    if (!st.isFile() || st.size > maxBytes) return null;
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }
}

function extractHandlerFieldHints(lines, startLineIdx) {
  const snippet = lines.slice(startLineIdx, Math.min(lines.length, startLineIdx + 28)).join('\n');
  const reqKeys = new Set();
  const resKeys = new Set();

  let m;
  const dotRe = /\b(?:body|payload|data|params|query|input)\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
  while ((m = dotRe.exec(snippet)) !== null && reqKeys.size < 8) {
    reqKeys.add(m[1]);
  }
  const destructRe = /(?:const|let|var)\s*\{\s*([^}\n]{1,140})\}\s*=\s*(?:body|payload|data|req\.body|request\.body)\b/g;
  while ((m = destructRe.exec(snippet)) !== null && reqKeys.size < 8) {
    for (const part of m[1].split(',')) {
      const key = part.split(':')[0].split('=')[0].trim();
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) && reqKeys.size < 8) reqKeys.add(key);
    }
  }
  const jsonRe = /(?:json|sendJson)\s*\([^{;\n]*\{\s*([^}\n]{1,140})/g;
  while ((m = jsonRe.exec(snippet)) !== null && resKeys.size < 8) {
    for (const part of m[1].split(',')) {
      const key = part.split(':')[0].trim();
      if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) && resKeys.size < 8) resKeys.add(key);
    }
  }

  return {
    reqKeys: Array.from(reqKeys),
    resKeys: Array.from(resKeys)
  };
}

/**
 * Extracts literal /api/... HTTP routes and router mount prefixes neutrally across JS/TS/decorator frameworks.
 */
export function extractBackendRoutesFromCode(content = '') {
  const src = String(content || '');
  if (!src || !src.includes('/api')) return [];
  const lines = src.split(/\r?\n/);
  const routeMap = new Map();

  const addRoute = (method, routePath, lineIdx, isPrefix = false) => {
    const cleanPath = String(routePath || '').trim().split('?')[0].replace(/\/+$/, '') || '/';
    if (!cleanPath.startsWith('/api')) return;
    if (!isPrefix && cleanPath === '/api') return;
    const normMethod = String(method || 'ANY').toUpperCase();
    const key = `${isPrefix ? 'PREFIX' : normMethod}:${cleanPath}`;
    if (routeMap.has(key)) return;
    const hints = isPrefix ? { reqKeys: [], resKeys: [] } : extractHandlerFieldHints(lines, lineIdx);
    routeMap.set(key, {
      method: normMethod,
      path: cleanPath,
      line: lineIdx + 1,
      isPrefix: Boolean(isPrefix),
      reqKeys: hints.reqKeys,
      resKeys: hints.resKeys
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('/api')) continue;

    let m;
    const methodRe = /(?:app|router|server|api)\.(get|post|put|patch|delete|all)\s*\(\s*['"](\/api\/[^'"`$\s?#]+)['"]/gi;
    while ((m = methodRe.exec(line)) !== null) {
      addRoute(m[1], m[2], i, false);
    }

    const decoRe = /@(?:app|router|bp)\.(get|post|put|patch|delete|route)\s*\(\s*['"](\/api\/[^'"`$\s?#]+)['"]/gi;
    while ((m = decoRe.exec(line)) !== null) {
      addRoute(m[1] === 'route' ? 'ANY' : m[1], m[2], i, false);
    }

    const urlCmpRe = /(?:pathname|url|path)\s*===?\s*['"](\/api\/[^'"`$\s?#]+)['"]/gi;
    while ((m = urlCmpRe.exec(line)) !== null) {
      const ctxWindow = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 2)).join(' ');
      const methodMatch = /\bmethod\s*===?\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/i.exec(ctxWindow);
      addRoute(methodMatch ? methodMatch[1] : 'ANY', m[1], i, false);
    }

    const startsWithRe = /\.startsWith\s*\(\s*['"](\/api\/[^'"`$\s?#]+)['"]\s*\)/gi;
    while ((m = startsWithRe.exec(line)) !== null) {
      addRoute('PREFIX', m[1], i, true);
    }

    const usePrefixRe = /(?:app|router)\.use\s*\(\s*['"](\/api(?:\/[^'"`$\s?#]*)?)['"]/gi;
    while ((m = usePrefixRe.exec(line)) !== null) {
      addRoute('PREFIX', m[1], i, true);
    }

    const optPrefixRe = /\bprefix\s*[:=]\s*['"](\/api(?:\/[^'"`$\s?#]*)?)['"]/gi;
    while ((m = optPrefixRe.exec(line)) !== null) {
      addRoute('PREFIX', m[1], i, true);
    }
  }

  return Array.from(routeMap.values());
}

/**
 * Discovers relevant non-frontend backend/API files outside a pure-frontend task's scope (0-token).
 */
export function discoverBackendContractFiles(task = {}, repoRoot = process.cwd(), policyConfig = {}, options = {}) {
  const maxFiles = Number(options.maxFiles ?? 3);
  const scopeSet = new Set((Array.isArray(task?.scope) ? task.scope : []).map(normalizeRelPath).filter(Boolean));
  const missingDependents = new Set(
    (Array.isArray(task?.scope_dependents?.missing_code_dependents) ? task.scope_dependents.missing_code_dependents : [])
      .map(normalizeRelPath)
      .filter(Boolean)
  );
  const recentFiles = options.recentFiles instanceof Set
    ? options.recentFiles
    : listRecentGitModifiedFiles(repoRoot, 3);

  const candidates = collectAllowedSourceFiles(repoRoot, policyConfig, options);
  const scored = [];

  for (const rel of candidates) {
    if (scopeSet.has(rel)) continue;
    if (TEST_FILE_HINT_RE.test(rel) || DOC_OR_ASSET_RE.test(rel)) continue;
    if (isFrontendDomainFile(rel, policyConfig)) continue;

    let score = 0;
    if (missingDependents.has(rel)) score += 5;
    if (recentFiles.has(rel)) score += 4;
    if (/(?:^|\/)(?:server|router|routes|api|bridge|controller|handler|service|backend)/i.test(rel)) score += 3;

    const content = readSafeTextFile(repoRoot, rel, 256 * 1024);
    if (content && extractBackendRoutesFromCode(content).length > 0) {
      score += 4;
    }

    if (score > 0) {
      scored.push({ rel, score });
    }
  }

  scored.sort((a, b) => (b.score - a.score) || a.rel.localeCompare(b.rel));
  return scored.slice(0, maxFiles).map(item => item.rel);
}

/**
 * Summarizes backend HTTP routes (with body/response keys) and public symbols into a bounded read-only contract block.
 */
export function extractBackendContractSummary(relFiles = [], repoRoot = process.cwd(), options = {}) {
  const maxChars = Number(options.maxChars ?? 2400);
  const cleanFiles = [...new Set((Array.isArray(relFiles) ? relFiles : []).map(normalizeRelPath).filter(Boolean))];
  if (cleanFiles.length === 0) return '';

  const sections = [];
  for (const rel of cleanFiles) {
    const content = readSafeTextFile(repoRoot, rel, 256 * 1024);
    if (!content) continue;

    const lines = [];
    const routes = extractBackendRoutesFromCode(content);
    if (routes.length > 0) {
      lines.push('  Routes:');
      for (const rt of routes.slice(0, 20)) {
        const metaParts = [];
        if (rt.reqKeys.length > 0) metaParts.push(`req: ${rt.reqKeys.join(', ')}`);
        if (rt.resKeys.length > 0) metaParts.push(`res: ${rt.resKeys.join(', ')}`);
        const metaSuffix = metaParts.length > 0 ? ` (${metaParts.join(' | ')})` : '';
        lines.push(`  - [${rt.method}] ${rt.path}${rt.isPrefix ? '/*' : ''} (L${rt.line})${metaSuffix}`);
      }
    }

    let exportedSyms = [];
    try {
      const symRes = extractPublicSymbolSignatures(rel, content);
      exportedSyms = Object.values(symRes?.symbols || {})
        .filter(d => d && d.name)
        .slice(0, 12)
        .map(d => `${d.name}${d.signature || '()'}`);
    } catch {}
    if (exportedSyms.length > 0) {
      lines.push(`  Symbols: ${exportedSyms.join(' | ')}`);
    }

    if (lines.length > 0) {
      sections.push(`FILE ${rel}:\n${lines.join('\n')}`);
    }
  }

  if (sections.length === 0) return '';
  let joined = sections.join('\n');
  if (joined.length > maxChars) {
    joined = joined.slice(0, Math.max(0, maxChars - 20)) + '\n... [truncated]';
  }
  return joined;
}

function extractAddedStaticFrontendApiCalls(diffText = '') {
  const calls = new Set();
  const lines = String(diffText || '').split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const added = line.slice(1);
    const callRe = /\bfetch\s*\(\s*(['"])(\/api\/[^'"`$\s?)]+(?:\?[^'"`$\s)]*)?)\1/gi;
    let m;
    while ((m = callRe.exec(added)) !== null) {
      const cleanPath = String(m[2] || '').split('?')[0].replace(/\/+$/, '');
      if (cleanPath && cleanPath.startsWith('/api/')) {
        calls.add(cleanPath);
      }
    }
  }
  return Array.from(calls);
}

function routePatternMatchesCall(routeEntry, calledPath) {
  const defPath = String(routeEntry?.path || '').replace(/\/+$/, '');
  if (!defPath) return false;
  if (routeEntry.isPrefix) {
    if (defPath === '/api') return false;
    return calledPath === defPath || calledPath.startsWith(defPath + '/');
  }
  if (defPath === calledPath) return true;
  if (/:[a-zA-Z_][a-zA-Z0-9_]*|<[^>]+>|\{[^}]+\}/.test(defPath)) {
    const defSegs = defPath.split('/');
    const callSegs = calledPath.split('/');
    if (defSegs.length !== callSegs.length) return false;
    return defSegs.every((seg, idx) => (
      seg.startsWith(':') || /^<[^>]+>$/.test(seg) || /^\{[^}]+\}$/.test(seg) || seg === callSegs[idx]
    ));
  }
  return false;
}

/**
 * Zero-token gate: checks static literal fetch('/api/...') calls in added frontend diff lines
 * against backend routes defined in the repo. Skips cleanly on repos without HTTP /api/ routes.
 */
export function verifyFrontendRouteContract({
  modifiedFiles = [],
  diffText = '',
  repoRoot = process.cwd(),
  policyConfig = {},
  backendFiles = null
} = {}) {
  const modList = (Array.isArray(modifiedFiles) ? modifiedFiles : []).map(normalizeRelPath).filter(Boolean);
  const hasFrontend = modList.some(f => isFrontendDomainFile(f, policyConfig));
  if (!hasFrontend) {
    return { ok: true, skipped: true, reason: 'no_frontend_files' };
  }

  const calledRoutes = extractAddedStaticFrontendApiCalls(diffText);
  if (calledRoutes.length === 0) {
    return { ok: true, skipped: true, reason: 'no_static_api_calls' };
  }

  const scanFiles = Array.isArray(backendFiles)
    ? backendFiles.map(normalizeRelPath).filter(Boolean)
    : collectAllowedSourceFiles(repoRoot, policyConfig);

  const backendRoutes = [];
  for (const rel of scanFiles) {
    if (TEST_FILE_HINT_RE.test(rel) || DOC_OR_ASSET_RE.test(rel)) continue;
    if (isFrontendDomainFile(rel, policyConfig)) continue;
    const content = readSafeTextFile(repoRoot, rel, 256 * 1024);
    if (!content) continue;
    for (const rt of extractBackendRoutesFromCode(content)) {
      backendRoutes.push({ ...rt, file: rel });
    }
  }

  // Repos without HTTP /api/ route handlers (e.g. local RPC/desktop bridge/CLI) skip with zero false positives.
  if (backendRoutes.length === 0) {
    return { ok: true, skipped: true, reason: 'no_backend_http_routes' };
  }

  const specificRoutes = backendRoutes.filter(r => !(r.isPrefix && r.path === '/api'));
  if (specificRoutes.length === 0) {
    return { ok: true, skipped: true, reason: 'only_root_api_mount' };
  }

  const mismatches = calledRoutes.filter(
    called => !specificRoutes.some(rt => routePatternMatchesCall(rt, called))
  );

  if (mismatches.length === 0) {
    return { ok: true, skipped: false, checked: calledRoutes };
  }

  const availableSample = [...new Set(specificRoutes.map(r => r.path))].slice(0, 12);
  return {
    ok: false,
    skipped: false,
    mismatches,
    available_routes: availableSample,
    error: `RouteContractCheck failed: Frontend diff calls static endpoint(s) [${mismatches.join(', ')}] not found in Backend routes ([${availableSample.join(', ')}]). Use an exact existing Backend route or update the endpoint path.`
  };
}

/**
 * Extracts bounded read-only schema samples (<= maxLines lines and <= maxBytesPerFile bytes)
 * for non-sensitive data files explicitly referenced in task goal/title.
 */
export function extractGoalDataSchemaSamples(task = {}, repoRoot = process.cwd(), options = {}) {
  const maxFiles = Number(options.maxFiles ?? 2);
  const maxLines = Number(options.maxLines ?? 30);
  const maxBytesPerFile = Number(options.maxBytesPerFile ?? 2048);
  const scopeSet = new Set((Array.isArray(task?.scope) ? task.scope : []).map(normalizeRelPath).filter(Boolean));
  const combinedText = `${String(task?.title || '')}\n${String(task?.goal || '')}`;
  const candidates = [];
  const seen = new Set();

  let m;
  DATA_SAMPLE_PATH_RE.lastIndex = 0;
  while ((m = DATA_SAMPLE_PATH_RE.exec(combinedText)) !== null) {
    const rawRel = normalizeRelPath(m[1]);
    if (!rawRel || seen.has(rawRel) || scopeSet.has(rawRel)) continue;
    seen.add(rawRel);
    candidates.push(rawRel);
  }

  const included = [];
  const blocks = [];

  for (const rel of candidates) {
    if (included.length >= maxFiles) break;
    let safeRel;
    try {
      safeRel = normalizeOrThrow(repoRoot, rel);
    } catch {
      continue;
    }
    if (isForbiddenAttachment(safeRel)) continue;

    const absPath = path.resolve(repoRoot, safeRel);
    const sym = checkNoSymlinkEscape(repoRoot, absPath);
    if (!sym.ok) continue;
    if (!fs.existsSync(absPath)) continue;

    let st;
    try {
      st = fs.statSync(absPath);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size === 0) continue;

    const readCap = Math.min(st.size, Math.max(maxBytesPerFile * 2, 4096));
    const buf = Buffer.allocUnsafe(readCap);
    let bytesRead = 0;
    let fd = null;
    try {
      fd = fs.openSync(absPath, 'r');
      bytesRead = fs.readSync(fd, buf, 0, readCap, 0);
    } catch {
      continue;
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch {}
      }
    }
    if (bytesRead <= 0) continue;

    const sliceBuf = buf.subarray(0, bytesRead);
    if (sliceBuf.includes(0x00)) continue; // Reject binary content

    const rawText = sliceBuf.toString('utf8');
    const rawLines = rawText.split(/\r?\n/);
    const outLines = [];
    let usedBytes = 0;
    let truncated = st.size > bytesRead;

    for (let i = 0; i < rawLines.length && i < maxLines; i++) {
      let line = rawLines[i];
      if (outLines.length === 0 && rawLines.length <= 2 && line.length > 300) {
        const inlineBudget = Math.min(1600, Math.max(200, maxBytesPerFile - 64));
        line = line.slice(0, inlineBudget) + ' ... [truncated minified line]';
        truncated = true;
      } else if (line.length > 300) {
        line = line.slice(0, 300) + ' ... [line truncated]';
        truncated = true;
      }

      const candidateBytes = Buffer.byteLength(line + '\n', 'utf8');
      if (outLines.length > 0 && usedBytes + candidateBytes > maxBytesPerFile) {
        truncated = true;
        break;
      }
      if (outLines.length === 0 && candidateBytes > maxBytesPerFile) {
        line = Buffer.from(line, 'utf8').subarray(0, Math.max(128, maxBytesPerFile - 32)).toString('utf8') + ' ... [truncated]';
        truncated = true;
      }
      outLines.push(line);
      usedBytes += Buffer.byteLength(line + '\n', 'utf8');
    }

    if (rawLines.length > maxLines) truncated = true;
    const footer = truncated ? `\n[... sample truncated (showing <=${maxLines} lines / <=${maxBytesPerFile} bytes of ${st.size} bytes total)]` : '';
    included.push(safeRel);
    blocks.push(`FILE ${safeRel}:\n${outLines.join('\n')}${footer}`);
  }

  return {
    files: included,
    text: blocks.join('\n\n')
  };
}
