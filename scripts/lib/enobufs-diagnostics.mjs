import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const DEFAULT_ENOBUFS_EXTERNAL_SOCKET_THRESHOLD = 50;
export const DEFAULT_ENOBUFS_CONSECUTIVE_LIMIT = 3;

const NON_HUMAN_OWNER_RE = /^(?:infra|team|triage|system|bot|auto|qa|devops|ops|ci|none|unknown|null|admin|default|tbd|unassigned)(?:[-_\s].*)?$/i;

/**
 * Validates that an assigned owner is a real human person name rather than a generic group/infra label.
 *
 * @param {string} [owner]
 * @returns {boolean}
 */
export function isHumanOwnerName(owner = '') {
  const clean = String(owner || '').trim();
  if (clean.length < 2) return false;
  if (NON_HUMAN_OWNER_RE.test(clean)) return false;
  return /[a-zA-Z\p{L}]{2,}/u.test(clean);
}

/**
 * Evaluates whether external (non-test) OS processes exceed the socket threshold
 * in a captured socket snapshot. Processes matching `testPids` or PID <= 0 are excluded.
 *
 * @param {Object|null} snapshot
 * @param {Object} [options]
 */
export function evaluateExternalSocketPressure(snapshot = null, options = {}) {
  const threshold = Number.isFinite(Number(options.threshold))
    ? Number(options.threshold)
    : DEFAULT_ENOBUFS_EXTERNAL_SOCKET_THRESHOLD;
  const rawTestPids = Array.isArray(options.testPids) && options.testPids.length > 0
    ? options.testPids
    : [process.pid];
  const excludedPids = new Set(rawTestPids.map(Number).filter(n => Number.isInteger(n) && n > 0));

  if (!snapshot || !snapshot.ok || !Array.isArray(snapshot.by_process)) {
    return {
      snapshot_ok: false,
      threshold,
      external_process_count: 0,
      external_total_sockets: 0,
      max_external_sockets: 0,
      culprit_process: null,
      exceeds_threshold: false
    };
  }

  const external = snapshot.by_process
    .filter(p => Number.isInteger(Number(p?.pid)) && Number(p.pid) > 0 && !excludedPids.has(Number(p.pid)))
    .map(p => ({
      pid: Number(p.pid),
      process_name: p.process_name || null,
      total_sockets: Number(p.total_sockets || 0),
      states: p.states || {}
    }))
    .sort((a, b) => b.total_sockets - a.total_sockets || a.pid - b.pid);

  const culprit = external[0] || null;
  const maxExternal = culprit ? culprit.total_sockets : 0;
  const externalTotal = external.reduce((sum, p) => sum + p.total_sockets, 0);

  return {
    snapshot_ok: true,
    threshold,
    external_process_count: external.length,
    external_total_sockets: externalTotal,
    max_external_sockets: maxExternal,
    culprit_process: culprit,
    exceeds_threshold: maxExternal > threshold
  };
}

/**
 * Enforces the strict ENOBUFS flaky qualification rule:
 *  - 3 consecutive ENOBUFS failures -> `blocked` (never flaky)
 *  - `flaky` ONLY when BOTH: (1) isolated retry passed AND (2) external non-test process sockets > threshold.
 *
 * @param {Object} [options]
 */
export function evaluateEnobufsQualification(options = {}) {
  const {
    isolatedRetryPassed = false,
    socketDiagnostics = null,
    threshold = DEFAULT_ENOBUFS_EXTERNAL_SOCKET_THRESHOLD,
    testPids = [process.pid],
    consecutiveCount = 1,
    consecutiveLimit = DEFAULT_ENOBUFS_CONSECUTIVE_LIMIT
  } = options;

  if (Number(consecutiveCount) >= Number(consecutiveLimit)) {
    return {
      eligible_flaky: false,
      blocked: true,
      reason: 'enobufs_consecutive_blocked',
      consecutive_count: Number(consecutiveCount),
      external_pressure: null
    };
  }

  const externalPressure = evaluateExternalSocketPressure(socketDiagnostics, { threshold, testPids });
  if (!isolatedRetryPassed) {
    return {
      eligible_flaky: false,
      blocked: true,
      reason: 'enobufs_isolated_retry_failed',
      consecutive_count: Number(consecutiveCount),
      external_pressure: externalPressure
    };
  }

  if (!externalPressure.exceeds_threshold) {
    return {
      eligible_flaky: false,
      blocked: true,
      reason: 'enobufs_no_external_socket_pressure',
      consecutive_count: Number(consecutiveCount),
      external_pressure: externalPressure
    };
  }

  return {
    eligible_flaky: true,
    blocked: false,
    reason: 'enobufs_flaky_external_socket_pressure',
    consecutive_count: Number(consecutiveCount),
    external_pressure: externalPressure
  };
}

/**
 * Returns true if the failure text or error indicates Windows/Node socket buffer exhaustion (ENOBUFS).
 *
 * @param {string} [text]
 * @param {Error|Object|null} [err]
 * @returns {boolean}
 */
export function isEnobufsFailure(text = '', err = null) {
  if (err && String(err.code || '').toUpperCase() === 'ENOBUFS') {
    return true;
  }
  return /\bENOBUFS\b/i.test(String(text || ''));
}

/**
 * Parses `netstat -ano` output into per-process socket counts grouped by PID.
 *
 * @param {string} rawText
 * @param {Map<number, string>} [pidNameMap]
 */
export function parseNetstatOutputByProcess(rawText = '', pidNameMap = new Map()) {
  const byPid = new Map();
  let totalConnections = 0;

  for (const line of String(rawText || '').split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean) continue;
    if (!/^(TCP|UDP)\s+/i.test(clean)) continue;
    const cols = clean.split(/\s+/);
    const proto = cols[0].toUpperCase();
    const pidStr = cols[cols.length - 1];
    const pid = Number.parseInt(pidStr, 10);
    if (!Number.isInteger(pid) || pid < 0) continue;

    const state = proto === 'TCP' && cols.length >= 5
      ? String(cols[cols.length - 2] || 'UNKNOWN').toUpperCase()
      : 'UDP';

    totalConnections += 1;
    let bucket = byPid.get(pid);
    if (!bucket) {
      bucket = {
        pid,
        process_name: pidNameMap.get(pid) || null,
        total_sockets: 0,
        states: {}
      };
      byPid.set(pid, bucket);
    }
    bucket.total_sockets += 1;
    bucket.states[state] = (bucket.states[state] || 0) + 1;
  }

  const byProcess = [...byPid.values()].sort((a, b) => b.total_sockets - a.total_sockets || a.pid - b.pid);
  return {
    total_connections: totalConnections,
    by_process: byProcess
  };
}

/**
 * Captures a bounded per-process TCP socket snapshot.
 * Prefers `Get-NetTCPConnection` grouped by `OwningProcess` on Windows,
 * falling back cleanly to `netstat -ano` if PowerShell CIM is unavailable.
 */
export async function captureProcessSocketSnapshot({
  timeoutMs = 5000,
  maxProcesses = 15,
  execFileFn = execFileAsync,
  platform = process.platform
} = {}) {
  const capturedAt = new Date().toISOString();

  if (platform === 'win32') {
    const psScript = [
      "$ErrorActionPreference='Stop'",
      "$conns = @(Get-NetTCPConnection)",
      "$procs = @{}",
      "Get-Process | ForEach-Object { $procs[[int]$_.Id] = $_.ProcessName }",
      "$grouped = @($conns | Group-Object OwningProcess | Sort-Object Count -Descending | Select-Object -First " + maxProcesses + " | ForEach-Object {",
      "  $p = [int]$_.Name",
      "  $st = @{}",
      "  $_.Group | Group-Object State | ForEach-Object { $st[$_.Name.ToString()] = $_.Count }",
      "  [PSCustomObject]@{ pid=$p; process_name=$procs[$p]; total_sockets=$_.Count; states=$st }",
      "})",
      "@{ total_connections=$conns.Count; by_process=$grouped } | ConvertTo-Json -Depth 4 -Compress"
    ].join('; ');

    try {
      const { stdout } = await execFileFn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psScript],
        { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }
      );
      const parsed = JSON.parse(String(stdout || '').trim() || '{}');
      const rows = Array.isArray(parsed.by_process)
        ? parsed.by_process
        : (parsed.by_process ? [parsed.by_process] : []);
      return {
        ok: true,
        source: 'Get-NetTCPConnection',
        captured_at: capturedAt,
        total_connections: Number(parsed.total_connections || 0),
        by_process: rows
      };
    } catch {
      // Fall back cleanly to netstat -ano
    }
  }

  try {
    const args = platform === 'win32' ? ['-ano'] : ['-anp'];
    const { stdout } = await execFileFn(
      'netstat',
      args,
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }
    );
    const grouped = parseNetstatOutputByProcess(stdout);
    return {
      ok: true,
      source: 'netstat',
      captured_at: capturedAt,
      total_connections: grouped.total_connections,
      by_process: grouped.by_process.slice(0, maxProcesses)
    };
  } catch (err) {
    return {
      ok: false,
      source: 'unavailable',
      captured_at: capturedAt,
      total_connections: 0,
      by_process: [],
      error: err.message
    };
  }
}

/**
 * Formats a concise single-line summary of captured socket diagnostics for logs.
 *
 * @param {Object|null} snapshot
 * @returns {string}
 */
export function formatSocketSnapshotSummary(snapshot = null) {
  if (!snapshot || !snapshot.ok) {
    return `unavailable (${snapshot?.error || 'no snapshot'})`;
  }
  const top = (snapshot.by_process || [])
    .slice(0, 5)
    .map(p => `pid=${p.pid}${p.process_name ? `(${p.process_name})` : ''}:${p.total_sockets}`)
    .join(', ');
  return `source=${snapshot.source}, total=${snapshot.total_connections}, top=[${top || 'none'}]`;
}
